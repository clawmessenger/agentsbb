-- 智能体 CLI 的现场事实：版本与安装路径（节点维度）。
--
-- 问题现场（2026-11-05）：后台「设备详情」与移动端面板上的「版本」「安装目录」
-- 显示的是 **clawmessenger 自己**（supervisor）的 `exe_version` / `install_dir`，
-- 例如 `1.3.26` 和 `C:\Users\Administrator\AppData\Local\clawmessenger`。可是这个
-- 页面讲的是**某个智能体**（codex / opencode / qwen …）：运维想知道的是「这台机器
-- 上的 codex 装的是哪个版本、二进制在哪个目录」，出问题时要直接去那儿翻日志、
-- 换二进制。看到一个无关的 supervisor 目录只会把人带偏。
--
-- 为什么不加在 rongcloud_node_upgrade（机器维度）：一台机器上可以同时跑 codex、
-- opencode、qwen，每个的 CLI 版本都可能不同；那张表的一行只该回答「这台机器的
-- supervisor 是什么版本」（升级要用）。混在一起会让「升级 codex」和「升级
-- supervisor」变成同一个字段。
--
-- 为什么不加在 rongcloud_node_control（节点维度，现成）：那张表的行只在**管理端
-- 操作过启停**时才存在（只 UPDATE 不 INSERT，见 claw_device_control_applied.go），
-- 从没被点过启动的 agent 根本没有行 —— 把 CLI 版本挂上去，等于最需要看版本的
-- 那批设备永远显示「-」。而给它们凭空 INSERT 一行就带上了 desired_state，会让
-- 设备侧把它当成一条真实的启停意图去执行（可能反手把 agent 拉起来）。所以单开
-- 一张只承载「设备自述事实」的表，与指令/意图完全隔离。
--
-- 写入端：supervisor 随 observed 回执上报 cliPath/cliVersion，服务端 upsert。
-- 探测有成本（要起 `<cli> --version` 子进程），设备侧做了 6 小时 TTL 的落盘缓存，
-- 所以这两列可能滞后于最新一次发版 —— 页面文案说「设备上报」，不说「实时」。
--
-- 空串 = 老 CLI 从未上报 / 该 agent 的 CLI 不在本机 PATH 上。页面显示「-」，
-- 不要用 supervisor 的版本兜底：那样又会退回今天这个错误。
CREATE TABLE IF NOT EXISTS rongcloud_node_agent_cli (
    node_id     uuid PRIMARY KEY REFERENCES rongcloud_node (id) ON DELETE CASCADE,
    -- 智能体自己的 CLI 版本（如 codex 的 0.144.6）。
    cli_version text NOT NULL DEFAULT '',
    -- 可执行文件绝对路径（Windows 上是 .exe/.cmd 的完整路径）。
    cli_path    text NOT NULL DEFAULT '',
    -- 最近一次探测到的时间。空 = 从未上报（老 CLI），页面不拿它下结论。
    probed_at   timestamptz,
    updated_at  timestamptz NOT NULL DEFAULT now()
);
