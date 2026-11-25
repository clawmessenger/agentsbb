// 外部应用接入（P2）：犇马 / SuperWagie 场景的「虾说身份初始化」与「窗口登录票据」。
//
// 两条路由，都是应用级凭据（AppId + AppSecret），不是用户 Bearer：
//
//	POST /api/claw/app/session/init        按 (appId, externalUserId) 幂等建号并返回用户 token
//	POST /api/claw/app/web-login-ticket    为内嵌窗口签发一次性登录票据（5 分钟）
//
// 为什么需要它们：犇马自己的用户第一次进虾说时，虾说侧还没有任何账号，也就没有
// token 可用。让犇马替用户注册/存密码是不可接受的（等于把虾说账号体系暴露成一个
// 开放注册接口），所以用应用凭据换「这个外部用户对应的虾说账号」。
//
// 账号派生是确定性的（见 clawAppUserID）：同一个 (appId, externalUserId) 永远得到
// 同一个 user_id，并发 init 时靠 claw_im_users 主键冲突天然收敛成一个账号，不依赖
// 「先查后插」这种有竞态的写法。
//
// 窗口登录**不传 token**：票据一次性、只含随机串、库里只存 sha256，由已有的
// /api/auth/web-qr/sessions/{ticket}/exchange 兑换成登录态。把 token 塞进 URL 会
// 留在浏览器历史、Referer 和窗口的地址栏里，一旦泄露就是永久凭据。
package handler

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// clawAppSessionTicketTTL 是窗口登录票据的有效期。比扫码登录的 180 秒长一点：
// 票据是服务端自己签的，不存在「用户还没扫完」的问题，5 分钟足够窗口加载。
const clawAppSessionTicketTTL = 5 * time.Minute

// clawAppIDPattern 限制 appId 可用字符：它会进 user_id（融云 id 的字集更窄），
// 也进日志与审计，放开只会引来转义问题。
var clawAppIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{1,31}$`)

// clawAppClient 是一行 claw_app_clients。
type clawAppClient struct {
	AppID      string
	SecretHash string
	Name       string
	Status     string
	RatePerMin int
	LastUsedAt *time.Time
}

// clawAppAuth 校验应用级凭据。
//
// 凭据走两个请求头：X-App-Id / X-App-Secret。不用 Authorization 是因为它已经被
// 用户 Bearer 占用（同一套 nginx 透传），混在一起会让「这是应用还是用户」变成
// 靠前缀猜。secret 比较用常数时间。
func (h *Handler) clawAppAuth(r *http.Request) (clawAppClient, error) {
	if h.DB == nil {
		return clawAppClient{}, errors.New("database not configured")
	}
	appID := strings.TrimSpace(r.Header.Get("X-App-Id"))
	secret := strings.TrimSpace(r.Header.Get("X-App-Secret"))
	if appID == "" || secret == "" {
		return clawAppClient{}, errClawAppUnauthorized
	}
	if !clawAppIDPattern.MatchString(appID) {
		return clawAppClient{}, errClawAppUnauthorized
	}
	var client clawAppClient
	err := h.DB.QueryRow(r.Context(),
		`SELECT app_id, app_secret_hash, name, status, rate_per_min
		   FROM claw_app_clients WHERE app_id = $1`, appID,
	).Scan(&client.AppID, &client.SecretHash, &client.Name, &client.Status, &client.RatePerMin)
	if errors.Is(err, pgx.ErrNoRows) {
		return clawAppClient{}, errClawAppUnauthorized
	}
	if err != nil {
		return clawAppClient{}, err
	}
	if client.Status != "active" {
		return clawAppClient{}, errClawAppDisabled
	}
	sum := sha256.Sum256([]byte(secret))
	// 常数时间比较：长度不同时 subtle 直接返回 0，不需要额外分支。
	if subtle.ConstantTimeCompare([]byte(hex.EncodeToString(sum[:])), []byte(client.SecretHash)) != 1 {
		return clawAppClient{}, errClawAppUnauthorized
	}
	return client, nil
}

var (
	errClawAppUnauthorized = errors.New("invalid app credentials")
	errClawAppDisabled     = errors.New("app disabled")
)

// clawAppUserID 从 (appId, externalUserId) 确定性派生虾说 user_id。
//
// 形状 app_<appId>_<16 位 hash>：appId 段是给人看的（排查时一眼知道哪个应用），
// hash 段保证「外部 id 里有分隔符/超长/大小写不同」都不会撞或截断。总长 ≤ 37，
// 在融云 user id 的 64 上限之内。
//
// 不用 app_<appId>_<externalUserId> 直拼：外部 id 由对方系统决定，可能 100 字符、
// 可能带 @ 或空格，直接拼会同时踩长度和字集两个限制，而且截断后互相撞车。
func clawAppUserID(appID, externalUserID string) string {
	sum := sha256.Sum256([]byte(appID + "\x00" + externalUserID))
	return "app_" + appID + "_" + hex.EncodeToString(sum[:])[:16]
}

// ClawAppInitSession POST /api/claw/app/session/init
func (h *Handler) ClawAppInitSession(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	client, err := h.clawAppAuth(r)
	if err != nil {
		clawAppAuthError(w, err)
		return
	}
	if !h.clawAppRateOK(w, client) {
		return
	}
	var req struct {
		ExternalUserID string `json:"externalUserId"`
		DisplayName    string `json:"displayName"`
		// AvatarURL 可选：外部应用已经有用户头像时直接沿用，省掉壳里的裸 id 头像。
		AvatarURL string `json:"avatarUrl"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		clawJSON(w, 400, 400, "请求参数错误", nil)
		return
	}
	externalUserID := strings.TrimSpace(req.ExternalUserID)
	if externalUserID == "" || len(externalUserID) > 200 {
		clawJSON(w, 400, 400, "externalUserId 不能为空且不超过 200 字符", nil)
		return
	}
	displayName := strings.TrimSpace(req.DisplayName)
	if len([]rune(displayName)) > 64 {
		clawJSON(w, 400, 400, "displayName 不超过 64 字", nil)
		return
	}

	created, err := h.clawAppEnsureUser(ctx, client.AppID, externalUserID, displayName, strings.TrimSpace(req.AvatarURL))
	if err != nil {
		slog.Error("claw: app session init failed", "appId", client.AppID, "error", err)
		clawJSON(w, 500, 500, "初始化用户失败", nil)
		return
	}

	token, err := h.clawAppMintToken(ctx, created.UserID, created.Nickname, created.Username, created.PortraitURI)
	if err != nil {
		slog.Error("claw: app session init mint token", "appId", client.AppID, "userId", created.UserID, "error", err)
		clawJSON(w, 500, 500, "获取IM Token失败", nil)
		return
	}

	h.clawAppTouchClient(ctx, client.AppID)

	clawJSON(w, 200, 200, "ok", map[string]interface{}{
		"userId":      created.UserID,
		"username":    created.Username,
		"nickname":    created.Nickname,
		"portraitUri": created.PortraitURI,
		"token":       token,
		// created=false 表示这是重复 init（幂等命中），方便对方区分「首次建号」。
		"created": created.IsNew,
	})
}

// ClawAppWebLoginTicket POST /api/claw/app/web-login-ticket
//
// 票据直接用 im_web_login_sessions 那张表：status 一栏填 confirmed 就等于「已经
// 被确认过」，已有的 exchange 接口拿到它就走完登录，不需要为犇马另写一条兑换链路
// （多一条兑换链路 = 多一份「一次性」与过期语义要维护）。
func (h *Handler) ClawAppWebLoginTicket(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	client, err := h.clawAppAuth(r)
	if err != nil {
		clawAppAuthError(w, err)
		return
	}
	if !h.clawAppRateOK(w, client) {
		return
	}
	var req struct {
		ExternalUserID string `json:"externalUserId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		clawJSON(w, 400, 400, "请求参数错误", nil)
		return
	}
	externalUserID := strings.TrimSpace(req.ExternalUserID)
	if externalUserID == "" || len(externalUserID) > 200 {
		clawJSON(w, 400, 400, "externalUserId 不能为空且不超过 200 字符", nil)
		return
	}

	// 票据必须绑到一个已存在的虾说账号：没有 init 就没有账号，先建号再签发。
	user, err := h.clawAppEnsureUser(ctx, client.AppID, externalUserID, "", "")
	if err != nil {
		slog.Error("claw: app login ticket ensure user", "appId", client.AppID, "error", err)
		clawJSON(w, 500, 500, "初始化用户失败", nil)
		return
	}
	if user.Status != "active" {
		clawJSON(w, 403, 403, "账号已被禁用", nil)
		return
	}

	ticket, err := clawNewWebLoginTicket()
	if err != nil {
		clawJSON(w, 500, 500, "生成登录票据失败", nil)
		return
	}
	expiresAt := time.Now().UTC().Add(clawAppSessionTicketTTL)
	if _, err := h.DB.Exec(ctx,
		`INSERT INTO im_web_login_sessions (ticket_hash, status, expires_at, user_id)
		 VALUES ($1, 'confirmed', $2, $3)`,
		clawWebLoginTicketHash(ticket), expiresAt, user.UserID,
	); err != nil {
		slog.Error("claw: app login ticket insert", "appId", client.AppID, "error", err)
		clawJSON(w, 500, 500, "生成登录票据失败", nil)
		return
	}

	h.clawAppTouchClient(ctx, client.AppID)

	// loginUrl 给内嵌窗口直接用（?login_ticket=），exchangeUrl 给不想改前端的
	// 对端自己换。两者都指向本服务，不依赖对方拼路径。
	base := clawAppWebBaseURL()
	clawJSON(w, 200, 200, "ok", map[string]interface{}{
		"ticket":      ticket,
		"expiresAt":   clawWebLoginExpiresAt(expiresAt),
		"userId":      user.UserID,
		"exchangeUrl": "/api/auth/web-qr/sessions/" + ticket + "/exchange",
		"loginUrl":    base + "/?login_ticket=" + ticket,
	})
}

// clawAppEnsureUser 幂等建号/取号。
func (h *Handler) clawAppEnsureUser(ctx context.Context, appID, externalUserID, displayName, avatarURL string) (clawAppUser, error) {
	userID := clawAppUserID(appID, externalUserID)
	portrait := avatarURL
	if portrait == "" {
		portrait = h.clawDefaultPortraitForNewUser()
	}
	nickname := displayName
	if nickname == "" {
		// 没有显示名时给一个稳定可读的兜底（不是随机串，用户重复 init 看到的
		// 名字要一致）。
		nickname = "犇马用户" + strings.ToUpper(userID[len(userID)-4:])
	}

	// 1. 先按映射表取（常规路径：账号已存在，这里只更新显示名）。
	var existing clawAppUser
	err := h.DB.QueryRow(ctx,
		`SELECT u.user_id, u.username, COALESCE(u.nickname,''), COALESCE(u.portrait_uri,''),
		        u.status, COALESCE(u.rongcloud_token,'')
		   FROM claw_app_identities i
		   JOIN claw_im_users u ON u.user_id = i.claw_user_id
		  WHERE i.app_id = $1 AND i.external_user_id = $2`,
		appID, externalUserID,
	).Scan(&existing.UserID, &existing.Username, &existing.Nickname, &existing.PortraitURI,
		&existing.Status, &existing.RCToken)
	if err == nil {
		if displayName != "" && displayName != existing.Nickname {
			if _, uErr := h.DB.Exec(ctx,
				"UPDATE claw_im_users SET nickname=$1, updated_at=now() WHERE user_id=$2",
				displayName, existing.UserID); uErr == nil {
				existing.Nickname = displayName
			} else {
				slog.Warn("claw: app user rename failed", "userId", existing.UserID, "error", uErr)
			}
		}
		if avatarURL != "" && avatarURL != existing.PortraitURI {
			if _, uErr := h.DB.Exec(ctx,
				"UPDATE claw_im_users SET portrait_uri=$1, updated_at=now() WHERE user_id=$2",
				avatarURL, existing.UserID); uErr == nil {
				existing.PortraitURI = avatarURL
			}
		}
		return existing, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return clawAppUser{}, err
	}

	// 2. 建号。user_id 是确定性的，并发 init 会撞主键 —— ON CONFLICT DO NOTHING
	// 让其中一个安静失败，随后统一走「读回来」这条路径，不会产生两个账号。
	password := make([]byte, 32)
	if _, err := rand.Read(password); err != nil {
		return clawAppUser{}, err
	}
	_, err = h.DB.Exec(ctx,
		`INSERT INTO claw_im_users
		   (user_id, username, nickname, portrait_uri, password_hash, status, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, 'active', now(), now())
		 ON CONFLICT (user_id) DO NOTHING`,
		// username 直接用派生 id：它既是唯一值，又不可能被当成邮箱/手机号登录
		// （clawQueryUserByIdentifier 的 OR 里 username 会命中，但没人知道这个串，
		// 密码也是随机的 —— 等价于「只能通过应用凭据进入」）。
		userID, userID, nickname, portrait, clawHashPassword(base64.RawURLEncoding.EncodeToString(password)),
	)
	if err != nil {
		return clawAppUser{}, err
	}
	// 映射行同理幂等：并发时只有一行进去。
	if _, err := h.DB.Exec(ctx,
		`INSERT INTO claw_app_identities
		   (app_id, external_user_id, claw_user_id, display_name, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, now(), now())
		 ON CONFLICT (app_id, external_user_id) DO UPDATE
		   SET claw_user_id = EXCLUDED.claw_user_id, updated_at = now()`,
		appID, externalUserID, userID, displayName,
	); err != nil {
		return clawAppUser{}, err
	}

	var out clawAppUser
	err = h.DB.QueryRow(ctx,
		`SELECT user_id, username, COALESCE(nickname,''), COALESCE(portrait_uri,''), status, COALESCE(rongcloud_token,'')
		   FROM claw_im_users WHERE user_id = $1`, userID,
	).Scan(&out.UserID, &out.Username, &out.Nickname, &out.PortraitURI, &out.Status, &out.RCToken)
	if err != nil {
		return clawAppUser{}, err
	}
	out.IsNew = true
	return out, nil
}

// clawAppMintToken 复用库内存量 token（与登录同一策略，见 clawResolveLoginToken）；
// 缺失时才向融云申请并回写。
func (h *Handler) clawAppMintToken(ctx context.Context, userID, nickname, username, portrait string) (string, error) {
	var stored string
	if err := h.DB.QueryRow(ctx,
		"SELECT COALESCE(rongcloud_token,'') FROM claw_im_users WHERE user_id=$1", userID,
	).Scan(&stored); err != nil {
		return "", err
	}
	var mintErr error
	token, minted := clawResolveLoginToken(stored, func() (string, error) {
		rc := h.clawRong(ctx)
		if rc == nil {
			mintErr = errors.New("rongcloud 未配置")
			return "", mintErr
		}
		return rc.getUserToken(ctx, userID, clawRongDisplayName(nickname, username), portrait)
	})
	if token == "" {
		if mintErr != nil {
			return "", mintErr
		}
		return "", errors.New("empty token")
	}
	if minted {
		if _, err := h.DB.Exec(ctx,
			"UPDATE claw_im_users SET rongcloud_token=$1 WHERE user_id=$2", token, userID,
		); err != nil {
			return "", err
		}
	}
	return token, nil
}

// clawAppTouchClient 记一次使用时间（best-effort，失败不影响主流程）。
func (h *Handler) clawAppTouchClient(ctx context.Context, appID string) {
	if _, err := h.DB.Exec(ctx,
		"UPDATE claw_app_clients SET last_used_at=now() WHERE app_id=$1", appID,
	); err != nil {
		slog.Debug("claw: app client touch failed", "appId", appID, "error", err)
	}
}

func clawAppAuthError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errClawAppDisabled):
		clawJSON(w, 403, 403, "应用凭据已停用", nil)
	case errors.Is(err, errClawAppUnauthorized):
		w.Header().Set("WWW-Authenticate", `X-App-Id realm="agentsbb"`)
		clawJSON(w, 401, 401, "应用凭据无效", nil)
	default:
		clawJSON(w, 500, 500, "校验应用凭据失败", nil)
	}
}

// clawAppWebBaseURL 是内嵌窗口的入口地址（用于拼 loginUrl）。
// 优先专用变量，其次 app URL（MULTICA_APP_URL / FRONTEND_ORIGIN），最后回落
// MULTICA_PUBLIC_URL —— 部署上窗口和 C 端是同一个 webroot，正常情况前两者就够。
func clawAppWebBaseURL() string {
	for _, key := range []string{"CLAW_APP_WEB_BASE_URL", "MULTICA_APP_URL", "FRONTEND_ORIGIN", "MULTICA_PUBLIC_URL"} {
		if v := strings.TrimRight(strings.TrimSpace(os.Getenv(key)), "/"); v != "" {
			return v
		}
	}
	return ""
}

// ---- 应用维度限流 ---------------------------------------------------------
//
// 与 MCP 的按用户限流叠加而不是替代：用户维度防单账号刷，应用维度防一个坏掉的
// 对端（重试风暴、循环调用）把整台机器打满。速率取 claw_app_clients.rate_per_min，
// 所以是「每应用一份」，不能复用 MCP 那个全局固定速率的限流器。

type clawAppRateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*clawAppBucket
	now     func() time.Time
}

type clawAppBucket struct {
	tokens float64
	rate   float64
	last   time.Time
}

func newClawAppRateLimiter() *clawAppRateLimiter {
	return &clawAppRateLimiter{buckets: make(map[string]*clawAppBucket), now: time.Now}
}

// allow 消耗一个令牌。perMinute <= 0 视为关闭该应用的限流。
func (l *clawAppRateLimiter) allow(appID string, perMinute int) bool {
	if l == nil || appID == "" || perMinute <= 0 {
		return true
	}
	now := l.now()
	rate := float64(perMinute)
	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.buckets[appID]
	if !ok {
		b = &clawAppBucket{tokens: rate, rate: rate, last: now}
		l.buckets[appID] = b
	}
	// 管理端改速率后立刻生效，不需要重启（bucket 里存的是上一轮的速率）。
	if b.rate != rate {
		b.rate = rate
		if b.tokens > rate {
			b.tokens = rate
		}
	}
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens += elapsed * b.rate / 60.0
		if b.tokens > b.rate {
			b.tokens = b.rate
		}
		b.last = now
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// InitClawAppAccess 装配应用接入所需的进程内状态。与 InitClawMCP 同理必须是
// 显式初始化 + 纯指针字段：Handler 在大量测试里按值拷贝，藏 sync.Once 会触发
// go vet 的 copylocks。
func (h *Handler) InitClawAppAccess() {
	if h.ClawAppLimiter == nil {
		h.ClawAppLimiter = newClawAppRateLimiter()
	}
}

// clawAppRateOK 校验应用维度频控，超限时直接写 429 并返回 false。
func (h *Handler) clawAppRateOK(w http.ResponseWriter, client clawAppClient) bool {
	if h.ClawAppLimiter == nil {
		return true
	}
	if !h.ClawAppLimiter.allow(client.AppID, client.RatePerMin) {
		w.Header().Set("Retry-After", "60")
		clawJSON(w, 429, 429, "应用调用过于频繁，请稍后重试", nil)
		return false
	}
	return true
}

// clawAppUser 是 ensure 的返回视图。
type clawAppUser struct {
	UserID      string
	Username    string
	Nickname    string
	PortraitURI string
	Status      string
	RCToken     string
	IsNew       bool
}
