-- 设备 CLI 安装目录随版本一起上报（602 hostname 的姊妹篇）。
--
-- 为什么放这张表：它本来就是「一台机器一行」，版本/平台/主机名都在这里，
-- install_dir 与它们同一生命周期（同一次 10 秒轮询上报），拆表只会多一次
-- join 与一次不一致的机会。
--
-- 空串 = 设备还没上报（老 CLI 不带 installDir）。写入端用
-- COALESCE(NULLIF(EXCLUDED.install_dir,''), 旧值) 兜底，老 CLI 混跑期间
-- 心跳不会把已上报的目录擦掉。
ALTER TABLE rongcloud_node_upgrade
    ADD COLUMN IF NOT EXISTS install_dir text NOT NULL DEFAULT '';
