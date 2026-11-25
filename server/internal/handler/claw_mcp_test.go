package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/integrations/rongcloud"
)

func TestInitClawMCPRegistersTools(t *testing.T) {
	h := &Handler{}
	h.InitClawMCP()
	if h.MCPServer == nil || h.MCPLimiter == nil {
		t.Fatal("InitClawMCP did not wire server/limiter")
	}
	names := h.MCPServer.ToolNames()
	want := []string{
		"list_chatrooms",
		"list_discussions",
		"get_discussion",
		"get_discussion_events",
		"list_round_documents",
		"get_round_document",
		// P2 控制类
		"create_roundtable",
		"get_roundtable_setup",
		"confirm_roundtable",
		"control_discussion",
	}
	if len(names) != len(want) {
		t.Fatalf("tool count = %d, want %d (%v)", len(names), len(want), names)
	}
	for i, name := range want {
		if names[i] != name {
			t.Fatalf("tool[%d] = %q, want %q", i, names[i], name)
		}
	}
}

func TestClawMCPOriginAllowlist(t *testing.T) {
	t.Setenv("MULTICA_CLAW_MCP_ALLOWED_ORIGINS", "https://benma.example, https://superwagie.example")

	cases := []struct {
		origin string
		want   int
	}{
		{"", http.StatusOK}, // 服务器对服务器：无 Origin 放行
		{"https://benma.example", http.StatusOK},
		{"https://BENMA.example", http.StatusOK}, // 大小写不敏感
		{"https://evil.example", http.StatusForbidden},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodPost, "/mcp", nil)
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		w := httptest.NewRecorder()
		if ok := clawMCPOriginAllowed(w, r); !ok && c.want == http.StatusOK {
			t.Fatalf("origin %q should pass", c.origin)
		}
		if w.Code != c.want {
			t.Fatalf("origin %q status = %d, want %d", c.origin, w.Code, c.want)
		}
	}
}

func TestClawMCPRateLimiterBurstAndRefill(t *testing.T) {
	clock := &clawMCPTestClock{t: time.Unix(1_700_000_000, 0)}
	limiter := newClawMCPRateLimiter(2) // 2/min
	limiter.now = clock.now

	if !limiter.allow("u1") || !limiter.allow("u1") {
		t.Fatal("burst of 2 should pass")
	}
	if limiter.allow("u1") {
		t.Fatal("third call within the same second must be rejected")
	}
	// 另一个用户不受影响。
	if !limiter.allow("u2") {
		t.Fatal("buckets must be per user")
	}
	// 60 秒后回满。
	clock.advance(time.Minute)
	if !limiter.allow("u1") {
		t.Fatal("tokens should refill after a minute")
	}
}

func TestClawMCPRateLimiterDisabled(t *testing.T) {
	limiter := newClawMCPRateLimiter(0)
	for i := 0; i < 100; i++ {
		if !limiter.allow("u1") {
			t.Fatal("perMinute<=0 must disable limiting")
		}
	}
}

func TestClawMCPArgParsing(t *testing.T) {
	if _, err := clawMCPArgString(map[string]any{}, "chatroomId"); err == nil {
		t.Fatal("missing argument must fail")
	}
	if _, err := clawMCPArgString(map[string]any{"chatroomId": "  "}, "chatroomId"); err == nil {
		t.Fatal("blank argument must fail")
	}
	got, err := clawMCPArgString(map[string]any{"chatroomId": " c1 "}, "chatroomId")
	if err != nil || got != "c1" {
		t.Fatalf("got %q err %v", got, err)
	}

	if v, err := clawMCPArgInt64(map[string]any{}, "afterSeq"); err != nil || v != 0 {
		t.Fatalf("absent afterSeq should default to 0, got %d err %v", v, err)
	}
	if _, err := clawMCPArgInt64(map[string]any{"afterSeq": -1.0}, "afterSeq"); err == nil {
		t.Fatal("negative afterSeq must fail")
	}
	if v, err := clawMCPArgInt64(map[string]any{"afterSeq": 12.0}, "afterSeq"); err != nil || v != 12 {
		t.Fatalf("got %d err %v", v, err)
	}
	if _, err := clawMCPArgInt64(map[string]any{"afterSeq": "12"}, "afterSeq"); err == nil {
		t.Fatal("string afterSeq must fail")
	}
}

func TestClawMCPControlToolsDeclareSchemas(t *testing.T) {
	h := &Handler{}
	byName := map[string]*mcpTool{}
	for _, tool := range h.clawMCPControlTools() {
		byName[tool.Name] = &mcpTool{description: tool.Description, schema: tool.InputSchema}
	}
	for _, name := range []string{"create_roundtable", "get_roundtable_setup", "confirm_roundtable", "control_discussion"} {
		tool, ok := byName[name]
		if !ok {
			t.Fatalf("control tool %q not registered", name)
		}
		if strings.TrimSpace(tool.description) == "" {
			t.Fatalf("tool %q has no description", name)
		}
		if tool.schema["type"] != "object" {
			t.Fatalf("tool %q schema is not an object schema", name)
		}
	}
	// control_discussion 的 enum 必须与门面接受的动作集合一致，否则模型会照着
	// schema 传一个服务端不认的动作。
	enum, ok := byName["control_discussion"].schema["properties"].(map[string]any)["action"].(map[string]any)["enum"].([]string)
	if !ok {
		t.Fatal("control_discussion.action has no enum")
	}
	if len(enum) != len(rongcloud.LifecycleActions) {
		t.Fatalf("enum has %d actions, facade accepts %d", len(enum), len(rongcloud.LifecycleActions))
	}
	for _, action := range enum {
		if !rongcloud.LifecycleActions[action] {
			t.Fatalf("enum exposes unsupported action %q", action)
		}
	}
}

func TestClawMCPConfirmRolesParsing(t *testing.T) {
	if got := clawMCPConfirmRoles(map[string]any{}); got != nil {
		t.Fatalf("absent roles must yield nil (server picks the recommendation), got %#v", got)
	}
	roles := clawMCPConfirmRoles(map[string]any{"roles": []any{
		map[string]any{"roleId": "r1", "roleName": "主持人", "rolePrompt": "引导", "nodeId": "n1"},
	}})
	if len(roles) != 1 || roles[0].RoleID != "r1" || roles[0].NodeID != "n1" {
		t.Fatalf("roles = %#v", roles)
	}
	// 形状不对时宁可回 nil 交给服务端按推荐全选，也不猜一个半成品参数。
	if got := clawMCPConfirmRoles(map[string]any{"roles": []any{"not-an-object"}}); got != nil {
		t.Fatalf("malformed roles must yield nil, got %#v", got)
	}
}

func TestClawMCPControlMessageCoversServerCodes(t *testing.T) {
	for _, code := range []string{
		"QUOTA_EXCEEDED", "SYSTEM_HOST_OFFLINE", "SYSTEM_HOST_CONFIG_CHANGED",
		"RECOMMENDATION_EXPIRED", "ROUNDTABLE_CREATE_REQUEST_NOT_FOUND",
		"DISCUSSION_SETUP_STEP_CONFLICT", "ROLE_DEVICE_UNAVAILABLE",
	} {
		if clawMCPControlMessage(code) == code {
			t.Fatalf("code %q has no human-readable message", code)
		}
	}
	// 未知原因码原样透出，不编故事。
	if got := clawMCPControlMessage("SOMETHING_NEW"); got != "SOMETHING_NEW" {
		t.Fatalf("unknown code rewritten to %q", got)
	}
}

func TestClawMCPControlResultIsErrorOnBusinessFailure(t *testing.T) {
	result, err := clawMCPControlResult("control_discussion:stop", "u1", "room-1", rongcloud.ControlOutcome{
		Code: 503, Message: "SYSTEM_HOST_OFFLINE",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsError {
		t.Fatal("business failure must set isError")
	}
	payload, ok := result.StructuredContent.(map[string]any)
	if !ok || payload["code"] != "SYSTEM_HOST_OFFLINE" || payload["status"] != 503 {
		t.Fatalf("payload = %#v", result.StructuredContent)
	}

	okResult, err := clawMCPControlResult("control_discussion:continue", "u1", "room-1", rongcloud.ControlOutcome{
		Code: 200, Data: map[string]any{"discussionId": "d1", "status": "running"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if okResult.IsError {
		t.Fatal("success must not be isError")
	}
	payload, _ = okResult.StructuredContent.(map[string]any)
	if payload["ok"] != true || payload["discussionId"] != "d1" {
		t.Fatalf("payload = %#v", okResult.StructuredContent)
	}
}

// mcpTool 是 tools/list 断言用的最小视图。
type mcpTool struct {
	description string
	schema      map[string]any
}

func TestClawMCPTruncateUTF8KeepsRunesWhole(t *testing.T) {
	// 每个汉字 3 字节；limit=4 时不能劈开第二个字。
	out := clawMCPTruncateUTF8("虾说虾说", 4)
	if out != "虾" {
		t.Fatalf("truncated = %q", out)
	}
	if !strings.HasPrefix("虾说虾说", out) {
		t.Fatal("truncation must be a prefix")
	}
}

func TestClawMCPEventStreamDetection(t *testing.T) {
	cases := []struct {
		accept string
		want   bool
	}{
		{"application/json", false},
		{"application/json, text/event-stream", false}, // 两种都收：优先 JSON
		{"text/event-stream", true},
		{"", false},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodPost, "/mcp", nil)
		if c.accept != "" {
			r.Header.Set("Accept", c.accept)
		}
		if got := clawMCPWantsEventStream(r); got != c.want {
			t.Fatalf("accept %q => %v, want %v", c.accept, got, c.want)
		}
	}
}

type clawMCPTestClock struct{ t time.Time }

func (c *clawMCPTestClock) now() time.Time { return c.t }

func (c *clawMCPTestClock) advance(d time.Duration) { c.t = c.t.Add(d) }
