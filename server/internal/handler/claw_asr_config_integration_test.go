package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// claw_asr_config_integration_test.go（T05）把 claw_asr_config_test.go 的单测
// 拼成**路由级全流程**：从鉴权（401/403）→ 管理端写（PUT）→ 读回脱敏（GET）
// → sk 留空保持 → 能力声明透传 → 损坏 JSONB 兜底 → 转写闸门 4501。
//
// 与单测的差异：单测各管一段（比如 PUT 只看落库），集成测试用**同一个 fake DB
// 顺序喂多步**，验证状态像真库一样在步骤间流转（PUT 写进去的值是后续 GET 读
// 出来的值）。仍然不连真库：convFakeDB 打桩即可，桩语义 = 一张只存 asr 一行
// 的内存表（asrFakeConfigStore）。
//
// 转写闸门的端到端断言：asrGate 是融云命令通道 ai/recognizeVoice 的服务端
// 闸门（装配点 cmd/server/router.go 的 rongcloud.ChannelDeps.AsrVoiceGate），
// 这里从 HTTP 侧 handler 包验证三层语义：关闭 4501、开启放行、无行 fail-closed。

// ---- 内存配置行 ----------------------------------------------------------------

// asrFakeConfigStore 模拟 rongcloud_system_config 里 config_key='asr' 的一行
// （PUT 之后 GET 能读到，模拟真库的持久语义）。nil row = 行不存在。
type asrFakeConfigStore struct {
	row []byte
	// broken 形式的行（损坏 JSONB），与 row 二选一注入。
	lastExecSQL string
}

func (s *asrFakeConfigStore) fakeDB(t *testing.T, permissions []string) *convFakeDB {
	t.Helper()
	permsJSON, _ := json.Marshal(permissions)
	authRow := &convStubRow{values: []any{
		convAdminID, "boss", "老板", "role-1", "active", "超级管理员", permsJSON,
	}}
	fake := &convFakeDB{}
	fake.queryRow = func(sql string, args []any) pgx.Row {
		switch {
		case strings.Contains(sql, "FROM claw_admin_users"):
			return authRow
		case strings.Contains(sql, "FROM claw_im_users"):
			return &convStubRow{values: []any{"user-1"}}
		case strings.Contains(sql, "SELECT config FROM rongcloud_system_config"):
			if s.row == nil {
				return &convStubRow{err: pgx.ErrNoRows}
			}
			return &convStubRow{values: []any{s.row}}
		case strings.Contains(sql, "SELECT workspace_id::text FROM rongcloud_system_config"),
			strings.Contains(sql, "SELECT id::text FROM workspace"):
			return &convStubRow{values: []any{"ws-1"}}
		}
		panic("unexpected QueryRow: " + sql)
	}
	fake.exec = func(sql string, args []any) (pgconn.CommandTag, error) {
		// upsert 的 $3 是完整 JSONB payload：存进内存"表"，供后续步骤读。
		if strings.Contains(sql, "INSERT INTO rongcloud_system_config") && len(args) == 3 {
			if raw, ok := args[2].([]byte); ok {
				s.row = raw
				s.lastExecSQL = sql
			}
		}
		return pgconn.NewCommandTag("INSERT 0 1"), nil
	}
	return fake
}

// putAsr 走真正的 handler 发一次 PUT（与线上同一条代码路径），返回 HTTP 状态码。
func putAsr(t *testing.T, h *Handler, body string) int {
	t.Helper()
	rr := httptest.NewRecorder()
	h.ClawAdminAsrConfigPut(rr, asrAdminRequest(t, "PUT", "/api/admin/system/config/asr", body))
	return rr.Code
}

// getAsrAdmin 走真正的 handler 发一次管理端 GET，返回 (状态码, data)。
func getAsrAdmin(t *testing.T, h *Handler) (int, map[string]interface{}) {
	t.Helper()
	rr := httptest.NewRecorder()
	h.ClawAdminAsrConfigGet(rr, asrAdminRequest(t, "GET", "/api/admin/system/config/asr", ""))
	if rr.Code != http.StatusOK {
		return rr.Code, nil
	}
	return rr.Code, dataMap(t, decodeConv(t, rr))
}

// getAsrCapability 走真正的 handler 发一次能力声明 GET，返回 (状态码, data)。
func getAsrCapability(t *testing.T, h *Handler) (int, map[string]interface{}) {
	t.Helper()
	rr := httptest.NewRecorder()
	h.ClawAsrCapability(rr, asrUserRequest(t, "GET", "/api/config/asr"))
	if rr.Code != http.StatusOK {
		return rr.Code, nil
	}
	var payload struct {
		Data map[string]interface{} `json:"data"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil {
		t.Fatalf("能力声明响应不是合法 JSON: %v (%s)", err, rr.Body.String())
	}
	return rr.Code, payload.Data
}

// ---- 全流程：PUT → GET 脱敏 → PUT 留空保持 → 能力透传 --------------------------

func TestAsrIntegrationPutGetMaskKeepFlow(t *testing.T) {
	store := &asrFakeConfigStore{}
	h := &Handler{DB: store.fakeDB(t, []string{"system:read", "system:write"})}

	// 步骤 1：首开 PUT（行不存在 → 新建），enabled=true + 合法凭据。
	if code := putAsr(t, h, `{"enabled":true,"ask":"`+asrTestAsk+`","sk":"`+asrTestSK+`"}`); code != http.StatusOK {
		t.Fatalf("步骤1 PUT 状态码 = %d, want 200", code)
	}

	// 步骤 2：管理端 GET —— 脱敏回显，明文不出现。
	code, data := getAsrAdmin(t, h)
	if code != http.StatusOK {
		t.Fatalf("步骤2 GET 状态码 = %d", code)
	}
	if data["enabled"] != true || data["ask"] != asrTestAsk || data["sk"] != "****stuv" {
		t.Fatalf("步骤2 回读内容错误: %#v", data)
	}
	if updated, ok := data["updated_at"].(string); !ok || updated == "" {
		t.Fatalf("步骤2 updated_at 应为服务端生成的非空 UTC 时间: %#v", data["updated_at"])
	}

	// 步骤 3：能力声明 GET —— enabled=true 透传，响应不含任何凭据痕迹。
	code, capData := getAsrCapability(t, h)
	if code != http.StatusOK {
		t.Fatalf("步骤3 能力声明状态码 = %d", code)
	}
	if capData["enabled"] != true {
		t.Fatalf("步骤3 能力声明应透传 enabled=true: %#v", capData)
	}
	for _, forbidden := range []string{asrTestAsk, asrTestSK, "****stuv"} {
		if strings.Contains(capData["feature"].(string)+capData["entry_text"].(string), forbidden) {
			t.Fatalf("步骤3 能力声明泄露凭据痕迹: %#v", capData)
		}
	}

	// 步骤 4：只改 enabled=false（sk 留空）—— 旧凭据必须原样保留在库里。
	if code := putAsr(t, h, `{"enabled":false}`); code != http.StatusOK {
		t.Fatalf("步骤4 PUT 状态码 = %d, want 200", code)
	}

	// 步骤 5：重新 GET —— sk 脱敏形态不变（旧值保持的直接证据）。
	code, data = getAsrAdmin(t, h)
	if code != http.StatusOK {
		t.Fatalf("步骤5 GET 状态码 = %d", code)
	}
	if data["sk"] != "****stuv" {
		t.Fatalf("步骤5 sk 留空后应保持旧值脱敏形态 ****stuv, 实际 %v", data["sk"])
	}
	if data["enabled"] != false {
		t.Fatalf("步骤5 enabled 应为 false: %#v", data)
	}

	// 步骤 6：能力声明同步翻转为 false（关 = 客户端入口消失的依据）。
	_, capData = getAsrCapability(t, h)
	if capData["enabled"] != false {
		t.Fatalf("步骤6 能力声明应透传 enabled=false: %#v", capData)
	}
}

// ---- 鉴权链：401 / 403 路由级 --------------------------------------------------

func TestAsrIntegrationAuthChain(t *testing.T) {
	store := &asrFakeConfigStore{}
	fullPermDB := store.fakeDB(t, []string{"system:read", "system:write"})

	t.Run("能力接口未登录 401", func(t *testing.T) {
		h := &Handler{DB: asrUserTokenHandler()}
		rr := httptest.NewRecorder()
		h.ClawAsrCapability(rr, httptest.NewRequest("GET", "/api/config/asr", nil))
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("状态码 = %d, want 401", rr.Code)
		}
	})

	t.Run("管理读未登录 401", func(t *testing.T) {
		h := &Handler{DB: fullPermDB}
		rr := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/api/admin/system/config/asr", nil)
		h.ClawAdminAsrConfigGet(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("状态码 = %d, want 401", rr.Code)
		}
	})

	t.Run("管理写未登录 401", func(t *testing.T) {
		h := &Handler{DB: fullPermDB}
		rr := httptest.NewRecorder()
		req := httptest.NewRequest("PUT", "/api/admin/system/config/asr", strings.NewReader(`{}`))
		h.ClawAdminAsrConfigPut(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("状态码 = %d, want 401", rr.Code)
		}
	})

	t.Run("管理读写只认 system 权限 403", func(t *testing.T) {
		store := &asrFakeConfigStore{}
		h := &Handler{DB: store.fakeDB(t, []string{"user:read"})}
		rr := httptest.NewRecorder()
		h.ClawAdminAsrConfigGet(rr, asrAdminRequest(t, "GET", "/api/admin/system/config/asr", ""))
		if rr.Code != http.StatusForbidden {
			t.Fatalf("GET 状态码 = %d, want 403", rr.Code)
		}
		rr = httptest.NewRecorder()
		h.ClawAdminAsrConfigPut(rr, asrAdminRequest(t, "PUT", "/api/admin/system/config/asr", `{"enabled":false}`))
		if rr.Code != http.StatusForbidden {
			t.Fatalf("PUT 状态码 = %d, want 403", rr.Code)
		}
	})
}

// ---- 损坏 JSONB 兜底（fail-closed 三入口一致）----------------------------------

func TestAsrIntegrationCorruptRowFailsClosed(t *testing.T) {
	store := &asrFakeConfigStore{row: []byte(`{"enabled":true,"ask":"` + asrTestAsk + `","sk":"` + asrTestSK + `", NOT VALID`)}
	h := &Handler{DB: store.fakeDB(t, []string{"system:read", "system:write"})}

	// 管理端读：损坏行 → 200 + 空白表单（不 5xx，管理员可重存修复）。
	code, data := getAsrAdmin(t, h)
	if code != http.StatusOK || data["enabled"] != false || data["sk"] != "" {
		t.Fatalf("损坏行管理读应 200+空白表单: code=%d data=%#v", code, data)
	}

	// 能力声明：损坏行 → 200 + enabled=false（客户端当没有此功能）。
	code, capData := getAsrCapability(t, h)
	if code != http.StatusOK {
		t.Fatalf("损坏行能力声明应仍 200: %d", code)
	}
	if capData["enabled"] != false {
		t.Fatalf("损坏行能力声明必须 fail-closed: %#v", capData)
	}

	// 闸门：损坏行 → 拒绝（4501 语义），绝不放行。
	if err := h.asrGate(context.Background()); err != ErrAsrDisabled {
		t.Fatalf("损坏行闸门 = %v, want ErrAsrDisabled", err)
	}

	// 修复路径：管理员重新保存合法配置后，三处全部恢复。
	if code := putAsr(t, h, `{"enabled":true,"ask":"`+asrTestAsk+`","sk":"`+asrTestSK+`"}`); code != http.StatusOK {
		t.Fatalf("修复 PUT 状态码 = %d", code)
	}
	if _, data := getAsrAdmin(t, h); data["enabled"] != true || data["sk"] != "****stuv" {
		t.Fatalf("修复后管理读应恢复: %#v", data)
	}
	if _, capData := getAsrCapability(t, h); capData["enabled"] != true {
		t.Fatalf("修复后能力声明应恢复 true: %#v", capData)
	}
	if err := h.asrGate(context.Background()); err != nil {
		t.Fatalf("修复后闸门应放行, 实际 %v", err)
	}
}

// ---- 转写接口闸门 4501（第一部分的端到端断言）----------------------------------

func TestAsrIntegrationTranscribeGate(t *testing.T) {
	// 端到端语义（对照 rongcloud/asr_voice_gate_test.go 的命令通道断言）：
	// 关闭 → 4501；开启/无行 → asrGate 返回 nil/ErrAsrDisabled，装配点把它
	// 翻译成 AsrDisabledCommandCode。这里验证 handler 侧的闸门源与业务码契约。
	store := &asrFakeConfigStore{}
	h := &Handler{DB: store.fakeDB(t, []string{"system:read", "system:write"})}

	t.Run("配置行不存在 → 闸门拒绝（fail-closed，无历史默认开启）", func(t *testing.T) {
		if err := h.asrGate(context.Background()); err != ErrAsrDisabled {
			t.Fatalf("无配置行闸门 = %v, want ErrAsrDisabled", err)
		}
	})

	t.Run("enabled=false → 4501", func(t *testing.T) {
		if code := putAsr(t, h, `{"enabled":true,"ask":"`+asrTestAsk+`","sk":"`+asrTestSK+`"}`); code != http.StatusOK {
			t.Fatalf("PUT 状态码 = %d", code)
		}
		if code := putAsr(t, h, `{"enabled":false}`); code != http.StatusOK {
			t.Fatalf("关闭 PUT 状态码 = %d", code)
		}
		if err := h.asrGate(context.Background()); err != ErrAsrDisabled {
			t.Fatalf("关闭后闸门 = %v, want ErrAsrDisabled", err)
		}
	})

	t.Run("enabled=true → 放行且行为与基线一致", func(t *testing.T) {
		if code := putAsr(t, h, `{"enabled":true}`); code != http.StatusOK {
			// sk 留空 + 有旧值 → 合法（留空保持），应 200。
			t.Fatalf("开启 PUT 状态码 = %d (%s)", code, "sk 留空应保持旧值")
		}
		if err := h.asrGate(context.Background()); err != nil {
			t.Fatalf("开启后闸门 = %v, want nil（放行）", err)
		}
		// 基线一致性：能力声明与管理读在开启态的回包形状与 T01 单测一致。
		_, capData := getAsrCapability(t, h)
		if capData["enabled"] != true || capData["feature"] != "asr" || capData["provider"] != "baidu" {
			t.Fatalf("开启态能力声明形状漂移: %#v", capData)
		}
	})

	t.Run("业务码契约稳定", func(t *testing.T) {
		if AsrDisabledCode() != 4501 {
			t.Fatalf("AsrDisabledCode = %d, want 4501", AsrDisabledCode())
		}
		if got := asrCodeAliases[4501]; got != "asr_disabled" {
			t.Fatalf("4501 别名 = %q, want asr_disabled", got)
		}
	})
}
