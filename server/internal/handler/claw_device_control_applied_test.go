package handler

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

func ctlAt(t time.Time) pgtype.Timestamptz { return pgtype.Timestamptz{Time: t, Valid: true} }

// 启停回执的折算规则是页面「已下发 / 已生效 / 失败」三态的唯一来源，
// 一旦写反，运维会看到「已生效」而 agent 其实没起来 —— 所以逐条钉住。
func TestClawAppliedOutcome(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name        string
		desired     string
		desiredVer  int64
		applied     clawAdminNodeControl
		wantState   string
		wantDetail  string
		explanation string
	}{
		{
			name:       "从未回执 = 待确认，不是失败",
			desired:    "running",
			desiredVer: 2,
			applied:    clawAdminNodeControl{AppliedVersion: 0},
			wantState:  "pending",
		},
		{
			name:       "回执版本追平且状态一致 = 已生效",
			desired:    "running",
			desiredVer: 2,
			applied: clawAdminNodeControl{
				AppliedState: "running", AppliedVersion: 2, AppliedAt: ctlAt(now),
			},
			wantState: "applied",
		},
		{
			name:       "版本落后 = 待确认（又点了一次，设备还没轮到）",
			desired:    "running",
			desiredVer: 3,
			applied: clawAdminNodeControl{
				AppliedState: "running", AppliedVersion: 2, AppliedAt: ctlAt(now),
			},
			wantState: "pending",
		},
		{
			name:       "本机没有这个 CLI = 失败，并带上设备给的原因",
			desired:    "running",
			desiredVer: 1,
			applied: clawAdminNodeControl{
				AppliedState: "missing", AppliedVersion: 1,
				AppliedError: "本机 PATH 上没有 qwen 命令", AppliedAt: ctlAt(now),
			},
			wantState:  "failed",
			wantDetail: "本机 PATH 上没有 qwen 命令",
		},
		{
			name:       "起过就崩 = 失败",
			desired:    "running",
			desiredVer: 1,
			applied: clawAdminNodeControl{
				AppliedState: "failed", AppliedVersion: 1, AppliedError: "exit code 1", AppliedAt: ctlAt(now),
			},
			wantState:  "failed",
			wantDetail: "exit code 1",
		},
		{
			name:       "启动中 = 待确认（子进程还没稳定）",
			desired:    "running",
			desiredVer: 1,
			applied: clawAdminNodeControl{
				AppliedState: "starting", AppliedVersion: 1, AppliedAt: ctlAt(now),
			},
			wantState: "pending",
		},
		{
			name:       "还跑着没停 = 待确认（停止指令收到了但没落地）",
			desired:    "stopped",
			desiredVer: 4,
			applied: clawAdminNodeControl{
				AppliedState: "running", AppliedVersion: 4, AppliedAt: ctlAt(now),
			},
			wantState: "pending",
		},
		{
			name:       "已停止 = 已生效",
			desired:    "stopped",
			desiredVer: 4,
			applied: clawAdminNodeControl{
				AppliedState: "stopped", AppliedVersion: 4, AppliedAt: ctlAt(now),
			},
			wantState: "applied",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			state, detail := clawAppliedOutcome(tc.desired, tc.desiredVer, tc.applied)
			if state != tc.wantState {
				t.Fatalf("state = %q, want %q", state, tc.wantState)
			}
			if detail != tc.wantDetail {
				t.Fatalf("detail = %q, want %q", detail, tc.wantDetail)
			}
		})
	}
}

// 从未下发过指令（no row）时不产生任何结论：凭空给「已生效」会让列表里多出一条
// 谁也没点过的状态。
func TestClawAdminNodeRowOmitsControlOutcomeWithoutIntent(t *testing.T) {
	h := &Handler{}
	rec := testNodeRecord("node_abc", "qwen_3300776275", "qwen", "3300776275")

	row := h.clawAdminNodeRowFor(rec, "", "", "", "", false, clawAdminNodeControl{})

	if row.ControlState != "" || row.ControlAt != "" || row.AppliedState != "" {
		t.Fatalf("no intent must yield no outcome: %q / %q / %q",
			row.ControlState, row.ControlAt, row.AppliedState)
	}
}

// 有指令 + 有回执时，行投影必须把三态与时间一起带出去（前端只读这三个字段）。
func TestClawAdminNodeRowCarriesControlOutcome(t *testing.T) {
	h := &Handler{}
	rec := testNodeRecord("node_abc", "qwen_3300776275", "qwen", "3300776275")
	appliedAt := time.Date(2026, 11, 5, 8, 20, 9, 0, time.UTC)

	row := h.clawAdminNodeRowFor(rec, "", "", "", "", false, clawAdminNodeControl{
		DesiredState: "running", DesiredVersion: 1,
		AppliedState: "running", AppliedVersion: 1, AppliedAt: ctlAt(appliedAt),
	})

	if row.ControlState != "applied" {
		t.Fatalf("control_state = %q, want applied", row.ControlState)
	}
	if row.ControlAt != "2026-11-05T08:20:09Z" {
		t.Fatalf("control_applied_at = %q", row.ControlAt)
	}
	if row.AppliedState != "running" {
		t.Fatalf("applied_state = %q", row.AppliedState)
	}
}

// 常驻自愈是三态：老 CLI 没报过 → Known=false（页面不下结论），
// 报过 false → Known=true + Ready=false（页面红字告警）。
func TestClawAdminAttachUpgradeServiceHealthTriState(t *testing.T) {
	h := &Handler{}
	rec := testNodeRecord("node_abc", "qwen_3300776275", "qwen", "3300776275")
	base := clawAdminNodeRow{}

	// 一、从未上报。
	row := h.clawAdminAttachUpgrade(base, rec, map[string]clawNodeUpgrade{
		"3300776275": {MachineID: "3300776275"},
	}, nil)
	if row.ServiceReadyKnown {
		t.Fatal("an unreported machine must not claim to know the service state")
	}

	// 二、明确上报「没就位」。
	row = h.clawAdminAttachUpgrade(base, rec, map[string]clawNodeUpgrade{
		"3300776275": {
			MachineID:     "3300776275",
			ServiceReady:  false,
			ServiceDetail: "计划任务注册被拒绝：schtasks failed",
			ServiceAt:     ctlAt(time.Date(2026, 11, 5, 8, 20, 0, 0, time.UTC)),
		},
	}, nil)
	if !row.ServiceReadyKnown || row.ServiceReady {
		t.Fatalf("known=%v ready=%v, want known=true ready=false", row.ServiceReadyKnown, row.ServiceReady)
	}
	if row.ServiceDetail == "" {
		t.Fatal("the reason must travel to the page, otherwise the operator is back to guessing")
	}
	if row.ServiceAt != "2026-11-05T08:20:00Z" {
		t.Fatalf("service_at = %q", row.ServiceAt)
	}
}

// 设备上报的失败原因可能是整段 stderr，落库前按 rune 截断（切半个汉字 pgx 会报错）。
func TestClawTruncateRunesKeepsWholeCharacters(t *testing.T) {
	if got := clawTruncateRunes("启动失败：本机没有 qwen", 3); got != "启动失" {
		t.Fatalf("truncate = %q", got)
	}
	if got := clawTruncateRunes("short", 10); got != "short" {
		t.Fatalf("short string must be unchanged, got %q", got)
	}
}
