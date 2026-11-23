package rongcloud

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"
)

// 这组用例守住「不改 CLI」这条设计的前提：设备端只可能回三种东西 ——
// RC:TxtMsg 全文兜底、chat_stream 终帧、以及什么都没有（超时）。

func newOpsChatTestBroker(t *testing.T, send OpsChatSender) *OpsChatBroker {
	t.Helper()
	b := NewOpsChatBroker(slog.Default())
	if send != nil {
		b.BindSender(send)
	}
	return b
}

func TestOpsChatCompletesOnTextFallback(t *testing.T) {
	b := newOpsChatTestBroker(t, func(_ context.Context, to, text, _ string) (string, error) {
		if to != "rc-ops-1" || text != "查看本机状态" {
			t.Fatalf("send(%q, %q), want the ops peer and the operator text", to, text)
		}
		return "msguid-1", nil
	})
	id, code := b.Start(context.Background(), "node_1", "rc-ops-1", "codearts", "查看本机状态")
	if code != "" || id == "" {
		t.Fatalf("Start = (%q, %q), want a request", id, code)
	}
	if got, _ := b.Get(id); got.Status != "pending" {
		t.Fatalf("status right after send = %q, want pending", got.Status)
	}
	// runStreamedTurn 收尾的 deliverAgentReply：没有 requestMessageId，只能按节点认领。
	if !b.Accept(NormalizedMessage{
		ObjectName: objectNameText, FromUserID: "rc-ops-1",
		Content: `{"content":"CPU 正常，3 个 agent 在线"}`,
	}) {
		t.Fatal("text fallback was not claimed; it would leak into the general dispatcher")
	}
	got, _ := b.Get(id)
	if got.Status != "completed" || got.Reply != "CPU 正常，3 个 agent 在线" {
		t.Fatalf("result = %+v, want completed with the reply", got)
	}
	// 终帧先到、兜底文本后到：重复的那条必须被吞掉，不能又变成一条用户消息。
	if !b.Accept(NormalizedMessage{ObjectName: objectNameText, FromUserID: "rc-ops-1", Content: `{"content":"CPU 正常，3 个 agent 在线"}`}) {
		t.Fatal("duplicate fallback text was not swallowed")
	}
}

func TestOpsChatCompletesOnStreamTerminalFrame(t *testing.T) {
	b := newOpsChatTestBroker(t, func(_ context.Context, _, _, _ string) (string, error) {
		return "msguid-2", nil
	})
	id, _ := b.Start(context.Background(), "node_2", "rc-ops-2", "opencode", "重启 opencode")
	// 非终帧只认领、不结算。
	frame := `{"msg_type":"chat_stream","request_message_id":"msguid-2","status":"streaming","text":"正在"}`
	if !b.Accept(NormalizedMessage{ObjectName: "chat_stream", FromUserID: "rc-ops-2", Content: frame}) {
		t.Fatal("in-flight chat_stream frame was not claimed")
	}
	if got, _ := b.Get(id); got.Status != "pending" {
		t.Fatalf("streaming frame settled the request: %+v", got)
	}
	terminal := `{"msg_type":"chat_stream","request_message_id":"msguid-2","status":"completed","text":"已重启 opencode"}`
	if !b.Accept(NormalizedMessage{ObjectName: "chat_stream", FromUserID: "rc-ops-2", Content: terminal}) {
		t.Fatal("terminal frame was not claimed")
	}
	got, _ := b.Get(id)
	if got.Status != "completed" || got.Reply != "已重启 opencode" {
		t.Fatalf("result = %+v, want completed with terminal text", got)
	}
}

func TestOpsChatIgnoresFrameBelongingToAnotherTurn(t *testing.T) {
	b := newOpsChatTestBroker(t, func(_ context.Context, _, _, _ string) (string, error) {
		return "msguid-mine", nil
	})
	id, _ := b.Start(context.Background(), "node_3", "rc-ops-3", "codex", "hi")
	other := `{"msg_type":"chat_stream","request_message_id":"msguid-from-another-chat","status":"completed","text":"别人的回答"}`
	if !b.Accept(NormalizedMessage{ObjectName: "chat_stream", FromUserID: "rc-ops-3", Content: other}) {
		t.Fatal("another turn's frame should still be swallowed while a request is in flight")
	}
	if got, _ := b.Get(id); got.Status != "pending" {
		t.Fatalf("another turn's frame settled our request: %+v", got)
	}
}

func TestOpsChatUnrelatedMessagesAreNotClaimed(t *testing.T) {
	b := newOpsChatTestBroker(t, func(_ context.Context, _, _, _ string) (string, error) {
		return "msguid-4", nil
	})
	msg := NormalizedMessage{ObjectName: objectNameText, FromUserID: "someone-else", Content: `{"content":"hello"}`}
	if b.Accept(msg) {
		t.Fatal("a message from an unrelated node must not be consumed")
	}
	// 同一节点、但没有在途请求时也不能吞：运维面板开着不代表这节点只准跟后台说话。
	if _, code := b.Start(context.Background(), "node_4", "rc-ops-4", "", "q"); code != "" {
		t.Fatalf("Start failed: %s", code)
	}
	b.Accept(NormalizedMessage{ObjectName: objectNameText, FromUserID: "rc-ops-4", Content: `{"content":"done"}`})
	now := time.Now()
	b.now = func() time.Time { return now.Add(31 * time.Second) }
	if b.Accept(NormalizedMessage{ObjectName: objectNameText, FromUserID: "rc-ops-4", Content: `{"content":"a later normal message"}`}) {
		t.Fatal("messages outside the duplicate-claim window must fall through")
	}
}

func TestOpsChatSerializesRequestsPerPeer(t *testing.T) {
	b := newOpsChatTestBroker(t, func(_ context.Context, _, _, _ string) (string, error) { return "uid", nil })
	if _, code := b.Start(context.Background(), "node_5", "rc-ops-5", "claude", "first"); code != "" {
		t.Fatalf("first Start failed: %s", code)
	}
	if _, code := b.Start(context.Background(), "node_5", "rc-ops-5", "claude", "second"); code != OpsChatCodeBusy {
		t.Fatalf("second Start code = %q, want %q: the fallback text has no id, so two in-flight requests cannot be told apart", code, OpsChatCodeBusy)
	}
}

func TestOpsChatSendFailureAndUnboundSender(t *testing.T) {
	b := newOpsChatTestBroker(t, func(_ context.Context, _, _, _ string) (string, error) {
		return "", errors.New("rongcloud 20604")
	})
	if _, code := b.Start(context.Background(), "node_6", "rc-ops-6", "", "q"); code != OpsChatCodeSendFailed {
		t.Fatalf("send failure code = %q, want %q", code, OpsChatCodeSendFailed)
	}
	unbound := newOpsChatTestBroker(t, nil)
	if _, code := unbound.Start(context.Background(), "node_7", "rc-ops-7", "", "q"); code != OpsChatCodeUnavailable {
		t.Fatalf("unbound sender code = %q, want %q", code, OpsChatCodeUnavailable)
	}
}

func TestOpsChatTimesOutWithoutAnyReply(t *testing.T) {
	now := time.Now()
	b := newOpsChatTestBroker(t, func(_ context.Context, _, _, _ string) (string, error) { return "uid", nil })
	b.now = func() time.Time { return now }
	id, _ := b.Start(context.Background(), "node_8", "rc-ops-8", "", "q")
	b.now = func() time.Time { return now.Add((OpsChatDefaultTimeoutSeconds + 1) * time.Second) }
	got, _ := b.Get(id)
	if got.Status != "timeout" || got.ErrorCode != OpsChatCodeTimeout {
		t.Fatalf("result = %+v, want timeout", got)
	}
}

// 2026-11-18 现场：同机所有 agent 的运维抽屉共享一条会话 —— 管理端发的是
// 裸 `{content}`，设备端既不知道这轮替谁运维，也没有分桶依据。管理端现在
// 把节点自己的 agent 键塞进 `{content, opsAgent}` 信封，broker 必须原样带到
// sender（设备端靠它分桶会话键 + 注入【运维对象】抬头）。
func TestOpsChatCarriesEntryAgentToSender(t *testing.T) {
	var gotTo, gotText, gotAgent string
	b := newOpsChatTestBroker(t, func(_ context.Context, to, text, opsAgent string) (string, error) {
		gotTo, gotText, gotAgent = to, text, opsAgent
		return "msguid-ops-agent", nil
	})
	id, code := b.Start(context.Background(), "node_9", "rc-ops-9", "codearts", "诊断一下")
	if code != "" || id == "" {
		t.Fatalf("Start = (%q, %q), want a request", id, code)
	}
	if gotTo != "rc-ops-9" || gotText != "诊断一下" || gotAgent != "codearts" {
		t.Fatalf("send(%q, %q, %q), want peer + text + entry agent", gotTo, gotText, gotAgent)
	}
	if got, _ := b.Get(id); got.OpsAgent != "codearts" {
		t.Fatalf("snapshot ops_agent = %q, want codearts", got.OpsAgent)
	}
	// 空 opsAgent（老管理端 / 未指定）也必须照发，只是不带提示。
	b2 := newOpsChatTestBroker(t, func(_ context.Context, _, _, opsAgent string) (string, error) {
		gotAgent = opsAgent
		return "msguid-ops-agent-2", nil
	})
	if _, code := b2.Start(context.Background(), "node_10", "rc-ops-10", "", "q"); code != "" {
		t.Fatalf("empty opsAgent Start failed: %s", code)
	}
	if gotAgent != "" {
		t.Fatalf("empty opsAgent leaked as %q", gotAgent)
	}
}

// 信封编码：设备端 CLI 的私聊入口按 `{content, opsAgent}` 解析（JSON 字段
// camelCase），老 CLI 读不到 opsAgent 只是不分桶，不会报错。
func TestEncodeOpsTextContent(t *testing.T) {
	if got := encodeOpsTextContent("hi", "codearts"); got != `{"content":"hi","opsAgent":"codearts"}` {
		t.Fatalf("encodeOpsTextContent = %s", got)
	}
	if got := encodeOpsTextContent("hi", ""); got != `{"content":"hi"}` {
		t.Fatalf("empty opsAgent must omit the field: %s", got)
	}
}

// 历史落库挂在结算上，且同一轮只写一次：迟到的重复回包/反复轮询都不能
// 再写第二行（表上还有 request_id 唯一索引兜底）。
func TestOpsChatRecorderWritesSettlementExactlyOnce(t *testing.T) {
	b := newOpsChatTestBroker(t, func(_ context.Context, _, _, _ string) (string, error) {
		return "msguid-history", nil
	})
	var recorded []OpsChatRecorded
	b.BindRecorder(func(_ context.Context, rec OpsChatRecorded) error {
		recorded = append(recorded, rec)
		return nil
	})
	id, code := b.Start(context.Background(), "node_history", "rc-ops-history", "codearts", "请只报告当前 agent 的版本")
	if code != "" || id == "" {
		t.Fatalf("Start = (%q, %q), want a request", id, code)
	}
	if !b.Accept(NormalizedMessage{ObjectName: objectNameText, FromUserID: "rc-ops-history",
		Content: `{"content":"agentsbb 1.3.61"}`}) {
		t.Fatal("reply not claimed")
	}
	if len(recorded) != 1 {
		t.Fatalf("recorded %d times, want 1", len(recorded))
	}
	rec := recorded[0]
	if rec.RequestID != id || rec.NodeID != "node_history" || rec.OpsPeerID != "rc-ops-history" ||
		rec.OpsAgent != "codearts" || rec.Question != "请只报告当前 agent 的版本" ||
		rec.Reply != "agentsbb 1.3.61" || rec.Status != "completed" {
		t.Fatalf("recorded payload = %+v", rec)
	}
	if rec.CreatedAt.IsZero() || rec.SettledAt.Before(rec.CreatedAt) {
		t.Fatalf("bad timestamps: created=%v settled=%v", rec.CreatedAt, rec.SettledAt)
	}
	// 重复文本 + 多次轮询都不再触发落库。
	b.Accept(NormalizedMessage{ObjectName: objectNameText, FromUserID: "rc-ops-history",
		Content: `{"content":"agentsbb 1.3.61"}`})
	b.Get(id)
	b.Get(id)
	if len(recorded) != 1 {
		t.Fatalf("recorded %d times after duplicates, want 1", len(recorded))
	}
}

func TestOpsChatRecorderWritesTimeout(t *testing.T) {
	now := time.Now()
	b := newOpsChatTestBroker(t, func(_ context.Context, _, _, _ string) (string, error) { return "uid", nil })
	b.now = func() time.Time { return now }
	var recorded []OpsChatRecorded
	b.BindRecorder(func(_ context.Context, rec OpsChatRecorded) error {
		recorded = append(recorded, rec)
		return nil
	})
	id, _ := b.Start(context.Background(), "node_timeout", "rc-ops-timeout", "", "在吗")
	b.now = func() time.Time { return now.Add((OpsChatDefaultTimeoutSeconds + 1) * time.Second) }
	b.Get(id)
	if len(recorded) != 1 || recorded[0].Status != "timeout" || recorded[0].ErrorCode != OpsChatCodeTimeout ||
		recorded[0].Question != "在吗" {
		t.Fatalf("timeout record = %+v", recorded)
	}
}
