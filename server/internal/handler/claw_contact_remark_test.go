package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// 联系人备注接口的测试。
//
// 复用 claw_contact_group_test.go 的脚本化假 DB（cgFakeDB / cgAuthedDB /
// cgStubRows / cgTestUserID）：未打桩的 SQL 会 panic，所以「某个分支零次 SQL」
// 是可直接断言的结论，而不是读代码的推断。
//
// 特别注意：**鉴权查询也走 DB**（clawRequireClawUser 查
// claw_im_users.rongcloud_token），所以每个带 token 的用例都靠 cgAuthedDB
// 把第一条 claw_im_users 查询接住；反过来，想证明「未登录时一次业务表都没碰」，
// 就用没有任何桩的 &cgFakeDB{} —— 任何一次 Query/QueryRow 都会 panic。

// crExecCall 是一次 Exec 的完整留痕，用于断言「走的是 upsert 还是 DELETE」
// 以及参数顺序（参数写反 = 越权写别人的备注，必须能被测出来）。
type crExecCall struct {
	sql  string
	args []any
}

// crStubExec 把 Exec 打桩成「记录语句与参数，返回 rows 行受影响」。
func crStubExec(db *cgFakeDB, rows int64) *[]crExecCall {
	calls := &[]crExecCall{}
	db.exec = func(sql string, args []any) (pgconn.CommandTag, error) {
		argsCopy := make([]any, len(args))
		copy(argsCopy, args)
		*calls = append(*calls, crExecCall{sql: sql, args: argsCopy})
		return pgconn.NewCommandTag(fmt.Sprintf("DELETE %d", rows)), nil
	}
	return calls
}

// crDecode 解析 {code, message, data} 信封。cgDecode 丢掉了 message，而备注接口
// 的用例几乎每条都要钉文案（「不能给自己加备注」这类是产品可见的原文）。
func crDecode(t *testing.T, rec *httptest.ResponseRecorder) (code int, message string, data map[string]any) {
	t.Helper()
	var envelope struct {
		Code    int                    `json:"code"`
		Message string                 `json:"message"`
		Data    map[string]interface{} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode response: %v (body=%s)", err, rec.Body.String())
	}
	return envelope.Code, envelope.Message, envelope.Data
}

// crRemarkBody 造 PUT 的请求体。用 json.Marshal 而不是手写字符串：备注里可能
// 有引号/控制字符，手拼会把「测什么」变成「JSON 写没写对」。
func crRemarkBody(t *testing.T, userID, remark string) string {
	t.Helper()
	payload, err := json.Marshal(map[string]string{"userId": userID, "remark": remark})
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	return string(payload)
}

// ---- GET /api/claw/contact-remarks -----------------------------------------

// 列表只返回本人行：占位参数必须是登录账号，不能是任何客户端可控的值。
func TestListContactRemarks_ReturnsOwnRows(t *testing.T) {
	db := cgAuthedDB(t)
	db.query = func(sql string, args []any) (pgx.Rows, error) {
		if !strings.Contains(sql, "FROM im_contact_remark") {
			t.Fatalf("unexpected Query: %s", sql)
		}
		if len(args) != 1 || args[0] != cgTestUserID {
			t.Fatalf("list args = %v, want exactly the logged-in account %q", args, cgTestUserID)
		}
		return &cgStubRows{rows: [][]any{
			{"claw_9f3a2c", "老王"},
			{"node_3f2b8d11", "写作助手"},
		}}, nil
	}
	h := &Handler{DB: db}

	rec := httptest.NewRecorder()
	h.ClawListContactRemarks(rec, cgRequest(t, http.MethodGet, "/api/claw/contact-remarks", ""))

	if rec.Code != 200 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	code, _, data := crDecode(t, rec)
	if code != 200 {
		t.Fatalf("envelope code = %d", code)
	}
	raw, err := json.Marshal(data["remarks"])
	if err != nil {
		t.Fatalf("marshal remarks: %v", err)
	}
	var remarks []contactRemarkDTO
	if err := json.Unmarshal(raw, &remarks); err != nil {
		t.Fatalf("decode remarks: %v", err)
	}
	if len(remarks) != 2 {
		t.Fatalf("remarks = %d, want 2", len(remarks))
	}
	if remarks[0].UserID != "claw_9f3a2c" || remarks[0].Remark != "老王" {
		t.Fatalf("remarks[0] = %+v", remarks[0])
	}
	// 键名必须是 userId/remark：前端按这两个键建 map，换个名字（key/value）就白拉。
	var rawItem map[string]any
	if err := json.Unmarshal(mustRawJSON(t, data["remarks"], 0), &rawItem); err != nil {
		t.Fatalf("decode first remark: %v", err)
	}
	if _, ok := rawItem["userId"]; !ok {
		t.Fatalf("first remark has no userId key: %v", rawItem)
	}
	if _, ok := rawItem["remark"]; !ok {
		t.Fatalf("first remark has no remark key: %v", rawItem)
	}
}

// mustRawJSON 取出数组里的第 i 个元素并重新编码成 JSON 文本。
func mustRawJSON(t *testing.T, value any, index int) []byte {
	t.Helper()
	list, ok := value.([]any)
	if !ok || len(list) <= index {
		t.Fatalf("value is not an array with index %d: %#v", index, value)
	}
	raw, err := json.Marshal(list[index])
	if err != nil {
		t.Fatalf("marshal element %d: %v", index, err)
	}
	return raw
}

// 0 条时必须是 []，不能是 null —— 前端 data.remarks.map(...) 会直接炸。
// 这条专门钉 make([]contactRemarkDTO, 0, ...)：写成 var remarks []contactRemarkDTO
// 就会编码成 null。
func TestListContactRemarks_EmptyIsArrayNotNull(t *testing.T) {
	db := cgAuthedDB(t)
	db.query = func(sql string, args []any) (pgx.Rows, error) {
		return &cgStubRows{rows: nil}, nil
	}
	h := &Handler{DB: db}

	rec := httptest.NewRecorder()
	h.ClawListContactRemarks(rec, cgRequest(t, http.MethodGet, "/api/claw/contact-remarks", ""))

	if rec.Code != 200 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if body := rec.Body.String(); !strings.Contains(body, `"remarks":[]`) {
		t.Fatalf("empty list must encode as [], body = %s", body)
	}
}

// 没有 Bearer 时必须在碰业务表之前就 401。用没有任何桩的假 DB：任何一次库调用
// 都会 panic，所以「零次 SQL」是硬结论。
func TestListContactRemarks_DeniedWithoutToken(t *testing.T) {
	db := &cgFakeDB{}
	h := &Handler{DB: db}

	rec := httptest.NewRecorder()
	h.ClawListContactRemarks(rec, httptest.NewRequest(http.MethodGet, "/api/claw/contact-remarks", nil))

	if rec.Code != 401 {
		t.Fatalf("status = %d, want 401 (body=%s)", rec.Code, rec.Body.String())
	}
	code, message, _ := crDecode(t, rec)
	if code != 401 || message != "登录令牌无效" {
		t.Fatalf("code/message = %d/%q, want 401/登录令牌无效", code, message)
	}
	if len(db.queries) != 0 || len(db.execs) != 0 {
		t.Fatalf("unauthenticated request touched DB: queries=%v execs=%v", db.queries, db.execs)
	}
}

// 查询失败必须 500 + 明确文案，不能吞成 200 空表：那样前端无法区分
// 「服务端挂了」和「我确实没有备注」。
func TestListContactRemarks_DBErrorIs500(t *testing.T) {
	db := cgAuthedDB(t)
	db.query = func(sql string, args []any) (pgx.Rows, error) {
		return nil, errors.New("connection reset by peer")
	}
	h := &Handler{DB: db}

	rec := httptest.NewRecorder()
	h.ClawListContactRemarks(rec, cgRequest(t, http.MethodGet, "/api/claw/contact-remarks", ""))

	if rec.Code != 500 {
		t.Fatalf("status = %d, want 500 (body=%s)", rec.Code, rec.Body.String())
	}
	if code, message, _ := crDecode(t, rec); code != 500 || message != "获取备注失败" {
		t.Fatalf("code/message = %d/%q, want 500/获取备注失败", code, message)
	}
}

// ---- PUT /api/claw/contact-remarks -----------------------------------------

// 首次写入必须走 INSERT ... ON CONFLICT（写成 UPDATE 会让「第一次加备注」静默无效），
// 且参数顺序是 (owner, target, value) —— 写反就是越权写别人的备注。
func TestUpdateContactRemark_Upsert(t *testing.T) {
	db := cgAuthedDB(t)
	calls := crStubExec(db, 1)
	h := &Handler{DB: db}

	rec := httptest.NewRecorder()
	h.ClawUpdateContactRemark(rec, cgRequest(t, http.MethodPut, "/api/claw/contact-remarks",
		crRemarkBody(t, "claw_9f3a2c", "老王")))

	if rec.Code != 200 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	_, _, data := crDecode(t, rec)
	if data["userId"] != "claw_9f3a2c" || data["remark"] != "老王" {
		t.Fatalf("data = %v", data)
	}
	if len(*calls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(*calls))
	}
	if !strings.HasPrefix(strings.TrimSpace((*calls)[0].sql), "INSERT INTO im_contact_remark") {
		t.Fatalf("upsert must be an INSERT into im_contact_remark, got: %s", (*calls)[0].sql)
	}
	want := []any{cgTestUserID, "claw_9f3a2c", "老王"}
	if fmt.Sprint((*calls)[0].args) != fmt.Sprint(want) {
		t.Fatalf("args = %v, want %v", (*calls)[0].args, want)
	}
}

// 「  老王  」存成「老王」：回包与落库都必须是 trim 之后的值，否则界面上会显示
// 带空格的备注，而且和前端 trim 后的对比逻辑对不上。
func TestUpdateContactRemark_TrimsStoredValue(t *testing.T) {
	db := cgAuthedDB(t)
	calls := crStubExec(db, 1)
	h := &Handler{DB: db}

	rec := httptest.NewRecorder()
	h.ClawUpdateContactRemark(rec, cgRequest(t, http.MethodPut, "/api/claw/contact-remarks",
		crRemarkBody(t, "claw_9f3a2c", "  老王  ")))

	if rec.Code != 200 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	_, _, data := crDecode(t, rec)
	if data["remark"] != "老王" {
		t.Fatalf("response remark = %v, want 老王", data["remark"])
	}
	if len(*calls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(*calls))
	}
	if len((*calls)[0].args) != 3 || (*calls)[0].args[2] != "老王" {
		t.Fatalf("stored value = %v, want 老王", (*calls)[0].args)
	}
}

// 纯空白 = 删除。走 upsert 会撞 CHECK (length(btrim(remark)) BETWEEN 1 AND 32) → 500，
// 所以要同时钉「SQL 是 DELETE」和「回包 remark 是空串」。
func TestUpdateContactRemark_EmptyDeletes(t *testing.T) {
	db := cgAuthedDB(t)
	calls := crStubExec(db, 1)
	h := &Handler{DB: db}

	rec := httptest.NewRecorder()
	h.ClawUpdateContactRemark(rec, cgRequest(t, http.MethodPut, "/api/claw/contact-remarks",
		crRemarkBody(t, "claw_9f3a2c", "   ")))

	if rec.Code != 200 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	_, _, data := crDecode(t, rec)
	if data["userId"] != "claw_9f3a2c" {
		t.Fatalf("data = %v", data)
	}
	if remark, present := data["remark"]; !present || remark != "" {
		t.Fatalf("delete must answer remark:\"\", got %#v", data["remark"])
	}
	if len(*calls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(*calls))
	}
	if !strings.HasPrefix(strings.TrimSpace((*calls)[0].sql), "DELETE FROM im_contact_remark") {
		t.Fatalf("blank remark must DELETE, got: %s", (*calls)[0].sql)
	}
	if len(*calls) > 1 {
		t.Fatalf("blank remark must not also upsert: %v", *calls)
	}
}

// 删不到行（本来就没备注）也算成功：DELETE 影响 0 行不是错误，用 RETURNING +
// ErrNoRows 判 404 是 contact-group 那套的写法，这里不能照抄。
func TestUpdateContactRemark_DeleteIsIdempotent(t *testing.T) {
	db := cgAuthedDB(t)
	calls := crStubExec(db, 0)
	h := &Handler{DB: db}

	rec := httptest.NewRecorder()
	h.ClawUpdateContactRemark(rec, cgRequest(t, http.MethodPut, "/api/claw/contact-remarks",
		crRemarkBody(t, "claw_9f3a2c", "")))

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	if len(*calls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(*calls))
	}
}

// 33 个中文必须 400 且**零次 SQL**。用 len() 判长会在 11 个中文时就误判超限，
// 这条专门钉 utf8.RuneCountInString。
func TestUpdateContactRemark_RejectsTooLong(t *testing.T) {
	db := cgAuthedDB(t)
	calls := crStubExec(db, 1)
	h := &Handler{DB: db}

	rec := httptest.NewRecorder()
	h.ClawUpdateContactRemark(rec, cgRequest(t, http.MethodPut, "/api/claw/contact-remarks",
		crRemarkBody(t, "claw_9f3a2c", strings.Repeat("备", 33))))

	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
	}
	if code, message, _ := crDecode(t, rec); code != 400 || message != "备注最多 32 个字" {
		t.Fatalf("code/message = %d/%q, want 400/备注最多 32 个字", code, message)
	}
	if len(*calls) != 0 || len(db.queries) != 0 {
		t.Fatalf("rejected value must not reach SQL: execs=%d queries=%d", len(*calls), len(db.queries))
	}
}

// 上一条的镜像：恰好 32 个中文（96 字节）必须通过。把上限写成 < 32 会在这里红。
func TestUpdateContactRemark_Accepts32Chinese(t *testing.T) {
	db := cgAuthedDB(t)
	calls := crStubExec(db, 1)
	h := &Handler{DB: db}

	value := strings.Repeat("备", 32)
	rec := httptest.NewRecorder()
	h.ClawUpdateContactRemark(rec, cgRequest(t, http.MethodPut, "/api/claw/contact-remarks",
		crRemarkBody(t, "claw_9f3a2c", value)))

	if rec.Code != 200 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	_, _, data := crDecode(t, rec)
	if data["remark"] != value {
		t.Fatalf("remark = %v, want 32 chars", data["remark"])
	}
	if len(*calls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(*calls))
	}
	if len((*calls)[0].args) != 3 || (*calls)[0].args[2] != value {
		t.Fatalf("exec args = %v", (*calls)[0].args)
	}
}

// 给自己加备注必须 400「不能给自己加备注」且零次 SQL。删掉这一步就会撞 DB 的
// CHECK (target_user_id <> owner_user_id) 变成 500，用户看到的是「保存备注失败」。
func TestUpdateContactRemark_RejectsSelf(t *testing.T) {
	db := cgAuthedDB(t)
	calls := crStubExec(db, 1)
	h := &Handler{DB: db}

	rec := httptest.NewRecorder()
	h.ClawUpdateContactRemark(rec, cgRequest(t, http.MethodPut, "/api/claw/contact-remarks",
		crRemarkBody(t, cgTestUserID, "我自己")))

	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
	}
	if code, message, _ := crDecode(t, rec); code != 400 || message != "不能给自己加备注" {
		t.Fatalf("code/message = %d/%q, want 400/不能给自己加备注", code, message)
	}
	if len(*calls) != 0 || len(db.queries) != 0 {
		t.Fatalf("self remark must not reach SQL: execs=%d queries=%d", len(*calls), len(db.queries))
	}
}

// userId 的判断必须 trim 之后再判：只判 == "" 会让 "  " 进 SQL（落库时撞
// CHECK target_not_blank → 500）。
func TestUpdateContactRemark_RejectsBlankTarget(t *testing.T) {
	db := cgAuthedDB(t)
	calls := crStubExec(db, 1)
	h := &Handler{DB: db}

	rec := httptest.NewRecorder()
	h.ClawUpdateContactRemark(rec, cgRequest(t, http.MethodPut, "/api/claw/contact-remarks",
		crRemarkBody(t, "   ", "老王")))

	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
	}
	if code, message, _ := crDecode(t, rec); code != 400 || message != "缺少用户ID" {
		t.Fatalf("code/message = %d/%q, want 400/缺少用户ID", code, message)
	}
	if len(*calls) != 0 {
		t.Fatalf("blank target must not reach SQL: %v", *calls)
	}
}

// 未登录的 PUT 也必须 401 且零次 SQL（图省事把鉴权放到解码之后，会出现
// 「匿名请求也能写库」）。
func TestUpdateContactRemark_DeniedWithoutToken(t *testing.T) {
	db := &cgFakeDB{}
	h := &Handler{DB: db}

	req := httptest.NewRequest(http.MethodPut, "/api/claw/contact-remarks",
		strings.NewReader(crRemarkBody(t, "claw_9f3a2c", "老王")))
	rec := httptest.NewRecorder()
	h.ClawUpdateContactRemark(rec, req)

	if rec.Code != 401 {
		t.Fatalf("status = %d, want 401 (body=%s)", rec.Code, rec.Body.String())
	}
	if code, message, _ := crDecode(t, rec); code != 401 || message != "登录令牌无效" {
		t.Fatalf("code/message = %d/%q", code, message)
	}
	if len(db.queries) != 0 || len(db.execs) != 0 {
		t.Fatalf("unauthenticated write touched DB: queries=%v execs=%v", db.queries, db.execs)
	}
}

// 写库失败要区分「保存」与「删除」两条文案：前端把后端 message 原样弹给用户。
func TestUpdateContactRemark_SQLErrorMessages(t *testing.T) {
	for _, tc := range []struct {
		name    string
		remark  string
		message string
	}{
		{"save", "老王", "保存备注失败"},
		{"delete", "  ", "删除备注失败"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := cgAuthedDB(t)
			db.exec = func(sql string, args []any) (pgconn.CommandTag, error) {
				return pgconn.CommandTag{}, errors.New("deadlock detected")
			}
			h := &Handler{DB: db}

			rec := httptest.NewRecorder()
			h.ClawUpdateContactRemark(rec, cgRequest(t, http.MethodPut, "/api/claw/contact-remarks",
				crRemarkBody(t, "claw_9f3a2c", tc.remark)))

			if rec.Code != 500 {
				t.Fatalf("status = %d, want 500 (body=%s)", rec.Code, rec.Body.String())
			}
			if code, message, _ := crDecode(t, rec); code != 500 || message != tc.message {
				t.Fatalf("code/message = %d/%q, want 500/%s", code, message, tc.message)
			}
		})
	}
}

// 503「数据库未配置」这一分支在这两个端点上**构造不出黑盒用例**：
// clawRequireClawUser 本身要用同一个 h.DB 查 token，h.DB == nil 时第 1 步就会
// 空指针，永远走不到第 2 步。所以这里钉住能验证的那一半，也是真正重要的那一半：
// **DB 判空必须排在鉴权之后**，且匿名请求不能因为「库没配」而拿到 200/400/503。
// 若有人把 h.DB == nil 提到鉴权之前，这条会立刻红（匿名请求会变成 503）。
func TestContactRemarkHandlers_NilDBStaysBehindAuth(t *testing.T) {
	h := &Handler{DB: nil}

	getRec := httptest.NewRecorder()
	h.ClawListContactRemarks(getRec, httptest.NewRequest(http.MethodGet, "/api/claw/contact-remarks", nil))
	if getRec.Code != 401 {
		t.Fatalf("GET status = %d, want 401 (body=%s)", getRec.Code, getRec.Body.String())
	}

	putReq := httptest.NewRequest(http.MethodPut, "/api/claw/contact-remarks",
		strings.NewReader(crRemarkBody(t, "claw_9f3a2c", "老王")))
	putRec := httptest.NewRecorder()
	h.ClawUpdateContactRemark(putRec, putReq)
	if putRec.Code != 401 {
		t.Fatalf("PUT status = %d, want 401 (body=%s)", putRec.Code, putRec.Body.String())
	}
}
