// 管理后台「用户配额」API（讨论组引导式创建与配额，R-09）。
//
//	GET /api/admin/users/{id}/quota          读用户的覆盖值 + 生效值 + 当前用量
//	PUT /api/admin/users/{id}/quota          保存覆盖值（保存即生效，下一次 Check 读到新值）
//	GET /api/admin/quota/default-plan        读全局默认配额（默认套餐那一行）
//	PUT /api/admin/quota/default-plan        改全局默认配额（保存即生效）
//
// 配额语义：-1 不限 / 0 禁止 / N 上限 / null 跟随默认（清除覆盖）。
// 权限：user:read / user:write（与用户详情页同一粒度）；默认套餐是系统级配置，
// 走 system:read / system:write。
package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/quota"
)

// clawAdminQuotaView 是 GET/PUT 共用的响应 data 形状（admin-web QuotaSection 渲染）。
type clawAdminQuotaView struct {
	// Override 是 claw_im_user_quota 行；没有行（从未覆盖）时三类全 null。
	Override quota.OverrideLimits `json:"override"`
	// Effective 是覆盖>套餐>内置默认解析后的生效上限（-1 不限）。
	Effective quota.Limits `json:"effective"`
	// Usage 是当前用量（status='active' 房间计数，讨论组不双计）。
	Usage quota.Usage `json:"usage"`
	// Defaults 是「全局默认配额」（默认套餐那一行）。关掉自定义覆盖时 effective 就等于它；
	// 前台据此把禁用的输入框填成「跟随默认（N）」而不是留一个没有出处的数字，
	// 也让「这个默认值在哪儿改」这件事有答案（系统配置 → 默认配额）。
	Defaults quota.Limits `json:"defaults"`
	// UpdatedBy / UpdatedAt 是最小审计（谁最后改的）；无覆盖行为空。
	UpdatedBy string `json:"updated_by"`
	UpdatedAt string `json:"updated_at"`
}

// clawAdminQuotaPayload 解析 PUT 请求体：指针为 nil 表示「跟随默认」（清除该类的覆盖）。
type clawAdminQuotaPayload struct {
	DiscussionLimit *int `json:"discussion_limit"`
	GroupLimit      *int `json:"group_limit"`
	ChatroomLimit   *int `json:"chatroom_limit"`
}

// validate 校验取值域：-1 不限 / 0 禁止 / 正整数上限；其余非法。
func (p clawAdminQuotaPayload) validate() bool {
	for _, v := range []*int{p.DiscussionLimit, p.GroupLimit, p.ChatroomLimit} {
		if v != nil && *v < -1 {
			return false
		}
	}
	return true
}

// clawUserExists 404 守门：配额行挂在 claw_im_users 上，目标用户不存在时直接 404，
// 避免给不存在的 user_id 落一条孤儿覆盖行。
func (h *Handler) clawUserExists(w http.ResponseWriter, r *http.Request, userID string) bool {
	var exists bool
	if err := h.DB.QueryRow(r.Context(),
		"SELECT EXISTS(SELECT 1 FROM claw_im_users WHERE user_id=$1)", userID).Scan(&exists); err != nil {
		clawAdminFail(w, 500, "database error")
		return false
	}
	if !exists {
		clawAdminFail(w, 404, "user not found")
		return false
	}
	return true
}

// buildClawAdminQuotaView 组装 GET/PUT 共用的响应：覆盖 + 生效 + 用量 + 最小审计。
func (h *Handler) buildClawAdminQuotaView(r *http.Request, userID string) (clawAdminQuotaView, error) {
	ctx := r.Context()
	var view clawAdminQuotaView
	// 覆盖行（含审计列）：没有行时 Override 保持全 null。
	if row, err := h.Queries.GetClawIMUserQuota(ctx, userID); err == nil {
		if row.DiscussionLimit.Valid {
			v := int(row.DiscussionLimit.Int32)
			view.Override.DiscussionLimit = &v
		}
		if row.GroupLimit.Valid {
			v := int(row.GroupLimit.Int32)
			view.Override.GroupLimit = &v
		}
		if row.ChatroomLimit.Valid {
			v := int(row.ChatroomLimit.Int32)
			view.Override.ChatroomLimit = &v
		}
		view.UpdatedBy = row.UpdatedBy
		if row.UpdatedAt.Valid {
			view.UpdatedAt = row.UpdatedAt.Time.UTC().Format(time.RFC3339)
		}
	}
	effective, err := h.ClawQuota.Resolve(ctx, userID)
	if err != nil {
		return view, err
	}
	view.Effective = effective
	// 默认值单独透出：这是「关掉覆盖会回到哪儿」的答案，也是运营改默认值的入口线索。
	// 读失败不影响主视图（覆盖/生效/用量照常返回），只是前端少一句「跟随默认（N）」。
	if h.DB != nil {
		if defaults, dErr := h.readDefaultQuotaPlan(r); dErr == nil {
			view.Defaults = quota.Limits{
				DiscussionLimit: defaults.DiscussionLimit,
				GroupLimit:      defaults.GroupLimit,
				ChatroomLimit:   defaults.ChatroomLimit,
			}
		}
	}
	usage, err := h.ClawQuota.Usage(ctx, userID)
	if err != nil {
		return view, err
	}
	view.Usage = usage
	return view, nil
}

// ClawAdminGetUserQuota GET /api/admin/users/{id}/quota
func (h *Handler) ClawAdminGetUserQuota(w http.ResponseWriter, r *http.Request) {
	if h.requireClawAdmin("user:read", w, r) == nil {
		return
	}
	if h.ClawQuota == nil || h.Queries == nil {
		clawAdminFail(w, 503, "quota service is unavailable")
		return
	}
	userID := chi.URLParam(r, "id")
	if !h.clawUserExists(w, r, userID) {
		return
	}
	view, err := h.buildClawAdminQuotaView(r, userID)
	if err != nil {
		clawAdminFail(w, 500, "database error")
		return
	}
	clawAdminOK(w, view)
}

// ClawAdminPutUserQuota PUT /api/admin/users/{id}/quota
//
// 保存即生效：UpsertOverride 落库后，下一次 Check（三入口共用同一 Service 实例）
// 立刻读到新值；updated_by 记当前管理员账号。
func (h *Handler) ClawAdminPutUserQuota(w http.ResponseWriter, r *http.Request) {
	ident := h.requireClawAdmin("user:write", w, r)
	if ident == nil {
		return
	}
	if h.ClawQuota == nil || h.Queries == nil {
		clawAdminFail(w, 503, "quota service is unavailable")
		return
	}
	userID := chi.URLParam(r, "id")
	if !h.clawUserExists(w, r, userID) {
		return
	}
	var body clawAdminQuotaPayload
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		clawAdminFail(w, 400, "invalid json body")
		return
	}
	if !body.validate() {
		clawAdminFail(w, 400, "limit must be -1 (unlimited), 0 (forbidden) or a positive integer")
		return
	}
	if err := h.ClawQuota.UpsertOverride(r.Context(), userID, quota.OverrideLimits{
		DiscussionLimit: body.DiscussionLimit,
		GroupLimit:      body.GroupLimit,
		ChatroomLimit:   body.ChatroomLimit,
	}, ident.Username); err != nil {
		clawAdminFail(w, 500, "database error")
		return
	}
	view, err := h.buildClawAdminQuotaView(r, userID)
	if err != nil {
		clawAdminFail(w, 500, "database error")
		return
	}
	clawAdminOK(w, view)
}

// ---- 全局默认配额（默认套餐） ----
//
// 三级优先级「按用户覆盖 > 套餐 > 内置默认」中间那一层就是 `claw_im_plan` 的
// `is_default` 行（597 迁移种下：讨论组 3 / 群聊 5 / 聊天室 1）。用户详情页那三个
// 「生效上限」在没有覆盖时就是这几个数。
//
// 以前这一层没有任何管理入口：运营想让「所有新用户默认能建 5 个讨论组」，只能
// 挨个用户开自定义覆盖，或者改常量重启后端 —— 前者不可持续（新用户永远漏掉），
// 后者线上做不到。所以这里开一组读写口，改的就是那一行：保存后所有**没有覆盖**
// 的用户下一次 Check 立刻按新默认放行（`quota.Resolve` 每次实时查库，无缓存）。

// clawAdminDefaultQuotaView 是默认配额的读写形状（admin-web QuotaDefaultsCard 渲染）。
type clawAdminDefaultQuotaView struct {
	// Name 是套餐名（内置默认兜底时为「内置默认」）。
	Name string `json:"name"`
	// 三类生效默认值（-1 不限 / 0 禁止 / N 上限）。
	DiscussionLimit int `json:"discussion_limit"`
	GroupLimit      int `json:"group_limit"`
	ChatroomLimit   int `json:"chatroom_limit"`
	// Source = plan（库里确有默认套餐行）/ builtin（表里没有，回落到常量）。
	Source string `json:"source"`
	// UpdatedAt 是该行最后修改时间（内置默认时为空）。
	UpdatedAt string `json:"updated_at"`
}

// clawAdminDefaultQuotaPayload 是全量写入形态：三项都必须给。
//
// 与用户覆盖不同，这里没有「null = 清除」的语义 —— 默认套餐行必须是一个完整的三元组，
// 缺一项就只能猜（是保持不变还是回落到常量？），猜错就是「保存成功但数字没动」。
type clawAdminDefaultQuotaPayload struct {
	DiscussionLimit *int `json:"discussion_limit"`
	GroupLimit      *int `json:"group_limit"`
	ChatroomLimit   *int `json:"chatroom_limit"`
}

// validate 校验取值域：-1 不限 / 0 禁止 / 正整数上限；三项都必须给。
func (p clawAdminDefaultQuotaPayload) validate() bool {
	if p.DiscussionLimit == nil || p.GroupLimit == nil || p.ChatroomLimit == nil {
		return false
	}
	for _, v := range []*int{p.DiscussionLimit, p.GroupLimit, p.ChatroomLimit} {
		if *v < -1 {
			return false
		}
	}
	return true
}

// readDefaultQuotaPlan 读默认套餐行；没有行时回落到内置常量（source=builtin）。
func (h *Handler) readDefaultQuotaPlan(r *http.Request) (clawAdminDefaultQuotaView, error) {
	view := clawAdminDefaultQuotaView{
		Name:            "内置默认",
		DiscussionLimit: quota.DefaultDiscussionLimit,
		GroupLimit:      quota.DefaultGroupLimit,
		ChatroomLimit:   quota.DefaultChatroomLimit,
		Source:          "builtin",
	}
	var updatedAt time.Time
	err := h.DB.QueryRow(r.Context(), `
		SELECT name, discussion_limit, group_limit, chatroom_limit, updated_at
		FROM claw_im_plan
		WHERE is_default AND status = 'active'
		LIMIT 1`).Scan(
		&view.Name, &view.DiscussionLimit, &view.GroupLimit, &view.ChatroomLimit, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return view, nil
	}
	if err != nil {
		return view, err
	}
	view.Source = "plan"
	view.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	return view, nil
}

// ClawAdminGetDefaultQuotaPlan GET /api/admin/quota/default-plan
func (h *Handler) ClawAdminGetDefaultQuotaPlan(w http.ResponseWriter, r *http.Request) {
	if h.requireClawAdmin("system:read", w, r) == nil {
		return
	}
	if h.DB == nil {
		clawAdminFail(w, 503, "database is unavailable")
		return
	}
	view, err := h.readDefaultQuotaPlan(r)
	if err != nil {
		clawAdminFail(w, 500, "database error")
		return
	}
	clawAdminOK(w, view)
}

// ClawAdminPutDefaultQuotaPlan PUT /api/admin/quota/default-plan
//
// 保存即生效（`quota.Resolve` 实时查库，无进程内缓存），并落一条审计。
// 三步写：先改「活跃的默认套餐」；没有活跃行但存在被停用的默认行时把它救活
// （否则新插一行会撞 `claw_im_plan_one_default` 部分唯一索引）；两样都没有才插入。
func (h *Handler) ClawAdminPutDefaultQuotaPlan(w http.ResponseWriter, r *http.Request) {
	ident := h.requireClawAdmin("system:write", w, r)
	if ident == nil {
		return
	}
	if h.DB == nil {
		clawAdminFail(w, 503, "database is unavailable")
		return
	}
	var body clawAdminDefaultQuotaPayload
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		clawAdminFail(w, 400, "invalid json body")
		return
	}
	if !body.validate() {
		clawAdminFail(w, 400, "discussion_limit, group_limit and chatroom_limit are required, each must be -1 (unlimited), 0 (forbidden) or a positive integer")
		return
	}
	ctx := r.Context()
	before, err := h.readDefaultQuotaPlan(r)
	if err != nil {
		clawAdminFail(w, 500, "database error")
		return
	}
	tag, err := h.DB.Exec(ctx, `
		UPDATE claw_im_plan
		SET discussion_limit = $1, group_limit = $2, chatroom_limit = $3, updated_at = now()
		WHERE is_default AND status = 'active'`,
		*body.DiscussionLimit, *body.GroupLimit, *body.ChatroomLimit)
	if err == nil && tag.RowsAffected() == 0 {
		// 有默认行但被停用了：救活它而不是新插一行（部分唯一索引不允许两个默认）。
		tag, err = h.DB.Exec(ctx, `
			UPDATE claw_im_plan
			SET discussion_limit = $1, group_limit = $2, chatroom_limit = $3,
			    status = 'active', updated_at = now()
			WHERE is_default`,
			*body.DiscussionLimit, *body.GroupLimit, *body.ChatroomLimit)
	}
	if err == nil && tag.RowsAffected() == 0 {
		// 一条默认行都没有（表被清过 / 597 迁移没跑到）：补种一行，名字固定
		// 「免费版」——`name` 上有唯一约束，同名行存在时按 upsert 覆盖并设回默认。
		_, err = h.DB.Exec(ctx, `
			INSERT INTO claw_im_plan (name, discussion_limit, group_limit, chatroom_limit, is_default, status)
			VALUES ('免费版', $1, $2, $3, true, 'active')
			ON CONFLICT (name) DO UPDATE
			SET discussion_limit = EXCLUDED.discussion_limit,
			    group_limit = EXCLUDED.group_limit,
			    chatroom_limit = EXCLUDED.chatroom_limit,
			    is_default = true,
			    status = 'active',
			    updated_at = now()`,
			*body.DiscussionLimit, *body.GroupLimit, *body.ChatroomLimit)
	}
	if err != nil {
		clawAdminFail(w, 500, "database error")
		return
	}
	h.clawAdminAudit(r, ident, "admin_quota_default_update", "quota_plan", "default", map[string]interface{}{
		"before": map[string]int{
			"discussion_limit": before.DiscussionLimit,
			"group_limit":      before.GroupLimit,
			"chatroom_limit":   before.ChatroomLimit,
		},
		"after": map[string]int{
			"discussion_limit": *body.DiscussionLimit,
			"group_limit":      *body.GroupLimit,
			"chatroom_limit":   *body.ChatroomLimit,
		},
	})
	view, err := h.readDefaultQuotaPlan(r)
	if err != nil {
		clawAdminFail(w, 500, "database error")
		return
	}
	clawAdminOK(w, view)
}
