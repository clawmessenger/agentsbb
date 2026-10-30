package rongcloud

// QA 独立验证：讨论快照的 `hostNodeId` 出口穷举。
//
// 背景：C 端（uniapp `mergeDiscussionSnapshot`）是 `{...snapshot}` **整块替换**，
// 任何一个响应漏了这个键，客户端手上的 hostNodeId 就被抹掉一次。
//
// 所以这里做两件事：
//  1. 行为层：把能在 fixture 上真跑到的 action 全走一遍，逐个断言响应里带 hostNodeId；
//  2. 静态层：钉住「不许再出现旁路出口」—— 旧的无 host 签名一旦被新调用点用上，
//     这个测试就会红，强制新代码走 `(*discussionRuntime).snapshotView`。

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// assertSnapshotHostNodeID 断言一份快照响应里 hostNodeId 存在且是字符串、值符合预期。
func assertSnapshotHostNodeID(t *testing.T, label string, data interface{}, want string) {
	t.Helper()
	snap, ok := data.(map[string]interface{})
	if !ok {
		t.Fatalf("%s: data is %T, not a snapshot object", label, data)
	}
	raw, present := snap["hostNodeId"]
	if !present {
		t.Fatalf("%s: snapshot has no hostNodeId key (keys=%v)", label, sortedKeys(snap))
	}
	got, isString := raw.(string)
	if !isString {
		t.Fatalf("%s: hostNodeId = %#v, want string (never null)", label, raw)
	}
	if got != want {
		t.Fatalf("%s: hostNodeId = %q, want %q", label, got, want)
	}
}

func sortedKeys(m map[string]interface{}) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	return keys
}

// TestDiscussionActionSnapshotsAllCarryHostNodeID 把 fixture 上跑得到的每个快照
// 返回点都走一遍，逐个断言 hostNodeId。
//
// 覆盖：start / getActive(按 id) / getActive(按房间) / interject / interject 重放 /
// cancel 409 的 latestSnapshot / cancel 成功 / cancel 非活跃早退 / stop 非活跃早退。
// 跑不到的（continue / finish / retry / interactive* 那些）不是漏改，它们和上面
// 共用同一个 `rt.snapshotView` 出口，由下面的静态用例兜住。
func TestDiscussionActionSnapshotsAllCarryHostNodeID(t *testing.T) {
	f := setupDiscussionFixture(t)
	ctx := context.Background()
	actor, err := f.rt.resolveActor(ctx, f.ownerRCID)
	if err != nil {
		t.Fatalf("resolveActor: %v", err)
	}
	wantHost := f.memberNode.NodeID

	start := f.rt.actionStart(ctx, CommandContent{
		Service: "discussion", Action: "start", WebEnvelope: true,
		Params: discussionParams("chatroomId", f.roomRCID, "topic", "T", "goal", "G", "maxRounds", 3),
	}, actor)
	if start.code != 200 {
		t.Fatalf("start: %d %s", start.code, start.message)
	}
	assertSnapshotHostNodeID(t, "start", start.data, wantHost)
	discussionID, _ := start.data.(map[string]interface{})["discussionId"].(string)

	byRoom := f.rt.actionGetActive(ctx, CommandContent{
		Params: discussionParams("chatroomId", f.roomRCID),
	}, actor)
	if byRoom.code != 200 {
		t.Fatalf("getActive(room): %d %s", byRoom.code, byRoom.message)
	}
	assertSnapshotHostNodeID(t, "getActive(room)", byRoom.data, wantHost)

	byID := f.rt.actionGetActive(ctx, CommandContent{
		Params: discussionParams("chatroomId", f.roomRCID, "discussionId", discussionID),
	}, actor)
	if byID.code != 200 {
		t.Fatalf("getActive(id): %d %s", byID.code, byID.message)
	}
	assertSnapshotHostNodeID(t, "getActive(discussionId)", byID.data, wantHost)

	interject := f.rt.actionInterject(ctx, CommandContent{
		Params: discussionParams("discussionId", discussionID, "stateVersion", 1, "content", "hi", "messageUid", "muid-qa"),
	}, actor)
	if interject.code != 200 {
		t.Fatalf("interject: %d %s", interject.code, interject.message)
	}
	assertSnapshotHostNodeID(t, "interject", interject.data, wantHost)

	replay := f.rt.actionInterject(ctx, CommandContent{
		Params: discussionParams("discussionId", discussionID, "stateVersion", 1, "content", "hi", "messageUid", "muid-qa"),
	}, actor)
	if replay.code != 200 {
		t.Fatalf("interject replay: %d %s", replay.code, replay.message)
	}
	assertSnapshotHostNodeID(t, "interject(idempotent replay)", replay.data, wantHost)

	// 409 的 data 是 {latestSnapshot: {...}}，客户端会拿它重同步 —— 同样不能漏键。
	conflict := f.rt.actionCancel(ctx, CommandContent{
		Params: discussionParams("discussionId", discussionID, "stateVersion", 99, "reason", "x"),
	}, actor)
	if conflict.code != 409 {
		t.Fatalf("cancel(bad version): %d (want 409)", conflict.code)
	}
	conflictData, ok := conflict.data.(map[string]interface{})
	if !ok {
		t.Fatalf("409 data = %T", conflict.data)
	}
	latest, present := conflictData["latestSnapshot"]
	if !present {
		t.Fatalf("409 data has no latestSnapshot (keys=%v)", sortedKeys(conflictData))
	}
	assertSnapshotHostNodeID(t, "cancel 409 latestSnapshot", latest, wantHost)

	cancelled := f.rt.actionCancel(ctx, CommandContent{
		Params: discussionParams("discussionId", discussionID, "stateVersion", 1, "reason", "用户强制取消"),
	}, actor)
	if cancelled.code != 200 {
		t.Fatalf("cancel: %d %s", cancelled.code, cancelled.message)
	}
	assertSnapshotHostNodeID(t, "cancel", cancelled.data, wantHost)

	// 非活跃早退分支（cancel / stop 各一条）
	cancelAgain := f.rt.actionCancel(ctx, CommandContent{
		Params: discussionParams("discussionId", discussionID, "stateVersion", 2, "reason", "again"),
	}, actor)
	if cancelAgain.code != 200 {
		t.Fatalf("cancel(non-live): %d %s", cancelAgain.code, cancelAgain.message)
	}
	assertSnapshotHostNodeID(t, "cancel(non-live early return)", cancelAgain.data, wantHost)

	stopped := f.rt.actionStop(ctx, CommandContent{
		Params: discussionParams("discussionId", discussionID),
	}, actor)
	if stopped.code != 200 {
		t.Fatalf("stop(non-live): %d %s", stopped.code, stopped.message)
	}
	assertSnapshotHostNodeID(t, "stop(non-live early return)", stopped.data, wantHost)
}

// TestDiscussionSnapshotNoBypassOutlet 静态守住「统一出口」。
//
// 规则：
//   - 生产代码里不许再有 `discussionSnapshotView(` / `DiscussionSnapshotView(` 调用点
//     （这两个签名恒回空串 host，只保留给兼容/测试）；
//   - `discussionSnapshotViewWithHost(` 只允许出现在它自己的定义与两个包装里
//     （直接调它等于把 host 写死，必须走 rt.snapshotView）。
//
// 任何绕过都会让「某个 action 把客户端 host 抹掉一次」重新变成可能，所以这里
// 用文件扫描而不是靠人看。
func TestDiscussionSnapshotNoBypassOutlet(t *testing.T) {
	// 允许出现的位置：函数定义 + 两个包装（旧签名包装给空串、rt.snapshotView 给真值）。
	allowedWithHost := map[string]int{
		filepath.Join("discussion_runtime.go"): 4, // 175 定义包装、185 rt 出口、214 定义、1077 导出包装
	}
	// 旧签名（恒空串）只允许出现在定义与它自己的包装里。
	allowedLegacy := map[string]int{
		filepath.Join("discussion_runtime.go"): 2, // 174 定义、1070 导出包装
	}

	files, err := filepath.Glob("discussion_*.go")
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	if len(files) == 0 {
		t.Fatal("no discussion_*.go found (wrong working directory?)")
	}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		body, readErr := os.ReadFile(file)
		if readErr != nil {
			t.Fatalf("read %s: %v", file, readErr)
		}
		source := string(body)

		if got := strings.Count(source, "discussionSnapshotViewWithHost("); got > allowedWithHost[file] {
			t.Errorf("%s: %d call sites of discussionSnapshotViewWithHost (allowed %d) — "+
				"新增的快照出口必须走 (*discussionRuntime).snapshotView，否则 hostNodeId 会是空串",
				file, got, allowedWithHost[file])
		}
		// 旧签名：统计不含 rt 前缀的那一种。
		legacy := strings.Count(source, "= discussionSnapshotView(") +
			strings.Count(source, "return discussionSnapshotView(") +
			strings.Count(source, "okResult(discussionSnapshotView(")
		if legacy > allowedLegacy[file] {
			t.Errorf("%s: %d call sites of the host-less discussionSnapshotView (allowed %d) — "+
				"这条路径会把 hostNodeId 写成空串，客户端手上的 host 就被抹掉了", file, legacy, allowedLegacy[file])
		}
	}

	// handler 层：扁平 REST 必须用 WithHost 那一版。
	handlerBody, err := os.ReadFile(filepath.Join("..", "..", "handler", "claw_discussion_rest.go"))
	if err != nil {
		t.Fatalf("read handler: %v", err)
	}
	handlerSrc := string(handlerBody)
	if strings.Contains(handlerSrc, "rongcloud.DiscussionSnapshotView(") {
		t.Error("claw_discussion_rest.go 用了无 host 的 DiscussionSnapshotView —— REST 快照会丢掉 hostNodeId")
	}
	if got := strings.Count(handlerSrc, "rongcloud.DiscussionSnapshotViewWithHost("); got != 2 {
		t.Errorf("claw_discussion_rest.go: %d 个 WithHost 出口（期望 2：列表 + 单场）", got)
	}
}

// TestChatroomHostNodeIDDegradesToEmptyString 覆盖「查不到就降级空串」的三条失败面：
// 未装配 queries / 房间不存在 / DB 报错。任何一个都不许 panic，也不许让调用方失败。
func TestChatroomHostNodeIDDegradesToEmptyString(t *testing.T) {
	ctx := context.Background()

	// 1) 空运行时（未装配 DB）
	var nilRuntime *discussionRuntime
	if got := nilRuntime.chatroomHostNodeID(ctx, "rc-anything"); got != "" {
		t.Fatalf("nil runtime: %q (want empty)", got)
	}
	if got := newDiscussionRuntime(nil, nil, nil, "", testLogger()).chatroomHostNodeID(ctx, "rc-anything"); got != "" {
		t.Fatalf("nil queries: %q (want empty)", got)
	}
	// 2) 空房间 id 直接短路，不打 DB
	if got := newDiscussionRuntime(nil, nil, nil, "", testLogger()).chatroomHostNodeID(ctx, ""); got != "" {
		t.Fatalf("empty chatroom: %q (want empty)", got)
	}

	f := setupDiscussionFixture(t)

	// 3) 房间不存在（sql.ErrNoRows）
	if got := f.rt.chatroomHostNodeID(ctx, "rc_no_such_room_"+uniqueID("t")); got != "" {
		t.Fatalf("missing room: %q (want empty)", got)
	}
	// 4) 正常房间 → 主持的业务 node id
	if got := f.rt.chatroomHostNodeID(ctx, f.roomRCID); got != f.memberNode.NodeID {
		t.Fatalf("existing room: %q (want %s)", got, f.memberNode.NodeID)
	}

	// 5) DB 层真的报错（连接池已关）→ 仍然空串，不 panic
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://multica:multica@localhost:5432/multica?sslmode=disable"
	}
	brokenPool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("build pool: %v", err)
	}
	brokenPool.Close()
	broken := newDiscussionRuntime(db.New(brokenPool), nil, nil, "", testLogger())
	if got := broken.chatroomHostNodeID(ctx, f.roomRCID); got != "" {
		t.Fatalf("broken DB: %q (want empty, must not fail the action)", got)
	}

	// 5b) 失败分支里新增的 `rt.logger.Warn` 必须自带 nil 判定：
	// 直接用结构体字面量绕过构造函数（`newDiscussionRuntime` 会把 nil 换成
	// `slog.Default()`），模拟「装配漏了 logger」的老路径 —— 报错时不许 panic。
	loggerless := &discussionRuntime{queries: db.New(brokenPool)}
	if loggerless.logger != nil {
		t.Fatal("precondition: 这里的 logger 必须是 nil，否则这条用例什么都没测到")
	}
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("logger == nil 时 chatroomHostNodeID 在失败路径 panic 了：%v", r)
			}
		}()
		if got := loggerless.chatroomHostNodeID(ctx, f.roomRCID); got != "" {
			t.Fatalf("logger==nil + broken DB: %q (want empty)", got)
		}
	}()
	// 空 chatroomID 在 logger 为 nil 时也走不到 Warn，同样不许 panic
	if got := loggerless.chatroomHostNodeID(ctx, ""); got != "" {
		t.Fatalf("logger==nil + empty chatroom: %q (want empty)", got)
	}

	// 6) 导出入口（HTTP 层用）行为一致：空洞察不到 host 时是空串，不是 null。
	access := NewDiscussionRoomAccess(nil)
	if got := access.ChatroomHostNodeID(ctx, f.roomRCID); got != "" {
		t.Fatalf("nil access: %q (want empty)", got)
	}
}
