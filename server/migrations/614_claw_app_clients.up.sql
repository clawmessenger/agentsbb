-- 外部应用接入凭据（P2：犇马 / SuperWagie 场景）。
--
-- 为什么需要它：C 端用户凭的是「本人融云 token」，但外部应用要替自己的用户去
-- 初始化虾说身份、签发窗口登录票据 —— 这两个动作发生在用户还没有虾说 token 之前，
-- 只能用应用级凭据（AppId + AppSecret）。
--
-- 不存明文 secret：库里只留 sha256，签发时返回一次原文。需要轮换时新建一行 +
-- 把旧行置 revoked，不做原地改写（审计上看得到「什么时候换的」）。
--
-- rate_per_min 是应用维度频控，与 MCP 的按用户限流叠加而不是替代：用户维度
-- 防单账号刷，应用维度防一个坏掉的对端把整个服务打满。
CREATE TABLE IF NOT EXISTS claw_app_clients (
    app_id           text PRIMARY KEY,
    app_secret_hash  text NOT NULL,
    name             text NOT NULL DEFAULT '',
    status           text NOT NULL DEFAULT 'active',
    rate_per_min     integer NOT NULL DEFAULT 120,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    last_used_at     timestamptz
);

-- 外部用户 → 虾说账号的映射。user_id 是确定性派生的
-- （app_<appId>_<externalUserId> 的规范化形式），这张表是它的可读索引 +
-- 首次初始化时的幂等锚点（同一外部用户重复 init 只建一个虾说账号）。
-- 不用 UNIQUE(external_user_id) 单列：不同应用的外部 id 空间互不相干。
CREATE TABLE IF NOT EXISTS claw_app_identities (
    app_id            text NOT NULL,
    external_user_id  text NOT NULL,
    claw_user_id      text NOT NULL,
    display_name      text NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (app_id, external_user_id)
);

CREATE INDEX IF NOT EXISTS claw_app_identities_user
    ON claw_app_identities (claw_user_id);
