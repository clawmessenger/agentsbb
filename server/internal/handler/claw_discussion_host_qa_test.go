package handler

// QA 独立验证：REST 快照出口的 hostNodeId 传递。
//
// 扁平 REST（`GET /api/discussions/{id}`、`GET /api/chatrooms/{id}/discussions`）是
// 重进讨论组恢复状态的唯一入口之一，它的快照同样会被 C 端整块合并 —— 少这个键
// 就等于把客户端手上的 host 抹掉一次。这里覆盖两点：
//   - 未装配访问检查器时降级空串（快照仍要能读，不能因为查不到 host 就 500）；
//   - 装配了但房间查不到时同样降级空串。

import (
	"net/http/httptest"
	"testing"
)

func TestClawChatroomHostNodeIDDegradesWithoutAccess(t *testing.T) {
	h := &Handler{}
	req := httptest.NewRequest("GET", "/api/discussions/d-1", nil)

	if got := h.clawChatroomHostNodeID(req, "rc-anything"); got != "" {
		t.Fatalf("nil access checker: %q (want empty string, never a failure)", got)
	}
	// 空 chatroomID 也必须是空串，不能 panic
	if got := h.clawChatroomHostNodeID(req, ""); got != "" {
		t.Fatalf("empty chatroomId: %q (want empty)", got)
	}
}
