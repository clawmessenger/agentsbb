// 进程内讨论控制门面（P2：给 HTTP / MCP 这类本进程调用方用）。
//
// 为什么要这一层：v3 交互轮次引擎的 action 实现全是包内私有方法，入参是
// CommandContent + discussionActor。C 端走融云 IM 命令（service=discussion），
// 服务端把它解密后交给 system_handler 分发。MCP 没有 IM 往返可走，但**必须**走
// 同一套实现 —— 创建闸门（配额 / 主持节点在场 / 角色推荐一致性）、幂等键、
// 事件落库、广播全部在里面。任何在 handler 层另写一套创建/推进逻辑的做法都会
// 立刻与 C 端口径分叉（先是配额，然后是角色权限闸门）。
//
// 所以这里只做三件事：把参数装成 CommandContent、调同一个 action、把
// commandResult 翻译成导出结构。**不新写业务判断**。
//
// 身份：actorRCID 是融云侧 TEXT id（= claw_im_users.user_id，即 MCP 的 Bearer
// 解出来的 id），与 C 端命令的 msg.FromUserID 同域。
package rongcloud

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"

	"github.com/google/uuid"
)

// DiscussionControl 是讨论控制的进程内入口。由 registration 在运行时装配完成
// 后通过 ChannelDeps.DiscussionControlSink 交给 HTTP 侧，nil 表示不可用
// （融云未配置 / 讨论仓库未装配），调用方应回 503。
type DiscussionControl struct {
	rt     *discussionRuntime
	logger *slog.Logger
}

func newDiscussionControl(rt *discussionRuntime, logger *slog.Logger) *DiscussionControl {
	if logger == nil {
		logger = slog.Default()
	}
	return &DiscussionControl{rt: rt, logger: logger}
}

// ControlOutcome 是控制调用的统一回包。Code 与 C 端命令码同口径
// （200 成功；400/403/409/410/429/503 失败），Message 是原因码或文案。
type ControlOutcome struct {
	Code    int
	Message string
	Data    map[string]interface{}
}

// OK 报告调用是否成功。
func (o ControlOutcome) OK() bool { return o.Code == 200 }

func controlOutcome(result commandResult) ControlOutcome {
	out := ControlOutcome{Code: result.code, Message: result.message}
	switch data := result.data.(type) {
	case nil:
	case map[string]interface{}:
		out.Data = data
	default:
		out.Data = map[string]interface{}{"value": data}
	}
	if out.Code == 0 {
		out.Code = 200
	}
	return out
}

// CreateRoundtableRequest 是一次建组 + 提交议题的入参（引导式创建 S1+S2）。
//
// 为什么把两步合成一次调用：MCP 的调用方是另一个应用的编排层，它对
// 「先建房拿 chatroomId，再把 chatroomId 填回议题」这种两段式没有任何收益，
// 反而多一次可能失败的网络往返。后台真正的状态机不变 —— shell 建 configuring
// 半成品，submitSetupTopic 推断点到 roles 并异步发起角色推荐。
type CreateRoundtableRequest struct {
	// Topic 必填，本次讨论的议题（≤4000 字节，与 C 端同口径）。
	Topic string
	// Goal 可选，期望产出/目标（≤8000 字节）。
	Goal string
	// ChatroomName 可选，讨论组名；空则由议题自动命名（服务端 nameDiscussionGroupFromTopic）。
	ChatroomName string
	// ClientRequestID 可选，幂等键。同一 (用户, 幂等键) 重放返回既有半成品。
	// 空时由服务端生成，重放语义随之退化为「每次都新建」。
	ClientRequestID string
}

// CreateRoundtable 建组并提交议题，返回 configuring 半成品。
//
// 失败口径全部来自 action 本身：429 QUOTA_EXCEEDED、503 SYSTEM_HOST_OFFLINE
// （主持节点不在场）、409 CREATE_ROUNDTABLE_CONFLICT 等，调用方原样透出即可。
func (c *DiscussionControl) CreateRoundtable(ctx context.Context, actorRCID string, req CreateRoundtableRequest) (ControlOutcome, error) {
	if c == nil || c.rt == nil {
		return ControlOutcome{}, errors.New("discussion control not configured")
	}
	topic := strings.TrimSpace(req.Topic)
	if topic == "" {
		return ControlOutcome{Code: 400, Message: "TOPIC_REQUIRED"}, nil
	}
	actor, err := c.resolveActor(ctx, actorRCID)
	if err != nil {
		return ControlOutcome{}, err
	}
	clientRequestID := strings.TrimSpace(req.ClientRequestID)
	if clientRequestID == "" {
		clientRequestID = "mcp-" + uuid.NewString()
	}

	shellResult := c.rt.actionCreateRoundtableShell(ctx, CommandContent{
		Service: "discussion",
		Action:  "createRoundtableShell",
		Params: map[string]interface{}{
			"client_request_id": clientRequestID,
			"name":              strings.TrimSpace(req.ChatroomName),
		},
	}, actor)
	outcome := controlOutcome(shellResult)
	if !outcome.OK() {
		return outcome, nil
	}
	chatroomID, _ := outcome.Data["chatroom_id"].(string)
	discussionID, _ := outcome.Data["discussion_id"].(string)
	if chatroomID == "" {
		return ControlOutcome{Code: 500, Message: "CREATE_ROUNDTABLE_RECOVERABLE"}, nil
	}

	topicResult := c.rt.actionSubmitSetupTopic(ctx, CommandContent{
		Service: "discussion",
		Action:  "submitSetupTopic",
		Params: map[string]interface{}{
			"chatroom_id": chatroomID,
			"topic":       topic,
			"goal":        strings.TrimSpace(req.Goal),
		},
	}, actor)
	outcome = controlOutcome(topicResult)
	if !outcome.OK() {
		// 建房已成功、议题没落地：把 chatroomId 带回去，调用方能续做
		// （get_roundtable_setup → 重提议题），不必重新建房。
		if outcome.Data == nil {
			outcome.Data = map[string]interface{}{}
		}
		outcome.Data["chatroomId"] = chatroomID
		outcome.Data["discussionId"] = discussionID
		return outcome, nil
	}

	return ControlOutcome{Code: 200, Data: map[string]interface{}{
		"chatroomId":   chatroomID,
		"discussionId": discussionID,
		"status":       DiscussionStatusConfiguring,
		// 角色推荐是异步跑的（设备端一整轮 LLM，可达 60s），这里只能告诉调用方
		// 「去轮询 get_roundtable_setup 等 roles 就绪」，不能假装已经能确认。
		"setupStep":       setupStepRoles,
		"nextAction":      "get_roundtable_setup",
		"clientRequestId": clientRequestID,
	}}, nil
}

// SetupState 读 configuring 半成品的当前步骤与最近一次引导卡。
//
// C 端靠服务端广播的 setup_prompt 事件渲染引导页；MCP 没有推送通道，只能轮询。
// roles 就绪后的载荷里带 recommendationId，是 confirm_roundtable 的必填入参。
func (c *DiscussionControl) SetupState(ctx context.Context, actorRCID, chatroomID string) (ControlOutcome, error) {
	if c == nil || c.rt == nil {
		return ControlOutcome{}, errors.New("discussion control not configured")
	}
	chatroomID = strings.TrimSpace(chatroomID)
	if chatroomID == "" {
		return ControlOutcome{Code: 400, Message: "CHATROOM_ID_REQUIRED"}, nil
	}
	actor, err := c.resolveActor(ctx, actorRCID)
	if err != nil {
		return ControlOutcome{}, err
	}

	resume := c.rt.actionResumeSetup(ctx, CommandContent{
		Service: "discussion",
		Action:  "resumeSetup",
		Params:  map[string]interface{}{"chatroom_id": chatroomID},
	}, actor)
	outcome := controlOutcome(resume)
	if !outcome.OK() {
		// 半成品不存在有两种正常原因：已经确认开始（讨论跑起来了）、或被 GC 回收。
		// 前者不是错误 —— 告诉调用方去看活跃讨论，别让它以为创建失败。
		if active, aErr := c.rt.queries.GetActiveRongCloudDiscussionByChatroom(ctx, chatroomID); aErr == nil && active.CreatedBy == actor.RcID {
			return ControlOutcome{Code: 200, Data: map[string]interface{}{
				"chatroomId":   chatroomID,
				"discussionId": active.DiscussionID,
				"status":       active.Status,
				"setupStep":    "",
				"ready":        true,
			}}, nil
		}
		return outcome, nil
	}

	discussionID, _ := outcome.Data["discussion_id"].(string)
	data := map[string]interface{}{
		"chatroomId":   chatroomID,
		"discussionId": discussionID,
		"status":       outcome.Data["status"],
		"setupStep":    outcome.Data["step"],
		"topic":        outcome.Data["topic"],
		"ready":        false,
	}
	if prompt, ok := c.rt.latestSetupPrompt(ctx, discussionID); ok {
		var payload map[string]interface{}
		if err := json.Unmarshal(prompt.Payload, &payload); err == nil {
			for k, v := range payload {
				switch k {
				case "step", "prompt", "roles", "recommendationId", "expiresAt", "attempt", "code", "message":
					data[k] = v
				}
			}
		}
		if step, _ := data["step"].(string); step == setupStepRoles {
			data["ready"] = true
		}
	}
	return ControlOutcome{Code: 200, Data: data}, nil
}

// ConfirmRoundtableRequest 是确认开始（S3）的入参。
type ConfirmRoundtableRequest struct {
	ChatroomID string
	// RecommendationID 必填，来自 SetupState 的 recommendationId。
	RecommendationID string
	// Roles 可选。空时由服务端按推荐批次原样全选（每角色带自己的 nodeId）——
	// 这条默认对「全流程托管」是刚需：调用方要么人工确认过角色，要么就照推荐跑。
	// 非空时元素至少含 roleId / roleName / rolePrompt / nodeId（与 SetupState 返回同构）。
	Roles []ConfirmRole
}

// ConfirmRole 是一个待确认角色。
type ConfirmRole struct {
	RoleID     string `json:"roleId"`
	RoleName   string `json:"roleName"`
	RolePrompt string `json:"rolePrompt"`
	NodeID     string `json:"nodeId"`
	Model      string `json:"model,omitempty"`
}

// ConfirmRoundtable 确认角色并开局（configuring → planning → v3 引擎接管）。
func (c *DiscussionControl) ConfirmRoundtable(ctx context.Context, actorRCID string, req ConfirmRoundtableRequest) (ControlOutcome, error) {
	if c == nil || c.rt == nil {
		return ControlOutcome{}, errors.New("discussion control not configured")
	}
	chatroomID := strings.TrimSpace(req.ChatroomID)
	recommendationID := strings.TrimSpace(req.RecommendationID)
	if chatroomID == "" || recommendationID == "" {
		return ControlOutcome{Code: 400, Message: "INVALID_ROUNDTABLE_REQUEST"}, nil
	}
	actor, err := c.resolveActor(ctx, actorRCID)
	if err != nil {
		return ControlOutcome{}, err
	}

	roles := req.Roles
	if len(roles) == 0 {
		// 全选推荐批次。推荐行里已有 role_id / role_name / role_prompt / node_id，
		// 与 parseSetupConfirmRoles 期望的形状一致。
		rec, recErr := c.rt.queries.GetRongCloudRoleRecommendation(ctx, recommendationID)
		if recErr != nil || rec.UserID != actor.RcID {
			return ControlOutcome{Code: 410, Message: "RECOMMENDATION_EXPIRED"}, nil
		}
		var recommended []map[string]interface{}
		if err := json.Unmarshal(rec.Roles, &recommended); err != nil {
			return ControlOutcome{Code: 500, Message: "RECOMMENDATION_UNREADABLE"}, nil
		}
		for _, item := range recommended {
			roles = append(roles, ConfirmRole{
				RoleID:     stringValue(item["role_id"]),
				RoleName:   stringValue(item["role_name"]),
				RolePrompt: stringValue(item["role_prompt"]),
				NodeID:     stringValue(item["node_id"]),
			})
		}
	}
	rawRoles := make([]interface{}, 0, len(roles))
	for _, role := range roles {
		item := map[string]interface{}{
			"role_id":     strings.TrimSpace(role.RoleID),
			"role_name":   strings.TrimSpace(role.RoleName),
			"role_prompt": strings.TrimSpace(role.RolePrompt),
			"node_id":     strings.TrimSpace(role.NodeID),
		}
		if model := strings.TrimSpace(role.Model); model != "" {
			item["model"] = model
		}
		rawRoles = append(rawRoles, item)
	}

	result := c.rt.actionConfirmRoundtableSetup(ctx, CommandContent{
		Service: "discussion",
		Action:  "confirmRoundtableSetup",
		Params: map[string]interface{}{
			"chatroom_id":       chatroomID,
			"recommendation_id": recommendationID,
			"roles":             rawRoles,
		},
	}, actor)
	return controlOutcome(result), nil
}

// LifecycleRequest 是一次用户动作的入参（continue/finish/cancel/stop/interject）。
type LifecycleRequest struct {
	// ChatroomID 与 DiscussionID 二选一：给 DiscussionID 时精确定位那场讨论，
	// 否则取聊天室当前的活跃讨论。
	ChatroomID   string
	DiscussionID string
	// Opinion 仅 continue 用：本轮希望讨论补充的方向（≤8000）。
	Opinion string
	// Reason 仅 cancel 用。
	Reason string
	// Content 仅 interject 用（≤8000 字节）。
	Content string
	// StateVersion 可选。continue/finish 有乐观锁语义，缺省时由服务端读当前版本
	// 填入 —— MCP 的编排层很难自己维护这个版本号，而「先读再写」在这里没有
	// 竞态价值（同一用户不会并发控制同一场讨论）。
	StateVersion *int
	// RequestID 可选幂等键，缺省生成。
	RequestID string
}

// LifecycleActions 是 control_discussion 接受的动作全集。
var LifecycleActions = map[string]bool{
	"continue": true, "finish": true, "cancel": true, "stop": true,
	"interject": true, "retry": true,
}

// Lifecycle 执行一次 v3 讨论的用户动作。action 必须是 LifecycleActions 里的值。
func (c *DiscussionControl) Lifecycle(ctx context.Context, actorRCID, action string, req LifecycleRequest) (ControlOutcome, error) {
	if c == nil || c.rt == nil {
		return ControlOutcome{}, errors.New("discussion control not configured")
	}
	if !LifecycleActions[action] {
		return ControlOutcome{Code: 400, Message: "UNKNOWN_LIFECYCLE_ACTION"}, nil
	}
	actor, err := c.resolveActor(ctx, actorRCID)
	if err != nil {
		return ControlOutcome{}, err
	}

	params := map[string]interface{}{}
	if v := strings.TrimSpace(req.ChatroomID); v != "" {
		params["chatroom_id"] = v
	}
	if v := strings.TrimSpace(req.DiscussionID); v != "" {
		params["discussionId"] = v
	}
	if params["chatroom_id"] == nil && params["discussionId"] == nil {
		return ControlOutcome{Code: 400, Message: "CHATROOM_ID_REQUIRED"}, nil
	}
	requestID := strings.TrimSpace(req.RequestID)
	if requestID == "" {
		requestID = uuid.NewString()
	}
	params["requestId"] = requestID

	switch action {
	case "continue", "finish":
		if version := req.StateVersion; version != nil {
			params["stateVersion"] = *version
		} else if current, ok := c.currentVersion(ctx, params); ok {
			params["stateVersion"] = current
		}
		if opinion := strings.TrimSpace(req.Opinion); opinion != "" {
			params["opinion"] = opinion
		}
	case "cancel":
		if reason := strings.TrimSpace(req.Reason); reason != "" {
			params["reason"] = reason
		}
	case "retry":
		// retry 的版本校验是可选的（引擎只在带了不一致版本时才拒），所以这里
		// 只透传调用方显式给的值，不替它读当前版本 —— 替它填反而会把「重试一次
		// 正在推进的讨论」变成必然的版本冲突。
		if version := req.StateVersion; version != nil {
			params["stateVersion"] = *version
		}
	case "interject":
		content := strings.TrimSpace(req.Content)
		if content == "" {
			return ControlOutcome{Code: 400, Message: "CONTENT_REQUIRED"}, nil
		}
		params["content"] = content
		// messageUid 是插话的幂等键；MCP 侧没有 IM 消息可对齐，用 requestId 派生。
		params["messageUid"] = "mcp-" + requestID
	}

	result, handled := c.rt.interactiveLifecycleAction(ctx, action, CommandContent{
		Service: "discussion",
		Action:  action,
		Params:  params,
	}, actor)
	if !handled {
		// 房间里的活跃讨论不是 v3（user_confirmed）：该引擎不接管，说明要操作的是
		// 老口径讨论，或者根本没有活跃讨论。如实报，不回落 legacy 实现 —— 两个
		// 状态机互斥，混着套会把轮次计数写坏。
		return ControlOutcome{Code: 409, Message: "NO_INTERACTIVE_DISCUSSION"}, nil
	}
	return controlOutcome(result), nil
}

// currentVersion 读目标讨论的当前版本号（continue/finish 的乐观锁基线）。
func (c *DiscussionControl) currentVersion(ctx context.Context, params map[string]interface{}) (int, bool) {
	if id, ok := params["discussionId"].(string); ok && id != "" {
		if d, err := c.rt.repo.Get(ctx, id); err == nil {
			return d.Version, true
		}
		return 0, false
	}
	chatroomID, _ := params["chatroom_id"].(string)
	if chatroomID == "" {
		return 0, false
	}
	d, err := c.rt.repo.GetActiveByChatroom(ctx, chatroomID)
	if err != nil {
		return 0, false
	}
	return d.Version, true
}

func (c *DiscussionControl) resolveActor(ctx context.Context, actorRCID string) (discussionActor, error) {
	actorRCID = strings.TrimSpace(actorRCID)
	if actorRCID == "" {
		return discussionActor{}, errors.New("missing actor")
	}
	return c.rt.resolveActor(ctx, actorRCID)
}
