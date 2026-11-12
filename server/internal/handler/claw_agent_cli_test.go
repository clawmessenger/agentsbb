package handler

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
)

// 设备上报的 agent CLI 版本/路径走的是 JSON 契约：CLI 侧字段名是 camelCase 的
// cliPath / cliVersion（见 api.ts 的 ObservedAgentState），服务端 struct tag 写错
// 一个字母就会**静默**收不到 —— 页面永远显示「-」，而两端都不会报错。
// 所以在这里把契约逐字钉住。
func TestClawDeviceObservedStateParsesAgentCLI(t *testing.T) {
	raw := `{"agent":"codex","state":"running","version":3,"error":"","cliPath":"C:\\nvm4w\\nodejs\\codex.cmd","cliVersion":"0.144.6"}`
	var got clawDeviceObservedState
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.CliPath != `C:\nvm4w\nodejs\codex.cmd` {
		t.Fatalf("cliPath not parsed: %q", got.CliPath)
	}
	if got.CliVersion != "0.144.6" {
		t.Fatalf("cliVersion not parsed: %q", got.CliVersion)
	}
}

// 老 CLI 不带这两个字段：解析后应是空串，写入端据此保留旧值。
func TestClawDeviceObservedStateAgentCLIOptional(t *testing.T) {
	var got clawDeviceObservedState
	if err := json.Unmarshal([]byte(`{"agent":"qwen","state":"running","version":1}`), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.CliPath != "" || got.CliVersion != "" {
		t.Fatalf("expected empty cli fields, got %q / %q", got.CliPath, got.CliVersion)
	}
}

// 详情页投影：没查到行时不能把「设备没上报」写成「探测到了空值」—— 两者在页面
// 上都是「-」，但前者不该覆盖已有数据。
func TestClawAdminAttachAgentCLI(t *testing.T) {
	row := clawAdminNodeRow{NodeID: "node_1", ExeVersion: "1.3.26"}

	// found=false：原样返回（老设备 / 迁移没跑）
	if got := clawAdminAttachAgentCLI(row, clawNodeAgentCLI{}, false); got.AgentCLIVersion != "" || got.AgentCLIPath != "" {
		t.Fatalf("found=false must not set fields, got %+v", got)
	}

	got := clawAdminAttachAgentCLI(row, clawNodeAgentCLI{
		CLIVersion: "0.144.6",
		CLIPath:    `C:\nvm4w\nodejs\codex.cmd`,
	}, true)
	if got.AgentCLIVersion != "0.144.6" {
		t.Fatalf("version: %q", got.AgentCLIVersion)
	}
	if got.AgentCLIPath != `C:\nvm4w\nodejs\codex.cmd` {
		t.Fatalf("path: %q", got.AgentCLIPath)
	}
	// supervisor 自己的版本照旧保留（升级要用），不能被 agent 版本顶掉
	if got.ExeVersion != "1.3.26" {
		t.Fatalf("supervisor version must stay: %q", got.ExeVersion)
	}
}

// 没有数据库时查 CLI 行必须安全返回（不 panic、不报错）。
func TestClawNodeAgentCLIByNodeWithoutDB(t *testing.T) {
	h := &Handler{}
	if _, found := h.clawNodeAgentCLIByNode(context.Background(), pgtype.UUID{}); found {
		t.Fatal("empty handler must not report found")
	}
}

// 列表页的批量版同样要保证降级语义：没有数据库（以及表不存在时的 err 路径）
// 返回空 map，列表接口照常出其他列，只是 CLI 版本都是「-」。
func TestClawAdminNodeAgentCLIsWithoutDB(t *testing.T) {
	h := &Handler{}
	got := h.clawAdminNodeAgentCLIs(context.Background())
	if got == nil {
		t.Fatal("must return an empty map, not nil")
	}
	if len(got) != 0 {
		t.Fatalf("expected empty map, got %v", got)
	}
}

// 超长路径/版本按 rune 截断，不能把多字节字符切半（pgx 会拒收非法 UTF-8）。
func TestClawTruncateRunesForCLIFields(t *testing.T) {
	long := "目录/智能体/路径"
	got := clawTruncateRunes(long, 3)
	if got != "目录/" {
		t.Fatalf("got %q", got)
	}
}
