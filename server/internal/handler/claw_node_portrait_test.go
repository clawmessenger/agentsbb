package handler

// 缺陷 D-004（2026-11-19）：「修改设备头像」写的是 rongcloud_user（融云账号资料
// 镜像，ClawUpdateNode → UpdateUserProfile），而设备列表 LegacyNodeRecords 的
// record 此前**不下发 portraitUri** —— 设备管理（Home.tsx 的
// avatarImg: node.portraitUri）与通讯录名片（contacts.ts 的 nodePortrait 优先链）
// 只能退到 IM SDK 的资料缓存，节点头像更新后这两处长期停留在旧默认图，与单聊
// 列表（读会话资料，已是新图）三个入口各不相同。
//
// 本用例钉住：record 必须带 portraitUri，且取值来自节点的融云 user 资料行 ——
// 让设备管理/通讯录与单聊列表共享同一份已同步的真相。
//
// workspace 归属说明：LegacyNodeRecords("") 是 workspace-wide 视图，按「最早创建
// 的 active rongcloud installation」解析 workspace（ListActiveChannelInstallations
// 的 insts[0]，ORDER BY created_at ASC）。共享测试库里存在别人插的 installation，
// 所以节点行必须插进那个 workspace 才会被列出，而不是插 testWorkspaceID。

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/integrations/rongcloud"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestLegacyNodeRecordsCarriesPortraitUri(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database-backed handler tests are disabled")
	}
	ctx := context.Background()
	stamp := time.Now().UnixNano()

	// LegacyNodeRecords 用最早创建的 active rongcloud installation 的 workspace。
	var ws string
	if err := testPool.QueryRow(ctx, `
		SELECT ci.workspace_id::text FROM channel_installation ci
		JOIN workspace w ON w.id = ci.workspace_id
		JOIN agent a ON a.id = ci.agent_id
		WHERE ci.channel_type = 'rongcloud' AND ci.status = 'active'
		ORDER BY ci.created_at ASC LIMIT 1`).Scan(&ws); err != nil {
		t.Skipf("no active rongcloud installation to anchor the workspace: %v", err)
	}

	nodeUUID := uuid.NewString()
	nodeRc := fmt.Sprintf("opencode_portrait_%d", stamp)
	nodeID := fmt.Sprintf("node_portrait_%d", stamp)
	machineID := fmt.Sprintf("portrait_machine_%d", stamp)
	uploaded := fmt.Sprintf("https://agentsbb.quukk.com/api/claw/files/qa/%d/avatar.png", stamp)

	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM rongcloud_node WHERE id = $1::uuid`, nodeUUID)
		_, _ = testPool.Exec(context.Background(), `DELETE FROM rongcloud_user WHERE rongcloud_user_id = $1`, nodeRc)
	})

	if _, err := testPool.Exec(ctx, `
		INSERT INTO rongcloud_node (id, workspace_id, owner_user_id, rongcloud_user_id, node_id, machine_id, ai_type)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'opencode')`,
		nodeUUID, ws, testUserID, nodeRc, nodeID, machineID); err != nil {
		t.Fatalf("seed node: %v", err)
	}
	if _, err := testPool.Exec(ctx, `
		INSERT INTO rongcloud_user (workspace_id, rongcloud_user_id, name, portrait_uri)
		VALUES ($1::uuid, $2, $3, $4)`,
		ws, nodeRc, "opencode", uploaded); err != nil {
		t.Fatalf("seed rongcloud_user: %v", err)
	}

	svc := rongcloud.NewNodeService(db.New(testPool), rongcloud.NewRongCloudAPIClientForServices(nil, nil, nil), nil, nil)
	records, err := svc.LegacyNodeRecords(ctx, "")
	if err != nil {
		t.Fatalf("LegacyNodeRecords: %v", err)
	}
	var hit map[string]interface{}
	for _, record := range records {
		if record["node_id"] == nodeID {
			hit = record
			break
		}
	}
	if hit == nil {
		t.Fatalf("node %s not in records (%d rows)", nodeID, len(records))
	}
	if got, _ := hit["portraitUri"].(string); got != uploaded {
		t.Errorf("record portraitUri = %q, want the rongcloud_user portrait %q (D-004: 设备管理与通讯录按这个字段读头像)", got, uploaded)
	}
}
