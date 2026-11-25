// MCP 控制类工具（第二期）：建组、确认开局、推进/收尾。
//
// 与查询类最大的不同：这些是有副作用、且状态机敏感的写操作。所以它们**不自己**
// 做任何业务判断，一律转发给 rongcloud.DiscussionControl —— 那一层直接调 v3 引擎
// 的同一个 action 实现（配额、主持节点在场、角色权限闸门、幂等键、事件落库、
// 广播全在里面）。MCP 只负责三件事：
//
//  1. 参数整形（MCP 的扁平 JSON → action 期望的 params 键）；
//  2. 成员资格前置校验（不泄露资源存不存在，与查询类同口径）；
//  3. 审计日志（谁、对哪个房间、调了什么、结果码）—— 控制类是唯一的写入面，
//     出事时只能靠这几行日志回溯。
package handler

import (
	"context"
	"log/slog"

	"github.com/multica-ai/multica/server/internal/integrations/rongcloud"
	"github.com/multica-ai/multica/server/internal/mcp"
)

// clawMCPControlTools 返回控制类工具表（拼接在查询类之后）。
func (h *Handler) clawMCPControlTools() []*mcp.Tool {
	return []*mcp.Tool{
		h.clawMCPToolCreateRoundtable(),
		h.clawMCPToolGetRoundtableSetup(),
		h.clawMCPToolConfirmRoundtable(),
		h.clawMCPToolControlDiscussion(),
	}
}

// clawMCPControl 取控制门面；nil = 融云未装配，工具回不可用。
func (h *Handler) clawMCPControl() (*rongcloud.DiscussionControl, error) {
	if h.RongCloudControl == nil {
		return nil, mcp.Errorf("control_unavailable", "讨论控制未装配（融云集成未启用）")
	}
	return h.RongCloudControl, nil
}

// clawMCPControlResult 把门面回包翻成 MCP 结果，并写一行审计日志。
//
// 业务失败走 result.isError（MCP 惯例），同时保留结构化 code —— 调用方的编排层
// 既能给人看文本，也能按 code 分支（如 SYSTEM_HOST_OFFLINE 提示去启动设备）。
func clawMCPControlResult(tool, userID, subject string, outcome rongcloud.ControlOutcome) (mcp.CallResult, error) {
	slog.Info("mcp: discussion control",
		"tool", tool, "user", userID, "subject", subject, "code", outcome.Code)

	if !outcome.OK() {
		payload := map[string]any{
			"code":    outcome.Message,
			"status":  outcome.Code,
			"message": clawMCPControlMessage(outcome.Message),
		}
		if len(outcome.Data) > 0 {
			payload["detail"] = outcome.Data
		}
		result, err := clawMCPJSONResult(payload)
		if err != nil {
			return mcp.CallResult{}, err
		}
		result.IsError = true
		return result, nil
	}

	payload := map[string]any{"ok": true}
	for key, value := range outcome.Data {
		payload[key] = value
	}
	return clawMCPJSONResult(payload)
}

// clawMCPControlMessage 把服务端原因码补成人能读的一句。原因码本身**不改**，
// 调用方仍按 code 判断；这里只是让模型不必猜。
func clawMCPControlMessage(code string) string {
	switch code {
	case "QUOTA_EXCEEDED":
		return "讨论组数量已达配额上限，请先结束或删除已有讨论组"
	case "SYSTEM_HOST_OFFLINE":
		return "主持设备不在线（或主持配置未设置），无法创建/推进讨论"
	case "SYSTEM_HOST_CONFIG_CHANGED":
		return "主持配置已变更，角色推荐作废，请重新获取推荐"
	case "RECOMMENDATION_EXPIRED":
		return "角色推荐已过期，请重新调用 get_roundtable_setup 获取"
	case "ROUNDTABLE_CREATE_REQUEST_NOT_FOUND":
		return "该聊天室没有进行中的配置流程，或当前用户不是创建者"
	case "CREATE_ROUNDTABLE_CONFLICT":
		return "幂等键对应的讨论组属于其他用户"
	case "DISCUSSION_SETUP_STEP_CONFLICT":
		return "当前配置步骤不允许该操作，请先调用 get_roundtable_setup 同步步骤"
	case "INVALID_ROUNDTABLE_REQUEST":
		return "参数不合法（议题/目标/角色字段缺失或超长）"
	case "ROLE_DEVICE_NOT_OWNED", "ROLE_DEVICE_PERMISSION_DENIED", "ROLE_DEVICE_UNAVAILABLE":
		return "所选角色绑定的设备不可用（不属于本人 / 讨论组权限已关闭 / 设备离线）"
	case "TOPIC_REQUIRED":
		return "必须提供讨论议题"
	case "CHATROOM_ID_REQUIRED":
		return "必须提供 chatroomId"
	case "CONTENT_REQUIRED":
		return "插话内容不能为空"
	case "NO_INTERACTIVE_DISCUSSION":
		return "该聊天室当前没有可控制的讨论（未开始或已终结）"
	case "UNKNOWN_LIFECYCLE_ACTION":
		return "不支持的动作"
	}
	return code
}

// ---- create_roundtable ---------------------------------------------------

func (h *Handler) clawMCPToolCreateRoundtable() *mcp.Tool {
	return &mcp.Tool{
		Name: "create_roundtable",
		Description: "创建一个讨论组（圆桌）并提交议题，返回 chatroomId 与 discussionId（status=configuring）。" +
			"服务端随后会异步让主持设备推荐角色（可能耗时数十秒），" +
			"**必须**轮询 get_roundtable_setup 直到 ready=true 再调 confirm_roundtable 才真正开跑。" +
			"需要主持人设备在线、且用户未超出讨论组配额。",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"topic":        map[string]any{"type": "string", "description": "本次讨论的议题（必填，≤4000 字节）"},
				"goal":         map[string]any{"type": "string", "description": "期望产出/目标（可选，≤8000 字节）"},
				"chatroomName": map[string]any{"type": "string", "description": "讨论组名称（可选，空则由议题自动命名）"},
				"clientRequestId": map[string]any{
					"type":        "string",
					"description": "幂等键（可选）。同一用户用同一键重放会返回既有讨论组，不会重复建房",
				},
			},
			"required":             []string{"topic"},
			"additionalProperties": false,
		},
		Handler: func(ctx context.Context, args map[string]any) (mcp.CallResult, error) {
			userID := mcp.UserID(ctx)
			control, err := h.clawMCPControl()
			if err != nil {
				return mcp.CallResult{}, err
			}
			topic, err := clawMCPArgString(args, "topic")
			if err != nil {
				return mcp.CallResult{}, err
			}
			outcome, cErr := control.CreateRoundtable(ctx, userID, rongcloud.CreateRoundtableRequest{
				Topic:           topic,
				Goal:            clawMCPArgOptionalString(args, "goal"),
				ChatroomName:    clawMCPArgOptionalString(args, "chatroomName"),
				ClientRequestID: clawMCPArgOptionalString(args, "clientRequestId"),
			})
			if cErr != nil {
				return mcp.CallResult{}, mcp.Errorf("control_failed", "创建讨论组失败：%v", cErr)
			}
			return clawMCPControlResult("create_roundtable", userID, topic, outcome)
		},
	}
}

// ---- get_roundtable_setup ------------------------------------------------

func (h *Handler) clawMCPToolGetRoundtableSetup() *mcp.Tool {
	return &mcp.Tool{
		Name: "get_roundtable_setup",
		Description: "查看讨论组的配置进度（引导式创建）。返回 setupStep（topic/roles/confirm）、" +
			"ready（角色推荐是否已就绪）、roles（推荐角色，含 roleId/roleName/rolePrompt/nodeId）与 " +
			"recommendationId。ready=false 时稍后重试即可（推荐由主持设备的模型产出）；" +
			"若已确认开局，本工具会改回当前讨论状态而不是报错。",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"chatroomId": map[string]any{"type": "string", "description": "聊天室 id（create_roundtable 返回的 chatroomId）"},
			},
			"required":             []string{"chatroomId"},
			"additionalProperties": false,
		},
		Handler: func(ctx context.Context, args map[string]any) (mcp.CallResult, error) {
			userID := mcp.UserID(ctx)
			control, err := h.clawMCPControl()
			if err != nil {
				return mcp.CallResult{}, err
			}
			chatroomID, err := clawMCPArgString(args, "chatroomId")
			if err != nil {
				return mcp.CallResult{}, err
			}
			if err := h.clawMCPRequireRoom(ctx, chatroomID, userID); err != nil {
				return mcp.CallResult{}, err
			}
			outcome, cErr := control.SetupState(ctx, userID, chatroomID)
			if cErr != nil {
				return mcp.CallResult{}, mcp.Errorf("control_failed", "查询配置进度失败：%v", cErr)
			}
			return clawMCPControlResult("get_roundtable_setup", userID, chatroomID, outcome)
		},
	}
}

// ---- confirm_roundtable --------------------------------------------------

func (h *Handler) clawMCPToolConfirmRoundtable() *mcp.Tool {
	return &mcp.Tool{
		Name: "confirm_roundtable",
		Description: "确认角色并正式开始讨论（configuring → planning → running）。" +
			"roles 省略时按角色推荐原样全选（每个角色用推荐里绑定的设备）；" +
			"也可以只传要参与的角色子集。确认后主持设备接手推进，用 get_discussion / " +
			"get_discussion_events 观察进度。",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"chatroomId":       map[string]any{"type": "string", "description": "聊天室 id"},
				"recommendationId": map[string]any{"type": "string", "description": "get_roundtable_setup 返回的 recommendationId"},
				"roles": map[string]any{
					"type":        "array",
					"description": "参与讨论的角色（可选，省略=推荐全选）。每项需含 roleId/roleName/rolePrompt/nodeId，与 get_roundtable_setup 的 roles 同结构",
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"roleId":     map[string]any{"type": "string"},
							"roleName":   map[string]any{"type": "string"},
							"rolePrompt": map[string]any{"type": "string"},
							"nodeId":     map[string]any{"type": "string"},
							"model":      map[string]any{"type": "string", "description": "可选，provider/slug"},
						},
						"required":             []string{"roleId", "roleName", "rolePrompt", "nodeId"},
						"additionalProperties": false,
					},
				},
			},
			"required":             []string{"chatroomId", "recommendationId"},
			"additionalProperties": false,
		},
		Handler: func(ctx context.Context, args map[string]any) (mcp.CallResult, error) {
			userID := mcp.UserID(ctx)
			control, err := h.clawMCPControl()
			if err != nil {
				return mcp.CallResult{}, err
			}
			chatroomID, err := clawMCPArgString(args, "chatroomId")
			if err != nil {
				return mcp.CallResult{}, err
			}
			recommendationID, err := clawMCPArgString(args, "recommendationId")
			if err != nil {
				return mcp.CallResult{}, err
			}
			if err := h.clawMCPRequireRoom(ctx, chatroomID, userID); err != nil {
				return mcp.CallResult{}, err
			}
			outcome, cErr := control.ConfirmRoundtable(ctx, userID, rongcloud.ConfirmRoundtableRequest{
				ChatroomID:       chatroomID,
				RecommendationID: recommendationID,
				Roles:            clawMCPConfirmRoles(args),
			})
			if cErr != nil {
				return mcp.CallResult{}, mcp.Errorf("control_failed", "确认讨论失败：%v", cErr)
			}
			return clawMCPControlResult("confirm_roundtable", userID, chatroomID, outcome)
		},
	}
}

// clawMCPConfirmRoles 解析可选的 roles 数组；形状不对时返回 nil（交给服务端按
// 推荐全选），而不是猜一个半成品参数 —— 角色错配的失败在服务端有精确原因码。
func clawMCPConfirmRoles(args map[string]any) []rongcloud.ConfirmRole {
	raw, ok := args["roles"].([]any)
	if !ok || len(raw) == 0 {
		return nil
	}
	roles := make([]rongcloud.ConfirmRole, 0, len(raw))
	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			return nil
		}
		roles = append(roles, rongcloud.ConfirmRole{
			RoleID:     clawMCPArgOptionalString(m, "roleId"),
			RoleName:   clawMCPArgOptionalString(m, "roleName"),
			RolePrompt: clawMCPArgOptionalString(m, "rolePrompt"),
			NodeID:     clawMCPArgOptionalString(m, "nodeId"),
			Model:      clawMCPArgOptionalString(m, "model"),
		})
	}
	return roles
}

// ---- control_discussion --------------------------------------------------

func (h *Handler) clawMCPToolControlDiscussion() *mcp.Tool {
	return &mcp.Tool{
		Name: "control_discussion",
		Description: "推进/收尾一场进行中的讨论。action 取值：" +
			"continue（在 awaiting_user 时开启下一轮，可用 opinion 指定下一轮重点）、" +
			"finish（提前结束讨论并生成结尾成果）、" +
			"stop（立即终止整场讨论）、" +
			"cancel（取消讨论，可用 reason 说明）、" +
			"interject（讨论进行中插一句话，内容用 content，会在后续轮次被读到）、" +
			"retry（某位成员发言失败后重派该轮主机工作）。" +
			"只有讨论创建者/聊天室所有者才能 continue/finish/stop/cancel。",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"action": map[string]any{
					"type": "string",
					"enum": []string{"continue", "finish", "stop", "cancel", "interject", "retry"},
				},
				"chatroomId":   map[string]any{"type": "string", "description": "聊天室 id（与 discussionId 二选一，同时给时以 discussionId 为准）"},
				"discussionId": map[string]any{"type": "string", "description": "讨论 id（可选，精确定位）"},
				"opinion":      map[string]any{"type": "string", "description": "continue 专用：下一轮希望补充的方向（≤8000 字节）"},
				"content":      map[string]any{"type": "string", "description": "interject 专用：插话内容（≤8000 字节）"},
				"reason":       map[string]any{"type": "string", "description": "cancel 专用：取消原因"},
				"stateVersion": map[string]any{"type": "integer", "minimum": 0, "description": "可选乐观锁版本（get_discussion 的 version）。省略时服务端读当前版本"},
			},
			"required":             []string{"action"},
			"additionalProperties": false,
		},
		Handler: func(ctx context.Context, args map[string]any) (mcp.CallResult, error) {
			userID := mcp.UserID(ctx)
			control, err := h.clawMCPControl()
			if err != nil {
				return mcp.CallResult{}, err
			}
			action, err := clawMCPArgString(args, "action")
			if err != nil {
				return mcp.CallResult{}, err
			}
			chatroomID := clawMCPArgOptionalString(args, "chatroomId")
			discussionID := clawMCPArgOptionalString(args, "discussionId")
			if chatroomID == "" && discussionID == "" {
				return mcp.CallResult{}, mcp.Errorf("invalid_arguments", "chatroomId 与 discussionId 至少提供一个")
			}

			// 成员资格：给 discussionId 时先解析出房间再校验，否则直接校验房间。
			subject := chatroomID
			if subject == "" {
				repo, repoErr := h.clawMCPRepo()
				if repoErr != nil {
					return mcp.CallResult{}, repoErr
				}
				d, dErr := h.clawMCPLoadDiscussion(ctx, repo, discussionID, userID)
				if dErr != nil {
					return mcp.CallResult{}, dErr
				}
				subject = d.ChatroomID
			} else if err := h.clawMCPRequireRoom(ctx, chatroomID, userID); err != nil {
				return mcp.CallResult{}, err
			}

			var stateVersion *int
			if raw, ok := args["stateVersion"]; ok && raw != nil {
				value, vErr := clawMCPArgInt64(args, "stateVersion")
				if vErr != nil {
					return mcp.CallResult{}, vErr
				}
				version := int(value)
				stateVersion = &version
			}

			outcome, cErr := control.Lifecycle(ctx, userID, action, rongcloud.LifecycleRequest{
				ChatroomID:   chatroomID,
				DiscussionID: discussionID,
				Opinion:      clawMCPArgOptionalString(args, "opinion"),
				Content:      clawMCPArgOptionalString(args, "content"),
				Reason:       clawMCPArgOptionalString(args, "reason"),
				StateVersion: stateVersion,
			})
			if cErr != nil {
				return mcp.CallResult{}, mcp.Errorf("control_failed", "讨论控制失败：%v", cErr)
			}
			return clawMCPControlResult("control_discussion:"+action, userID, subject, outcome)
		},
	}
}

// clawMCPArgOptionalString 取可选的字符串参数（缺省/类型不符都当空）。
func clawMCPArgOptionalString(args map[string]any, key string) string {
	raw, ok := args[key]
	if !ok || raw == nil {
		return ""
	}
	value, ok := raw.(string)
	if !ok {
		return ""
	}
	return value
}
