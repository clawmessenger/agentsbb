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
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/integrations/rongcloud"
)

const clawAdminOpsChatMaxTextRunes = 4000

// clawAdminOpsChatContext 是抽屉头部那一排「这台节点现在什么状态」的事实来源。
// 名称/版本/机器名全部复用节点列表与详情页的助手，避免运维面板自己另算一套。
type clawAdminOpsChatContext struct {
	NodeID         string `json:"node_id"`
	Name           string `json:"name"`
	NodeType       string `json:"node_type"`
	Online         bool   `json:"online"`
	ExeVersion     string `json:"exe_version"`
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
	requestID, code := h.OpsChat.Start(r.Context(), rec.NodeID, ctx.OpsPeerID, text)
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
