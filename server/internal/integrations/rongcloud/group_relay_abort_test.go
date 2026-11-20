package rongcloud

import "testing"

// QA5-DEF-06 尾巴：撤回触发消息要能精确中止接龙，且不误停别的消息。
func TestAbortGroupRelayMatchesTrigger(t *testing.T) {
	h := &chatroomRelayHub{
		sessions: map[string]*relaySession{},
		rounds:   map[string][]relayRound{},
	}
	h.sessions["g-1"] = &relaySession{
		isGroup:           true,
		triggerMessageUID: "MSG-1",
		pending:           &relayPending{userText: "排队中的下一条"},
	}

	// 撤回别的消息：不匹配、什么都不动。
	if aborted, matched := h.AbortGroupRelay("g-1", "MSG-OTHER"); aborted || matched {
		t.Fatalf("non-matching message must not abort: aborted=%v matched=%v", aborted, matched)
	}
	if h.sessions["g-1"].stopped {
		t.Fatal("session must not be stopped by a non-matching recall")
	}
	if h.sessions["g-1"].pending == nil {
		t.Fatal("pending must survive a non-matching recall")
	}

	// 撤回触发消息：置中止标记，并丢弃排队消息（撤回即「这段不算数」）。
	aborted, matched := h.AbortGroupRelay("g-1", "MSG-1")
	if !aborted || !matched {
		t.Fatalf("matching recall must abort: aborted=%v matched=%v", aborted, matched)
	}
	if !h.sessions["g-1"].stopped {
		t.Fatal("session must be stopped")
	}
	if h.sessions["g-1"].pending != nil {
		t.Fatal("pending must be dropped when trigger message is recalled")
	}

	// 二次调用幂等：已停止的会话不再重复「中止」。
	if aborted, matched := h.AbortGroupRelay("g-1", "MSG-1"); aborted || !matched {
		t.Fatalf("repeat abort must be idempotent: aborted=%v matched=%v", aborted, matched)
	}
}

func TestAbortGroupRelayIgnoresChatroomSession(t *testing.T) {
	h := &chatroomRelayHub{
		sessions: map[string]*relaySession{},
		rounds:   map[string][]relayRound{},
	}
	h.sessions["room-1"] = &relaySession{triggerMessageUID: "MSG-1"} // isGroup=false

	if aborted, matched := h.AbortGroupRelay("room-1", "MSG-1"); aborted || matched {
		t.Fatalf("chatroom relay must not be aborted by group recall: aborted=%v matched=%v", aborted, matched)
	}
}

func TestAbortGroupRelayMissingSession(t *testing.T) {
	h := &chatroomRelayHub{
		sessions: map[string]*relaySession{},
		rounds:   map[string][]relayRound{},
	}
	if aborted, matched := h.AbortGroupRelay("g-none", "MSG-1"); aborted || matched {
		t.Fatalf("missing session must not abort: aborted=%v matched=%v", aborted, matched)
	}
	if aborted, matched := h.AbortGroupRelay("", "MSG-1"); aborted || matched {
		t.Fatal("empty group id must not abort")
	}
	if aborted, matched := h.AbortGroupRelay("g-1", ""); aborted || matched {
		t.Fatal("empty message id must not abort")
	}
}

func TestTagGroupRelayTrigger(t *testing.T) {
	h := &chatroomRelayHub{
		sessions: map[string]*relaySession{},
		rounds:   map[string][]relayRound{},
	}
	h.sessions["g-1"] = &relaySession{isGroup: true}

	h.tagGroupRelayTrigger("g-1", "MSG-9")
	if h.sessions["g-1"].triggerMessageUID != "MSG-9" {
		t.Fatalf("trigger not tagged: %q", h.sessions["g-1"].triggerMessageUID)
	}

	// 空 id / 不存在的会话：静默忽略，不 panic、不建会话。
	h.tagGroupRelayTrigger("g-1", "  ")
	if h.sessions["g-1"].triggerMessageUID != "MSG-9" {
		t.Fatal("blank message id must not overwrite the tag")
	}
	h.tagGroupRelayTrigger("g-none", "MSG-9")
	if _, ok := h.sessions["g-none"]; ok {
		t.Fatal("tagging must not create a session")
	}
}
