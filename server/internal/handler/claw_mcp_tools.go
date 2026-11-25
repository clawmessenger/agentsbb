// MCP 工具实现（第一期：查询类 6 个）。
//
// 所有工具都从 ctx 取已认证用户（mcp.UserID），入参里没有 userId —— 模型无法
// 伪造他人身份。权限复用 C 端同一套检查：
//   - 读讨论类：clawDiscussionRoomAccess（成员或 owner），失败一律按「资源不存在」
//     处理，不泄露聊天室是否存在；
//   - 列表类：ListRongCloudChatroomViewsForUser（owner 或启用成员）。
package handler

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/rongcloud"
	"github.com/multica-ai/multica/server/internal/mcp"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const (
	clawMCPChatroomListLimit = 200
	clawMCPDocumentByteLimit = 64 * 1024
)

// clawMCPTools 返回注册给协议层的工具表（顺序即 tools/list 顺序）。
func (h *Handler) clawMCPTools() []*mcp.Tool {
	return []*mcp.Tool{
		h.clawMCPToolListChatrooms(),
		h.clawMCPToolListDiscussions(),
		h.clawMCPToolGetDiscussion(),
		h.clawMCPToolGetDiscussionEvents(),
		h.clawMCPToolListRoundDocuments(),
		h.clawMCPToolGetRoundDocument(),
	}
}

// ---- list_chatrooms ------------------------------------------------------

func (h *Handler) clawMCPToolListChatrooms() *mcp.Tool {
	return &mcp.Tool{
		Name: "list_chatrooms",
		Description: "列出当前用户在 agentsbb（虾说）里可见的聊天室/讨论组，" +
			"包含自己创建的（owner）与被加入的（启用成员）。讨论（圆桌）都挂在某个 chatroom 下，" +
			"所以这是操作其它工具的第一步。返回项含 chatroomId、name、hostNodeId（主持设备，空=未配置）。",
		InputSchema: map[string]any{
			"type":                 "object",
			"properties":           map[string]any{},
			"additionalProperties": false,
		},
		Handler: func(ctx context.Context, _ map[string]any) (mcp.CallResult, error) {
			userID := mcp.UserID(ctx)
			if userID == "" {
				return mcp.CallResult{}, mcp.Errorf("unauthenticated", "缺少调用者身份")
			}
			if h.Queries == nil {
				return mcp.CallResult{}, mcp.Errorf("service_unavailable", "数据库未初始化")
			}

			params := db.ListRongCloudChatroomViewsForUserParams{
				MemberID: pgtype.Text{String: userID, Valid: userID != ""},
			}
			// owner 用内部 UUID 比较；没有镜像行时置空（SQL 里 = NULL 不命中，成员条件仍生效）。
			if actor, err := h.Queries.GetRongCloudUserByRongCloudID(ctx, userID); err == nil {
				params.OwnerUserID = actor.ID
			}

			rooms, err := h.Queries.ListRongCloudChatroomViewsForUser(ctx, params)
			if err != nil {
				return mcp.CallResult{}, mcp.Errorf("query_failed", "获取聊天室列表失败")
			}

			total := len(rooms)
			truncated := false
			if total > clawMCPChatroomListLimit {
				rooms = rooms[:clawMCPChatroomListLimit]
				truncated = true
			}
			items := make([]map[string]any, 0, len(rooms))
			for _, r := range rooms {
				item := map[string]any{
					"chatroomId":       r.RongcloudChatroomID,
					"name":             r.Name,
					"portraitUri":      r.PortraitUri,
					"maxRounds":        r.MaxRounds,
					"conversationKind": pgTextValue(r.ConversationKind),
					"createdAt":        pgTimeValue(r.CreatedAt),
				}
				if r.OwnerRcUserID.Valid {
					item["ownerId"] = r.OwnerRcUserID.String
				}
				if r.HostBusinessNodeID.Valid {
					item["hostNodeId"] = r.HostBusinessNodeID.String
				}
				items = append(items, item)
			}
			return clawMCPJSONResult(map[string]any{
				"chatrooms": items,
				"total":     total,
				"truncated": truncated,
			})
		},
	}
}

// ---- list_discussions ----------------------------------------------------

func (h *Handler) clawMCPToolListDiscussions() *mcp.Tool {
	return &mcp.Tool{
		Name: "list_discussions",
		Description: "列出指定聊天室下的讨论（圆桌），按创建时间倒序。每项含 discussionId、status、" +
			"currentRound、topic。status 取值：configuring/planning/running/summarizing/awaiting_user/" +
			"synthesizing/completed/cancelled/failed；前六个是活跃态，同一聊天室同时只有一个活跃讨论。",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"chatroomId": map[string]any{"type": "string", "description": "聊天室 id（list_chatrooms 返回的 chatroomId）"},
			},
			"required":             []string{"chatroomId"},
			"additionalProperties": false,
		},
		Handler: func(ctx context.Context, args map[string]any) (mcp.CallResult, error) {
			userID := mcp.UserID(ctx)
			chatroomID, err := clawMCPArgString(args, "chatroomId")
			if err != nil {
				return mcp.CallResult{}, err
			}
			repo, err := h.clawMCPRepo()
			if err != nil {
				return mcp.CallResult{}, err
			}
			if err := h.clawMCPRequireRoom(ctx, chatroomID, userID); err != nil {
				return mcp.CallResult{}, err
			}
			discussions, qErr := repo.ListByChatroom(ctx, chatroomID)
			if qErr != nil {
				return mcp.CallResult{}, mcp.Errorf("query_failed", "查询讨论失败")
			}
			host := h.clawChatroomHostNodeIDCtx(ctx, chatroomID)
			items := make([]map[string]any, 0, len(discussions))
			for _, d := range discussions {
				// 列表不逐条查最新产物（会退化成 N+1），需要产物时用 get_discussion。
				items = append(items, rongcloud.DiscussionSnapshotViewWithHost(d, nil, host))
			}
			return clawMCPJSONResult(map[string]any{
				"chatroomId":  chatroomID,
				"discussions": items,
				"total":       len(items),
			})
		},
	}
}

// ---- get_discussion ------------------------------------------------------

func (h *Handler) clawMCPToolGetDiscussion() *mcp.Tool {
	return &mcp.Tool{
		Name: "get_discussion",
		Description: "读取单场讨论的完整快照：状态、当前轮次、轮次策略、角色板（roles）、" +
			"主持设备（hostNodeId）与最新产物（artifact）。轮询进度优先用 get_discussion_events 增量读，" +
			"本工具适合「先看一眼当前状态」。",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"discussionId": map[string]any{"type": "string", "description": "讨论 id"},
			},
			"required":             []string{"discussionId"},
			"additionalProperties": false,
		},
		Handler: func(ctx context.Context, args map[string]any) (mcp.CallResult, error) {
			userID := mcp.UserID(ctx)
			discussionID, err := clawMCPArgString(args, "discussionId")
			if err != nil {
				return mcp.CallResult{}, err
			}
			repo, err := h.clawMCPRepo()
			if err != nil {
				return mcp.CallResult{}, err
			}
			d, err := h.clawMCPLoadDiscussion(ctx, repo, discussionID, userID)
			if err != nil {
				return mcp.CallResult{}, err
			}
			artifact, aErr := repo.LatestArtifact(ctx, discussionID)
			var artifactPtr *rongcloud.ArtifactRecord
			if aErr == nil {
				artifactPtr = &artifact
			}
			return clawMCPJSONResult(rongcloud.DiscussionSnapshotViewWithHost(
				d, artifactPtr, h.clawChatroomHostNodeIDCtx(ctx, d.ChatroomID),
			))
		},
	}
}

// ---- get_discussion_events ----------------------------------------------

func (h *Handler) clawMCPToolGetDiscussionEvents() *mcp.Tool {
	return &mcp.Tool{
		Name: "get_discussion_events",
		Description: "增量读取讨论事件（阶段迁移、发言、产物更新），按 seq 升序。首次调用 afterSeq=0，" +
			"之后把返回的 nextAfterSeq 作为下次的 afterSeq —— 事件 seq 在单场讨论内单调递增，" +
			"这就是轮询进度的唯一正确姿势（不要重复拉全量）。",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"discussionId": map[string]any{"type": "string", "description": "讨论 id"},
				"afterSeq":     map[string]any{"type": "integer", "minimum": 0, "description": "只返回 seq 大于该值的事件，默认 0"},
			},
			"required":             []string{"discussionId"},
			"additionalProperties": false,
		},
		Handler: func(ctx context.Context, args map[string]any) (mcp.CallResult, error) {
			userID := mcp.UserID(ctx)
			discussionID, err := clawMCPArgString(args, "discussionId")
			if err != nil {
				return mcp.CallResult{}, err
			}
			afterSeq, err := clawMCPArgInt64(args, "afterSeq")
			if err != nil {
				return mcp.CallResult{}, err
			}
			repo, err := h.clawMCPRepo()
			if err != nil {
				return mcp.CallResult{}, err
			}
			if _, err := h.clawMCPLoadDiscussion(ctx, repo, discussionID, userID); err != nil {
				return mcp.CallResult{}, err
			}
			events, qErr := repo.ListEventsAfter(ctx, discussionID, afterSeq)
			if qErr != nil {
				return mcp.CallResult{}, mcp.Errorf("query_failed", "查询讨论事件失败")
			}
			items := make([]map[string]any, 0, len(events))
			var next int64 = afterSeq
			for _, e := range events {
				items = append(items, rongcloud.DiscussionEventView(e))
				if e.Seq > next {
					next = e.Seq
				}
			}
			return clawMCPJSONResult(map[string]any{
				"discussionId": discussionID,
				"events":       items,
				"nextAfterSeq": next,
				"hasMore":      len(events) > 0,
			})
		},
	}
}

// ---- list_round_documents -----------------------------------------------

func (h *Handler) clawMCPToolListRoundDocuments() *mcp.Tool {
	return &mcp.Tool{
		Name: "list_round_documents",
		Description: "列出讨论的逐轮纪要文档（元数据，不含正文）：documentId、round、revision、title。" +
			"正文用 get_round_document 单独取。round 越大越新，revision 是同一轮的修订号。",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"discussionId": map[string]any{"type": "string", "description": "讨论 id"},
			},
			"required":             []string{"discussionId"},
			"additionalProperties": false,
		},
		Handler: func(ctx context.Context, args map[string]any) (mcp.CallResult, error) {
			userID := mcp.UserID(ctx)
			discussionID, err := clawMCPArgString(args, "discussionId")
			if err != nil {
				return mcp.CallResult{}, err
			}
			repo, err := h.clawMCPRepo()
			if err != nil {
				return mcp.CallResult{}, err
			}
			if _, err := h.clawMCPLoadDiscussion(ctx, repo, discussionID, userID); err != nil {
				return mcp.CallResult{}, err
			}
			documents, qErr := repo.ListRoundDocuments(ctx, discussionID)
			if qErr != nil {
				return mcp.CallResult{}, mcp.Errorf("query_failed", "查询逐轮纪要失败")
			}
			items := make([]map[string]any, 0, len(documents))
			for _, doc := range documents {
				items = append(items, rongcloud.RoundDocumentView(doc, false))
			}
			return clawMCPJSONResult(map[string]any{
				"discussionId": discussionID,
				"documents":    items,
			})
		},
	}
}

// ---- get_round_document -------------------------------------------------

func (h *Handler) clawMCPToolGetRoundDocument() *mcp.Tool {
	return &mcp.Tool{
		Name: "get_round_document",
		Description: "读取逐轮纪要正文（Markdown）。超过 64KB 会截断并置 truncated=true，" +
			"此时请以 list_round_documents 的元数据定位其它轮次，或让用户到虾说里查看完整内容。",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"documentId": map[string]any{"type": "string", "description": "纪要 id（list_round_documents 返回的 document_id）"},
			},
			"required":             []string{"documentId"},
			"additionalProperties": false,
		},
		Handler: func(ctx context.Context, args map[string]any) (mcp.CallResult, error) {
			userID := mcp.UserID(ctx)
			documentID, err := clawMCPArgString(args, "documentId")
			if err != nil {
				return mcp.CallResult{}, err
			}
			repo, err := h.clawMCPRepo()
			if err != nil {
				return mcp.CallResult{}, err
			}
			doc, dErr := repo.GetRoundDocument(ctx, documentID)
			if errors.Is(dErr, rongcloud.ErrRoundDocumentNotFound) {
				return mcp.CallResult{}, mcp.Errorf("document_not_found", "纪要不存或已删除")
			}
			if dErr != nil {
				return mcp.CallResult{}, mcp.Errorf("query_failed", "查询纪要失败")
			}
			d, err := repo.Get(ctx, doc.DiscussionID)
			if err != nil {
				return mcp.CallResult{}, mcp.Errorf("document_not_found", "纪要不存或已删除")
			}
			if err := h.clawMCPRequireRoom(ctx, d.ChatroomID, userID); err != nil {
				return mcp.CallResult{}, err
			}
			view := rongcloud.RoundDocumentView(doc, true)
			truncated := false
			if content, ok := view["content"].(string); ok && len(content) > clawMCPDocumentByteLimit {
				view["content"] = clawMCPTruncateUTF8(content, clawMCPDocumentByteLimit)
				truncated = true
			}
			view["truncated"] = truncated
			return clawMCPJSONResult(view)
		},
	}
}

// ---- 共用小工具 ----------------------------------------------------------

func (h *Handler) clawMCPRepo() (*rongcloud.DiscussionRepository, error) {
	repo := h.clawDiscussionRepo()
	if repo == nil {
		return nil, mcp.Errorf("discussion_service_unavailable", "讨论服务尚未初始化")
	}
	return repo, nil
}

// clawMCPRequireRoom 校验成员资格。失败统一回 not_chatroom_member，
// 不区分「房间不存在」与「不是成员」—— 与 C 端 REST 的 404 语义一致，防探测。
func (h *Handler) clawMCPRequireRoom(ctx context.Context, chatroomID, userID string) error {
	if h.RongCloudDiscussionAccess == nil {
		return mcp.Errorf("discussion_service_unavailable", "讨论访问检查未初始化")
	}
	ok, err := h.RongCloudDiscussionAccess.CheckMember(ctx, chatroomID, userID)
	if err != nil {
		return mcp.Errorf("query_failed", "校验聊天室成员资格失败")
	}
	if !ok {
		return mcp.Errorf("not_chatroom_member", "用户不是该聊天室成员，或聊天室不存在")
	}
	return nil
}

func (h *Handler) clawMCPLoadDiscussion(ctx context.Context, repo *rongcloud.DiscussionRepository, discussionID, userID string) (rongcloud.DiscussionRecord, error) {
	d, err := repo.Get(ctx, discussionID)
	if errors.Is(err, rongcloud.ErrDiscussionNotFound) {
		return rongcloud.DiscussionRecord{}, mcp.Errorf("discussion_not_found", "讨论不存在")
	}
	if err != nil {
		return rongcloud.DiscussionRecord{}, mcp.Errorf("query_failed", "查询讨论失败")
	}
	if err := h.clawMCPRequireRoom(ctx, d.ChatroomID, userID); err != nil {
		return rongcloud.DiscussionRecord{}, err
	}
	return d, nil
}

// clawChatroomHostNodeIDCtx 是 clawChatroomHostNodeID 的 ctx 版本（MCP 无 *http.Request）。
func (h *Handler) clawChatroomHostNodeIDCtx(ctx context.Context, chatroomID string) string {
	if h.RongCloudDiscussionAccess == nil {
		return ""
	}
	return h.RongCloudDiscussionAccess.ChatroomHostNodeID(ctx, chatroomID)
}

func clawMCPJSONResult(payload any) (mcp.CallResult, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return mcp.CallResult{}, mcp.Errorf("encode_failed", "结果序列化失败")
	}
	return mcp.CallResult{
		Content:           []mcp.Content{{Type: "text", Text: string(encoded)}},
		StructuredContent: payload,
	}, nil
}

func clawMCPArgString(args map[string]any, key string) (string, error) {
	raw, ok := args[key]
	if !ok {
		return "", mcp.Errorf("invalid_arguments", "缺少参数 %s", key)
	}
	value, ok := raw.(string)
	if !ok {
		return "", mcp.Errorf("invalid_arguments", "参数 %s 必须是非空字符串", key)
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return "", mcp.Errorf("invalid_arguments", "参数 %s 必须是非空字符串", key)
	}
	return value, nil
}

func clawMCPArgInt64(args map[string]any, key string) (int64, error) {
	raw, ok := args[key]
	if !ok || raw == nil {
		return 0, nil
	}
	switch v := raw.(type) {
	case float64:
		if v < 0 {
			return 0, mcp.Errorf("invalid_arguments", "参数 %s 不能为负数", key)
		}
		return int64(v), nil
	case int64:
		if v < 0 {
			return 0, mcp.Errorf("invalid_arguments", "参数 %s 不能为负数", key)
		}
		return v, nil
	case int:
		if v < 0 {
			return 0, mcp.Errorf("invalid_arguments", "参数 %s 不能为负数", key)
		}
		return int64(v), nil
	default:
		return 0, mcp.Errorf("invalid_arguments", "参数 %s 必须是整数", key)
	}
}

// clawMCPTruncateUTF8 按 rune 边界截断，避免把多字节汉字劈成半个。
func clawMCPTruncateUTF8(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

func pgTextValue(t pgtype.Text) string {
	if t.Valid {
		return t.String
	}
	return ""
}

func pgTimeValue(t pgtype.Timestamptz) string {
	if !t.Valid {
		return ""
	}
	return t.Time.UTC().Format(time.RFC3339)
}
