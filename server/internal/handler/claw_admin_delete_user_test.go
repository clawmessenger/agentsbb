package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// 删除用户 API 的集成测试（真实库，不可达时 Skip —— 与 claw_admin_quota_test.go 同一约定）。
//
// 覆盖验收标准：
//   - DELETE /api/admin/users/{id} 删掉 claw_im_users 行，连带清理
//     claw_im_user_quota / claw_lobster（FK）、im_contact_remark、
//     im_friend_request（软引用）与 rongcloud_node.claimed_by_user_id 投影；
//   - 融云集成未接（RongCloudNode 为 nil）时本地照删，响应
//     rongcloud_deactivated=false 如实标注；
//   - 不存在的用户 / 运维账号（不在 claw_im_users）→ 404，什么都不删；
//   - 无权限（缺 token）401。

func deleteUserServicePool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://multica:multica@localhost:5432/multica?sslmode=disable"
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Skipf("skipping: cannot build pool: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("skipping: db unreachable: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func deleteTestUnique(prefix string) string {
	return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
}

type deleteUserFixture struct {
	pool     *pgxpool.Pool
	h        *Handler
	userID   string
	adminID  string
	adminJWT string
}

func setupDeleteUserFixture(t *testing.T) *deleteUserFixture {
	t.Helper()
	pool := deleteUserServicePool(t)
	ctx := context.Background()
	f := &deleteUserFixture{
		pool:    pool,
		userID:  deleteTestUnique("deluser-u"),
		adminID: deleteTestUnique("deluser-admin"),
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO claw_im_users (user_id, username, nickname, password_hash, status)
		VALUES ($1, $2, $3, 'x', 'active')`,
		f.userID, "u-"+f.userID, "删除用户测试"); err != nil {
		t.Fatalf("seed claw user: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO claw_admin_users (admin_id, username, nickname, password_hash, role_id)
		VALUES ($1, $2, $3, 'x', 'super_admin')`,
		f.adminID, "boss-"+f.adminID, "删除用户管理员"); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		// 用户行在删除成功后已不存在；这里的清理只兜底失败分支的残留。
		_, _ = pool.Exec(ctx, "DELETE FROM claw_im_user_quota WHERE user_id=$1", f.userID)
		_, _ = pool.Exec(ctx, "DELETE FROM claw_lobster WHERE user_id=$1", f.userID)
		_, _ = pool.Exec(ctx, "DELETE FROM im_contact_remark WHERE owner_user_id=$1", f.userID)
		_, _ = pool.Exec(ctx, "DELETE FROM im_friend_request WHERE from_user_id=$1 OR to_user_id=$1", f.userID)
		_, _ = pool.Exec(ctx, "UPDATE rongcloud_node SET claimed_by_user_id=NULL WHERE claimed_by_user_id=$1", f.userID)
		_, _ = pool.Exec(ctx, "DELETE FROM claw_im_users WHERE user_id=$1", f.userID)
		_, _ = pool.Exec(ctx, "DELETE FROM claw_admin_users WHERE admin_id=$1", f.adminID)
	})
	token, err := issueClawAdminJWT(f.adminID, "access", time.Hour)
	if err != nil {
		t.Fatalf("issue jwt: %v", err)
	}
	f.adminJWT = token
	// TxStarter 也指向 pool（pgxpool.Pool 同时实现 dbExecutor 与 txStarter，
	// 与生产 router.New 的接线一致）。
	f.h = &Handler{DB: pool, TxStarter: pool, Queries: db.New(pool)}
	return f
}

func (f *deleteUserFixture) adminReq(t *testing.T, method, target, userID string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	req.Header.Set("Authorization", "Bearer "+f.adminJWT)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", userID)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

func decodeDeleteBody(t *testing.T, rr *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()
	var body map[string]interface{}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %v (%s)", err, rr.Body.String())
	}
	if data, ok := body["data"].(map[string]interface{}); ok {
		return data
	}
	return body
}

func TestClawAdminDeleteUserCleansUpRelatedRows(t *testing.T) {
	f := setupDeleteUserFixture(t)
	ctx := context.Background()

	// 依赖行：quota（FK）、lobster（FK）、备注（软引用）、好友申请（软引用）。
	if _, err := f.pool.Exec(ctx,
		"INSERT INTO claw_im_user_quota (user_id, discussion_limit) VALUES ($1, 3)", f.userID); err != nil {
		t.Fatalf("seed quota: %v", err)
	}
	if _, err := f.pool.Exec(ctx,
		"INSERT INTO claw_lobster (id, user_id, name) VALUES ($1, $2, $3)",
		deleteTestUnique("lobster"), f.userID, "测试龙虾"); err != nil {
		t.Fatalf("seed lobster: %v", err)
	}
	if _, err := f.pool.Exec(ctx,
		"INSERT INTO im_contact_remark (owner_user_id, target_user_id, remark) VALUES ($1, $2, $3)",
		f.userID, "rc_node_someone", "旧机器"); err != nil {
		t.Fatalf("seed remark: %v", err)
	}
	if _, err := f.pool.Exec(ctx,
		"INSERT INTO im_friend_request (from_user_id, to_user_id, device_node_id) VALUES ($1, $2, $3)",
		f.userID, "rc_node_owner", "rc_node_target"); err != nil {
		t.Fatalf("seed friend request: %v", err)
	}

	rr := httptest.NewRecorder()
	f.h.ClawAdminDeleteUser(rr, f.adminReq(t, http.MethodDelete, "/api/admin/users/"+f.userID, f.userID))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	body := decodeDeleteBody(t, rr)
	if body["ok"] != true {
		t.Fatalf("ok = %v", body["ok"])
	}
	// 融云集成未接线（RongCloudNode 为 nil）：如实标注未注销，不算失败。
	if body["rongcloud_deactivated"] != false {
		t.Fatalf("rongcloud_deactivated = %v, want false", body["rongcloud_deactivated"])
	}

	var n int
	if err := f.pool.QueryRow(ctx, "SELECT COUNT(*) FROM claw_im_users WHERE user_id=$1", f.userID).Scan(&n); err != nil || n != 0 {
		t.Fatalf("user row still present: n=%d err=%v", n, err)
	}
	for _, tc := range []struct{ label, sql string }{
		{"quota", "SELECT COUNT(*) FROM claw_im_user_quota WHERE user_id=$1"},
		{"lobster", "SELECT COUNT(*) FROM claw_lobster WHERE user_id=$1"},
		{"remark", "SELECT COUNT(*) FROM im_contact_remark WHERE owner_user_id=$1"},
		{"friend request", "SELECT COUNT(*) FROM im_friend_request WHERE from_user_id=$1"},
	} {
		if err := f.pool.QueryRow(ctx, tc.sql, f.userID).Scan(&n); err != nil || n != 0 {
			t.Fatalf("%s row still present: n=%d err=%v", tc.label, n, err)
		}
	}
}

func TestClawAdminDeleteUserUnknownIDReturns404(t *testing.T) {
	f := setupDeleteUserFixture(t)
	rr := httptest.NewRecorder()
	// 运维账号 / 纯融云账号不在 claw_im_users：404，不会误删任何行。
	f.h.ClawAdminDeleteUser(rr, f.adminReq(t, http.MethodDelete, "/api/admin/users/rc_node_xxx_ops", "rc_node_xxx_ops"))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
}

func TestClawAdminDeleteUserRequiresAuth(t *testing.T) {
	f := setupDeleteUserFixture(t)
	req := httptest.NewRequest(http.MethodDelete, "/api/admin/users/"+f.userID, nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", f.userID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rr := httptest.NewRecorder()
	f.h.ClawAdminDeleteUser(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "Missing authentication token") {
		t.Fatalf("body = %s", rr.Body.String())
	}
}
