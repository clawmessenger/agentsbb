package handler

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"unicode/utf8"
)

// 联系人备注接口。给 agentsbb-web / agentsbb-uniapp 的通讯录与名片用。
//
// 设计要点（改之前先读，这几条都是被具体问题逼出来的）：
//
//  1. 备注**独立成一条端点**，不塞进 GET /api/user/friends。好友列表在两端各有
//     2~3 条取数通道（web 是「融云 SDK getFriends + HTTP /api/user/friends」合并，
//     移动端是「SDK → command → HTTP」三级降级），塞进其中一条，另外几条路径拿到
//     的朋友就没有备注 —— 这正是 claw_contact_group.go 顶部第 5 条记过的 bug 类型。
//     更根本的判据是生命周期：备注是「我对某人的私有标注」，用户可以给一个已删
//     好友保留备注，也可以给还没加成好友的 agent 设备加备注，它不该依赖好友关系。
//  2. 键统一用**融云 userId**（target_user_id）。web 好友行取 friend.userId，web
//     智能体行取 device.sn（= rongcloud_id || node_id），移动端取 user.userId /
//     device.rongcloud_id（**不是** node_id）。两端各用各的键，备注就会「一半生效」。
//  3. userId 放 body 而不是路径段：target_user_id 是客户端给的不透明字符串，放路径
//     要 encodeURIComponent + url.PathUnescape 两侧对齐，漏一次就把 %2F 变成 404
//     或串号。写接口一次一条，批量（localStorage 一次性迁移）由客户端循环调用，
//     天然拿到「部分成功可重试」。
//  4. 删除与写入共用 200，靠回包 remark:"" 表达「已无备注」。本仓所有接口都是
//     {code,message,data} 信封，突然来一个 204 会让两端 envelopeData() 拿到 null。
//  5. 读接口失败当空表、写接口失败必须让前端看到原因 —— 备注是叠加信息，拿不到
//     就退回昵称显示，不该让通讯录进错误态。
//  6. 表零外键：不 FK 到 claw_im_users（好友可能是纯融云侧账号），也不 FK 到
//     rongcloud_node（解绑不该连带删掉「这是老机器」这种备注）。

// contactRemarkMaxRunes 是备注上限，按**字符**（rune）计，不是字节数。中文一个字
// 三字节，用 len() 会把「写作助手专业版」这种 7 字名判超限。这个 32 必须与迁移
// 608 的 CHECK（length(btrim(remark)) BETWEEN 1 AND 32）以及前端 maxLength=32
// 三处一致 —— 服务端是权威，前端那个只是体验优化。
const contactRemarkMaxRunes = 32

// 一条 SQL 取回当前账号的全部备注：唯一查询是 owner_user_id，主键
// (owner_user_id, target_user_id) 的最左前缀已经覆盖，不需要额外索引。
// ORDER BY updated_at DESC 让「最近改过的」排在前面，前端顺序稳定。
const contactRemarkListSQL = `
SELECT target_user_id, remark
FROM im_contact_remark
WHERE owner_user_id = $1
ORDER BY updated_at DESC`

// 写入走 upsert：首次加备注与改备注是同一条语句，客户端不用先 GET 再决定
// INSERT 还是 UPDATE（那中间有窗口，且多一次往返）。
// updated_at 只在这里刷新 —— 列表排序依赖它。
const contactRemarkUpsertSQL = `
INSERT INTO im_contact_remark (owner_user_id, target_user_id, remark)
VALUES ($1, $2, $3)
ON CONFLICT (owner_user_id, target_user_id)
DO UPDATE SET remark = EXCLUDED.remark, updated_at = now()`

// 删除就是真删除，不做「写空串」。空串会让「有没有备注」的判断与「备注是否为空」
// 分叉（前端已有两处逻辑分别判 empty 与 undefined），表里也加了 CHECK 拦空串。
const contactRemarkDeleteSQL = `
DELETE FROM im_contact_remark
WHERE owner_user_id = $1 AND target_user_id = $2`

// contactRemarkDTO 是给前端的形状，读写两个接口共用：删除成功的回包同样带
// userId，前端据此把这一行从内存表里删掉，不用再猜「删的是谁」。
type contactRemarkDTO struct {
	UserID string `json:"userId"`
	Remark string `json:"remark"`
}

// normalizeContactRemark 统一按「先 trim 再按字符数计长」校验，返回三个值：
//   - value    落库/回包用的文本（已 trim）
//   - deleted  是否等于「删除这条备注」（trim 后为空即删除）
//   - ok       是否合法（超长则 false）
//
// 特意让「空」走 deleted=true, ok=true 而不是当作非法：清空备注是正常操作，
// 走 DELETE 而不是撞 CHECK 约束变 500。
func normalizeContactRemark(raw string) (value string, deleted bool, ok bool) {
	value = strings.TrimSpace(raw)
	if value == "" {
		return "", true, true
	}
	if utf8.RuneCountInString(value) > contactRemarkMaxRunes {
		return "", false, false
	}
	return value, false, true
}

// ClawListContactRemarks GET /api/claw/contact-remarks
//
// 无查询参数、无请求体：只返回 owner_user_id = 当前登录账号的行，没有任何入参
// 能让调用方读到别人的备注。
func (h *Handler) ClawListContactRemarks(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.clawRequireClawUser(w, r)
	if !ok {
		return
	}
	if h.DB == nil {
		clawJSON(w, 503, 503, "数据库未配置", nil)
		return
	}
	rows, err := h.DB.Query(r.Context(), contactRemarkListSQL, userID)
	if err != nil {
		slog.Warn("claw: list contact remarks failed", "error", err)
		clawJSON(w, 500, 500, "获取备注失败", nil)
		return
	}
	defer rows.Close()

	// 容量按 8 起步：备注数量级 = 好友数的一小部分，不值得先 COUNT。
	remarks := make([]contactRemarkDTO, 0, 8)
	for rows.Next() {
		var item contactRemarkDTO
		if err := rows.Scan(&item.UserID, &item.Remark); err != nil {
			slog.Warn("claw: scan contact remark failed", "error", err)
			clawJSON(w, 500, 500, "获取备注失败", nil)
			return
		}
		remarks = append(remarks, item)
	}
	if err := rows.Err(); err != nil {
		slog.Warn("claw: iterate contact remarks failed", "error", err)
		clawJSON(w, 500, 500, "获取备注失败", nil)
		return
	}
	// remarks 恒为数组：nil 会被 json 编码成 null，前端直接 .map 会炸。
	// 上面用 make(..., 0, ...) 保证 0 条时序列化成 []。
	clawJSON(w, 200, 200, "ok", map[string]interface{}{"remarks": remarks})
}

// ClawUpdateContactRemark PUT /api/claw/contact-remarks  {userId, remark}
//
// remark 为空串/纯空白 = 删除该行。同一个 body 重复 PUT 结果一致（写入是
// ON CONFLICT DO UPDATE，删除删不到也算成功）。
//
// 下面 8 步的**顺序即安全边界**，不要为了「早点给出准确错误」而调整：
//  1. 鉴权（中间件已写好响应）
//  2. DB 判空 → 503
//  3. 解码 body → 400 请求格式有误
//  4. trim userId，空 → 400 缺少用户ID
//  5. target == 自己 → 400 不能给自己加备注
//  6. 校验备注（trim + rune 上限）→ 400 备注最多 32 个字
//  7. 删除分支
//  8. upsert 分支
//
// 第 5 步在 SQL 之前挡：DB 有 CHECK (target_user_id <> owner_user_id)，但让用户
// 看到「保存备注失败」(500) 而不是「不能给自己加备注」(400) 是没必要的体验损失。
func (h *Handler) ClawUpdateContactRemark(w http.ResponseWriter, r *http.Request) {
	clawUserID, ok := h.clawRequireClawUser(w, r)
	if !ok {
		return
	}
	if h.DB == nil {
		clawJSON(w, 503, 503, "数据库未配置", nil)
		return
	}
	var req struct {
		UserID string `json:"userId"`
		Remark string `json:"remark"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		clawJSON(w, 400, 400, "请求格式有误", nil)
		return
	}
	target := strings.TrimSpace(req.UserID)
	if target == "" {
		clawJSON(w, 400, 400, "缺少用户ID", nil)
		return
	}
	if target == clawUserID {
		clawJSON(w, 400, 400, "不能给自己加备注", nil)
		return
	}
	value, deleted, valid := normalizeContactRemark(req.Remark)
	if !valid {
		clawJSON(w, 400, 400, "备注最多 32 个字", nil)
		return
	}
	if deleted {
		if _, err := h.DB.Exec(r.Context(), contactRemarkDeleteSQL, clawUserID, target); err != nil {
			slog.Warn("claw: delete contact remark failed", "target", target, "error", err)
			clawJSON(w, 500, 500, "删除备注失败", nil)
			return
		}
		// 删不到行也回成功：清空一个本来就没有的备注是幂等操作，不该报错。
		clawJSON(w, 200, 200, "ok", contactRemarkDTO{UserID: target, Remark: ""})
		return
	}
	if _, err := h.DB.Exec(r.Context(), contactRemarkUpsertSQL, clawUserID, target, value); err != nil {
		slog.Warn("claw: save contact remark failed", "target", target, "error", err)
		clawJSON(w, 500, 500, "保存备注失败", nil)
		return
	}
	clawJSON(w, 200, 200, "ok", contactRemarkDTO{UserID: target, Remark: value})
}
