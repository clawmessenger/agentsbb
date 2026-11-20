package handler

// 缺陷 D-002（2026-11-19）：注册表单标注「账号（邮箱或手机号）」，但服务端
// ClawRegister 只查重、不校验格式 —— 缺域名的邮箱、位数不对 / 0 开头 / 含字母的
// "手机号"（QA 给出的 6 个非法样本）都能 HTTP 200 注册成功并进入登录态。
//
// 校验收口在服务端（前端的提示只是第一道防线）。这里锁两件事：
//  1. `clawAccountFormatOK` 对 QA 全部非法样本拒绝、对合法形态放行（表驱动）；
//  2. 集成口径：非法账号注册返回 400 且**不落库**（不会留下半截账号）。
//
// 正向对照沿用 QA 的样本集：标准邮箱、短域名邮箱（a@b.c 也合法）、常规 11 位号段。

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestClawAccountFormatOK(t *testing.T) {
	valid := []string{
		"user@example.com",          // 标准邮箱
		"a@b.c",                     // 短域名邮箱（QA 正向对照）
		"user.name+tag@sub.ex.com",  // 带 local 标点与多级域名
		"13123456789",               // 常规 11 位号段
		"18912345678",               // 第二位 8
	}
	invalid := []string{
		"qabc672e60.example.com", // 缺 @（QA 非法样本）
		"qabc672e60@",            // 缺域名（QA 非法样本）
		"0000878688",             // 10 位（QA 非法样本）
		"000000878688",           // 12 位（QA 非法样本）
		"00000878688",            // 11 位但 0 开头（QA 非法样本）
		"1a160878688",            // 含字母（QA 非法样本）
		"12@x",                   // 域名无点
		"@example.com",           // 缺 local
		"",                       // 空（handler 层还有空判）
	}
	for _, account := range valid {
		if !clawAccountFormatOK(account) {
			t.Errorf("clawAccountFormatOK(%q) = false, want true", account)
		}
	}
	for _, account := range invalid {
		if clawAccountFormatOK(account) {
			t.Errorf("clawAccountFormatOK(%q) = true, want false", account)
		}
	}
}

// 集成口径：非法账号必须 400，且库里不能留下这一行。
func TestClawRegisterRejectsAnInvalidAccount(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database-backed handler tests are disabled")
	}
	username := "1a160878688-1" // 非法：11 位含字母，撞库概率可忽略
	req := testutil.JSONRequest(http.MethodPost, "/api/register", map[string]string{
		"username": username,
		"password": "secret123",
	})
	env := testutil.Call(t, testHandler.ClawRegister, req).Want(http.StatusBadRequest).Map()
	if msg, _ := env["message"].(string); msg == "" {
		t.Errorf("register response must carry a reason, got %#v", env)
	}

	var exists bool
	if err := testPool.QueryRow(t.Context(),
		`SELECT EXISTS(SELECT 1 FROM claw_im_users WHERE username = $1)`, username).Scan(&exists); err != nil {
		t.Fatalf("read back account: %v", err)
	}
	if exists {
		t.Fatal("rejected registration must not create a row")
	}
}

// D-015：注册账号本身是手机号/邮箱时，绑定列必须同步落库。否则账号安全页
// 显示「未绑定」，用户拿同一个值去绑又被自己占着的 username 挡住，看起来就是
// 「手机号和邮箱无法联动登录」。
func TestClawRegisterWritesBindingColumn(t *testing.T) {
	cases := []struct {
		account string
		column  string
	}{
		{"13800000001", "phone"},
		{"link@example.com", "email"},
	}
	for _, tc := range cases {
		t.Run(tc.account, func(t *testing.T) {
			fake := &accountSecDB{taken: map[string]bool{}}
			h := &Handler{DB: fake}
			req := httptest.NewRequest(http.MethodPost, "/api/register",
				strings.NewReader(fmt.Sprintf(`{"username":%q,"password":"secret123"}`, tc.account)))
			rr := httptest.NewRecorder()
			h.ClawRegister(rr, req)
			if rr.Code != http.StatusOK {
				t.Fatalf("status = %d (%s)", rr.Code, rr.Body.String())
			}
			if len(fake.execSQL) != 1 {
				t.Fatalf("exec calls = %d, want 1", len(fake.execSQL))
			}
			if !strings.Contains(fake.execSQL[0], tc.column+", status") {
				t.Fatalf("register SQL must write %s: %q", tc.column, fake.execSQL[0])
			}
			if got := fake.execArgs[0][5]; got != tc.account {
				t.Fatalf("binding arg = %v, want %q", got, tc.account)
			}
		})
	}
}

// 正向对照：合法手机号注册仍然成功（校验别把合法形态也挡了）。
func TestClawRegisterAcceptsAPhoneAccount(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database-backed handler tests are disabled")
	}
	username := fmt.Sprintf("137%08d", time.Now().UnixNano()%1_0000_0000)
	dbfx.Cleanup(t, `DELETE FROM claw_im_users WHERE username = $1`, username)

	req := testutil.JSONRequest(http.MethodPost, "/api/register", map[string]string{
		"username": username,
		"password": "secret123",
	})
	testutil.Call(t, testHandler.ClawRegister, req).Want(http.StatusOK)
}
