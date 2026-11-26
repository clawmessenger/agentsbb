package rongcloud

// node_reassign_test.go 钉住「一个 agent 只有一个拥有者」的换绑语义：
// 新账号绑定一个已被旧账号认领的 agent 时，程序自动把 agent 从旧拥有者名下
// 迁到新账号 —— 撤销旧 owner → node 的好友边、清归属投影，再建新边、写新
// 投影；agent 的融云账号保留复用（不注销）。

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type friendAddCall struct {
	user   string
	target string
}

type friendDelCall struct {
	user    string
	targets []string
}

// privatePublishCall 记录一次私聊下发，断言「换绑后通知了原账号」用。
type privatePublishCall struct {
	from    string
	to      string
	content string
}

// rebindAPIServer 是覆盖 get/add/delete 三个好友端点的桩：真实维护 friends，
// 并记录 add/delete 调用，便于断言「撤销了谁的边、给谁建了边」。get 之外的调用
// 不计入任何计数，避免干扰复用 claimFriendServer 的既有测试。
type rebindAPIServer struct {
	mu      sync.Mutex
	friends map[string][]string
	adds    []friendAddCall
	dels    []friendDelCall
	pubs    []privatePublishCall
	delFail bool
}

func (f *rebindAPIServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/friend/get.json":
		f.mu.Lock()
		user := r.PostForm.Get("userId")
		list := make([]map[string]interface{}, 0, len(f.friends[user]))
		for _, id := range f.friends[user] {
			list = append(list, map[string]interface{}{"userId": id})
		}
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"code": 200, "friendList": list})
	case "/friend/add.json":
		f.mu.Lock()
		user, target := r.PostForm.Get("userId"), r.PostForm.Get("targetId")
		f.adds = append(f.adds, friendAddCall{user, target})
		exists := false
		for _, id := range f.friends[user] {
			if id == target {
				exists = true
			}
		}
		if !exists {
			f.friends[user] = append(f.friends[user], target)
		}
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"code": 200})
	case "/friend/delete.json":
		f.mu.Lock()
		user := r.PostForm.Get("userId")
		targets := strings.Split(r.PostForm.Get("targetIds"), ",")
		fail := f.delFail
		if !fail {
			f.dels = append(f.dels, friendDelCall{user, targets})
			for _, t := range targets {
				rest := f.friends[user][:0]
				for _, id := range f.friends[user] {
					if id != t {
						rest = append(rest, id)
					}
				}
				f.friends[user] = rest
			}
		}
		f.mu.Unlock()
		if fail {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"code": 500, "errorMessage": "delete unavailable"})
		} else {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"code": 200})
		}
	case "/message/private/publish.json":
		f.mu.Lock()
		var body textContent
		_ = json.Unmarshal([]byte(r.PostForm.Get("content")), &body)
		f.pubs = append(f.pubs, privatePublishCall{
			from:    r.PostForm.Get("fromUserId"),
			to:      r.PostForm.Get("toUserId"),
			content: body.Content,
		})
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"code": 200, "msgUID": "msg-1"})
	default:
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"code": 200})
	}
}

func (f *rebindAPIServer) calls() ([]friendAddCall, []friendDelCall) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]friendAddCall(nil), f.adds...), append([]friendDelCall(nil), f.dels...)
}

func (f *rebindAPIServer) publishes() []privatePublishCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]privatePublishCall(nil), f.pubs...)
}

func newRebindService(t *testing.T, api *rebindAPIServer, store *claimStoreDB) (*NodeService, func()) {
	t.Helper()
	srv := httptest.NewServer(api)
	client := newRongCloudAPIClient("key", "secret", srv.URL, srv.Client(), testLogger())
	svc := NewNodeService(nil, client, nil, testLogger())
	svc.SetClaimDB(store)
	return svc, srv.Close
}

func hasDel(dels []friendDelCall, user, target string) bool {
	for _, d := range dels {
		if d.user != user {
			continue
		}
		for _, t := range d.targets {
			if t == target {
				return true
			}
		}
	}
	return false
}

func hasAdd(adds []friendAddCall, user, target string) bool {
	for _, a := range adds {
		if a.user == user && a.target == target {
			return true
		}
	}
	return false
}

// 投影列命中旧 owner：撤销旧边 + 清投影，再建新边 + 写新投影。
func TestSetNodeOwnerReassignsFromProjection(t *testing.T) {
	old := "user-a"
	api := &rebindAPIServer{friends: map[string][]string{"user-a": {"rc_node_x"}}}
	store := &claimStoreDB{claims: map[string]*string{"rc_node_x": &old}, users: []string{"user-a"}}
	svc, close := newRebindService(t, api, store)
	defer close()

	svc.setNodeOwner(context.Background(), "rc_node_x", "user-b")

	adds, dels := api.calls()
	if !hasDel(dels, "user-a", "rc_node_x") {
		t.Errorf("expected old owner edge user-a -> rc_node_x to be revoked, dels = %+v", dels)
	}
	if !hasAdd(adds, "user-b", "rc_node_x") {
		t.Errorf("expected new owner edge user-b -> rc_node_x to be added, adds = %+v", adds)
	}
	if owner, _ := store.claim("rc_node_x"); owner != "user-b" {
		t.Errorf("claim = %q, want user-b", owner)
	}
}

// 投影列为空、好友边反查发现旧 owner（存量自愈路径）：同样要撤销旧边再换绑。
func TestSetNodeOwnerReassignsFromFriendEdgeFallback(t *testing.T) {
	api := &rebindAPIServer{friends: map[string][]string{"user-a": {"rc_node_x"}}}
	// 投影列为 NULL，lookup 会降级扫好友边并回填。
	store := &claimStoreDB{claims: map[string]*string{"rc_node_x": nil}, users: []string{"user-a"}}
	svc, close := newRebindService(t, api, store)
	defer close()

	svc.setNodeOwner(context.Background(), "rc_node_x", "user-b")

	adds, dels := api.calls()
	if !hasDel(dels, "user-a", "rc_node_x") {
		t.Errorf("friend-edge fallback must still revoke old owner edge, dels = %+v", dels)
	}
	if !hasAdd(adds, "user-b", "rc_node_x") {
		t.Errorf("expected new owner edge, adds = %+v", adds)
	}
	if owner, _ := store.claim("rc_node_x"); owner != "user-b" {
		t.Errorf("claim = %q, want user-b", owner)
	}
}

// 无旧 owner：不撤销任何边，照常建新边 + 写投影。
func TestSetNodeOwnerWithoutPriorOwner(t *testing.T) {
	api := &rebindAPIServer{friends: map[string][]string{}}
	// claimStoreDB 的 UPDATE 只更新已存在的行，预置一个 NULL 行模拟「节点存在但未认领」。
	store := &claimStoreDB{claims: map[string]*string{"rc_node_x": nil}, users: []string{"user-a"}}
	svc, close := newRebindService(t, api, store)
	defer close()

	svc.setNodeOwner(context.Background(), "rc_node_x", "user-b")

	_, dels := api.calls()
	if len(dels) != 0 {
		t.Errorf("no prior owner => no revoke, got dels = %+v", dels)
	}
	adds, _ := api.calls()
	if !hasAdd(adds, "user-b", "rc_node_x") {
		t.Errorf("expected new owner edge, adds = %+v", adds)
	}
	if owner, _ := store.claim("rc_node_x"); owner != "user-b" {
		t.Errorf("claim = %q, want user-b", owner)
	}
}

// 同一个 owner 重复绑定：不撤销自己的边，写回同一个 owner。
func TestSetNodeOwnerSameOwnerIsNoOpReassign(t *testing.T) {
	old := "user-a"
	api := &rebindAPIServer{friends: map[string][]string{"user-a": {"rc_node_x"}}}
	store := &claimStoreDB{claims: map[string]*string{"rc_node_x": &old}, users: []string{"user-a"}}
	svc, close := newRebindService(t, api, store)
	defer close()

	svc.setNodeOwner(context.Background(), "rc_node_x", "user-a")

	_, dels := api.calls()
	if len(dels) != 0 {
		t.Errorf("same owner must not revoke its own edge, got dels = %+v", dels)
	}
	if owner, _ := store.claim("rc_node_x"); owner != "user-a" {
		t.Errorf("claim = %q, want user-a unchanged", owner)
	}
}

// 撤销旧边失败：不阻断换绑 —— 新边照建、投影照写（best-effort 语义）。
func TestSetNodeOwnerRevokeFailureDoesNotBlock(t *testing.T) {
	old := "user-a"
	api := &rebindAPIServer{friends: map[string][]string{"user-a": {"rc_node_x"}}, delFail: true}
	store := &claimStoreDB{claims: map[string]*string{"rc_node_x": &old}, users: []string{"user-a"}}
	svc, close := newRebindService(t, api, store)
	defer close()

	svc.setNodeOwner(context.Background(), "rc_node_x", "user-b")

	adds, _ := api.calls()
	if !hasAdd(adds, "user-b", "rc_node_x") {
		t.Errorf("revoke failure must not block the bind, adds = %+v", adds)
	}
	if owner, _ := store.claim("rc_node_x"); owner != "user-b" {
		t.Errorf("claim = %q, want user-b even when revoke failed", owner)
	}
}

// reassignNodeOwnerOnBind 的返回值语义：只有真的换了 owner 才报迁移，并把被
// 迁走的原拥有者一并交回（换绑后通知要用）。
func TestReassignNodeOwnerOnBindReportsMigration(t *testing.T) {
	old := "user-a"
	api := &rebindAPIServer{friends: map[string][]string{"user-a": {"rc_node_x"}}}
	store := &claimStoreDB{claims: map[string]*string{"rc_node_x": &old}, users: []string{"user-a"}}
	svc, close := newRebindService(t, api, store)
	defer close()
	ctx := context.Background()

	// reassign 只清投影、写回由 setNodeOwner 的第 3 步完成，所以每次迁移前
	// 手动把投影写成「当前 owner」，模拟上一次完整换绑后的落库状态。
	setClaim := func(owner string) {
		v := owner
		store.mu.Lock()
		store.claims["rc_node_x"] = &v
		store.mu.Unlock()
	}

	prev, moved := svc.reassignNodeOwnerOnBind(ctx, "rc_node_x", "user-b")
	if !moved || prev != "user-a" {
		t.Errorf("expected (user-a, true) when moving from user-a to user-b, got (%q, %v)", prev, moved)
	}
	// 再换一次：投影已是 user-b，换到 user-c 仍应报告迁移。
	setClaim("user-b")
	if prev, moved := svc.reassignNodeOwnerOnBind(ctx, "rc_node_x", "user-c"); !moved || prev != "user-b" {
		t.Errorf("expected (user-b, true) when moving from user-b to user-c, got (%q, %v)", prev, moved)
	}
	// 同一个 owner：不迁移，也不报原拥有者。
	setClaim("user-c")
	if prev, moved := svc.reassignNodeOwnerOnBind(ctx, "rc_node_x", "user-c"); moved || prev != "" {
		t.Errorf("expected (\"\", false) for the same owner, got (%q, %v)", prev, moved)
	}
}

// 换绑后给原账号发一条私聊：告诉 A「opencode 已被 xxx 绑定」，而不是让它从
// A 的设备列表里无声消失。发件人是 agent 自己的融云账号（C 端按对端解析昵称，
// 用平台系统账号会落进一个没有标题的陌生人会话）。
func TestSetNodeOwnerNotifiesPreviousOwner(t *testing.T) {
	old := "user-a"
	api := &rebindAPIServer{friends: map[string][]string{"user-a": {"rc_node_x"}}}
	store := &claimStoreDB{claims: map[string]*string{"rc_node_x": &old}, users: []string{"user-a"}}
	svc, close := newRebindService(t, api, store)
	defer close()

	svc.setNodeOwner(context.Background(), "rc_node_x", "user-b")

	pubs := api.publishes()
	if len(pubs) != 1 {
		t.Fatalf("expected exactly one notice to the previous owner, got %+v", pubs)
	}
	p := pubs[0]
	if p.from != "rc_node_x" || p.to != "user-a" {
		t.Errorf("notice must come from the agent itself to the old owner, got from=%q to=%q", p.from, p.to)
	}
	// queries 为 nil 时展示名退回融云 id，正文仍要点到「原拥有者不再拥有」「新账号」。
	for _, want := range []string{"rc_node_x", "user-b", "不再拥有"} {
		if !strings.Contains(p.content, want) {
			t.Errorf("notice %q must mention %q", p.content, want)
		}
	}
}

// 同一个账号重复绑定 / 首次绑定（无旧 owner）：不发任何通知，别打扰用户。
func TestSetNodeOwnerDoesNotNotifyWithoutMigration(t *testing.T) {
	old := "user-a"
	api := &rebindAPIServer{friends: map[string][]string{"user-a": {"rc_node_x"}}}
	store := &claimStoreDB{claims: map[string]*string{"rc_node_x": &old}, users: []string{"user-a"}}
	svc, close := newRebindService(t, api, store)
	defer close()

	svc.setNodeOwner(context.Background(), "rc_node_x", "user-a")
	if pubs := api.publishes(); len(pubs) != 0 {
		t.Errorf("same owner must not be notified, got %+v", pubs)
	}

	// 无旧 owner 的首次绑定同样不发。
	api2 := &rebindAPIServer{friends: map[string][]string{}}
	store2 := &claimStoreDB{claims: map[string]*string{"rc_node_x": nil}, users: []string{"user-b"}}
	svc2, close2 := newRebindService(t, api2, store2)
	defer close2()
	svc2.setNodeOwner(context.Background(), "rc_node_x", "user-b")
	if pubs := api2.publishes(); len(pubs) != 0 {
		t.Errorf("first bind must not send a notice, got %+v", pubs)
	}
}
