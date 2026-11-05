-- 「点启动真的能启动」的可观测性收口（2026-11-05）。
--
-- 问题现场：管理端点「启动」只写期望状态（rongcloud_node_control.desired_state），
-- 真正去拉起 agent 的是设备上每 10 秒轮询一次的 supervisor。于是有两种沉默的失败：
--   1. 设备上根本没有 supervisor 在跑（崩溃后没人拉起、计划任务被安全软件拦掉）——
--      指令永远挂着，页面只显示「待启动 · 等待设备执行」，看不出「这台机器压根没人
--      消费指令」；
--   2. supervisor 在，但那个 agent 的 CLI 不在 PATH 上 / 启动即崩 —— 同样永远停在
--      「待启动」，运维只能去设备上看日志。
-- 本轮给两处补齐设备侧的**事实**，让页面能说人话。

-- 一、机器级：常驻自愈是否就位。
--
-- 一台机器一行（与 reported_version/install_dir 同表同生命周期）。ready=false 的含义
-- 是「这台机器掉线后不会自己回来」：Windows 缺计划任务看门狗，或 Linux/macOS 没装
-- systemd/launchd 单元。空 service_at = 老 CLI 没报过（页面不显示，也不下结论）。
ALTER TABLE rongcloud_node_upgrade
    ADD COLUMN IF NOT EXISTS service_ready boolean NOT NULL DEFAULT false;

-- 为什么没就位：给页面/排障直接可读的一句话（如「计划任务注册被拒绝：schtasks
-- failed」）。写入端只做长度截断，不做枚举 —— 它是诊断文本，不是状态机。
ALTER TABLE rongcloud_node_upgrade
    ADD COLUMN IF NOT EXISTS service_detail text NOT NULL DEFAULT '';

-- 最近一次上报时间。与 service_ready 一起构成三态：NULL=未知（老 CLI）、
-- 有时间戳+true=就位、有时间戳+false=没就位。没有这一列就分不清「没报过」和「报的
-- 是 false」—— 那会把所有老设备都误标成「不会自愈」。
ALTER TABLE rongcloud_node_upgrade
    ADD COLUMN IF NOT EXISTS service_at timestamptz;

-- 二、节点级：设备对启停指令的执行回执。
--
-- 设备每轮轮询顺带上报「我这个 agent 现在到底是什么状态、收敛到哪一版意图」，
-- 服务端贴在指令行上。页面据此把「已下发」和「已生效 / 失败」分开：
--   applied_version >= desired_version 且 applied_state == desired_state → 已生效
--   applied_state = missing / failed（或 applied_error 非空）      → 失败，附原因
--   其余（含从未上报）                                             → 待设备确认
--
-- 为什么不新开一张表：这两个字段描述的就是「这一条指令被执行到哪一步」，
-- 与 desired_state/desired_version 同一行同一生命周期；拆表只会多一个 join 和一次
-- 不一致的机会（620/610 的 install_dir / remote_ip 是同样的取舍）。
ALTER TABLE rongcloud_node_control
    ADD COLUMN IF NOT EXISTS applied_state text NOT NULL DEFAULT '';

ALTER TABLE rongcloud_node_control
    ADD COLUMN IF NOT EXISTS applied_version bigint NOT NULL DEFAULT 0;

-- 失败原因（人可读）。空串 = 没有失败信息。
ALTER TABLE rongcloud_node_control
    ADD COLUMN IF NOT EXISTS applied_error text NOT NULL DEFAULT '';

-- 回执时间。NULL = 设备从未确认过这一行（老 CLI / 设备离线）。
ALTER TABLE rongcloud_node_control
    ADD COLUMN IF NOT EXISTS applied_at timestamptz;
