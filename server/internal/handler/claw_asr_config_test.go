package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// claw_asr_config_test.go 覆盖 ASR 配置里那几段「错了会直接变成安全事故或静默
// 故障」的逻辑：
//
//   - sk 脱敏：任何读接口出现明文 sk 都是不可接受的事故；
//   - 部分更新：sk 留空 = 保持旧值，做错会把库里唯一的凭据清掉；
//   - fail-closed：行不存在 / 损坏 JSONB 必须按 enabled=false 兜底；
//   - 鉴权：能力接口不认匿名，管理读写不认低权限角色。
//
// 不需要真库：全部走 convFakeDB（同一套 convStubRow 打桩，见
// claw_admin_conversations_test.go），每条用例只声明它关心的语句。

// ---- 脚手架 -----------------------------------------------------------------

const (
	asrTestAsk = "abcdefghijklmnopqrstuvwx"         // 24 位
	asrTestSK  = "0123456789abcdefghijklmnopqrstuv" // 32 位（10 数字 + 22 字母）
)

// newAsrFakeDB 造一个带 admin 鉴权打桩的假 DB。configJSON 为 nil 表示库里没有
// asr 行（QueryRow 回 ErrNoRows）。用例按需 &Handler{DB: fake} 包一层。
type asrHandlerOptions struct {
	permissions []string
	configJSON  []byte
	execHook    func(sql string, args []any)
}

func newAsrFakeDB(t *testing.T, opts asrHandlerOptions) *convFakeDB {
	t.Helper()
	permsJSON, _ := json.Marshal(opts.permissions)
	authRow := &convStubRow{values: []any{
		convAdminID, "boss", "老板", "role-1", "active", "超级管理员", permsJSON,
	}}
	fake := &convFakeDB{}
	fake.queryRow = func(sql string, args []any) pgx.Row {
		switch {
		case strings.Contains(sql, "FROM claw_admin_users"):
			return authRow
		case strings.Contains(sql, "SELECT config FROM rongcloud_system_config"):
			if opts.configJSON == nil {
				return &convStubRow{err: pgx.ErrNoRows}
			}
			return &convStubRow{values: []any{opts.configJSON}}
		case strings.Contains(sql, "SELECT workspace_id::text FROM rongcloud_system_config"):
			return &convStubRow{values: []any{"ws-1"}}
		case strings.Contains(sql, "SELECT id::text FROM workspace"):
			return &convStubRow{values: []any{"ws-1"}}
		}
		panic("unexpected QueryRow: " + sql)
	}
	fake.exec = func(sql string, args []any) (pgconn.CommandTag, error) {
		if opts.execHook != nil {
			opts.execHook(sql, args)
		}
		return pgconn.NewCommandTag("INSERT 0 1"), nil
	}
	return fake
}

// newAsrHandler = newAsrFakeDB + Handler 包装（多数用例直接用它）。
func newAsrHandler(t *testing.T, opts asrHandlerOptions) *Handler {
	t.Helper()
	return &Handler{DB: newAsrFakeDB(t, opts)}
}

// asrUserRequest 造一个带 C 端登录态（Bearer = claw_im_users.rongcloud_token）
// 的请求，给能力声明接口用。
func asrUserRequest(t *testing.T, method, target string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	req.Header.Set("Authorization", "Bearer asr-test-rongcloud-token")
	return req
}

// asrAdminRequest 造一个带 admin token 的请求（convRequest 不带参数变体）。
func asrAdminRequest(t *testing.T, method, target, body string) *http.Request {
	t.Helper()
	return convRequest(t, method, target, body, nil)
}

// asrUserTokenHandler 造一个给能力接口打桩用户会话的假 DB：
// clawViewerUserID/clawRequireClawUser 会按 rongcloud_token 查 claw_im_users。
func asrUserTokenHandler() *convFakeDB {
	fake := &convFakeDB{}
	fake.queryRow = func(sql string, args []any) pgx.Row {
		switch {
		case strings.Contains(sql, "FROM claw_im_users"):
			return &convStubRow{values: []any{"user-1"}}
		case strings.Contains(sql, "SELECT config FROM rongcloud_system_config"):
			return &convStubRow{err: pgx.ErrNoRows}
		}
		panic("unexpected QueryRow: " + sql)
	}
	return fake
}

// ---- 纯函数 -----------------------------------------------------------------

func TestMaskSK(t *testing.T) {
	cases := map[string]string{
		"":        "",
		"   ":     "****   ", // 空白串不是空串，按原样脱敏（调用方应先 trim）
		"abcd":    "****abcd",
		asrTestSK: "****stuv", // 正常 32 位
		"z":       "****z",    // 单字符也只给 last1，不给额外信息
	}
	for input, want := range cases {
		if got := maskSK(input); got != want {
			t.Errorf("maskSK(%q) = %q, want %q", input, got, want)
		}
	}
	// 正控：明文绝不能出现在脱敏结果里。
	if masked := maskSK(asrTestSK); strings.Contains(masked, asrTestSK) {
		t.Fatal("脱敏结果包含明文 sk")
	}
}

func TestValidateAsrConfig(t *testing.T) {
	valid := asrConfig{Enabled: true, Ask: asrTestAsk, SK: asrTestSK}
	cases := []struct {
		name    string
		cfg     asrConfig
		stored  string
		wantErr bool
	}{
		{"合法全量", valid, "", false},
		{"sk 留空但有旧值（部分更新）", asrConfig{Enabled: true, Ask: asrTestAsk}, asrTestSK, false},
		{"enabled=true 无 ask", asrConfig{Enabled: true, SK: asrTestSK}, "", true},
		{"enabled=true sk 留空且无旧值", asrConfig{Enabled: true, Ask: asrTestAsk}, "", true},
		{"ask 格式非法", asrConfig{Enabled: true, Ask: "short", SK: asrTestSK}, "", true},
		{"sk 格式非法", asrConfig{Enabled: true, Ask: asrTestAsk, SK: "tooshort"}, "", true},
		{"enabled=false 凭据可空", asrConfig{Enabled: false}, "", false},
		{"enabled=false 填了非法格式仍拒绝", asrConfig{Enabled: false, Ask: "bad!"}, "", true},
		{"enabled=false 合法凭据允许（预留开启）", asrConfig{Enabled: false, Ask: asrTestAsk, SK: asrTestSK}, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateAsrConfig(tc.cfg, tc.stored)
			if tc.wantErr && err == nil {
				t.Fatalf("应当被拒绝，实际通过")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("应当通过，实际报 %v", err)
			}
		})
	}
}

func TestParseAsrPutRequest(t *testing.T) {
	t.Run("缺省字段全为 nil（部分更新信号）", func(t *testing.T) {
		req, err := parseAsrPutRequest([]byte(`{"enabled":true}`))
		if err != nil {
			t.Fatalf("解析失败: %v", err)
		}
		if req.Enabled == nil || *req.Enabled != true {
			t.Fatalf("enabled 解析错误: %#v", req.Enabled)
		}
		if req.Ask != nil || req.SK != nil {
			t.Fatalf("sk/ask 应为 nil（保持旧值）: %#v", req)
		}
	})
	t.Run("空串与缺省同样按保持旧值处理", func(t *testing.T) {
		req, err := parseAsrPutRequest([]byte(`{"enabled":false,"ask":"","sk":""}`))
		if err != nil {
			t.Fatalf("解析失败: %v", err)
		}
		if req.SK == nil || *req.SK != "" {
			t.Fatalf("显式空串应被识别: %#v", req.SK)
		}
	})
	t.Run("enabled 非布尔拒绝", func(t *testing.T) {
		if _, err := parseAsrPutRequest([]byte(`{"enabled":"yes"}`)); err == nil {
			t.Fatal("字符串 enabled 不应通过")
		}
	})
	t.Run("非对象请求体拒绝", func(t *testing.T) {
		for _, body := range []string{`[1,2]`, `"str"`, `not-json`, ``} {
			if _, err := parseAsrPutRequest([]byte(body)); err == nil {
				t.Errorf("%q 不应被当作合法配置请求", body)
			}
		}
	})
	t.Run("未知字段忽略但记录键名", func(t *testing.T) {
		req, err := parseAsrPutRequest([]byte(`{"enabled":false,"mystery":"x"}`))
		if err != nil {
			t.Fatalf("未知字段不应导致失败: %v", err)
		}
		if len(req.Unknown) != 1 || req.Unknown[0] != "mystery" {
			t.Fatalf("未知键名收集错误: %#v", req.Unknown)
		}
	})
}

func TestAsrGate(t *testing.T) {
	stubConfigRow := func(fake *convFakeDB, raw []byte) {
		fake.queryRow = func(sql string, args []any) pgx.Row {
			switch {
			case strings.Contains(sql, "SELECT config FROM rongcloud_system_config"):
				if raw == nil {
					return &convStubRow{err: pgx.ErrNoRows}
				}
				return &convStubRow{values: []any{raw}}
			}
			panic("unexpected QueryRow: " + sql)
		}
	}

	t.Run("enabled=false 返回 ErrAsrDisabled", func(t *testing.T) {
		fake := &convFakeDB{}
		stubConfigRow(fake, []byte(`{"enabled":false,"ask":"x","sk":"y"}`))
		h := &Handler{DB: fake}
		if err := h.asrGate(context.Background()); err != ErrAsrDisabled {
			t.Fatalf("asrGate = %v, want ErrAsrDisabled", err)
		}
	})
	t.Run("enabled=true 放行", func(t *testing.T) {
		fake := &convFakeDB{}
		stubConfigRow(fake, []byte(`{"enabled":true,"ask":"`+asrTestAsk+`","sk":"`+asrTestSK+`"}`))
		h := &Handler{DB: fake}
		if err := h.asrGate(context.Background()); err != nil {
			t.Fatalf("asrGate = %v, want nil", err)
		}
	})
	t.Run("行不存在按关闭处理（fail-closed）", func(t *testing.T) {
		fake := &convFakeDB{}
		stubConfigRow(fake, nil)
		h := &Handler{DB: fake}
		if err := h.asrGate(context.Background()); err != ErrAsrDisabled {
			t.Fatalf("asrGate = %v, want ErrAsrDisabled", err)
		}
	})
}

// ---- GET /api/config/asr（能力声明） -----------------------------------------

func TestClawAsrCapability(t *testing.T) {
	t.Run("未登录 401", func(t *testing.T) {
		h := &Handler{DB: asrUserTokenHandler()}
		rr := httptest.NewRecorder()
		h.ClawAsrCapability(rr, httptest.NewRequest("GET", "/api/config/asr", nil))
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("状态码 = %d, want 401", rr.Code)
		}
	})

	stubUserAndConfig := func(configJSON []byte) *Handler {
		fake := asrUserTokenHandler()
		fake.queryRow = func(sql string, args []any) pgx.Row {
			switch {
			case strings.Contains(sql, "FROM claw_im_users"):
				return &convStubRow{values: []any{"user-1"}}
			case strings.Contains(sql, "SELECT config FROM rongcloud_system_config"):
				if configJSON == nil {
					return &convStubRow{err: pgx.ErrNoRows}
				}
				return &convStubRow{values: []any{configJSON}}
			}
			panic("unexpected QueryRow: " + sql)
		}
		return &Handler{DB: fake}
	}

	full := `{"enabled":true,"ask":"` + asrTestAsk + `","sk":"` + asrTestSK + `","updated_at":"2026-11-04T08:00:00Z"}`

	t.Run("开启时透传 enabled=true 且响应不含 ask/sk", func(t *testing.T) {
		h := stubUserAndConfig([]byte(full))
		rr := httptest.NewRecorder()
		h.ClawAsrCapability(rr, asrUserRequest(t, "GET", "/api/config/asr"))
		if rr.Code != http.StatusOK {
			t.Fatalf("状态码 = %d (%s)", rr.Code, rr.Body.String())
		}
		body := rr.Body.String()
		if strings.Contains(body, "ask") || strings.Contains(body, "sk") {
			t.Fatalf("能力声明响应包含 ask/sk 键: %s", body)
		}
		if strings.Contains(body, asrTestSK) || strings.Contains(body, asrTestAsk) {
			t.Fatalf("能力声明响应泄露凭据内容: %s", body)
		}
		var payload struct {
			Code int `json:"code"`
			Data struct {
				Enabled bool   `json:"enabled"`
				Feature string `json:"feature"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil {
			t.Fatalf("响应不是合法 JSON: %v", err)
		}
		// C 端外壳约定（clawJSON）：成功 code=HTTP 状态码（与 /api/config/user-guide
		// 等既有能力接口一致）；管理端外壳（clawAdminOK）才是 code=0。
		if payload.Code != 200 || !payload.Data.Enabled || payload.Data.Feature != "asr" {
			t.Fatalf("能力声明内容错误: %s", rr.Body.String())
		}
	})

	t.Run("行不存在时 enabled=false（fail-closed）", func(t *testing.T) {
		h := stubUserAndConfig(nil)
		rr := httptest.NewRecorder()
		h.ClawAsrCapability(rr, asrUserRequest(t, "GET", "/api/config/asr"))
		if rr.Code != http.StatusOK {
			t.Fatalf("状态码 = %d, want 200", rr.Code)
		}
		var payload struct {
			Data struct {
				Enabled bool `json:"enabled"`
			} `json:"data"`
		}
		_ = json.Unmarshal(rr.Body.Bytes(), &payload)
		if payload.Data.Enabled {
			t.Fatalf("行不存在必须按 enabled=false 兜底: %s", rr.Body.String())
		}
	})

	t.Run("损坏 JSONB 时仍 200 + enabled=false", func(t *testing.T) {
		h := stubUserAndConfig([]byte(`{not-valid-json`))
		rr := httptest.NewRecorder()
		h.ClawAsrCapability(rr, asrUserRequest(t, "GET", "/api/config/asr"))
		if rr.Code != http.StatusOK {
			t.Fatalf("状态码 = %d, want 200（损坏行不能把能力接口打成 5xx）", rr.Code)
		}
		if strings.Contains(rr.Body.String(), `"enabled":true`) {
			t.Fatalf("损坏 JSONB 必须按 false 兜底: %s", rr.Body.String())
		}
	})
}

// ---- GET /api/admin/system/config/asr（管理端读） ----------------------------

func TestClawAdminAsrConfigGet(t *testing.T) {
	stored := `{"enabled":true,"ask":"` + asrTestAsk + `","sk":"` + asrTestSK + `","updated_at":"2026-11-04T08:00:00Z"}`

	t.Run("sk 脱敏回显且明文不出现", func(t *testing.T) {
		h := newAsrHandler(t, asrHandlerOptions{
			permissions: []string{"system:read"},
			configJSON:  []byte(stored),
		})
		rr := httptest.NewRecorder()
		h.ClawAdminAsrConfigGet(rr, asrAdminRequest(t, "GET", "/api/admin/system/config/asr", ""))
		if rr.Code != http.StatusOK {
			t.Fatalf("状态码 = %d (%s)", rr.Code, rr.Body.String())
		}
		data := dataMap(t, decodeConv(t, rr))
		if data["enabled"] != true {
			t.Fatalf("enabled = %v, want true", data["enabled"])
		}
		if data["ask"] != asrTestAsk {
			t.Fatalf("ask = %v, want 明文回显", data["ask"])
		}
		if data["sk"] != "****stuv" {
			t.Fatalf("sk = %v, want ****stuv（前4星+last4）", data["sk"])
		}
		assertNoSecret(t, rr, asrTestSK)
	})

	t.Run("行不存在返回 200 空白表单", func(t *testing.T) {
		h := newAsrHandler(t, asrHandlerOptions{permissions: []string{"system:read"}})
		rr := httptest.NewRecorder()
		h.ClawAdminAsrConfigGet(rr, asrAdminRequest(t, "GET", "/api/admin/system/config/asr", ""))
		if rr.Code != http.StatusOK {
			t.Fatalf("状态码 = %d, want 200", rr.Code)
		}
		data := dataMap(t, decodeConv(t, rr))
		if data["enabled"] != false || data["ask"] != "" || data["sk"] != "" {
			t.Fatalf("空白表单内容错误: %#v", data)
		}
	})

	t.Run("损坏 JSONB 返回 200 + enabled=false", func(t *testing.T) {
		h := newAsrHandler(t, asrHandlerOptions{
			permissions: []string{"system:read"},
			configJSON:  []byte(`{broken`),
		})
		rr := httptest.NewRecorder()
		h.ClawAdminAsrConfigGet(rr, asrAdminRequest(t, "GET", "/api/admin/system/config/asr", ""))
		if rr.Code != http.StatusOK {
			t.Fatalf("状态码 = %d, want 200", rr.Code)
		}
		data := dataMap(t, decodeConv(t, rr))
		if data["enabled"] != false {
			t.Fatalf("损坏行必须按 enabled=false 兜底: %#v", data)
		}
	})

	t.Run("非 admin 权限 403", func(t *testing.T) {
		h := newAsrHandler(t, asrHandlerOptions{permissions: []string{"user:read"}})
		rr := httptest.NewRecorder()
		h.ClawAdminAsrConfigGet(rr, asrAdminRequest(t, "GET", "/api/admin/system/config/asr", ""))
		if rr.Code != http.StatusForbidden {
			t.Fatalf("状态码 = %d, want 403", rr.Code)
		}
	})
}

// ---- PUT /api/admin/system/config/asr（管理端写，部分更新） -------------------

func TestClawAdminAsrConfigPut(t *testing.T) {
	stored := `{"enabled":true,"ask":"` + asrTestAsk + `","sk":"` + asrTestSK + `","updated_at":"2026-11-04T08:00:00Z"}`

	t.Run("合法凭据 PUT 成功且回读脱敏正确", func(t *testing.T) {
		var savedRaw []byte
		h := newAsrHandler(t, asrHandlerOptions{
			permissions: []string{"system:write"},
			configJSON:  nil,
			execHook: func(sql string, args []any) {
				if strings.Contains(sql, "INSERT INTO rongcloud_system_config") && len(args) == 3 {
					if raw, ok := args[2].([]byte); ok {
						savedRaw = raw
					}
				}
			},
		})
		rr := httptest.NewRecorder()
		h.ClawAdminAsrConfigPut(rr, asrAdminRequest(t, "PUT", "/api/admin/system/config/asr",
			`{"enabled":true,"ask":"`+asrTestAsk+`","sk":"`+asrTestSK+`"}`))
		if rr.Code != http.StatusOK {
			t.Fatalf("状态码 = %d (%s)", rr.Code, rr.Body.String())
		}
		// 落库内容：enabled=true、凭据明文入库（DB 侧本来就要明文换 token）。
		var persisted asrConfig
		if err := json.Unmarshal(savedRaw, &persisted); err != nil {
			t.Fatalf("落库的不是合法 JSON: %v", err)
		}
		if !persisted.Enabled || persisted.Ask != asrTestAsk || persisted.SK != asrTestSK {
			t.Fatalf("落库内容错误: %#v", persisted)
		}
		if persisted.UpdatedAt == "" {
			t.Fatal("updated_at 必须由服务端生成")
		}
		if _, err := parseRFC3339UTC(persisted.UpdatedAt); err != nil {
			t.Fatalf("updated_at 不是合法 UTC RFC3339: %v", err)
		}
		// 回包：脱敏形态，明文不出现。
		data := dataMap(t, decodeConv(t, rr))
		if data["sk"] != "****stuv" {
			t.Fatalf("回包 sk = %v, want ****stuv", data["sk"])
		}
		assertNoSecret(t, rr, asrTestSK)
	})

	t.Run("sk 留空时保留 DB 旧值", func(t *testing.T) {
		var savedRaw []byte
		h := newAsrHandler(t, asrHandlerOptions{
			permissions: []string{"system:write"},
			configJSON:  []byte(stored),
			execHook: func(sql string, args []any) {
				if strings.Contains(sql, "INSERT INTO rongcloud_system_config") && len(args) == 3 {
					if raw, ok := args[2].([]byte); ok {
						savedRaw = raw
					}
				}
			},
		})
		rr := httptest.NewRecorder()
		h.ClawAdminAsrConfigPut(rr, asrAdminRequest(t, "PUT", "/api/admin/system/config/asr",
			`{"enabled":true,"ask":"`+asrTestAsk+`","sk":""}`))
		if rr.Code != http.StatusOK {
			t.Fatalf("状态码 = %d (%s)", rr.Code, rr.Body.String())
		}
		var persisted asrConfig
		if err := json.Unmarshal(savedRaw, &persisted); err != nil {
			t.Fatalf("落库的不是合法 JSON: %v", err)
		}
		if persisted.SK != asrTestSK {
			t.Fatalf("sk 留空应保持旧值 %q, 实际 %q", asrTestSK, persisted.SK)
		}
		assertNoSecret(t, rr, asrTestSK)
	})

	t.Run("sk 留空且无旧值 + enabled=true → 400 asr_config_invalid", func(t *testing.T) {
		h := newAsrHandler(t, asrHandlerOptions{permissions: []string{"system:write"}})
		rr := httptest.NewRecorder()
		h.ClawAdminAsrConfigPut(rr, asrAdminRequest(t, "PUT", "/api/admin/system/config/asr",
			`{"enabled":true,"ask":"`+asrTestAsk+`"}`))
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("状态码 = %d, want 400", rr.Code)
		}
		body := decodeConv(t, rr)
		if code, _ := body["code"].(float64); code != 4001 {
			t.Fatalf("业务码 = %v, want 4001 (asr_config_invalid)", body["code"])
		}
	})

	t.Run("非法格式 → 400", func(t *testing.T) {
		h := newAsrHandler(t, asrHandlerOptions{permissions: []string{"system:write"}})
		for _, target := range []string{
			`{"enabled":true,"ask":"nope","sk":"` + asrTestSK + `"}`,
			`{"enabled":true,"ask":"` + asrTestAsk + `","sk":"nope"}`,
		} {
			rr := httptest.NewRecorder()
			h.ClawAdminAsrConfigPut(rr, asrAdminRequest(t, "PUT", "/api/admin/system/config/asr", target))
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("%s 未被拦截，状态码 = %d (%s)", target, rr.Code, rr.Body.String())
			}
		}
	})

	t.Run("请求体非法 → 400 bad_request", func(t *testing.T) {
		h := newAsrHandler(t, asrHandlerOptions{permissions: []string{"system:write"}})
		rr := httptest.NewRecorder()
		h.ClawAdminAsrConfigPut(rr, asrAdminRequest(t, "PUT", "/api/admin/system/config/asr", `not-json`))
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("状态码 = %d, want 400", rr.Code)
		}
		if code, _ := decodeConv(t, rr)["code"].(float64); code != 4002 {
			t.Fatal("业务码应为 4002 (bad_request)")
		}
	})

	t.Run("enabled=false 凭据留空合法保存", func(t *testing.T) {
		h := newAsrHandler(t, asrHandlerOptions{permissions: []string{"system:write"}})
		rr := httptest.NewRecorder()
		h.ClawAdminAsrConfigPut(rr, asrAdminRequest(t, "PUT", "/api/admin/system/config/asr",
			`{"enabled":false}`))
		if rr.Code != http.StatusOK {
			t.Fatalf("状态码 = %d (%s)", rr.Code, rr.Body.String())
		}
		data := dataMap(t, decodeConv(t, rr))
		if data["enabled"] != false {
			t.Fatalf("enabled = %v, want false", data["enabled"])
		}
	})

	t.Run("updated_at 与未知字段被忽略", func(t *testing.T) {
		h := newAsrHandler(t, asrHandlerOptions{permissions: []string{"system:write"}})
		rr := httptest.NewRecorder()
		h.ClawAdminAsrConfigPut(rr, asrAdminRequest(t, "PUT", "/api/admin/system/config/asr",
			`{"enabled":false,"updated_at":"1999-01-01T00:00:00Z","mystery":{"evil":1}}`))
		if rr.Code != http.StatusOK {
			t.Fatalf("状态码 = %d (%s)", rr.Code, rr.Body.String())
		}
		if got := dataMap(t, decodeConv(t, rr))["updated_at"]; got == "1999-01-01T00:00:00Z" {
			t.Fatal("updated_at 必须由服务端生成，不接受请求值")
		}
	})

	t.Run("非 admin 权限 403", func(t *testing.T) {
		h := newAsrHandler(t, asrHandlerOptions{permissions: []string{"system:read"}})
		rr := httptest.NewRecorder()
		h.ClawAdminAsrConfigPut(rr, asrAdminRequest(t, "PUT", "/api/admin/system/config/asr",
			`{"enabled":false}`))
		if rr.Code != http.StatusForbidden {
			t.Fatalf("状态码 = %d, want 403", rr.Code)
		}
	})

	t.Run("未登录 401", func(t *testing.T) {
		h := newAsrHandler(t, asrHandlerOptions{permissions: []string{"system:write"}})
		rr := httptest.NewRecorder()
		req := httptest.NewRequest("PUT", "/api/admin/system/config/asr", strings.NewReader(`{}`))
		h.ClawAdminAsrConfigPut(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("状态码 = %d, want 401", rr.Code)
		}
	})
}

// ---- 通用配置口不得漏出 asr 密钥 ---------------------------------------------

func TestSystemConfigGenericHidesAsrKey(t *testing.T) {
	t.Run("Get 拒绝 asr 键", func(t *testing.T) {
		fake := newAsrFakeDB(t, asrHandlerOptions{
			permissions: []string{"system:read"},
			configJSON:  []byte(`{"enabled":true,"ask":"a","sk":"` + asrTestSK + `"}`),
		})
		h := &Handler{DB: fake}
		rr := httptest.NewRecorder()
		h.ClawAdminSystemConfigGet(rr, embedRequestWithParams(t, "GET",
			"/api/admin/system/config/asr", "", map[string]string{"key": "asr"}))
		if rr.Code != http.StatusNotFound {
			t.Fatalf("状态码 = %d, want 404（asr 不允许走通用口）", rr.Code)
		}
		assertNoSecret(t, rr, asrTestSK)
	})

	t.Run("List 过滤 asr 键", func(t *testing.T) {
		now := time.Now()
		fake := newAsrFakeDB(t, asrHandlerOptions{permissions: []string{"system:read"}})
		fake.query = func(string, []any) (pgx.Rows, error) {
			return &convStubRows{rows: [][]any{
				{"asr", []byte(`{"enabled":true,"sk":"` + asrTestSK + `"}`), now, now},
				{"user_guide", []byte(`{"title":"x"}`), now, now},
			}}, nil
		}
		h := &Handler{DB: fake}
		rr := httptest.NewRecorder()
		h.ClawAdminSystemConfigList(rr, asrAdminRequest(t, "GET", "/api/admin/system/config", ""))
		items := dataList(t, decodeConv(t, rr))
		if len(items) != 1 {
			t.Fatalf("期望只剩 1 条可见配置，实际 %d 条: %#v", len(items), items)
		}
		kept, _ := items[0].(map[string]interface{})
		if kept["config_key"] != "user_guide" {
			t.Fatalf("asr 必须被 List 过滤: %#v", kept)
		}
		assertNoSecret(t, rr, asrTestSK)
	})
}

// parseRFC3339UTC 校验 s 是合法的 RFC3339 UTC 时间（服务端约定 Z 结尾）。
func parseRFC3339UTC(s string) (time.Time, error) {
	return time.Parse(time.RFC3339, s)
}
