package mcp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// DefaultSessionTTL 是 MCP 会话（Mcp-Session-Id）的空闲存活时间。滑动续期：
// 每次请求刷新。30 分钟足够覆盖一次对话，又不会让失效会话长期占内存。
const DefaultSessionTTL = 30 * time.Minute

// Server 是 MCP 协议层实例：持有工具表与会话表，无数据库依赖。
type Server struct {
	name    string
	version string

	tools  map[string]*Tool
	order  []string
	ttl    time.Duration
	now    func() time.Time
	mu      sync.Mutex
	session map[string]*session
}

type session struct {
	userID   string
	lastSeen time.Time
}

// NewServer 构造协议层。tools 按注册顺序出现在 tools/list 里。
func NewServer(name, version string, tools ...*Tool) *Server {
	s := &Server{
		name:    name,
		version: version,
		tools:   make(map[string]*Tool, len(tools)),
		order:   make([]string, 0, len(tools)),
		ttl:     DefaultSessionTTL,
		now:     time.Now,
		session: make(map[string]*session),
	}
	for _, t := range tools {
		if t == nil || t.Name == "" || t.Handler == nil {
			continue
		}
		if _, dup := s.tools[t.Name]; dup {
			continue
		}
		s.tools[t.Name] = t
		s.order = append(s.order, t.Name)
	}
	return s
}

// ServerInfo 是 initialize 回包里的 serverInfo。
func (s *Server) ServerInfo() map[string]any {
	return map[string]any{"name": s.name, "version": s.version}
}

// ToolNames 返回注册顺序的工具名（测试与 tools/list 共用同一来源）。
func (s *Server) ToolNames() []string {
	out := make([]string, len(s.order))
	copy(out, s.order)
	return out
}

// Outcome 是 Handle 的结果，HTTP 层只负责把它写到响应里。
type Outcome struct {
	Status    int
	Body      []byte
	SessionID string // initialize 时新签发的会话 id
	NoContent bool   // 通知类消息：202，空 body
}

// Handle 处理一条 JSON-RPC 消息。
//
// userID 来自 HTTP 层已完成的 Bearer 鉴权，是本请求的**可信身份**；
// sessionID 来自 Mcp-Session-Id 头（可空 = 无状态调用）。
func (s *Server) Handle(ctx context.Context, userID, sessionID string, body []byte) Outcome {
	var req Request
	if err := json.Unmarshal(body, &req); err != nil {
		return errorOutcome(nil, CodeParseError, "invalid JSON", nil)
	}
	if req.JSONRPC != "" && req.JSONRPC != "2.0" {
		return errorOutcome(req.ID, CodeInvalidRequest, "jsonrpc must be \"2.0\"", nil)
	}
	if req.Method == "" {
		return errorOutcome(req.ID, CodeInvalidRequest, "method is required", nil)
	}
	// 批次（JSON-RPC array）在 Streamable HTTP 下已被 2025-06-18 移除，明确拒绝，
	// 避免客户端误以为我们支持后拿到更难懂的解析错误。
	if len(body) > 0 && body[0] == '[' {
		return errorOutcome(req.ID, CodeInvalidRequest, "batch requests are not supported", nil)
	}

	switch req.Method {
	case "initialize":
		return s.handleInitialize(ctx, userID, req)
	case "ping":
		if blocked, ok := s.guardSession(userID, sessionID, req.ID); !ok {
			return blocked
		}
		return resultOutcome(req.ID, map[string]any{})
	case "tools/list":
		if blocked, ok := s.guardSession(userID, sessionID, req.ID); !ok {
			return blocked
		}
		return s.handleToolsList(req)
	case "tools/call":
		if blocked, ok := s.guardSession(userID, sessionID, req.ID); !ok {
			return blocked
		}
		return s.handleToolsCall(ctx, userID, req)
	}

	// 通知（notifications/initialized、notifications/cancelled 等）按规范不回包。
	if req.IsNotification() {
		return Outcome{Status: http.StatusAccepted, NoContent: true}
	}
	return errorOutcome(req.ID, CodeMethodNotFound, "method not found: "+req.Method, nil)
}

func (s *Server) handleInitialize(ctx context.Context, userID string, req Request) Outcome {
	var params struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	_ = json.Unmarshal(req.Params, &params)

	version := ProtocolVersion20250618
	if _, ok := supportedProtocolVersions[params.ProtocolVersion]; ok {
		version = params.ProtocolVersion
	}

	id := s.newSessionID()
	s.mu.Lock()
	s.session[id] = &session{userID: userID, lastSeen: s.now()}
	s.pruneLocked()
	s.mu.Unlock()

	out := resultOutcome(req.ID, map[string]any{
		"protocolVersion": version,
		"capabilities": map[string]any{
			"tools": map[string]any{"listChanged": false},
		},
		"serverInfo": s.ServerInfo(),
		"instructions": "agentsbb（虾说）MCP：查询与驱动多 agent 圆桌讨论。" +
			"先用 list_chatrooms 找到可操作的聊天室，再 list_discussions / start_discussion。" +
			"状态机：configuring → planning → running → summarizing → awaiting_user → synthesizing → completed，任意阶段可转 cancelled/failed。",
	})
	out.SessionID = id
	return out
}

func (s *Server) handleToolsList(req Request) Outcome {
	tools := make([]map[string]any, 0, len(s.order))
	for _, name := range s.order {
		t := s.tools[name]
		schema := t.InputSchema
		if schema == nil {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		tools = append(tools, map[string]any{
			"name":        t.Name,
			"description": t.Description,
			"inputSchema": schema,
		})
	}
	return resultOutcome(req.ID, map[string]any{"tools": tools})
}

func (s *Server) handleToolsCall(ctx context.Context, userID string, req Request) Outcome {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Name == "" {
		return errorOutcome(req.ID, CodeInvalidParams, "params.name is required", nil)
	}
	tool, ok := s.tools[params.Name]
	if !ok {
		return errorOutcome(req.ID, CodeInvalidParams, "unknown tool: "+params.Name, nil)
	}

	args := map[string]any{}
	if len(params.Arguments) > 0 && string(params.Arguments) != "null" {
		if err := json.Unmarshal(params.Arguments, &args); err != nil {
			return errorOutcome(req.ID, CodeInvalidParams, "arguments must be a JSON object", nil)
		}
	}

	ctx = WithUserID(ctx, userID)
	result, err := tool.Handler(ctx, args)
	if err != nil {
		return resultOutcome(req.ID, toolErrorResult(err))
	}
	if len(result.Content) == 0 && result.StructuredContent != nil {
		if encoded, mErr := json.Marshal(result.StructuredContent); mErr == nil {
			result.Content = []Content{{Type: "text", Text: string(encoded)}}
		}
	}
	return resultOutcome(req.ID, result)
}

// toolErrorResult 把工具错误包成 IsError 结果（MCP 惯例），并尽量附结构化 code。
func toolErrorResult(err error) CallResult {
	code := "internal_error"
	message := err.Error()
	if te, ok := err.(*ToolError); ok {
		code = te.Code
		message = te.Message
	}
	payload, _ := json.Marshal(map[string]string{"code": code, "message": message})
	return CallResult{
		IsError: true,
		Content: []Content{{Type: "text", Text: string(payload)}},
		StructuredContent: map[string]string{
			"code":    code,
			"message": message,
		},
	}
}

// guardSession 校验会话并给出可直接返回的结果。
//
// ok=true 表示可继续；ok=false 时 blocked 是要写回的响应：
//   - 会话不存在/过期 → HTTP 404（客户端重新 initialize）
//   - 会话属于别的用户 → HTTP 403（身份不可跨会话复用）
//   - 没带会话头 → 放行（无状态兼容）
func (s *Server) guardSession(userID, sessionID string, id json.RawMessage) (blocked Outcome, ok bool) {
	if sessionID == "" {
		return Outcome{}, true
	}
	s.mu.Lock()
	sess, exists := s.session[sessionID]
	if !exists {
		s.mu.Unlock()
		return staleSessionOutcome(id), false
	}
	if s.now().Sub(sess.lastSeen) > s.ttl {
		delete(s.session, sessionID)
		s.mu.Unlock()
		return staleSessionOutcome(id), false
	}
	if sess.userID != userID {
		s.mu.Unlock()
		return foreignSessionOutcome(id), false
	}
	sess.lastSeen = s.now()
	s.mu.Unlock()
	return Outcome{}, true
}

// Terminate 处理 DELETE /mcp：客户端显式结束会话。
func (s *Server) Terminate(sessionID string) {
	if sessionID == "" {
		return
	}
	s.mu.Lock()
	delete(s.session, sessionID)
	s.mu.Unlock()
}

func (s *Server) newSessionID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return hex.EncodeToString([]byte(time.Now().String()))
	}
	return hex.EncodeToString(buf[:])
}

// pruneLocked 清理过期会话（调用方持锁）。会话表天然很小，线性扫即可。
func (s *Server) pruneLocked() {
	cutoff := s.now().Add(-s.ttl)
	for id, sess := range s.session {
		if sess.lastSeen.Before(cutoff) {
			delete(s.session, id)
		}
	}
}

func resultOutcome(id json.RawMessage, result any) Outcome {
	body, _ := json.Marshal(Response{JSONRPC: "2.0", ID: id, Result: result})
	return Outcome{Status: http.StatusOK, Body: body}
}

func errorOutcome(id json.RawMessage, code int, message string, data any) Outcome {
	body, _ := json.Marshal(Response{JSONRPC: "2.0", ID: id, Error: &RPCError{Code: code, Message: message, Data: data}})
	return Outcome{Status: http.StatusOK, Body: body}
}

// staleSessionOutcome 是「会话不存在/过期」：MCP 规范要求 HTTP 404，
// 客户端看到 404 就重新 initialize。
func staleSessionOutcome(id json.RawMessage) Outcome {
	body, _ := json.Marshal(Response{JSONRPC: "2.0", ID: id, Error: &RPCError{
		Code:    CodeInvalidRequest,
		Message: "session not found or expired",
	}})
	return Outcome{Status: http.StatusNotFound, Body: body}
}

// foreignSessionOutcome 是「会话属于另一个用户」：HTTP 403，不做任何降级 ——
// 复用别人的 Mcp-Session-Id 必须失败。
func foreignSessionOutcome(id json.RawMessage) Outcome {
	body, _ := json.Marshal(Response{JSONRPC: "2.0", ID: id, Error: &RPCError{
		Code:    CodeInvalidRequest,
		Message: "session belongs to another user",
	}})
	return Outcome{Status: http.StatusForbidden, Body: body}
}

// UnauthorizedBody 是 HTTP 401 时回的最小 JSON-RPC 错误体，便于客户端日志定位。
func UnauthorizedBody(message string) []byte {
	body, _ := json.Marshal(Response{JSONRPC: "2.0", Error: &RPCError{Code: CodeInvalidRequest, Message: message}})
	return body
}
