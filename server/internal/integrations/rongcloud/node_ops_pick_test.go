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
	}

	got := pickOpsNode(nodes, machine, "openclaw_3300776275", false)
	if got == nil || got.RongcloudUserID != "ops_3300776275" {
		t.Fatalf("want machine-level ops_3300776275, got %+v", got)
	}

	// 回退开关打开时恢复旧行为：per-agent 优先。
	got = pickOpsNode(nodes, machine, "openclaw_3300776275", true)
	if got == nil || got.RongcloudUserID != "openclaw_3300776275_ops" {
		t.Fatalf("with per-agent ops enabled want openclaw_3300776275_ops, got %+v", got)
	}
}

// 僵尸 per-agent ops 行：agent 已注销（antigravity 那台机器上的真实情况），
// 它留下的 "<agentRC>_ops" 已不再命中任何 agent。按旧判据它会被误认为机器级，
// 而它的 token 早已失效 —— 2026-11-16 现场就是选中它，新起的 ops 子进程
// 60s 一次 31004 崩溃重启。这里断言：没有真正的机器级 ops 时必须返回 nil，
// 绝不能把僵尸行当机器级。
func TestPickOpsNodeIgnoresZombiePerAgentOps(t *testing.T) {
	const machine = "3300776275"
	nodes := []db.RongcloudNode{
		agentNodeAt("opencode_3300776275", machine, "opencode"),
		opsNode("antigravity_3300776275_ops", machine), // agent 已注销的残留
		opsNode("claude_3300776275_ops", machine),      // 同上
	}
	if got := pickOpsNode(nodes, machine, "opencode_3300776275", false); got != nil {
		t.Fatalf("zombie per-agent ops must not be picked as machine-level, got %+v", got)
	}
}

// 旧世代的机器级命名 "rc_node_<key>_ops" 必须能当机器级选中：线上本机
// （3300776275）唯一在役的机器级 ops 就是这个名字。
func TestPickOpsNodeAcceptsLegacyMachineLevelName(t *testing.T) {
	const machine = "3300776275"
	nodes := []db.RongcloudNode{
		agentNodeAt("rc_node_3300776275", machine, "opencode"),
		opsNode("antigravity_3300776275_ops", machine), // 僵尸行，不得优先
		opsNode("rc_node_3300776275_ops", machine),     // 真正的机器级
	}

	got := pickOpsNode(nodes, machine, "rc_node_3300776275", false)
	if got == nil || got.RongcloudUserID != "rc_node_3300776275_ops" {
		t.Fatalf("want rc_node_3300776275_ops, got %+v", got)
	}
}

// 只有 per-agent 行（没有机器级）且开关打开时仍要用它：运维入口不能凭空消失。
func TestPickOpsNodeFallsBackToPerAgentWhenEnabled(t *testing.T) {
	const machine = "6731537256"
	nodes := []db.RongcloudNode{
		agentNodeAt("opencode_6731537256", machine, "opencode"),
		opsNode("opencode_6731537256_ops", machine),
	}

	got := pickOpsNode(nodes, machine, "opencode_6731537256", true)
	if got == nil || got.RongcloudUserID != "opencode_6731537256_ops" {
		t.Fatalf("want per-agent fallback, got %+v", got)
	}
	// 默认（关闭）时不下发 per-agent。
	if got := pickOpsNode(nodes, machine, "opencode_6731537256", false); got != nil {
		t.Fatalf("per-agent ops retired: want nil, got %+v", got)
	}
}

// 别的机器的 ops 永远不能被抓进来。
func TestPickOpsNodeIgnoresOtherMachines(t *testing.T) {
	nodes := []db.RongcloudNode{
		opsNode("ops_other", "other-machine"),
		opsNode("rc_node_other_ops", "other-machine"),
	}
	if got := pickOpsNode(nodes, "3300776275", "openclaw_3300776275", false); got != nil {
		t.Fatalf("want nil, got %+v", got)
	}
}

// 非 ops 类型的行不参与挑选。
func TestPickOpsNodeIgnoresNonOpsRows(t *testing.T) {
	const machine = "m1"
	nodes := []db.RongcloudNode{
		agentNodeAt("openclaw_m1", machine, "openclaw"),
	}
	if got := pickOpsNode(nodes, machine, "openclaw_m1", false); got != nil {
		t.Fatalf("want nil, got %+v", got)
	}
}
