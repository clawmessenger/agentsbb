-- 联系人备注：用户对「某个人 / 某个智能体」的私有标注，跨设备同步。
--
-- 为什么落库：备注在微信里是「只给自己看的名字」。原来的实现存在浏览器
-- localStorage（xiachat.contacts.remark.v1），换电脑/换手机就没了，用户以为
-- 是 bug。它是账号级偏好，不是某台机器的本地状态 —— 与 606 的分组同一个判据。
--
-- 三列语义：
--   owner_user_id   做备注的人（= claw_im_users.user_id，与 clawRequireClawUser 同源）
--   target_user_id  被备注的人/智能体（融云 userId：claw_xxx / node_xxx / 融云侧任何 id）
--   remark          **已 trim** 的备注文本；行存在即「有备注」，空串不允许落库
--
-- 刻意不建外键，两个方向都不建：
--   1) 不 FK 到 claw_im_users：好友可以是纯融云侧账号，本地没有行。加了 FK 会让
--      「给一个还没同步到本地的 agent 加备注」直接失败。
--   2) 不 FK 到 rongcloud_node：备注允许落在已被解绑的节点上（用户给一个已解绑
--      的智能体留一句「这是老机器」是合理需求），而解绑不该连带删掉备注。
--
-- 刻意不加 version 列：并发口径是「最后写入胜」，备注没有可合并语义。
--
-- 刻意不加额外索引：唯一查询是 WHERE owner_user_id = $1，主键 (owner_user_id,
-- target_user_id) 的最左前缀已经覆盖，多一个索引只是多一份写放大。

CREATE TABLE IF NOT EXISTS im_contact_remark (
    owner_user_id   TEXT        NOT NULL,
    target_user_id  TEXT        NOT NULL,
    remark          TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT im_contact_remark_pkey
        PRIMARY KEY (owner_user_id, target_user_id),
    -- 给自己加备注在界面上是不可见状态（名片标题永远显示自己），且会给「我这行
    -- 到底叫什么」制造两个答案，直接挡在库里。
    CONSTRAINT im_contact_remark_not_self
        CHECK (target_user_id <> owner_user_id),
    CONSTRAINT im_contact_remark_target_not_blank
        CHECK (length(btrim(target_user_id)) > 0),
    -- 空备注在界面上就是「没有备注」，留着行会让「有没有备注」的判断和「备注是否
    -- 为空」分叉（前端已有两处逻辑分别判 empty 和 undefined）。删除靠 DELETE。
    -- 32 是**字符数**不是字节数：length(text) 在 PostgreSQL 里按字符计，
    -- 「写作助手」这种 4 字名不会因为 12 字节被判超限。与前端 maxLength=32 一致。
    CONSTRAINT im_contact_remark_remark_check
        CHECK (length(btrim(remark)) BETWEEN 1 AND 32)
);

COMMENT ON TABLE im_contact_remark IS
  '联系人备注（本人私有标注，跨设备同步）。行不存在 = 没有备注；不与好友关系/节点生命周期绑定。';
COMMENT ON COLUMN im_contact_remark.owner_user_id IS
  '做备注的人：claw_im_users.user_id（融云 userId），与 clawRequireClawUser 返回值同源。';
COMMENT ON COLUMN im_contact_remark.target_user_id IS
  '被备注的人或智能体：融云 userId。web 取 device.sn / friend.userId，移动端取 device.rongcloud_id / user.userId。';
COMMENT ON COLUMN im_contact_remark.remark IS
  '已 trim 的备注文本，长度按字符计 1..32。32 个中文（96 字节）合法。';
