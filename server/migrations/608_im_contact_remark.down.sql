-- 608 的回滚：备注是纯偏好数据，删掉即回到「没有备注、按昵称显示」的旧行为。
--
-- 安全性（逐条核对过，不要凭感觉改）：
--   1) 本表**不被任何表以 FK 引用**：up 里没有对本表的外键，也没有其它迁移提到
--      im_contact_remark（`grep -r im_contact_remark migrations/` 只命中 608 自己）。
--   2) 本表**不引用任何表**，所以 drop 不会连带、也不会被连带。
--   3) 本表不参与任何视图 / 触发器 / 物化视图。
--   4) 回滚后前端会走「GET 404 → 备注表当空」的降级路径（web 与移动端都实现），
--      不需要同时回滚前端 —— 与 606 down 的说明同一口径。
--
-- 禁止：在 down 里 DROP 任何不是 608 创建的对象；禁止把 down 挂进 supervise /
-- restart-server.sh（迁移只允许显式 up / down）。

DROP TABLE IF EXISTS im_contact_remark;
