package rongcloud

import (
	"context"
	"testing"
)

// 定向派发的**接线级**测试（真连库、真走权限快照、真调 StartRelay /
// StartGroupRelay）。
//
// 为什么纯函数测试不够：mention_targets_test.go 证明的是「算得对」，这里证明的
// 是「接上了、下发得对」——
//   - 命令参数 → StartRelay/StartGroupRelay 的入参是否真的传达到位（签名改动、
//     参数顺序错位、漏传 nil 都只能在这一层暴露）；
//   - 定向与权限快照的交界：目标被权限滤掉时是否**回退全员且不报错**；
//   - 回包里的 speakers / mentionFallback 是否真的下发（前端与 QA 的判据）。
//
// 这些用例依赖 DATABASE_URL（缺省回落到本地 multica 库），库不可达时 Skip ——
// 与同包既有的 permission 夹具一致，不引入新的测试依赖。

// relayReplyNumbers 取出 relay 回包里的判据字段。
func relayReplyNumbers(t *testing.T, result commandResult) (speakers int, fallback bool) {
	t.Helper()
	if result.code != 200 {
		t.Fatalf("relay 应成功，实际 code=%d message=%q", result.code, result.message)
	}
	data, ok := result.data.(map[string]interface{})
	if !ok {
		t.Fatalf("回包 data 不是 map：%#v", result.data)
	}
	speakers, _ = data["speakers"].(int)
	fallback, _ = data["mentionFallback"].(bool)
	return speakers, fallback
}

// TestGroupRelayMentionDispatch 是群聊链路的端到端定向验证：4 个都有群聊发言权
// 的 agent，逐个场景断言「派给了几个」。
func TestGroupRelayMentionDispatch(t *testing.T) {
	env := newPermEnv(t)
	wang := env.seedAgent(t, "mention-wang-"+uniqueID("t"), "owner-1", permFlags{Group: true}, "")
	li := env.seedAgent(t, "mention-li-"+uniqueID("t"), "owner-1", permFlags{Group: true}, "")
	// 「产品」与「产品经理」同时存在：钉住「禁止前缀匹配」这条红线在**真实链路**
	// 上也成立（纯函数测试只覆盖了算逻辑，这里覆盖取值与派发）。
	product := env.seedAgent(t, "mention-product-"+uniqueID("t"), "owner-1", permFlags{Group: true}, "")
	pm := env.seedAgent(t, "mention-pm-"+uniqueID("t"), "owner-1", permFlags{Group: true}, "")
	resetAgentPermissionCache()

	aiMembers := []GroupMember{
		{UserID: wang.RongcloudUserID, Nickname: "老王"},
		{UserID: li.RongcloudUserID, Nickname: "小李"},
		{UserID: product.RongcloudUserID, Nickname: "产品"},
		{UserID: pm.RongcloudUserID, Nickname: "产品经理"},
	}
	allMembers := append([]GroupMember{{UserID: "rc_requester"}}, aiMembers...)
	hub := newPermHub(permRelayRuntime(env.queries, testLogger()))

	cases := []struct {
		name         string
		text         string
		mentions     []string
		mentionAll   bool
		wantSpeakers int
		wantFallback bool
	}{
		{
			name: "结构化定向只派被 @ 的那一个",
			text: "@小李 你来", mentions: []string{li.RongcloudUserID},
			wantSpeakers: 1, wantFallback: false,
		},
		{
			name: "结构化多 id 只派这两人",
			// 传入顺序与成员顺序相反：派发人数与顺序都以成员表为准，不按传入重排。
			text: "@老王 @小李", mentions: []string{li.RongcloudUserID, wang.RongcloudUserID},
			wantSpeakers: 2, wantFallback: false,
		},
		{
			name: "结构化 id 不存在 → 回退全员且带 mentionFallback",
			text: "@张三 你来", mentions: []string{"rc_ghost_" + uniqueID("t")},
			wantSpeakers: 4, wantFallback: true,
		},
		{
			name: "mentionAll → 全员且不带 mentionFallback",
			text: "@所有人 开会", mentionAll: true,
			wantSpeakers: 4, wantFallback: false,
		},
		{
			name:         "无 @ → 全员（回归底线）",
			text:         "大家好啊",
			wantSpeakers: 4, wantFallback: false,
		},
		{
			name:         "正文 @产品 只命中「产品」，不吃「产品经理」",
			text:         "@产品 这个需求谁跟",
			wantSpeakers: 1, wantFallback: false,
		},
		{
			name:         "正文 @产品经理 只命中「产品经理」",
			text:         "@产品经理 这个需求谁跟",
			wantSpeakers: 1, wantFallback: false,
		},
		{
			name:         "正文 @ 的名字不在成员里 → 全员且不算定向",
			text:         "@张三 你看",
			wantSpeakers: 4, wantFallback: false,
		},
		{
			name:         "邮箱里的 @ 不是定向（成员名恰好等于域名前半段）",
			text:         "发我邮箱 a@老王.com",
			wantSpeakers: 4, wantFallback: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// 每个用例独立的群 id：hub.sessions 按群 id 建键，复用会让后一个用例
			// 走进「已有中继在跑 → 排队」分支，speakers 就测不出差异了。
			groupID := "g-mention-" + uniqueID("t")
			result := hub.StartGroupRelay(context.Background(), groupID, "rc_requester",
				tc.text, allMembers, aiMembers, tc.mentions, tc.mentionAll)
			speakers, fallback := relayReplyNumbers(t, result)
			if speakers != tc.wantSpeakers {
				t.Fatalf("speakers = %d, want %d（定向是否生效只能看这个）", speakers, tc.wantSpeakers)
			}
			if fallback != tc.wantFallback {
				t.Fatalf("mentionFallback = %v, want %v", fallback, tc.wantFallback)
			}
		})
	}
}

// TestGroupRelayMentionTargetWithoutPermissionFallsBack 钉住最危险的一条：@ 到
// 「在这个场景没有发言权」的 agent 时，**不能**变成用户可见的错误（409），
// 必须回 200、回退到有权限的成员、并带 mentionFallback。
func TestGroupRelayMentionTargetWithoutPermissionFallsBack(t *testing.T) {
	env := newPermEnv(t)
	allowed := env.seedAgent(t, "mention-on-"+uniqueID("t"), "owner-1", permFlags{Group: true}, "")
	denied := env.seedAgent(t, "mention-off-"+uniqueID("t"), "owner-1", permFlags{Group: false}, "")
	resetAgentPermissionCache()

	hub := newPermHub(permRelayRuntime(env.queries, testLogger()))
	aiMembers := []GroupMember{
		{UserID: allowed.RongcloudUserID, Nickname: "开着的"},
		{UserID: denied.RongcloudUserID, Nickname: "关掉的"},
	}
	allMembers := append([]GroupMember{{UserID: "rc_requester"}}, aiMembers...)

	t.Run("@ 到无发言权者 → 200 + 回退到有权限的成员 + fallback", func(t *testing.T) {
		result := hub.StartGroupRelay(context.Background(), "g-mention-deny-"+uniqueID("t"),
			"rc_requester", "@关掉的 你说", allMembers, aiMembers,
			[]string{denied.RongcloudUserID}, false)
		speakers, fallback := relayReplyNumbers(t, result)
		if speakers != 1 {
			t.Fatalf("speakers = %d, want 1（只剩有权限的那个）", speakers)
		}
		if !fallback {
			t.Fatalf("mentionFallback 应为 true（定向被权限滤掉，已回退全员）")
		}
	})

	t.Run("@ 到有发言权者 → 200 + 定向命中 + 无 fallback", func(t *testing.T) {
		result := hub.StartGroupRelay(context.Background(), "g-mention-allow-"+uniqueID("t"),
			"rc_requester", "@开着的 你说", allMembers, aiMembers,
			[]string{allowed.RongcloudUserID}, false)
		speakers, fallback := relayReplyNumbers(t, result)
		if speakers != 1 {
			t.Fatalf("speakers = %d, want 1", speakers)
		}
		if fallback {
			t.Fatalf("mentionFallback 应为 false（定向成功递出）")
		}
	})
}

// TestChatroomRelayMentionDispatch 是聊天室链路的接线验证：确认 StartRelay 也
// 接上了同一套定向逻辑（两条路径共用一个实现，但参数是各自传的，签名接错只能
// 在这一层暴露）。
func TestChatroomRelayMentionDispatch(t *testing.T) {
	ctx := context.Background()
	targeted := setupDiscussionFixture(t)
	targeted.rt.interactiveEnabled = true
	hub := newPermHub(targeted.rt)

	// 房间里有且只有这一个 AI 成员：定向它 → 命中；定向一个不存在的 id → 回退
	// 全员（仍是它），两者 speakers 都是 1，靠 mentionFallback 区分。
	t.Run("结构化定向命中", func(t *testing.T) {
		result := hub.StartRelay(ctx, targeted.roomRCID, targeted.ownerRCID, "随便聊聊",
			[]string{targeted.memberNode.RongcloudUserID}, false)
		speakers, fallback := relayReplyNumbers(t, result)
		if speakers != 1 {
			t.Fatalf("speakers = %d, want 1", speakers)
		}
		if fallback {
			t.Fatalf("mentionFallback 应为 false（定向命中）")
		}
	})

	t.Run("结构化 id 不存在 → 回退全员且不报错", func(t *testing.T) {
		// 换一间房：同一 hub 的同房间已经在跑上一轮中继，复用会进排队分支。
		fallbackRoom := setupDiscussionFixture(t)
		fallbackRoom.rt.interactiveEnabled = true
		fallbackHub := newPermHub(fallbackRoom.rt)
		result := fallbackHub.StartRelay(ctx, fallbackRoom.roomRCID, fallbackRoom.ownerRCID,
			"随便聊聊", []string{"rc_ghost_" + uniqueID("t")}, false)
		speakers, fallback := relayReplyNumbers(t, result)
		if speakers != 1 {
			t.Fatalf("speakers = %d, want 1（房间只有 1 个 AI 成员）", speakers)
		}
		if !fallback {
			t.Fatalf("mentionFallback 应为 true（定向目标不存在，已回退全员）")
		}
	})
}
