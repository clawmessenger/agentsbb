package rongcloud

import (
	"encoding/json"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
)

// textContent is the JSON structure of a RC:TxtMsg content field.
type textContent struct {
	Content string `json:"content"`
}

// opsTextContent 是运维对话私聊的信封：在 textContent 上多带 opsAgent（入口
// 提示，见 encodeOpsTextContent）。设备端对未知字段宽容，老 CLI 读不到
// opsAgent 只是退回共享会话，不会报错。
type opsTextContent struct {
	Content  string `json:"content"`
	OpsAgent string `json:"opsAgent,omitempty"`
}

// isCommandMessage returns true if the objectName indicates a command message.
func isCommandMessage(objectName string) bool {
	return objectName == objectNameCommand
}

// normalizeInbound converts a RongCloud NormalizedMessage to a channel.InboundMessage.
// Returns ok=false for message types we don't handle (images, typing, etc.).
// The Raw field preserves the original content JSON for protocol-level parsing.
func normalizeInbound(msg NormalizedMessage) (channel.InboundMessage, bool) {
	chatType := channel.ChatTypeP2P
	if msg.ConversationType == "3" || msg.ConversationType == "4" {
		chatType = channel.ChatTypeGroup
	}

	// Determine receiver ID (toUserId with targetId fallback)
	recvID := msg.ToUserID
	if recvID == "" {
		recvID = msg.TargetID
	}

	inbound := channel.InboundMessage{
		MessageID: msg.MsgUID,
		EventID:   msg.MsgUID,
		Source: channel.Source{
			ChannelType: TypeRongCloud,
			ChatID:      recvID,
			ChatType:    chatType,
			SenderID:    msg.FromUserID,
		},
		Raw: json.RawMessage(msg.Content),
	}

	switch msg.ObjectName {
	case objectNameText:
		inbound.Type = channel.MsgTypeText
		var tc textContent
		if err := json.Unmarshal([]byte(msg.Content), &tc); err == nil {
			inbound.Text = tc.Content
		}
	case objectNameCommand:
		inbound.Type = channel.MsgTypeText
		inbound.CommandText = msg.Content
		inbound.SkipAgentRun = true
	case objectNameImage:
		inbound.Type = channel.MsgTypeImage
	default:
		return channel.InboundMessage{}, false
	}

	// P2P messages are always addressed to the bot (system node).
	// Group messages require explicit mention (not implemented in MVP).
	inbound.AddressedToBot = chatType == channel.ChatTypeP2P

	return inbound, true
}
