package handler

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/integrations/rongcloud"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func testNodeRecord(nodeID, rcUser, aiType, machineID string) clawAdminNodeRecord {
	var id pgtype.UUID
	if err := id.Scan("5e88b789-55ef-4a7e-b090-9f4e3ff208d1"); err != nil {
		panic(err)
	}
	return clawAdminNodeRecord{
		ID:              id,
		NodeID:          nodeID,
		RongcloudUserID: rcUser,
		AIType:          aiType,
		MachineID:       machineID,
		CreatedAt:       time.Date(2026, 10, 9, 3, 36, 47, 0, time.UTC),
		UpdatedAt:       time.Date(2026, 10, 9, 3, 36, 47, 0, time.UTC),
	}
}

func TestClawAdminNodeMatchesAppliesNodeTypeFilter(t *testing.T) {
	rec := testNodeRecord("node_abc", "opencode_3300776275", "opencode", "3300776275")

	if !clawAdminNodeMatches(rec, "小久 opencode", "", "", "opencode") {
		t.Fatal("an opencode node must match the opencode filter")
	}
	if clawAdminNodeMatches(rec, "小久 opencode", "", "", "hermes") {
		t.Fatal("an opencode node must not match the hermes filter")
	}
	// Empty filter means "全部节点".
	if !clawAdminNodeMatches(rec, "小久 opencode", "", "", "") {
		t.Fatal("an empty node_type filter must accept every node")
	}
}

func TestClawAdminNodeMatchesSearchesTheFieldsThePlaceholderPromises(t *testing.T) {
	rec := testNodeRecord("node_abc", "opencode_3300776275", "opencode", "3300776275")

	for _, keyword := range []string{
		"node_abc",            // 节点ID
		"小久 opencode",         // 名称（存于 rongcloud_user.name）
		"机房 A 的主力镜像节点",        // 描述（存于 rongcloud_system_config）
		"opencode_3300776275", // 融云 id
		"3300776275",          // machine id
		"OPENCODE",            // 大小写不敏感
	} {
		if !clawAdminNodeMatches(rec, "小久 opencode", "机房 A 的主力镜像节点", keyword, "") {
			t.Fatalf("keyword %q should match", keyword)
		}
	}
	if clawAdminNodeMatches(rec, "小久 opencode", "机房 A 的主力镜像节点", "不存在的关键词", "") {
		t.Fatal("an unrelated keyword must not match")
	}
}

func TestClawAdminNodeRowProjectsTheFrontendShape(t *testing.T) {
	h := &Handler{}
	rec := testNodeRecord("node_abc", "opencode_3300776275", "opencode", "3300776275")

	row := h.clawAdminNodeRowFor(rec, "小久 opencode", "说明", "850509", "小酒", true,
		clawAdminNodeControl{DesiredState: "running", DesiredVersion: 3})

	if row.DesiredState != "running" || row.DesiredVersion != 3 {
		t.Fatalf("desired state = %q / %d", row.DesiredState, row.DesiredVersion)
	}
	// 展示节点（普通 AI 节点）必须可启停。
	if !row.Controllable {
		t.Fatal("display node must be controllable")
	}

	if row.NodeID != "node_abc" {
		t.Fatalf("node_id = %q", row.NodeID)
	}
	if row.Name != "小久 opencode" {
		t.Fatalf("name = %q", row.Name)
	}
	if row.NodeType != "opencode" {
		t.Fatalf("node_type = %q", row.NodeType)
	}
	if row.UserID != "850509" || row.Username != "小酒" {
		t.Fatalf("归属 = %q / %q", row.UserID, row.Username)
	}
	if !row.IsSystemReserved {
		t.Fatal("is_system_reserved must be carried through")
	}
	if row.Description != "说明" {
		t.Fatalf("description = %q", row.Description)
	}
	// 线上在线态由心跳推导；没有心跳表时只能报离线，绝不能回落到库里的旧字段。
	if row.DeployStatus != "offline" {
		t.Fatalf("deploy_status = %q, want offline", row.DeployStatus)
	}
	if row.CreatedAt != "2026-10-09T03:36:47Z" {
		t.Fatalf("created_at = %q", row.CreatedAt)
	}
}

func TestClawAdminNodeRowFallsBackToAgentTypeForTheName(t *testing.T) {
	h := &Handler{}
	rec := testNodeRecord("node_abc", "opencode_3300776275", "opencode", "3300776275")

	row := h.clawAdminNodeRowFor(rec, "", "", "", "", false, clawAdminNodeControl{})

	// rongcloud_user.name 为空时显示 ai_type，而不是空串或内部 id。
	if row.Name != "opencode" {
		t.Fatalf("name = %q, want the agent type", row.Name)
	}
	if row.UserID != "" || row.Username != "" {
		t.Fatalf("an unclaimed node must not report归属: %q / %q", row.UserID, row.Username)
	}
}

func TestClawAdminNodeStatusExplainsItsSource(t *testing.T) {
	h := &Handler{}
	rec := testNodeRecord("node_abc", "opencode_3300776275", "opencode", "3300776275")

	status, detail := h.clawAdminNodeStatus(rec)

	if status != "offline" {
		t.Fatalf("status = %q, want offline when no heartbeat table is wired", status)
	}
	if detail == "" {
		t.Fatal("detail must explain where the status came from")
	}
}

// 机器名只能来自机器主节点的昵称，且必须去掉 CLI 拼上去的 " <aiType>" 后缀。
//
// 这条钉住的是一个很容易退化的行为：如果哪天有人图省事用 agent 节点自己的昵称
// 当机器名，三台机器上各自的 opencode 会全部显示成「opencode」，列表又回到
// 「三行一模一样」—— 而这正是本次需求要解决的问题。
func TestClawAdminMachineNamesComeFromTheMachineNode(t *testing.T) {
	records := []clawAdminNodeRecord{
		// 机器主节点：rc 必须等于 "rc_node_" + machineIdentityKey(machine_id)。
		testNodeRecord("node_m", "rc_node_3300776275", "opencode", "3300776275"),
		testNodeRecord("node_a", "rc_node_3300776275_hermes", "hermes", "3300776275"),
		testNodeRecord("node_b", "rc_node_3300776275_opencode", "opencode", "3300776275"),
	}
	names := map[string]string{
		"rc_node_3300776275":          "小久 opencode",
		"rc_node_3300776275_hermes":   "hermes",
		"rc_node_3300776275_opencode": "opencode",
	}
	h := &Handler{}

	got := h.clawAdminMachineNames(records, names)
	if got["3300776275"] != "小久" {
		t.Fatalf("machine name = %q, want 小久 (the aiType suffix must be stripped)", got["3300776275"])
	}
	if len(got) != 1 {
		t.Fatalf("only the machine node may contribute a machine name, got %#v", got)
	}

	// 没有机器主节点行时**不能**凭空造名字：宁可显示机器键，也不能把某个 agent
	// 的昵称当成整台机器的名字（那会让「升级」按错误的机器归并）。
	withoutMachineNode := h.clawAdminMachineNames(records[1:], names)
	if len(withoutMachineNode) != 0 {
		t.Fatalf("agent rows must never name the machine, got %#v", withoutMachineNode)
	}

	// 机器主节点的 aiType 为空（早期注册/探针行）：昵称原样保留，不要瞎截。
	probe := []clawAdminNodeRecord{testNodeRecord("node_p", "rc_node_02:95:06:48:f0:dc", "", "02:95:06:48:f0:dc")}
	probeNames := map[string]string{"rc_node_02:95:06:48:f0:dc": "bind-probe-node"}
	if name := h.clawAdminMachineNames(probe, probeNames)["02:95:06:48:f0:dc"]; name != "bind-probe-node" {
		t.Fatalf("a machine node without an aiType must keep its full nickname, got %q", name)
	}
}

// 机器名与设备主机名都要贴到行上，且主机名缺失时不能把机器名顶掉。
func TestClawAdminAttachUpgradeCarriesMachineNameAndHostname(t *testing.T) {
	h := &Handler{}
	rec := testNodeRecord("node_a", "rc_node_3300776275_hermes", "hermes", "3300776275")
	machineNames := map[string]string{"3300776275": "小久"}

	row := h.clawAdminAttachUpgrade(clawAdminNodeRow{}, rec, map[string]clawNodeUpgrade{
		"3300776275": {
			MachineID:        "3300776275",
			ReportedVersion:  "1.3.3",
			ReportedPlatform: "linux-x64",
			ReportedHostname: "SHGuoZiWei-10.1.1.225",
		},
	}, machineNames)
	if row.MachineName != "小久" || row.Hostname != "SHGuoZiWei-10.1.1.225" {
		t.Fatalf("row = %#v, want machine_name=小久 hostname=SHGuoZiWei-10.1.1.225", row)
	}

	// 机器还没上报过任何升级信息（没有行）：机器名仍然要给，否则列表第一屏
	// 全是「-」，管理员根本判断不出这行属于哪台机器。
	bare := h.clawAdminAttachUpgrade(clawAdminNodeRow{}, rec, map[string]clawNodeUpgrade{}, machineNames)
	if bare.MachineName != "小久" || bare.Hostname != "" {
		t.Fatalf("without an upgrade row the machine name must survive, got %#v", bare)
	}
}

// ---- supervisor 可达性（启停提示的判据） ------------------------------------
//
// 心跳是 agent 子进程发的：agent 被停掉后心跳停止、后台显示离线，但 supervisor
// 还活着还在 10 秒一轮地轮询 /device/control，「启动」指令马上就会被执行。判据
// 因此是「同机任一节点 90s 内有心跳」而不是「目标 agent 自己有心跳」—— 否则对
// 离线 agent 点启动会弹出「将在设备上线后执行」这种读起来像死锁的提示。

// supNodeUUID 生成一个确定性 UUID：同机各节点各占一个（seed 不同即可）。
func supNodeUUID(seed byte) pgtype.UUID {
	var id pgtype.UUID
	if err := id.Scan(fmt.Sprintf("5e88b789-55ef-4a7e-b090-9f4e3ff208%02x", seed)); err != nil {
		panic(err)
	}
	return id
}

// supHeartbeatRow 是 Heartbeat() 走 sqlc GetRongCloudNodeByNodeID 时的 20 列
// 扫描目标（rongcloud.sql.go 的 Scan 顺序）。列类型必须与 sqlc 的目标一致：
// ai_type / claimed_by_user_id 是 pgtype.Text，behavior_prompt 是 string，
// 时间列是 pgtype.Timestamptz。
func supHeartbeatRow(id pgtype.UUID, nodeID string) []any {
	created := pgtype.Timestamptz{Time: time.Date(2026, 10, 9, 3, 36, 47, 0, time.UTC), Valid: true}
	emptyUUID := pgtype.UUID{}
	return []any{
		id, emptyUUID, emptyUUID, "rc_" + nodeID, nodeID, pgtype.Text{},
		[]byte(`[]`), "online", int32(0), created, created, "", pgtype.Text{},
		false, false, false, false, false, "",
	}
}

// supMachineRows 造同一台机器的三行（机器主节点 + agent 节点 + ops 节点），
// 列序与 clawAdminNodeColumns 一致，供 clawAdminListNodeRecords 的全表查询用。
func supMachineRows(machineID string, agentSeed byte) [][]any {
	created := time.Date(2026, 10, 9, 3, 36, 47, 0, time.UTC)
	return [][]any{
		{supNodeUUID(0x01), "node_m", "rc_node_" + machineID, "", machineID, []byte(`[]`), "online", created, created},
		{supNodeUUID(agentSeed), "node_a", "rc_node_" + machineID + "_hermes", "hermes", machineID, []byte(`[]`), "online", created, created},
		{supNodeUUID(0x03), "node_o", "rc_node_" + machineID + "_ops", "ops", machineID, []byte(`[]`), "online", created, created},
	}
}

// supBeat 通过**真实的** Heartbeat() 路径把一个节点标记为在线（90s TTL）：
// 心跳表是 NodeService 的内存 map，唯一的写入点在 Heartbeat 里，绕过它去戳
// 内部状态会让用例对实现细节（而非「心跳=在线」这条业务事实）撒谎。
func supBeat(t *testing.T, h *Handler, id pgtype.UUID, nodeID string) {
	t.Helper()
	if err := h.RongCloudNode.Heartbeat(context.Background(), nodeID, "cred", "sup-secret"); err != nil {
		t.Fatalf("seed heartbeat for %s: %v", nodeID, err)
	}
}

// supHandler 装配一个带 NodeService 的 Handler：
//   - nodeRows：clawAdminListNodeRecords 全表查询返回的行
//   - beats：需要打心跳的节点（uuid + node_id），空切片表示全机无心跳
//
// 设备凭据密文用固定的 box 封装，secret 固定 "sup-secret"，与 supBeat 一致。
func supHandler(t *testing.T, nodeRows [][]any, beats ...struct {
	id     pgtype.UUID
	nodeID string
}) (*Handler, *supFakeDB) {
	t.Helper()
	box, err := secretbox.New(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatalf("secretbox.New: %v", err)
	}
	fake := &supFakeDB{nodeRows: nodeRows}
	h := &Handler{DB: fake, RongCloudNode: rongcloud.NewNodeService(nil, nil, box, nil)}

	// 心跳链路的两条 QueryRow：节点行 + 设备凭据行（密文封的是 "sup-secret"）。
	// beatUUIDByNodeID 把 beats 里的 node_id 文本映射回各自的 uuid ——
	// GetRongCloudNodeByNodeID 按 node_id 文本查询，但 Heartbeat 记进心跳表的
	// 是行里的 uuid，两张表必须对得上，心跳才会落在正确的节点上。
	sealed, err := box.Seal([]byte("sup-secret"))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	beatUUIDByNodeID := make(map[string]pgtype.UUID, len(beats))
	for _, beat := range beats {
		beatUUIDByNodeID[beat.nodeID] = beat.id
	}
	created := time.Date(2026, 10, 9, 3, 36, 47, 0, time.UTC)
	fake.queryRow = func(sql string, args []any) pgx.Row {
		switch {
		case strings.Contains(sql, "FROM claw_admin_users"):
			return &convStubRow{values: []any{supAdminID, "boss", "老板", "role-1", "active", "超级管理员", []byte(`["node:write"]`)}}
		case strings.Contains(sql, "node_id = $1 OR id::text = $1"):
			// clawAdminNodeByPathID：目标是 agent 节点那行。必须排在仅匹配
			// 前缀的 heartbeat 分支之前 —— 它的 SQL 以
			// “FROM rongcloud_node WHERE node_id = $1” 开头，会先撞上。
			return &convStubRow{values: supMachineRows("3300776275", 0x02)[1]}
		case strings.Contains(sql, "FROM rongcloud_node WHERE node_id = $1"):
			nodeID, _ := args[0].(string)
			return &convStubRow{values: supHeartbeatRow(beatUUIDByNodeID[nodeID], nodeID)}
		case strings.Contains(sql, "FROM rongcloud_device WHERE node_id"):
			// GetRongCloudDeviceByNodeAndCredential 的 11 列：只有密文列（第 7 列）
			// 会被 Heartbeat 读到，按 pgtype.Text 给，保证 Scan 成功。
			createdTS := pgtype.Timestamptz{Time: created, Valid: true}
			return &convStubRow{values: []any{
				pgtype.UUID{}, pgtype.UUID{}, pgtype.UUID{}, pgtype.UUID{},
				"box", pgtype.Text{}, pgtype.Text{String: "cred", Valid: true},
				pgtype.Text{String: base64.StdEncoding.EncodeToString(sealed), Valid: true},
				"active", createdTS, createdTS,
			}}
		}
		panic("unexpected QueryRow: " + sql)
	}
	if len(beats) > 0 {
		// Heartbeat 走的是 NodeService 自己的 queries —— 给它配上同一个 fake
		// （QueryRow 按上表应答），凭据校验即可通过。
		h.RongCloudNode = rongcloud.NewNodeService(db.New(fake), nil, box, nil)
		for _, beat := range beats {
			supBeat(t, h, beat.id, beat.nodeID)
		}
	}
	return h, fake
}

const supAdminID = "sup-admin-1"

// supFakeDB 继承 convFakeDB 的脚本化套路；全表节点查询固定返回 nodeRows。
type supFakeDB struct {
	convFakeDB
	nodeRows [][]any
}

func (f *supFakeDB) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	f.record(sql, args)
	if strings.Contains(sql, "FROM rongcloud_node ORDER BY created_at DESC") {
		return &convStubRows{rows: f.nodeRows}, nil
	}
	return &convStubRows{}, nil
}

func TestClawAdminSupervisorReachableSiblingHeartbeatCounts(t *testing.T) {
	// agent 自己（0x02）离线，但同机机器主节点（0x01）在线。
	beat := struct {
		id     pgtype.UUID
		nodeID string
	}{supNodeUUID(0x01), "beat"}
	h, _ := supHandler(t, supMachineRows("3300776275", 0x02), beat)
	rec := testNodeRecord("node_a", "rc_node_3300776275_hermes", "hermes", "3300776275")
	rec.ID = supNodeUUID(0x02)

	if !h.clawAdminSupervisorReachable(context.Background(), rec) {
		t.Fatal("a machine whose primary node heartbeats has a live supervisor")
	}
}

func TestClawAdminSupervisorReachableOpsSiblingCounts(t *testing.T) {
	// 同机的 ops 节点在线也一样成立：supervisor 会拉起所有 running 的 agent，
	// 机器上任何一个节点在心跳都说明它活着。
	beat := struct {
		id     pgtype.UUID
		nodeID string
	}{supNodeUUID(0x03), "beat"}
	h, _ := supHandler(t, supMachineRows("3300776275", 0x02), beat)
	rec := testNodeRecord("node_a", "rc_node_3300776275_hermes", "hermes", "3300776275")
	rec.ID = supNodeUUID(0x02)

	if !h.clawAdminSupervisorReachable(context.Background(), rec) {
		t.Fatal("a machine whose ops node heartbeats has a live supervisor")
	}
}

func TestClawAdminSupervisorReachableWholeMachineSilentIsFalse(t *testing.T) {
	// 整台机器没有任何节点在心跳（supervisor 死了 / 机器关机）。
	h, _ := supHandler(t, supMachineRows("3300776275", 0x02))
	rec := testNodeRecord("node_a", "rc_node_3300776275_hermes", "hermes", "3300776275")
	rec.ID = supNodeUUID(0x02)

	if h.clawAdminSupervisorReachable(context.Background(), rec) {
		t.Fatal("a machine with no heartbeat at all must not report a reachable supervisor")
	}
}

func TestClawAdminSupervisorReachableOwnHeartbeatSuffices(t *testing.T) {
	// agent 自己在线：最直接的可达信号，不必依赖同机节点。
	beat := struct {
		id     pgtype.UUID
		nodeID string
	}{supNodeUUID(0x02), "beat"}
	h, _ := supHandler(t, nil, beat)
	rec := testNodeRecord("node_a", "rc_node_3300776275_hermes", "hermes", "3300776275")
	rec.ID = supNodeUUID(0x02)

	if !h.clawAdminSupervisorReachable(context.Background(), rec) {
		t.Fatal("the agent's own heartbeat must count")
	}
}

func TestClawAdminSupervisorReachableLegacyRowFallsBackToOwnHeartbeat(t *testing.T) {
	// machine_id 为空的旧行：无法归并同机节点，回退 agent 自身心跳（修复前语义）。
	h, _ := supHandler(t, supMachineRows("3300776275", 0x02))
	legacy := testNodeRecord("node_legacy", "opencode_3300776275", "opencode", "")
	legacy.ID = supNodeUUID(0x7f)
	if h.clawAdminSupervisorReachable(context.Background(), legacy) {
		t.Fatal("a legacy row with no own heartbeat must fall back to offline")
	}

	// 同一行的 agent 自己在线 → 可达。
	beat := struct {
		id     pgtype.UUID
		nodeID string
	}{supNodeUUID(0x7f), "beat"}
	h2, _ := supHandler(t, nil, beat)
	if !h2.clawAdminSupervisorReachable(context.Background(), legacy) {
		t.Fatal("a legacy row whose agent heartbeats must be reachable")
	}
}

// 纯函数判据：别的机器心跳不算数 —— m2 的节点在线不能证明 m1 的 supervisor 活着。
func TestClawAdminMachineSupervisorAliveIgnoresOtherMachines(t *testing.T) {
	agent := testNodeRecord("node_a", "rc_node_m1_hermes", "hermes", "m1")
	agent.ID = supNodeUUID(0x02)
	records := supMachineRowsRecords("m1", 0x02)
	// 另一台机器的节点（在线）。
	other := testNodeRecord("node_x", "rc_node_m2_hermes", "hermes", "m2")
	other.ID = supNodeUUID(0x42)
	records = append(records, other)

	isOnlineOther := func(id pgtype.UUID) bool { return id == other.ID }
	if clawAdminMachineSupervisorAlive(records, "m1", agent.ID, isOnlineOther) {
		t.Fatal("a sibling on another machine must not prove this machine's supervisor")
	}
}

// supMachineRowsRecords 是 supMachineRows 的 clawAdminNodeRecord 版本。
func supMachineRowsRecords(machineID string, agentSeed byte) []clawAdminNodeRecord {
	created := time.Date(2026, 10, 9, 3, 36, 47, 0, time.UTC)
	return []clawAdminNodeRecord{
		{ID: supNodeUUID(0x01), NodeID: "node_m", RongcloudUserID: "rc_node_" + machineID, MachineID: machineID, CreatedAt: created, UpdatedAt: created},
		{ID: supNodeUUID(agentSeed), NodeID: "node_a", RongcloudUserID: "rc_node_" + machineID + "_hermes", AIType: "hermes", MachineID: machineID, CreatedAt: created, UpdatedAt: created},
		{ID: supNodeUUID(0x03), NodeID: "node_o", RongcloudUserID: "rc_node_" + machineID + "_ops", AIType: "ops", MachineID: machineID, CreatedAt: created, UpdatedAt: created},
	}
}

// ---- POST /start 的响应契约（前端弹什么文案就看这三个字段） -------------------
//
// Bug 现场：agent 被停止 → 自身心跳停 → 旧响应 device_online=false → 前端弹
// 「将在设备上线后执行」。但 supervisor 还在轮询，指令 10 秒内执行。新契约用
// supervisor_online 区分这两种情况，device_online 保留「agent 自身」语义。

// supStartHandler 在 supHandler 之上补齐 start/stop 链路的三条语句：
// 指令 upsert（RETURNING desired_version）、审计 Exec、全表控制行（可空）。
func supStartHandler(t *testing.T, machineRows [][]any, beats ...struct {
	id     pgtype.UUID
	nodeID string
}) (*Handler, *supFakeDB) {
	t.Helper()
	h, fake := supHandler(t, machineRows, beats...)
	base := fake.queryRow
	fake.queryRow = func(sql string, args []any) pgx.Row {
		switch {
		case strings.Contains(sql, "INSERT INTO rongcloud_node_control"):
			return &convStubRow{values: []any{int64(1)}}
		}
		return base(sql, args)
	}
	fake.exec = func(sql string, _ []any) (pgconn.CommandTag, error) {
		if strings.Contains(sql, "claw_admin_audit_logs") {
			return pgconn.NewCommandTag("INSERT 0 1"), nil
		}
		panic("unexpected Exec: " + sql)
	}
	return h, fake
}

// supStartRequest 造 POST /api/admin/nodes/node_a/start 的请求（JWT + chi 路由）。
func supStartRequest(t *testing.T) *http.Request {
	t.Helper()
	token, err := issueClawAdminJWT(supAdminID, "access", time.Hour)
	if err != nil {
		t.Fatalf("issue jwt: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/admin/nodes/node_a/start", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", "node_a")
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

// agent 停止但 supervisor 活着（Bug 原现场）：device_online=false 且
// supervisor_online=true —— 前端据此弹 success（约 10 秒内执行），不再弹
// 「将在设备上线后执行」。
func TestClawAdminStartNodeReportsSupervisorAliveForStoppedAgent(t *testing.T) {
	beat := struct {
		id     pgtype.UUID
		nodeID string
	}{supNodeUUID(0x01), "beat"} // 机器主节点在心跳
	h, _ := supStartHandler(t, supMachineRows("3300776275", 0x02), beat)

	rr := httptest.NewRecorder()
	h.ClawAdminStartNode(rr, supStartRequest(t))

	body := decodeConv(t, rr)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	data := dataMap(t, body)
	if data["device_online"] != false {
		t.Fatalf("device_online = %#v, want false (the agent itself is stopped)", data["device_online"])
	}
	if data["supervisor_online"] != true {
		t.Fatalf("supervisor_online = %#v, want true (the machine primary node heartbeats)", data["supervisor_online"])
	}
	detail, _ := data["delivery_detail"].(string)
	if !strings.Contains(detail, "10 秒") {
		t.Fatalf("delivery_detail = %q, want the ~10s execution hint", detail)
	}
}

// 全机失联：两个字段都 false，delivery_detail 保留挂起语义。
func TestClawAdminStartNodeKeepsPendingHintWhenMachineDown(t *testing.T) {
	h, _ := supStartHandler(t, supMachineRows("3300776275", 0x02))

	rr := httptest.NewRecorder()
	h.ClawAdminStartNode(rr, supStartRequest(t))

	body := decodeConv(t, rr)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	data := dataMap(t, body)
	if data["device_online"] != false || data["supervisor_online"] != false {
		t.Fatalf("device_online=%v supervisor_online=%v, want both false", data["device_online"], data["supervisor_online"])
	}
	detail, _ := data["delivery_detail"].(string)
	if !strings.Contains(detail, "上线后执行") {
		t.Fatalf("delivery_detail = %q, want the pending hint", detail)
	}
}
