package rongcloud

// asr_voice_gate.go 把「语音转文字开关」接进融云命令通道的转写路径。
//
// 真实的 ASR 转写消费链路：Web（sendSystemRequest('ai','recognizeVoice')）与
// 小程序（aiService.recognizeVoice）都经融云 command 消息打到 systemHandler
// 的 service=ai 分支。后台开关关闭时，转写请求在 ai/recognizeVoice 入口被
// 以 4501 asr_disabled 明确拒绝 —— 「关闭 = 没有这个功能」在服务端也成立，
// 而不只是前端藏入口。
//
// 闸门本身不在这个包里实现 DB 读取（system_config 行的 fail-closed 读取在
// handler 包的 loadAsrConfig/asrGate），这里只定义**回包契约**：
//   - code 恒为 4501（业务码，稳定、有语义；禁止 500 表达业务状态，设计 2.6）；
//   - message 恒为「语音转文字功能未开启」（客户端只判 code 不解析 message）。
//
// 回包经 replyErr：WebEnvelope 命令回 web 形态（{status:"error", code, message}，
// 客户端 handleSystemResponse 抛 code=4501 的 Error）；设备信封回
// {ok:false, error}。两端各自的「收到即报错」语义不变，不产生 60s 白等超时。

const (
	// AsrDisabledCommandCode 是 ASR 依赖路径统一业务码（4501 asr_disabled）。
	// 与 handler 包的 asrCodeDisabled 数值一致；本包不 import handler，
	// 常量在此重复声明并测试钉住。
	AsrDisabledCommandCode = 4501

	// AsrDisabledCommandMessage 是 4501 的用户可读文案。
	AsrDisabledCommandMessage = "语音转文字功能未开启"
)
