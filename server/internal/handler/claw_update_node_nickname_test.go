package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/rongcloud"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ClawUpdateNode（POST /api/claw/nodes/{nodeId}）的昵称校验。
//
// 这个端点是「设备改名」的唯一写入口：web 的 deviceService.updateNode 与移动端
// device-info-sheet.vue 都走它。加校验的**唯一安全边界**是「只校验显式传入的
// name」—— 空串 / 纯空白 / 未传仍然走「保持库里现值」的回退路径，因为旧包只说
// portraitUri 的换头像请求依赖它。那条回退路径一旦也被 400 挡住，就是线上事故，
// 所以本文件里有两条专门钉它的用例（EmptyNameKeepsCurrent / WhitespaceNameKeepsCurrent）。

// nicknameNodeOps 复用 claw_node_ownership_test.go 的 stubClawNodeOps（记录每一次
// 被碰到的方法，让「校验失败时一次都没写库」成为可断言的结论），只补两件事：
//  1. 库里的现值（GetUserByRongCloudID 要能返回非空 name/portrait，父类型只回零值）；
//  2. 记录 UpdateUserProfile 的完整入参（name 与 portrait 都要断言）。
type nicknameNodeOps struct {
	*stubClawNodeOps

	currentName     string
	currentPortrait string
	profileWrites   []nicknameProfileWrite
}

type nicknameProfileWrite struct {
	name     string
	portrait string
}

func (s *nicknameNodeOps) GetUserByRongCloudID(_ context.Context, rcUserID string) (db.RongcloudUser, error) {
	s.userLookups++
	return db.RongcloudUser{
		RongcloudUserID: rcUserID,
		Name:            pgtype.Text{String: s.currentName, Valid: s.currentName != ""},
		PortraitUri:     pgtype.Text{String: s.currentPortrait, Valid: s.currentPortrait != ""},
	}, nil
}

func (s *nicknameNodeOps) UpdateUserProfile(_ context.Context, _ pgtype.UUID, name, portrait string) error {
	s.profileWrites = append(s.profileWrites, nicknameProfileWrite{name: name, portrait: portrait})
	// 父类型的留痕也补一份，「UpdateUserProfile 零次调用」两种断言的写法都能用。
	s.profileUpdates = append(s.profileUpdates, name)
	return nil
}

// 编译期护栏：本文件的假实现必须仍然满足生产接口，否则 h.clawNodeOpsForTest
// 会在赋值处悄悄换成别的类型。
var _ clawNodeOps = (*nicknameNodeOps)(nil)
var _ clawNodeOps = (*stubClawNodeOps)(nil)

// ownedNicknameOps 造一个「user-a 拥有该节点、库里现值为 oldName」的假服务。
func ownedNicknameOps(oldName, oldPortrait string) *nicknameNodeOps {
	return &nicknameNodeOps{
		stubClawNodeOps: &stubClawNodeOps{
			node:    db.RongcloudNode{RongcloudUserID: "rc_node_a_agent"},
			ownedBy: map[string]bool{"user-a": true},
		},
		currentName:     oldName,
		currentPortrait: oldPortrait,
	}
}

// nicknameRequest 造一个带 chi 路由参数的改名请求。body 用 map 走 json.Marshal，
// 因为有用例要传 \u0000 这种手写 JSON 里很容易写错的字符。
func nicknameRequest(t *testing.T, body map[string]string, token string) (*http.Request, *httptest.ResponseRecorder) {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	const nodeID = "node_0123456789abcdef"
	req := httptest.NewRequest(http.MethodPost, "/api/claw/nodes/"+nodeID, strings.NewReader(string(payload)))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("nodeId", nodeID)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx)), httptest.NewRecorder()
}

// 超长昵称必须 400 且**不写库**：校验若放在 UpdateUserProfile 之后，就是「已写
// 进 rongcloud_user.name 并刷到融云才报错」，本地与融云状态分裂。
func TestUpdateNode_RejectsTooLongName(t *testing.T) {
	ops := ownedNicknameOps("旧名字", "https://cdn/old.png")
	h := newClawNodeHandler(ops.stubClawNodeOps)
	h.clawNodeOpsForTest = ops

	req, rr := nicknameRequest(t, map[string]string{"name": strings.Repeat("长", 33)}, "token-a")
	h.ClawUpdateNode(rr, req)

	if rr.Code != 400 {
		t.Fatalf("status = %d, want 400 (body=%s)", rr.Code, rr.Body.String())
	}
	if code, message := clawReplyCode(t, rr); code != 400 || message != "昵称最多 32 个字" {
		t.Fatalf("code/message = %d/%q, want 400/昵称最多 32 个字", code, message)
	}
	if len(ops.profileWrites) != 0 {
		t.Fatalf("a rejected name must not be written: %v", ops.profileWrites)
	}
}

// 上一条的镜像：32 个中文（96 字节）合法，且落库的是 trim 之后的值。
// 把上限写成 < 32、或者忘了 trim，都会在这里红。
func TestUpdateNode_Accepts32ChineseAndTrims(t *testing.T) {
	ops := ownedNicknameOps("旧名字", "https://cdn/old.png")
	h := newClawNodeHandler(ops.stubClawNodeOps)
	h.clawNodeOpsForTest = ops

	value := strings.Repeat("长", 32)
	req, rr := nicknameRequest(t, map[string]string{"name": "  " + value + "  "}, "token-a")
	h.ClawUpdateNode(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	if len(ops.profileWrites) != 1 {
		t.Fatalf("profile writes = %v, want exactly one", ops.profileWrites)
	}
	if got := ops.profileWrites[0].name; got != value {
		t.Fatalf("stored name = %q, want the trimmed 32-char value %q", got, value)
	}
	// 只改名不该把头像清空。
	if got := ops.profileWrites[0].portrait; got != "https://cdn/old.png" {
		t.Fatalf("portrait = %q, want the existing one", got)
	}
}

// 本轮最容易误伤旧包的回归点：旧包的「换头像」请求只带 portraitUri、name 为空。
// 它必须仍然 200，且落库的 name 是**库里的现值**（不是空串 —— 那会把设备名清掉）。
func TestUpdateNode_EmptyNameKeepsCurrent(t *testing.T) {
	ops := ownedNicknameOps("旧名字", "https://cdn/old.png")
	h := newClawNodeHandler(ops.stubClawNodeOps)
	h.clawNodeOpsForTest = ops

	req, rr := nicknameRequest(t, map[string]string{"portraitUri": "https://cdn/new.png"}, "token-a")
	h.ClawUpdateNode(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200 — 旧包的换头像请求不能被昵称校验挡住 (body=%s)", rr.Code, rr.Body.String())
	}
	if len(ops.profileWrites) != 1 {
		t.Fatalf("profile writes = %v, want exactly one", ops.profileWrites)
	}
	if got := ops.profileWrites[0].name; got != "旧名字" {
		t.Fatalf("stored name = %q, want the current name 旧名字", got)
	}
	if got := ops.profileWrites[0].portrait; got != "https://cdn/new.png" {
		t.Fatalf("stored portrait = %q, want the new one", got)
	}
}

// 纯空白等同于空：回退现值且不落空格。只判 req.Name == "" 会让 "   " 进库。
func TestUpdateNode_WhitespaceNameKeepsCurrent(t *testing.T) {
	ops := ownedNicknameOps("旧名字", "https://cdn/old.png")
	h := newClawNodeHandler(ops.stubClawNodeOps)
	h.clawNodeOpsForTest = ops

	req, rr := nicknameRequest(t, map[string]string{"name": "   "}, "token-a")
	h.ClawUpdateNode(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	if len(ops.profileWrites) != 1 || ops.profileWrites[0].name != "旧名字" {
		t.Fatalf("profile writes = %v, want the current name", ops.profileWrites)
	}
}

// 控制字符（U+0000）必须拒：Go 的 http 与融云接口在这个字符上都会出异常，
// 而本地已经写进 rongcloud_user.name 时，本地与融云的状态就分裂了。
func TestUpdateNode_NullByteNameRejected(t *testing.T) {
	ops := ownedNicknameOps("旧名字", "https://cdn/old.png")
	h := newClawNodeHandler(ops.stubClawNodeOps)
	h.clawNodeOpsForTest = ops

	req, rr := nicknameRequest(t, map[string]string{"name": "\u0000abc"}, "token-a")
	h.ClawUpdateNode(rr, req)

	if rr.Code != 400 {
		t.Fatalf("status = %d, want 400 (body=%s)", rr.Code, rr.Body.String())
	}
	if len(ops.profileWrites) != 0 {
		t.Fatalf("a rejected name must not be written: %v", ops.profileWrites)
	}
}

// 非自有节点仍然 404「节点不存在」，**与错误码无关地**先于任何校验：超长昵称也
// 不能让它变成 400，否则错误码差异就成了 node_id 存在性探针。
func TestUpdateNode_NonOwnerStillNotFound(t *testing.T) {
	ops := &nicknameNodeOps{
		stubClawNodeOps: victimNode(),
		currentName:     "别人的设备",
	}
	h := newClawNodeHandler(ops.stubClawNodeOps)
	h.clawNodeOpsForTest = ops

	req, rr := nicknameRequest(t, map[string]string{"name": strings.Repeat("长", 33)}, "token-a")
	h.ClawUpdateNode(rr, req)

	if rr.Code != 404 {
		t.Fatalf("status = %d, want 404 (body=%s)", rr.Code, rr.Body.String())
	}
	if code, message := clawReplyCode(t, rr); code != 404 || message != clawNodeOwnershipMessage {
		t.Fatalf("code/message = %d/%q, want 404/%s", code, message, clawNodeOwnershipMessage)
	}
	if len(ops.profileWrites) != 0 {
		t.Fatalf("a non-owner must not write: %v", ops.profileWrites)
	}
}

// ---- normalizeAgentNickname 单测 -------------------------------------------

func TestNormalizeAgentNickname_LimitsAndTrim(t *testing.T) {
	if name, ok := normalizeAgentNickname("  写作助手  "); !ok || name != "写作助手" {
		t.Fatalf("normalize = %q/%v, want 写作助手/true", name, ok)
	}
	// 32 个中文（96 字节）合法：用 len() 会在这里红。
	if _, ok := normalizeAgentNickname(strings.Repeat("写", 32)); !ok {
		t.Fatal("32 个中文应当合法")
	}
	if _, ok := normalizeAgentNickname(strings.Repeat("写", 33)); ok {
		t.Fatal("33 个中文应当被拒")
	}
	if _, ok := normalizeAgentNickname("   "); ok {
		t.Fatal("纯空白应当被拒")
	}
	if _, ok := normalizeAgentNickname("ab\u0000cd"); ok {
		t.Fatal("含控制字符的昵称应当被拒")
	}
}

// ZWJ 组合 emoji 必须合法：只拒控制字符（Cc）而不是所有非 IsPrint 字符，
// 否则 👨‍👩‍👧 这种正常昵称会被自己的校验挡住。
func TestNormalizeAgentNickname_KeepsZwjEmoji(t *testing.T) {
	const family = "👨\u200d👩\u200d👧"
	if name, ok := normalizeAgentNickname(family); !ok || name != family {
		t.Fatalf("normalize = %q/%v, want the emoji unchanged", name, ok)
	}
}

// 编译期护栏：生产路径的 *rongcloud.NodeService 必须仍然满足 clawNodeOps。
// （claw_node_ownership_test.go 已有同一条，这里再钉一次，因为本文件新增了
// 一个实现，改动接口时两处都要看。）
var _ clawNodeOps = (*rongcloud.NodeService)(nil)
