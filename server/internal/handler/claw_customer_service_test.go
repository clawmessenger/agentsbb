package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// csFakeDB 是只认 customer_service 那条 SELECT 的最小桩。
type csFakeDB struct {
	// config 为 nil = 库里没有这一行（pgx.ErrNoRows）。
	config []byte
}

func (f *csFakeDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	if !strings.Contains(sql, "customer_service") {
		return &groupStubRow{err: errors.New("unexpected sql: " + sql)}
	}
	if f.config == nil {
		return &groupStubRow{err: pgx.ErrNoRows}
	}
	return &groupStubRow{values: []any{f.config}}
}

func (f *csFakeDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("not stubbed")
}

func (f *csFakeDB) Exec(_ context.Context, _ string, _ ...any) (pgconn.CommandTag, error) {
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

// ClawCustomerService 的三条路径：没配置 → 空 qr_image；正常配置 → 透传；
// 坏 JSON → 空 qr_image（不让客服入口挂掉）。
func TestClawCustomerService(t *testing.T) {
	cases := []struct {
		name string
		db   *csFakeDB
		want string
	}{
		{
			name: "没配置 → 空 qr_image",
			db:   &csFakeDB{},
			want: "",
		},
		{
			name: "正常配置 → 透传 qr_image",
			db:   &csFakeDB{config: []byte(`{"qr_image":"https://agentsbb.quukk.com/uploads/branding/x.png"}`)},
			want: "https://agentsbb.quukk.com/uploads/branding/x.png",
		},
		{
			name: "坏 JSON → 空 qr_image",
			db:   &csFakeDB{config: []byte(`{not-json`)},
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := &Handler{DB: tc.db}
			rr := httptest.NewRecorder()
			h.ClawCustomerService(rr, httptest.NewRequest("GET", "/api/config/customer-service", nil))
			if rr.Code != http.StatusOK {
				t.Fatalf("状态码 = %d, want 200", rr.Code)
			}
			body := rr.Body.String()
			if !strings.Contains(body, `"qr_image":"`+tc.want+`"`) {
				t.Fatalf("回包缺 qr_image=%q: %s", tc.want, body)
			}
		})
	}
}
