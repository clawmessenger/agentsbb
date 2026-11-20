package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// 后台「编辑用户」的手机号 / 邮箱查重（QA5-DEF-07 的现场根因）。
//
// 事故链路：claw_im_users.phone 没有库级唯一索引，C 端绑定走的是
// clawIdentifierTaken 先查后写，而后台这条 PUT /api/admin/users/{id} 此前
// 直接 UPDATE —— 于是同一个手机号可以同时挂在两条账号上（一条手机号注册、
// 一条微信登录）。用户在不同入口看到两个「自己」，头像/昵称各不相同，
// 也就是测试单里的「好友账号头像显示不一致」。
//
// 这里盯住三件事：
//  1. 撞别人的 phone / email 一律 409，且目标账号一个字段都不落库；
//  2. 查重口径与 C 端一致 —— username（登录账号）也参与，邮箱不区分大小写；
//  3. 改自己的值（哪怕和库里现值相同）不能误判成冲突。
//
// 与 claw_admin_delete_user_test.go 同一约定：真实库，不可达即 Skip。

type updateUserFixture struct {
	pool     *pgxpool.Pool
	h        *Handler
	selfID   string
	adminID  string
	adminJWT string

	// 四个「占位」账号，各占一种标识符：
	phoneHolderID      string // phone 列被人占了
	loginNameHolderID  string // 手机号被别人当登录账号（username）用了
	emailHolderID      string // email 列被人占了（大小写不同的写法）
	emailLoginHolderID string // 邮箱被别人当登录账号用了

	phoneTaken      string
	loginNameTaken  string
	emailTaken      string
	emailUpperTaken string
	emailLoginTaken string
}

func setupUpdateUserFixture(t *testing.T) *updateUserFixture {
	t.Helper()
	pool := deleteUserServicePool(t)
	ctx := context.Background()
	f := &updateUserFixture{
		pool:               pool,
		selfID:             deleteTestUnique("upd-u"),
		adminID:            deleteTestUnique("upd-admin"),
		phoneHolderID:      deleteTestUnique("upd-phone"),
		loginNameHolderID:  deleteTestUnique("upd-login"),
		emailHolderID:      deleteTestUnique("upd-mail"),
		emailLoginHolderID: deleteTestUnique("upd-maillogin"),
		// 手机号/邮箱都带时间戳，避免同一库上的历史数据撞车。
		phoneTaken:      fmt.Sprintf("1370000%04d", time.Now().UnixNano()%10000),
		loginNameTaken:  fmt.Sprintf("1390000%04d", time.Now().UnixNano()%10000),
		emailTaken:      fmt.Sprintf("taken-%d@example.com", time.Now().UnixNano()),
		emailLoginTaken: fmt.Sprintf("login-%d@example.com", time.Now().UnixNano()),
	}
	f.emailUpperTaken = strings.ToUpper(f.emailTaken)

	seeds := []struct {
		userID, username, nickname, phone, email string
	}{
		{f.selfID, "u-" + f.selfID, "被后台编辑的人", "", ""},
		// 手机号被别人当登录账号（真实现场：手机号注册的账号）。
		{f.loginNameHolderID, f.loginNameTaken, "手机号注册的老号", "", ""},
		// phone 列被占（另一条账号绑了同一号码）。
		{f.phoneHolderID, "u-" + f.phoneHolderID, "已绑手机号的人", f.phoneTaken, ""},
		// email 列被占，库里是小写，请求里用大写测大小写不敏感。
		{f.emailHolderID, "u-" + f.emailHolderID, "已绑邮箱的人", "", f.emailTaken},
		// 邮箱被别人当登录账号用了。
		{f.emailLoginHolderID, f.emailLoginTaken, "邮箱注册的老号", "", ""},
	}
	for _, s := range seeds {
		var phone, email interface{}
		if s.phone != "" {
			phone = s.phone
		}
		if s.email != "" {
			email = s.email
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO claw_im_users (user_id, username, nickname, password_hash, status, phone, email)
			VALUES ($1, $2, $3, 'x', 'active', $4, $5)`,
			s.userID, s.username, s.nickname, phone, email); err != nil {
			t.Fatalf("seed claw user %s: %v", s.userID, err)
		}
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO claw_admin_users (admin_id, username, nickname, password_hash, role_id)
		VALUES ($1, $2, $3, 'x', 'super_admin')`,
		f.adminID, "boss-"+f.adminID, "编辑用户管理员"); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		for _, id := range []string{f.selfID, f.phoneHolderID, f.loginNameHolderID, f.emailHolderID, f.emailLoginHolderID} {
			_, _ = pool.Exec(ctx, "DELETE FROM claw_im_users WHERE user_id=$1", id)
		}
		_, _ = pool.Exec(ctx, "DELETE FROM claw_admin_users WHERE admin_id=$1", f.adminID)
	})

	token, err := issueClawAdminJWT(f.adminID, "access", time.Hour)
	if err != nil {
		t.Fatalf("issue jwt: %v", err)
	}
	f.adminJWT = token
	f.h = &Handler{DB: pool, TxStarter: pool, Queries: db.New(pool)}
	return f
}

func (f *updateUserFixture) req(t *testing.T, targetID string, body map[string]interface{}) *http.Request {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPut, "/api/admin/users/"+targetID, strings.NewReader(string(raw)))
	req.Header.Set("Authorization", "Bearer "+f.adminJWT)
	req.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", targetID)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

// 请求被拒时，目标账号的 phone / email 必须原样不动 —— 409 只是提示，
// 不能落一半（改昵称成功、手机号失败）。
func (f *updateUserFixture) assertUntouched(t *testing.T, label string) {
	t.Helper()
	var phone, email, nickname *string
	if err := f.pool.QueryRow(context.Background(),
		"SELECT phone, email, nickname FROM claw_im_users WHERE user_id=$1", f.selfID).
		Scan(&phone, &email, &nickname); err != nil {
		t.Fatalf("%s: read back self row: %v", label, err)
	}
	if phone != nil && *phone != "" {
		t.Fatalf("%s: phone was written despite rejection: %q", label, *phone)
	}
	if email != nil && *email != "" {
		t.Fatalf("%s: email was written despite rejection: %q", label, *email)
	}
	if nickname == nil || *nickname != "被后台编辑的人" {
		t.Fatalf("%s: nickname changed despite rejection: %v", label, nickname)
	}
}

// 手机号撞别人 phone 列 → 409。
func TestClawAdminUpdateUserRejectsPhoneTakenByAnotherRow(t *testing.T) {
	f := setupUpdateUserFixture(t)
	rr := httptest.NewRecorder()
	f.h.ClawAdminUpdateUser(rr, f.req(t, f.selfID, map[string]interface{}{
		"phone": f.phoneTaken,
	}))
	if rr.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body = %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "手机号") {
		t.Fatalf("body should name the field: %s", rr.Body.String())
	}
	f.assertUntouched(t, "phone taken")
}

// 手机号撞别人的「登录账号」→ 409。这就是现场那条同手机号双账号：
// 号码本身没绑在别人 phone 列，但已经是别人的 username，绑上去之后
// 用这个号码登录会进别人的号。
func TestClawAdminUpdateUserRejectsPhoneTakenByLoginName(t *testing.T) {
	f := setupUpdateUserFixture(t)
	rr := httptest.NewRecorder()
	f.h.ClawAdminUpdateUser(rr, f.req(t, f.selfID, map[string]interface{}{
		"phone": f.loginNameTaken,
	}))
	if rr.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body = %s", rr.Code, rr.Body.String())
	}
	f.assertUntouched(t, "phone taken by username")
}

// 邮箱查重不分大小写：库里存的小写、请求里写大写也算占用。
func TestClawAdminUpdateUserRejectsEmailTakenCaseInsensitively(t *testing.T) {
	f := setupUpdateUserFixture(t)
	rr := httptest.NewRecorder()
	f.h.ClawAdminUpdateUser(rr, f.req(t, f.selfID, map[string]interface{}{
		"email": f.emailUpperTaken,
	}))
	if rr.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body = %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "邮箱") {
		t.Fatalf("body should name the field: %s", rr.Body.String())
	}
	f.assertUntouched(t, "email taken")
}

// 邮箱撞别人的登录账号 → 409（邮箱注册的账号 username 就是邮箱）。
func TestClawAdminUpdateUserRejectsEmailTakenByLoginName(t *testing.T) {
	f := setupUpdateUserFixture(t)
	rr := httptest.NewRecorder()
	f.h.ClawAdminUpdateUser(rr, f.req(t, f.selfID, map[string]interface{}{
		"email": f.emailLoginTaken,
	}))
	if rr.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body = %s", rr.Code, rr.Body.String())
	}
	f.assertUntouched(t, "email taken by username")
}

// 改自己的值不能误判：先写入，再原值 PUT 一次，两次都要 200。
// （自查重条件里 user_id<>$2 那半段的回归闸门。）
func TestClawAdminUpdateUserAllowsKeepingOwnIdentifier(t *testing.T) {
	f := setupUpdateUserFixture(t)
	phone := fmt.Sprintf("1360000%04d", time.Now().UnixNano()%10000)
	email := fmt.Sprintf("mine-%d@example.com", time.Now().UnixNano())

	for i := 0; i < 2; i++ {
		rr := httptest.NewRecorder()
		f.h.ClawAdminUpdateUser(rr, f.req(t, f.selfID, map[string]interface{}{
			"phone": phone, "email": email,
		}))
		if rr.Code != http.StatusOK {
			t.Fatalf("round %d: status = %d, want 200; body = %s", i, rr.Code, rr.Body.String())
		}
	}

	var gotPhone, gotEmail string
	if err := f.pool.QueryRow(context.Background(),
		"SELECT COALESCE(phone,''), COALESCE(email,'') FROM claw_im_users WHERE user_id=$1", f.selfID).
		Scan(&gotPhone, &gotEmail); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if gotPhone != phone || gotEmail != email {
		t.Fatalf("stored phone/email = %q/%q, want %q/%q", gotPhone, gotEmail, phone, email)
	}
}

// 409 之外，正常改昵称/头像仍要能落库（查重不能把整条编辑路径锁死）。
func TestClawAdminUpdateUserStillSavesNicknameAndPortrait(t *testing.T) {
	f := setupUpdateUserFixture(t)
	rr := httptest.NewRecorder()
	f.h.ClawAdminUpdateUser(rr, f.req(t, f.selfID, map[string]interface{}{
		"nickname": "改过的昵称", "portrait_uri": "https://cdn.example.com/a.png",
	}))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
	var nickname, portrait string
	if err := f.pool.QueryRow(context.Background(),
		"SELECT COALESCE(nickname,''), COALESCE(portrait_uri,'') FROM claw_im_users WHERE user_id=$1", f.selfID).
		Scan(&nickname, &portrait); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if nickname != "改过的昵称" || portrait != "https://cdn.example.com/a.png" {
		t.Fatalf("stored nickname/portrait = %q/%q", nickname, portrait)
	}
}
