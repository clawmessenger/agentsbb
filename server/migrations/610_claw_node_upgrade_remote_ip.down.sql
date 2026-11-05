ALTER TABLE rongcloud_node_upgrade
    DROP COLUMN IF EXISTS remote_ip_at;

ALTER TABLE rongcloud_node_upgrade
    DROP COLUMN IF EXISTS remote_ip;
