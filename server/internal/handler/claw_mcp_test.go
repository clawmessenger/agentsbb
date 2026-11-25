package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestInitClawMCPRegistersQueryTools(t *testing.T) {
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
