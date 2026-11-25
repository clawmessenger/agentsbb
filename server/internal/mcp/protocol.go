// Package mcp 实现 agentsbb 对外暴露的 MCP（Model Context Protocol）服务端协议层。
//
// 只做协议本身：JSON-RPC 2.0 编解码、initialize 握手、tools/list、tools/call、
// 会话生命周期与错误码映射。**不 import 数据库、不 import handler** —— 工具由
// 调用方（internal/handler/claw_mcp*.go）注入，这样协议层可以脱离数据库单测。
//
// 传输面刻意收窄：Streamable HTTP（2025-03-26 及以后）的「纯 JSON 响应」模式，
// 不做 SSE 服务端推送、不做 resources/prompts/sampling。依据见
// docs/方案与报告/方案-MCP开放接口-20261124.md §3。
package mcp

import (
	"context"
	"encoding/json"
	"fmt"
)

// JSON-RPC 2.0 错误码（MCP 沿用同一套）。
const (
	CodeParseError     = -32700
	CodeInvalidRequest = -32600
	CodeMethodNotFound = -32601
	CodeInvalidParams  = -32602
	CodeInternalError  = -32603
)

// 支持的协议版本，新的在前。initialize 时按客户端请求协商；不认识就回我们的首选。
const (
	ProtocolVersion20250618 = "2025-06-18"
	ProtocolVersion20250326 = "2025-03-26"
	ProtocolVersion20241105 = "2024-11-05"
)

// supportedProtocolVersions 是协商集合。MCP 要求服务端在客户端版本不认识时
// 回自己支持的最新版本，客户端自行决定是否继续。
var supportedProtocolVersions = map[string]struct{}{
	ProtocolVersion20250618: {},
	ProtocolVersion20250326: {},
	ProtocolVersion20241105: {},
}

// Request 是一条 JSON-RPC 请求。ID 为 nil 表示通知（notification），按规范不回包。
type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// IsNotification reports whether the message expects no response.
func (r Request) IsNotification() bool {
	return len(r.ID) == 0
}

// Response 是一条 JSON-RPC 响应。Result 与 Error 互斥。
type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// RPCError 是协议级错误（未知方法、参数不合法、解析失败）。
// 业务失败不进这里 —— 按 MCP 惯例包成 CallResult.IsError。
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("mcp: %d %s", e.Code, e.Message) }

// Content 是工具结果的内容块。第一期只用 text（JSON 字符串）。
type Content struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

// CallResult 是 tools/call 的成功结果壳。
//
// IsError=true 表示「工具执行失败但调用本身成功」（MCP 惯例）：调用方模型能读到
// 错误文案继续决策，而不会被协议错误打断。StructuredContent 同时下发机器可读
// 结构（新版客户端会用，旧客户端只读 content）。
type CallResult struct {
	Content           []Content `json:"content"`
	IsError           bool      `json:"isError,omitempty"`
	StructuredContent any       `json:"structuredContent,omitempty"`
}

// Tool 是一个可调用工具。InputSchema 是 JSON Schema（tools/list 原样下发）。
type Tool struct {
	Name        string
	Description string
	InputSchema map[string]any
	Handler     func(ctx context.Context, args map[string]any) (CallResult, error)
}

// ToolError 是工具业务错误：Code 给调用方程序化判断（如 not_chatroom_member），
// Message 给人看。Server 会把它包成 IsError=true 的 CallResult。
type ToolError struct {
	Code    string
	Message string
}

func (e *ToolError) Error() string { return e.Code + ": " + e.Message }

// Errorf 构造一个带错误码的工具错误。
func Errorf(code, format string, args ...any) *ToolError {
	return &ToolError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// userIDKey 是注入工具 ctx 的用户身份键。工具实现只能从 ctx 取身份，
// 不从入参取 —— 防止模型通过参数伪造他人身份。
type userIDKey struct{}

// WithUserID 把已认证用户放进 ctx。
func WithUserID(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, userIDKey{}, userID)
}

// UserID 取当前调用者（未认证时为空串，工具应直接报错）。
func UserID(ctx context.Context) string {
	id, _ := ctx.Value(userIDKey{}).(string)
	return id
}
