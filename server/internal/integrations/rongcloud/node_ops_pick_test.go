package rongcloud

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func opsNode(rc, machineID string) db.RongcloudNode {
	return db.RongcloudNode{
		RongcloudUserID: rc,
		MachineID:       machineID,
		AiType:          pgtype.Text{String: OpsAgentType, Valid: true},
	}
}

func agentNodeAt(rc, machineID, aiType string) db.RongcloudNode {
	return db.RongcloudNode{
		RongcloudUserID: rc,
		MachineID:       machineID,
		AiType:          pgtype.Text{String: aiType, Valid: true},
	}
}

// 收敛后的默认行为：同机既有机器级 ops、又有存量 per-agent ops 时，必须选
// 机器级 —— per-agent 的进程已经不再拉起，指向它只会让用户看到「运维助手
// 离线」。这是本次改造最核心的一条。
func TestPickOpsNodePrefersMachineLevelWhenPerAgentRetired(t *testing.T) {
	const machine = "3300776275"
	nodes := []db.RongcloudNode{
		agentNodeAt("openclaw_3300776275", machine, "openclaw"),
		agentNodeAt("qwen_3300776275", machine, "qwen"),
		opsNode("ops_3300776275", machine),          // 机器级（新命名）
		opsNode("openclaw_3300776275_ops", machine), // 存量 per-agent
		opsNode("qwen_3300776275_ops", machine),     // 存量 per-agent
		agentNodeAt("openclaw_other", "other-machine", "openclaw"),
	}
	agentRCs := map[string]bool{
		"openclaw_3300776275": true,
		"qwen_3300776275":     true,
	}

	got := pickOpsNode(nodes, machine, "openclaw_3300776275", agentRCs, false)
	if got == nil || got.RongcloudUserID != "ops_3300776275" {
		t.Fatalf("want machine-level ops_3300776275, got %+v", got)
	}

	// 回退开关打开时恢复旧行为：per-agent 优先。
	got = pickOpsNode(nodes, machine, "openclaw_3300776275", agentRCs, true)
	if got == nil || got.RongcloudUserID != "openclaw_3300776275_ops" {
		t.Fatalf("with per-agent ops enabled want openclaw_3300776275_ops, got %+v", got)
	}
}

// 只有 per-agent 行（没有机器级）时仍要用它：运维入口不能凭空消失。
func TestPickOpsNodeFallsBackToPerAgent(t *testing.T) {
	const machine = "6731537256"
	nodes := []db.RongcloudNode{
		agentNodeAt("opencode_6731537256", machine, "opencode"),
		opsNode("opencode_6731537256_ops", machine),
	}
	agentRCs := map[string]bool{"opencode_6731537256": true}

	got := pickOpsNode(nodes, machine, "opencode_6731537256", agentRCs, false)
	if got == nil || got.RongcloudUserID != "opencode_6731537256_ops" {
		t.Fatalf("want per-agent fallback, got %+v", got)
	}
}

// 旧世代的机器级命名 "rc_node_<key>_ops" 不能被当成 per-agent 然后被跳过：
// 它去掉 "_ops" 后确实命中同机某个 rc_node_<key> agent，但那是历史命名。
func TestPickOpsNodeKeepsLegacyMachineLevel(t *testing.T) {
	const machine = "3300776275"
	nodes := []db.RongcloudNode{
		agentNodeAt("rc_node_3300776275", machine, "opencode"),
		opsNode("rc_node_3300776275_ops", machine),
	}
	agentRCs := map[string]bool{"rc_node_3300776275": true}

	got := pickOpsNode(nodes, machine, "rc_node_3300776275", agentRCs, false)
	if got == nil {
		t.Fatal("legacy machine-level ops must still be picked when it is the only candidate")
	}
}

// 别的机器的 ops 永远不能被抓进来。
func TestPickOpsNodeIgnoresOtherMachines(t *testing.T) {
	nodes := []db.RongcloudNode{
		opsNode("ops_other", "other-machine"),
	}
	if got := pickOpsNode(nodes, "3300776275", "openclaw_3300776275", map[string]bool{}, false); got != nil {
		t.Fatalf("want nil, got %+v", got)
	}
}

// 非 ops 类型的行不参与挑选。
func TestPickOpsNodeIgnoresNonOpsRows(t *testing.T) {
	const machine = "m1"
	nodes := []db.RongcloudNode{
		agentNodeAt("openclaw_m1", machine, "openclaw"),
	}
	if got := pickOpsNode(nodes, machine, "openclaw_m1", map[string]bool{"openclaw_m1": true}, false); got != nil {
		t.Fatalf("want nil, got %+v", got)
	}
}
