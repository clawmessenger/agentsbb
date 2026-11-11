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
	b := newOpsChatTestBroker(t, func(_ context.Context, to, text string) (string, error) {
		if to != "rc-ops-1" || text != "查看本机状态" {
			t.Fatalf("send(%q, %q), want the ops peer and the operator text", to, text)
		}
		return "msguid-1", nil
	})
	id, code := b.Start(context.Background(), "node_1", "rc-ops-1", "查看本机状态")
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
	b := newOpsChatTestBroker(t, func(_ context.Context, _, _ string) (string, error) {
		return "msguid-2", nil
	})
	id, _ := b.Start(context.Background(), "node_2", "rc-ops-2", "重启 opencode")
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
	b := newOpsChatTestBroker(t, func(_ context.Context, _, _ string) (string, error) {
		return "msguid-mine", nil
	})
	id, _ := b.Start(context.Background(), "node_3", "rc-ops-3", "hi")
	other := `{"msg_type":"chat_stream","request_message_id":"msguid-from-another-chat","status":"completed","text":"别人的回答"}`
	if !b.Accept(NormalizedMessage{ObjectName: "chat_stream", FromUserID: "rc-ops-3", Content: other}) {
		t.Fatal("another turn's frame should still be swallowed while a request is in flight")
	}
	if got, _ := b.Get(id); got.Status != "pending" {
		t.Fatalf("another turn's frame settled our request: %+v", got)
	}
}

func TestOpsChatUnrelatedMessagesAreNotClaimed(t *testing.T) {
	b := newOpsChatTestBroker(t, func(_ context.Context, _, _ string) (string, error) {
		return "msguid-4", nil
	})
	msg := NormalizedMessage{ObjectName: objectNameText, FromUserID: "someone-else", Content: `{"content":"hello"}`}
	if b.Accept(msg) {
		t.Fatal("a message from an unrelated node must not be consumed")
	}
	// 同一节点、但没有在途请求时也不能吞：运维面板开着不代表这节点只准跟后台说话。
	if _, code := b.Start(context.Background(), "node_4", "rc-ops-4", "q"); code != "" {
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
	b := newOpsChatTestBroker(t, func(_ context.Context, _, _ string) (string, error) { return "uid", nil })
	if _, code := b.Start(context.Background(), "node_5", "rc-ops-5", "first"); code != "" {
		t.Fatalf("first Start failed: %s", code)
	}
	if _, code := b.Start(context.Background(), "node_5", "rc-ops-5", "second"); code != OpsChatCodeBusy {
		t.Fatalf("second Start code = %q, want %q: the fallback text has no id, so two in-flight requests cannot be told apart", code, OpsChatCodeBusy)
	}
}

func TestOpsChatSendFailureAndUnboundSender(t *testing.T) {
	b := newOpsChatTestBroker(t, func(_ context.Context, _, _ string) (string, error) {
		return "", errors.New("rongcloud 20604")
	})
	if _, code := b.Start(context.Background(), "node_6", "rc-ops-6", "q"); code != OpsChatCodeSendFailed {
		t.Fatalf("send failure code = %q, want %q", code, OpsChatCodeSendFailed)
	}
	unbound := newOpsChatTestBroker(t, nil)
	if _, code := unbound.Start(context.Background(), "node_7", "rc-ops-7", "q"); code != OpsChatCodeUnavailable {
		t.Fatalf("unbound sender code = %q, want %q", code, OpsChatCodeUnavailable)
	}
}

func TestOpsChatTimesOutWithoutAnyReply(t *testing.T) {
	now := time.Now()
	b := newOpsChatTestBroker(t, func(_ context.Context, _, _ string) (string, error) { return "uid", nil })
	b.now = func() time.Time { return now }
	id, _ := b.Start(context.Background(), "node_8", "rc-ops-8", "q")
	b.now = func() time.Time { return now.Add((OpsChatDefaultTimeoutSeconds + 1) * time.Second) }
	got, _ := b.Get(id)
	if got.Status != "timeout" || got.ErrorCode != OpsChatCodeTimeout {
		t.Fatalf("result = %+v, want timeout", got)
	}
}
