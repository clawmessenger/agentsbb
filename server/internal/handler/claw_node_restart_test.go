package handler

// ClawRestartNode（POST /api/claw/nodes/{nodeId}/restart）的 handler 级测试。
//
// 这条路由补的是「用户态没有重启入口」那个洞：device/control/set 只认设备凭据，
// App 拿不到，于是「安全重启」在小程序里只能退化成一自然语言话术 —— 设备离线时
// 那句话没有执行者。这里钉住四件事：
//
//  1. 主人调用会写入 running + 版本推进（supervisor 靠「状态没变、版本变了」识别
//     重启，语义错一格就变成「什么都不做」或「把 agent 停了」）；
//  2. 设备离线时**照样写入**（排队语义）——不能因为 offline 就丢指令，否则「设备
//     离线 → 用户点重启 → 什么都没发生 → 设备上线也不动」这个最坑的路径又回来了；
//  3. 非主人一律 403，且**一个字节都没写**（重启会打断别人正在进行的对话）；
//  4. 连续点两次要能连续推进版本（版本不推进 = 第二次点击被 supervisor 当成重复）。
//
// 走 TestMain 的 testPool（DATABASE_URL 不可达时整个 package 跳过），造数套路与
// claw_node_status_runtime_test.go 一致。

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/integrations/rongcloud"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type clawRestartEnv struct {
	h        *Handler
	nodeID   string
	ownerTok string
	otherTok string
	nodeUUID string
}

// clawRestartTestEnv 造：一台节点（主人 = owner）、两个登录用户（owner / 陌生人）。
func clawRestartTestEnv(t *testing.T, machineID string) clawRestartEnv {
	t.Helper()
	ctx := context.Background()
	stamp := time.Now().UnixNano()

	owner := fmt.Sprintf("qa-restart-owner-%d", stamp)
	ownerTok := fmt.Sprintf("qa-restart-owner-tok-%d", stamp)
	other := fmt.Sprintf("qa-restart-other-%d", stamp)
	otherTok := fmt.Sprintf("qa-restart-other-tok-%d", stamp)
	rcUserID := fmt.Sprintf("rc_node_qa_restart_%d", stamp)
	nodeID := fmt.Sprintf("node_qa_restart_%d", stamp)

	for _, u := range []struct{ id, tok string }{{owner, ownerTok}, {other, otherTok}} {
		if _, err := testPool.Exec(ctx, `
			INSERT INTO claw_im_users (user_id, username, password_hash, rongcloud_token, status)
			VALUES ($1, $1, 'x', $2, 'active')`, u.id, u.tok); err != nil {
			t.Fatalf("insert claw_im_users: %v", err)
		}
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(),
			`DELETE FROM claw_im_users WHERE user_id = ANY($1)`, []string{owner, other})
	})

	var nodeUUID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO rongcloud_node (workspace_id, owner_user_id, rongcloud_user_id, node_id, machine_id, claimed_by_user_id)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
		RETURNING id::text`,
		testWorkspaceID, testUserID, rcUserID, nodeID, machineID, owner).Scan(&nodeUUID); err != nil {
		t.Fatalf("insert rongcloud_node: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(),
			`DELETE FROM rongcloud_node_control WHERE node_id = $1::uuid`, nodeUUID)
		_, _ = testPool.Exec(context.Background(),
			`DELETE FROM rongcloud_node WHERE id = $1::uuid`, nodeUUID)
	})

	h := &Handler{
		DB:            testPool,
		RongCloudNode: rongcloud.NewNodeService(db.New(testPool), rongcloud.NewRongCloudAPIClientForServices(nil, nil, nil), nil, nil),
	}
	return clawRestartEnv{h: h, nodeID: nodeID, ownerTok: ownerTok, otherTok: otherTok, nodeUUID: nodeUUID}
}

func (e clawRestartEnv) post(t *testing.T, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/claw/nodes/"+e.nodeID+"/restart", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("nodeId", e.nodeID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rr := httptest.NewRecorder()
	e.h.ClawRestartNode(rr, req)
	return rr
}

func (e clawRestartEnv) controlRow(t *testing.T) (state string, version int, changedBy string, ok bool) {
	t.Helper()
	err := testPool.QueryRow(context.Background(), `
		SELECT desired_state, desired_version, COALESCE(changed_by, '')
		  FROM rongcloud_node_control WHERE node_id = $1::uuid`, e.nodeUUID,
	).Scan(&state, &version, &changedBy)
	if err != nil {
		return "", 0, "", false
	}
	return state, version, changedBy, true
}

// TestClawRestartNodeQueuesRightStateAndBumpsVersion 钉住写成什么样。
//
// 三个字段错一个都出事：
//   - desired_state 必须是 running（写成 stopped 就是把用户的 agent 停了）；
//   - desired_version 必须 +1（不推进 = supervisor 认为「没有变化」，重启失效）；
//   - changed_by 要能看出是用户点的（排障时区分人工与设备自愈）。
func TestClawRestartNodeQueuesRightStateAndBumpsVersion(t *testing.T) {
	env := clawRestartTestEnv(t, "")

	rr := env.post(t, env.ownerTok)
	if rr.Code != http.StatusOK {
		t.Fatalf("HTTP %d, want 200 (body: %s)", rr.Code, rr.Body.String())
	}

	var body struct {
		Code int `json:"code"`
		Data struct {
			Queued         bool `json:"queued"`
			Online         bool `json:"online"`
			DesiredVersion int  `json:"desired_version"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body: %s)", err, rr.Body.String())
	}
	if body.Code != 200 || !body.Data.Queued {
		t.Fatalf("code=%d queued=%v, want 200/true (body: %s)", body.Code, body.Data.Queued, rr.Body.String())
	}
	// 测试环境里没有 supervisor 心跳，设备必然是离线 —— 这正是要覆盖的那条路径。
	if body.Data.Online {
		t.Fatal("online must be false without a live supervisor (the test env has no heartbeat)")
	}
	if body.Data.DesiredVersion < 1 {
		t.Fatalf("desired_version = %d, want >= 1", body.Data.DesiredVersion)
	}

	state, version, changedBy, ok := env.controlRow(t)
	if !ok {
		t.Fatal("no control row was written — 离线时排队正是这条接口的核心语义")
	}
	if state != "running" {
		t.Fatalf("desired_state = %q, want running（写 stopped 会直接停掉用户的 agent）", state)
	}
	if version < 1 {
		t.Fatalf("desired_version = %d, want >= 1", version)
	}
	if changedBy == "" || len(changedBy) < 5 || changedBy[:5] != "user:" {
		t.Fatalf("changed_by = %q, want a user:<id> prefix (要与设备自愈区分开)", changedBy)
	}
}

// TestClawRestartNodeAdvancesVersionEveryTime 连续两次点击必须都推进版本。
//
// supervisor 的判据是「状态没变、版本变了」。版本原地不动时第二次点击等于没点 ——
// 用户会看到「已下发」但什么都没发生，这比不给按钮更糟。
func TestClawRestartNodeAdvancesVersionEveryTime(t *testing.T) {
	env := clawRestartTestEnv(t, "")

	if rr := env.post(t, env.ownerTok); rr.Code != http.StatusOK {
		t.Fatalf("first restart: HTTP %d (body: %s)", rr.Code, rr.Body.String())
	}
	_, first, _, _ := env.controlRow(t)

	if rr := env.post(t, env.ownerTok); rr.Code != http.StatusOK {
		t.Fatalf("second restart: HTTP %d (body: %s)", rr.Code, rr.Body.String())
	}
	_, second, _, _ := env.controlRow(t)

	if second <= first {
		t.Fatalf("desired_version %d -> %d, want strictly increasing（第二次点击否则会被当成重复）", first, second)
	}
}

// TestClawRestartNodeRejectsNonOwner 非主人一律 403，且一个字节都不写。
//
// 重启会打断正在进行的对话，让「被分享者」也能按这个按钮等于给了对方一个
// 随手的拒绝服务开关。
func TestClawRestartNodeRejectsNonOwner(t *testing.T) {
	env := clawRestartTestEnv(t, "")

	rr := env.post(t, env.otherTok)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("HTTP %d, want 403 (body: %s)", rr.Code, rr.Body.String())
	}
	if _, _, _, ok := env.controlRow(t); ok {
		t.Fatal("a rejected restart must not write a control row")
	}
}

// TestClawRestartNodeRequiresLogin 没带 token 时不能匿名重启别人的设备。
func TestClawRestartNodeRequiresLogin(t *testing.T) {
	env := clawRestartTestEnv(t, "")

	req := httptest.NewRequest(http.MethodPost, "/api/claw/nodes/"+env.nodeID+"/restart", nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("nodeId", env.nodeID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rr := httptest.NewRecorder()
	env.h.ClawRestartNode(rr, req)

	if rr.Code == http.StatusOK {
		t.Fatalf("anonymous restart must not succeed (body: %s)", rr.Body.String())
	}
	if _, _, _, ok := env.controlRow(t); ok {
		t.Fatal("an anonymous request must not write a control row")
	}
}

// TestClawRestartNodeUnknownNodeIs404 不存在的节点：404，不要把 500 抛给前端。
func TestClawRestartNodeUnknownNodeIs404(t *testing.T) {
	env := clawRestartTestEnv(t, "")

	req := httptest.NewRequest(http.MethodPost, "/api/claw/nodes/node_does_not_exist/restart", nil)
	req.Header.Set("Authorization", "Bearer "+env.ownerTok)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("nodeId", "node_does_not_exist")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rr := httptest.NewRecorder()
	env.h.ClawRestartNode(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("HTTP %d, want 404 (body: %s)", rr.Code, rr.Body.String())
	}
}
