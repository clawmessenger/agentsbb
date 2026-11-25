package handler

// 外部应用接入（犇马）的用例。
//
// 真实数据库部分只覆盖「建号幂等」这条不可回退的语义：同一 (appId, externalUserId)
// 反复 init 必须是同一个虾说账号，且显示名能更新。token 发放走融云，测试环境没有
// 融云凭据，所以不在端点层断言 —— 那一段复用既有登录策略（clawResolveLoginToken），
// 由登录用例覆盖。

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClawAppUserIDIsDeterministicAndSafe(t *testing.T) {
	first := clawAppUserID("benma", "user-1")
	second := clawAppUserID("benma", "user-1")
	if first != second {
		t.Fatalf("derivation not deterministic: %q vs %q", first, second)
	}
	// 外部 id 里有分隔符 / 大小写不同 / 很长时都不能撞车。
	cases := []struct{ app, ext string }{
		{"benma", "user_1"},
		{"benma", "user-2"},
		{"benma2", "user-1"},
		{"benma", "USER-1"},
		{"benma", string(make([]byte, 200))},
	}
	seen := map[string]string{first: "benma/user-1"}
	for _, c := range cases {
		id := clawAppUserID(c.app, c.ext)
		if len(id) > 64 {
			t.Fatalf("derived id too long for rongcloud: %d", len(id))
		}
		if !clawAppIDPattern.MatchString(c.app) {
			continue
		}
		key := c.app + "/" + c.ext
		if prev, ok := seen[id]; ok && prev != key {
			t.Fatalf("collision: %q and %q -> %q", prev, key, id)
		}
		seen[id] = key
	}
}

func TestClawAppIDPattern(t *testing.T) {
	valid := []string{"benma", "superwagie", "app1", "bm-2", "bm_3"}
	for _, id := range valid {
		if !clawAppIDPattern.MatchString(id) {
			t.Fatalf("%q should be a valid app id", id)
		}
	}
	// 大写、点号、空格、超长都拒 —— 这些会进 user_id 或日志，放开只会引来转义问题。
	invalid := []string{"Benma", "bm.app", "bm app", "a", "-bm", "bm!", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	for _, id := range invalid {
		if clawAppIDPattern.MatchString(id) {
			t.Fatalf("%q must be rejected", id)
		}
	}
}

func TestClawAppRateLimiterIsPerApp(t *testing.T) {
	clock := time.Unix(1_700_000_000, 0)
	limiter := newClawAppRateLimiter()
	limiter.now = func() time.Time { return clock }

	if !limiter.allow("app-a", 2) || !limiter.allow("app-a", 2) {
		t.Fatal("burst of 2 should pass")
	}
	if limiter.allow("app-a", 2) {
		t.Fatal("third call in the same second must be rejected")
	}
	// 另一个应用有自己的桶。
	if !limiter.allow("app-b", 2) {
		t.Fatal("buckets must be per app")
	}
	// rate_per_min <= 0 = 该应用不限流。
	if !limiter.allow("app-c", 0) {
		t.Fatal("perMinute<=0 must disable limiting for that app")
	}
	// 一分钟后回满。
	clock = clock.Add(time.Minute)
	if !limiter.allow("app-a", 2) {
		t.Fatal("tokens should refill after a minute")
	}
}

func TestClawAppRateLimiterFollowsRateChange(t *testing.T) {
	clock := time.Unix(1_700_000_000, 0)
	limiter := newClawAppRateLimiter()
	limiter.now = func() time.Time { return clock }

	// 先按 1/min 耗完。
	_ = limiter.allow("app-a", 1)
	if limiter.allow("app-a", 1) {
		t.Fatal("second call with rate 1 should be rejected")
	}
	// 管理端把速率调大后按新速率补充 —— 不是「立刻白送一桶」，而是下一秒就按
	// 120/min 补（1 秒 = 2 个令牌），不需要重启进程。
	clock = clock.Add(time.Second)
	if !limiter.allow("app-a", 120) {
		t.Fatal("rate change must take effect on the next refill")
	}
}

func TestClawAppWebBaseURLPrefersDedicatedEnv(t *testing.T) {
	t.Setenv("CLAW_APP_WEB_BASE_URL", "https://window.example/")
	t.Setenv("MULTICA_APP_URL", "https://app.example")
	if got := clawAppWebBaseURL(); got != "https://window.example" {
		t.Fatalf("got %q, want the dedicated base with trailing slash trimmed", got)
	}
	t.Setenv("CLAW_APP_WEB_BASE_URL", "")
	if got := clawAppWebBaseURL(); got != "https://app.example" {
		t.Fatalf("fallback got %q", got)
	}
}

// 建号幂等：同一个外部用户两次 init 只产生一个虾说账号，显示名以最后一次为准。
func TestClawAppEnsureUserIsIdempotent(t *testing.T) {
	if testHandler == nil || testHandler.DB == nil {
		t.Skip("handler test fixture not initialised (database unavailable)")
	}
	h := *testHandler
	appID := "testapp"
	externalID := "ext-" + time.Now().Format("150405.000000000")
	userID := clawAppUserID(appID, externalID)

	t.Cleanup(func() {
		dbfx.Exec(t, `DELETE FROM claw_app_identities WHERE app_id=$1 AND external_user_id=$2`, appID, externalID)
		dbfx.Exec(t, `DELETE FROM claw_im_users WHERE user_id=$1`, userID)
	})
	dbfx.Exec(t, `DELETE FROM claw_app_identities WHERE app_id=$1 AND external_user_id=$2`, appID, externalID)
	dbfx.Exec(t, `DELETE FROM claw_im_users WHERE user_id=$1`, userID)

	ctx := context.Background()
	first, err := h.clawAppEnsureUser(ctx, appID, externalID, "犇马-小张", "")
	if err != nil {
		t.Fatalf("first ensure: %v", err)
	}
	if !first.IsNew {
		t.Fatal("first ensure must report a new account")
	}
	if first.UserID != userID {
		t.Fatalf("user id = %q, want derived %q", first.UserID, userID)
	}
	if first.Nickname != "犇马-小张" {
		t.Fatalf("nickname = %q", first.Nickname)
	}

	second, err := h.clawAppEnsureUser(ctx, appID, externalID, "犇马-张三", "")
	if err != nil {
		t.Fatalf("second ensure: %v", err)
	}
	if second.IsNew {
		t.Fatal("second ensure must hit the existing account")
	}
	if second.UserID != first.UserID {
		t.Fatalf("second ensure created a different account: %q vs %q", second.UserID, first.UserID)
	}
	if second.Nickname != "犇马-张三" {
		t.Fatalf("display name not updated: %q", second.Nickname)
	}

	// 空显示名不能把已有昵称抹掉（窗口重开时对方可能只传 externalUserId）。
	third, err := h.clawAppEnsureUser(ctx, appID, externalID, "", "")
	if err != nil {
		t.Fatalf("third ensure: %v", err)
	}
	if third.Nickname != "犇马-张三" {
		t.Fatalf("blank displayName wiped the nickname: %q", third.Nickname)
	}

	var identities int
	if err := h.DB.QueryRow(ctx,
		`SELECT count(*) FROM claw_app_identities WHERE app_id=$1 AND external_user_id=$2`,
		appID, externalID,
	).Scan(&identities); err != nil {
		t.Fatalf("count identities: %v", err)
	}
	if identities != 1 {
		t.Fatalf("identity rows = %d, want 1", identities)
	}
}

// 未在册的应用凭据必须 401，且不建任何账号。
func TestClawAppAuthRejectsUnknownApp(t *testing.T) {
	if testHandler == nil || testHandler.DB == nil {
		t.Skip("handler test fixture not initialised (database unavailable)")
	}
	h := *testHandler
	req := httptest.NewRequest(http.MethodPost, "/api/claw/app/session/init", strings.NewReader(`{}`))
	req.Header.Set("X-App-Id", "nosuchapp")
	req.Header.Set("X-App-Secret", "whatever")
	if _, err := h.clawAppAuth(req); err == nil {
		t.Fatal("unknown app must be rejected")
	}
	// 缺头同样拒绝。
	empty := httptest.NewRequest(http.MethodPost, "/api/claw/app/session/init", strings.NewReader(`{}`))
	if _, err := h.clawAppAuth(empty); err == nil {
		t.Fatal("missing headers must be rejected")
	}
}
