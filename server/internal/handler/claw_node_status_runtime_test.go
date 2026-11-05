package handler

// ClawNodeStatus 运行环境字段的 handler 级测试（设备详情字段扩展，QA 补测）。
//
// 背景：commit a2dc19f77 给 ClawNodeStatus（GET /api/claw/nodes/{nodeId}/status）
// 追加了 exe_version/exe_platform/hostname/install_dir/reported_at 五个字段，但
// handler 层没有任何用例钉住这条读路径 —— 列清单错位、machineIDForDevice 键
// 推导改坏、found=false 分支 500，这类回归只有打到真库的 handler 用例才能拦住。
//
// 三条用例对应 PRD §7 的验收口径：
//  1. 新设备：升级行齐全时五字段 + RFC3339 时间全部下发（§7.3 前半）；
//  2. 老设备：从未上报（upgrade 表无行，found=false）时字段全体缺省、HTTP 200
//     不 500（§7.2 —— 状态探针的主职责是在线判断，环境字段缺了前端显示「-」）；
//  3. 老机器键兜底：machine_id 为空的节点走 rc_node_ 前缀剥离后的键取到行
//     （架构设计 §7.4：读侧与上报侧键推导逐字一致，否则读不到自己刚写的行）。
//
// 走 TestMain 里那份 testPool（DATABASE_URL 不可达时整个 package 会跳过），
// 造数/清理套路与 claw_node_upgrade_test.go 的真库用例一致。

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
	"github.com/multica-ai/multica/server/internal/integrations/rongcloud"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// clawNodeStatusTestEnv 造好一个持有 token 的 claw 用户 + 一台节点，返回
// handler、nodeID 与 Bearer token。token 落在 claw_im_users.rongcloud_token 上，
// clawRequireClawUser 只认这一列。machineID 传空串即造「老机器」节点。
func clawNodeStatusTestEnv(t *testing.T, machineID string) (*Handler, string, string) {
	t.Helper()
	ctx := context.Background()
	stamp := time.Now().UnixNano()

	userID := fmt.Sprintf("qa-status-user-%d", stamp)
	token := fmt.Sprintf("qa-status-token-%d", stamp)
	rcUserID := fmt.Sprintf("rc_node_qa_status_%d", stamp)
	nodeID := fmt.Sprintf("node_qa_status_%d", stamp)

	if _, err := testPool.Exec(ctx, `
		INSERT INTO claw_im_users (user_id, username, password_hash, rongcloud_token, status)
		VALUES ($1, $2, 'x', $3, 'active')`,
		userID, userID, token); err != nil {
		t.Fatalf("insert claw_im_users: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(),
			`DELETE FROM claw_im_users WHERE user_id = $1`, userID)
	})

	if _, err := testPool.Exec(ctx, `
		INSERT INTO rongcloud_node (workspace_id, owner_user_id, rongcloud_user_id, node_id, machine_id)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
		testWorkspaceID, testUserID, rcUserID, nodeID, machineID); err != nil {
		t.Fatalf("insert rongcloud_node: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(),
			`DELETE FROM rongcloud_node WHERE rongcloud_user_id = $1`, rcUserID)
	})

	// NodeService 挂真库 queries：GetNodeByNodeID 命中上面那行；
	// OmStatusForNode 会按机器键查 ops 节点（找不到就 found=false，安全）。
	// RongCloud HTTP 客户端不带凭据（ensureCreds 无 loader 时是 no-op），
	// 不会打真实融云网络 —— 与 rongcloud_handler_refresh_token_test.go 同款。
	h := &Handler{
		DB:            testPool,
		RongCloudNode: rongcloud.NewNodeService(db.New(testPool), rongcloud.NewRongCloudAPIClientForServices(nil, nil, nil), nil, nil),
	}
	return h, nodeID, token
}

// clawNodeStatusRequest 造一个带 chi 路由参数与 Bearer token 的 GET 请求并打进去。
func clawNodeStatusRequest(t *testing.T, h *Handler, nodeID, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/claw/nodes/"+nodeID+"/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("nodeId", nodeID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rr := httptest.NewRecorder()
	h.ClawNodeStatus(rr, req)
	return rr
}

// clawNodeStatusData 断言 code=200 并解出 clawEnvelope.data。
func clawNodeStatusData(t *testing.T, rr *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body struct {
		Code int            `json:"code"`
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body %q: %v", rr.Body.String(), err)
	}
	if body.Code != 200 {
		t.Fatalf("code = %d, want 200 (body: %s)", body.Code, rr.Body.String())
	}
	return body.Data
}

// TestClawNodeStatusCarriesTheRuntimeEnvFields 钉住新设备的五字段 + 时间：
// 升级行齐全时全部下发，字段名 snake_case、时间 RFC3339 可解析（§7.3）。
func TestClawNodeStatusCarriesTheRuntimeEnvFields(t *testing.T) {
	if testPool == nil || testHandler == nil {
		t.Skip("handler test database is not available")
	}
	machine := clawUpgradeTestMachine("status-runtime")
	h, nodeID, token := clawNodeStatusTestEnv(t, machine)

	seed := `INSERT INTO rongcloud_node_upgrade
		(machine_id, workspace_id, reported_version, reported_platform, reported_hostname,
		 install_dir, remote_ip, remote_ip_at, reported_at, reported_generation)
		VALUES ($1, $2::uuid, '1.3.19', 'win32-x64', 'host-qa',
		        'C:\qa\bin', '203.0.113.9', now(), now(), 0)`
	if _, err := testPool.Exec(context.Background(), seed, machine, testWorkspaceID); err != nil {
		t.Fatalf("seed upgrade row: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(),
			`DELETE FROM rongcloud_node_upgrade WHERE machine_id = $1`, machine)
	})

	data := clawNodeStatusData(t, clawNodeStatusRequest(t, h, nodeID, token))
	for field, want := range map[string]string{
		"exe_version":  "1.3.19",
		"exe_platform": "win32-x64",
		"hostname":     "host-qa",
		"install_dir":  `C:\qa\bin`,
		"remote_ip":    "203.0.113.9",
	} {
		if got, _ := data[field].(string); got != want {
			t.Fatalf("%s = %q, want %q", field, got, want)
		}
	}
	rawAt, _ := data["reported_at"].(string)
	if rawAt == "" {
		t.Fatal("reported_at must be present for a fully reported machine")
	}
	if _, err := time.Parse(time.RFC3339, rawAt); err != nil {
		t.Fatalf("reported_at %q is not RFC3339: %v", rawAt, err)
	}
	// 公网 IP 三件套（服务端观测）：值 + 是否公网 + 观测时间。public 用 bool 而不是
	// 字符串，前端据此决定要不要打「内网」标记；时间同 RFC3339。
	if got, ok := data["remote_ip_public"].(bool); !ok || !got {
		t.Fatalf("remote_ip_public = %v (%T), want true", data["remote_ip_public"], data["remote_ip_public"])
	}
	rawIPAt, _ := data["remote_ip_at"].(string)
	if rawIPAt == "" {
		t.Fatal("remote_ip_at must be present together with remote_ip")
	}
	if _, err := time.Parse(time.RFC3339, rawIPAt); err != nil {
		t.Fatalf("remote_ip_at %q is not RFC3339: %v", rawIPAt, err)
	}
}

// TestClawNodeStatusOmitsRuntimeEnvForANeverReportedMachine 钉住老设备兜底：
// upgrade 表无行（found=false）时环境字段全体缺省、无 500 —— 在线状态照常下发
// （§7.2：字段缺了前端显示「-」，不能把状态探针打红）。
func TestClawNodeStatusOmitsRuntimeEnvForANeverReportedMachine(t *testing.T) {
	if testPool == nil || testHandler == nil {
		t.Skip("handler test database is not available")
	}
	machine := clawUpgradeTestMachine("status-never")
	h, nodeID, token := clawNodeStatusTestEnv(t, machine)

	data := clawNodeStatusData(t, clawNodeStatusRequest(t, h, nodeID, token))

	// online 是状态探针的本职，必须在；环境五字段一个都不该出现。
	if _, ok := data["online"]; !ok {
		t.Fatal("online must always be present — the status probe is the primary duty")
	}
	for _, field := range []string{"exe_version", "exe_platform", "hostname", "install_dir", "reported_at", "remote_ip", "remote_ip_public", "remote_ip_at"} {
		if _, ok := data[field]; ok {
			t.Fatalf("%s must be omitted for a never-reported machine, got %v", field, data[field])
		}
	}
}

// TestClawNodeStatusReadsViaTheRcNodeFallbackKey 钉住键一致性（§7.4）：
// machine_id 为空的老机器，读侧必须走 rc_node_ 前缀剥离后的键 —— 与上报侧
// machineIDForDevice 逐字一致，否则老机器读不到自己刚写的行。
func TestClawNodeStatusReadsViaTheRcNodeFallbackKey(t *testing.T) {
	if testPool == nil || testHandler == nil {
		t.Skip("handler test database is not available")
	}
	// machine_id 传空：节点的机器键由 rongcloud_user_id 剥 rc_node_ 前缀得出。
	h, nodeID, token := clawNodeStatusTestEnv(t, "")

	// 从节点反推期望键，升级行按这个键插（模拟老机器用兜底键上报过的历史数据）。
	var rcUserID string
	if err := testPool.QueryRow(context.Background(),
		`SELECT rongcloud_user_id FROM rongcloud_node WHERE node_id = $1`, nodeID).
		Scan(&rcUserID); err != nil {
		t.Fatalf("load rc id: %v", err)
	}
	fallbackKey := strings.TrimPrefix(rcUserID, "rc_node_")
	if fallbackKey == rcUserID {
		t.Fatalf("test node rc id %q must carry the rc_node_ prefix", rcUserID)
	}

	seed := `INSERT INTO rongcloud_node_upgrade
		(machine_id, workspace_id, reported_version, reported_platform, install_dir, reported_at)
		VALUES ($1, $2::uuid, '1.3.19', 'linux-x64', '/home/qa/.local/bin', now())`
	if _, err := testPool.Exec(context.Background(), seed, fallbackKey, testWorkspaceID); err != nil {
		t.Fatalf("seed upgrade row under the fallback key: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(),
			`DELETE FROM rongcloud_node_upgrade WHERE machine_id = $1`, fallbackKey)
	})

	data := clawNodeStatusData(t, clawNodeStatusRequest(t, h, nodeID, token))
	if got, _ := data["install_dir"].(string); got != "/home/qa/.local/bin" {
		t.Fatalf("install_dir = %q, want the row stored under the rc_node_ fallback key", got)
	}
	if got, _ := data["exe_version"].(string); got != "1.3.19" {
		t.Fatalf("exe_version = %q, want 1.3.19", got)
	}
}
