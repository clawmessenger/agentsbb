package handler

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/multica-ai/multica/server/internal/integrations/rongcloud"
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

type opsHistoryCaptureDB struct {
	dbExecutor
	sql  string
	args []any
}

func (d *opsHistoryCaptureDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	d.sql = sql
	d.args = args
	return pgconn.CommandTag{}, nil
}

func TestClawAdminOpsChatHistoryRecorder(t *testing.T) {
	capture := &opsHistoryCaptureDB{}
	h := &Handler{DB: capture}
	created := time.Now().Add(-3 * time.Second)
	settled := time.Now()
	rec := rongcloud.OpsChatRecorded{
		RequestID: "opschat-1", NodeID: "node_1", OpsPeerID: "rc_ops_1", OpsAgent: "codearts",
		Question: "请只报告当前 agent 的版本", Reply: "agentsbb 1.3.61", Status: "completed",
		ElapsedMs: 3000, CreatedAt: created, SettledAt: settled,
	}
	if err := h.ClawAdminOpsChatHistoryRecorder()(context.Background(), rec); err != nil {
		t.Fatalf("record: %v", err)
	}
	if !strings.Contains(capture.sql, "INSERT INTO claw_admin_ops_chat_history") ||
		!strings.Contains(capture.sql, "ON CONFLICT (request_id) DO NOTHING") {
		t.Fatalf("unexpected insert SQL: %s", capture.sql)
	}
	if len(capture.args) != 10 || capture.args[0] != "node_1" || capture.args[1] != "opschat-1" ||
		capture.args[3] != rec.Question || capture.args[4] != rec.Reply || capture.args[7] != int64(3000) {
		t.Fatalf("unexpected insert args: %#v", capture.args)
	}

	// DB 没接上时静默跳过，不阻断问答链路。
	if err := (&Handler{}).ClawAdminOpsChatHistoryRecorder()(context.Background(), rec); err != nil {
		t.Fatalf("nil DB should be a no-op: %v", err)
	}
}

// 历史表 613 上过一次线后，SELECT 里写了一个建表时没有的 ops_agent 列，
// 线上每次查询直接 500（单元测试只覆盖 INSERT，没抓到）。这里直接对照
// migration 的表定义与 handler 源码里的 SELECT/INSERT 列，防同类回归。
func TestClawAdminOpsChatHistoryColumnsMatchMigration(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate test source")
	}
	dir := filepath.Dir(thisFile)
	migrationPath := filepath.Join(dir, "..", "..", "migrations", "613_claw_admin_ops_chat_history.up.sql")
	migration, err := os.ReadFile(migrationPath)
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	source, err := os.ReadFile(filepath.Join(dir, "claw_admin_ops_chat.go"))
	if err != nil {
		t.Fatalf("read handler: %v", err)
	}

	columns := map[string]bool{}
	columnDef := regexp.MustCompile(`(?m)^\s{4}([a-z][a-z0-9_]*)\s+(?:bigserial|text|bigint|timestamptz)\b`)
	for _, m := range columnDef.FindAllStringSubmatch(string(migration), -1) {
		columns[m[1]] = true
	}
	if len(columns) < 10 {
		t.Fatalf("parsed too few columns from migration: %v", columns)
	}

	const table = "claw_admin_ops_chat_history"
	check := func(label, block string) {
		t.Helper()
		for _, word := range regexp.MustCompile(`[a-z][a-z0-9_]*`).FindAllString(block, -1) {
			switch word {
			case table, "select", "from", "where", "and", "or", "order", "by", "limit", "desc",
				"coalesce", "on", "conflict", "do", "nothing", "values", "into", "insert",
				"as", "not", "null", "true", "false":
				continue
			}
			if !columns[word] {
				t.Errorf("%s references column %q which migration 613 does not define", label, word)
			}
		}
	}

	src := string(source)
	selectAt := strings.Index(src, "SELECT id, request_id,")
	if selectAt < 0 {
		t.Fatal("locate history SELECT")
	}
	fromAt := strings.Index(src[selectAt:], "FROM "+table)
	if fromAt < 0 {
		t.Fatal("locate history SELECT FROM")
	}
	check("history SELECT", src[selectAt:selectAt+fromAt])

	insertAt := strings.Index(src, "INSERT INTO "+table)
	if insertAt < 0 {
		t.Fatal("locate history INSERT")
	}
	valuesAt := strings.Index(src[insertAt:], "VALUES (")
	if valuesAt < 0 {
		t.Fatal("locate history INSERT VALUES")
	}
	check("history INSERT", src[insertAt:insertAt+valuesAt])
}
