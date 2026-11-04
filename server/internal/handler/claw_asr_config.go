package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// claw_asr_config.go 是「后台可配置的语音转文字（ASR）能力」的唯一读写入口。
//
// 存的是什么：`rongcloud_system_config` 的一行，config_key='asr'，config 是
// `{"enabled":…,"ask":…,"sk":…,"updated_at":…,"token_status":…}`。与 branding
// 同构（同一张 KV 表、同一条 upsert 语句、同一个 workspace 归属规则），不建新
// 表、不需要迁移。
//
// 与 branding 的两条关键差异（为什么不能走通用 system/config 透传）：
//  1. **sk 是云凭据**，等同密码：任何读接口只给 `****`+last4 脱敏形态，通用
//     JSONB 透传做不到；
//  2. **PUT 是部分更新**：sk/ask 缺省或空串 = 保持 DB 旧值（脱敏的必然推论，
//     否则管理员每改一次开关都得去百度控制台重新复制 sk）。
//
// 三条安全红线（设计文档第 6 章）：
//  1. 任何读接口不返回明文 sk；
//  2. 任何日志不打印 sk 明文或完整 payload；
//  3. fail-closed：行不存在 / JSONB 损坏 / 解析失败一律按 enabled=false，
//     「没配凭据就当没有这个功能」。
const asrConfigKey = "asr"

// ASR 业务错误码（设计文档 2.6：ASR 开关域 45xx、ASR 配置域 40xx，
// 客户端只判 code 不解析 message）。
const (
	// asrCodeDisabled：ASR 依赖路径在开关关闭时的统一业务码。
	asrCodeDisabled = 4501
	// asrCodeConfigInvalid：enabled=true 但凭据缺失/非法。
	asrCodeConfigInvalid = 4001
	// asrCodeBadRequest：请求体本身非法（JSON 坏 / enabled 非 bool）。
	asrCodeBadRequest = 4002
)

// asrTokenState 是 token_status.state 的合法取值（执行链路落地前恒为 unknown）。
const (
	asrTokenStateOK      = "ok"
	asrTokenStateInvalid = "invalid"
	asrTokenStateUnknown = "unknown"
)

// ErrAsrDisabled 是 asrGate 在开关关闭时返回的哨兵错误。执行链路落地后据此
// 映射业务码 4501（HTTP 200/403 由执行链路定），禁止把它当 500 处理。
var ErrAsrDisabled = errors.New("asr_disabled")

// 凭据格式：百度智能云 API Key 24 位 / Secret Key 32 位，字母数字（trim 后校验）。
var (
	asrAskPattern = regexp.MustCompile(`^[A-Za-z0-9]{24}$`)
	asrSKPattern  = regexp.MustCompile(`^[A-Za-z0-9]{32}$`)
)

// asrTokenStatus 是凭据健康状态的预留结构：本次恒缺省（state=unknown），
// 执行链路落地后由服务端在换 token 时维护，schema 先留位防演进卡壳。
type asrTokenStatus struct {
	State     string  `json:"state"`
	CheckedAt *string `json:"checked_at"`
}

// asrConfig 是 config_key='asr' 的 JSONB 落库结构，也是管理端 GET/PUT 的回包
// 基底（回包时 SK 字段装的是脱敏值，ask 明文——百度 API Key 本就按 header 明文
// 传输，泄露危害远小于 sk，明文回显便于管理员与控制台核对）。
//
// UpdatedAt 由服务端写入时生成（ISO 8601 UTC），请求体中出现则忽略；
// TokenStatus 本次恒为零值（State=unknown、CheckedAt=nil）。
type asrConfig struct {
	Enabled     bool           `json:"enabled"`
	Ask         string         `json:"ask"`
	SK          string         `json:"sk"`
	UpdatedAt   string         `json:"updated_at"`
	TokenStatus asrTokenStatus `json:"token_status"`
}

// asrBlankConfig 返回「行不存在 / 损坏」时的兜底配置（fail-closed 的具体形态）：
// 开关关、凭据空、时间空、token 状态 unknown。
func asrBlankConfig() asrConfig {
	return asrConfig{TokenStatus: asrTokenStatus{State: asrTokenStateUnknown}}
}

// maskSK 把 sk 变成可回显的脱敏形态：空串→空串；否则 `****` + last4。
// sk 正常 32 位，last4 足够管理员核对是不是同一把钥匙，又给不了撞库材料。
func maskSK(sk string) string {
	if sk == "" {
		return ""
	}
	return "****" + lastN(sk, 4)
}

// lastN 返回 s 的最后 n 个字符（按 byte；凭据字母数字集下与 rune 等价，
// 且即使遇到多字节也不会 panic —— 越界部分按空串处理）。
func lastN(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

// readAsrRow 读库里那一行原始 config（不存在时 ok=false）。
//
// 与 readBrandingRow 同一套语义：ErrNoRows 与「表里没有这一行」同义，不是故障；
// 坏 JSON 也不算故障（记日志后按没配处理），绝不让一行脏数据把配置接口打成 500。
func (h *Handler) readAsrRow(ctx context.Context) (map[string]interface{}, bool, error) {
	var raw []byte
	err := h.DB.QueryRow(ctx,
		"SELECT config FROM rongcloud_system_config WHERE config_key=$1 LIMIT 1",
		asrConfigKey).Scan(&raw)
	if err != nil {
		if isNoRows(err) {
			return map[string]interface{}{}, false, nil
		}
		return nil, false, err
	}
	cfg := map[string]interface{}{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &cfg); err != nil {
			// 一行坏 JSON 不该让 ASR 配置 500：当没配（fail-closed）。
			slog.Warn("asr: config 不是合法 JSON，按未配置处理", "error", err)
			return map[string]interface{}{}, false, nil
		}
	}
	return cfg, true, nil
}

// decodeAsrTokenStatus 从 JSONB 的 token_status 字段提取状态，只认合法枚举；
// 缺省/类型不对/枚举外一律 unknown（schema 预留字段，宽松读取）。
func decodeAsrTokenStatus(raw map[string]interface{}) asrTokenStatus {
	status := asrTokenStatus{State: asrTokenStateUnknown}
	obj, ok := raw["token_status"].(map[string]interface{})
	if !ok {
		return status
	}
	if state, ok := obj["state"].(string); ok {
		switch state {
		case asrTokenStateOK, asrTokenStateInvalid:
			status.State = state
		}
	}
	if checkedAt, ok := obj["checked_at"].(string); ok && checkedAt != "" {
		status.CheckedAt = &checkedAt
	}
	return status
}

// loadAsrConfig 读配置并兜底：行不存在 / JSONB 空 / 解析失败 → enabled=false。
//
// 这是最重要的读取约定（fail-closed）：「拿到 enabled=true 才显示入口」一条
// 判断走天下，客户端逻辑因此最简单。DB 层面的查询错误同样按没配处理并记日志
// ——能力声明接口必须永远可达（200），不能因为存储抖动把入口判断打成 5xx。
func (h *Handler) loadAsrConfig(ctx context.Context) asrConfig {
	cfg := asrBlankConfig()
	raw, ok, err := h.readAsrRow(ctx)
	if err != nil {
		slog.Warn("asr: 读取系统配置失败，按未开启处理", "error", err)
		return cfg
	}
	if !ok {
		return cfg
	}
	if enabled, ok := raw["enabled"].(bool); ok && enabled {
		cfg.Enabled = true
	}
	cfg.Ask, _ = raw["ask"].(string)
	cfg.SK, _ = raw["sk"].(string)
	cfg.UpdatedAt, _ = raw["updated_at"].(string)
	cfg.TokenStatus = decodeAsrTokenStatus(raw)
	return cfg
}

// asrGate 是 ASR 依赖路径的统一闸门（本次交付的执行链路挂载点占位）：
// enabled=false → ErrAsrDisabled（业务码 4501 语义）；DB 抖动 → 同样按关闭处理
// （loadAsrConfig 已兜底）。在途请求不复查（graceful drain，设计文档 3.3）。
func (h *Handler) asrGate(ctx context.Context) error {
	if !h.loadAsrConfig(ctx).Enabled {
		return ErrAsrDisabled
	}
	return nil
}

// AsrGate 是 asrGate 的导出形态：cmd/server 装配融云命令通道的语音转写闸门
// （rongcloud.ChannelDeps.AsrVoiceGate）时跨包取用。语义与 asrGate 完全一致
// ——内部路径继续用小写，导出仅为装配点服务。
func (h *Handler) AsrGate(ctx context.Context) error { return h.asrGate(ctx) }

// asrAdminData 把配置转成管理端回包形态：sk 脱敏、ask 明文、其余原样。
// 三个出参接口（能力声明除外）统一走这里，脱敏不可能被绕过。
func asrAdminData(cfg asrConfig) map[string]interface{} {
	return map[string]interface{}{
		"enabled":    cfg.Enabled,
		"ask":        cfg.Ask,
		"sk":         maskSK(cfg.SK),
		"updated_at": cfg.UpdatedAt,
		"token_status": map[string]interface{}{
			"state":      cfg.TokenStatus.State,
			"checked_at": cfg.TokenStatus.CheckedAt,
		},
	}
}

// ClawAsrCapability GET /api/config/asr —— 登录用户可读的能力声明。
//
// 为什么要求登录：开关状态也是信息（「这家有没有开语音转写」），不给匿名探测
// 的口子。响应**永不含 ask/sk 任何形式**——客户端只需要一个布尔。行损坏也
// 200 + enabled=false（loadAsrConfig 兜底），客户端「拿到 true 才显示入口」。
func (h *Handler) ClawAsrCapability(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.clawRequireClawUser(w, r); !ok {
		return
	}
	enabled := h.loadAsrConfig(r.Context()).Enabled
	clawJSON(w, 200, 200, "", map[string]interface{}{
		"enabled":    enabled,
		"feature":    "asr",
		"provider":   "baidu",
		"entry_text": "语音转文字",
	})
}

// ClawAdminAsrConfigGet GET /api/admin/system/config/asr —— 管理端读，sk 脱敏回显。
//
// 行不存在也 200 + 空白表单（enabled=false、ask/sk 空）：管理端首开体验是
// 「待填表单」而不是报错。修复一条损坏的配置同样从这里走（管理员看到 false
// 后重新保存即可）。
func (h *Handler) ClawAdminAsrConfigGet(w http.ResponseWriter, r *http.Request) {
	if h.requireClawAdmin("system:read", w, r) == nil {
		return
	}
	cfg := h.loadAsrConfig(r.Context())
	clawAdminOK(w, asrAdminData(cfg))
}

// clawAsrFail 以 ASR 域业务码回错：外壳仍是 {code, message}，但 code 装
// **业务码**（4001/4002，设计文档 2.6——客户端按 code 分支不解析 message），
// HTTP 状态单独传。管理端响应沿用 clawAdminFail 的形态，仅 code 语义收紧。
func clawAsrFail(w http.ResponseWriter, status, businessCode int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"code":    businessCode,
		"alias":   asrCodeAliases[businessCode],
		"message": message,
	})
}

// asrCodeAliases 业务码 → 稳定字符串别名（客户端兜底对账用）。
var asrCodeAliases = map[int]string{
	asrCodeDisabled:      "asr_disabled",
	asrCodeConfigInvalid: "asr_config_invalid",
	asrCodeBadRequest:    "bad_request",
}

// AsrDisabledCode 暴露 ASR 关闭业务码（4501）：执行链路落地后把 ErrAsrDisabled
// 映射成响应时用它，避免魔法数字散落。
func AsrDisabledCode() int { return asrCodeDisabled }

// asrPutRequest 是 PUT 请求体的解析结果。Ask/SK 用 *string 区分「字段缺省」
// 与「显式空串」（两者语义相同 = 保持 DB 旧值）；Unknown 只收集键名记日志，
// 内容绝不落日志（安全红线）。
type asrPutRequest struct {
	Enabled *bool
	Ask     *string
	SK      *string
	Unknown []string
}

// parseAsrPutRequest 解析 PUT 请求体：顶层必须是 JSON 对象；enabled 非 bool、
// ask/sk 非字符串都是结构层错误（4002）；未知字段忽略但记键名。
func parseAsrPutRequest(body []byte) (*asrPutRequest, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		// 数组 / 标量 / 坏 JSON 都进这里：不是合法的配置对象。
		return nil, errors.New("请求体必须是 JSON 对象")
	}
	req := &asrPutRequest{}
	if v, ok := raw["enabled"]; ok {
		if err := json.Unmarshal(v, &req.Enabled); err != nil {
			return nil, errors.New("enabled 必须是布尔")
		}
	}
	if v, ok := raw["ask"]; ok {
		if err := json.Unmarshal(v, &req.Ask); err != nil {
			return nil, errors.New("ask 必须是字符串")
		}
	}
	if v, ok := raw["sk"]; ok {
		if err := json.Unmarshal(v, &req.SK); err != nil {
			return nil, errors.New("sk 必须是字符串")
		}
	}
	for key := range raw {
		switch key {
		case "enabled", "ask", "sk", "updated_at", "token_status":
			// 已知字段或服务端维护字段，忽略请求值即可。
		default:
			req.Unknown = append(req.Unknown, key)
		}
	}
	return req, nil
}

// validateAsrConfig 实现 1.4 校验表（trim 后校验）：
//   - ask 填了就必须是 24 位字母数字，sk 填了就必须是 32 位（无论开关）；
//   - enabled=true 时 ask 必填；sk 要么这次填了、要么 DB 有旧值（留空保持），
//     两者皆无 = 无法凭空开启，400。
//   - enabled=false 时凭据可空，填了才校验格式（关功能、换钥匙中途态都合法）。
//
// storedSK 是 DB 旧值（已 trim 的调用方保证不在此做）。返回的 error message
// 只描述字段与期望格式，**不回显用户输入**。
func validateAsrConfig(cfg asrConfig, storedSK string) error {
	ask := strings.TrimSpace(cfg.Ask)
	sk := strings.TrimSpace(cfg.SK)
	if ask != "" && !asrAskPattern.MatchString(ask) {
		return errors.New("ask 格式应为 24 位字母数字")
	}
	if sk != "" && !asrSKPattern.MatchString(sk) {
		return errors.New("sk 格式应为 32 位字母数字")
	}
	if !cfg.Enabled {
		return nil
	}
	if ask == "" {
		return errors.New("开启语音转文字需要填写 ask（24 位字母数字）")
	}
	if sk == "" && strings.TrimSpace(storedSK) == "" {
		return errors.New("开启语音转文字需要填写 sk（32 位字母数字；留空保持不变仅在已有旧值时可用）")
	}
	return nil
}

// saveAsrConfig 复用 ClawAdminSystemConfigPut 的 upsert 语句（同列集、同冲突
// 目标 (workspace_id, config_key)）：workspace 取该键现有行，没有则落默认
// 工作区（与通用配置口同一套 fallback）。
func (h *Handler) saveAsrConfig(ctx context.Context, cfg asrConfig) error {
	payload, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	var wsID string
	if err := h.DB.QueryRow(ctx,
		"SELECT workspace_id::text FROM rongcloud_system_config WHERE config_key=$1 LIMIT 1",
		asrConfigKey).Scan(&wsID); err != nil {
		if err := h.DB.QueryRow(ctx,
			"SELECT id::text FROM workspace ORDER BY created_at LIMIT 1").Scan(&wsID); err != nil {
			return err
		}
	}
	_, err = h.DB.Exec(ctx, `
		INSERT INTO rongcloud_system_config (workspace_id, config_key, config)
		VALUES ($1, $2, $3)
		ON CONFLICT (workspace_id, config_key)
		DO UPDATE SET config = $3, config_version = rongcloud_system_config.config_version + 1, updated_at = now()`,
		wsID, asrConfigKey, payload)
	return err
}

// ClawAdminAsrConfigPut PUT /api/admin/system/config/asr —— 管理端写（部分更新）。
//
// 语义：sk/ask 缺省或空串 = 保持 DB 旧值，非空才覆盖；updated_at 服务端生成
// UTC；未知字段忽略。成功后回脱敏后的最新配置（前端免二次 GET）。
// 日志与错误路径不含 sk 明文、不含完整 payload。
func (h *Handler) ClawAdminAsrConfigPut(w http.ResponseWriter, r *http.Request) {
	ident := h.requireClawAdmin("system:write", w, r)
	if ident == nil {
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		clawAdminFail(w, 400, "请求体读取失败")
		return
	}
	req, perr := parseAsrPutRequest(body)
	if perr != nil {
		clawAsrFail(w, 400, asrCodeBadRequest, "请求体非法")
		return
	}
	enabled := false
	if req.Enabled != nil {
		enabled = *req.Enabled
	}

	stored := h.loadAsrConfig(r.Context())
	// 部分更新合并：凭据字段缺省/空串沿用旧值；enabled 缺省视为 false
	// （总开关没有「保持不变」语义——表单里它是显式的）。
	next := asrConfig{
		Enabled:     enabled,
		Ask:         stored.Ask,
		SK:          stored.SK,
		UpdatedAt:   time.Now().UTC().Format(time.RFC3339),
		TokenStatus: stored.TokenStatus,
	}
	if req.Ask != nil {
		next.Ask = strings.TrimSpace(*req.Ask)
	}
	if req.SK != nil && strings.TrimSpace(*req.SK) != "" {
		next.SK = strings.TrimSpace(*req.SK)
	}
	if verr := validateAsrConfig(next, stored.SK); verr != nil {
		// message 指明具体字段但不回显用户输入的值。
		clawAsrFail(w, 400, asrCodeConfigInvalid, verr.Error())
		return
	}
	if err := h.saveAsrConfig(r.Context(), next); err != nil {
		slog.Error("asr: 保存配置失败", "error", err)
		clawAdminFail(w, 500, "database error")
		return
	}
	if len(req.Unknown) > 0 {
		// 只记键名——键名是结构信息不是凭据，安全；值绝不打印。
		slog.Info("asr: PUT 忽略未知字段", "keys", req.Unknown)
	}
	h.clawAdminAudit(r, ident, "admin_asr_config_update", "system_config", asrConfigKey,
		map[string]interface{}{"enabled": next.Enabled})
	clawAdminOK(w, asrAdminData(next))
}
