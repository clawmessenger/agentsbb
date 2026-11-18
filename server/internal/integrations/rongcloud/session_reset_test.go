package rongcloud

import (
	"context"
	"encoding/json"
	"testing"
)

// 与设备端 session-command.ts 的规则逐条对齐：两边认的必须完全一样，
// 否则用户会遇到「私聊里好使、群里没反应」。
func TestIsNewSessionCommandText(t *testing.T) {
	cases := []struct {
		text string
		want bool
	}{
		{"新开会话", true},
		{"  新开会话  ", true},
		{"新开一个会话", true},
		{"重开会话", true},
		{"重新开一个对话", true},
		{"另开聊天", true},
		{"开启新会话", true},
		{"/new", true},
		{"/reset", true},
		{"/新开会话", true},
		// 正文，不是命令：吞掉就等于把用户原话丢了，还平白清上下文。
		{"新开一个项目", false},
		{"请在群里新开会话", false},
		{"新开会话吧", false},
		{"查版本号", false},
		{"", false},
		{"   ", false},
		{"新开会话新开会话新开会话", false},
	}
	for _, tc := range cases {
		if got := isNewSessionCommandText(tc.text); got != tc.want {
			t.Errorf("isNewSessionCommandText(%q) = %v, want %v", tc.text, got, tc.want)
		}
	}
}

// 重置必须「三件事一起做到」：丢历史、掐住进行中的中继、通知每个成员节点。
// 少任何一件，用户都会觉得「说了新开会话，它还是记得刚才那摊事」。
func TestResetRoomSessionsClearsHistoryAndNotifiesMembers(t *testing.T) {
	rec, client := newRelayRecorder(t)
	rt := &discussionRuntime{client: client, logger: testLogger(), systemNodeID: "rc_sys"}
	hub := &chatroomRelayHub{
		sessions: map[string]*relaySession{},
		rounds:   map[string][]relayRound{},
		rt:       rt,
	}
	const room = "group-42"
	hub.rounds[room] = []relayRound{{userText: "查版本号", replies: []relayReply{{roleName: "kimi", content: "冲咖啡"}}}}
	hub.sessions[room] = &relaySession{
		chatroomRCID: room,
		isGroup:      true,
		pending:      &relayPending{userText: "排队的那条"},
	}

	res := hub.resetRoomSessions(context.Background(), room, "group", []relayMember{
		{rcID: "kimi_1", roleName: "kimi"},
		{rcID: "grok_1", roleName: "grok"},
	})
	if res.code != 200 {
		t.Fatalf("code = %d, want 200", res.code)
	}
	if data, _ := res.data.(map[string]interface{}); data["agents"] != 2 {
		t.Fatalf("agents = %v, want 2", data["agents"])
	}
	if _, ok := hub.rounds[room]; ok {
		t.Errorf("rounds for %q must be dropped, still present", room)
	}
	s := hub.sessions[room]
	if !s.stopped {
		t.Errorf("in-flight relay must be stopped so it stops carrying old context")
	}
	if s.pending != nil {
		t.Errorf("queued message must be dropped, got %+v", s.pending)
	}

	privates, _ := rec.snapshot()
	if len(privates) != 2 {
		t.Fatalf("private dispatches = %d, want 2", len(privates))
	}
	got := map[string]bool{}
	for _, entry := range privates {
		var decoded struct {
			Action string `json:"action"`
			Params struct {
				ConversationID string `json:"conversation_id"`
				Venue          string `json:"venue"`
			} `json:"params"`
		}
		if err := json.Unmarshal([]byte(entry["content"]), &decoded); err != nil {
			t.Fatalf("dispatch content is not JSON: %v (%s)", err, entry["content"])
		}
		if decoded.Action != "reset_session" {
			t.Errorf("action = %q, want reset_session", decoded.Action)
		}
		if decoded.Params.ConversationID != room {
			t.Errorf("conversation_id = %q, want %q", decoded.Params.ConversationID, room)
		}
		if decoded.Params.Venue != "group" {
			t.Errorf("venue = %q, want group", decoded.Params.Venue)
		}
		got[entry["toUserId"]] = true
	}
	for _, want := range []string{"kimi_1", "grok_1"} {
		if !got[want] {
			t.Errorf("member %q was not notified", want)
		}
	}
}

// 没有历史、没有在跑的中继时重置也必须成功（幂等）：用户手滑连发两遍不能报错。
func TestResetRoomSessionsIsIdempotent(t *testing.T) {
	rec, client := newRelayRecorder(t)
	hub := &chatroomRelayHub{
		sessions: map[string]*relaySession{},
		rounds:   map[string][]relayRound{},
		rt:       &discussionRuntime{client: client, logger: testLogger(), systemNodeID: "rc_sys"},
	}
	for i := 0; i < 2; i++ {
		if res := hub.resetRoomSessions(context.Background(), "chat-1", "chatroom", []relayMember{{rcID: "kimi_1"}}); res.code != 200 {
			t.Fatalf("run %d: code = %d, want 200", i, res.code)
		}
	}
	privates, _ := rec.snapshot()
	if len(privates) != 2 {
		t.Fatalf("private dispatches = %d, want 2 (one per call)", len(privates))
	}
}
