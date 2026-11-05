-- 回滚 611：把「常驻自愈状态」与「启停回执」两处设备侧事实列删掉。
--
-- 这两组列都是纯附加的观测字段：删掉只丢历史观测值，desired_state/desired_version
-- 与升级链路完全不受影响（老代码读不存在的列会报错，所以回滚前必须先把二进制退回
-- 到不含这些查询的版本）。
ALTER TABLE rongcloud_node_upgrade
    DROP COLUMN IF EXISTS service_ready,
    DROP COLUMN IF EXISTS service_detail,
    DROP COLUMN IF EXISTS service_at;

ALTER TABLE rongcloud_node_control
    DROP COLUMN IF EXISTS applied_state,
    DROP COLUMN IF EXISTS applied_version,
    DROP COLUMN IF EXISTS applied_error,
    DROP COLUMN IF EXISTS applied_at;
