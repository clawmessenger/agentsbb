package rongcloud

// 群聊「暂停 OpenClaw」的优雅停止回归用例（2026-11-06 拍板）。
//
// 语义：点击暂停不是把下一位直接掐掉，而是
//   ① 正在发言的那一位把话说完（回包照常广播进群）；
//   ② 还没开口的成员一律不再派发；
//   ③ 暂停期间排队的用户消息直接丢弃，恢复后只对**之后**的新消息生效。
//
// 为什么必须单独钉住：旧实现只把 openclaw_stopped 写进库，群聊的按序中继
// （StartGroupRelay / pump）完全没读这一列 —— 于是「点了暂停，AI 还在一条条
// 回」，和小程序/App 上已经亮起的「已暂停」状态完全相反。

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// TestGroupOpenclawSettings_ReadsStopFlag 钉住「暂停真值只有一处」：
// 轮数与暂停位都来自 GroupProfiles（rongcloud_group 的两列）。
func TestGroupOpenclawSettings_ReadsStopFlag(t *testing.T) {
	hub := &chatroomRelayHub{
		rt: nilRelayRuntime(),
		groupMirror: &GroupMirror{
			GroupProfiles: func(_ context.Context, _ []string) ([]GroupProfile, error) {
				return []GroupProfile{{GroupID: "g1", MaxRounds: 4, Stopped: true}}, nil
			},
		},
	}
	rounds, stopped := hub.groupOpenclawSettings(context.Background(), "g1")
	if rounds != 4 {
		t.Fatalf("rounds = %d, want 4", rounds)
	}
	if !stopped {
		t.Fatal("stopped must be true when the mirror row says openclaw_stopped")
	}
	if !hub.groupPaused(context.Background(), "g1") {
		t.Fatal("groupPaused must follow the mirror flag")
	}

	// 查询失败按「未暂停 + 默认轮数」处理：DB 抖一下不能让全群永久哑掉。
	hub.groupMirror = &GroupMirror{
		GroupProfiles: func(_ context.Context, _ []string) ([]GroupProfile, error) {
			return nil, context.DeadlineExceeded
		},
	}
	rounds, stopped = hub.groupOpenclawSettings(context.Background(), "g1")
	if rounds != defaultGroupRelayRounds || stopped {
		t.Fatalf("lookup failure must fail open: rounds=%d stopped=%v", rounds, stopped)
	}
}

// TestGroupRelay_PauseFinishesCurrentSpeakerThenStops 是整个语义的核心：
// A 正在发言时群主点暂停 —— A 的回包必须照常广播，B 不能再被派发。
func TestGroupRelay_PauseFinishesCurrentSpeakerThenStops(t *testing.T) {
	rec, client := newRelayRecorder(t)
	rt := newDiscussionRuntime(nil, nil, client, "sys-node", testLogger())

	var paused atomic.Bool
	const groupID = "g-pause-finish"
	hub := &chatroomRelayHub{
		sessions: map[string]*relaySession{},
		rounds:   map[string][]relayRound{},
		rt:       rt,
		groupMirror: &GroupMirror{
			GroupProfiles: func(_ context.Context, ids []string) ([]GroupProfile, error) {
				return []GroupProfile{{GroupID: groupID, MaxRounds: 3, Stopped: paused.Load()}}, nil
			},
		},
	}
	members := []relayMember{
		{rcID: "rc_a", roleName: "A", order: 0},
		{rcID: "rc_b", roleName: "B", order: 1},
	}
	ctx := context.Background()
	if started, queued := hub.StartGroupOrQueue(ctx, groupID, members, "大家聊聊", "rc_user", 3, false); !started || queued {
		t.Fatalf("relay should start: started=%v queued=%v", started, queued)
	}
	waitUntil(t, "A dispatched", func() bool {
		s := relaySessionState(hub, groupID)
		return s != nil && s.senderRCID == "rc_a" && s.requestID != ""
	})
	reqA := relaySessionState(hub, groupID).requestID

	// 群主点暂停：此刻 A 已经在跑。
	paused.Store(true)

	// A 说完 —— 回包必须被接受并广播，不能因为「已暂停」把它吞掉。
	if !hub.AcceptResponse(ctx, "rc_a", reqA, "A 的完整发言", false, "") {
		t.Fatal("the in-flight speaker's reply must still be accepted after pause")
	}
	waitUntil(t, "session ends after the current speaker", func() bool {
		return relaySessionState(hub, groupID) == nil
	})

	privates, group := rec.snapshot()
	if len(privates) != 1 {
		t.Fatalf("only A should have been dispatched, got %d dispatches", len(privates))
	}
	texts := broadcastTexts(t, group)
	found := false
	for _, text := range texts {
		if text == "A 的完整发言" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the in-flight speaker's words must still reach the group: %v", texts)
	}
}

// TestGroupRelay_PauseBeforeSpeakerStartsEndsEarly 钉住「刚派发、还没产出」的那位
// 不会拖满 60s 超时：用户点了暂停，没开口的人应当立刻算作「不发言」。
//
// 判据是 2s 的查库节流 + 500ms 轮询，所以这里给 5s 观察窗（远小于一轮 60s）。
func TestGroupRelay_PauseBeforeSpeakerStartsEndsEarly(t *testing.T) {
	_, client := newRelayRecorder(t)
	rt := newDiscussionRuntime(nil, nil, client, "sys-node", testLogger())

	var paused atomic.Bool
	const groupID = "g-pause-idle"
	hub := &chatroomRelayHub{
		sessions: map[string]*relaySession{},
		rounds:   map[string][]relayRound{},
		rt:       rt,
		groupMirror: &GroupMirror{
			GroupProfiles: func(_ context.Context, ids []string) ([]GroupProfile, error) {
				return []GroupProfile{{GroupID: groupID, MaxRounds: 3, Stopped: paused.Load()}}, nil
			},
		},
	}
	members := []relayMember{
		{rcID: "rc_a", roleName: "A", order: 0},
		{rcID: "rc_b", roleName: "B", order: 1},
	}
	ctx := context.Background()
	if started, _ := hub.StartGroupOrQueue(ctx, groupID, members, "开个头", "rc_user", 3, false); !started {
		t.Fatal("relay should start")
	}
	waitUntil(t, "A dispatched", func() bool {
		s := relaySessionState(hub, groupID)
		return s != nil && s.senderRCID == "rc_a" && s.requestID != ""
	})

	// A 还没发任何流帧（renews=0）时群主暂停：不应等满整轮超时。
	paused.Store(true)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if relaySessionState(hub, groupID) == nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("a dispatched-but-silent member must be dropped shortly after pause, not after the full turn timeout")
}

// TestGroupRelay_PauseDropsQueuedMessage 钉住「恢复不补跑」：暂停期间排队的
// 用户消息不能在收尾时接着起一段新的中继 —— 否则一点恢复，AI 又把暂停期间
// 攒下的话全回一遍。
func TestGroupRelay_PauseDropsQueuedMessage(t *testing.T) {
	rec, client := newRelayRecorder(t)
	rt := newDiscussionRuntime(nil, nil, client, "sys-node", testLogger())

	var paused atomic.Bool
	const groupID = "g-pause-queue"
	hub := &chatroomRelayHub{
		sessions: map[string]*relaySession{},
		rounds:   map[string][]relayRound{},
		rt:       rt,
		groupMirror: &GroupMirror{
			GroupProfiles: func(_ context.Context, ids []string) ([]GroupProfile, error) {
				return []GroupProfile{{GroupID: groupID, MaxRounds: 1, Stopped: paused.Load()}}, nil
			},
		},
	}
	members := []relayMember{
		{rcID: "rc_a", roleName: "A", order: 0},
		{rcID: "rc_b", roleName: "B", order: 1},
	}
	ctx := context.Background()
	if started, _ := hub.StartGroupOrQueue(ctx, groupID, members, "第一条", "rc_user", 1, false); !started {
		t.Fatal("relay should start")
	}
	waitUntil(t, "A dispatched", func() bool {
		s := relaySessionState(hub, groupID)
		return s != nil && s.senderRCID == "rc_a" && s.requestID != ""
	})
	// 忙时又发一条：进 pending。
	if started, queued := hub.StartGroupOrQueue(ctx, groupID, members, "第二条", "rc_user", 1, false); started || !queued {
		t.Fatalf("second message should queue: started=%v queued=%v", started, queued)
	}
	reqA := relaySessionState(hub, groupID).requestID
	paused.Store(true)
	if !hub.AcceptResponse(ctx, "rc_a", reqA, "A 说完就停", false, "") {
		t.Fatal("reply accepted")
	}
	waitUntil(t, "session ends", func() bool {
		return relaySessionState(hub, groupID) == nil
	})

	// 收尾后不能再有任何新派发（排队那条已被丢弃）。给 pump 一点时间收尾，
	// 仍然只应有 A 那一次派发。
	privates, _ := rec.snapshot()
	if len(privates) != 1 {
		t.Fatalf("queued message must be dropped on pause, got %d dispatches", len(privates))
	}
	if s := relaySessionState(hub, groupID); s != nil {
		t.Fatalf("no new relay session should have been started: %+v", s)
	}
}
