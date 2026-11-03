package rongcloud

// 「插话要在下一位发言的 agent 那里就读到」的回归用例。
//
// 旧口径：插话只在**归属轮次相等**时注入（round == d.CurrentRound）。running 中途
// 插话（R == N）因为本轮还有人要发言，后续成员读得到 —— 这部分一直是对的。但收口
// 阶段（summarizing / synthesizing，或 running 但本轮全员已说完）归属被判成 N+1，
// 而此刻真正下一位开口的是**第 N 轮的主持人**：它的 CurrentRound 仍是 N，R=N+1 直接
// 被 skip，用户的意见进不了纪要，要白等一整轮。下面第三条用例就是这个缺口。
//
// 现行口径（interactiveVisibleOpinions）：
//
//	R == N            → 注入（任何角色）
//	R == N+1 且 IsHost → 注入
//	其余              → 不注入

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// interjectionVisibilityMembers 是这些用例统一用的两名普通成员（顺序即 speaking_order）。
var interjectionVisibilityMembers = [][2]string{
	{"rc-analyst", "分析者"},
	{"rc-critic", "质疑者"},
}

// assertPromptHas 断言提示词里出现了该片段；prompt 一并打出来便于定位。
func assertPromptHas(t *testing.T, prompt, want, context string) {
	t.Helper()
	if !strings.Contains(prompt, want) {
		t.Errorf("%s：提示词缺少 %q\n--- prompt ---\n%s", context, want, prompt)
	}
}

// assertPromptMisses 断言提示词里**没有**该片段（防重复注入/提前注入）。
func assertPromptMisses(t *testing.T, prompt, unwanted, context string) {
	t.Helper()
	if strings.Contains(prompt, unwanted) {
		t.Errorf("%s：提示词不应包含 %q\n--- prompt ---\n%s", context, unwanted, prompt)
	}
}

// interjectionAppliedUIDs 读回该讨论所有 interjection_applied 回执的 messageUid 集合。
// 回执的 payload 是裸 JSON（interactiveEmit 直接 mustJSON(e.Payload)），所以按
// messageUid 取值即可，不必剥 v3 信封。
func interjectionAppliedUIDs(t *testing.T, f *discussionFixture, discussionID string) map[string]int {
	t.Helper()
	events, err := f.rt.repo.ListEventsAfter(context.Background(), discussionID, 0)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	out := map[string]int{}
	for _, event := range events {
		if event.EventType != "interjection_applied" {
			continue
		}
		var payload map[string]interface{}
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			continue
		}
		if uid, _ := payload["messageUid"].(string); uid != "" {
			out[uid]++
		}
	}
	return out
}

// appliedRoundOf 取插话回包的 appliedRound，并校验 200。
func appliedRoundOf(t *testing.T, result commandResult, context string) int {
	t.Helper()
	if result.code != 200 {
		t.Fatalf("%s：插话应被接受，得到 %d (%s)", context, result.code, result.message)
	}
	data, _ := result.data.(map[string]interface{})
	applied, ok := data["appliedRound"].(int)
	if !ok || applied < 1 {
		t.Fatalf("%s：回包缺少 appliedRound >= 1，得到 %v", context, data["appliedRound"])
	}
	return applied
}

// TestInterjectionVisibleOpinions 是过滤规则的纯函数表驱动断言：普通成员 × 主持人
// 两种角色，各配 R = N-1 / N / N+1 / N+2 四条候选插话。
//
// 表里刻意带上 N-1 与 N+2：只测 N/N+1 的话，把实现写成
// `round >= currentRound`（或整个不过滤）依然会全绿 —— 而那样 N-1 会跨轮重复、
// N+2 会提前抢跑，正是要防的两种回归。
func TestInterjectionVisibleOpinions(t *testing.T) {
	const current = 3
	opinions := []interactiveOpinion{
		{messageUID: "prev", content: "归属上一轮", round: current - 1},
		{messageUID: "cur", content: "归属本轮", round: current},
		{messageUID: "next", content: "归属下一轮", round: current + 1},
		{messageUID: "later", content: "归属更后面", round: current + 2},
	}

	cases := []struct {
		name   string
		isHost bool
		want   []string
	}{
		// 普通成员：只读本轮。下一轮那条不能提前给他（否则第 N+1 轮会读到两遍）。
		{"普通成员", false, []string{"cur"}},
		// 主持人：本轮 + 下一轮。收口时它就是本轮最后一位发言者，必须当场读进纪要。
		{"主持人", true, []string{"cur", "next"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := interactiveVisibleOpinions(opinions, current, tc.isHost)
			uids := make([]string, 0, len(got))
			for _, opinion := range got {
				uids = append(uids, opinion.messageUID)
			}
			if len(uids) != len(tc.want) {
				t.Fatalf("可见插话 = %v（%d 条），期望 %v（%d 条）",
					uids, len(uids), tc.want, len(tc.want))
			}
			for i := range tc.want {
				if uids[i] != tc.want[i] {
					t.Errorf("可见插话[%d] = %q，期望 %q（完整 %v）", i, uids[i], tc.want[i], uids)
				}
			}
			// 结构体字段必须原样带出（messageUID 是回执的键，丢了就打不出回执）。
			for _, opinion := range got {
				if opinion.messageUID == "" {
					t.Errorf("过滤后丢了 messageUID：%+v", opinion)
				}
				if opinion.round == 0 {
					t.Errorf("过滤后丢了归属轮次：%+v", opinion)
				}
			}
		})
	}

	// 入参不能被就地改写：opinions 是轮内共享快照，改它会污染同轮后续派发。
	if got := interactiveVisibleOpinions(opinions, current, false); len(got) > 0 {
		got[0].content = "被篡改"
	}
	if opinions[1].content != "归属本轮" {
		t.Fatalf("interactiveVisibleOpinions 直接改写了入参切片：%+v", opinions)
	}

	// 空输入不得 Panic（派发时没有任何插话是最常见的情况）。
	if got := interactiveVisibleOpinions(nil, current, true); len(got) != 0 {
		t.Fatalf("空输入应返回空集合，得到 %+v", got)
	}
}

// TestInterjectionVisible_MemberReadsMidRoundInterjection 钉住「running 中途插话，
// 本轮后续成员立刻读得到」这条既有行为（R == N，必须保持）。
//
// 归属判定的前置条件是「本轮还没全员说完」：只让分析者发言，于是
// interactiveInterjectionRoundFor 给 R = 当前轮，而不是顺延。
func TestInterjectionVisible_MemberReadsMidRoundInterjection(t *testing.T) {
	f := setupDiscussionFixture(t)
	d := newWindowFixtureDiscussion(t, f, 3, interjectionVisibilityMembers)

	// 第 3 轮只让分析者发言 → 本轮未全员完成 → 插话归当前轮。
	appendFixtureEvent(t, f, d.DiscussionID, "contribution_completed", "rc-analyst",
		map[string]interface{}{"round": 3, "content": "分析者第三轮的判断"})

	uid := "uid-mid-" + uniqueID("t")
	const content = "【插话-中途】先别急着收口，成本数据我这边有补充"
	applied := appliedRoundOf(t, interjectAs(t, f, interjectCmd(d.DiscussionID, d.Version, uid, content)), "running 中途插话")
	if applied != 3 {
		t.Fatalf("running 中途插话的 appliedRound = %d，期望 3（本轮未被全员说完，不该顺延）", applied)
	}

	critic := roleFromSnapshot(t, d, "rc-critic")
	if err := f.rt.interactiveDispatch(context.Background(), d, critic, 1); err != nil {
		t.Fatalf("dispatch critic: %v", err)
	}
	criticPrompt := dispatchTasksByTarget(t, f, d.DiscussionID)["rc-critic"].Prompt
	if criticPrompt == "" {
		t.Fatal("普通成员派发没有落进 outbox")
	}
	assertPromptHas(t, criticPrompt, content, "本轮下一位普通成员应读到中途插话")

	// 回执必须落（它确实被注入到这条提示词里）。
	if got := interjectionAppliedUIDs(t, f, d.DiscussionID)[uid]; got != 1 {
		t.Fatalf("interjection_applied 回执条数 = %d，期望 1（uid=%s）", got, uid)
	}
}

// TestInterjectionVisible_HostReadsClosingInterjectionSameRound 是本次修复的核心断言：
//
//	收口阶段（summarizing，本轮全员已发言完毕）用户插话，归属被判成第 N+1 轮；
//	但真正下一位开口的是第 N 轮的主持人，它必须在**本轮**的派发里就读到这条插话。
//
// 修复前：主持人的 CurrentRound 仍是 N，R=N+1 被「严格相等」过滤掉，纪要里根本没有
// 用户这条意见，用户要白等一整轮才有人读到。
func TestInterjectionVisible_HostReadsClosingInterjectionSameRound(t *testing.T) {
	f := setupDiscussionFixture(t)
	ctx := context.Background()
	d := newWindowFixtureDiscussion(t, f, 3, interjectionVisibilityMembers)

	// 第 3 轮全员发言完毕 → 收口阶段。
	for _, member := range interjectionVisibilityMembers {
		appendFixtureEvent(t, f, d.DiscussionID, "contribution_completed", member[0],
			map[string]interface{}{"round": 3, "content": member[1] + "第三轮的判断"})
	}
	summarizing, err := f.rt.repo.AdvanceState(ctx, AdvanceDiscussionParams{
		DiscussionID: d.DiscussionID, ExpectedVersion: d.Version,
		Status: DiscussionStatusSummarizing, CurrentRound: 3, RoundRevision: d.RoundRevision,
	})
	if err != nil {
		t.Fatalf("advance to summarizing: %v", err)
	}

	uid := "uid-closing-" + uniqueID("t")
	const content = "【插话-收口】结论里必须写明预算上限是 50 万"
	applied := appliedRoundOf(t, interjectAs(t, f, interjectCmd(d.DiscussionID, summarizing.Version, uid, content)), "收口阶段插话")
	if applied != 4 {
		t.Fatalf("收口阶段插话的 appliedRound = %d，期望 4（归属下一轮，显示契约不变）", applied)
	}

	host := roleFromSnapshot(t, summarizing, "host-rc")
	if !host.IsHost {
		t.Fatalf("角色板里 host-rc 不是主持人：%+v", host)
	}
	if err := f.rt.interactiveDispatch(ctx, summarizing, host, 1); err != nil {
		t.Fatalf("dispatch host: %v", err)
	}
	hostPrompt := dispatchTasksByTarget(t, f, summarizing.DiscussionID)["host-rc"].Prompt
	if hostPrompt == "" {
		t.Fatal("主持人派发没有落进 outbox")
	}
	assertPromptHas(t, hostPrompt, content, "收口阶段的主持人必须在本轮就读到用户插话")
	// 纪要素材也必须在（插话不能挤掉本轮成员发言）。
	assertPromptHas(t, hostPrompt, "质疑者第三轮的判断", "主持人上下文不能因插话而丢掉本轮发言")

	// 回执只对真正注入的那条落，且只落一条。
	if got := interjectionAppliedUIDs(t, f, summarizing.DiscussionID)[uid]; got != 1 {
		t.Fatalf("interjection_applied 回执条数 = %d，期望 1（uid=%s）", got, uid)
	}
}

// TestInterjectionVisible_NextRoundOrdinaryMemberCannotSeeYetButHostDoes 钉住
// 「下一轮那条只给主持人」：R=N+1 的插话在**第 N 轮**派发给普通成员时不得注入，
// 也不能因此提前落 interjection_applied 回执（否则前端会告诉用户「已纳入」，
// 而其实这次派发的提示词里没有它）。
func TestInterjectionVisible_NextRoundOrdinaryMemberCannotSeeYetButHostDoes(t *testing.T) {
	f := setupDiscussionFixture(t)
	ctx := context.Background()
	d := newWindowFixtureDiscussion(t, f, 3, interjectionVisibilityMembers)

	// 收口阶段：本轮全员已发言完毕 → 插话归属顺延到第 4 轮，但第 3 轮的主持人
	// 才是下一位发言者。这里先让**普通成员**派发一次，证明它此刻还不该看到这条。
	for _, member := range interjectionVisibilityMembers {
		appendFixtureEvent(t, f, d.DiscussionID, "contribution_completed", member[0],
			map[string]interface{}{"round": 3, "content": member[1] + "第三轮的判断"})
	}
	summarizing, err := f.rt.repo.AdvanceState(ctx, AdvanceDiscussionParams{
		DiscussionID: d.DiscussionID, ExpectedVersion: d.Version,
		Status: DiscussionStatusSummarizing, CurrentRound: 3, RoundRevision: d.RoundRevision,
	})
	if err != nil {
		t.Fatalf("advance to summarizing: %v", err)
	}

	uid := "uid-nextonly-" + uniqueID("t")
	const content = "【插话-只给主持】记得把风险窗口写进分歧段"
	if applied := appliedRoundOf(t, interjectAs(t, f, interjectCmd(d.DiscussionID, summarizing.Version, uid, content)), "收口阶段插话"); applied != 4 {
		t.Fatalf("appliedRound = %d，期望 4", applied)
	}

	// 普通成员（本轮）先派发：不得注入，也不得落回执。
	critic := roleFromSnapshot(t, summarizing, "rc-critic")
	if err := f.rt.interactiveDispatch(ctx, summarizing, critic, 1); err != nil {
		t.Fatalf("dispatch critic: %v", err)
	}
	criticPrompt := dispatchTasksByTarget(t, f, summarizing.DiscussionID)["rc-critic"].Prompt
	assertPromptMisses(t, criticPrompt, content, "归属下一轮的插话不得提前注入普通成员")
	if got := interjectionAppliedUIDs(t, f, summarizing.DiscussionID)[uid]; got != 0 {
		t.Fatalf("普通成员未注入却落了 %d 条 interjection_applied 回执", got)
	}

	// 主持人随后派发：必须注入，且此时才落回执。
	host := roleFromSnapshot(t, summarizing, "host-rc")
	if err := f.rt.interactiveDispatch(ctx, summarizing, host, 1); err != nil {
		t.Fatalf("dispatch host: %v", err)
	}
	hostPrompt := dispatchTasksByTarget(t, f, summarizing.DiscussionID)["host-rc"].Prompt
	assertPromptHas(t, hostPrompt, content, "同一轮的主持人必须读到归属下一轮的插话")
	if got := interjectionAppliedUIDs(t, f, summarizing.DiscussionID)[uid]; got != 1 {
		t.Fatalf("主持人注入后回执条数 = %d，期望 1", got)
	}
}

// TestInterjectionVisible_SurvivesIntoNextRound 钉住「R=N+1 的插话在第 N+1 轮普通
// 成员那里仍然读得到」：主持人提前读到不等于把它消耗掉，下一轮成员必须照样拿到。
func TestInterjectionVisible_SurvivesIntoNextRound(t *testing.T) {
	f := setupDiscussionFixture(t)
	ctx := context.Background()
	d := newWindowFixtureDiscussion(t, f, 3, interjectionVisibilityMembers)

	for _, member := range interjectionVisibilityMembers {
		appendFixtureEvent(t, f, d.DiscussionID, "contribution_completed", member[0],
			map[string]interface{}{"round": 3, "content": member[1] + "第三轮的判断"})
	}
	summarizing, err := f.rt.repo.AdvanceState(ctx, AdvanceDiscussionParams{
		DiscussionID: d.DiscussionID, ExpectedVersion: d.Version,
		Status: DiscussionStatusSummarizing, CurrentRound: 3, RoundRevision: d.RoundRevision,
	})
	if err != nil {
		t.Fatalf("advance to summarizing: %v", err)
	}

	uid := "uid-carry-" + uniqueID("t")
	const content = "【插话-跨轮】下一轮请优先讨论交付延期怎么止损"
	if applied := appliedRoundOf(t, interjectAs(t, f, interjectCmd(d.DiscussionID, summarizing.Version, uid, content)), "收口阶段插话"); applied != 4 {
		t.Fatalf("appliedRound = %d，期望 4", applied)
	}

	// 主持人先在本轮消费掉（真实链路里这一步会写纪要）。
	host := roleFromSnapshot(t, summarizing, "host-rc")
	if err := f.rt.interactiveDispatch(ctx, summarizing, host, 1); err != nil {
		t.Fatalf("dispatch host: %v", err)
	}

	// 第 4 轮：普通成员必须仍然读到同一条插话。
	next, err := f.rt.repo.AdvanceState(ctx, AdvanceDiscussionParams{
		DiscussionID: summarizing.DiscussionID, ExpectedVersion: summarizing.Version,
		Status: DiscussionStatusRunning, CurrentRound: 4, RoundRevision: 0,
	})
	if err != nil {
		t.Fatalf("advance to round 4: %v", err)
	}
	critic := roleFromSnapshot(t, next, "rc-critic")
	if err := f.rt.interactiveDispatch(ctx, next, critic, 1); err != nil {
		t.Fatalf("dispatch critic round 4: %v", err)
	}
	criticPrompt := dispatchTasksByTarget(t, f, next.DiscussionID)["rc-critic"].Prompt
	assertPromptHas(t, criticPrompt, content, "归属第 4 轮的插话必须被第 4 轮成员读到")

	// 同一条插话仍然只留一条回执（key 不含成员，主持人已消费过）。
	if got := interjectionAppliedUIDs(t, f, next.DiscussionID)[uid]; got != 1 {
		t.Fatalf("跨轮重复注入导致回执条数 = %d，期望 1", got)
	}
}

// TestInterjectionVisible_NotRepeatedInNextRound 钉住反向约束：R=N 的插话在第 N+1 轮
// 不得再出现（防重复注入）。
//
// 实现若为了省事写成 `round <= currentRound` 或干脆不过滤，这条用例会红 —— 用户会看到
// 模型把同一句话连续两轮当成「新意见」复述。
func TestInterjectionVisible_NotRepeatedInNextRound(t *testing.T) {
	f := setupDiscussionFixture(t)
	ctx := context.Background()
	d := newWindowFixtureDiscussion(t, f, 3, interjectionVisibilityMembers)

	// 本轮只让分析者发言 → 插话归当前轮（3）。
	appendFixtureEvent(t, f, d.DiscussionID, "contribution_completed", "rc-analyst",
		map[string]interface{}{"round": 3, "content": "分析者第三轮的判断"})

	uid := "uid-norepeat-" + uniqueID("t")
	const content = "【插话-别重复】这条意见只在第三轮有效"
	if applied := appliedRoundOf(t, interjectAs(t, f, interjectCmd(d.DiscussionID, d.Version, uid, content)), "中途插话"); applied != 3 {
		t.Fatalf("appliedRound = %d，期望 3", applied)
	}

	// 第 3 轮：质疑者读得到（前置条件，保证下面的「读不到」不是因为压根没写进去）。
	critic := roleFromSnapshot(t, d, "rc-critic")
	if err := f.rt.interactiveDispatch(ctx, d, critic, 1); err != nil {
		t.Fatalf("dispatch critic round 3: %v", err)
	}
	round3Prompt := dispatchTasksByTarget(t, f, d.DiscussionID)["rc-critic"].Prompt
	assertPromptHas(t, round3Prompt, content, "第 3 轮成员应读到本轮插话")

	// 推进到第 4 轮：同一条插话必须消失。
	next, err := f.rt.repo.AdvanceState(ctx, AdvanceDiscussionParams{
		DiscussionID: d.DiscussionID, ExpectedVersion: d.Version,
		Status: DiscussionStatusRunning, CurrentRound: 4, RoundRevision: 0,
	})
	if err != nil {
		t.Fatalf("advance to round 4: %v", err)
	}
	critic4 := roleFromSnapshot(t, next, "rc-critic")
	if err := f.rt.interactiveDispatch(ctx, next, critic4, 1); err != nil {
		t.Fatalf("dispatch critic round 4: %v", err)
	}
	round4Prompt := dispatchTasksByTarget(t, f, next.DiscussionID)["rc-critic"].Prompt
	if round4Prompt == "" {
		t.Fatal("第 4 轮普通成员派发没有落进 outbox")
	}
	assertPromptMisses(t, round4Prompt, content, "R=N 的插话不得在第 N+1 轮重复注入")
}

// assertionHelper 断言「标题 + 具体内容」成对出现，防止只断言原文还在（那样两句
// 标题写成一模一样也会绿）。
func assertOpinionUnder(t *testing.T, prompt, header, content, context string) {
	t.Helper()
	want := header + "\n- " + content
	if !strings.Contains(prompt, want) {
		t.Errorf("%s：提示词里没有「%s」+ 该条内容\n--- prompt ---\n%s", context, header, prompt)
	}
}

// TestInteractiveBuildPromptOpinionHeaders 是文案分叉的纯函数断言（不起库）：
// 同一次派发里既可能有本轮新插话、也可能有上一轮沿用下来的那条，两段标题必须分开，
// 且内容必须落在自己的标题下面。
func TestInteractiveBuildPromptOpinionHeaders(t *testing.T) {
	rt := &discussionRuntime{}
	d := DiscussionRecord{DiscussionID: "disc-pure", CurrentRound: 3}
	role := interactiveRole{MemberID: "rc-critic", RoleName: "质疑者"}
	opinions := []interactiveOpinion{
		{messageUID: "uid-fresh", content: "【插话-新】本轮刚提的意见", round: 3},
		{messageUID: "uid-carried", content: "【插话-沿用】上一轮已经纳入过的意见", round: 3, alreadyApplied: true},
	}
	prompt := rt.interactiveBuildPrompt(d, role, "", opinions, interactiveHistory{})

	assertOpinionUnder(t, prompt, interactiveOpinionHeaderFresh, "【插话-新】本轮刚提的意见", "新插话应用第一次的文案")
	assertOpinionUnder(t, prompt, interactiveOpinionHeaderCarried, "【插话-沿用】上一轮已经纳入过的意见", "沿用插话应用第二次的文案")
	// 反向：两条不能互换标题（互换就等于文案没分叉）。
	assertPromptMisses(t, prompt, interactiveOpinionHeaderFresh+"\n- 【插话-沿用】",
		"已被用过的插话不得挂在「本轮用户插话」标题下")
	assertPromptMisses(t, prompt, interactiveOpinionHeaderCarried+"\n- 【插话-新】",
		"本轮新插话不得挂在「沿用」标题下")

	// 两句文案必须是两句不同的话：写成同一个字符串等于没改。
	if interactiveOpinionHeaderFresh == interactiveOpinionHeaderCarried {
		t.Fatalf("两种插话标题不能相同：%q", interactiveOpinionHeaderFresh)
	}
	// 沿用文案必须自带「不要表述为重复强调」的约束，否则分叉没有意义。
	if !strings.Contains(interactiveOpinionHeaderCarried, "不要表述为用户重复强调") {
		t.Errorf("沿用文案缺少「不要表述为用户重复强调」：%q", interactiveOpinionHeaderCarried)
	}
}

// TestInterjectionVisible_SecondReadUsesCarriedWording 复现 QA 用例
// TestQA_Interject_HostReadsSameOpinionInTwoConsecutiveRounds 的观感问题：
//
//	收口阶段（R = N+1）的一条插话，第 N 轮的主持人读一次、第 N+1 轮再读一次。
//	第一次是本轮插话（必须纳入），第二次必须标成「此前补充的意见（沿用…）」——
//	否则两次都用同一句「必须纳入」时，模型会把用户这一句话表述成「再次强调」，
//	观感像用户在刷屏。
//
// 判据是「这条意见是否已经被用过」（此前落过 interjection_applied 回执），不是
// 「第几次读」：回执只对真正注入的那几条落，且幂等。
func TestInterjectionVisible_SecondReadUsesCarriedWording(t *testing.T) {
	f := setupDiscussionFixture(t)
	ctx := context.Background()
	d := newWindowFixtureDiscussion(t, f, 3, interjectionVisibilityMembers)

	for _, member := range interjectionVisibilityMembers {
		appendFixtureEvent(t, f, d.DiscussionID, "contribution_completed", member[0],
			map[string]interface{}{"round": 3, "content": member[1] + "第三轮的判断"})
	}
	summarizing, err := f.rt.repo.AdvanceState(ctx, AdvanceDiscussionParams{
		DiscussionID: d.DiscussionID, ExpectedVersion: d.Version,
		Status: DiscussionStatusSummarizing, CurrentRound: 3, RoundRevision: d.RoundRevision,
	})
	if err != nil {
		t.Fatalf("advance to summarizing: %v", err)
	}

	uid := "uid-twice-" + uniqueID("t")
	const content = "【插话-两次读】结论里要写明验收口径以合同附件为准"
	if applied := appliedRoundOf(t, interjectAs(t, f, interjectCmd(d.DiscussionID, summarizing.Version, uid, content)), "收口阶段插话"); applied != 4 {
		t.Fatalf("appliedRound = %d，期望 4", applied)
	}

	// 第一次：第 3 轮主持人收口时读 —— 此前没人读过它，必须是「本轮用户插话」。
	host := roleFromSnapshot(t, summarizing, "host-rc")
	if err := f.rt.interactiveDispatch(ctx, summarizing, host, 1); err != nil {
		t.Fatalf("dispatch host round 3: %v", err)
	}
	round3Prompt := dispatchTasksByTarget(t, f, summarizing.DiscussionID)["host-rc"].Prompt
	if round3Prompt == "" {
		t.Fatal("第 3 轮主持人派发没有落进 outbox")
	}
	assertOpinionUnder(t, round3Prompt, interactiveOpinionHeaderFresh, content, "第一次读必须是本轮插话")
	assertPromptMisses(t, round3Prompt, interactiveOpinionHeaderCarried+"\n- "+content,
		"第一次读不得标成沿用（此前没人读到过它）")

	// 第二次：第 4 轮主持人再读同一条 —— 必须换成「沿用」文案，且同一句话不得
	// 在一条提示词里出现两遍。
	next, err := f.rt.repo.AdvanceState(ctx, AdvanceDiscussionParams{
		DiscussionID: summarizing.DiscussionID, ExpectedVersion: summarizing.Version,
		Status: DiscussionStatusRunning, CurrentRound: 4, RoundRevision: 0,
	})
	if err != nil {
		t.Fatalf("advance to round 4: %v", err)
	}
	host4 := roleFromSnapshot(t, next, "host-rc")
	if err := f.rt.interactiveDispatch(ctx, next, host4, 1); err != nil {
		t.Fatalf("dispatch host round 4: %v", err)
	}
	round4Prompt := dispatchTasksByTarget(t, f, next.DiscussionID)["host-rc"].Prompt
	if round4Prompt == "" {
		t.Fatal("第 4 轮主持人派发没有落进 outbox")
	}
	assertOpinionUnder(t, round4Prompt, interactiveOpinionHeaderCarried, content, "第二次读必须标成沿用")
	assertPromptMisses(t, round4Prompt, interactiveOpinionHeaderFresh+"\n- "+content,
		"第二次读不得再挂「本轮用户插话（必须纳入你的发言）」——那会让模型当成用户又强调了一遍")
	if got := strings.Count(round4Prompt, content); got != 1 {
		t.Fatalf("第二次读的提示词里同一句插话出现 %d 次，期望 1\n--- prompt ---\n%s", got, round4Prompt)
	}

	// 回执不因第二次注入而重复落（判据靠它，重复就会串轮次）。
	if got := interjectionAppliedUIDs(t, f, next.DiscussionID)[uid]; got != 1 {
		t.Fatalf("interjection_applied 回执条数 = %d，期望 1（uid=%s）", got, uid)
	}
}

// TestInterjectionVisible_SameRoundMembersKeepFreshWording 钉住判据的边界：同一轮里
// 前一位成员消费后落的回执（信封 round == 本轮）**不能**把同轮后一位成员降级成
// 「沿用」—— 那位成员是第一次读到这条意见，「必须纳入你的发言」的力道不能丢。
func TestInterjectionVisible_SameRoundMembersKeepFreshWording(t *testing.T) {
	f := setupDiscussionFixture(t)
	ctx := context.Background()
	d := newWindowFixtureDiscussion(t, f, 3, interjectionVisibilityMembers)

	// 第 3 轮只让分析者发言 → 插话归当前轮（3），本轮所有成员都该读到。
	appendFixtureEvent(t, f, d.DiscussionID, "contribution_completed", "rc-analyst",
		map[string]interface{}{"round": 3, "content": "分析者第三轮的判断"})

	uid := "uid-sameround-" + uniqueID("t")
	const content = "【插话-同轮】成本口径请统一按含税价"
	if applied := appliedRoundOf(t, interjectAs(t, f, interjectCmd(d.DiscussionID, d.Version, uid, content)), "中途插话"); applied != 3 {
		t.Fatalf("appliedRound = %d，期望 3", applied)
	}

	// 分析者先派发：读一次并落回执。
	analyst := roleFromSnapshot(t, d, "rc-analyst")
	if err := f.rt.interactiveDispatch(ctx, d, analyst, 1); err != nil {
		t.Fatalf("dispatch analyst: %v", err)
	}
	analystPrompt := dispatchTasksByTarget(t, f, d.DiscussionID)["rc-analyst"].Prompt
	assertOpinionUnder(t, analystPrompt, interactiveOpinionHeaderFresh, content, "同轮第一位成员是新读")
	if got := interjectionAppliedUIDs(t, f, d.DiscussionID)[uid]; got != 1 {
		t.Fatalf("回执条数 = %d，期望 1", got)
	}

	// 质疑者随后派发：回执已经存在（同轮落的），但它仍是第一次读到 → 文案不变。
	critic := roleFromSnapshot(t, d, "rc-critic")
	if err := f.rt.interactiveDispatch(ctx, d, critic, 1); err != nil {
		t.Fatalf("dispatch critic: %v", err)
	}
	criticPrompt := dispatchTasksByTarget(t, f, d.DiscussionID)["rc-critic"].Prompt
	assertOpinionUnder(t, criticPrompt, interactiveOpinionHeaderFresh, content,
		"同轮第二位成员仍是第一次读到，必须保留「必须纳入」的文案")
	assertPromptMisses(t, criticPrompt, interactiveOpinionHeaderCarried,
		"同轮之内的回执不得把后一位成员降级成沿用")
}
