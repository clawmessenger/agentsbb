package handler

import (
	"encoding/json"
	"strings"
	"testing"
)

// clawAdminOpsChatContext 的纯结构投影测试：不造 DB 行，只验证 agent CLI 两
// 字段的 omitempty 投影行为（found=false → 空串 → JSON 不出现；found=true →
// JSON 带 agent_cli_version / agent_cli_path）。数据库路径由
// clawNodeAgentCLIByNode 自身对 nil DB / 表不存在的降级保证，集成测试不在
// 本文件范围内强造。
func TestClawAdminOpsChatContextAgentCLIVersionProjection(t *testing.T) {
	t.Run("no agent cli reported", func(t *testing.T) {
		out := clawAdminOpsChatContext{
			NodeID:     "node-1",
			ExeVersion: "1.3.22",
		}
		if out.AgentCLIVersion != "" || out.AgentCLIPath != "" {
			t.Fatalf("expected empty agent CLI fields, got version=%q path=%q", out.AgentCLIVersion, out.AgentCLIPath)
		}
		raw, err := json.Marshal(out)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if strings.Contains(string(raw), "agent_cli") {
			t.Fatalf("expected agent_cli_* keys to be omitted, got %s", raw)
		}
	})

	t.Run("agent cli reported", func(t *testing.T) {
		out := clawAdminOpsChatContext{
			NodeID:          "node-1",
			ExeVersion:      "1.3.22",
			AgentCLIVersion: "1.19.4",
			AgentCLIPath:    "/usr/local/bin/codex",
		}
		raw, err := json.Marshal(out)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if !strings.Contains(string(raw), `"agent_cli_version":"1.19.4"`) {
			t.Fatalf("expected agent_cli_version in JSON, got %s", raw)
		}
		if !strings.Contains(string(raw), `"agent_cli_path":"/usr/local/bin/codex"`) {
			t.Fatalf("expected agent_cli_path in JSON, got %s", raw)
		}
	})
}
