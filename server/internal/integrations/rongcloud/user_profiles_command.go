package rongcloud

// user_profiles_command.go implements service=user, action=getProfiles —— 批量按
// id 取用户资料。它是「群聊添加成员弹窗里所有头像都一样」的服务端修复。
//
// 客户端调用点（2026-11-05 全库 grep 核对，回包形状必须同时满足）：
//   - web agentsbb-web/src/services/contacts.ts:204
//     `sendSystemRequest<UserInfo[]>('user','getProfiles',{userIds})` —— resolve 的
//     是信封里的 `data` 本身，所以 data **必须是数组**（不是 {list:[...]}）；
//   - web agentsbb-web/src/services/contacts.ts:304（resolveTargetProfile，
//     扫码/搜索后补单条资料，同样的数组期望）；
//   - web agentsbb-web/src/services/user.ts:84（getUserProfiles，数组期望）；
//   - uniapp agentsbb-uniapp/src/utils/system-service-client.js:377-378
//     （userService.getProfiles，同一契约；当前无页面调用，仅通道保留）。
//
// 数据源是本地镜像表 rongcloud_user（rongcloud_user_id / name / portrait_uri）。
// 融云的 /user/info.json 只能单个查、且限 100 QPS —— 群资料弹窗一次要十几个
// 成员，逐个回填既慢又会把命令通道拖向客户端 15s 超时，所以与 group 域的
// getProfiles（group_members.go:263）同一口径：**本地镜像就是权威投影**。
//
// 2026-11-20 修订（QA5-DEF-07）：镜像不再是真人的唯一来源。真人改头像/昵称走
// ClawUpdateUserProfile，它只写 claw_im_users + 推融云，**不写 rongcloud_user**
// —— 于是「顶部导航是自己新头像，通讯录里同一个虾说号却是默认图」。现在真人
// 优先读 claw_im_users（同一份数据源，改完立即生效），镜像只兜节点账号；两边
// 都缺的字段再回融云补一次（与 user/search 共用 enrichUserSummariesFromRongCloud）。
// 镜像写回放在 ClawUpdateUserProfile，这里不写库 —— 读路径不该引入锁竞争。
//
// 语义决定（与 review 方案对齐）：
//   1. 空列表回 200 + []，不是 400。调用方（contacts.ts）包在 bestEffortWithin
//     （失败吞成 []）里，空列表在前端语义里是合法回包；回 400 只会把「没传 id」
//     变成一次注定被吞的错误日志。
//   2. 查不到的 id **也要占位**：{userId, username: <id>, nickname:"", portraitUri:""}。
//     前端靠 `profileMap.get(friend.userId)` 对齐（contacts.ts:215），缺键等于该
//     成员白等一轮。占位还能让前端把「没有任何资料」与「整条请求失败」区分开。
//   3. 入参兼容 userIds / user_ids（历史客户端两种键名都出现过）。
//   4. 只读，不校验发送者身份 —— 与 user/search、group/getProfiles 同口径。
//
// 失败语义：DB 查询出错回 503（不是 500 —— 与本包其它 store 未装配/查询失败的
// 文案一致），前端 bestEffort 吞掉后走 IM SDK 好友表兜底，行为与修复前相同。

import (
	"context"
	"strings"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)// userProfilesLimit 是单次请求的 id 数上限。回包是一条 IM 私聊消息（web 15s 超时
// 链路），不设上限的话一次恶意/误用请求能把整张镜像表塞进一条消息。前端
// contacts.ts 的真实调用规模是「好友列表 + 自己」，几十为上限，200 给足余量。
const userProfilesLimit = 200

// handleUserProfiles 是 service=user/action=getProfiles 的入口（路由见
// user_command.go 的 handleUserCommand）。
func (h *systemHandler) handleUserProfiles(ctx context.Context, msg NormalizedMessage, cmd CommandContent) error {
	// web 传 userIds；user_ids 是历史别名，一并收下（与 group/getMembers 认
	// memberIds 的做法一致，省得某个旧端整套流程失联）。
	userIDs := dedupeUserIDs(getStringSlice(cmd.Params, "userIds"))
	if len(userIDs) == 0 {
		userIDs = dedupeUserIDs(getStringSlice(cmd.Params, "user_ids"))
	}
	if len(userIDs) == 0 {
		// 空列表是合法回包（见文件头语义决定 1）：不 400，直接回空数组。
		// make 非 nil 保证 JSON 序列化出来是 [] 而不是 null —— web 的
		// `profiles.map(...)` 对 null 会直接抛 TypeError。
		return h.sendWebOK(ctx, msg, cmd, []interface{}{})
	}
	if len(userIDs) > userProfilesLimit {
		userIDs = userIDs[:userProfilesLimit]
	}
	if h.queries == nil {
		return h.sendWebError(ctx, msg, cmd, 503, "user service is unavailable")
	}

	rows, err := h.queries.GetRongCloudUsersByRongCloudIDs(ctx, userIDs)
	if err != nil {
		h.logger.Error("rongcloud: user profiles lookup", "error", err, "count", len(userIDs))
		return h.sendWebError(ctx, msg, cmd, 503, "failed to load user profiles")
	}

	byID := make(map[string]db.RongcloudUser, len(rows))
	for _, row := range rows {
		byID[row.RongcloudUserID] = row
	}

	// 真人账号以 claw_im_users 为准（见文件头 2026-11-20 修订）。查不到就退回
	// 镜像；查询报错不降级成 503 —— 镜像还在手上，少一份更准的名字/头像不该
	// 让整个花名册打不开。
	humans := map[string]humanProfile{}
	if h.humanProfiles != nil {
		var err error
		humans, err = h.humanProfiles(ctx, userIDs)
		if err != nil {
			h.logger.Warn("rongcloud: user profiles human lookup", "error", err, "count", len(userIDs))
			humans = map[string]humanProfile{}
		}
	}

	// 按请求顺序逐 id 组装；镜像没有的 id 补占位条目（见文件头语义决定 2）。
	profiles := make([]map[string]interface{}, 0, len(userIDs))
	// 两边都拿不到名字/头像的条目留给融云补一次（只补空字段，见 enrich 注释）。
	needEnrich := make([]UserSummary, 0, len(userIDs))
	for _, id := range userIDs {
		row, found := byID[id]
		human := humans[id]
		name := strings.TrimSpace(human.nickname)
		portrait := strings.TrimSpace(human.portraitURI)
		if name == "" && found {
			name = strings.TrimSpace(row.Name.String)
		}
		if portrait == "" && found {
			portrait = strings.TrimSpace(row.PortraitUri.String)
		}
		if name == "" || portrait == "" {
			needEnrich = append(needEnrich, UserSummary{UserID: id, Nickname: name, PortraitURI: portrait})
		}
		profiles = append(profiles, map[string]interface{}{
			"userId":      id,
			"username":    id,
			"nickname":    name,
			"portraitUri": portrait,
		})
	}
	// 融云补全按切片原地改，再按 id 回填（回包已经按请求顺序排好了，不能重排）。
	if h.client != nil && len(needEnrich) > 0 {
		enrichUserSummariesFromRongCloud(ctx, h.client, h.logger, needEnrich)
		filled := make(map[string]UserSummary, len(needEnrich))
		for _, item := range needEnrich {
			filled[item.UserID] = item
		}
		for _, profile := range profiles {
			id, _ := profile["userId"].(string)
			item, ok := filled[id]
			if !ok {
				continue
			}
			if item.Nickname != "" {
				profile["nickname"] = item.Nickname
			}
			if item.PortraitURI != "" {
				profile["portraitUri"] = item.PortraitURI
			}
		}
	}
	return h.sendWebOK(ctx, msg, cmd, profiles)
}

// humanProfile 是 claw_im_users 里真人账号的展示字段（只读两列）。
type humanProfile struct {
	nickname    string
	portraitURI string
}

// humanProfileLookup 是真人资料的读取接缝：生产实现走 claw_im_users（见
// loadHumanProfiles），测试注入假数据即可，不必起库。
type humanProfileLookup func(ctx context.Context, userIDs []string) (map[string]humanProfile, error)

// loadHumanProfiles 从 claw_im_users 批量取真人的昵称与头像。
//
// 为什么不用 sqlc：这个 service 的本地表读写一律走参数化 SQL（registration.go
// 的 ChannelDeps.DB 注释），user/search 也是同一套；为两列再生成一次 sqlc 查询
// 只会让生成代码与手写 SQL 两套口径并存。
//
// 空 nickname / portrait_uri 原样返回空串（NULL 折成 ''），由调用方决定要不要
// 退回镜像 —— 这里不做 COALESCE 到其它列，昵称回退成账号名是历史污染源。
func loadHumanProfiles(dbtx db.DBTX) humanProfileLookup {
	if dbtx == nil {
		return nil
	}
	return func(ctx context.Context, userIDs []string) (map[string]humanProfile, error) {
		out := make(map[string]humanProfile, len(userIDs))
		if len(userIDs) == 0 {
			return out, nil
		}
		rows, err := dbtx.Query(ctx, `
			SELECT user_id, COALESCE(nickname, ''), COALESCE(portrait_uri, '')
			  FROM claw_im_users
			 WHERE user_id = ANY($1)`, userIDs)
		if err != nil {
			return out, err
		}
		defer rows.Close()
		for rows.Next() {
			var id, nickname, portrait string
			if err := rows.Scan(&id, &nickname, &portrait); err != nil {
				return out, err
			}
			out[id] = humanProfile{nickname: nickname, portraitURI: portrait}
		}
		return out, rows.Err()
	}
}
