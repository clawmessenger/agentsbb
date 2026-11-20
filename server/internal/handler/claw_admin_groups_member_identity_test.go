package handler

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// clawResolveGroupMemberIDs 的打桩 DB：按 identifier 返回 claw_im_users 行，
// 或 pgx.ErrNoRows（AI 节点 / 运维账号不在表里）。
type memberIdentityFakeDB struct {
	queryRow func(sql string, args []any) pgx.Row
}

func (f *memberIdentityFakeDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	return f.queryRow(sql, args)
}
func (f *memberIdentityFakeDB) Query(_ context.Context, _ string, _ ...any) (pgx.Rows, error) {
	return nil, errors.New("Query not expected in this test")
}
func (f *memberIdentityFakeDB) Exec(_ context.Context, _ string, _ ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, errors.New("Exec not expected in this test")
}

// clawUserByIdentifierRow 构造 clawQueryUserByIdentifier 需要的 13 列值
// （第 12 列 rongcloud_token 扫进 sql.NullString，用 nil 表示 NULL）。
func clawUserByIdentifierRow(userID, username, phone string) []any {
	return []any{
		userID, username, "昵称", "", "a@b.com", phone, "", "", "", "active", "hash", nil, "",
	}
}

func TestClawResolveGroupMemberIDs(t *testing.T) {
	fake := &memberIdentityFakeDB{
		queryRow: func(query string, args []any) pgx.Row {
			if !strings.Contains(query, "FROM claw_im_users") {
				return &groupStubRow{err: errors.New("unexpected query: " + query)}
			}
			id, _ := args[0].(string)
			switch id {
			case "zhangsan", "13800000000", "rc-1001", "a@b.com":
				// 同一账号的 username / phone / user_id / email 都指向 rc-1001。
				return &groupStubRow{values: clawUserByIdentifierRow("rc-1001", "zhangsan", "13800000000")}
			default:
				// AI 节点、运维账号查不到。
				return &groupStubRow{err: pgx.ErrNoRows}
			}
		},
	}
	h := &Handler{DB: fake}

	got, err := h.clawResolveGroupMemberIDs(context.Background(), []string{
		"zhangsan", "13800000000", "rc-1001", "a@b.com",
		"rc_node_abc", "claw_42", "pi_3300776275", "rc-ops-1",
		"", "   ", "zhangsan", // 空值与重复项
	})
	if err != nil {
		t.Fatalf("clawResolveGroupMemberIDs: %v", err)
	}
	want := map[string]string{
		"zhangsan":    "rc-1001",
		"13800000000": "rc-1001",
		"rc-1001":     "rc-1001",
		"a@b.com":     "rc-1001",
	}
	if len(got) != len(want) {
		t.Fatalf("resolved = %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("resolved[%q] = %q, want %q", k, got[k], v)
		}
	}
	// 查不到的标识绝不能进 map（调用方据此原样保留）。
	for _, id := range []string{"rc_node_abc", "claw_42", "pi_3300776275", "rc-ops-1"} {
		if _, ok := got[id]; ok {
			t.Errorf("unknown id %q must not be resolved", id)
		}
	}
}

func TestClawResolveGroupMemberIDsNilDBDisables(t *testing.T) {
	h := &Handler{} // DB 为 nil：未装配 DB 的部署 / 测试
	got, err := h.clawResolveGroupMemberIDs(context.Background(), []string{"zhangsan"})
	if err != nil {
		t.Fatalf("nil DB must not error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("nil DB must disable resolution, got %v", got)
	}
}

func TestClawResolveGroupMemberIDsPropagatesDBFailure(t *testing.T) {
	sentinel := errors.New("db is down")
	h := &Handler{DB: &memberIdentityFakeDB{
		queryRow: func(string, []any) pgx.Row { return &groupStubRow{err: sentinel} },
	}}
	if _, err := h.clawResolveGroupMemberIDs(context.Background(), []string{"zhangsan"}); !errors.Is(err, sentinel) {
		t.Errorf("error = %v, want %v (integration layer falls back to legacy dedupe on this error)", err, sentinel)
	}
}

// 让编译器确认 sql.NullString 分支确实被覆盖（assignGroupScan 的 NULL 路径）。
var _ = sql.NullString{}
