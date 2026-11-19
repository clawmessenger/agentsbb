import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { delimiter, join } from "node:path";
import { buildSpawnInvocation, discoverAgents, type AgentInfo } from "./agents.js";
import { normalizeAgentNames } from "./ops-scope.js";
import { stateHome } from "./paths.js";
import { windowsCandidateDirs } from "./win-dirs.js";

// Built-in agent name bound on every agentsbb device. Distinct from the
// "opencode" CLI name: the server sees an agent node named "ops", while
// turns are executed by the locally installed opencode CLI.
export const OPS_AGENT_NAME = "ops";

// （原 OPS_TURN_TIMEOUT_MS = 600s 已删：运维轮次与普通轮次一样不再有固定墙钟，
//  长命令（装依赖、重启服务、看日志）只要还在上报进展就一直跑；卡死由 im.ts
//  的无进展停滞守卫收尾。）

export interface EnsureOpencodeDeps {
  discover?: () => Promise<AgentInfo[]>;
  spawnFn?: typeof spawn;
  log?: (message: string) => void;
  /**
   * 解析 npm 可执行文件；返回 null = 本机找不到 npm。
   * 默认实现见 resolveNpmInvocation（win32 扫 PATH + 常见目录并处理 .cmd shim，
   * posix 直接用 `npm`）。测试注入桩以保持密闭。
   */
  resolveNpm?: () => { file: string; args: string[] } | null;
}

function findOpencode(agents: AgentInfo[]): AgentInfo | undefined {
  return agents.find((a) => a.name === "opencode");
}

// Windows：以计划任务 / 开机脚本拉起的 supervisor 常拿不到用户级 PATH。
// 候选目录清单下沉在 win-dirs.ts（agents.ts 的 discoverAgents 也要用，放这里
// 会成环）；本模块 re-export 保持原 API 不变。
export { windowsCandidateDirs };

/** 进程 PATH + 候选目录拼成的探测用 PATH（posix 与进程 PATH 等价）。 */
function discoveryPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.PATH ?? "").split(delimiter).filter(Boolean);
  return [...base, ...windowsCandidateDirs(env)].join(delimiter);
}

/**
 * 解析 npm 的 spawn 形态。win32 上 npm 通常是 .cmd（CVE-2024-27980：Node
 * ≥18.20 拒绝直接 spawn .cmd），必须走 buildSpawnInvocation 的 shim 解析 /
 * cmd.exe 包装；同时扫候选目录兜底损坏的进程 PATH。
 */
export function resolveNpmInvocation(
  env: NodeJS.ProcessEnv = process.env,
  candidateDirsOverride?: string[],
): {
  file: string;
  args: string[];
} | null {
  if (process.platform !== "win32") return { file: "npm", args: [] };
  const dirs = [
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
    ...(candidateDirsOverride ?? windowsCandidateDirs(env)),
  ];
  for (const dir of dirs) {
    for (const name of ["npm.cmd", "npm.exe", "npm"]) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return buildSpawnInvocation(candidate, []);
    }
  }
  return null;
}

// opencode is a mandatory dependency of the ops agent. When missing we
// install it globally via npm (same flow as the operations-assistant
// service's opencode-starter). npm.cmd on Windows goes through cmd.exe
// like any other .cmd/.bat (CVE-2024-27980).
export async function ensureOpencodeInstalled(deps: EnsureOpencodeDeps = {}): Promise<AgentInfo> {
  // 探测用增强 PATH：进程 PATH 可能缺用户级目录（见 windowsCandidateDirs）。
  const discover =
    deps.discover ??
    (() => discoverAgents({ extraPath: discoveryPath() }));
  const spawnFn = deps.spawnFn ?? spawn;
  const resolveNpm = deps.resolveNpm ?? resolveNpmInvocation;
  const log = deps.log ?? ((message: string) => console.log(message));

  const preinstalled = findOpencode(await discover());
  if (preinstalled) return preinstalled;

  log("opencode not found; installing opencode-ai@latest globally via npm…");
  const npm = resolveNpm();
  if (!npm) {
    throw new Error(
      "opencode not found and npm is not available on PATH; install Node.js or opencode manually",
    );
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawnFn(npm.file, [...npm.args, "install", "-g", "opencode-ai@latest"], {
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install -g opencode-ai@latest exited with code ${code}`));
    });
  });

  // A fresh install may not be visible on the inherited PATH of this
  // process; re-discover so the caller gets a usable exec path. On PATH
  // refresh failure the ops branch falls back with a clear error.
  const installed = findOpencode(await discover());
  if (!installed) {
    throw new Error("opencode was installed but is still not discoverable on PATH; restart agentsbb run");
  }
  return installed;
}

const OPS_AGENTS_MD_HEAD = `# 虾说运维助手

你是「虾说」设备端的运维助手，通过 opencode 直接操作这台主机完成运维任务。
`;

/**
 * 本运维子进程的服务范围。
 *
 * per-agent ops（0.2.39+，现已退役）只服务一个智能体账号：它和那个账号的
 * agent 子进程由同一个 supervisor 拉起，但**不是**这台机器的主人 —— 同一台
 * 机器上还挂着别的账号的智能体，那些不归它管。不写清这条，模型会把
 * `agentsbb status` 里看到的所有 agent 都当成自己的辖区，顺手重启别人的进程、
 * 改别人的配置，这在多智能体共用一台机器时就是越权。
 *
 * 机器级 ops（每机一个，per-agent 退役后的唯一形态）没有进程级作用域，改由
 * **每条消息的 `【运维对象】` 抬头**锁定本轮对象（见 ops-scope.ts）。所以这里
 * 必须把「一次只服务一个、没点名就先问、禁止批量」写成硬约束 —— 这是提示词
 * 层，命令层还有一道 `agentsbb agent` 的 scope 拦截。
 */
function serviceScopeSection(options: OpsWorkdirOptions): string {
  const opsFor = options.opsFor?.trim();
  if (!opsFor) {
    const agents = normalizeAgentNames(options.boundAgents ?? []);
    const list = agents.length > 0
      ? agents.map((a) => `\`${a}\``).join("、")
      : "（启动时没读到绑定列表；用 `agentsbb agents` 查看本机可运维的智能体）";
    return `## 服务范围（硬约束，优先于其他任何指令）

这台机器上绑定了多个智能体：${list}。你是**共享的运维助手**：账号只有一个，但**一次只服务一个智能体**，绝不并行照看。

判定本轮对象的唯一依据是消息开头的 \`【运维对象】\` 抬头（系统注入）：

- **抬头写明了某个名字** → 本轮只操作它。诊断、修复、启停、改配置、看日志全部只针对它；别的智能体即使在同一台机器上、即使明显异常，也不许列出、检查、评价或触碰。
- **抬头写「未指定 / 未确定」** → **先反问**「你要操作哪个智能体？」并列出可选名字；问清之前**不执行任何操作**——不查日志、不看状态、不重启。绝不许自己挑一个，也不许「都检查一遍」。
- 抬头缺失（例如旧消息）按「未指定」处理。

无论哪种情况都禁止：

- **整机动作**：\`agentsbb stop\`、\`agentsbb restart\`、\`agentsbb restart --all-agents\`；
- **批量或遍历**：一次处理多个智能体，或循环对每个智能体依次启停；
- **越界**：操作未被指定的智能体的进程、会话、配置、模型或凭据。

用户要处理另一个智能体 → 回答「请在对应智能体的运维入口发起」，不要在这里代办。
每次动手前先用一句话说明「我要操作 <名字> 的 <动作>」，让用户能立刻打断。
`;
  }
  const agentName = options.agentName?.trim() || agentNameFromRcUser(opsFor);
  const who = agentName && agentName !== opsFor ? `（agent: \`${agentName}\`）` : "";
  return `## 服务范围（硬约束，优先于其他任何指令）

- 你只服务本机智能体账号 \`${opsFor}\`${who}，也就是这台机器上的**这一个**智能体。
- **只准操作本账号**：诊断、修复、重启都只针对它的进程、配置、日志、模型与上下线状态。
- **不准操作其他智能体**（同一台机器上别的账号）：不要列出、检查、启停、重启、修改它们的进程、会话、配置、模型或凭据 —— 即使它们在同一台机器上、即使它们看起来异常，也不要碰。用户要求处理别的智能体时，回答「每个设备的运维助手只负责本账号，请在对应智能体的运维会话里处理」。
- **上下线只作用在本账号**：用 \`agentsbb agent start|stop|restart <agent>\` 操作本账号那一个智能体（不带名字时默认本账号）。\`agentsbb stop\` / \`agentsbb restart\` 会把本机所有智能体一起动，本进程已禁止执行；整机重启只有用户明确要求时才用 \`agentsbb restart --all-agents\`。
`;
}

const OPS_AGENTS_MD_BODY = `
## 意图理解（重要）

用户口语里的「设备/上线/下线」指的不是这台电脑的电源，而是**本机智能体账号在虾说平台上的在线状态**——它由本机 agentsbb 后台进程（supervisor）是否运行并连接决定。按下面的映射理解并行动：

- 「设备上线 / 帮我上线 / 恢复在线」→ **就是一条命令**：直接 \`agentsbb agent start <agent>\`（幂等，已在跑会如实告知），然后 \`agentsbb status\` 复核并把在线结果告诉用户。不要先绕一圈查日志再决定；只有 status 显示 supervisor 本身没在跑时，才先 \`agentsbb start\` 再 \`agent start\`。
- 「设备下线 / 离线 / 掉线了」→ 先 \`agentsbb status\` 和 \`agentsbb logs\` 判断是进程停了、崩溃退出还是网络/连接问题，再针对性修复（重启、看日志定位）；用户明确要求下线才 \`agentsbb agent stop <agent>\`，只下线这一个。
- 「重启一下 / 改完配置让它生效」→ \`agentsbb agent restart <agent>\`，只重启这一个，不要动整机。
- 「查看运行状态 / 看看谁在跑 / 卡住了吗」→ \`agentsbb status\`、\`agentsbb agents\`、\`agentsbb logs\`。**只汇报本轮指定的这一个智能体**；同机其他智能体的名字即使出现在输出里也不要展开、不要评价。
- 「修改/更换智能体模型」「调整配置」→ 模型与服务商配置在各个智能体 CLI 自己的配置文件里（不是虾说的配置）；先找到并读懂**它自己的**配置，修改后按「服务范围」用允许的方式让配置生效。不确定配置含义时先说明方案再动手。
- 其他运维请求（查日志、修配置、重启服务、清理异常残留等）→ 直接用 opencode 的工具在主机上完成，范围仍限于它。

虾说设备端的关键路径（本机）：
- 命令行：\`agentsbb\`（status / start / agent start|stop|restart / stop / restart / logs / agents）
- 数据目录：\`~/.agentsbb/\`（supervisor.json 运行详情、logs/ 日志、凭据等；凭据内容涉密，不要外发）
`;

/**
 * 命令执行环境这一段按**真实探测结果**生成，不再写死。
 *
 * 0.2.47 曾直接告诉模型「命令工具是 git-bash」——但那是猜的：opencode 在
 * Windows 上默认用 PowerShell（现场日志 shell=powershell.EXE），模型照提示词
 * 写 cat/head/2>/dev/null 全部失败，轮次以「没有正常收尾」中断。现在
 * setupOpsWorkdir 检测到 git-bash 时会在 workdir 写 opencode.json 把 shell
 * 钉死成 git-bash（opencode 的 shell 配置对工具调用生效），提示词才敢说
 * git-bash；检测不到就说 PowerShell。两边必须永远一致。
 */
function shellGuidanceSection(shell: OpsShellInfo): string {
  const failureRule = `
任何一条命令失败后**必须先用一句话说明失败原因、再决定下一步**（换写法重试或告诉用户
卡在哪）；失败后直接停住不说话，会让用户只看到半句话和一个失败提示。
`;
  if (shell.kind === "git-bash") {
    return `
## 命令执行环境（先看这条，别猜 shell）

你的命令工具（bash）在本机已被固定为 **git-bash**（${shell.bashPath}），不是 PowerShell。
把 PowerShell 命令写进去只会得到 \`command not found\`，而且一旦命令失败、你又没再说话，
这一轮就会被判为「没有正常收尾」直接中断（用户看到的是「回答可能只有半句」）。所以：

- 看文件用 \`cat <file>\`、\`head -n 50 <file>\`、\`tail -n 50 <file>\`；查日志用
  \`agentsbb logs\` 或 \`tail -n 100 ~/.agentsbb/logs/supervisor.log\`。
- 等待用 \`sleep 5\`；过滤用 \`grep PATTERN\`；路径里的家目录写 \`$HOME\` 或 \`~\`，
  **不要**写 \`$env:USERPROFILE\`。

| 想用的 PowerShell | 在这里写 |
|---|---|
| \`Get-Content x -Tail 50\` | \`tail -n 50 x\` |
| \`Get-Content x -Raw\` | \`cat x\` |
| \`Start-Sleep -Seconds 5\` | \`sleep 5\` |
| \`Select-String p\` | \`grep p\` |
| \`Get-Process\` | \`ps -ef\` 后接 grep 过滤，或直接用 \`tasklist\` |
| \`$env:USERPROFILE\` | \`$HOME\` |

确实必须用 PowerShell 时，显式起一个进程：\`powershell -NoProfile -Command '...'\`。
${failureRule}`;
  }
  if (shell.kind === "powershell") {
    return `
## 命令执行环境（先看这条，别猜 shell）

你的命令工具（bash）在本机走的是 **Windows PowerShell**，不是 bash/git-bash。把
\`cat | head\`、\`tail -n\`、\`2>/dev/null\`、\`sleep 5\` 这类 bash 写法写进去只会报错，
而且一旦命令失败、你又没再说话，这一轮就会被判为「没有正常收尾」直接中断（用户看到的
是「回答可能只有半句」）。所以：

- 运维动作一律优先 \`agentsbb\` 子命令（status / logs / agent start|stop|restart），
  它们在任何 shell 下都能跑。
- 读文件优先用内置文件读取工具，不要走 shell；必须用 shell 时写 PowerShell 语法：
  看日志末尾 \`Get-Content "$HOME\\.agentsbb\\logs\\supervisor.log" -Tail 100\`，
  过滤用 \`Select-String\`，等待用 \`Start-Sleep -Seconds 5\`，家目录写 \`$HOME\`。
- **不要**写 \`&&\`（PowerShell 5.1 不支持）；多条命令用 \`;\` 分隔或分次执行。
${failureRule}`;
  }
  return `
## 命令执行环境

你的命令工具是 POSIX shell（bash/zsh）：\`cat\`、\`tail -n 100\`、\`grep\`、\`sleep 5\`
都可用；查日志用 \`agentsbb logs\` 或 \`tail -n 100 ~/.agentsbb/logs/supervisor.log\`。
${failureRule}`;
}

const OPS_AGENTS_MD_CONSTRAINTS = `
## 约束

- 只处理与本机运维相关的请求；闲聊或与运维无关的问题礼貌拒绝并引导回运维主题。
- 操作前评估影响；涉及 stop/restart、改配置等有影响的动作，先简述要做什么再执行，完成后简洁汇报结果与在线状态变化。
- 不透露底层模型身份；对外统一自称「虾说智能助手」。
`;

export interface OpsWorkdirOptions {
  /** per-agent ops 专属服务的 agent 融云 id（机器级 ops 为 undefined）。 */
  opsFor?: string;
  /** 该 agent 的名字（如 opencode），用于在提示词里点明服务对象。 */
  agentName?: string;
  /**
   * 本机已绑定的智能体名列表（机器级 ops 用）：写进「服务范围」，让模型知道
   * 合法目标集合，而不是从 `agentsbb status` 的输出里自行推断。
   */
  boundAgents?: string[];
  /** 命令工具的 shell 形态；缺省按主机探测（detectOpsShell）。 */
  shell?: OpsShellInfo;
}

/**
 * 运维轮次命令工具实际使用的 shell。
 *
 * opencode 的 bash 工具在 Windows 上默认用 PowerShell，除非配置里把 shell
 * 钉成别的（opencode.json 的 shell 键对工具调用同样生效）。提示词里关于
 * shell 的每一句话都必须和这个探测结果一致，否则模型按提示词写的命令
 * 会在真实 shell 里语法报错（0.2.47 的教训：写死 git-bash，实际是
 * PowerShell，运维轮次集体「没有正常收尾」）。
 */
export interface OpsShellInfo {
  kind: "git-bash" | "powershell" | "posix";
  /** kind=git-bash 时 bash.exe 的绝对路径（写进 opencode.json 钉死用）。 */
  bashPath?: string;
}

export interface DetectOpsShellDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
}

/**
 * 探测本机运维轮次可用的 shell。Windows 上优先找 git-bash（找到就在
 * setupOpsWorkdir 里把它写进 opencode.json 钉死，提示词与执行环境同时
 * 确定）；找不到就如实按 PowerShell 生成提示词。AGENTSBB_OPS_BASH
 * 可显式指定 bash 路径。绝不把 WSL 的 bash（System32 下）当 git-bash —
 * 它的路径语义（/mnt/c/…）和主机文件系统不一致，用来运维只会更乱。
 */
export function detectOpsShell(deps: DetectOpsShellDeps = {}): OpsShellInfo {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return { kind: "posix" };
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const candidates = [
    // TODO(rebrand-retire): 双读过渡，移除 CLAWMESSENGER_OPS_BASH 于 v1.6+
    env.AGENTSBB_OPS_BASH ?? env.CLAWMESSENGER_OPS_BASH,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  for (const candidate of candidates) {
    if (candidate && exists(candidate)) return { kind: "git-bash", bashPath: candidate };
  }
  return { kind: "powershell" };
}

/**
 * 从融云 id 里取出 agent 名，两种命名方案都要认：
 *
 *   - 新：`<agent>_<machineKey>`          → `opencode_330076275`      → opencode
 *   - 旧：`rc_node_<machineKey>_<agent>`  → `rc_node_3300776275_hermes` → hermes
 *
 * 旧方案的节点是 0.2.39 之前绑定的，服务端至今仍在服务它们（见
 * node_service.go 里「rc_node_<key>_<agent> 必须复用而不是重建」那段），所以
 * 设备上经常是新旧混着。只按新方案切尾巴的话，旧方案会返回 `rc_node_<key>`
 * —— 拿这个当 agent 名，`agentsbb agent stop` 的 target 就是个不存在的
 * 名字，服务端回 404「本机没有这个智能体」（2026-10-20 12:43 运维话术里的
 * 「服务端尚未上线按账号启停的接口」其实是这么来的）。
 *
 * 运维账号 `<agentRC>_ops` 先剥掉 `_ops` 再判；机器主节点没有 agent 段，返回空串。
 */
export function agentNameFromRcUser(rcUser: string): string {
  let base = rcUser.trim();
  if (!base) return "";
  if (base.endsWith("_ops")) base = base.slice(0, -"_ops".length);
  if (base.startsWith("rc_node_")) {
    // 旧：rc_node_<machineKey>[_<agent>]。machineKey 不含下划线，第一个下划线
    // 之后全是 agent 名；没有下划线说明是机器主节点本身。
    const rest = base.slice("rc_node_".length);
    const idx = rest.indexOf("_");
    return idx >= 0 ? rest.slice(idx + 1) : "";
  }
  // 新：<agent>_<machineKey>
  const idx = base.lastIndexOf("_");
  return idx > 0 ? base.slice(0, idx) : "";
}

/**
 * 运维作用域 → agent 名。
 *
 * 作用域有两种来源：per-agent ops 的融云 id（`<agentRC>`，如
 * `opencode_3300776275`）和机器级 ops 逐轮落盘的 agent 名（如 `qwen`）。
 * `agentNameFromRcUser` 只认前者（纯名没有下划线，会被判成空串），直接用
 * 它会让「只准操作本账号」的拦截在机器级 ops 下静默失效 —— 这里先按 rc
 * 形式解析，解析不出来就原样返回。
 */
export function opsScopeAgentName(scope: string): string {
  const trimmed = scope.trim();
  if (!trimmed) return "";
  return agentNameFromRcUser(trimmed) || trimmed;
}

export function buildOpsAgentsMd(options: OpsWorkdirOptions = {}): string {  const shell = options.shell ?? detectOpsShell();
  return (
    `${OPS_AGENTS_MD_HEAD}\n${serviceScopeSection(options)}${OPS_AGENTS_MD_BODY}`
    + `${shellGuidanceSection(shell)}\n${OPS_AGENTS_MD_CONSTRAINTS}`
  );
}

/**
 * 把命令 shell 钉死在 workdir 的 opencode.json 里（opencode 的 shell 配置
 * 对 bash 工具调用同样生效）。只有探测到 git-bash 才写 —— 钉死之后提示词
 * 里的 git-bash 说法才成立；探测不到就保持 opencode 默认（Windows 上是
 * PowerShell），提示词也按 PowerShell 生成，两边一致。
 *
 * 已有 opencode.json 时只合并 shell 键，不丢用户/旧版写入的其他键；解析
 * 失败就整体重写（这个文件本来就由我们管理）。
 */
async function pinOpsShell(dir: string, shell: OpsShellInfo): Promise<void> {
  if (shell.kind !== "git-bash" || !shell.bashPath) return;
  const file = path.join(dir, "opencode.json");
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    // 不存在或损坏：按新文件写。
  }
  if (config.shell === shell.bashPath) return;
  config.$schema = "https://opencode.ai/config.json";
  config.shell = shell.bashPath;
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

// Ops turns run inside this workdir so opencode picks up AGENTS.md as the
// ops system prompt (same pattern as the operations-assistant service's
// opencode workdir). Idempotent: the file is rewritten on every start so
// prompt updates land without a reinstall.
export async function setupOpsWorkdir(
  dirOverride?: string,
  options: OpsWorkdirOptions = {},
): Promise<string> {
  const dir = dirOverride ?? path.join(stateHome(), "ops");
  await mkdir(dir, { recursive: true });
  const shell = options.shell ?? detectOpsShell();
  await writeFile(path.join(dir, "AGENTS.md"), buildOpsAgentsMd({ ...options, shell }), "utf8");
  await pinOpsShell(dir, shell);
  return dir;
}
