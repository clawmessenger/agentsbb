package handler

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/integrations/rongcloud"
)

// 设备回执里 state 的取值（由 CLI 上报，服务端不强制枚举，但把已知的几个说清楚）：
//
//	running  —— 子进程在跑（supervisor 认这一条为「已生效」）
//	starting —— 刚被拉起/正在重启，还没稳定（页面显示「启动中」）
//	stopped  —— 已在期望停止状态下
//	missing  —— 本机 PATH 上根本没有这个 agent 的命令行（点了启动也起不来，
//	            这正是过去「点启动永远没反应」的一种典型真相）
//	failed   —— 起过但崩了（error 里带退出码/最近一次错误）
//
// 未知取值原样落库：旧服务端遇到新 CLI 新增的状态时，页面至少能显示原文，
// 而不是把设备的真实情况改写成服务端猜的。
const (
	clawAppliedStateRunning  = "running"
	clawAppliedStateStarting = "starting"
	clawAppliedStateStopped  = "stopped"
	clawAppliedStateMissing  = "missing"
	clawAppliedStateFailed   = "failed"
)

// clawDeviceObservedState 是设备对「本机某个 agent 现在到底是什么状态」的回执。
//
// 为什么让设备每轮都报、而不是执行完发一次 ack：ack 会丢（网络抖动、进程被杀），
// 丢了以后页面永远停在「已下发」；而这一条本来是**状态**，状态天然可以重复上报，
// 幂等且能自愈 —— 服务端只要比较 applied_* 与 desired_* 就知道收敛到哪一步了。
type clawDeviceObservedState struct {
	Agent string `json:"agent"`
	State string `json:"state"`
	// Version 是设备已收敛到的期望状态版本（CLI 的 seenVersion）。
	// 与 desired_version 比：>= 说明这条指令设备已经看过了。
	Version int64  `json:"version"`
	Error   string `json:"error"`
	// CliPath/CliVersion 是**这个 agent 自己的 CLI** 的安装路径与版本（迁移 612）。
	//
	// 与机器维度的 install_dir / exe_version 分工：那两列讲的是 supervisor
	// （clawmessenger 自己），这两列讲的是真正干活的 codex/opencode/qwen。后台
	// 「设备详情」的「安装目录」「版本」展示的是这两个 —— 运维要翻的是 agent 的
	// 日志，不是 supervisor 的目录。空串 = 设备没探到（没装 / 超时），写入端
	// 保留旧值而不是把已知版本抹掉。
	CliPath    string `json:"cliPath"`
	CliVersion string `json:"cliVersion"`
}

// 设备上报的 CLI 路径/版本长度上限。版本串本来就短，路径在 Windows 上受
// MAX_PATH 限制；这里只防一条恶意/异常的超长串把页面撑爆。
const (
	clawCliPathMaxLen    = 512
	clawCliVersionMaxLen = 64
)

// clawAppliedErrorMaxLen 限制回执错误文本长度（设备侧可能是整段 stderr）。
const clawAppliedErrorMaxLen = 200

// clawDeviceRecordAppliedStates 把设备回执写回对应的控制指令行。
//
// 只 UPDATE 不 INSERT：没有控制指令行 = 这台 agent 从未被操作过（服务端基线就是
// running），没有「指令」需要被确认。为回执凭空建行会让 desired_version 从 0 起跳，
// 与管理端「同状态不推进版本」的模型打架。
//
// 只在**值真的变了**时才写（WHERE ... IS DISTINCT FROM）：10 秒一轮、一台机器十几个
// agent，无脑 UPDATE 会让 applied_at 一直跳，页面上的「已生效于 16:20:09」就永远
// 变成「刚刚」—— 那个时间戳的意义正是「什么时候收敛的」。
func (h *Handler) clawDeviceRecordAppliedStates(
	ctx context.Context,
	refs []rongcloud.AgentNodeRef,
	observed []clawDeviceObservedState,
) error {
	if h.DB == nil || len(observed) == 0 {
		return nil
	}
	byAgent := make(map[string]pgtype.UUID, len(refs))
	for _, ref := range refs {
		if ref.Agent != "" && ref.ID.Valid {
			byAgent[ref.Agent] = ref.ID
		}
	}
	var firstErr error
	for _, item := range observed {
		agent := strings.TrimSpace(item.Agent)
		state := strings.TrimSpace(item.State)
		if agent == "" || state == "" {
			continue
		}
		nodeUUID, ok := byAgent[agent]
		if !ok {
			// 服务端这轮没把这个 agent 列进 refs（解绑竞态）：忽略，别按 agent 名
			// 反查全表 —— 那会跨机器改到别人的行。
			continue
		}
		if len(state) > 32 {
			state = state[:32]
		}
		detail := clawTruncateRunes(strings.TrimSpace(item.Error), clawAppliedErrorMaxLen)
		if _, err := h.DB.Exec(ctx, `
			UPDATE rongcloud_node_control
			   SET applied_state = $1,
			       applied_version = $2,
			       applied_error = $3,
			       applied_at = now()
			 WHERE node_id = $4
			   AND (applied_state IS DISTINCT FROM $1
			        OR applied_version IS DISTINCT FROM $2
			        OR applied_error IS DISTINCT FROM $3)`,
			state, item.Version, detail, nodeUUID); err != nil && firstErr == nil {
			firstErr = err
		}
		// 智能体 CLI 的版本/路径（迁移 612，独立的 rongcloud_node_agent_cli）。
		//
		// 为什么不写进 rongcloud_node_control：那张表的行只在管理端操作过启停时
		// 才存在（只 UPDATE 不 INSERT）。挂上去等于「从没被点过启动的 agent 永远
		// 没有版本」，而凭空 INSERT 会带上 desired_state、被设备当成真实意图执行。
		//
		// COALESCE(NULLIF(...)) 保留旧值的语义：这次没探到（超时 / 临时不在 PATH）
		// 就不要把已知版本抹成空串，否则页面上的版本号会在有/无之间闪；WHERE 里
		// 再判一次「真的变了才写」，避免每轮 10 秒都刷 probed_at。
		cliPath := clawTruncateRunes(strings.TrimSpace(item.CliPath), clawCliPathMaxLen)
		cliVersion := clawTruncateRunes(strings.TrimSpace(item.CliVersion), clawCliVersionMaxLen)
		if cliPath != "" || cliVersion != "" {
			if _, err := h.DB.Exec(ctx, `
				INSERT INTO rongcloud_node_agent_cli (node_id, cli_version, cli_path, probed_at, updated_at)
				VALUES ($1, $2, $3, now(), now())
				ON CONFLICT (node_id) DO UPDATE
				   SET cli_version = COALESCE(NULLIF(EXCLUDED.cli_version, ''), rongcloud_node_agent_cli.cli_version),
				       cli_path = COALESCE(NULLIF(EXCLUDED.cli_path, ''), rongcloud_node_agent_cli.cli_path),
				       probed_at = now(),
				       updated_at = now()
				 WHERE rongcloud_node_agent_cli.cli_version IS DISTINCT FROM
				           COALESCE(NULLIF(EXCLUDED.cli_version, ''), rongcloud_node_agent_cli.cli_version)
				    OR rongcloud_node_agent_cli.cli_path IS DISTINCT FROM
				           COALESCE(NULLIF(EXCLUDED.cli_path, ''), rongcloud_node_agent_cli.cli_path)`,
				nodeUUID, cliVersion, cliPath); err != nil && firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

// clawTruncateRunes 按 rune 截断，避免把多字节字符切成半个（pgx 写半个 UTF-8 会报错）。
func clawTruncateRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max])
}

// clawAppliedOutcome 把「期望 + 回执」折算成页面要显示的一种结论。纯函数，便于单测。
//
// 返回 (状态码, 人话原因)：
//
//	"applied"  已生效 —— 回执版本追平期望版本且实际状态就是期望状态
//	"pending"  待设备确认 —— 设备还没报过，或报的版本落后于最后一次下发
//	"failed"   失败 —— 设备明确说 missing/failed（点一百次也不会生效，必须上机处理）
func clawAppliedOutcome(desiredState string, desiredVersion int64, applied clawAdminNodeControl) (string, string) {
	state := strings.TrimSpace(applied.AppliedState)
	if !applied.AppliedAt.Valid {
		return "pending", ""
	}
	switch state {
	case clawAppliedStateMissing, clawAppliedStateFailed:
		return "failed", applied.AppliedError
	}
	if applied.AppliedVersion < desiredVersion {
		return "pending", ""
	}
	// 版本追平了还要看实际状态：点「停止」但设备还在跑（子进程没退干净）、
	// 刚拉起处于 starting —— 都只能算「还没落地」，不能报已生效。
	if desiredState != "" && state != desiredState {
		return "pending", ""
	}
	return "applied", ""
}
