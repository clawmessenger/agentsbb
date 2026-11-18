package rongcloud

import "encoding/json"

func encodeTextContent(text string) string {
	b, _ := json.Marshal(textContent{Content: text})
	return string(b)
}

// encodeOpsTextContent 是运维对话私聊的信封：设备端 CLI 的私聊入口解析
// `{content, opsAgent}`（见 agentsbb-cli ops-scope.ts），opsAgent 是「用户从
// 哪个智能体的运维面板进来」的入口提示 —— 设备端靠它做两件事：把【运维对象】
// 钉进本轮提示词，以及把会话键按「对端 + 入口 agent」分桶（运维会话按 agent
// 隔离，不再同机共享一条）。opsAgent 为空时等价于 encodeTextContent。
func encodeOpsTextContent(text, opsAgent string) string {
	b, _ := json.Marshal(opsTextContent{Content: text, OpsAgent: opsAgent})
	return string(b)
}
