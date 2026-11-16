package handler

// 后台可配网络出口（upgrade_netconfig.go）的用例 —— 钉住三件事：
//
//  1. 配置解析：jsonb 的两种形态（裸字符串 / {"value": "..."}）都能读出纯文本，
//     其余形态（数字、数组、坏 JSON）一律当作没配；
//  2. 优先级：DB 值 > 环境变量 > 默认值；DB 读失败降级为 env，绝不让设置读取
//     的失败拖垮升级/镜像功能；非法值忽略并回落；
//  3. 客户端：代理真的进 transport（http 与 socks5 两种），client 没有 client 级
//     墙钟（超时全靠 ctx —— 15s 墙钟掐死 85MB 下载就是本次修复的根因）。
//
// DB 侧用 conversations 测试的 convFakeDB 打桩：settings 读取走 QueryRow，
// 与 clawCLIServerURL 同一条访问形态。

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// netConfigRow 造一条 config 列的返回值（jsonb 原始字节）。
func netConfigRow(value string) *convStubRow {
	return &convStubRow{values: []any{[]byte(value)}}
}

// ---- 形态解析（clawUpgradeConfigString）--------------------------------------

// 三种 jsonb 形态各一条：裸字符串、{"value": "..."}、其余一律空。
func TestClawUpgradeConfigStringAcceptsBothJSONBShapes(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"bare json string", `"https://ghfast.top/https://github.com"`, "https://ghfast.top/https://github.com"},
		{"wrapped value object", `{"value":"http://127.0.0.1:7890"}`, "http://127.0.0.1:7890"},
		{"wrapped value trims spaces", `{"value":"  https://api.example.com  "}`, "https://api.example.com"},
		{"number is not a setting", `123`, ""},
		{"array is not a setting", `["a","b"]`, ""},
		{"garbage is not a setting", `not-json-at-all`, ""},
		{"empty object", `{}`, ""},
		{"empty string", ``, ""},
	}
	for _, tc := range cases {
		if got := clawUpgradeConfigString([]byte(tc.raw)); got != tc.want {
			t.Fatalf("%s: clawUpgradeConfigString(%q) = %q, want %q", tc.name, tc.raw, got, tc.want)
		}
	}
}

// ---- 基址/代理的校验与归一 ---------------------------------------------------

func TestClawUpgradeNormalizeBase(t *testing.T) {
	cases := []struct {
		in, fallback, want string
	}{
		{"https://github.com/", "", "https://github.com"},
		{"  https://x.example ", "", "https://x.example"},
		{"ftp://evil", "https://fallback", "https://fallback"}, // 非法 → 回落
		{"", "https://fallback", "https://fallback"},
		{"   ", "", ""},
	}
	for _, tc := range cases {
		if got := clawUpgradeNormalizeBase(tc.in, tc.fallback); got != tc.want {
			t.Fatalf("clawUpgradeNormalizeBase(%q, %q) = %q, want %q", tc.in, tc.fallback, got, tc.want)
		}
	}
}

func TestClawUpgradeNormalizeProxy(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"http://127.0.0.1:7890", "http://127.0.0.1:7890"},
		{" https://proxy.corp:3128 ", "https://proxy.corp:3128"},
		{"socks5://127.0.0.1:1080", "socks5://127.0.0.1:1080"},
		{"", ""},               // 空 = 直连（合法）
		{"127.0.0.1:7890", ""}, // 没写 scheme → 非法
		// 机场订阅地址是节点列表不是代理端口：填进去连不通（端点不回应代理协议）。
		// 服务端不做订阅解析、也不做内容嗅探 —— scheme 合法（https://）就放行，
		// 失败发生在真正拨号的那一刻，这是刻意保守的边界（见 upgrade_netconfig.go）。
		{"https://sub.example.com/subscribe?token=abc", "https://sub.example.com/subscribe?token=abc"},
	}
	for _, tc := range cases {
		if got := clawUpgradeNormalizeProxy(tc.in); got != tc.want {
			t.Fatalf("clawUpgradeNormalizeProxy(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// ---- 设置读取：DB 优先于 env，失败降级 ---------------------------------------

// DB 里有值 → 覆盖 env；DB 里非法 → 回落 env；DB 没有该行 → 保持 env。
func TestClawUpgradeNetSettingsDBWinsOverEnv(t *testing.T) {
	t.Setenv("CLAW_UPGRADE_RELEASE_WEB", "https://env-web.example")
	t.Setenv("CLAW_UPGRADE_RELEASE_API", "https://env-api.example")
	t.Setenv("CLAW_UPGRADE_PROXY", "")

	fake := &convFakeDB{}
	fake.queryRow = func(_ string, args []any) pgx.Row {
		// key 是绑定参数而不是 SQL 文本的一部分，按参数值分发。
		key, _ := args[0].(string)
		switch key {
		case clawUpgradeReleaseWebConfigKey:
			return netConfigRow(`"https://ghfast.top/https://github.com"`)
		case clawUpgradeReleaseAPIConfigKey:
			// 非法值：忽略该项，回落 env。
			return netConfigRow(`"ftp://not-a-base"`)
		case clawUpgradeProxyConfigKey:
			return netConfigRow(`{"value":"socks5://127.0.0.1:1080"}`)
		default:
			return &convStubRow{err: pgx.ErrNoRows}
		}
	}
	h := &Handler{DB: fake}

	settings := h.clawUpgradeNetSettings(context.Background())
	if settings.ReleaseWeb != "https://ghfast.top/https://github.com" {
		t.Fatalf("DB 值必须优先于 env: ReleaseWeb = %q", settings.ReleaseWeb)
	}
	if settings.ReleaseAPI != "https://env-api.example" {
		t.Fatalf("DB 非法值必须回落 env: ReleaseAPI = %q", settings.ReleaseAPI)
	}
	if settings.Proxy != "socks5://127.0.0.1:1080" {
		t.Fatalf("DB 的 socks5 代理必须生效: Proxy = %q", settings.Proxy)
	}
}

// DB 读失败（连接断等）→ 完整回落 env，并且不 panic。
func TestClawUpgradeNetSettingsFallsBackToEnvOnDBFailure(t *testing.T) {
	t.Setenv("CLAW_UPGRADE_RELEASE_WEB", "https://env-web.example")
	t.Setenv("CLAW_UPGRADE_RELEASE_API", "")
	t.Setenv("CLAW_UPGRADE_PROXY", "http://127.0.0.1:7890")

	fake := &convFakeDB{}
	fake.queryRow = func(string, []any) pgx.Row {
		return &convStubRow{err: errors.New("connection reset")}
	}
	h := &Handler{DB: fake}

	settings := h.clawUpgradeNetSettings(context.Background())
	if settings.ReleaseWeb != "https://env-web.example" {
		t.Fatalf("DB 失败必须回落 env: ReleaseWeb = %q", settings.ReleaseWeb)
	}
	if settings.ReleaseAPI != clawUpgradeDefaultAPIBase {
		t.Fatalf("env 与 DB 都没有时回落默认值: ReleaseAPI = %q", settings.ReleaseAPI)
	}
	if settings.Proxy != "http://127.0.0.1:7890" {
		t.Fatalf("env 代理必须生效: Proxy = %q", settings.Proxy)
	}
}

// DB 与 env 全空 → 默认值；nil Handler / nil DB 也不许 panic。
func TestClawUpgradeNetSettingsDefaultsWhenNothingConfigured(t *testing.T) {
	t.Setenv("CLAW_UPGRADE_RELEASE_WEB", "")
	t.Setenv("CLAW_UPGRADE_RELEASE_API", "")
	t.Setenv("CLAW_UPGRADE_PROXY", "")

	if settings := (*Handler)(nil).clawUpgradeNetSettings(context.Background()); settings.ReleaseWeb != clawUpgradeDefaultWebBase || settings.ReleaseAPI != clawUpgradeDefaultAPIBase || settings.Proxy != "" {
		t.Fatalf("nil handler 必须回落默认值, got %+v", settings)
	}

	fake := &convFakeDB{}
	fake.queryRow = func(string, []any) pgx.Row { return &convStubRow{err: pgx.ErrNoRows} }
	settings := (&Handler{DB: fake}).clawUpgradeNetSettings(context.Background())
	if settings.ReleaseWeb != clawUpgradeDefaultWebBase || settings.ReleaseAPI != clawUpgradeDefaultAPIBase {
		t.Fatalf("无任何配置时必须是默认值, got %+v", settings)
	}
}

// DB 基址带尾斜杠 → 归一化时去掉（拼 URL 时不会出现 //releases）。
func TestClawUpgradeNetSettingsTrimsTrailingSlashFromDB(t *testing.T) {
	t.Setenv("CLAW_UPGRADE_RELEASE_WEB", "")
	t.Setenv("CLAW_UPGRADE_RELEASE_API", "")
	t.Setenv("CLAW_UPGRADE_PROXY", "")

	fake := &convFakeDB{}
	fake.queryRow = func(sql string, _ []any) pgx.Row {
		return netConfigRow(`"https://ghfast.top/https://github.com/"`)
	}
	settings := (&Handler{DB: fake}).clawUpgradeNetSettings(context.Background())
	if settings.ReleaseWeb != "https://ghfast.top/https://github.com" {
		t.Fatalf("尾斜杠必须被 TrimRight 掉: ReleaseWeb = %q", settings.ReleaseWeb)
	}
}

// ---- URL 拼接 ----------------------------------------------------------------

// base 带尾斜杠 / 不带，tag 与资产名都要落在正确位置；仓库必须是新名。
func TestClawUpgradeAssetURLWithBase(t *testing.T) {
	got := clawUpgradeAssetURLWithBase("https://ghfast.top/https://github.com/", "agentsbb-v1.4.0", "agentsbb-windows-x64.exe")
	want := "https://ghfast.top/https://github.com/clawmessenger/agentsbb/releases/download/agentsbb-v1.4.0/agentsbb-windows-x64.exe"
	if got != want {
		t.Fatalf("asset URL = %q, want %q", got, want)
	}
	got = clawUpgradeAssetURLWithBase("https://github.com", "clawmessenger-v1.3.33", "clawmessenger-windows-x64.exe")
	want = "https://github.com/clawmessenger/agentsbb/releases/download/clawmessenger-v1.3.33/clawmessenger-windows-x64.exe"
	if got != want {
		t.Fatalf("legacy tag/asset 也要能用新仓库拼: %q, want %q", got, want)
	}
	if strings.Contains(clawUpgradeAssetURLWithBase("https://x.example/", "agentsbb-v1.0.0", "a.exe"), "//clawmessenger") {
		t.Fatal("基址尾斜杠去掉后不该出现双斜杠")
	}
}

// ---- client：代理生效、无 client 级墙钟 --------------------------------------

// http 代理必须真的进 transport.Proxy，且指向设定地址。
func TestClawUpgradeClientForSettingsAppliesHTTPProxy(t *testing.T) {
	t.Cleanup(clawUpgradeSetHTTPClientForTest(nil))
	settings := clawUpgradeNetSettings{Proxy: "http://127.0.0.1:7890"}
	client := clawUpgradeClientForSettings(settings)
	if client.Timeout != 0 {
		t.Fatalf("client 级墙钟必须为 0（超时全靠 ctx），got %v", client.Timeout)
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport 类型 = %T", client.Transport)
	}
	if transport.Proxy == nil {
		t.Fatal("配置了 http 代理时 transport.Proxy 不能是 nil")
	}
	req, _ := http.NewRequest(http.MethodGet, "https://github.com", nil)
	u, err := transport.Proxy(req)
	if err != nil {
		t.Fatalf("Proxy(req): %v", err)
	}
	if u == nil || u.Host != "127.0.0.1:7890" {
		t.Fatalf("代理地址 = %v, want 127.0.0.1:7890", u)
	}
}

// socks5 不能走 transport.Proxy（那只会 CONNECT），必须换掉拨号层。
func TestClawUpgradeClientForSettingsAppliesSocks5Proxy(t *testing.T) {
	t.Cleanup(clawUpgradeSetHTTPClientForTest(nil))
	settings := clawUpgradeNetSettings{Proxy: "socks5://127.0.0.1:1080"}
	client := clawUpgradeClientForSettings(settings) // 不许 panic / 报错
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport 类型 = %T", client.Transport)
	}
	if transport.DialContext == nil {
		t.Fatal("socks5 代理必须替换 DialContext")
	}
	// transport.Proxy 仍是 Clone 自 DefaultTransport 的 env 逻辑 —— socks5 不用它，
	// 不该被覆盖成 http.ProxyURL。**不能**对 Proxy(req) 的返回值做断言：
	// http.ProxyFromEnvironment 在进程内 sync.Once 快照一次环境，任何先跑的测试
	// 触发过一次请求，这里的 env 就被冻结了（沙箱里必然带着 HTTP_PROXY），
	// t.Setenv 清不动它 —— 断言它只会得到环境噪音。
}

// 没配代理 = 直连（transport.Proxy 保持默认环境逻辑，不额外指定）。
func TestClawUpgradeClientForSettingsWithoutProxyKeepsDirect(t *testing.T) {
	t.Cleanup(clawUpgradeSetHTTPClientForTest(nil))
	client := clawUpgradeClientForSettings(clawUpgradeNetSettings{})
	if client.Timeout != 0 {
		t.Fatalf("直连 client 同样不能有 client 级墙钟, got %v", client.Timeout)
	}
	transport := client.Transport.(*http.Transport)
	if transport.TLSHandshakeTimeout != clawUpgradeTLSHandshakeTimeout {
		t.Fatalf("TLS 握手护栏没生效: %v", transport.TLSHandshakeTimeout)
	}
	if transport.ResponseHeaderTimeout != clawUpgradeResponseHeaderTimeout {
		t.Fatalf("响应头护栏没生效: %v", transport.ResponseHeaderTimeout)
	}
}

// 非法代理值在 normalize 阶段就被拦掉；这里补一层：URL 解析失败的值不 panic、
// 退回直连。
func TestClawUpgradeClientForSettingsToleratesGarbageProxy(t *testing.T) {
	t.Cleanup(clawUpgradeSetHTTPClientForTest(nil))
	if _, err := url.Parse("http://[::1"); err == nil {
		t.Skip("this Go version accepts the garbage URL; nothing to assert")
	}
	client := clawUpgradeClientForSettings(clawUpgradeNetSettings{Proxy: "http://[::1"})
	if client == nil {
		t.Fatal("垃圾代理值不能让 client 构造失败")
	}
}

// ---- 测试注入仍然优先 ---------------------------------------------------------

func TestClawUpgradeClientForSettingsPrefersInjectedTestClient(t *testing.T) {
	injected := &http.Client{Timeout: 3 * time.Second}
	restore := clawUpgradeSetHTTPClientForTest(injected)
	defer restore()
	got := clawUpgradeClientForSettings(clawUpgradeNetSettings{Proxy: "http://127.0.0.1:7890"})
	if got != injected {
		t.Fatal("测试注入的 client 必须优先于按设置构造的 client")
	}
}

// ---- 超时量级（防回归：15s 墙钟的根因不能再回来）------------------------------

// 资产下载的墙钟必须是 30 分钟量级（复用 clawMirrorAssetTimeout），API 请求 20s。
// 断言常量本身，不锁具体实现。
func TestClawUpgradeTimeoutsAreSizedForBigAssets(t *testing.T) {
	if clawMirrorAssetTimeout < 5*time.Minute {
		t.Fatalf("单资产下载墙钟必须 >= 5 分钟（85MB 在慢出口上），got %v", clawMirrorAssetTimeout)
	}
	if clawUpgradeAPIRequestTimeout != 20*time.Second {
		t.Fatalf("GitHub API 请求墙钟应为 20s, got %v", clawUpgradeAPIRequestTimeout)
	}
	if clawUpgradeTLSHandshakeTimeout <= 0 || clawUpgradeResponseHeaderTimeout <= 0 {
		t.Fatal("transport 层护栏必须为正")
	}
}
