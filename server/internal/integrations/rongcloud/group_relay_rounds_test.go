package rongcloud

import (
	"context"
	"testing"
)

// QA5-DEF-06 专项回归：群里只有 1 个智能体时，默认 3 轮接龙会让它自己接
// 自己（「下一位请继续」→「接上一位」→「第 3 轮到位」）。修复口径是
// 「按实际可发言成员数收敛轮数 + 跨轮排除刚发言者」，全部抽成纯函数做
// 表驱动测试，另配两条不依赖 DB 的行为级用例。

func oneSpeaker() []relayMember {
	return []relayMember{{rcID: "rc_only", roleName: "opencode", order: 0}}
}

func twoSpeakers() []relayMember {
	return []relayMember{
		{rcID: "rc_a", roleName: "A", order: 0},
		{rcID: "rc_b", roleName: "B", order: 1},
	}
}

// TestEffectiveGroupRelayRounds：≤1 个成员一律收口为 1 轮；2 个及以上
// 保持原归一化语义（0/负数回落默认 3、超上限截到 10、定向的 1 原样保留）。
func TestEffectiveGroupRelayRounds(t *testing.T) {
	cases := []struct {
		name     string
		rounds   int
		speakers int
		want     int
	}{
		{"单智能体默认3轮收敛为1", 3, 1, 1},
		{"单智能体配置5轮仍为1", 5, 1, 1},
		{"单智能体配置1轮仍为1", 1, 1, 1},
		{"0个成员也收口为1", 3, 0, 1},
		{"2成员保持默认3轮", 3, 2, 3},
		{"2成员0轮回落默认3轮", 0, 2, 3},
		{"2成员负数回落默认3轮", -3, 2, 3},
		{"2成员超上限截到10", 50, 2, maxGroupRelayRounds},
		{"2成员定向1轮原样保留", 1, 2, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := effectiveGroupRelayRounds(tc.rounds, tc.speakers); got != tc.want {
				t.Fatalf("effectiveGroupRelayRounds(%d, %d) = %d, want %d",
					tc.rounds, tc.speakers, got, tc.want)
			}
		})
	}
}

// TestGroupRelayNextRoundStart：跨轮起点跳过刚发言者自己（用 rcID 判定，
// 避免展示名重复误判）。2 成员正常交替时起点仍是 0，行为不变。
func TestGroupRelayNextRoundStart(t *testing.T) {
	three := []relayMember{
		{rcID: "rc_a", roleName: "A", order: 0},
		{rcID: "rc_b", roleName: "B", order: 1},
		{rcID: "rc_c", roleName: "C", order: 2},
	}
	cases := []struct {
		name    string
		members []relayMember
		last    string
		want    int
	}{
		{"无上一位从0开始", twoSpeakers(), "", 0},
		{"上一位是B→新一轮从A开始（交替）", twoSpeakers(), "rc_b", 0},
		{"上一位是A→跳过A从B开始（不自己接自己）", twoSpeakers(), "rc_a", 1},
		{"3成员上一位是A→从B开始", three, "rc_a", 1},
		{"3成员上一位是C→从A开始", three, "rc_c", 0},
		{"单成员无可轮换", oneSpeaker(), "rc_only", 0},
		{"空候选池", nil, "rc_a", 0},
		{"上一位不在候选池", twoSpeakers(), "rc_unknown", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := groupRelayNextRoundStart(tc.members, tc.last); got != tc.want {
				t.Fatalf("groupRelayNextRoundStart(%v, %q) = %d, want %d",
					relayRCIDs(tc.members), tc.last, got, tc.want)
			}
		})
	}
}

func relayRCIDs(members []relayMember) []string {
	out := make([]string, 0, len(members))
	for _, m := range members {
		out = append(out, m.rcID)
	}
	return out
}

// TestGroupRelayTwoSpeakersAlternateWithoutSelfRepeat：把 pump 的跨轮推进
// 用纯函数重放一遍，钉住「2 个智能体交替、相邻两轮不重复自己」。
func TestGroupRelayTwoSpeakersAlternateWithoutSelfRepeat(t *testing.T) {
	members := twoSpeakers()
	rounds := effectiveGroupRelayRounds(3, len(members))
	if rounds != 3 {
		t.Fatalf("2 成员应保持 3 轮, got %d", rounds)
	}
	var seq []string
	last := ""
	for r := 0; r < rounds; r++ {
		start := groupRelayNextRoundStart(members, last)
		for i := start; i < len(members); i++ {
			seq = append(seq, members[i].rcID)
			last = members[i].rcID
		}
	}
	want := []string{"rc_a", "rc_b", "rc_a", "rc_b", "rc_a", "rc_b"}
	if len(seq) != len(want) {
		t.Fatalf("sequence = %v, want %v", seq, want)
	}
	for i := range want {
		if seq[i] != want[i] {
			t.Fatalf("sequence = %v, want %v", seq, want)
		}
		if i > 0 && seq[i] == seq[i-1] {
			t.Fatalf("同一智能体连续两轮接龙: %v", seq)
		}
	}
}

// TestGroupRelaySingleSpeakerRunsOneRound 是行为级用例：用假融云真跑一次
// 单成员 + 默认 3 轮的中继，断言 totalRounds 收敛为 1、只派发一次、答完
// 立即收尾（旧实现会连着驱动 3 次）。
func TestGroupRelaySingleSpeakerRunsOneRound(t *testing.T) {
	rec, client := newRelayRecorder(t)
	rt := newDiscussionRuntime(nil, nil, client, "sys-node", testLogger())
	hub := &chatroomRelayHub{
		sessions: map[string]*relaySession{},
		rounds:   map[string][]relayRound{},
		rt:       rt,
	}
	const groupID = "g-single-speaker"
	if started, queued := hub.StartGroupOrQueue(context.Background(), groupID,
		oneSpeaker(), "你好", "rc_user", defaultGroupRelayRounds, false); !started || queued {
		t.Fatalf("relay should start: started=%v queued=%v", started, queued)
	}
	if s := relaySessionState(hub, groupID); s == nil || s.totalRounds != 1 {
		t.Fatalf("单智能体会话 totalRounds 应为 1, got %+v", s)
	}
	acceptFrom(t, hub, groupID, "rc_only", "唯一一轮的回答")
	waitUntil(t, "session ends after the single round", func() bool {
		return relaySessionState(hub, groupID) == nil
	})
	privates, group := rec.snapshot()
	if len(privates) != 1 {
		t.Fatalf("单智能体只应派发 1 次, got %d", len(privates))
	}
	if got := broadcastTexts(t, group); len(got) != 1 || got[0] != "唯一一轮的回答" {
		t.Fatalf("broadcasts = %v, want the single answer", got)
	}
}

// TestGroupRelayStartOrQueueConvergesRounds 直接验证 StartGroupOrQueue 把
// 收敛后的 total 一路带给排队消息（enqueue 分支不启动 pump、不碰 DB/runtime，
// 因此这里能纯内存地钉住入口接入是否生效）。
func TestGroupRelayStartOrQueueConvergesRounds(t *testing.T) {
	cases := []struct {
		name      string
		members   []relayMember
		rounds    int
		wantTotal int
	}{
		{"单智能体默认3轮→排队消息也是1轮", oneSpeaker(), 3, 1},
		{"单智能体配置5轮→排队消息也是1轮", oneSpeaker(), 5, 1},
		{"2成员默认3轮→排队消息保持3轮", twoSpeakers(), 3, 3},
		{"2成员0轮→排队消息回落3轮", twoSpeakers(), 0, 3},
		{"2成员50轮→排队消息截到10轮", twoSpeakers(), 50, maxGroupRelayRounds},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hub := &chatroomRelayHub{
				sessions: map[string]*relaySession{},
				rounds:   map[string][]relayRound{},
			}
			existing := &relaySession{chatroomRCID: "g", totalRounds: 3}
			hub.sessions["g"] = existing
			started, queued := hub.StartGroupOrQueue(context.Background(), "g",
				tc.members, "又一条消息", "rc_user", tc.rounds, false)
			if started || !queued {
				t.Fatalf("busy session should queue: started=%v queued=%v", started, queued)
			}
			hub.mu.Lock()
			pending := existing.pending
			hub.mu.Unlock()
			if pending == nil {
				t.Fatal("queued message missing pending")
			}
			if pending.totalRounds != tc.wantTotal {
				t.Fatalf("pending.totalRounds = %d, want %d", pending.totalRounds, tc.wantTotal)
			}
		})
	}
}
