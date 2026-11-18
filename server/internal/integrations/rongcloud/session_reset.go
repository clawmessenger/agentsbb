package rongcloud

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

// 「新开会话」指令：群聊 / 讨论组里用户主动要求这段对话从新会话重新开始。
//
// 为什么必须由服务端识别：群聊和讨论组里，用户发的消息**不会**直接到 agent
// 的设备进程 —— 设备只收服务端按序派发的 your_turn（私聊命令），正文由服务端
// 拼进 role_prompt。所以用户那句「新开会话」在设备侧根本没有入口，只能在这里
// 拦下来：清中继自己的历史 + 给每个成员节点下发重置指令。
//
// 私聊不走这条链路（设备直接收到用户原话，见 CLI 的 session-command.ts）。
// 两侧的匹配规则必须**逐字同源** —— 一边认一边不认，用户就会遇到「私聊里好使、
// 群里没反应」。
var newSessionCommandRe = regexp.MustCompile(
	`^(?:(?:新开|重开|另开|重新开|新建|开启|开始)(?:一个|个)?新?(?:会话|对话|聊天)|[\/／](?i:new|reset|newchat|newsession)|[\/／](?:新会话|新开会话|重置会话))$`,
)

// newSessionCommandMaxLen 与 CLI 侧一致：超过这个长度就不是命令，是正文。
const newSessionCommandMaxLen = 12

// isNewSessionCommandText 判定一条用户消息是不是「新开会话」指令。
func isNewSessionCommandText(text string) bool {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" || len([]rune(trimmed)) > newSessionCommandMaxLen {
		return false
	}
	return newSessionCommandRe.MatchString(trimmed)
}

// resetRoomSessions 把某个群/聊天室的会话「掰断」：
//
//  1. 丢掉中继的滚动历史（h.rounds）—— 否则下一条消息的提示词里仍然带着旧话题；
//  2. 正在进行的那段中继标记 stopped 并丢弃排队消息 —— 让当前这位把话说完就收，
//     不会用旧上下文继续接龙；
//  3. 给每个成员节点私发 reset_session，让设备清掉自己的会话映射。
//
// 只清「映射」不清 agent 的会话文件：用户要的是「从现在开始重新聊」，不是销毁历史
// （设备侧同理，见 CLI TurnRunner.clearSession 的注释）。
func (h *chatroomRelayHub) resetRoomSessions(ctx context.Context, roomRCID, venue string, members []relayMember) commandResult {
	h.mu.Lock()
	delete(h.rounds, roomRCID)
	if s, ok := h.sessions[roomRCID]; ok && s != nil {
		s.stopped = true
		s.pending = nil
	}
	h.mu.Unlock()

	sent := 0
	for _, member := range members {
		if strings.TrimSpace(member.rcID) == "" {
			continue
		}
		if err := h.dispatchSessionReset(ctx, member, roomRCID, venue); err != nil {
			h.rt.logger.Warn("session reset: dispatch failed",
				"room", roomRCID, "member", member.rcID, "error", err)
			continue
		}
		sent++
	}
	h.rt.logger.Info("session reset: room history cleared",
		"room", roomRCID, "venue", venue, "agents", sent)
	return commandResult{code: 200, data: map[string]interface{}{
		"ok":     true,
		"reset":  true,
		"agents": sent,
	}}
}

// dispatchSessionReset 给单个成员节点私发「清掉这个会话 id 的续接记录」。
//
// 走的是和 your_turn 同一条私聊命令通道（service=discussion）：设备侧的
// handle 分支只认这个 service，另开一套协议就得两端同时发版才能生效。
// 不回包、不重试 —— 重置是幂等的，漏掉一个节点的后果只是那位还记着旧上下文，
// 下一轮它自己还能再被重置。
func (h *chatroomRelayHub) dispatchSessionReset(ctx context.Context, member relayMember, roomRCID, venue string) error {
	content, err := json.Marshal(map[string]interface{}{
		"request_id": "reset-" + uuid.NewString(),
		"service":    "discussion",
		"action":     "reset_session",
		"params": map[string]interface{}{
			// conversation_id 是设备的会话键尾巴（cm-<venue>-<id>），与
			// chatroom_id / group_id 同值：设备按「这个 id 下的所有形态」清。
			"conversation_id": roomRCID,
			"venue":           venue,
		},
	})
	if err != nil {
		return err
	}
	return h.rt.sendPrivateJSON(ctx, member.rcID, content)
}
