package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/rongcloud"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// newDeviceAuthHandler wires the two services the device-code endpoints read:
// the pairing service, and (for bind) nothing — bind's validation branches all
// run before NodeService.BindAgents, which cannot be constructed from this
// package, so the success path is covered at the service layer instead.
func newDeviceAuthHandler() *Handler {
	return &Handler{
		// DB backs clawSingleInstallWorkspace; the suite's testHandler does not
		// wire the rongcloud services this endpoint needs.
		DB:                testPool,
		Queries:           db.New(testPool),
		RongCloudPairing:  rongcloud.NewPairingService(db.New(testPool), nil, nil),
		devicePairLimiter: newDevicePairLimiter(),
	}
}

// seedClawWebUser inserts a claw_im_users row and returns (userID, token) so a
// request can authenticate the way the legacy web app does: Bearer <token>.
func seedClawWebUser(t *testing.T) (string, string) {
	t.Helper()
	userID := uuid.NewString()
	token := "tok_" + uuid.NewString()
	dbfx.InsertNoID(t, "claw_im_users", testutil.Cols{
		"user_id":         userID,
		"username":        "pair_" + userID[:8],
		"password_hash":   "x",
		"rongcloud_token": token,
		"status":          "active",
	}, "user_id = $1", userID)
	return userID, token
}

// seedRongCloudChannelInstallation makes clawSingleInstallWorkspace resolvable
// in the suite workspace. It reuses the fixture agent created by testutil.New.
func seedRongCloudChannelInstallation(t *testing.T) {
	t.Helper()
	var agentID string
	if err := testPool.QueryRow(context.Background(),
		`SELECT id FROM agent WHERE workspace_id = $1 LIMIT 1`, testWorkspaceID).Scan(&agentID); err != nil {
		t.Fatalf("find fixture agent: %v", err)
	}
	installationID := uuid.NewString()
	if _, err := testPool.Exec(context.Background(), `
		INSERT INTO channel_installation (id, workspace_id, agent_id, channel_type, config, status, installer_user_id)
		VALUES ($1, $2, $3, 'rongcloud', '{}'::jsonb, 'active', $4)
	`, installationID, testWorkspaceID, agentID, testUserID); err != nil {
		t.Fatalf("seed rongcloud installation: %v", err)
	}
	dbfx.Cleanup(t, "DELETE FROM channel_installation WHERE id = $1", installationID)
}

func TestClawCreateDeviceSessionRequiresMachineID(t *testing.T) {
	h := newDeviceAuthHandler()
	testutil.Call(t, h.ClawCreateDeviceSession,
		testutil.JSONRequest(http.MethodPost, "/api/claw/pairing/device", map[string]any{"hostname": "x"}),
	).Want(http.StatusBadRequest)
}

func TestClawCreateDeviceSessionReturnsUserCodeAndVerifyURL(t *testing.T) {
	seedRongCloudChannelInstallation(t)
	h := newDeviceAuthHandler()

	body := map[string]any{
		"machine_id": "machine-" + uuid.NewString(),
		"hostname":   "MacBook-Pro",
		"platform":   "darwin",
		"agents":     []string{"opencode", "hermes", "opencode", ""},
	}
	resp := testutil.Call(t, h.ClawCreateDeviceSession,
		testutil.JSONRequest(http.MethodPost, "/api/claw/pairing/device", body),
	).Want(http.StatusOK).Body

	var payload struct {
		Code int `json:"code"`
		Data struct {
			Ticket     string `json:"ticket"`
			UserCode   string `json:"user_code"`
			VerifyURL  string `json:"verify_url"`
			ExpiresAt  string `json:"expires_at"`
			IntervalMS int    `json:"interval_seconds"`
		} `json:"data"`
	}
	if err := json.Unmarshal(resp.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v (body %s)", err, resp.String())
	}
	data := payload.Data
	dbfx.Cleanup(t, "DELETE FROM rongcloud_pairing_session WHERE ticket = $1", data.Ticket)

	if len(data.UserCode) != 8 {
		t.Fatalf("user_code = %q, want 8 chars", data.UserCode)
	}
	for _, r := range data.UserCode {
		if !isUserCodeRune(r) {
			t.Fatalf("user_code %q contains %q outside the alphabet", data.UserCode, r)
		}
	}
	if want := "/pair?code=" + data.UserCode; len(data.VerifyURL) < len(want) ||
		data.VerifyURL[len(data.VerifyURL)-len(want):] != want {
		t.Fatalf("verify_url = %q, want suffix %q", data.VerifyURL, want)
	}
	// The reported agent list must be deduped and blank-free: the verify page
	// renders it verbatim as checkboxes.
	session, err := h.RongCloudPairing.GetSession(context.Background(), data.Ticket)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	var agents []string
	if err := json.Unmarshal(session.ReportedAgents, &agents); err != nil {
		t.Fatalf("decode reported_agents: %v", err)
	}
	if len(agents) != 2 || agents[0] != "opencode" || agents[1] != "hermes" {
		t.Fatalf("reported_agents = %v, want [opencode hermes]", agents)
	}
}

func TestClawCreateDeviceSessionRateLimited(t *testing.T) {
	seedRongCloudChannelInstallation(t)
	h := newDeviceAuthHandler()
	machine := "machine-" + uuid.NewString()
	for i := 0; i < devicePairRateMax; i++ {
		resp := testutil.Call(t, h.ClawCreateDeviceSession,
			testutil.JSONRequest(http.MethodPost, "/api/claw/pairing/device", map[string]any{"machine_id": machine}),
		).Want(http.StatusOK).Body
		var payload struct {
			Data struct {
				Ticket string `json:"ticket"`
			} `json:"data"`
		}
		_ = json.Unmarshal(resp.Bytes(), &payload)
		dbfx.Cleanup(t, "DELETE FROM rongcloud_pairing_session WHERE ticket = $1", payload.Data.Ticket)
	}
	testutil.Call(t, h.ClawCreateDeviceSession,
		testutil.JSONRequest(http.MethodPost, "/api/claw/pairing/device", map[string]any{"machine_id": machine}),
	).Want(http.StatusTooManyRequests)
}

func TestClawGetPairingByCodeHidesInternals(t *testing.T) {
	seedRongCloudChannelInstallation(t)
	h := newDeviceAuthHandler()
	_, token := seedClawWebUser(t)

	session := createDeviceSessionForTest(t, h, "hermes", "opencode")

	resp := testutil.Call(t, h.ClawGetPairingByCode,
		testutil.WithURLParams(
			testutil.WithHeaders(
				testutil.JSONRequest(http.MethodGet, "/api/claw/pairing/code/"+session.UserCode.String, nil),
				"Authorization", "Bearer "+token,
			),
			"code", session.UserCode.String,
		),
	).Want(http.StatusOK).Body

	var payload struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(resp.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, leaked := range []string{"machine_id", "ticket", "client_claim_key", "workspace_id"} {
		if _, ok := payload.Data[leaked]; ok {
			t.Fatalf("response leaks %q: %s", leaked, resp.String())
		}
	}
	if got := payload.Data["hostname"]; got != "MacBook-Pro" {
		t.Fatalf("hostname = %v, want MacBook-Pro", got)
	}
	agents, _ := payload.Data["agents"].([]any)
	if len(agents) != 2 {
		t.Fatalf("agents = %v, want 2 entries", payload.Data["agents"])
	}
}

func TestClawGetPairingByCodeUnknown(t *testing.T) {
	h := newDeviceAuthHandler()
	_, token := seedClawWebUser(t)
	testutil.Call(t, h.ClawGetPairingByCode,
		testutil.WithURLParams(
			testutil.WithHeaders(
				testutil.JSONRequest(http.MethodGet, "/api/claw/pairing/code/ZZZZZZZZ", nil),
				"Authorization", "Bearer "+token,
			),
			"code", "ZZZZZZZZ",
		),
	).Want(http.StatusNotFound)
}

func TestClawBindPairingByCodeRejectsPendingSession(t *testing.T) {
	seedRongCloudChannelInstallation(t)
	h := newDeviceAuthHandler()
	_, token := seedClawWebUser(t)
	session := createDeviceSessionForTest(t, h, "hermes")

	// status is still pending: the terminal has not claimed the session yet.
	testutil.Call(t, h.ClawBindPairingByCode,
		testutil.WithURLParams(
			testutil.WithHeaders(
				testutil.JSONRequest(http.MethodPost, "/api/claw/pairing/code/"+session.UserCode.String+"/bind",
					map[string]any{"agents": []string{"hermes"}}),
				"Authorization", "Bearer "+token,
			),
			"code", session.UserCode.String,
		),
	).Want(http.StatusConflict)
}

func TestClawBindPairingByCodeRejectsUnreportedAgent(t *testing.T) {
	seedRongCloudChannelInstallation(t)
	h := newDeviceAuthHandler()
	_, token := seedClawWebUser(t)
	code := "ABCD2345"
	dbfx.InsertNoID(t, "rongcloud_pairing_session", testutil.Cols{
		"workspace_id":       testWorkspaceID,
		"ticket":             "pt_" + uuid.NewString(),
		"user_code":          code,
		"status":             "claimed",
		"candidate_node_ids": testutil.Raw("'[]'::jsonb"),
		"reported_agents":    testutil.Raw(`'["hermes"]'::jsonb`),
		"device_info":        testutil.Raw(`'{"hostname":"Box","platform":"linux"}'::jsonb`),
		"expires_at":         testutil.Raw("now() + interval '10 minutes'"),
	}, "user_code = $1", code)

	testutil.Call(t, h.ClawBindPairingByCode,
		testutil.WithURLParams(
			testutil.WithHeaders(
				testutil.JSONRequest(http.MethodPost, "/api/claw/pairing/code/"+code+"/bind",
					map[string]any{"agents": []string{"codex"}}),
				"Authorization", "Bearer "+token,
			),
			"code", code,
		),
	).Want(http.StatusBadRequest)
}

func TestClawBindPairingByCodeRejectsExpiredSession(t *testing.T) {
	seedRongCloudChannelInstallation(t)
	h := newDeviceAuthHandler()
	_, token := seedClawWebUser(t)
	code := "WXYZ2345"
	dbfx.InsertNoID(t, "rongcloud_pairing_session", testutil.Cols{
		"workspace_id":       testWorkspaceID,
		"ticket":             "pt_" + uuid.NewString(),
		"user_code":          code,
		"status":             "claimed",
		"candidate_node_ids": testutil.Raw("'[]'::jsonb"),
		"reported_agents":    testutil.Raw(`'["hermes"]'::jsonb`),
		"device_info":        testutil.Raw(`'{"hostname":"Box","platform":"linux"}'::jsonb`),
		"expires_at":         testutil.Raw("now() - interval '1 minute'"),
	}, "user_code = $1", code)

	testutil.Call(t, h.ClawBindPairingByCode,
		testutil.WithURLParams(
			testutil.WithHeaders(
				testutil.JSONRequest(http.MethodPost, "/api/claw/pairing/code/"+code+"/bind",
					map[string]any{"agents": []string{"hermes"}}),
				"Authorization", "Bearer "+token,
			),
			"code", code,
		),
	).Want(http.StatusGone)
}

func TestClawGetDeviceSessionReportsReadTimeExpiry(t *testing.T) {
	h := newDeviceAuthHandler()
	ticket := "pt_" + uuid.NewString()
	dbfx.InsertNoID(t, "rongcloud_pairing_session", testutil.Cols{
		"workspace_id":       testWorkspaceID,
		"ticket":             ticket,
		"user_code":          "JKLM2345",
		"status":             "pending",
		"candidate_node_ids": testutil.Raw("'[]'::jsonb"),
		"reported_agents":    testutil.Raw("'[]'::jsonb"),
		"device_info":        testutil.Raw("'{}'::jsonb"),
		"expires_at":         testutil.Raw("now() - interval '1 second'"),
	}, "ticket = $1", ticket)

	resp := testutil.Call(t, h.ClawGetDeviceSession,
		testutil.WithURLParams(
			testutil.JSONRequest(http.MethodGet, "/api/claw/pairing/device/"+ticket, nil),
			"ticket", ticket,
		),
	).Want(http.StatusOK).Body
	var payload struct {
		Data struct {
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(resp.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// The DB row still says pending; the poller must see expired.
	if payload.Data.Status != "expired" {
		t.Fatalf("status = %q, want expired (body %s)", payload.Data.Status, resp.String())
	}
}

func createDeviceSessionForTest(t *testing.T, h *Handler, agents ...string) db.RongcloudPairingSession {
	t.Helper()
	wsID := mustParseUUID(t, testWorkspaceID)
	session, err := h.RongCloudPairing.CreateDeviceSession(context.Background(), rongcloud.DeviceSessionParams{
		WorkspaceID: wsID,
		MachineID:   "machine-" + uuid.NewString(),
		Hostname:    "MacBook-Pro",
		Platform:    "darwin",
		Agents:      agents,
		ExpiresIn:   10 * time.Minute,
	})
	if err != nil {
		t.Fatalf("CreateDeviceSession: %v", err)
	}
	dbfx.Cleanup(t, "DELETE FROM rongcloud_pairing_session WHERE ticket = $1", session.Ticket)
	return session
}

func mustParseUUID(t *testing.T, s string) pgtype.UUID {
	t.Helper()
	u, err := uuid.Parse(s)
	if err != nil {
		t.Fatalf("parse uuid %q: %v", s, err)
	}
	return pgtype.UUID{Bytes: u, Valid: true}
}

func isUserCodeRune(r rune) bool {
	const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
	for _, a := range alphabet {
		if a == r {
			return true
		}
	}
	return false
}

// TestClawWebBaseURL pins the verify-link base resolution: an operator-set
// value wins, an unset value follows the request (so a domain move needs no
// .env edit), and the pre-2.0 host keeps its /claw-web mount so that
// deployment does not start printing links that 404.
func TestClawWebBaseURL(t *testing.T) {
	cases := []struct {
		name     string
		base     string
		prefix   string
		target   string
		fwdHost  string
		fwdProto string
		want     string
	}{
		{
			name:   "explicit base wins and drops the trailing slash",
			base:   "https://agentsbb.quukk.com/",
			target: "http://127.0.0.1:58081/api/claw/pairing/device",
			want:   "https://agentsbb.quukk.com",
		},
		{
			name:   "root deployment follows the request host",
			target: "https://agentsbb.quukk.com/api/claw/pairing/device",
			want:   "https://agentsbb.quukk.com",
		},
		{
			name:     "forwarded host beats the upstream hop",
			target:   "http://10.0.0.5:58081/api/claw/pairing/device",
			fwdHost:  "agentsbb.quukk.com",
			fwdProto: "https",
			want:     "https://agentsbb.quukk.com",
		},
		{
			name:   "legacy host keeps its web mount",
			target: "https://newsradar.dreamdt.cn/im/api/claw/pairing/device",
			want:   "https://newsradar.dreamdt.cn/claw-web",
		},
		{
			name:   "path prefix env wins over the legacy default",
			prefix: "/assets/app",
			target: "https://newsradar.dreamdt.cn/im/api/claw/pairing/device",
			want:   "https://newsradar.dreamdt.cn/assets/app",
		},
		{
			name:   "path prefix slash means root",
			prefix: "/",
			target: "https://newsradar.dreamdt.cn/im/api/claw/pairing/device",
			want:   "https://newsradar.dreamdt.cn",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(clawWebBaseEnv, tc.base)
			t.Setenv(clawWebPathPrefixEnv, tc.prefix)
			// A developer .env must not leak into these expectations.
			t.Setenv(brandingPublicBaseEnv, "")

			req := httptest.NewRequest(http.MethodPost, tc.target, nil)
			if tc.fwdHost != "" {
				req.Header.Set("X-Forwarded-Host", tc.fwdHost)
			}
			if tc.fwdProto != "" {
				req.Header.Set("X-Forwarded-Proto", tc.fwdProto)
			}
			if got := clawWebBaseURL(req); got != tc.want {
				t.Fatalf("clawWebBaseURL = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestClawWebBaseURLWithoutRequest keeps the last-resort value working: the
// request-free call path (a locally built server, a future worker) must still
// produce something usable rather than a relative link.
func TestClawWebBaseURLWithoutRequest(t *testing.T) {
	t.Setenv(clawWebBaseEnv, "")
	t.Setenv(clawWebPathPrefixEnv, "")
	t.Setenv(brandingPublicBaseEnv, "")
	if got := clawWebBaseURL(nil); got != defaultClawWebBaseURL {
		t.Fatalf("clawWebBaseURL(nil) = %q, want %q", got, defaultClawWebBaseURL)
	}
}
