package rongcloud

import (
	"reflect"
	"testing"
)

// 定向派发（@ 意图）的解析与折叠测试。
//
// 全部是纯函数用例：不碰数据库、不碰融云，因为 resolveMentionTargets /
// resolveRelayDispatch 被刻意设计成无 IO —— 「@ 了谁」这种规则密集的逻辑
// 必须能用表驱动钉死，而不是靠拉起一套 relay 夹具去间接验证。

// mentionSpec 是造 relayMember 的最小信息集：rc id + 展示名。
type mentionSpec struct {
	rcID string
	name string
}

// mentionMembers 按给定顺序造一批成员（顺序即接龙顺序）。
func mentionMembers(specs ...mentionSpec) []relayMember {
	members := make([]relayMember, 0, len(specs))
	for i, spec := range specs {
		members = append(members, relayMember{rcID: spec.rcID, roleName: spec.name, order: i})
	}
	return members
}

// mentionNames 取成员展示名序列，用于断言「选了谁、什么顺序」。
func mentionNames(members []relayMember) []string {
	if len(members) == 0 {
		return nil
	}
	names := make([]string, 0, len(members))
	for _, member := range members {
		names = append(names, member.roleName)
	}
	return names
}

// TestResolveMentionTargets 覆盖定向解析的全部主路径：结构化 id、保序、
// 文本兜底、重名歧义、@ 所有人、无 @。
//
// wantDirective 与 wantNames 必须分开断言：前者是「本条消息带了可用定向」，
// 后者是「递给了谁」。两者混为一谈会让「@ 了真人 → 回退全员」这类用例
// 失去区分度（回退全员时 wantNames 是空的，但语义完全不同）。
func TestResolveMentionTargets(t *testing.T) {
	base := mentionMembers(
		mentionSpec{"rc_wang", "老王"},
		mentionSpec{"rc_li", "小李"},
		mentionSpec{"rc_pm", "产品经理"},
		mentionSpec{"rc_pm2", "产品"}, // 用来钉住「前缀匹配」红线
	)

	cases := []struct {
		name          string
		members       []relayMember
		mentions      []string
		mentionAll    bool
		text          string
		wantNames     []string
		wantDirective bool
	}{
		{
			name:          "结构化单 id",
			members:       base,
			mentions:      []string{"rc_li"},
			text:          "@小李 你怎么看",
			wantNames:     []string{"小李"},
			wantDirective: true,
		},
		{
			name: "结构化多 id 保持成员原顺序（不按传入顺序重排）",
			// mentions 故意倒着传：输出必须仍是「老王 → 小李」的接龙顺序。
			members:       base,
			mentions:      []string{"rc_li", "rc_wang"},
			text:          "随便聊聊",
			wantNames:     []string{"老王", "小李"},
			wantDirective: true,
		},
		{
			name:          "结构化 id 里混入不存在的 id 被静默忽略",
			members:       base,
			mentions:      []string{"rc_ghost", "rc_wang", ""},
			text:          "hi",
			wantNames:     []string{"老王"},
			wantDirective: true,
		},
		{
			name:          "结构化 id 全是空白 → 落到文本兜底",
			members:       base,
			mentions:      []string{"  ", ""},
			text:          "@小李 在吗",
			wantNames:     []string{"小李"},
			wantDirective: true,
		},
		{
			name:          "文本 @展示名唯一命中",
			members:       base,
			text:          "@老王 说说看",
			wantNames:     []string{"老王"},
			wantDirective: true,
		},
		{
			name:          "文本多个 @ 命中多人且保持成员顺序",
			members:       base,
			text:          "@小李 @老王 你们俩聊聊",
			wantNames:     []string{"老王", "小李"},
			wantDirective: true,
		},
		{
			name: "重名歧义 → 无定向（不许猜）",
			members: mentionMembers(
				mentionSpec{"rc_a", "小明"},
				mentionSpec{"rc_b", "小明"},
				mentionSpec{"rc_c", "小红"},
			),
			text:          "@小明 你来说",
			wantNames:     nil,
			wantDirective: false,
		},
		{
			name: "部分命中也算歧义 → 整条消息无定向（@ 不能静默消失）",
			members: mentionMembers(
				mentionSpec{"rc_a", "小明"},
				mentionSpec{"rc_b", "小明"},
				mentionSpec{"rc_c", "小红"},
			),
			text:          "@小红 @小明",
			wantNames:     nil,
			wantDirective: false,
		},
		{
			name:          "文本 @ 的名字不在成员里（如真人）→ 无定向",
			members:       base,
			text:          "@张三 你看看",
			wantNames:     nil,
			wantDirective: false,
		},
		{
			name:          "结构化 @ 到真人（不是接力成员）→ 有定向但零目标，交给调用方回退",
			members:       base,
			mentions:      []string{"rc_human_zhangsan"},
			text:          "@张三 你看看",
			wantNames:     nil,
			wantDirective: true,
		},
		{
			name:          "mentionAll → 无定向",
			members:       base,
			mentions:      []string{"rc_li"},
			mentionAll:    true,
			text:          "@小李 你也来",
			wantNames:     nil,
			wantDirective: false,
		},
		{
			name:          "文本 @所有人 → 无定向",
			members:       base,
			text:          "@所有人 开会了",
			wantNames:     nil,
			wantDirective: false,
		},
		{
			name:          "文本 @全体成员 → 无定向",
			members:       base,
			text:          "@全体成员 开会了",
			wantNames:     nil,
			wantDirective: false,
		},
		{
			name:          "完全没有 @ → 无定向",
			members:       base,
			text:          "大家好啊",
			wantNames:     nil,
			wantDirective: false,
		},
		{
			name:          "空正文 + 空 mentions → 无定向",
			members:       base,
			text:          "",
			wantNames:     nil,
			wantDirective: false,
		},
		{
			name:          "孤立 @ 不产生 token",
			members:       base,
			text:          "价格是 100@ 左右",
			wantNames:     nil,
			wantDirective: false,
		},
		{
			name:          "@产品 不得命中 产品经理（禁止前缀匹配）",
			members:       base,
			text:          "@产品 这个需求谁跟",
			wantNames:     []string{"产品"},
			wantDirective: true,
		},
		{
			name:          "@产品经理 不得命中 产品（禁止前缀匹配）",
			members:       base,
			text:          "@产品经理 这个需求谁跟",
			wantNames:     []string{"产品经理"},
			wantDirective: true,
		},
		{
			name:          "@ 展示名后接汉字（无分隔符）不命中：不做包含匹配",
			members:       base,
			text:          "@老王你好",
			wantNames:     nil,
			wantDirective: false,
		},
		{
			name:          "展示名是 rc id（含下划线）时文本兜底仍能命中",
			members:       mentionMembers(mentionSpec{"rc_agent_m1", "rc_agent_m1"}),
			text:          "@rc_agent_m1 在吗",
			wantNames:     []string{"rc_agent_m1"},
			wantDirective: true,
		},
		{
			name:          "结构化 id 优先于正文（正文 @ 了别人也以参数为准）",
			members:       base,
			mentions:      []string{"rc_li"},
			text:          "@老王 你看呢",
			wantNames:     []string{"小李"},
			wantDirective: true,
		},
		// ---- 兜底误判硬化：正文里的 @ 不都是定向意图 ----
		//
		// 下面四组是「误判 = 少派本该发言的人」的退化场景（QA 实测复现）。每对
		// 都是「非定向 → 无定向」+「正控：真的在 @ 时必须仍能定向」，光有前者
		// 的话，一个「永远不认 @」的实现也能全绿。
		{
			name:          "邮箱里的 @ 不算定向（成员名恰好等于邮箱域名前半段）",
			members:       mentionMembers(mentionSpec{"rc_b", "b"}, mentionSpec{"rc_wang", "老王"}),
			text:          "发我邮箱 a@b.com",
			wantNames:     nil,
			wantDirective: false,
		},
		{
			name:          "正控：空白后的 @b 仍定向到 b",
			members:       mentionMembers(mentionSpec{"rc_b", "b"}, mentionSpec{"rc_wang", "老王"}),
			text:          "@b 你好",
			wantNames:     []string{"b"},
			wantDirective: true,
		},
		{
			name:          "URL 路径里的 @ 不算定向（成员名恰好等于路径末段）",
			members:       base,
			text:          "https://example.com/u/@老王",
			wantNames:     nil,
			wantDirective: false,
		},
		{
			name:          "正控：正文里真的 @ 了老王（空白分隔）仍定向",
			members:       base,
			text:          "帮我看下 @老王",
			wantNames:     []string{"老王"},
			wantDirective: true,
		},
		{
			name:          "连续 @@ 仍能定向（第二个 @ 继承第一个的合规结论）",
			members:       mentionMembers(mentionSpec{"rc_zs", "张三"}),
			text:          "@@张三 你来",
			wantNames:     []string{"张三"},
			wantDirective: true,
		},
		{
			name:          "字母后的 @@ 不产生定向（第一个 @ 不合规，第二个一并跳过）",
			members:       mentionMembers(mentionSpec{"rc_zs", "张三"}),
			text:          "a@@张三",
			wantNames:     nil,
			wantDirective: false,
		},
		{
			name:          "@ 在行首",
			members:       mentionMembers(mentionSpec{"rc_zs", "张三"}),
			text:          "@张三 你看",
			wantNames:     []string{"张三"},
			wantDirective: true,
		},
		{
			name:          "@ 在全角括号内",
			members:       mentionMembers(mentionSpec{"rc_zs", "张三"}),
			text:          "（@张三）这个问题",
			wantNames:     []string{"张三"},
			wantDirective: true,
		},
		{
			name:          "@ 紧跟在中文逗号后",
			members:       mentionMembers(mentionSpec{"rc_zs", "张三"}),
			text:          "？，@张三 你答",
			wantNames:     []string{"张三"},
			wantDirective: true,
		},
		{
			name:          "@ 在换行之后",
			members:       mentionMembers(mentionSpec{"rc_zs", "张三"}),
			text:          "第一行\n@张三 你答",
			wantNames:     []string{"张三"},
			wantDirective: true,
		},
		{
			name:          "同一句里邮箱之后真的 @ 了人 → 仍定向",
			members:       mentionMembers(mentionSpec{"rc_b", "b"}, mentionSpec{"rc_wang", "老王"}),
			text:          "发我邮箱 a@b.com ，另外 @老王 你看下",
			wantNames:     []string{"老王"},
			wantDirective: true,
		},
		{
			// 讨论组没有 @ 选人面板，用户就是这么手打的：不能因为硬化而失效。
			name:          "中文紧贴 @ 仍能定向（手打主路径）",
			members:       base,
			text:          "回复@老王 你看下",
			wantNames:     []string{"老王"},
			wantDirective: true,
		},
		{
			name:          "中文紧贴 @（裸写法，无空格无标点）",
			members:       base,
			text:          "回复@老王",
			wantNames:     []string{"老王"},
			wantDirective: true,
		},
		{
			name:          "中文标点收尾紧贴 @",
			members:       base,
			text:          "同意@老王，开始",
			wantNames:     []string{"老王"},
			wantDirective: true,
		},
		{
			name:          "这个问下@老王（中文动词紧贴 @）",
			members:       base,
			text:          "这个问下@老王",
			wantNames:     []string{"老王"},
			wantDirective: true,
		},
		{
			// 裸邮箱文本：@ 前是字母，黑名单必须挡住（正控见上面几条中文紧贴）。
			name:          "裸邮箱 a@b.com（成员含 b）→ 无定向",
			members:       mentionMembers(mentionSpec{"rc_b", "b"}),
			text:          "a@b.com",
			wantNames:     nil,
			wantDirective: false,
		},
		{
			name:          "纯数字本地部分邮箱 10086@qq.com → 无定向",
			members:       mentionMembers(mentionSpec{"rc_qq", "qq"}, mentionSpec{"rc_c", "com"}),
			text:          "10086@qq.com",
			wantNames:     nil,
			wantDirective: false,
		},
		{
			// 纯文字粘连：等于老版本行为（定向到被 @ 者）。产品取舍已记在
			// extractMentionTokens 的注释里，这里只钉住「不会因此 500/报错」。
			name:          "中文粘连两个名字 → 定向到被 @ 的那个（等同老行为）",
			members:       base,
			text:          "老王@小李 你看",
			wantNames:     []string{"小李"},
			wantDirective: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, directive := resolveMentionTargets(
				tc.members, tc.mentions, tc.mentionAll, tc.text, relayMemberDisplayName,
			)
			if directive != tc.wantDirective {
				t.Fatalf("directive = %v, want %v (names=%v)", directive, tc.wantDirective, mentionNames(got))
			}
			if names := mentionNames(got); !reflect.DeepEqual(names, tc.wantNames) {
				t.Fatalf("names = %v, want %v", names, tc.wantNames)
			}
		})
	}
}

// TestExtractMentionTokens 钉住 token 边界：中文标点、空白、连续 @、结尾 @。
//
// 这些细节单独测，因为它们是「@ 失效」最常见的来源：多切一个字符就匹配不上，
// 少切一个字符就会把后文当成名字。
func TestExtractMentionTokens(t *testing.T) {
	cases := []struct {
		name string
		text string
		want []string
	}{
		{"空格分隔", "@老王 你好", []string{"老王"}},
		{"结尾即 token", "@老王", []string{"老王"}},
		{"中文逗号", "@老王，你好", []string{"老王"}},
		{"中文句号", "@老王。", []string{"老王"}},
		{"中文顿号", "@老王、@小李", []string{"老王", "小李"}},
		{"中文感叹号问号", "@老王！@小李？", []string{"老王", "小李"}},
		{"中文冒号分号", "@老王：@小李；", []string{"老王", "小李"}},
		{"全角括号", "@老王（主持人）", []string{"老王"}},
		{"中文书名号", "@老王《报告》", []string{"老王"}},
		{"英文标点", "@Tom, please look", []string{"Tom"}},
		{"换行与制表", "@Tom\n@Jerry\t", []string{"Tom", "Jerry"}},
		{"连续 @", "@@老王", []string{"老王"}},
		{"@ 后接空格：孤立 @ 不产生 token（避免把邮箱/价格里的 @ 后半段当名字）", "@ 老王", nil},
		{"连写两个提及（中间无分隔符）", "@老王@小李", []string{"老王", "小李"}},
		{"行首", "@老王", []string{"老王"}},
		{"全角括号包裹", "（@老王）", []string{"老王"}},
		{"中文逗号后紧邻", "，@老王", []string{"老王"}},
		{"换行后", "第一行\n@老王", []string{"老王"}},
		{"制表符后", "第一列\t@老王", []string{"老王"}},
		{"邮箱：@ 前是字母 → 不是定向起点", "发我邮箱 a@b.com", nil},
		{"邮箱：@ 前是数字 → 不是定向起点", "工单 10086@qq.com", nil},
		{"URL：@ 前是斜杠 → 不是定向起点", "https://example.com/u/@老王", nil},
		{"URL 但 @ 前是空白 → 仍是定向（用户真的在 @）", "看这个 https://example.com/u/ @老王", []string{"老王"}},
		{"字母后的连续 @ 一并跳过（不凭空造出定向）", "a@@老王", nil},
		{"字母后 @ 被跳过，后面合规的 @ 照常认", "a@b.com 然后 @老王 你看", []string{"老王"}},
		// 手打中文提及：黑名单判据要保住这一类（讨论组没有 @ 选人面板，手打是
		// 唯一途径；白名单会把它一起拒掉，是本次硬化最容易踩的坑）。
		{"中文紧贴 @（手打最常见写法）", "回复@老王", []string{"老王"}},
		{"中文标点收尾", "同意@老王，开始", []string{"老王"}},
		{"@ 前是汉字且只有一个提及", "这个得问@老王", []string{"老王"}},
		// 纯文字粘连：黑名单不拦，等于老版本行为（产品取舍，见函数注释）。
		{"中文粘连两个名字（等同老行为）", "老王@小李", []string{"小李"}},
		// 已知的 over-inclusion：邮箱本地部分是中文时黑名单不拦，切出域名前半段。
		// 方向是多派不是少派，且要求恰好有成员叫这个串，故按低危记录并钉住行为。
		{"邮箱本地部分是中文 → 会切出域名前半段（已知 over-inclusion）", "老王@163.com", []string{"163"}},
		{"多个 @ 一个人两次", "@老王 @老王", []string{"老王", "老王"}},
		{"无 @", "大家好啊", nil},
		{"空串", "", nil},
		{"中文里夹 @ 空 token", "邮件 a@ b", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := extractMentionTokens(tc.text); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("extractMentionTokens(%q) = %v, want %v", tc.text, got, tc.want)
			}
		})
	}
}

// TestResolveRelayDispatch 是 relay 层的折叠测试：定向 + 权限 + 回退三件事
// 合起来的结果。聊天室与群聊两个入口共用这一个函数，所以这一组用例等价于
// 「两条 relay 路径的定向行为」。
func TestResolveRelayDispatch(t *testing.T) {
	members := mentionMembers(
		mentionSpec{"rc_wang", "老王"},
		mentionSpec{"rc_li", "小李"},
		mentionSpec{"rc_off", "关掉的"},
	)
	// 关掉的：已认领且群聊无权限。其余未认领（放行）。
	perms := agentPermissionSet{
		"rc_wang": {claimed: false},
		"rc_li":   {claimed: false},
		"rc_off":  {claimed: true, claimedBy: "owner-x", allowGroup: false},
	}

	cases := []struct {
		name         string
		mentions     []string
		mentionAll   bool
		text         string
		wantNames    []string
		wantFallback bool
		wantTargeted bool
	}{
		{
			name: "无 @ → 全员（老行为，回归底线）",
			text: "大家好啊",
			// 关掉的：已认领且 allow_group=false → 被权限滤掉（与定向无关）。
			wantNames:    []string{"老王", "小李"},
			wantFallback: false,
			wantTargeted: false,
		},
		{
			name: "定向命中且有权限 → 只派给目标",
			mentions:     []string{"rc_li"},
			text:         "@小李 你来",
			wantNames:    []string{"小李"},
			wantFallback: false,
			// 方案 A：定向派发的标记位 —— 调用方据此把轮数收口为 1
			// 并启用「失败如实提示」。
			wantTargeted: true,
		},
		{
			name:     "定向目标无权限 → 回退全员（不报错）",
			mentions: []string{"rc_off"},
			text:     "@关掉的 你说",
			// 关掉的被权限滤掉 → 定向结果为空 → 回退全员（关掉的仍不在列表里）
			wantNames:    []string{"老王", "小李"},
			wantFallback: true,
			wantTargeted: false,
		},
		{
			name:         "定向 id 不存在（@ 了真人）→ 回退全员 + mentionFallback",
			mentions:     []string{"rc_human"},
			text:         "@张三 你看",
			wantNames:    []string{"老王", "小李"},
			wantFallback: true,
			wantTargeted: false,
		},
		{
			name:         "mentionAll → 全员且不带 fallback（用户就是要点名全员）",
			mentionAll:   true,
			text:         "@所有人 开会",
			wantNames:    []string{"老王", "小李"},
			wantFallback: false,
			wantTargeted: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, fallback, targeted := resolveRelayDispatch(
				members, tc.mentions, tc.mentionAll, tc.text, perms, sceneGroup, "owner-y",
			)
			if fallback != tc.wantFallback {
				t.Fatalf("fallback = %v, want %v (names=%v)", fallback, tc.wantFallback, mentionNames(got))
			}
			if targeted != tc.wantTargeted {
				t.Fatalf("targeted = %v, want %v (names=%v)", targeted, tc.wantTargeted, mentionNames(got))
			}
			if names := mentionNames(got); !reflect.DeepEqual(names, tc.wantNames) {
				t.Fatalf("names = %v, want %v", names, tc.wantNames)
			}
		})
	}
}

// TestResolveRelayDispatchPermissionUntouched 是红线用例：定向过滤**不能**改
// 变发言侧的权限语义 —— 无定向时的结果必须与直接调用 filterMembersByPermission
// 完全一致（顺序、成员、行为准则注入都相同）。
func TestResolveRelayDispatchPermissionUntouched(t *testing.T) {
	members := mentionMembers(
		mentionSpec{"rc_a", "A"},
		mentionSpec{"rc_b", "B"},
		mentionSpec{"rc_c", "C"},
	)
	perms := agentPermissionSet{
		"rc_a": {claimed: true, claimedBy: "owner-1", allowGroup: true},
		"rc_b": {claimed: true, claimedBy: "owner-1", allowGroup: false},
		"rc_c": {claimed: false},
	}
	want := applyBehaviorPrompts(filterMembersByPermission(members, perms, sceneGroup, "owner-9"), perms)
	got, fallback, targeted := resolveRelayDispatch(members, nil, false, "随便聊聊", perms, sceneGroup, "owner-9")
	if fallback {
		t.Fatalf("无定向时不该带 mentionFallback")
	}
	if targeted {
		t.Fatalf("无定向时不该带 targeted（全员接力语义不能被误标）")
	}
	if !reflect.DeepEqual(mentionNames(got), mentionNames(want)) {
		t.Fatalf("names = %v, want %v", mentionNames(got), mentionNames(want))
	}
	for i := range got {
		if got[i].behaviorPrompt != want[i].behaviorPrompt {
			t.Fatalf("member %d behaviorPrompt = %q, want %q", i, got[i].behaviorPrompt, want[i].behaviorPrompt)
		}
	}
}

// TestMentionParamParsing 钉住命令参数解析（system_handler 里唯一的取数入口）：
// 两种键名风格、数组/单串/逗号串三种值形态、bool 的多种写法。
func TestMentionParamParsing(t *testing.T) {
	cases := []struct {
		name    string
		params  map[string]interface{}
		wantIDs []string
		wantAll bool
	}{
		{
			name:    "web camelCase 数组",
			params:  map[string]interface{}{"mentions": []interface{}{"rc_a", "rc_b"}, "mentionAll": false},
			wantIDs: []string{"rc_a", "rc_b"},
			wantAll: false,
		},
		{
			name:    "CLI snake_case 数组 + 空白被裁掉",
			params:  map[string]interface{}{"mentions": []interface{}{" rc_a ", "", "rc_b"}, "mention_all": true},
			wantIDs: []string{"rc_a", "rc_b"},
			wantAll: true,
		},
		{
			name:    "单字符串 + 逗号分隔",
			params:  map[string]interface{}{"mentions": "rc_a, rc_b"},
			wantIDs: []string{"rc_a", "rc_b"},
			wantAll: false,
		},
		{
			name:    "都没传 → 老客户端（关键回归场景）",
			params:  map[string]interface{}{"content": "hi"},
			wantIDs: nil,
			wantAll: false,
		},
		{
			name:    "mentionAll 传字符串 true（历史序列化形态）",
			params:  map[string]interface{}{"mentionAll": "true"},
			wantIDs: nil,
			wantAll: true,
		},
		{
			name:    "mentionAll 传数字 1",
			params:  map[string]interface{}{"mentionAll": float64(1)},
			wantIDs: nil,
			wantAll: true,
		},
		{
			name:    "mentionAll 传无法识别的写法 → 按 false（缺省语义）",
			params:  map[string]interface{}{"mentionAll": "yes-please-maybe"},
			wantIDs: nil,
			wantAll: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := mentionParamIDs(tc.params); !reflect.DeepEqual(got, tc.wantIDs) {
				t.Fatalf("mentionParamIDs = %v, want %v", got, tc.wantIDs)
			}
			if got := mentionParamAll(tc.params); got != tc.wantAll {
				t.Fatalf("mentionParamAll = %v, want %v", got, tc.wantAll)
			}
		})
	}
}
