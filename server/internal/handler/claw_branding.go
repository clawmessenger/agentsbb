package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/integrations/rongcloud"
)

// claw_branding.go 是「后台可配置的品牌图片」的唯一读写入口。
//
// 存的是什么：`rongcloud_system_config` 的一行，config_key='branding'，
// config 是 `{"user_avatar":"…","group_avatar":"…","discussion_avatar":"…",
// "chatroom_avatar":"…","logo":"…"}`。**不新建表、不需要迁移** —— 这张 KV 表
// 本来就是给这类运营配置用的（user_guide、agent_onboarding_prompt 都在这）。
//
// 为什么这件事值得做：默认图过去散在四个地方各自硬编码 ——
//   - web：`default-avatar.ts` / `group-avatar.ts` / `brand.ts`（public/*）
//   - 小程序：`utils/default-avatar.js` 的本地 static
//   - 服务端：`portrait_group.go` + `DefaultUserPortrait()`（写进融云的那份）
//   - 群头像 PNG 还要手工重出、手工 scp
//
// 于是「换一张默认头像」= 改 4 处代码 + 构建 + 部署三端，还很容易只改了一半
// （历史上就出现过「网页彩色、小程序还是灰的」）。现在统一成一个配置项。
//
// 三个约定：
//  1. **空值 = 没配 = 用内置**。绝不能把空串当成"故意不显示"传给融云/客户端，
//     那会得到一张空白图而不是默认图。下发接口因此永远给全 5 个绝对 URL。
//  2. **相对路径在保存时就归一成绝对 URL**。服务端写融云的地方没有 request
//     上下文，读的时候补不出 host；把归一化放在保存这一刻，读侧才是一段纯
//     无上下文的逻辑。
//  3. **只接受 http(s) 与本机相对路径**。`javascript:` / `data:` 直接丢弃 ——
//     这个值会进 `<img src>`，客户端虽然只是加载图片，但没有理由给它们留口子。
const brandingConfigKey = "branding"

// defaultBrandingLogoURL 是未配置时的 Logo 图源（与 web `public/logo.png` 同图）。
// 运维要换域名/C DN 时改 env，不必动代码 —— 与 GroupPortraitBase 同一套思路。
const defaultBrandingLogoURL = "https://agents.quukk.com/claw-web/logo.png"

// brandingLogoEnv 覆盖内置 Logo 图源。
const brandingLogoEnv = "CLAW_BRANDING_LOGO_URL"

// brandingPublicBaseEnv 显式指定站点对外基址（相对路径归一化用）。
// 反代链路上 Host / X-Forwarded-* 有时不可信，运维可以直接钉死。
const brandingPublicBaseEnv = "CLAW_PUBLIC_BASE_URL"

// brandingConfig 是 brandng 配置的线上结构，同时也是 GET 接口的回包结构。
type brandingConfig struct {
	UserAvatar       string `json:"user_avatar"`
	GroupAvatar      string `json:"group_avatar"`
	DiscussionAvatar string `json:"discussion_avatar"`
	ChatroomAvatar   string `json:"chatroom_avatar"`
	Logo             string `json:"logo"`
}

// builtinBranding 返回五个槽位的内置绝对 URL（配置为空时下发这些）。
//
// 与各端代码里的常量同源：user_avatar 用 rongcloud 包的统一图源（有 env 覆盖），
// 三张群图用 GroupPortraitBase()（同样认 env），Logo 单独一个常量。
func builtinBranding() brandingConfig {
	base := rongcloud.GroupPortraitBase()
	return brandingConfig{
		UserAvatar:       rongcloud.DefaultUserPortrait(),
		GroupAvatar:      base + "/group.png",
		DiscussionAvatar: base + "/discussion.png",
		ChatroomAvatar:   base + "/chatroom.png",
		Logo:             builtinBrandingLogo(),
	}
}

func builtinBrandingLogo() string {
	if v := strings.TrimSpace(os.Getenv(brandingLogoEnv)); v != "" {
		return v
	}
	return defaultBrandingLogoURL
}

// normalizeBrandingImageURL 把配置值归一成可下发的绝对 URL；不合法返回空串
// （调用方据此回落到内置值）。
//
// 接受的三种写法：
//   - `https://…` / `http://…` 绝对地址（含对象存储、CDN、外链）；
//   - `/uploads/…` 这类站内相对路径 → 用 base 拼成绝对；
//   - 空串 → 返回空串（= 没配）。
//
// 拒绝：其它 scheme（javascript / data / file）、协议相对 `//host/x`（会被
// `url.Parse` 当成 host，等于绕过了校验）、以及不含 host 又不是 `/` 开头的值。
func normalizeBrandingImageURL(raw, base string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	// 协议相对（//evil.example/x.png）：url.Parse 会给它 host 而 scheme 为空，
	// 走下面的 switch 会落到 case ""，必须在这里先挡掉。
	if strings.HasPrefix(trimmed, "//") {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return ""
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https":
		if parsed.Host == "" {
			return ""
		}
		return parsed.String()
	case "":
		if !strings.HasPrefix(trimmed, "/") {
			return ""
		}
		trimmedBase := strings.TrimRight(strings.TrimSpace(base), "/")
		if trimmedBase == "" {
			return ""
		}
		return trimmedBase + trimmed
	default:
		return ""
	}
}

// brandingPublicBaseURL 推导站点对外基址，用于把相对路径补成绝对 URL。
//
// 顺序：CLAW_PUBLIC_BASE_URL → X-Forwarded-Proto/Host（反代常见）→ 请求自身。
// 反代后 `r.TLS` 恒为 nil，所以不能只看它判断 https。
func brandingPublicBaseURL(r *http.Request) string {
	if v := strings.TrimSpace(os.Getenv(brandingPublicBaseEnv)); v != "" {
		return strings.TrimRight(v, "/")
	}
	if r == nil {
		return ""
	}
	scheme := strings.TrimSpace(firstCSV(r.Header.Get("X-Forwarded-Proto")))
	if scheme == "" {
		if r.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	host := strings.TrimSpace(firstCSV(r.Header.Get("X-Forwarded-Host")))
	if host == "" {
		host = r.Host
	}
	if host == "" {
		return ""
	}
	return scheme + "://" + host
}

// firstCSV 取逗号分隔头的第一个值（多重反代会串成一串）。
func firstCSV(v string) string {
	if idx := strings.IndexByte(v, ','); idx >= 0 {
		return v[:idx]
	}
	return v
}

// readBrandingRow 读库里那一行原始 config（不存在时返回 false）。
//
// 单独拆出来是因为两处要用同一套"缺行 = 没配"的语义：下发接口与后台保存前的
// 合并（后台允许只提交部分字段，未提交的沿用已存值）。
func (h *Handler) readBrandingRow(ctx context.Context) (map[string]interface{}, bool, error) {
	var raw []byte
	err := h.DB.QueryRow(ctx,
		"SELECT config FROM rongcloud_system_config WHERE config_key=$1 LIMIT 1",
		brandingConfigKey).Scan(&raw)
	if err != nil {
		// sql.ErrNoRows 与"表里没有这一行"同义：当作没配，不是故障。
		if isNoRows(err) {
			return map[string]interface{}{}, false, nil
		}
		return nil, false, err
	}
	cfg := map[string]interface{}{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &cfg); err != nil {
			// 一行坏 JSON 不该让整站头像 500：当作没配继续（内置值兜底）。
			slog.Warn("branding: config 不是合法 JSON，回落内置默认图", "error", err)
			return map[string]interface{}{}, false, nil
		}
	}
	return cfg, true, nil
}

// loadBranding 读配置并归一化，任何缺失/非法的槽位回落内置值。
//
// 返回的每一项都保证非空且是绝对 URL —— 调用方（下发接口 / 进程内投影）
// 不需要再做判空。
func (h *Handler) loadBranding(ctx context.Context, base string) brandingConfig {
	cfg := builtinBranding()
	if strings.TrimSpace(base) == "" {
		// 启动路径没有 request，只能靠 env。正常情况库里存的已经是绝对 URL
		// （保存时就归一过），走不到这里；只有手工 SQL 写进相对路径时才需要它。
		base = strings.TrimRight(strings.TrimSpace(os.Getenv(brandingPublicBaseEnv)), "/")
	}
	raw, ok, err := h.readBrandingRow(ctx)
	if err != nil {
		slog.Warn("branding: 读取系统配置失败，回落内置默认图", "error", err)
		return cfg
	}
	if !ok {
		return cfg
	}
	pick := func(key, fallback string) string {
		v, _ := raw[key].(string)
		normalized := normalizeBrandingImageURL(v, base)
		if normalized == "" {
			return fallback
		}
		return normalized
	}
	cfg.UserAvatar = pick("user_avatar", cfg.UserAvatar)
	cfg.GroupAvatar = pick("group_avatar", cfg.GroupAvatar)
	cfg.DiscussionAvatar = pick("discussion_avatar", cfg.DiscussionAvatar)
	cfg.ChatroomAvatar = pick("chatroom_avatar", cfg.ChatroomAvatar)
	cfg.Logo = pick("logo", cfg.Logo)
	return cfg
}

// ApplyBranding 把配置加载进进程内投影（rongcloud 包据此生成写进融云的 URL），
// 并打一条图源日志。
//
// 两个调用点：服务启动时（cmd/server）、后台保存 branding 之后。多实例部署下
// 其他实例要等下次启动或下次保存才更新 —— 与"在线心跳表在进程内"是同一类
// 已知限制，当前是单实例。
func (h *Handler) ApplyBranding(ctx context.Context, base string) brandingConfig {
	cfg := h.loadBranding(ctx, base)
	applyBrandingToRuntime(cfg)
	slog.Info("品牌图片图源",
		"user", cfg.UserAvatar,
		"group", cfg.GroupAvatar,
		"discussion", cfg.DiscussionAvatar,
		"chatroom", cfg.ChatroomAvatar,
		"logo", cfg.Logo)
	return cfg
}

// applyBrandingToRuntime 把配置推给 rongcloud 包（进程内，无 DB 依赖）。
func applyBrandingToRuntime(cfg brandingConfig) {
	rongcloud.SetBrandingOverrides(rongcloud.BrandingOverrides{
		UserAvatar:       cfg.UserAvatar,
		GroupAvatar:      cfg.GroupAvatar,
		DiscussionAvatar: cfg.DiscussionAvatar,
		ChatroomAvatar:   cfg.ChatroomAvatar,
		Logo:             cfg.Logo,
	})
}

// normalizeBrandingConfigJSON 在后台保存前把相对路径补成绝对 URL，再序列化回存。
//
// 为什么在保存时做而不是在读的时候做：服务端写融云的那条链路（建群、建聊天室、
// 回填脚本）**没有 request 上下文**，读的时候补不出 host。存进去的就是最终值，
// 读侧才是一段纯粹、可测、与请求无关的逻辑。
//
// 返回 ok=false 表示这份 JSON 不能当作 branding 配置用（交给调用方按普通配置存）。
func normalizeBrandingConfigJSON(rawValue, base string) (string, bool) {
	trimmed := strings.TrimSpace(rawValue)
	if trimmed == "" || !json.Valid([]byte(trimmed)) {
		return "", false
	}
	var incoming map[string]interface{}
	if err := json.Unmarshal([]byte(trimmed), &incoming); err != nil {
		return "", false
	}
	// 只接受对象；数组/标量不是 branding 配置。
	if incoming == nil {
		return "", false
	}
	out := map[string]string{}
	for _, key := range []string{"user_avatar", "group_avatar", "discussion_avatar", "chatroom_avatar", "logo"} {
		v, _ := incoming[key].(string)
		// 用户清空某个槽位 = 恢复内置：存空串（读侧会自动回落）。
		out[key] = ""
		if normalized := normalizeBrandingImageURL(v, base); normalized != "" {
			out[key] = normalized
		}
		// 传了但归一化失败（比如 javascript:）→ 存空串而不是原样存，
		// 否则下发接口还要再挡一次，且库里会留下脏值。
		if strings.TrimSpace(v) != "" && out[key] == "" {
			slog.Warn("branding: 丢弃不合法的图片地址", "key", key, "value", v)
		}
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return "", false
	}
	return string(encoded), true
}

// ClawBranding GET /api/config/branding —— 公开只读，给 web 与小程序启动时拉。
//
// 不需要登录：这是纯展示配置（5 个图片地址），登录前就要用（登录页有 Logo）。
// 返回的 5 个字段保证非空绝对 URL，客户端可以直接塞进 `<img src>`，不用再判空。
func (h *Handler) ClawBranding(w http.ResponseWriter, r *http.Request) {
	cfg := h.loadBranding(r.Context(), brandingPublicBaseURL(r))
	clawJSON(w, 200, 200, "", map[string]interface{}{
		"user_avatar":       cfg.UserAvatar,
		"group_avatar":      cfg.GroupAvatar,
		"discussion_avatar": cfg.DiscussionAvatar,
		"chatroom_avatar":   cfg.ChatroomAvatar,
		"logo":              cfg.Logo,
	})
}

// brandingImageExts 是允许上传的图片扩展名（与内容类型一起校验）。
var brandingImageExts = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".svg":  "image/svg+xml",
}

// brandingMaxUploadBytes 单张品牌图上限。默认头像在列表里最宽也就 96px@3x，
// 2 MB 已经远大于实际需要；再大只会拖慢首屏（这五张图每个会话列表都要用）。
const brandingMaxUploadBytes = 2 << 20

// ClawAdminUploadBrandingImage POST /api/admin/branding/upload —— 后台上传品牌图。
//
// 为什么不复用 `/api/upload-file`：那条要求普通用户登录态（`requireUserID`），
// 后台拿到的是 admin token，过不去；`/api/claw/node-files` 又要设备凭据。
// 与其放宽那两条的鉴权，不如给后台单开一条只写 `branding/` 前缀的上传路径。
func (h *Handler) ClawAdminUploadBrandingImage(w http.ResponseWriter, r *http.Request) {
	ident := h.requireClawAdmin("admin:write", w, r)
	if ident == nil {
		return
	}
	if h.Storage == nil {
		clawAdminFail(w, 503, "file_upload_not_configured")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, brandingMaxUploadBytes)
	if err := r.ParseMultipartForm(brandingMaxUploadBytes); err != nil {
		clawAdminFail(w, 400, "图片过大或表单格式错误")
		return
	}
	defer r.MultipartForm.RemoveAll()

	file, header, err := r.FormFile("file")
	if err != nil {
		clawAdminFail(w, 400, "缺少 file 字段")
		return
	}
	defer file.Close()

	ext := strings.ToLower(path.Ext(header.Filename))
	contentType, allowed := brandingImageExts[ext]
	if !allowed {
		clawAdminFail(w, 400, "只支持 png / jpg / webp / svg")
		return
	}
	// 上限已经在 ParseMultipartForm 拦过，这里再读一次实际字节用于内容嗅探。
	data, err := io.ReadAll(file)
	if err != nil {
		clawAdminFail(w, 400, "读取图片失败")
		return
	}
	if len(data) == 0 {
		clawAdminFail(w, 400, "图片是空文件")
		return
	}
	// MSIE / 老客户端会传 application/octet-stream，扩展名映射已经覆盖了这种情况；
	// 这里只做一次"看起来像图片"的最低校验，避免把任意文件塞进图片槽位。
	if !looksLikeImage(data, contentType) {
		clawAdminFail(w, 400, "文件内容不是图片")
		return
	}

	id, err := uuid.NewV7()
	if err != nil {
		clawAdminFail(w, 500, "internal error")
		return
	}
	// 固定 branding/ 前缀：这五张图与用户附件、头像分开存，日后清理残留好识别。
	key := "branding/" + id.String() + ext
	publicURL, err := h.Storage.Upload(r.Context(), key, data, contentType, header.Filename)
	if err != nil {
		slog.Error("branding: 上传图片失败", "error", err)
		clawAdminFail(w, 500, "上传失败")
		return
	}
	// LocalStorage 返回的是 `/uploads/<key>`，小程序与融云需要绝对 URL，
	// 这里立刻补全（后台随后会把它存进配置，存的就是绝对值）。
	if normalized := normalizeBrandingImageURL(publicURL, brandingPublicBaseURL(r)); normalized != "" {
		publicURL = normalized
	}
	clawAdminOK(w, map[string]interface{}{"url": publicURL, "content_type": contentType, "size": len(data)})
}

// looksLikeImage 用魔数做一次最低限度校验。SVG 是文本，按 `<svg` 前缀判。
func looksLikeImage(data []byte, contentType string) bool {
	if strings.HasPrefix(contentType, "image/svg") {
		head := strings.TrimSpace(string(data))
		// 允许 XML 声明在 `<svg` 之前。
		return strings.Contains(strings.ToLower(head), "<svg")
	}
	if len(data) < 12 {
		return false
	}
	switch {
	case data[0] == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G':
		return true
	case data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF: // jpeg
		return true
	case string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return true
	}
	return false
}

// isNoRows 把 pgx 的 ErrNoRows 判定收在一处（避免每个调用点都写一遍 errors.Is）。
func isNoRows(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, pgx.ErrNoRows)
}
