package rongcloud

// user_profiles_command_test.go 钉住 service=user/action=getProfiles —— 批量按
// id 取用户资料（实现见 user_profiles_command.go，路由见 user_command.go 的
// `case "getProfiles"`）。
//
// 这条命令通道是「群聊添加成员弹窗里所有头像都一样」的服务端修复：web 的
// contacts.ts 调 user/getProfiles 补好友资料，此前 action 未实现走 404，
// bestEffortWithin 吞掉后 profileMap 为空，agent 节点只能落一张默认头像。
//
// 与 user_search_command_test.go 同样的处境：本机没有真实 Postgres，DB 命中分支
// 无法端到端驱动（GetRongCloudUsersByRongCloudIDs 是 sqlc 生成物，列序由 sqlc
// 保证，集成环境由真实 DB 覆盖）。所以分两层钉：
//   A. 回包形状是 web 的硬契约 —— sendSystemRequest<UserInfo[]> resolve 的就是
//      信封的 data 本身，形状错了前端 profiles.map 直接抛 TypeError；
//   B. SQL 形状钉死 `ANY($1::text[])` 与表名/列，防止将来手滑改回逐行单查或把
//      绑定数组退化成字符串拼接。

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// --- A. 命令通道行为 ---------------------------------------------------------

// newProfilesHandler 构造一个可注入 queries 的 handler（其余字段保持 nil，任何
// 多余的依赖触碰都会 nil panic 而不是被静默兜底）。
func newProfilesHandler(t *testing.T, queries *db.Queries) (*imServiceServer, *systemHandler) {
	t.Helper()
	rec, srv := newIMServiceServer(t, imServiceServerOptions{})
	t.Cleanup(srv.Close)
	handler := newIMServiceHandler(t, srv)
	handler.queries = queries
	return rec, handler
}

// wantProfilesData 取 reply.data 并要求它是 JSON 数组。`null` 会在这里直接
// fatal —— 前端 `profiles.map(...)` 对 null 抛 TypeError，这正是要防的形状。
func wantProfilesData(t *testing.T, reply map[string]interface{}) []interface{} {
	t.Helper()
	list, ok := reply["data"].([]interface{})
	if !ok {
		t.Fatalf("reply.data = %#v, want a JSON array — the web resolves the array "+
			"directly (sendSystemRequest<UserInfo[]>) and `null` breaks profiles.map "+
			"(full reply %#v)", reply["data"], reply)
	}
	return list
}

// profilesEntry 在断言前把数组元素收窄成对象，失败时把整个列表带出来。
func profilesEntry(t *testing.T, list []interface{}, index int) map[string]interface{} {
	t.Helper()
	if index >= len(list) {
		t.Fatalf("data has %d entries, want at least %d (full data %#v)", len(list), index+1, list)
	}
	entry, ok := list[index].(map[string]interface{})
	if !ok {
		t.Fatalf("data[%d] = %#v, want an object (full data %#v)", index, list[index], list)
	}
	return entry
}

// 空列表（含缺键 / 全空白 / 逗号空串）→ success/200 + []，且绝不能碰 DB。
// 空列表在调用方（contacts.ts 的 bestEffortWithin 语义）是合法回包，回 400 只会
// 制造一次注定被吞的错误。序列化必须是真数组：`"data":null` 会让前端 .map 抛
// TypeError。
func TestUserProfilesEmptyListRepliesAnEmptyArray(t *testing.T) {
	cases := []struct {
		name    string
		payload map[string]interface{}
	}{
		{"userIds omitted", map[string]interface{}{}},
		{"userIds is an empty array", map[string]interface{}{"userIds": []interface{}{}}},
		{"userIds is whitespace only", map[string]interface{}{"userIds": []interface{}{"  ", "\t"}}},
		{"user_ids alias is empty too", map[string]interface{}{"user_ids": []interface{}{}}},
		{"userIds is a blank comma string", map[string]interface{}{"userIds": " , ,"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec, handler := newProfilesHandler(t, nil) // queries 未装配也不该被碰到

			sendWebCommand(t, handler, "user-7", "user", "getProfiles", tc.payload)

			reply := rec.last(t)
			if reply["status"] != "success" || reply["code"] != float64(200) {
				t.Fatalf("status/code = %#v/%#v, want success/200 — an empty list is a "+
					"legal reply under the caller's bestEffort semantics (reply %#v)",
					reply["status"], reply["code"], reply)
			}
			list := wantProfilesData(t, reply)
			if len(list) != 0 {
				t.Fatalf("data = %#v, want an empty array", list)
			}
			encoded, err := json.Marshal(reply)
			if err != nil {
				t.Fatalf("re-marshal reply: %v", err)
			}
			if strings.Contains(string(encoded), `"data":null`) {
				t.Fatalf("serialized reply = %s, want a real empty array, not null", encoded)
			}
		})
	}
}

// 键名兼容：user_ids（历史别名）与 userIds 同义。这里用「queries 未装配时非空
// id 列表必须 503」做判据 —— 503（而不是 success/[]）恰好证明别名键里的 id 被
// 读到了，否则会走空列表分支。
func TestUserProfilesReadsTheUserIdsSnakeAlias(t *testing.T) {
	t.Run("user_ids carries the ids while userIds is absent", func(t *testing.T) {
		rec, handler := newProfilesHandler(t, nil)

		sendWebCommand(t, handler, "user-7", "user", "getProfiles",
			map[string]interface{}{"user_ids": []interface{}{"100001"}})

		wantWebError(t, rec.last(t), 503, "user service is unavailable")
	})

	t.Run("userIds wins when both keys are present", func(t *testing.T) {
		rec, handler := newProfilesHandler(t, nil)

		sendWebCommand(t, handler, "user-7", "user", "getProfiles",
			map[string]interface{}{
				"userIds":  []interface{}{"100001"},
				"user_ids": []interface{}{"100002"},
			})

		wantWebError(t, rec.last(t), 503, "user service is unavailable")
	})

	t.Run("both keys blank falls through to the empty reply", func(t *testing.T) {
		rec, handler := newProfilesHandler(t, nil)

		sendWebCommand(t, handler, "user-7", "user", "getProfiles",
			map[string]interface{}{
				"userIds":  []interface{}{},
				"user_ids": []interface{}{""},
			})

		reply := rec.last(t)
		if reply["status"] != "success" {
			t.Fatalf("status = %#v, want success (reply %#v)", reply["status"], reply)
		}
		if list := wantProfilesData(t, reply); len(list) != 0 {
			t.Fatalf("data = %#v, want an empty array", list)
		}
	})
}

// queries 未装配：非空 id 列表必须 503「能力未启用」，不能 panic。无 DB 的部署里
// queries 就是 nil（registration.go 只在有 DB 时装配），503 后前端 bestEffort
// 吞掉、退回 IM SDK 好友表，行为与修复前一致。
func TestUserProfilesFailsClosedWithoutTheQueries(t *testing.T) {
	rec, handler := newProfilesHandler(t, nil)

	sendWebCommand(t, handler, "user-7", "user", "getProfiles",
		map[string]interface{}{"userIds": []interface{}{"100001", "100002"}})

	wantWebError(t, rec.last(t), 503, "user service is unavailable")
}

// 回包形状契约：data **直接是数组**，不能包成 {list:[...]}。user/search 走
// {list} 是因为它的前端解包读 result?.list；user/getProfiles 的解包直接拿
// data 本身（contacts.ts:204 的 sendSystemRequest<UserInfo[]>）。两个 action
// 两种形状，这里防止有人「顺手统一」。
func TestUserProfilesRepliesABareArrayNotAListEnvelope(t *testing.T) {
	rec, handler := newProfilesHandler(t, nil)

	sendWebCommand(t, handler, "user-7", "user", "getProfiles",
		map[string]interface{}{"userIds": []interface{}{}})

	reply := rec.last(t)
	if _, isMap := reply["data"].(map[string]interface{}); isMap {
		t.Fatalf("reply.data = %#v, want a bare array — the web types this call as "+
			"UserInfo[] and builds profileMap from it directly", reply["data"])
	}
}

// --- B. SQL 形状契约 ----------------------------------------------------------

// capturingDBTX 捕获生成代码发出的 SQL 文本与绑定参数，随后按预置行回放。有了
// 它就能在没有真实 Postgres 的机器上，把「handler → sqlc 生成查询 → 回包映射」
// 整条链驱动起来。
type capturingDBTX struct {
	sql  string
	args []interface{}
	rows [][]string // 每行 11 列，列序 = RongcloudUser 的 Scan 顺序（sqlc 生成）
}

func (c *capturingDBTX) Exec(_ context.Context, _ string, _ ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.NewCommandTag("SELECT 0"), nil
}

func (c *capturingDBTX) Query(_ context.Context, query string, args ...interface{}) (pgx.Rows, error) {
	c.sql = query
	c.args = args
	return &profileRowsStub{rows: c.rows}, nil
}

func (c *capturingDBTX) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	return profileNoRowsRow{}
}

// profileRowsStub 是一个只回预置行的假 pgx.Rows（列值全部是 string，Scan 走
// 反射逐列写入；pgtype.Text 等目标类型由 database/sql 风格的字符串直填兼容 ——
// pgx v5 的行扫描在传 *pgtype.Text 时接受 string 源）。
type profileRowsStub struct {
	rows [][]string
	next int
	done bool
}

func (r *profileRowsStub) Next() bool {
	if r.done {
		return false
	}
	r.next++
	if r.next > len(r.rows) {
		r.done = true
		return false
	}
	return true
}

func (r *profileRowsStub) Scan(dest ...any) error {
	if r.next < 1 || r.next > len(r.rows) {
		return pgx.ErrNoRows
	}
	row := r.rows[r.next-1]
	if len(dest) != len(row) {
		return fmt.Errorf("profileRowsStub: scan target count %d != row column count %d", len(dest), len(row))
	}
	for i, d := range dest {
		if err := profileAssignString(d, row[i]); err != nil {
			return err
		}
	}
	return nil
}

// profileAssignString 把字符串源写进 *string / *pgtype.Text 目标（覆盖
// RongcloudUser 生成结构里出现的两类可文本列；时间戳/UUID/布尔列在下面的用例里
// 不参与断言，统一给占位串并由 pgtype 的自动转换处理）。
func profileAssignString(dest any, value string) error {
	switch target := dest.(type) {
	case *string:
		*target = value
	case *pgtype.Text:
		*target = pgtype.Text{String: value, Valid: true}
	case *pgtype.UUID:
		if value == "" {
			*target = pgtype.UUID{}
		} else {
			return fmt.Errorf("profileRowsStub: uuid column not supported in this stub (got %q)", value)
		}
	case *pgtype.Timestamptz:
		*target = pgtype.Timestamptz{}
	case *bool:
		*target = value == "true"
	default:
		return fmt.Errorf("profileRowsStub: unsupported scan target %T", dest)
	}
	return nil
}

func (r *profileRowsStub) Values() ([]any, error) {
	if r.next < 1 || r.next > len(r.rows) {
		return nil, pgx.ErrNoRows
	}
	out := make([]any, len(r.rows[r.next-1]))
	for i, v := range r.rows[r.next-1] {
		out[i] = v
	}
	return out, nil
}

func (r *profileRowsStub) RawValues() [][]byte { return nil }

func (r *profileRowsStub) Close() {}

func (r *profileRowsStub) Err() error { return nil }

func (r *profileRowsStub) CommandTag() pgconn.CommandTag { return pgconn.CommandTag{} }

func (r *profileRowsStub) FieldDescriptions() []pgconn.FieldDescription { return nil }

func (r *profileRowsStub) TypeMap() *pgtype.Map { return nil }

func (r *profileRowsStub) Conn() *pgx.Conn { return nil }

type profileNoRowsRow struct{}

func (profileNoRowsRow) Scan(...interface{}) error { return pgx.ErrNoRows }

// profileMirrorRow 按 RongcloudUser 的 Scan 列序拼一行镜像记录：
// [id(uuid), workspace_id(uuid), rongcloud_user_id, name, portrait_uri,
//
//	token_encrypted, is_system_reserved(bool), is_ai_node(bool), node_type,
//	created_at, updated_at]。uuid/时间列不参与断言，给空占位（stub 对空串返回
//
// 零值）；布尔列用 "true"/"false" 文本。
func profileMirrorRow(rcID, name, portrait string) []string {
	return []string{
		"",       // id (uuid)
		"",       // workspace_id (uuid)
		rcID,     // rongcloud_user_id
		name,     // name
		portrait, // portrait_uri
		"",       // token_encrypted
		"false",  // is_system_reserved
		"false",  // is_ai_node
		"",       // node_type
		"",       // created_at
		"",       // updated_at
	}
}

// 把 GetRongCloudUsersByRongCloudIDs 的 SQL 文本当契约钉死：
//   - 必须 `ANY($1::text[])` 批量绑定 —— 退化成 `IN (...)` 拼接会把 id 拼进
//     SQL 文本（注入面），退化成逐行 `$1` 单查会复活 N+1（融云群成员一次十几个）；
//   - 目标表必须是 rongcloud_user（镜像表就是权威投影，不许偷偷改查
//     claw_im_users —— 那张表没有 agent 节点）；
//   - 带出的列必须覆盖 name / portrait_uri —— 回包的 nickname/portraitUri 全靠
//     它们，少一列前端就白等。
//
// 这条防线与 user_search_command_test.go 的 B 组同理：这条 SQL 至今没在真实
// Postgres 上执行过（本机无 psql / TEST_DATABASE_URL），文本契约是唯一的
// 自动化防线。SQL 从 capturingDBTX 捕获 —— 即真实走一遍生成代码，不需要反射
// 去抠 unexported 常量。
func TestUserProfilesQueryIsABatchAnyLookup(t *testing.T) {
	dbtx := &capturingDBTX{rows: [][]string{profileMirrorRow("100001", "爱丽丝", "https://example.test/a.png")}}
	rec, handler := newProfilesHandler(t, db.New(dbtx))

	sendWebCommand(t, handler, "user-7", "user", "getProfiles",
		map[string]interface{}{"userIds": []interface{}{"100001"}})

	reply := rec.last(t)
	if reply["status"] != "success" {
		t.Fatalf("status = %#v, want success (reply %#v)", reply["status"], reply)
	}
	for _, cond := range []struct{ label, fragment string }{
		{"the rongcloud_user mirror table", "rongcloud_user"},
		{"a single ANY($1::text[]) array binding", "ANY($1::text[])"},
	} {
		if !strings.Contains(dbtx.sql, cond.fragment) {
			t.Fatalf("query = %s, want it to use %s — per-id queries or a "+
				"string-concatenated IN list would reopen N+1 / injection", dbtx.sql, cond.label)
		}
	}
	if strings.Contains(dbtx.sql, "claw_im_users") {
		t.Fatalf("query = %s, must not read claw_im_users — agent nodes live only "+
			"in the rongcloud_user mirror", dbtx.sql)
	}
	for _, column := range []string{"name", "portrait_uri"} {
		if !strings.Contains(dbtx.sql, column) {
			t.Fatalf("query = %s, want it to select %s — the reply's nickname/portraitUri "+
				"come from these columns", dbtx.sql, column)
		}
	}
	// 绑定参数必须是整个 id 数组一次性传入（不是拆成多个绑定或拼进文本）。
	if len(dbtx.args) != 1 {
		t.Fatalf("query bound %d arguments (%#v), want exactly one array binding", len(dbtx.args), dbtx.args)
	}
	ids, ok := dbtx.args[0].([]string)
	if !ok {
		t.Fatalf("bound argument = %#v, want []string", dbtx.args[0])
	}
	if len(ids) != 1 || ids[0] != "100001" {
		t.Fatalf("bound ids = %#v, want [100001]", ids)
	}
}

// 正常路径（镜像命中 + 缺失占位）：镜像里只配了 100001 一个用户，请求 3 个 id
// （多出一个不存在的）—— 回包必须 3 条、按请求顺序排列：
//   - 存在者：nickname/portraitUri 来自镜像（name/portrait_uri 列）；
//   - 缺失者：占位 {userId, username: <原id>, nickname:"", portraitUri:""}。
//
// 前端 contacts.ts 靠 profileMap.get(friend.userId) 对齐（contacts.ts:215），
// 缺键等于该成员白等一轮 —— 所以「没查到的也要占位」是硬契约，不是锦上添花。
func TestUserProfilesRepliesProfilesWithPlaceholdersForMissingIDs(t *testing.T) {
	dbtx := &capturingDBTX{rows: [][]string{
		profileMirrorRow("100001", "爱丽丝", "https://example.test/a.png"),
		profileMirrorRow("100002", "鲍勃", ""),
	}}
	rec, handler := newProfilesHandler(t, db.New(dbtx))

	sendWebCommand(t, handler, "user-7", "user", "getProfiles",
		map[string]interface{}{"userIds": []interface{}{"100001", "404", "100002"}})

	reply := rec.last(t)
	if reply["status"] != "success" || reply["code"] != float64(200) {
		t.Fatalf("status/code = %#v/%#v, want success/200 (reply %#v)",
			reply["status"], reply["code"], reply)
	}
	list := wantProfilesData(t, reply)
	if len(list) != 3 {
		t.Fatalf("data length = %d, want 3 — every requested id must get an entry "+
			"so the web's profileMap lookup never misses (full reply %#v)", len(list), reply)
	}

	first := profilesEntry(t, list, 0)
	for _, field := range []struct{ name, want string }{
		{"userId", "100001"},
		{"username", "100001"},
		{"nickname", "爱丽丝"},
		{"portraitUri", "https://example.test/a.png"},
	} {
		if got := first[field.name]; got != field.want {
			t.Errorf("data[0].%s = %#v, want %q (entry %#v)", field.name, got, field.want, first)
		}
	}
	for _, snake := range []string{"user_id", "portrait_uri", "nick_name"} {
		if _, exists := first[snake]; exists {
			t.Errorf("data[0] carries the snake_case key %q — keys must stay camelCase (%#v)",
				snake, first)
		}
	}

	missing := profilesEntry(t, list, 1)
	if missing["userId"] != "404" {
		t.Fatalf("data[1].userId = %#v, want the original id 404 — the web matches "+
			"profiles by userId", missing)
	}
	for _, field := range []string{"nickname", "portraitUri"} {
		if got := missing[field]; got != "" {
			t.Errorf("data[1].%s = %#v, want an empty string placeholder (%#v)", field, got, missing)
		}
	}
	if missing["username"] != "404" {
		t.Errorf("data[1].username = %#v, want the original id as a non-empty fallback (%#v)",
			missing["username"], missing)
	}

	second := profilesEntry(t, list, 2)
	if second["userId"] != "100002" || second["nickname"] != "鲍勃" {
		t.Fatalf("data[2] = %#v, want {userId:100002, nickname:鲍勃} — the reply must "+
			"preserve the request order, not the mirror's row order", second)
	}
	if second["portraitUri"] != "" {
		t.Errorf("data[2].portraitUri = %#v, want an empty string when the mirror row "+
			"has no portrait (%#v)", second["portraitUri"], second)
	}
}

// 去重 + 修剪：请求里重复的 id 只回一条；超过 userProfilesLimit 的部分被丢弃，
// 且只裁 id 列表、不影响其余逻辑。
func TestUserProfilesDedupesAndCapsTheIDList(t *testing.T) {
	dbtx := &capturingDBTX{rows: [][]string{
		profileMirrorRow("100001", "爱丽丝", ""),
	}}
	rec, handler := newProfilesHandler(t, db.New(dbtx))

	sendWebCommand(t, handler, "user-7", "user", "getProfiles",
		map[string]interface{}{"userIds": []interface{}{"100001", "100001", " 100001 "}})

	reply := rec.last(t)
	if reply["status"] != "success" {
		t.Fatalf("status = %#v, want success (reply %#v)", reply["status"], reply)
	}
	list := wantProfilesData(t, reply)
	if len(list) != 1 {
		t.Fatalf("data length = %d, want 1 — duplicated ids must collapse to one entry "+
			"(full reply %#v)", len(list), reply)
	}
	entry := profilesEntry(t, list, 0)
	if entry["userId"] != "100001" {
		t.Fatalf("data[0].userId = %#v, want 100001", entry)
	}

	t.Run("oversized requests are capped, not rejected", func(t *testing.T) {
		ids := make([]interface{}, 0, userProfilesLimit+5)
		for i := 0; i < userProfilesLimit+5; i++ {
			ids = append(ids, fmt.Sprintf("u%03d", i))
		}
		dbtx := &capturingDBTX{}
		rec, handler := newProfilesHandler(t, db.New(dbtx))

		sendWebCommand(t, handler, "user-7", "user", "getProfiles",
			map[string]interface{}{"userIds": ids})

		reply := rec.last(t)
		if reply["status"] != "success" {
			t.Fatalf("status = %#v, want success — a large-but-legal batch must not 400 (reply %#v)",
				reply["status"], reply)
		}
		if len(dbtx.args) != 1 {
			t.Fatalf("bound args = %#v, want one array binding", dbtx.args)
		}
		bound, ok := dbtx.args[0].([]string)
		if !ok {
			t.Fatalf("bound argument = %#v, want []string", dbtx.args[0])
		}
		if len(bound) != userProfilesLimit {
			t.Fatalf("bound id count = %d, want %d — the cap protects the reply message size",
				len(bound), userProfilesLimit)
		}
	})
}

// 路由契约：user/getProfiles 必须接进 handleUserCommand 的 switch —— 走 default
// 404 正是本次要修的 bug。这里钉住路由本身，防止将来重构时 case 被挪丢。
func TestUserProfilesActionIsRouted(t *testing.T) {
	rec, handler := newProfilesHandler(t, nil)

	sendWebCommand(t, handler, "user-7", "user", "getProfiles",
		map[string]interface{}{"userIds": []interface{}{"100001"}})

	// 503（DB 未装配）而不是 404「未知的服务或操作」—— 404 说明路由丢了。
	reply := rec.last(t)
	if reply["code"] == float64(404) {
		t.Fatalf("user/getProfiles hit the default 404 branch — the route in "+
			"handleUserCommand is missing (reply %#v)", reply)
	}
	wantWebError(t, reply, 503, "user service is unavailable")
}
