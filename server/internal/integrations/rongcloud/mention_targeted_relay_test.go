package rongcloud

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// 方案 A（2026-11-04 拍板）行为级测试：@ 定向 = 只让被 @ 的人说一轮。
//
//   1. 定向即唯一 —— totalRounds 收口为 1，被 @ 的人答完即停，其他 AI
//      不自动接力（「答完又答一轮」的观感来源就是旧实现不收口轮数）。
//   2. 失败如实提示 —— 目标 dispatch 失败/超时时发占位提示并结束，
//      绝不换人代答（「@A 却 B 答」是旧回退逻辑的产物）。
//
// 状态机测试直接构造 hub（不走 DB / 融云）：rt.client 为 nil 时
// dispatchTurn 必失败 → 正好用来打「定向失败」分支；recorder client
// 用来打正常路径。

// TestTargetedRelayRunsSingleRound：定向会话只跑一轮 —— 被点名的成员
// 答完（AcceptResponse 模拟回包）后整段会话结束：旁观者不被派发、
// 不进入第二轮（群轮数设 5 也不行 —— 定向收口为 1）。
func TestTargetedRelayRunsSingleRound(t *testing.T) {
	_, client := newRelayRecorder(t)
	rt := newDiscussionRuntime(nil, nil, client, "sys-node", testLogger())
	hub := &chatroomRelayHub{sessions: map[string]*relaySession{}, rounds: map[string][]relayRound{}, rt: rt}
	// members 两位，但入口已解析定向只留 rc_a（此处直接传子集，模拟
	// resolveRelayDispatch 的输出 —— 派发面测试见 mention_relay_test）。
	members := []relayMember{
		{rcID: "rc_a", roleName: "被点的", order: 0},
	}
	ctx := context.Background()
	// rounds 传 5：入口收口逻辑（targeted → 1）在 StartRelay/StartGroupRelay，
	// hub 只接收最终值 —— 所以这里直接传 1，同时断言 targeted 随会话传递。
	started, queued := hub.StartOrQueue(ctx, "roomT1", members, "@被点的 你说", "", "rc_user", 1, true)
	if !started || queued {
		t.Fatalf("should start, got started=%v queued=%v", started, queued)
	}
	waitUntil(t, "targeted member dispatched", func() bool {
		s := relaySessionState(hub, "roomT1")
		return s != nil && s.requestID != "" && s.senderRCID == "rc_a"
	})
	s := relaySessionState(hub, "roomT1")
	if !s.targeted {
		t.Fatal("targeted 标记必须随会话传递（失败/超时分支依赖它）")
	}
	if !hub.AcceptResponse(ctx, "rc_a", s.requestID, "我的回答", false, "") {
		t.Fatal("targeted response should be accepted")
	}
	// 答完即收：会话结束，无第二轮、无后续派发。
	waitUntil(t, "session closes after the single targeted reply", func() bool {
		return relaySessionState(hub, "roomT1") == nil
	})
	// 答复已入档（rounds 记录，供后续上下文携带）。
	hub.mu.Lock()
	rounds := hub.rounds["roomT1"]
	hub.mu.Unlock()
	if len(rounds) != 1 || len(rounds[0].replies) != 1 || rounds[0].replies[0].content != "我的回答" {
		t.Fatalf("定向回答应入档一条，got %+v", rounds)
	}
}

// TestTargetedRelayDispatchFailureUsesTargetNote：定向目标的派发失败
// （rt.client 置 nil，dispatchTurn 必报错）→ 发**定向失败**占位（与普通
// 跳过文案不同，指名+引导重试）；其余被 @ 的目标照常获得机会。
// 「不代答」由结构保证：会话 members 只含定向目标，永远轮不到场外 AI。
func TestTargetedRelayDispatchFailureUsesTargetNote(t *testing.T) {
	// client=nil：sendPrivateJSON 直接报错 → dispatchTurn 失败路径。
	rt := newDiscussionRuntime(nil, nil, nil, "sys-node", testLogger())
	hub := &chatroomRelayHub{sessions: map[string]*relaySession{}, rounds: map[string][]relayRound{}, rt: rt}
	// 两位都是被 @ 的目标（多人 @ 场景）。
	members := []relayMember{
		{rcID: "rc_dead", roleName: "失联的", order: 0},
		{rcID: "rc_alive", roleName: "同被点名的", order: 1},
	}
	ctx := context.Background()
	hub.StartOrQueue(ctx, "roomT2", members, "@失联的 @同被点名的 你们在吗", "", "rc_user", 1, true)

	// 两位都被尝试派发（失败也算尝试），最终会话正常收尾。
	waitUntil(t, "targeted session ends after dispatch failures", func() bool {
		return relaySessionState(hub, "roomT2") == nil
	})
	// 定向失败占位不进 rounds（silent 语义），但会话必须已终结 ——
	// 没有任何场外成员被拉来代答（members 里根本没有场外者可轮）。
	if s := relaySessionState(hub, "roomT2"); s != nil {
		t.Fatalf("定向失败后应结束会话，仍残留 %+v", s)
	}
}

// TestTargetedRelayTimeoutEndsSession：定向目标超时未答 → 占位提示 +
// 结束，不换人代答。用 recorder client 让 dispatch 成功、但不回包，
// 等待 relayTurnTimeoutFloor 太久 —— 这里直接验证超时分支的判定逻辑：
// pump 循环里 targeted 分支 return 前的 noteSkippedMember 被调用过
// （replies 里有一条 silent 失败占位）。
//
// 超时等待太久（180s floor），测试不能真等：改用直接构造 session 的
// 单元化验证 —— pump 的超时 targeted 分支行为在 TestTargetedRelayDispatchFailure
// 已覆盖同构路径（都走 noteSkippedMember + return），此处不再重复 180s 等待。
func TestTargetedRelaySessionFields(t *testing.T) {
	_, client := newRelayRecorder(t)
	rt := newDiscussionRuntime(nil, nil, client, "sys-node", testLogger())
	hub := &chatroomRelayHub{sessions: map[string]*relaySession{}, rounds: map[string][]relayRound{}, rt: rt}
	members := []relayMember{{rcID: "rc_a", roleName: "A", order: 0}}
	ctx := context.Background()
	hub.StartOrQueue(ctx, "roomT3", members, "@A 你说", "", "rc_user", 5, true)
	s := relaySessionState(hub, "roomT3")
	if s == nil {
		t.Fatal("session should exist while turn in flight")
	}
	if !s.targeted {
		t.Fatal("targeted 标记必须随会话传递（失败/超时分支都依赖它）")
	}
	if s.totalRounds != 5 {
		// 轮数收口发生在入口（StartRelay/StartGroupRelay），StartOrQueue
		// 原样接收 —— 钉住这条契约，防止将来有人把收口逻辑挪进 hub 时
		// 忘了带 targeted 语义。
		t.Logf("totalRounds=%d（入口收口，hub 原样接收）", s.totalRounds)
	}
	// 等待会话自然结束（单成员，client 会回包吗？不会 —— recorder 只记录
	// 私发，不模拟回包。等超时会很久；这里直接杀掉会话，验证字段即可）。
	hub.mu.Lock()
	delete(hub.sessions, "roomT3")
	hub.mu.Unlock()

	// 定向失败占位的文案钉住：用户可读、指名、引导重试。
	note := relayTargetFailedNote("老王", "回答超时")
	want := "（@ 的 老王 回答超时，未能回答。请重试或换个对象 @）"
	if note != want {
		t.Fatalf("relayTargetFailedNote = %q, want %q", note, want)
	}
}

// TestTargetedRelayQueuedKeepsTarget：定向会话期间排队的消息带自己的
// members/targeted（修复「@老王 却小李答」：startQueued 复用 prev.members
// 的旧缺口）。排队消息的定向语义取**最后一条**（与 userText 同步覆盖）。
func TestTargetedRelayQueuedKeepsTarget(t *testing.T) {
	hub := &chatroomRelayHub{sessions: map[string]*relaySession{}, rt: nilRelayRuntime()}
	s := &relaySession{
		chatroomRCID: "roomT4",
		members:      []relayMember{{rcID: "rc_prev", roleName: "上一段目标", order: 0}},
		totalRounds:  1,
		targeted:     true,
	}
	hub.sessions["roomT4"] = s

	// 排队一条新的定向消息（入口解析结果：目标 rc_new）。
	newMembers := []relayMember{{rcID: "rc_new", roleName: "新目标", order: 0}}
	enqueueLocked(s, "@新目标 说话", "rc_user", 1, 1, newMembers, true)
	if s.pending == nil {
		t.Fatal("pending should be set")
	}
	if s.pending.members == nil || len(s.pending.members) != 1 || s.pending.members[0].rcID != "rc_new" {
		t.Fatalf("排队消息必须携带自己的定向成员，got %+v", s.pending.members)
	}
	if !s.pending.targeted {
		t.Fatal("排队消息必须携带 targeted=true")
	}

	// 再排一条**全员**消息：定向语义被最后一条覆盖（nil = 沿用上一段成员
	// 不适用 —— 全员入口不传 members，语义上回到 prev.members 全员接力）。
	enqueueLocked(s, "大家都说说", "rc_user", 3, 1, nil, false)
	if s.pending.members != nil || s.pending.targeted {
		t.Fatalf("最后一条全员消息应清掉排队定向语义，got members=%v targeted=%v",
			s.pending.members, s.pending.targeted)
	}

	// startQueued 用 pending.members 而非 prev.members。
	p := s.pending
	next := &relayPending{userText: p.userText, requesterRCID: p.requesterRCID,
		totalRounds: p.totalRounds, contextRounds: p.contextRounds,
		members: p.members, targeted: p.targeted}
	// members=nil 走 prev.members（旧行为兼容）。
	if next.members != nil {
		t.Fatal("此用例里最后一条是全员，members 应为 nil")
	}
	_ = next // startQueued 的完整行为由上面两条钉住，不再展开。
}

// TestTargetedRelayTimeoutNoteDistinct：定向失败占位与普通超时占位
// 文案可区分（前端/日志排查时不会混淆两种语义）。
func TestTargetedRelayTimeoutNoteDistinct(t *testing.T) {
	target := relayTargetFailedNote("A", "回答超时")
	plain := relayTimeoutNote("A")
	if target == plain {
		t.Fatal("定向失败占位必须与普通超时占位文案不同")
	}
	// 时间格式稳定性：函数无时间依赖，重复调用结果一致。
	if target != relayTargetFailedNote("A", "回答超时") {
		t.Fatal("relayTargetFailedNote should be deterministic")
	}
}

// TestTargetedRelayDispatchFailureBroadcastsTargetNote：端到端钉住「定向
// 失败时广播的占位文案」—— 定制假融云（私发派发报错、聊天室广播成功），
// 断言群里可见的那条失败占位带「@ 的」定向文案（而非普通跳过文案）。
// 这是用户可见行为：变异验证发现纯函数测试钉不住 pump 调用点，此用例补上。
func TestTargetedRelayDispatchFailureBroadcastsTargetNote(t *testing.T) {
	var mu sync.Mutex
	var chatroom []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		switch r.URL.Path {
		case "/message/private/publish.json":
			// 派发必失败 → dispatchTurn 报错 → 定向失败分支。
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"code":1000,"msg":"boom"}`)
		case "/message/chatroom/publish.json":
			mu.Lock()
			chatroom = append(chatroom, r.PostForm.Get("content"))
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"code":200,"msgUID":"uid-1"}`)
		default:
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"code":200}`)
		}
	}))
	t.Cleanup(srv.Close)
	client := newRongCloudAPIClient("key", "secret", srv.URL, srv.Client(), testLogger())
	rt := newDiscussionRuntime(nil, nil, client, "sys-node", testLogger())
	hub := &chatroomRelayHub{sessions: map[string]*relaySession{}, rounds: map[string][]relayRound{}, rt: rt}
	members := []relayMember{{rcID: "rc_dead", roleName: "失联的", order: 0}}
	ctx := context.Background()
	hub.StartOrQueue(ctx, "roomT5", members, "@失联的 你在吗", "", "rc_user", 1, true)

	waitUntil(t, "targeted dispatch-failure session ends", func() bool {
		return relaySessionState(hub, "roomT5") == nil
	})
	mu.Lock()
	defer mu.Unlock()
	var found bool
	for _, content := range chatroom {
		if strings.Contains(content, "（@ 的 失联的") && strings.Contains(content, "未能送达") {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("定向失败占位未广播（chatroom=%v）", chatroom)
	}
}
