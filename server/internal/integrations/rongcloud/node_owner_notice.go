package rongcloud

// node_owner_notice.go 负责「换绑后通知原账号」。
//
// 背景：一个 agent 只有一个拥有者。第二个账号确认「解绑并改绑」后，服务端撤销
// 原账号到 agent 的好友边、清掉归属投影 —— 对原账号来说，这个 agent 会从设备
// 列表里静默消失。用户看不到任何解释，只会觉得「我的智能体丢了」。所以在换绑
// 成功后补一条私聊，把「现在归谁」说清楚。

import (
	"context"
	"fmt"
	"strings"
)

// notifyNodeRebound 在换绑完成后给原拥有者发一条普通文本私聊。
//
// 发件人刻意选 agent 自己的融云账号，而不是平台系统账号（claw-system）：
// C 端会话列表按对端解析昵称/头像，agent 是用户原本就认识的会话，消息会追加
// 在他和设备的那条聊天里；系统账号在 C 端没有会话条目，消息会落进一个没有
// 标题的陌生人会话，等于没通知。
//
// 整条链路 best-effort：此时归属已经改完并落库，通知失败只记日志，绝不回滚。
func (s *NodeService) notifyNodeRebound(ctx context.Context, nodeRCID, oldOwner, newOwner string) {
	nodeRCID = strings.TrimSpace(nodeRCID)
	oldOwner = strings.TrimSpace(oldOwner)
	newOwner = strings.TrimSpace(newOwner)
	if nodeRCID == "" || oldOwner == "" || oldOwner == newOwner || s.client == nil {
		return
	}
	agentName := s.agentDisplayName(ctx, nodeRCID)
	// ownerDisplay 的昵称优先 / 账号兜底已经覆盖「查不到」的情况，这里只再
	// 补一道：两者都空时用融云 id，宁可难看也不能让用户不知道是谁。
	newOwnerLabel, newOwnerAccount := s.ownerDisplay(ctx, newOwner)
	newOwnerLabel = strings.TrimSpace(newOwnerLabel)
	if newOwnerLabel == "" {
		newOwnerLabel = strings.TrimSpace(newOwnerAccount)
	}
	if newOwnerLabel == "" {
		newOwnerLabel = newOwner
	}
	text := fmt.Sprintf(
		"【虾说】智能体 %s 已被账号 %s 绑定，你名下不再拥有该智能体。如仍需使用，请在设备列表中重新绑定。",
		agentName, newOwnerLabel)
	if _, err := s.client.sendPrivateMessage(ctx, nodeRCID, oldOwner, objectNameText, encodeTextContent(text)); err != nil {
		s.log().Warn("rongcloud: notify old owner on rebind failed",
			"node_rc", nodeRCID, "old_owner", oldOwner, "new_owner", newOwner, "error", err)
		return
	}
	s.log().Info("rongcloud: old owner notified about rebind",
		"node_rc", nodeRCID, "old_owner", oldOwner, "new_owner", newOwner)
}

// agentDisplayName 取 agent 对外展示名。rongcloud_node 没有 name 列，对外展示名
// 就是 ai_type（见 DefaultAgentNodeName）；查不到时退回融云 id。
func (s *NodeService) agentDisplayName(ctx context.Context, nodeRCID string) string {
	if s.queries != nil {
		if node, err := s.queries.GetRongCloudNodeByRongCloudUserID(ctx, nodeRCID); err == nil {
			if name := strings.TrimSpace(node.AiType.String); name != "" {
				return name
			}
		}
	}
	return nodeRCID
}
