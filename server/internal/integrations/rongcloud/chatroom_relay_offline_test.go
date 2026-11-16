package rongcloud

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// 本文件覆盖「离线闸门」：relay 在派发前确认成员此刻连着融云，离线的直接占位
// 跳过，不再干等一整轮超时（relayTurnTimeoutFloor = 10 分钟）。
//
// 历史背景：融云私聊对离线账号是「存离线」语义，sendPrivateJSON 对一台早已
// 掉线的设备同样返回成功。18 人群里 5 个幽灵节点，用户发一句话要等将近一小时
// 才轮到真正在线的设备开口，线上表现就是「发了没人接话」。

// presenceRelayRecorder 是会回答 /user/checkOnline.json 的假融云：按 userId
// 返回在线/离线，并记录探测、私聊派发与房间广播。
type presenceRelayRecorder struct {
	mu  sync.Mutex
	onl map[string]bool
	// statusless=true 时 checkOnline 的响应体不带 status 字段（模拟协议/网关
	// 异常）：此时「在线状态未知」，派发必须照旧进行。
	statusless bool
	probes     []string
	privates   []map[string]string
	group      []map[string]string
	chatroom   []map[string]string
	client     *rongcloudAPIClient
}

func newPresenceRelay(t *testing.T, online map[string]bool) (*presenceRelayRecorder, *rongcloudAPIClient) {
	t.Helper()
	rec := &presenceRelayRecorder{onl: online}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("ParseForm: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/user/checkOnline.json" {
			userID := r.PostForm.Get("userId")
			rec.mu.Lock()
			rec.probes = append(rec.probes, userID)
			statusless, isOnline := rec.statusless, rec.onl[userID]
			rec.mu.Unlock()
			switch {
			case statusless:
				fmt.Fprint(w, `{"code":200}`)
			case isOnline:
				fmt.Fprint(w, `{"code":200,"status":"1"}`)
			default:
				fmt.Fprint(w, `{"code":200,"status":"0"}`)
			}
			return
		}
		entry := make(map[string]string, len(r.PostForm))
		for k, v := range r.PostForm {
			entry[k] = strings.Join(v, ",")
		}
		rec.mu.Lock()
		switch r.URL.Path {
		case "/message/private/publish.json":
			rec.privates = append(rec.privates, entry)
		case "/message/group/publish.json":
			rec.group = append(rec.group, entry)
		case "/message/chatroom/publish.json":
			rec.chatroom = append(rec.chatroom, entry)
		}
		rec.mu.Unlock()
		fmt.Fprint(w, `{"code":200,"msgUID":"uid-1"}`)
	}))
	t.Cleanup(srv.Close)
	client := newRongCloudAPIClient("key", "secret", srv.URL, srv.Client(), testLogger())
	rec.client = client
	return rec, client
}

func (r *presenceRelayRecorder) snapshot() (probes []string, privates, chatroom []map[string]string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.probes...),
		append([]map[string]string(nil), r.privates...),
		append([]map[string]string(nil), r.chatroom...)
}

// newPresenceHub 建一个只接了假融云的 relay hub（库与讨论仓库都不需要）。
func newPresenceHub(client *rongcloudAPIClient) *chatroomRelayHub {
	return &chatroomRelayHub{
		sessions: map[string]*relaySession{},
		rounds:   map[string][]relayRound{},
		rt:       newDiscussionRuntime(nil, nil, client, "sys-node", testLogger()),
	}
}

// TestRelayHub_SkipsOfflineMemberImmediately 是本次修复的核心用例：首位成员
// 离线时必须**立刻**跳过（广播离线占位），而不是等满 10 分钟超时。
func TestRelayHub_SkipsOfflineMemberImmediately(t *testing.T) {
	rec, client := newPresenceRelay(t, map[string]bool{"rc_on": true, "rc_off": false})
	hub := newPresenceHub(client)
	members := []relayMember{
		{rcID: "rc_off", roleName: "幽灵", order: 0},
		{rcID: "rc_on", roleName: "在线", order: 1},
	}
	start := time.Now()
	if !hub.Start(context.Background(), "room-off", members, "大家好", "", "", 0) {
		t.Fatal("start should succeed")
	}
	// 离线的那位不该收到 your_turn：必须直接轮到在线的这位。
	var reqOn string
	waitUntil(t, "online member dispatched after offline skip", func() bool {
		s := relaySessionState(hub, "room-off")
		if s == nil || s.senderRCID != "rc_on" || s.requestID == "" {
			return false
		}
		reqOn = s.requestID
		return true
	})
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("offline member must be skipped immediately, took %v", elapsed)
	}
	probes, privates, chatroom := rec.snapshot()
	if len(probes) == 0 || probes[0] != "rc_off" {
		t.Fatalf("presence must be probed before dispatching the first member, got probes=%v", probes)
	}
	if len(privates) != 1 {
		t.Fatalf("only the online member may be dispatched, got %d private messages", len(privates))
	}
	if got := privates[0]["toUserId"]; got != "rc_on" {
		t.Fatalf("dispatch target = %q, want rc_on", got)
	}
	if texts := broadcastTexts(t, chatroom); !containsText(texts, "幽灵 当前不在线，已跳过") {
		t.Fatalf("offline placeholder missing, broadcasts=%v", texts)
	}
	if !hub.AcceptResponse(context.Background(), "rc_on", reqOn, "answer", false, "") {
		t.Fatal("online response should be accepted")
	}
	waitUntil(t, "session cleanup", func() bool { return relaySessionState(hub, "room-off") == nil })
}

// TestRelayHub_OfflineTargetedNote 覆盖定向（@）场景：被 @ 的人离线时，占位文案
// 必须说「不在线 + 未能回答 + 重试/换人」，而不是笼统的超时。
func TestRelayHub_OfflineTargetedNote(t *testing.T) {
	rec, client := newPresenceRelay(t, map[string]bool{"rc_ghost": false})
	hub := newPresenceHub(client)
	started, _ := hub.StartOrQueue(context.Background(), "room-at", []relayMember{
		{rcID: "rc_ghost", roleName: "幽灵", order: 0},
	}, "在吗", "", "rc_user", 1, true)
	if !started {
		t.Fatal("targeted relay should start")
	}
	waitUntil(t, "session cleanup", func() bool { return relaySessionState(hub, "room-at") == nil })
	_, privates, chatroom := rec.snapshot()
	if len(privates) != 0 {
		t.Fatalf("offline targeted member must not be dispatched, got %d", len(privates))
	}
	if texts := broadcastTexts(t, chatroom); !containsText(texts, "@ 的 幽灵 当前不在线，未能回答") {
		t.Fatalf("targeted offline note missing, broadcasts=%v", texts)
	}
}

// TestRelayHub_UnknownPresenceStillDispatches 是「不能因为问不出在线状态就让
// 整个群哑掉」的回归用例：响应缺 status 字段 → 未知 → 照旧派发。
func TestRelayHub_UnknownPresenceStillDispatches(t *testing.T) {
	rec, client := newPresenceRelay(t, nil)
	rec.mu.Lock()
	rec.statusless = true
	rec.mu.Unlock()
	hub := newPresenceHub(client)
	if !hub.Start(context.Background(), "room-unknown", []relayMember{
		{rcID: "rc_a", roleName: "A", order: 0},
		{rcID: "rc_b", roleName: "B", order: 1},
	}, "hi", "", "", 0) {
		t.Fatal("start should succeed")
	}
	var reqA string
	waitUntil(t, "first member dispatched despite unknown presence", func() bool {
		s := relaySessionState(hub, "room-unknown")
		if s == nil || s.senderRCID != "rc_a" || s.requestID == "" {
			return false
		}
		reqA = s.requestID
		return true
	})
	if !hub.AcceptResponse(context.Background(), "rc_a", reqA, "answer-a", false, "") {
		t.Fatal("response should be accepted")
	}
	waitUntil(t, "second member dispatched", func() bool {
		s := relaySessionState(hub, "room-unknown")
		return s != nil && s.senderRCID == "rc_b" && s.requestID != ""
	})
	_, privates, chatroom := rec.snapshot()
	if len(privates) != 2 {
		t.Fatalf("unknown presence must not skip anyone, got %d dispatches", len(privates))
	}
	if texts := broadcastTexts(t, chatroom); containsText(texts, "当前不在线") {
		t.Fatalf("unknown presence must not produce offline placeholders, broadcasts=%v", texts)
	}
}

// TestCheckOnlinePresence_Trinary 锁住三态口径：status=1 在线、status=0 离线、
// 缺字段未知。checkOnline 的旧语义（缺字段即离线）必须保持不变 —— 它服务于
// 「这条命令发不发得出去」的 fail-closed 判定。
func TestCheckOnlinePresence_Trinary(t *testing.T) {
	cases := []struct {
		name       string
		body       string
		wantOnline bool
		wantKnown  bool
	}{
		{name: "online", body: `{"code":200,"status":"1"}`, wantOnline: true, wantKnown: true},
		{name: "offline", body: `{"code":200,"status":"0"}`, wantOnline: false, wantKnown: true},
		{name: "no status field", body: `{"code":200}`, wantOnline: false, wantKnown: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := tc.body
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(body))
			}))
			defer srv.Close()
			client := newRongCloudAPIClient("key", "secret", srv.URL, srv.Client(), testLogger())
			online, known, err := client.checkOnlinePresence(context.Background(), "u1")
			if err != nil {
				t.Fatalf("checkOnlinePresence: %v", err)
			}
			if known != tc.wantKnown || online != tc.wantOnline {
				t.Fatalf("checkOnlinePresence = (%v,%v), want (%v,%v)",
					online, known, tc.wantOnline, tc.wantKnown)
			}
			legacy, err := client.checkOnline(context.Background(), "u1")
			if err != nil {
				t.Fatalf("checkOnline: %v", err)
			}
			if legacy != tc.wantOnline {
				t.Fatalf("checkOnline = %v, want %v (fail-closed keeps old semantics)",
					legacy, tc.wantOnline)
			}
		})
	}
}

// containsText 报告任一广播文本包含 substr。
func containsText(texts []string, substr string) bool {
	for _, text := range texts {
		if strings.Contains(text, substr) {
			return true
		}
	}
	return false
}
