package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

// timeFixture 让会话过期用例不依赖真实时钟。
type timeFixture struct{ t time.Time }

func (f *timeFixture) now() time.Time {
	if f.t.IsZero() {
		f.t = time.Unix(1_700_000_000, 0)
	}
	return f.t
}

func (f *timeFixture) advance(d time.Duration) { f.t = f.now().Add(d) }

func echoTool() *Tool {
	return &Tool{
		Name:        "echo",
		Description: "echoes",
		InputSchema: map[string]any{"type": "object"},
		Handler: func(ctx context.Context, args map[string]any) (CallResult, error) {
			if args["fail"] == true {
				return CallResult{}, Errorf("boom", "user %s asked to fail", UserID(ctx))
			}
			text, _ := args["text"].(string)
			return CallResult{Content: []Content{{Type: "text", Text: text}}}, nil
		},
	}
}

func newTestServer() *Server {
	return NewServer("agentsbb", "test", echoTool())
}

func mustCall(t *testing.T, s *Server, userID, sessionID, method string, params any) (Outcome, map[string]any) {
	t.Helper()
	body := map[string]any{"jsonrpc": "2.0", "id": 1, "method": method}
	if params != nil {
		body["params"] = params
	}
	raw, _ := json.Marshal(body)
	out := s.Handle(context.Background(), userID, sessionID, raw)
	var parsed map[string]any
	if len(out.Body) > 0 {
		if err := json.Unmarshal(out.Body, &parsed); err != nil {
			t.Fatalf("response is not JSON: %v (%s)", err, out.Body)
		}
	}
	return out, parsed
}

func TestInitializeIssuesSession(t *testing.T) {
	s := newTestServer()
	out, resp := mustCall(t, s, "u1", "", "initialize", map[string]any{"protocolVersion": ProtocolVersion20250326})
	if out.Status != http.StatusOK || out.SessionID == "" {
		t.Fatalf("initialize: status=%d session=%q", out.Status, out.SessionID)
	}
	result, _ := resp["result"].(map[string]any)
	if result["protocolVersion"] != ProtocolVersion20250326 {
		t.Fatalf("protocol version not negotiated: %v", result["protocolVersion"])
	}
	info, _ := result["serverInfo"].(map[string]any)
	if info["name"] != "agentsbb" {
		t.Fatalf("serverInfo.name = %v", info["name"])
	}
}

func TestInitializeFallsBackToLatestVersion(t *testing.T) {
	s := newTestServer()
	_, resp := mustCall(t, s, "u1", "", "initialize", map[string]any{"protocolVersion": "1999-01-01"})
	result, _ := resp["result"].(map[string]any)
	if result["protocolVersion"] != ProtocolVersion20250618 {
		t.Fatalf("expected fallback to %s, got %v", ProtocolVersion20250618, result["protocolVersion"])
	}
}

func TestToolsListIsOrdered(t *testing.T) {
	s := NewServer("agentsbb", "test",
		echoTool(),
		&Tool{Name: "second", InputSchema: map[string]any{"type": "object"}, Handler: func(context.Context, map[string]any) (CallResult, error) {
			return CallResult{}, nil
		}},
	)
	_, resp := mustCall(t, s, "u1", "", "tools/list", nil)
	result := resp["result"].(map[string]any)
	tools := result["tools"].([]any)
	if len(tools) != 2 {
		t.Fatalf("want 2 tools, got %d", len(tools))
	}
	first := tools[0].(map[string]any)
	if first["name"] != "echo" || first["inputSchema"] == nil {
		t.Fatalf("unexpected first tool: %v", first)
	}
}

func TestToolsCallSuccess(t *testing.T) {
	s := newTestServer()
	_, resp := mustCall(t, s, "u1", "", "tools/call", map[string]any{
		"name":      "echo",
		"arguments": map[string]any{"text": "hello"},
	})
	result := resp["result"].(map[string]any)
	if result["isError"] == true {
		t.Fatalf("unexpected error result: %v", result)
	}
	content := result["content"].([]any)
	if content[0].(map[string]any)["text"] != "hello" {
		t.Fatalf("content = %v", content)
	}
}

func TestToolsCallBusinessErrorBecomesIsError(t *testing.T) {
	s := newTestServer()
	_, resp := mustCall(t, s, "u-someone", "", "tools/call", map[string]any{
		"name":      "echo",
		"arguments": map[string]any{"fail": true},
	})
	result := resp["result"].(map[string]any)
	if result["isError"] != true {
		t.Fatalf("expected isError, got %v", result)
	}
	text := result["content"].([]any)[0].(map[string]any)["text"].(string)
	var payload map[string]string
	if err := json.Unmarshal([]byte(text), &payload); err != nil {
		t.Fatalf("error payload is not JSON: %s", text)
	}
	if payload["code"] != "boom" {
		t.Fatalf("code = %q", payload["code"])
	}
	if payload["message"] != "user u-someone asked to fail" {
		t.Fatalf("identity not propagated from ctx: %q", payload["message"])
	}
}

func TestUnknownToolIsProtocolError(t *testing.T) {
	s := newTestServer()
	_, resp := mustCall(t, s, "u1", "", "tools/call", map[string]any{"name": "nope"})
	rpcErr, ok := resp["error"].(map[string]any)
	if !ok {
		t.Fatalf("expected JSON-RPC error, got %v", resp)
	}
	if int(rpcErr["code"].(float64)) != CodeInvalidParams {
		t.Fatalf("code = %v", rpcErr["code"])
	}
}

func TestUnknownMethodIsMethodNotFound(t *testing.T) {
	s := newTestServer()
	_, resp := mustCall(t, s, "u1", "", "resources/list", nil)
	rpcErr, ok := resp["error"].(map[string]any)
	if !ok || int(rpcErr["code"].(float64)) != CodeMethodNotFound {
		t.Fatalf("expected -32601, got %v", resp)
	}
}

func TestNotificationHasNoBody(t *testing.T) {
	s := newTestServer()
	out := s.Handle(context.Background(), "u1", "", []byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	if out.Status != http.StatusAccepted || !out.NoContent || len(out.Body) != 0 {
		t.Fatalf("notification: status=%d noContent=%v body=%s", out.Status, out.NoContent, out.Body)
	}
}

func TestBatchIsRejected(t *testing.T) {
	s := newTestServer()
	out := s.Handle(context.Background(), "u1", "", []byte(`[{"jsonrpc":"2.0","id":1,"method":"ping"}]`))
	var resp map[string]any
	if err := json.Unmarshal(out.Body, &resp); err != nil {
		t.Fatalf("not JSON: %s", out.Body)
	}
	if _, ok := resp["error"]; !ok {
		t.Fatalf("expected error for batch, got %v", resp)
	}
}

func TestParseErrorOnGarbage(t *testing.T) {
	s := newTestServer()
	out := s.Handle(context.Background(), "u1", "", []byte(`{oops`))
	var resp map[string]any
	_ = json.Unmarshal(out.Body, &resp)
	rpcErr := resp["error"].(map[string]any)
	if int(rpcErr["code"].(float64)) != CodeParseError {
		t.Fatalf("code = %v", rpcErr["code"])
	}
}

func TestSessionLifecycle(t *testing.T) {
	s := newTestServer()
	init, _ := mustCall(t, s, "u1", "", "initialize", nil)
	sid := init.SessionID

	// 同一用户带会话：正常。
	out, _ := mustCall(t, s, "u1", sid, "tools/list", nil)
	if out.Status != http.StatusOK {
		t.Fatalf("same-user session: %d", out.Status)
	}

	// 换用户带同一会话：403。
	out, _ = mustCall(t, s, "u2", sid, "tools/list", nil)
	if out.Status != http.StatusForbidden {
		t.Fatalf("foreign session should be 403, got %d", out.Status)
	}

	// 未知会话：404。
	out, _ = mustCall(t, s, "u1", "does-not-exist", "tools/list", nil)
	if out.Status != http.StatusNotFound {
		t.Fatalf("unknown session should be 404, got %d", out.Status)
	}

	// 显式终止后：404。
	s.Terminate(sid)
	out, _ = mustCall(t, s, "u1", sid, "tools/list", nil)
	if out.Status != http.StatusNotFound {
		t.Fatalf("terminated session should be 404, got %d", out.Status)
	}
}

func TestSessionExpires(t *testing.T) {
	s := newTestServer()
	clock := &timeFixture{}
	s.now = clock.now
	init, _ := mustCall(t, s, "u1", "", "initialize", nil)
	clock.advance(DefaultSessionTTL + time.Minute)
	out, _ := mustCall(t, s, "u1", init.SessionID, "tools/list", nil)
	if out.Status != http.StatusNotFound {
		t.Fatalf("expired session should be 404, got %d", out.Status)
	}
}

func TestStatelessCallWithoutSessionHeader(t *testing.T) {
	s := newTestServer()
	out, _ := mustCall(t, s, "u1", "", "tools/list", nil)
	if out.Status != http.StatusOK {
		t.Fatalf("stateless tools/list should pass, got %d", out.Status)
	}
}
