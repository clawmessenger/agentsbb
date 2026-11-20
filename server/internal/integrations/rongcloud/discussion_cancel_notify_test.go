package rongcloud

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// QA4-DEF-07 a 的下发通道回归：v3 的 interactiveCancel 现在与 legacy
// actionStop/actionCancel 一样会调 notifyCancelSafe。这个用例不依赖 DB
// （repo 故意留 nil，走角色板 host 分支，同时钉住新增的 nil 守卫），用假
// 融云验证「停止讨论」确实把 discussion_cancel 私发给正在跑的节点。
func TestNotifyCancelSafeDispatchesCancelCommand(t *testing.T) {
	rec, client := newRelayRecorder(t)
	rt := &discussionRuntime{
		client:       client,
		systemNodeID: "rc_sys",
		logger:       testLogger(),
		// repo=nil：只从 RoleSnapshot 取 host，不需要查事件表。
	}
	d := DiscussionRecord{
		DiscussionID: "disc-cancel-1",
		ChatroomID:   "room-1",
		CurrentRound: 2,
		Version:      7,
		RoleSnapshot: json.RawMessage(`{"host":{"isHost":true,"memberId":"rc_host"},"member":{"isHost":false,"memberId":"rc_member"}}`),
	}
	rt.notifyCancelSafe(context.Background(), d)

	privates, _ := rec.snapshot()
	if len(privates) != 1 {
		t.Fatalf("cancel should be sent to the host only, got %d privates: %v", len(privates), privates)
	}
	content := privates[0]["content"]
	for _, want := range []string{`"msg_type":"discussion_cancel"`, `"discussionId":"disc-cancel-1"`, `"reason":"cancelled"`} {
		if !strings.Contains(content, want) {
			t.Fatalf("cancel payload %q missing %s", content, want)
		}
	}
}

// client=nil 是现成 discussionFixture 的常见形态：notifyCancelSafe 必须
// 直接 no-op，不能触碰 repo / queries、更不能 panic（否则补调用会让所有
// 现有 v3 取消用例挂掉）。
func TestNotifyCancelSafeNoopWithoutClient(t *testing.T) {
	rt := &discussionRuntime{logger: testLogger()}
	rt.notifyCancelSafe(context.Background(), DiscussionRecord{
		RoleSnapshot: json.RawMessage(`{}`),
	})
}
