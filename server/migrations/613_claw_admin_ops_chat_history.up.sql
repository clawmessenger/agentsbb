-- 管理端「节点管理 → 运维对话」的历史记录。
--
-- 背景（2026-11-23）：运维对话原先只有进程内状态——OpsChatBroker 按 request_id
-- 存 5 分钟就删，前端 turns 只活在当前抽屉里。用户换节点/关抽屉/刷新页面后，
-- 之前问过什么、设备答过什么一概查不到。审计表 claw_admin_audit_logs 只记节点、
-- 对端、request_id 和文本长度，**刻意不记正文**（运维对话常直接贴配置片段），
-- 因此不能拿审计表冒充历史。
--
-- 这张表是显式产品决定：运维对话的正文与回复落库，供管理端按节点回看。
-- 访问面只有 /api/admin/nodes/{id}/ops-chat/history，仍是 system:write 闸门，
-- 且按节点过滤；不进任何普通用户/C 端接口。request_id 唯一，重复结算不会写重。
CREATE TABLE IF NOT EXISTS claw_admin_ops_chat_history (
    id          bigserial PRIMARY KEY,
    -- rongcloud_node.node_id 或它的 uuid 文本（与运维对话 URL 的 {id} 同源）。
    node_id     text NOT NULL,
    request_id  text NOT NULL UNIQUE,
    ops_peer_id text NOT NULL DEFAULT '',
    question    text NOT NULL,
    reply       text NOT NULL DEFAULT '',
    status      text NOT NULL,
    error_code  text NOT NULL DEFAULT '',
    elapsed_ms  bigint NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    settled_at  timestamptz
);

CREATE INDEX IF NOT EXISTS claw_admin_ops_chat_history_node_recent
    ON claw_admin_ops_chat_history (node_id, id DESC);
