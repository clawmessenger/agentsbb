// MCP（Model Context Protocol）入站端点：POST /mcp。
//
// 这是「犇马 / SuperWagie 内嵌 opencode 调虾说」的通道。设计依据见
// docs/方案与报告/方案-MCP开放接口-20261124.md：
//
//   - 传输：Streamable HTTP 的纯 JSON 响应模式（客户端只收 SSE 时也回一条 SSE 帧）；
//   - 鉴权：Authorization: Bearer <rongcloud_token>，与 C 端扁平 REST 同源同权；
//   - 权限：工具内部复用 clawDiscussionRoomAccess / 讨论创建闸门，不另立模型；
//   - Origin：有 Origin 头时必须在白名单内（MULTICA_CLAW_MCP_ALLOWED_ORIGINS），
//     服务器对服务器调用通常没有 Origin，放行。
package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/internal/mcp"
)

const (
	// clawMCPMaxBodyBytes 限制单条 JSON-RPC 消息体积（超了直接 413）。
	clawMCPMaxBodyBytes = 1 << 20
	// clawMCPServerVersion 是 initialize 回包里的 serverInfo.version。
	// 不跟随二进制 commit：对调用方而言它是「工具契约版本」，不是构建号。
	clawMCPServerVersion = "2026.11"
)

// InitClawMCP 构造协议实例与限流器。必须在 Handler 依赖装配完成后调用
// （cmd/server/router.go 里紧接 handler.New 之后）；工具闭包引用 Handler 字段，
// 但只在调用时读取，所以早于融云/仓库装配也没问题。
//
// 不做 sync.Once 懒加载：Handler 会被按值拷贝（多个测试），带锁字段会触发
// vet 的 copylocks，这里用显式初始化换一个干净的零值。
func (h *Handler) InitClawMCP() {
	h.MCPServer = mcp.NewServer("agentsbb", clawMCPServerVersion, h.clawMCPTools()...)
	h.MCPLimiter = newClawMCPRateLimiter(clawMCPEnvInt("MULTICA_CLAW_MCP_RATE_PER_MIN", 60))
}

// ClawMCPPost 处理 JSON-RPC 请求。
func (h *Handler) ClawMCPPost(w http.ResponseWriter, r *http.Request) {
	if !clawMCPOriginAllowed(w, r) {
		return
	}
	userID, ok := h.clawMCPRequireUser(w, r)
	if !ok {
		return
	}
	if h.MCPServer == nil {
		// 生产路径由 router 初始化；走到这里说明装配漏了，明确 503 而不是空指针。
		clawMCPWriteError(w, http.StatusServiceUnavailable, "mcp not initialized")
		return
	}
	if h.MCPLimiter != nil && !h.MCPLimiter.allow(userID) {
		w.Header().Set("Retry-After", "60")
		clawMCPWriteError(w, http.StatusTooManyRequests, "rate limit exceeded")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, clawMCPMaxBodyBytes))
	if err != nil {
		clawMCPWriteError(w, http.StatusRequestEntityTooLarge, "request body too large")
		return
	}

	out := h.MCPServer.Handle(r.Context(), userID, r.Header.Get("Mcp-Session-Id"), body)
	clawMCPWriteOutcome(w, r, out)
}

// ClawMCPGet 是 SSE 服务端推送通道：本期不实现，明确 405（规范允许）。
func (h *Handler) ClawMCPGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Allow", "POST, DELETE")
	clawMCPWriteError(w, http.StatusMethodNotAllowed, "SSE stream is not supported; use POST")
}

// ClawMCPDelete 结束会话（客户端主动断开）。
func (h *Handler) ClawMCPDelete(w http.ResponseWriter, r *http.Request) {
	if !clawMCPOriginAllowed(w, r) {
		return
	}
	if _, ok := h.clawMCPRequireUser(w, r); !ok {
		return
	}
	if h.MCPServer != nil {
		h.MCPServer.Terminate(r.Header.Get("Mcp-Session-Id"))
	}
	w.WriteHeader(http.StatusOK)
}

// clawMCPRequireUser 是 MCP 专用鉴权：401 时回 WWW-Authenticate，且响应体是
// JSON-RPC 错误形状（不是 clawJSON 信封）—— MCP 客户端只认协议格式。
func (h *Handler) clawMCPRequireUser(w http.ResponseWriter, r *http.Request) (string, bool) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		clawMCPWriteAuthFailure(w, "missing bearer token")
		return "", false
	}
	token := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	if token == "" {
		clawMCPWriteAuthFailure(w, "empty bearer token")
		return "", false
	}
	userID, err := h.clawUserIDByToken(r.Context(), token)
	if err != nil {
		clawMCPWriteAuthFailure(w, "invalid or expired token")
		return "", false
	}
	return userID, true
}

func clawMCPWriteAuthFailure(w http.ResponseWriter, message string) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="agentsbb", error="invalid_token"`)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = w.Write(mcp.UnauthorizedBody(message))
}

// clawMCPWriteError 是传输层错误（401 以外的 4xx）：回最小 JSON，不带 clawJSON 信封。
func clawMCPWriteError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	payload, _ := json.Marshal(map[string]string{"error": message})
	_, _ = w.Write(payload)
}

// clawMCPWriteOutcome 把协议层结果写到 HTTP 响应。
//
// 客户端 Accept 只要 SSE（不含 application/json）时，把单条响应包成一帧
// `event: message` —— 部分客户端（含某些版本的 mcp-remote）无条件要求 SSE。
func clawMCPWriteOutcome(w http.ResponseWriter, r *http.Request, out mcp.Outcome) {
	if out.SessionID != "" {
		w.Header().Set("Mcp-Session-Id", out.SessionID)
	}
	w.Header().Set("Cache-Control", "no-store")
	if out.NoContent {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	if out.Status == http.StatusOK && clawMCPWantsEventStream(r) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintf(w, "event: message\ndata: %s\n\n", out.Body)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(out.Status)
	_, _ = w.Write(out.Body)
}

func clawMCPWantsEventStream(r *http.Request) bool {
	accept := strings.ToLower(r.Header.Get("Accept"))
	return strings.Contains(accept, "text/event-stream") && !strings.Contains(accept, "application/json")
}

// clawMCPOriginAllowed 防 DNS rebinding（MCP 规范要求）：
// 没有 Origin 的服务器对服务器调用放行；有 Origin 必须在白名单。
func clawMCPOriginAllowed(w http.ResponseWriter, r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	for _, allowed := range clawMCPAllowedOrigins() {
		if strings.EqualFold(allowed, origin) {
			return true
		}
	}
	clawMCPWriteError(w, http.StatusForbidden, "origin not allowed")
	return false
}

func clawMCPAllowedOrigins() []string {
	raw := strings.TrimSpace(os.Getenv("MULTICA_CLAW_MCP_ALLOWED_ORIGINS"))
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// ---- 限流 ----------------------------------------------------------------

// clawMCPRateLimiter 是进程内按用户 token bucket。单实例部署够用；
// 多实例时再换 Redis（与插件 API 的限流同理）。
type clawMCPRateLimiter struct {
	mu        sync.Mutex
	perMinute int
	buckets   map[string]*clawMCPBucket
	now       func() time.Time
}

type clawMCPBucket struct {
	tokens float64
	last   time.Time
}

func newClawMCPRateLimiter(perMinute int) *clawMCPRateLimiter {
	return &clawMCPRateLimiter{
		perMinute: perMinute,
		buckets:   make(map[string]*clawMCPBucket),
		now:       time.Now,
	}
}

// allow 消耗一个令牌。perMinute <= 0 视为关闭限流。
func (l *clawMCPRateLimiter) allow(userID string) bool {
	if l == nil || l.perMinute <= 0 || userID == "" {
		return true
	}
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.buckets[userID]
	if !ok {
		b = &clawMCPBucket{tokens: float64(l.perMinute), last: now}
		l.buckets[userID] = b
	}
	elapsed := now.Sub(b.last).Seconds()
	if elapsed > 0 {
		b.tokens += elapsed * float64(l.perMinute) / 60.0
		if b.tokens > float64(l.perMinute) {
			b.tokens = float64(l.perMinute)
		}
		b.last = now
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	// 会话表很小，顺手清理长期不活跃的桶（每 1024 次调用一次，避免 O(n) 摊薄）。
	if len(l.buckets) > 4096 {
		cutoff := now.Add(-10 * time.Minute)
		for id, bucket := range l.buckets {
			if bucket.last.Before(cutoff) {
				delete(l.buckets, id)
			}
		}
	}
	return true
}

func clawMCPEnvInt(name string, def int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return def
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	return v
}
