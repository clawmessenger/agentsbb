package db

// WEB-053：角色级模型单独落库。
//
// 为什么手写而不是走 sqlc：`UpdateRongCloudChatroomMemberRoleByChatroomAndNodeID`
// 只覆盖 role_name / role_instructions / enabled，角色模型（`discussion_model`）
// 一直没有 UPDATE 路径 —— 修改角色模型只发了一条 `/use-model` 到设备，服务端
// 仍留着建群时的值，于是「角色配置显示 A、成员卡片显示 B」，下一轮 your_turn
// 又按角色板里的旧值派发。补一条最小 UPDATE 比改那条已经稳定运行的查询风险更小
// （后者被创建与搬迁两条链路共用）。
//
// 与生成本身保持同一风格：常量 SQL + pgtype 参数 + 只回一个字段，方便调用方
// 判断是否真的写进去了。

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

const updateRongCloudChatroomMemberDiscussionModel = `-- name: UpdateRongCloudChatroomMemberDiscussionModel :one
UPDATE rongcloud_chatroom_member
SET discussion_model = $1, updated_at = now()
WHERE chatroom_id = $2 AND node_id = $3
RETURNING discussion_model
`

// UpdateRongCloudChatroomMemberDiscussionModel 覆盖某个 AI 成员的讨论模型。
// `model` 传 invalid 的 pgtype.Text 表示「跟随节点默认模型」（写 NULL）。
func (q *Queries) UpdateRongCloudChatroomMemberDiscussionModel(
	ctx context.Context,
	model pgtype.Text,
	chatroomID pgtype.UUID,
	nodeID pgtype.UUID,
) (pgtype.Text, error) {
	var out pgtype.Text
	err := q.db.QueryRow(ctx, updateRongCloudChatroomMemberDiscussionModel, model, chatroomID, nodeID).Scan(&out)
	return out, err
}
