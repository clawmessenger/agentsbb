-- 设备出口 IP（服务端观测），详情页「公网 IP」一行。
--
-- 为什么不靠设备自己上报：设备要拿到自己的公网出口，只能去问某个 IP 回显服务
-- （api.ipify.org 之类）—— 那是「设备能不能出网」的又一次赌博，而现场已经出现过
-- 整批设备连不上 GitHub 的情况；而且每加一个上报字段都要发一版 CLI，老版本设备
-- 永远看不到（现在线上还混跑 1.3.16~1.3.21）。
--
-- 服务端本来就看得到：supervisor 每 10 秒来轮询一次 /api/claw/device/control，
-- 这次连接的来源地址就是这台机器出口到平台的 IP —— 不需要设备配合、不需要发版，
-- 下一轮轮询（10 秒内）所有在线设备就都有了值。这也是运维真正要的那个数：在防火
-- 墙/白名单里该放谁。
--
-- 口径（详情页也照这个说）：「服务端观测」，不是设备自述。设备在 NAT 后面时它是
-- 出口 IP（通常就是公网 IP）；设备与服务端同处内网时它会是内网地址 —— UI 用
-- remote_ip_public 区分并打「内网」标记，而不是假装成公网地址。
--
-- 空串 = 设备还没轮询过（老部署 / 从未在线）。写入端用 IS DISTINCT FROM 判重，
-- IP 没变就只刷 remote_ip_at，不制造无意义的行更新。
ALTER TABLE rongcloud_node_upgrade
    ADD COLUMN IF NOT EXISTS remote_ip text NOT NULL DEFAULT '';

-- 最近一次观测到该 IP 的时间。与 reported_at 分开：reported_at 只在设备带
-- 版本/主机名上报时刷新，而 IP 每轮轮询都能确认，用它才好判断「这个 IP 是不是
-- 已经过期了」。
ALTER TABLE rongcloud_node_upgrade
    ADD COLUMN IF NOT EXISTS remote_ip_at timestamptz;
