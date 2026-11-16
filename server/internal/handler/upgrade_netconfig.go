package handler

// 后台可配的升级网络出口 —— 「服务端从 GitHub 拉取 CLI 镜像包」这条路的
// 下载基址、API 基址与代理。
//
// 背景：生产服务器（国内）直连 github.com 下载 85MB 级资产基本不可能成功
// （Client 15s 墙钟 + 5.7MB/s 才来得及），而 gh 镜像前缀（如
// `https://ghfast.top/https://github.com`）与本地代理（如 mihomo 的
// `http://127.0.0.1:7890`）是两条已被验证可行的出路。这里把三个值做成
// `rongcloud_system_config` 里的配置项，后台「系统配置」页的通用键值就能改，
// **每次拉取/查询开始时读一次 DB** —— 不做进程级缓存，改完即时生效，不需重启。
//
// ⚠️ 代理只接受 `http://` / `https://` / `socks5://` 的端口端点。机场**订阅
// 地址**（`https://sub.xxx/.../subscribe?token=...`）是节点列表，不是代理端口，
// 本服务**不做订阅解析** —— 填订阅地址只会被当作非法值忽略（并留一条 Warn），
// 正确做法是先在服务器上跑一个本地内核（如 mihomo）把订阅变成 7890 这类端口。
//
// 读取优先级（每个键独立）：
//
//	rongcloud_system_config（后台） → 环境变量（CLAW_UPGRADE_RELEASE_WEB /
//	  CLAW_UPGRADE_RELEASE_API / CLAW_UPGRADE_PROXY） → 内置默认值
//
// 读 DB 失败**必须降级**为 env/默认值并留 Warn —— 网络设置读不出来不该让
// 升级/镜像功能整个不可用；那只是退回改动前的行为。

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/net/proxy"
)

// 后台三个配置键（config_key）。描述文案给后台运维抄：
//
//	claw_upgrade_release_web  release 资产下载基址（gh 镜像前缀）
//	claw_upgrade_release_api  GitHub API 基址
//	claw_upgrade_proxy        出网代理（http/https/socks5 端口）
const (
	clawUpgradeReleaseWebConfigKey = "claw_upgrade_release_web"
	clawUpgradeReleaseAPIConfigKey = "claw_upgrade_release_api"
	clawUpgradeProxyConfigKey      = "claw_upgrade_proxy"
)

// 默认值：没有后台配置、没有 env 时的行为与改动前一致（直连 GitHub）。
const (
	clawUpgradeDefaultWebBase = "https://github.com"
	clawUpgradeDefaultAPIBase = "https://api.github.com"
)

// clawUpgradeNetSettings 是一次拉取/查询所用到的全部网络出口。
// 三个字段都是已校验、已 TrimRight 掉尾斜杠的最终值（Proxy 无尾斜杠概念）。
type clawUpgradeNetSettings struct {
	ReleaseWeb string // release 资产下载基址（可为 gh 镜像前缀）
	ReleaseAPI string // GitHub API 基址（可为兼容镜像）
	Proxy      string // 出网代理，空串 = 直连
}

// clawUpgradeEnvNetSettings 从环境变量读一份设置（无 DB 时的完整回退路径，
// 也是单测离线打假服务的注入点：t.Setenv + 本函数）。
func clawUpgradeEnvNetSettings() clawUpgradeNetSettings {
	return clawUpgradeNetSettings{
		ReleaseWeb: clawUpgradeNormalizeBase(os.Getenv("CLAW_UPGRADE_RELEASE_WEB"), clawUpgradeDefaultWebBase),
		ReleaseAPI: clawUpgradeNormalizeBase(os.Getenv("CLAW_UPGRADE_RELEASE_API"), clawUpgradeDefaultAPIBase),
		Proxy:      clawUpgradeNormalizeProxy(os.Getenv("CLAW_UPGRADE_PROXY")),
	}
}

// clawUpgradeNetSettings 读取本次拉取/查询生效的网络设置。
//
// DB 值优先于 env；DB 无该行、值为空或非法时逐键回落 env，再回落默认值。
// 每次调用各查一次 DB（键上有索引的点查，代价可忽略），后台改完下一个请求
// 立即生效 —— 这是「热生效」的全部实现，刻意不做进程级缓存。
func (h *Handler) clawUpgradeNetSettings(ctx context.Context) clawUpgradeNetSettings {
	settings := clawUpgradeEnvNetSettings()
	if h == nil || h.DB == nil {
		return settings
	}
	if v := clawUpgradeDBConfigValue(ctx, h, clawUpgradeReleaseWebConfigKey); v != "" {
		if base := clawUpgradeNormalizeBase(v, ""); base != "" {
			settings.ReleaseWeb = base
		} else {
			slog.Warn("claw upgrade: 后台配置的 release 下载基址非法，已忽略（只接受 http(s):// 开头）",
				"config_key", clawUpgradeReleaseWebConfigKey, "value", v)
		}
	}
	if v := clawUpgradeDBConfigValue(ctx, h, clawUpgradeReleaseAPIConfigKey); v != "" {
		if base := clawUpgradeNormalizeBase(v, ""); base != "" {
			settings.ReleaseAPI = base
		} else {
			slog.Warn("claw upgrade: 后台配置的 GitHub API 基址非法，已忽略（只接受 http(s):// 开头）",
				"config_key", clawUpgradeReleaseAPIConfigKey, "value", v)
		}
	}
	if v := clawUpgradeDBConfigValue(ctx, h, clawUpgradeProxyConfigKey); v != "" {
		if p := clawUpgradeNormalizeProxy(v); p != "" {
			settings.Proxy = p
		} else {
			// 最常见的踩坑就是把机场订阅地址填进来。订阅是节点列表不是代理端口，
			// 这里点名说明，运维一眼就知道该去搭本地内核。
			slog.Warn("claw upgrade: 后台配置的代理非法，已忽略（只接受 http:// https:// socks5:// 开头的端口端点；机场订阅地址是节点列表，不是代理，请先用 mihomo 等本地内核转成本地端口）",
				"config_key", clawUpgradeProxyConfigKey, "value", v)
		}
	}
	return settings
}

// clawUpgradeDBConfigValue 读单个配置键的原始字符串。无行/读失败都返回空串；
// 除「无此行」之外的读库失败必须留 Warn（降级但不能静默）。
func clawUpgradeDBConfigValue(ctx context.Context, h *Handler, key string) string {
	var raw []byte
	err := h.DB.QueryRow(ctx,
		`SELECT config FROM rongcloud_system_config WHERE config_key=$1 LIMIT 1`, key).Scan(&raw)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			slog.Warn("claw upgrade: 读取后台网络设置失败，该项回落环境变量/默认值",
				"config_key", key, "error", err)
		}
		return ""
	}
	return clawUpgradeConfigString(raw)
}

// clawUpgradeConfigString 从 jsonb 的 config 列里抠出纯文本值。
//
// 后台通用编辑框写纯文本时，upsert 会包成 `{"value": "<文本>"}`；直接写 JSON
// 时列里就是裸字符串（甚至可能是数字/数组）。两种字符串形态都认，其余一律
// 空串（当作没配）。与 clawCLIServerURL 的解析同构 —— 那条路径已经在线上
// 验证过两种形态。
func clawUpgradeConfigString(raw []byte) string {
	var value interface{}
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case map[string]interface{}:
		if s, ok := typed["value"].(string); ok {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

// clawUpgradeNormalizeBase 校验/归一一个基址：去空白、TrimRight 尾斜杠，
// 必须以 http:// 或 https:// 开头。空串或非法值返回 fallback（fallback 传空串
// 即「告诉调用方这里没有有效值」）。
func clawUpgradeNormalizeBase(value, fallback string) string {
	base := strings.TrimRight(strings.TrimSpace(value), "/")
	if base == "" {
		return fallback
	}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		return fallback
	}
	return base
}

// clawUpgradeNormalizeProxy 校验代理地址：只接受 http:// https:// socks5://
// 开头的端口端点。空串 = 直连（合法）。机场订阅地址会被判非法。
func clawUpgradeNormalizeProxy(value string) string {
	p := strings.TrimSpace(value)
	if p == "" {
		return ""
	}
	lower := strings.ToLower(p)
	for _, scheme := range []string{"http://", "https://", "socks5://"} {
		if strings.HasPrefix(lower, scheme) {
			return p
		}
	}
	return ""
}

const (
	// clawUpgradeTLSHandshakeTimeout / clawUpgradeResponseHeaderTimeout 是
	// transport 层的两个护栏：握手卡死、或连上之后服务器迟迟不回响应头，
	// 都不该挂住整个任务。它们**不是**下载墙钟 —— 85MB 的 body 读取不受
	// ResponseHeaderTimeout 影响（那只管到响应头为止）。
	clawUpgradeTLSHandshakeTimeout   = 15 * time.Second
	clawUpgradeResponseHeaderTimeout = 30 * time.Second
)

// clawUpgradeClientForSettings 按设置构造 HTTP client。
//
// 与改动前最关键的区别：**client.Timeout = 0**（没有 client 级墙钟）。改动前
// 整个 client 是 15s 墙钟，85MB 的资产要 ≈5.7MB/s 才下得完 —— 国内直连必然
// context deadline exceeded。现在超时完全靠每次请求的 ctx 控制：
// API/HEAD 用 clawUpgradeAPIRequestTimeout（20s），资产下载用
// clawMirrorAssetTimeout（30 分钟）。
//
// 测试注入优先：clawUpgradeSetHTTPClientForTest 塞进来的假 client 永远获胜，
// 既有测试的离线语义不变。
func clawUpgradeClientForSettings(settings clawUpgradeNetSettings) *http.Client {
	if injected := clawUpgradeHTTPClient(); injected != nil {
		return injected
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if addr := settings.Proxy; addr != "" {
		if strings.HasPrefix(strings.ToLower(addr), "socks5://") {
			// socks5 不是 HTTP 代理，不能走 transport.Proxy（那只讲 CONNECT）；
			// 要换掉拨号层。golang.org/x/net/proxy 的 dialer 自带上下文版本。
			u, err := url.Parse(addr)
			if err == nil {
				dialer, dialerErr := proxy.FromURL(u, proxy.Direct)
				if dialerErr == nil {
					if contextDialer, ok := dialer.(proxy.ContextDialer); ok {
						transport.DialContext = contextDialer.DialContext
					}
				} else {
					slog.Warn("claw upgrade: socks5 代理解析失败，该项按直连处理",
						"proxy", addr, "error", dialerErr)
				}
			} else {
				slog.Warn("claw upgrade: socks5 代理地址无法解析，该项按直连处理",
					"proxy", addr, "error", err)
			}
		} else if u, err := url.Parse(addr); err == nil && u.Host != "" {
			transport.Proxy = http.ProxyURL(u)
		} else {
			slog.Warn("claw upgrade: 代理地址无法解析，该项按直连处理", "proxy", addr)
		}
	}
	transport.TLSHandshakeTimeout = clawUpgradeTLSHandshakeTimeout
	transport.ResponseHeaderTimeout = clawUpgradeResponseHeaderTimeout
	return &http.Client{Transport: transport}
}
