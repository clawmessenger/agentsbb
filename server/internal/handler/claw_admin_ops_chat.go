package handler

// 管理端「节点管理 → 运维对话」的 HTTP 层。
//
// 三个接口刻意做成「POST 投递 + GET 轮询」，不做长轮询：设备端一轮 agent 可能
// 要跑 120s，而站点 nginx 对 /api 的 proxy_read_timeout 是默认的 60s，同步等
// 回包一定会在设备答完之前被网关掐断，现场表现就是「明明节点在干活，页面报
// 504」。POST 只负责把消息放到融云线上，回包由 webhook 交给 OpsChatBroker，
// 页面再按 request_id 轮询终态。
//
// 权限收紧到 system:write：这条链路会以系统账号向设备私发一条消息，让设备上的
// agent 真的跑一轮（能读文件、能执行命令），比任何只读接口都危险。审计只记
// 节点 id / 对端 / 文本长度，**绝不记正文** —— 运维对话里经常直接贴配置片段。

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/integrations/rongcloud"
)

const clawAdminOpsChatMaxTextRunes = 4000

// clawAdminOpsChatContext 是抽屉头部那一排「这台节点现在什么状态」的事实来源。
// 名称/版本/机器名全部复用节点列表与详情页的助手，避免运维面板自己另算一套。
type clawAdminOpsChatContext struct {
	NodeID   string `json:"node_id"`
	Name     string `json:"name"`
	NodeType string `json:"node_type"`
	Online   bool   `json:"online"`

	ExeVersion string `json:"exe_version"`
	// agent CLI 版本是该节点智能体自己的（rongcloud_node_agent_cli，迁移 612），
	// 不是 agentsbb supervisor 的 exe_version；空 = 设备没探到或老 CLI 未上报。
	AgentCLIVersion string `json:"agent_cli_version,omitempty"`
	AgentCLIPath    string `json:"agent_cli_path,omitempty"`

	MachineName    string `json:"machine_name"`
	OpsPeerID      string `json:"ops_peer_id"`
	OpsPeerOnline  bool   `json:"ops_peer_online"`
	HasOpsPeer     bool   `json:"has_ops_peer"`
	PeerKind       string `json:"peer_kind"`
	TimeoutSeconds int    `json:"timeout_seconds"`
}

func (h *Handler) ClawAdminOpsChatContext(w http.ResponseWriter, r *http.Request) {
	if h.requireClawAdmin("system:write", w, r) == nil {
		return
	}
	rec, found, err := h.clawAdminNodeByPathID(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		clawAdminFail(w, 500, "获取设备失败")
		return
	}
	if !found {
		clawAdminFail(w, 404, "设备不存在")
		return
	}
	clawAdminOK(w, h.clawAdminOpsChatContextOf(r, rec))
}

func (h *Handler) ClawAdminOpsChatSend(w http.ResponseWriter, r *http.Request) {
	ident := h.requireClawAdmin("system:write", w, r)
	if ident == nil {
		return
	}
	var body struct {
		Text *string `json:"text"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		clawAdminFail(w, 400, "JSON object is required")
		return
	}
	text := ""
	if body.Text != nil {
		text = strings.TrimSpace(*body.Text)
	}
	if text == "" || len([]rune(text)) > clawAdminOpsChatMaxTextRunes {
		clawAdminFail(w, 400, "text is required and must be at most 4000 characters")
		return
	}
	rec, found, err := h.clawAdminNodeByPathID(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		clawAdminFail(w, 500, "获取设备失败")
		return
	}
	if !found {
		clawAdminFail(w, 404, "设备不存在")
		return
	}
	if h.OpsChat == nil {
		clawAdminFail(w, 503, rongcloud.OpsChatCodeUnavailable)
		return
	}

	ctx := h.clawAdminOpsChatContextOf(r, rec)
	// 入口 agent = 该节点自己的 agent 键（ai_type，如 codearts/opencode）。
	// 设备端靠它把运维会话按 agent 分桶并注入【运维对象】：同机所有 agent
	// 共用同一个机器级 ops 对端，不带它的话所有面板共享一条会话（2026-11-18
	// 现场：codearts 与 opencode 的运维抽屉互相看见对方的诊断上下文）。
	// peer_kind=agent 的回落路径也带上：设备端按「对端+agent」分桶同样成立。
	requestID, code := h.OpsChat.Start(r.Context(), rec.NodeID, ctx.OpsPeerID, rec.AIType, text)
	if code != "" {
		status := http.StatusServiceUnavailable
		if code == rongcloud.OpsChatCodeBusy {
			status = http.StatusConflict
		}
		h.clawAdminAudit(r, ident, "ops_chat_send", "node", rec.NodeID, map[string]interface{}{
			"error_code":  code,
			"ops_peer_id": ctx.OpsPeerID,
			"text_runes":  len([]rune(text)),
		})
		clawAdminFail(w, status, code)
		return
	}
	h.clawAdminAudit(r, ident, "ops_chat_send", "node", rec.NodeID, map[string]interface{}{
		"request_id":  requestID,
		"ops_peer_id": ctx.OpsPeerID,
		"text_runes":  len([]rune(text)),
	})
	clawAdminOK(w, map[string]interface{}{
		"request_id":  requestID,
		"node_id":     rec.NodeID,
		"ops_peer_id": ctx.OpsPeerID,
		"status":      "pending",
	})
}

func (h *Handler) ClawAdminOpsChatResult(w http.ResponseWriter, r *http.Request) {
	if h.requireClawAdmin("system:write", w, r) == nil {
		return
	}
	if h.OpsChat == nil {
		clawAdminFail(w, 503, rongcloud.OpsChatCodeUnavailable)
		return
	}
	rec, found, err := h.clawAdminNodeByPathID(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		clawAdminFail(w, 500, "获取设备失败")
		return
	}
	if !found {
		clawAdminFail(w, 404, "设备不存在")
		return
	}
	result, ok := h.OpsChat.Get(chi.URLParam(r, "request_id"))
	// 顺带挡住「拿别的节点的 request_id 来这个 URL 查」：request_id 是随机 UUID，
	// 本身不算秘密，但不该让一个节点的运维回复被另一个节点的管理员读到。
	if !ok || result.NodeID != rec.NodeID {
		clawAdminFail(w, 404, "运维请求不存在或已过期")
		return
	}
	clawAdminOK(w, result)
}

// clawAdminOpsChatHistoryItem 是管理端抽屉回看的一轮问答。
// elapsed_ms / id 用数字即可（JS 安全整数范围内），时间走 RFC3339 字符串。
type clawAdminOpsChatHistoryItem struct {
	ID         int64      `json:"id"`
	RequestID  string     `json:"request_id"`
	Status     string     `json:"status"`
	Question   string     `json:"question"`
	Reply      string     `json:"reply"`
	ErrorCode  string     `json:"error_code,omitempty"`
	ElapsedMs  int64      `json:"elapsed_ms"`
	CreatedAt  time.Time  `json:"created_at"`
	SettledAt  *time.Time `json:"settled_at,omitempty"`
	OpsAgent   string     `json:"ops_agent,omitempty"`
	OpsPeerID  string     `json:"ops_peer_id,omitempty"`
}

// ClawAdminOpsChatHistoryRecorder 把结算后的问答写进历史表。
// 用 ON CONFLICT DO NOTHING 而不是 UPSERT：同一 request_id 只该有一份史实，
// 迟到的重复回包不能把已经落库的设备回复覆盖掉。
func (h *Handler) ClawAdminOpsChatHistoryRecorder() rongcloud.OpsChatRecorder {
	return func(ctx context.Context, rec rongcloud.OpsChatRecorded) error {
		if h.DB == nil {
			return nil
		}
		_, err := h.DB.Exec(ctx, `
			INSERT INTO claw_admin_ops_chat_history
				(node_id, request_id, ops_peer_id, question, reply, status, error_code, elapsed_ms, created_at, settled_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			ON CONFLICT (request_id) DO NOTHING`,
			rec.NodeID, rec.RequestID, rec.OpsPeerID, rec.Question, rec.Reply,
			rec.Status, rec.ErrorCode, rec.ElapsedMs, rec.CreatedAt, rec.SettledAt,
		)
		return err
	}
}

// ClawAdminOpsChatHistory 按节点分页返回历史（最新在前取 N 条，再翻转成时间正序）。
// before 是游标 id；has_more=true 表示还有更早的记录。
func (h *Handler) ClawAdminOpsChatHistory(w http.ResponseWriter, r *http.Request) {
	if h.requireClawAdmin("system:write", w, r) == nil {
		return
	}
	rec, found, err := h.clawAdminNodeByPathID(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		clawAdminFail(w, 500, "获取设备失败")
		return
	}
	if !found {
		clawAdminFail(w, 404, "设备不存在")
		return
	}
	if h.DB == nil {
		clawAdminFail(w, 503, rongcloud.OpsChatCodeUnavailable)
		return
	}

	limit := 50
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		n, convErr := strconv.Atoi(raw)
		if convErr != nil || n < 1 {
			clawAdminFail(w, 400, "limit must be a positive integer")
			return
		}
		if n > 100 {
			n = 100
		}
		limit = n
	}
	before := int64(0)
	if raw := strings.TrimSpace(r.URL.Query().Get("before")); raw != "" {
		n, convErr := strconv.ParseInt(raw, 10, 64)
		if convErr != nil || n < 1 {
			clawAdminFail(w, 400, "before must be a positive integer")
			return
		}
		before = n
	}

	rows, err := h.DB.Query(r.Context(), `
		SELECT id, request_id, status, question, reply, error_code, elapsed_ms, created_at, settled_at,
		       COALESCE(ops_agent, ''), COALESCE(ops_peer_id, '')
		FROM claw_admin_ops_chat_history
		WHERE node_id = $1 AND ($2 = 0 OR id < $2)
		ORDER BY id DESC LIMIT $3`, rec.NodeID, before, limit+1)
	if err != nil {
		clawAdminFail(w, 500, "读取运维对话历史失败")
		return
	}
	defer rows.Close()

	items := make([]clawAdminOpsChatHistoryItem, 0, limit)
	for rows.Next() {
		var item clawAdminOpsChatHistoryItem
		var settledAt *time.Time
		if err := rows.Scan(&item.ID, &item.RequestID, &item.Status, &item.Question, &item.Reply,
			&item.ErrorCode, &item.ElapsedMs, &item.CreatedAt, &settledAt, &item.OpsAgent, &item.OpsPeerID); err != nil {
			clawAdminFail(w, 500, "读取运维对话历史失败")
			return
		}
		item.SettledAt = settledAt
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		clawAdminFail(w, 500, "读取运维对话历史失败")
		return
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	// DESC 取最新 N 条后翻回正序，前端直接从上往下渲染就是时间线。
	for i, j := 0, len(items)-1; i < j; i, j = i+1, j-1 {
		items[i], items[j] = items[j], items[i]
	}
	clawAdminOK(w, map[string]interface{}{
		"items":    items,
		"has_more": hasMore,
	})
}

// clawAdminOpsChatContextOf 解析「这条运维消息该发给谁」。
//
// 优先同机的运维助手（ops 节点）：它是设备端专门留给运维会话的对端，不会撞
// agent 自己的私聊权限闸门。老设备/未绑定机器上没有 ops 节点时回落到 agent
// 节点自身，并把 peer_kind 标成 agent —— 前端据此提示「可能被权限闸门拒绝」，
// 不要让用户以为功能坏了。
func (h *Handler) clawAdminOpsChatContextOf(r *http.Request, rec clawAdminNodeRecord) clawAdminOpsChatContext {
	ctx := r.Context()
	out := clawAdminOpsChatContext{
		NodeID:         rec.NodeID,
		Name:           rec.NodeID,
		NodeType:       rec.AIType,
		OpsPeerID:      rec.RongcloudUserID,
		PeerKind:       "agent",
		TimeoutSeconds: rongcloud.OpsChatDefaultTimeoutSeconds,
	}

	names, _, _ := h.clawAdminNodeUserNames(ctx)
	if name := names[rec.RongcloudUserID]; name != "" {
		out.Name = name
	}
	if h.RongCloudNode != nil {
		out.Online = h.RongCloudNode.IsOnline(rec.ID)
	}
	out.OpsPeerOnline = out.Online

	// 版本/机器名与详情页同源：走 clawAdminAttachUpgrade 而不是自己查升级表，
	// 免得 machine_id 为空的旧机器在这里显示「-」、详情页却显示版本。
	allRecords, _ := h.clawAdminListNodeRecords(ctx)
	row := h.clawAdminAttachUpgrade(
		clawAdminNodeRow{}, rec, h.clawAdminNodeUpgrades(ctx),
		h.clawAdminMachineNames(allRecords, names),
	)
	out.ExeVersion = row.ExeVersion
	out.MachineName = row.MachineName

	// agent CLI 版本同样与详情页同源（rongcloud_node_agent_cli，迁移 612）：
	// helper 自身对 h.DB 为 nil / 表不存在都是安全降级（found=false），不报错。
	if cli, found := h.clawNodeAgentCLIByNode(ctx, rec.ID); found {
		out.AgentCLIVersion = cli.CLIVersion
		out.AgentCLIPath = cli.CLIPath
	}

	if h.RongCloudNode == nil || h.Queries == nil {
		return out
	}
	// OmStatusForNode 需要带 workspace_id 的完整节点行，clawAdminNodeRecord 是
	// 列表用的投影列、没有它，不能直接喂进去。
	node, err := h.Queries.GetRongCloudNodeByID(ctx, rec.ID)
	if err != nil {
		return out
	}
	omRC, omOnline, found, err := h.RongCloudNode.OmStatusForNode(ctx, node)
	if err != nil || !found || omRC == "" {
		return out
	}
	out.OpsPeerID = omRC
	out.OpsPeerOnline = omOnline
	out.HasOpsPeer = true
	out.PeerKind = "ops"
	return out
}
