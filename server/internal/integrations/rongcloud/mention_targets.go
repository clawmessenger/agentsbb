package rongcloud

import (
	"strconv"
	"strings"
	"unicode"
)

// 定向派发（「@ 某人」让指定成员回答）的解析与折叠。
//
// 背景：聊天室/群的按序接力一直是「全员依次开口」。用户在消息里 @ 了某个人，
// 服务端却完全不消费这个意图 —— 于是被 @ 的人不一定先答，常常是别人答了，
// 体感就是「@ 了 A，B 抢答」。这个文件是 @ 意图的唯一解析入口：两条 relay
// 路径（聊天室 relayMessage / 群 relayGroupMessage）都只调用这里的函数，
// 不允许各自写一份 if。
//
// 三条硬约束：
//  1. 顺序即接龙顺序（见 filterMembersByPermission 上方的注释）。定向只做
//     **子集筛选**，绝不重排 —— 重排会改变「谁接住谁的话」。
//  2. 展示名必须与派发署名同源。聊天室用 relayRoleName、群用
//     groupSpeakerName，二者在构造 relayMember 时已填进 roleName，所以这里
//     统一走 relayMemberDisplayName，绝不另造第三套取名逻辑。
//  3. 重名不许猜。同一展示名命中 2 个及以上成员时判为歧义 → 当作无定向，
//     回退全员接力。猜错的代价（把话递给无关的 agent）远大于多问一句。

const (
	// mentionPrefix 是 @ 意图的起始字符。融云文本消息里它就是普通字符，
	// 没有结构化字段，所以只能在正文里认。
	mentionPrefix rune = '@'

	// mentionTokenBoundaries 界定「@ 后面的名字到哪结束」。
	//
	// 为什么是常量集合而不是散落的正则：中文标点与全角符号的编码区间不连续，
	// 一条正则要么漏（全角冒号）要么误伤（把英文句点当成名字的一部分），
	// 而边界集合是**可枚举的产品语义**，改一处即可，测试也好表驱动。
	// 空白字符由 unicode.IsSpace 覆盖（含 \t \n \u00a0），'@' 单独判定（连续 @）。
	//
	// 刻意**不含** `_` `-` `+` `/`：展示名可能直接是 rc id（relayRoleName /
	// groupSpeakerName 在缺昵称时回退到 id），id 里全是下划线，把它们当边界
	// 会让「@agent_xxx」被切成「agent」，兜底解析永远失效。
	mentionTokenBoundaries = "，。、！？：；,.!?:;…·~\"'“”‘’（）()【】[]{}「」『』《》<>"
)

// mentionAllTokens 是「@ 所有人」的各种写法：它们是**无定向**的信号，
// 不是某个成员的名字。命中时整条消息按全员接力处理。
//
// 用集合而不是字符串比较：文案会跟着产品迭代（「所有人」/「全体成员」/
// 「all」），新增写法只该改这张表。
var mentionAllTokens = map[string]bool{
	"所有人":      true,
	"全体成员":     true,
	"全体":       true,
	"大家":       true,
	"all":      true,
	"everyone": true,
}

// relayMemberDisplayName 是定向解析用的展示名取值器，同时也是**派发署名**的
// 取值器 —— 两者必须是同一份数据，否则会出现「@ 得到名字但对不上成员」。
//
// relayMember.roleName 在构造时由 relayRoleName（聊天室）/ groupSpeakerName
// （群）填好，这里不再做任何回退推导。
func relayMemberDisplayName(m relayMember) string {
	return m.roleName
}

// resolveMentionTargets 把一条带 @ 意图的消息解析成「该派发给哪些成员」。
//
// 纯函数、无 IO：入参是成员全集与已从命令参数里取出的定向信号，出参是**保持
// 成员原相对顺序**的子集，外加一个「本条消息是否真的带了可用定向」的标记。
//
// 为什么需要第二个返回值：调用方要区分两种「空」——
//   - 没有定向（directive=false）：完全按老行为全员接力，回包不带 fallback；
//   - 有定向但一个都没命中（directive=true, targets 为空）：用户 @ 了人，
//     我们只能回退全员，回包要带 mentionFallback=true 便于排查。
//
// 用一个标记位而不是「nil vs 空切片」的约定：后者靠隐式约定，复制/append
// 一次就会失真，而这里出错的表现是「@ 失效」这种线上事故。
//
// 判定顺序（不可换）：
//  1. mentionAll=true → 无定向（显式「所有人」）。
//  2. mentions 非空（去掉空白后）→ 按集合挑成员，忽略不存在的 id。
//  3. mentions 为空 → 从 text 里解析 @<展示名> 做兜底，精确等值匹配。
func resolveMentionTargets(
	members []relayMember,
	mentions []string,
	mentionAll bool,
	text string,
	displayName func(relayMember) string,
) ([]relayMember, bool) {
	if mentionAll {
		return nil, false
	}
	if wanted := normalizeMentionIDs(mentions); len(wanted) > 0 {
		picked := make([]relayMember, 0, len(wanted))
		for _, member := range members {
			if wanted[member.rcID] {
				picked = append(picked, member)
			}
		}
		// 一个都没命中（id 写错/成员已退群）同样是「有定向、无目标」：
		// 调用方回退全员，而不是把这条消息丢了。
		return picked, true
	}
	return resolveMentionTargetsByName(members, text, displayName)
}

// normalizeMentionIDs 去掉空白、去重，得到「用户到底 @ 了哪些 rc id」的集合。
// 空数组/全空白都视为没有结构化定向，交给文本兜底。
func normalizeMentionIDs(mentions []string) map[string]bool {
	if len(mentions) == 0 {
		return nil
	}
	wanted := make(map[string]bool, len(mentions))
	for _, id := range mentions {
		if trimmed := strings.TrimSpace(id); trimmed != "" {
			wanted[trimmed] = true
		}
	}
	if len(wanted) == 0 {
		return nil
	}
	return wanted
}

// resolveMentionTargetsByName 是文本兜底：从正文里认 @<展示名>。
//
// 匹配规则是**精确等值**，不是前缀也不是包含 —— 否则「@产品」会命中
// 「产品经理」，等于替用户改了收件人。token 后面允许跟分隔符/标点/结尾，
// 那些位置已经被 extractMentionTokens 切掉了。
//
// 歧义处理：只要有一个 token 命中 ≥2 个同名成员，整条消息判为无定向。
// 部分命中也一样 —— 「@A @B」里 A 重名时不能只把 B 递出去，那会让 A 的
// @ 静默消失。
func resolveMentionTargetsByName(
	members []relayMember,
	text string,
	displayName func(relayMember) string,
) ([]relayMember, bool) {
	tokens := extractMentionTokens(text)
	if len(tokens) == 0 {
		return nil, false
	}
	// 展示名 → 成员下标。同一个名字可能对应多个成员（重名），全部记下来，
	// 命中多个就是歧义。
	index := make(map[string][]int, len(members))
	for i, member := range members {
		name := strings.TrimSpace(displayName(member))
		if name == "" {
			continue
		}
		index[name] = append(index[name], i)
	}
	selected := make([]bool, len(members))
	matched := false
	for _, token := range tokens {
		if isMentionAllToken(token) {
			// 「@所有人」出现在正文里：显式全员，等同无定向。
			continue
		}
		hits, ok := index[token]
		if !ok {
			continue
		}
		if len(hits) > 1 {
			// 重名：不许猜，整条消息回退全员。
			return nil, false
		}
		selected[hits[0]] = true
		matched = true
	}
	if !matched {
		return nil, false
	}
	// 按成员原顺序收集：顺序即接龙顺序，不能按 token 出现顺序重排。
	picked := make([]relayMember, 0, len(members))
	for i, member := range members {
		if selected[i] {
			picked = append(picked, member)
		}
	}
	return picked, true
}

// extractMentionTokens 切出正文里所有 @ 后面的名字。
//
// 处理要点：
//   - 连续 @（「@@张三」「@ @张三」）：逐个 @ 起头，空 token 丢弃；
//   - 中文标点/全角符号/空白/另一个 @ 都是边界；
//   - 结尾的孤立 @ 不产生 token。
func extractMentionTokens(text string) []string {
	if text == "" || !strings.ContainsRune(text, mentionPrefix) {
		return nil
	}
	runes := []rune(text)
	tokens := make([]string, 0, 4)
	for i := 0; i < len(runes); i++ {
		if runes[i] != mentionPrefix {
			continue
		}
		start := i + 1
		end := start
		for end < len(runes) && !isMentionTokenBoundary(runes[end]) && runes[end] != mentionPrefix {
			end++
		}
		if end > start {
			tokens = append(tokens, string(runes[start:end]))
		}
		// 跳到 token 末尾：紧邻的下一个 @ 会在下一轮循环里重新起头。
		i = end - 1
	}
	if len(tokens) == 0 {
		return nil
	}
	return tokens
}

// isMentionTokenBoundary 报告 r 是否终止一个 @ 名字。
func isMentionTokenBoundary(r rune) bool {
	if unicode.IsSpace(r) {
		return true
	}
	return strings.ContainsRune(mentionTokenBoundaries, r)
}

// isMentionAllToken 报告 token 是否是「所有人」的写法。英文写法按小写比较，
// 中文写法原样比较（大小写对它无意义）。
func isMentionAllToken(token string) bool {
	trimmed := strings.TrimSpace(token)
	if trimmed == "" {
		return false
	}
	if mentionAllTokens[trimmed] {
		return true
	}
	return mentionAllTokens[strings.ToLower(trimmed)]
}

// resolveRelayDispatch 把「成员全集 + 定向意图 + 权限快照」折叠成这一轮真正
// 要派发的成员列表。聊天室与群聊两条 relay 共用这一份实现：定向选择、
// 权限过滤、回退兜底三件事只允许存在一个版本。
//
// 回退语义（红线）：定向结果经权限过滤后为空时**回退全员接力**，不报错。
// 典型的空结果是「@ 的是真人成员」（他不在 relayMember 列表里，天然命中 0 个）
// 或「被 @ 的 agent 在这个场景没有发言权」。这种情况下报 409
// 「没有可发言的 AI 成员」是把用户的一句 @ 变成一句错误提示，而群里其实有人
// 能说话 —— 用户看到的是「@ 了人反而没人理」。
//
// 返回值 fallback=true 表示「带了定向但没递出去，已回退全员」，回包会带上
// mentionFallback 便于排查（前端不用处理，纯诊断信号）。
func resolveRelayDispatch(
	allMembers []relayMember,
	mentions []string,
	mentionAll bool,
	text string,
	perms agentPermissionSet,
	scene agentPermissionScene,
	actorRCID string,
) ([]relayMember, bool) {
	// 全员基线先算好：无定向时直接用它，有定向但目标全被滤掉时也用它回退。
	// 权限过滤是纯内存遍历，算一次比在回退分支里再算一次更省心。
	full := filterMembersByPermission(allMembers, perms, scene, actorRCID)
	targeted, directive := resolveMentionTargets(allMembers, mentions, mentionAll, text, relayMemberDisplayName)
	if !directive {
		return applyBehaviorPrompts(full, perms), false
	}
	if only := filterMembersByPermission(targeted, perms, scene, actorRCID); len(only) > 0 {
		return applyBehaviorPrompts(only, perms), false
	}
	return applyBehaviorPrompts(full, perms), true
}

// mentionParamIDs 从命令参数里取结构化定向 id 列表。
//
// 两种键名都认（web 发 camelCase、CLI 发 snake_case，与 getStringAny 同口径）；
// 值兼容 JSON 数组、单个字符串与逗号分隔串 —— getStringSlice 已经实现了这套
// 容错，直接复用，避免第二个「解析 id 列表」的实现。
func mentionParamIDs(params map[string]interface{}) []string {
	for _, key := range []string{"mentions", "mentionedIds", "mentioned_ids"} {
		if _, ok := params[key]; !ok {
			continue
		}
		if ids := getStringSlice(params, key); len(ids) > 0 {
			return ids
		}
	}
	return nil
}

// mentionParamAll 从命令参数里取「是否 @ 所有人」。
func mentionParamAll(params map[string]interface{}) bool {
	return getBoolAny(params, "mentionAll", "mention_all")
}

// getBoolAny 读第一个存在的布尔开关。JSON 解出来的值可能是 bool、字符串
// "true"/"1"，或数字 1（历史调用方各自序列化过），三种都认。
//
// 未知写法一律按 false 处理：这是**可选**参数，缺省语义是无定向，
// 猜成 true 会让消息莫名其妙派给全员。
func getBoolAny(m map[string]interface{}, keys ...string) bool {
	for _, key := range keys {
		raw, ok := m[key]
		if !ok || raw == nil {
			continue
		}
		switch typed := raw.(type) {
		case bool:
			return typed
		case string:
			if parsed, err := strconv.ParseBool(strings.TrimSpace(typed)); err == nil {
				return parsed
			}
			if strings.TrimSpace(typed) == "1" {
				return true
			}
		case float64:
			return typed != 0
		case int:
			return typed != 0
		}
	}
	return false
}
