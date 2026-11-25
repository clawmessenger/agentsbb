package handler

// /mcp 端点的端到端用例：鉴权 → initialize → tools/list → tools/call。
//
// 只覆盖与用户体系打通的几件事（真实数据库）：
//   - 无 token / 错 token → 401 + WWW-Authenticate；
//   - 有效 token → initialize 下发 Mcp-Session-Id；
//   - 带会话调 tools/list 拿到 6 个查询工具；
//   - list_chatrooms 对无群用户返回空数组（不是报错）；
//   - 非成员 chatroom 的 list_discussions 回 isError + not_chatroom_member。

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/integrations/rongcloud"
)

func mcpTestHandler(t *testing.T) *Handler {
	t.Helper()
	if testHandler == nil || testHandler.Queries == nil {
		t.Skip("handler test fixture not initialised (database unavailable)")
	}
	h := *testHandler
	h.RongCloudDiscussionAccess = rongcloud.NewDiscussionRoomAccess(testHandler.Queries)
	h.RongCloudDiscussionRepo = rongcloud.NewDiscussionRepository(testHandler.Queries, nil)
	h.InitClawMCP()
	return &h
}

func mcpPost(t *testing.T, h *Handler, token, sessionID string, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if sessionID != "" {
		req.Header.Set("Mcp-Session-Id", sessionID)
	}
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ClawMCPPost(rec, req)
	return rec
}

func TestClawMCPRejectsMissingToken(t *testing.T) {
	h := mcpTestHandler(t)
	rec := mcpPost(t, h, "", "", `{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if !strings.Contains(rec.Header().Get("WWW-Authenticate"), "Bearer") {
		t.Fatalf("missing WWW-Authenticate: %q", rec.Header().Get("WWW-Authenticate"))
	}
}

func TestClawMCPRejectsUnknownToken(t *testing.T) {
	h := mcpTestHandler(t)
	rec := mcpPost(t, h, "definitely-not-a-token", "", `{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestClawMCPEndToEndQueryFlow(t *testing.T) {
	h := mcpTestHandler(t)

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	userID := "mcp-user-" + suffix
	token := "mcp-token-" + suffix
	seedClawUserRow(t, userID, token)
	t.Cleanup(func() {
		dbfx.Exec(t, `DELETE FROM claw_im_users WHERE user_id = $1`, userID)
	})

	// 1. initialize
	rec := mcpPost(t, h, token, "", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","clientInfo":{"name":"test","version":"1"}}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("initialize status = %d body=%s", rec.Code, rec.Body.String())
	}
	sessionID := rec.Header().Get("Mcp-Session-Id")
	if sessionID == "" {
		t.Fatal("initialize did not issue Mcp-Session-Id")
	}
	var initResp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &initResp); err != nil {
		t.Fatalf("initialize body not JSON: %s", rec.Body.String())
	}
	serverInfo := initResp["result"].(map[string]any)["serverInfo"].(map[string]any)
	if serverInfo["name"] != "agentsbb" {
		t.Fatalf("serverInfo.name = %v", serverInfo["name"])
	}

	// 2. tools/list
	rec = mcpPost(t, h, token, sessionID, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("tools/list status = %d body=%s", rec.Code, rec.Body.String())
	}
	var listResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &listResp)
	tools := listResp["result"].(map[string]any)["tools"].([]any)
	// 6 个查询 + 4 个控制类（P2）。控制类在没有融云装配的环境下仍会出现在
	// tools/list 里 —— 能力位是运行时判断（control_unavailable），不是列表裁剪，
	// 否则调用方在装配完成前后看到的工具集合会漂移。
	if len(tools) != 10 {
		t.Fatalf("tool count = %d, want 10", len(tools))
	}

	// 3. list_chatrooms：该用户没有任何群 → 空数组
	rec = mcpPost(t, h, token, sessionID, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_chatrooms","arguments":{}}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("list_chatrooms status = %d body=%s", rec.Code, rec.Body.String())
	}
	payload := mcpToolPayload(t, rec.Body.Bytes())
	if payload["truncated"] != false {
		t.Fatalf("unexpected payload: %v", payload)
	}
	if rooms, ok := payload["chatrooms"].([]any); !ok || len(rooms) != 0 {
		t.Fatalf("chatrooms = %v, want empty array", payload["chatrooms"])
	}

	// 4. 非成员 chatroom → 工具级 isError + not_chatroom_member
	rec = mcpPost(t, h, token, sessionID, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_discussions","arguments":{"chatroomId":"no-such-room"}}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("list_discussions status = %d body=%s", rec.Code, rec.Body.String())
	}
	var callResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &callResp)
	result := callResp["result"].(map[string]any)
	if result["isError"] != true {
		t.Fatalf("expected isError for non-member room, got %v", result)
	}
	errPayload := mcpToolErrorPayload(t, result)
	if errPayload["code"] != "not_chatroom_member" {
		t.Fatalf("code = %q, want not_chatroom_member", errPayload["code"])
	}
}

func mcpToolPayload(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var resp map[string]any
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("response not JSON: %s", body)
	}
	result, ok := resp["result"].(map[string]any)
	if !ok {
		t.Fatalf("missing result: %s", body)
	}
	if result["isError"] == true {
		t.Fatalf("unexpected tool error: %s", body)
	}
	content := result["content"].([]any)
	text := content[0].(map[string]any)["text"].(string)
	var payload map[string]any
	if err := json.Unmarshal([]byte(text), &payload); err != nil {
		t.Fatalf("tool text is not JSON: %s", text)
	}
	return payload
}

func mcpToolErrorPayload(t *testing.T, result map[string]any) map[string]any {
	t.Helper()
	content, ok := result["content"].([]any)
	if !ok || len(content) == 0 {
		t.Fatalf("missing content in error result: %v", result)
	}
	text := content[0].(map[string]any)["text"].(string)
	var payload map[string]any
	if err := json.Unmarshal([]byte(text), &payload); err != nil {
		t.Fatalf("error text is not JSON: %s", text)
	}
	return payload
}
