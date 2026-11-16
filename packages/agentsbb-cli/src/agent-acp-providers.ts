import type { AcpDiscoverySpec } from "./acp-discovery.js";
import type { AcpTurnSpec } from "./acp-turn.js";

// ACP 目录发现的启动规格表 —— 加一家 agent 只加一行。
//
// 每一行的参数都对齐上游 Go exe 的权威实现（server/pkg/agent/models.go 的
// acpDiscoveryProvider 配置），不是猜的：
//
//   kiro-cli    discovery  : models.go:1868  `kiro-cli acp`
//   qodercli    discovery  : models.go:1915  `--yolo --acp`
//   qoderclicn  同上，独立账号根
//   traecli     discovery  : models.go:667   `acp serve --yolo`
//   dim         discovery  : models.go:2988  `dim acp`
//   hermes      discovery  : models.go:1520  `hermes acp` + HERMES_YOLO_MODE=1
//   reasonix    discovery  : models.go:1855  reasonixACPLaunchArgs()（见下）
//   copilot     discovery  : models.go:1895  `copilot --acp`
//   grok        discovery  : models.go:2464  `--no-auto-update agent --always-approve stdio`
//
// 说明：grok / kimi / hermes 已有各自的 CLI / 配置目录来源，这里列出来是为了
// 「ACP 是它们目录的同一份权威答案」—— loader 会把多路结果并集，跨来源不冲突。

export interface AgentAcpProvider {
  spec: AcpDiscoverySpec;
  /**
   * 该 agent 的**回合**是否也走 ACP（模型靠 session/set_model 生效）。
   *
   * 只有「模型注入除了 ACP 没有第二条路」的 agent 才填：填了它，runAgentTurn
   * 就改用 acp-turn.ts 跑真实回合，模型选择才真的生效。catalogOnly（copilot /
   * grok / hermes / kimi）不填 —— 它们的回合走各自的 headless 通道，模型靠
   * `--model` / `-m` 注入，改走 ACP 只是平白多一层协议。
   */
  turn?: AcpTurnSpec;
  /** 面板与该表以外的说明用；日志里出现时就靠它定位哪家 agent 失败。 */
  label: string;
}

/** reasonixACPLaunchArgs 的 Node 同构（server/pkg/agent/reasonix.go:33）。 */
export const REASONIX_ACP_ARGS: readonly string[] = [
  "acp",
  "--profile", "balanced",
  "--planner", "auto",
  "--sandbox-network", "auto",
  "--sandbox-bash", "auto",
  "--workspace-only",
];

export const AGENT_ACP_PROVIDERS: Readonly<Record<string, AgentAcpProvider>> = {
  "kiro-cli": {
    label: "Kiro CLI",
    spec: { args: ["acp"], providerFallback: "kiro" },
    // kiro.go:265 续接走 session/load；模型走 session/set_model（kiro.go:325）。
    turn: { args: ["acp"], providerFallback: "kiro", resume: "load", label: "Kiro CLI" },
  },
  qodercli: {
    label: "Qoder CLI",
    spec: { args: ["--yolo", "--acp"], providerFallback: "qoder" },
    // qoder.go:256 续接走 session/resume（不是标准 load）。
    turn: { args: ["--yolo", "--acp"], providerFallback: "qoder", resume: "resume", label: "Qoder CLI" },
  },
  qoderclicn: {
    label: "Qoder CN CLI",
    spec: { args: ["--yolo", "--acp"], providerFallback: "qoder" },
    turn: { args: ["--yolo", "--acp"], providerFallback: "qoder", resume: "resume", label: "Qoder CN CLI" },
  },
  traecli: {
    label: "TRAE CLI",
    spec: { args: ["acp", "serve", "--yolo"], providerFallback: "trae" },
    turn: { args: ["acp", "serve", "--yolo"], providerFallback: "trae", resume: "load", label: "TRAE CLI" },
  },
  dim: {
    label: "Dim Code",
    spec: { args: ["acp"], providerFallback: "dim" },
    turn: {
      args: ["acp"],
      providerFallback: "dim",
      resume: "load",
      // dim.go:520-541：ACP server 建会话时钉的是只读预设，不抬到 full-access
      // 的话每一轮写文件/起进程都会被静默拒绝。
      setConfig: [
        { id: "permission", value: "full-access" },
        { id: "mode", value: "agent" },
      ],
      label: "Dim Code",
    },
  },
  hermes: {
    label: "Hermes",
    spec: {
      args: ["acp"],
      // Go 侧同样注入：无它时 hermes 在非 TTY 下会挂住等确认。
      env: { HERMES_YOLO_MODE: "1" },
      providerFallback: "hermes",
    },
  },
  reasonix: {
    label: "Reasonix",
    spec: {
      args: [...REASONIX_ACP_ARGS],
      providerFallback: "reasonix",
    },
    // reasonix.go:288 续接走 session/resume；模型 set_model 原样透传（:352）。
    turn: {
      args: [...REASONIX_ACP_ARGS],
      providerFallback: "reasonix",
      resume: "resume",
      label: "Reasonix",
    },
  },
  copilot: {
    label: "GitHub Copilot CLI",
    spec: { args: ["--acp"], providerFallback: "copilot" },
  },
  grok: {
    label: "Grok Build",
    spec: {
      args: ["--no-auto-update", "agent", "--always-approve", "stdio"],
      providerFallback: "grok",
    },
  },
};

/** 该 agent 是否有 ACP 目录发现规格。 */
export function acpProviderFor(agentName: string | undefined): AgentAcpProvider | null {
  if (!agentName) return null;
  return AGENT_ACP_PROVIDERS[agentName] ?? null;
}

/** 该 agent 的回合是否走 ACP（即模型注入只有 session/set_model 一条路）。 */
export function acpTurnSpecFor(agentName: string | undefined): AcpTurnSpec | null {
  if (!agentName) return null;
  return AGENT_ACP_PROVIDERS[agentName]?.turn ?? null;
}
