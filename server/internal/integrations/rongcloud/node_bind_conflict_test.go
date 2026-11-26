package rongcloud

import (
	"errors"
	"strings"
	"testing"
)

// 这一组钉住「同一台机器、第二个账号再绑同一个 agent」的拦截口径：
// 未被占用的节点照旧直接绑（幂等），被别的账号占用的必须先报冲突、
// 由用户确认 force 之后才换绑。

func TestBindOwnerConflictsBlocksOtherOwner(t *testing.T) {
	rows := []agentNodeOwner{
		{Agent: "opencode", NodeID: "node_aaaa", OwnerID: "user_a"},
	}
	got := bindOwnerConflicts(rows, "user_b")
	if len(got) != 1 {
		t.Fatalf("conflicts = %+v, want exactly one", got)
	}
	if got[0].Agent != "opencode" || got[0].OwnerID != "user_a" || got[0].NodeID != "node_aaaa" {
		t.Fatalf("conflict = %+v, want opencode owned by user_a", got[0])
	}
}

func TestBindOwnerConflictsSameOwnerIsIdempotent(t *testing.T) {
	rows := []agentNodeOwner{
		{Agent: "opencode", NodeID: "node_aaaa", OwnerID: "user_a"},
	}
	if got := bindOwnerConflicts(rows, "user_a"); len(got) != 0 {
		t.Fatalf("same owner must not conflict, got %+v", got)
	}
}

// 首次绑定（节点还没有归属）不能被拦，否则新机器永远绑不上。
func TestBindOwnerConflictsIgnoresUnowned(t *testing.T) {
	rows := []agentNodeOwner{
		{Agent: "opencode", NodeID: "node_aaaa", OwnerID: ""},
		{Agent: "hermes", NodeID: "node_bbbb", OwnerID: "  "},
	}
	if got := bindOwnerConflicts(rows, "user_b"); len(got) != 0 {
		t.Fatalf("unowned nodes must not conflict, got %+v", got)
	}
}

// 设备凭据路径（内置运维 agent 自动绑定）没有人类归属，不做拦截。
func TestBindOwnerConflictsSkipsCredentialBinds(t *testing.T) {
	rows := []agentNodeOwner{
		{Agent: "ops", NodeID: "node_cccc", OwnerID: "user_a"},
	}
	if got := bindOwnerConflicts(rows, ""); len(got) != 0 {
		t.Fatalf("credential binds must not conflict, got %+v", got)
	}
}

// 一次勾选多个 agent 时，只把真正属于别人的那几条报出来 —— 前端据此只问
// 需要问的项，未被占用的不必进确认框。
func TestBindOwnerConflictsOnlyReportsForeignAgents(t *testing.T) {
	rows := []agentNodeOwner{
		{Agent: "opencode", NodeID: "node_aaaa", OwnerID: "user_a"},
		{Agent: "hermes", NodeID: "node_bbbb", OwnerID: "user_b"},
		{Agent: "qwen", NodeID: "node_cccc", OwnerID: ""},
	}
	got := bindOwnerConflicts(rows, "user_b")
	if len(got) != 1 || got[0].Agent != "opencode" {
		t.Fatalf("conflicts = %+v, want only opencode", got)
	}
}

func TestAgentOwnedByOtherErrorMessageListsAgents(t *testing.T) {
	err := error(&AgentOwnedByOtherError{Conflicts: []AgentOwnerConflict{
		{Agent: "opencode", OwnerID: "user_a"},
		{Agent: "hermes", OwnerID: "user_a"},
	}})
	if !strings.Contains(err.Error(), "opencode") || !strings.Contains(err.Error(), "hermes") {
		t.Fatalf("message = %q, want both agent names", err.Error())
	}
	// handler 用 errors.As 取冲突清单，包装一层也必须命中。
	wrapped := errors.Join(err)
	var target *AgentOwnedByOtherError
	if !errors.As(wrapped, &target) || len(target.Conflicts) != 2 {
		t.Fatalf("wrapped error must still expose 2 conflicts, got %+v", target)
	}
}
