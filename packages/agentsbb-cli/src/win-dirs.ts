import { join } from "node:path";

// Windows：以计划任务 / 开机脚本拉起的 supervisor 常拿不到用户级 PATH。
// 2026-11-16 现场（小久）：注册表 PATH 里 `%NVM_HOME%`/`%NVM_SYMLINK%` 以
// REG_SZ 字面量形式写死、进程环境从未展开 —— npm 与 npm 全局安装的 opencode
// 在进程眼里"不存在"，ops 子进程于是永远走到 npm 安装分支、再被
// spawn npm ENOENT 打死，无限重启。这些目录按常见度补进探测与解析的候选；
// 多列几个无害，命中与否取决于机器。
//
// 独立成模块的原因：discoverAgents（agents.ts）本身也要附加这份候选，而
// ops.ts 已经 import agents.js —— 直接反向引用会成环，所以下沉到叶子模块，
// ops.ts 从这里 re-export 保持原 API。
export function windowsCandidateDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform !== "win32") return [];
  const dirs: string[] = [];
  const push = (dir?: string | null) => {
    const trimmed = dir?.trim();
    if (trimmed && !dirs.includes(trimmed)) dirs.push(trimmed);
  };
  // opencode 官方安装器的默认落点（%USERPROFILE%\.opencode\bin）必须排在 npm
  // 全局目录**之前**：npm 包 opencode-ai 的版本长期滞后于官方安装器（2026-11-16
  // 现场：npm 1.19.x vs 官方 2.1.4），兜底装出的旧版会长期遮蔽机器上已有的
  // 新版 —— 两者并存时，宁可探到官方版。
  push(env.USERPROFILE ? join(env.USERPROFILE, ".opencode", "bin") : null);
  push(env.APPDATA ? join(env.APPDATA, "npm") : null); // npm 全局 bin（npm i -g 的落点）
  push("C:\\Program Files\\nodejs"); // 官方安装器默认目录
  push(env.NVM_SYMLINK); // nvm-windows 的当前 node 目录
  push("C:\\nvm4w\\nodejs"); // nvm-windows 自定义符号链接的常见落点
  push(env.NVM_HOME);
  return dirs;
}
