package rongcloud

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// 讨论组标题总结请求族（title_）的往返、校验与降级。
//
// 标题是建组的锦上添花：主持节点离线 / 超时 / 旧设备不认 action，都必须
// **静默失败**让调用方回落到议题截断名，绝不能阻塞建组。这里钉住：
//  1. 请求信封带 action=summarize_title、topic、timeout_seconds；
//  2. command_result 的 payload.title 能被 AcceptResponse 认领并结算；
//  3. 标题在服务端再清洗一次（去引号/标点/多行、按 rune 截 10 字）；
//  4. 无效标题（空/乱码）判 INVALID，不写入组名；
//  5. 超时结算走 title 族终态，不污染 roles 族。

func titleBroker(t *testing.T, send NodeRequestSender) *NodeRequestBroker {
	t.Helper()
	b := NewNodeRequestBroker(testLogger())
	b.BindSender(send)
	return b
}

const titleTestHost = "ai-host-title"

// titleAnsweringBroker 起一个把请求 request_id 记录下来的 broker 与 sender，
// 调用方在 StartTitle 之后用拿到的 requestID 让「设备」回包。
func titleAnsweringBroker(t *testing.T) (*NodeRequestBroker, *string) {
	t.Helper()
	var gotID string
	b := titleBroker(t, func(_ context.Context, _ string, content string) error {
		var frame struct {
			RequestID string `json:"request_id"`
		}
		_ = json.Unmarshal([]byte(content), &frame)
		gotID = frame.RequestID
		return nil
	})
	return b, &gotID
}

func titleOKResponse(requestID, title string) string {
	payload := map[string]interface{}{"kind": "text", "title": title}
	encoded, _ := json.Marshal(payload)
	return `{"request_id":"` + requestID + `","msg_type":"command_result","payload":` + string(encoded) + `}`
}

func TestTitleRequestEnvelope(t *testing.T) {
	var content string
	b := titleBroker(t, func(_ context.Context, _ string, c string) error {
		content = c
		return nil
	})
	if _, code := b.StartTitle(context.Background(), NodeRequestHost{
		AIUserID: titleTestHost, TimeoutSeconds: 60, Model: "provider/model",
	}, "如何用 AI 做动画", "头脑风暴"); code != "" {
		t.Fatalf("StartTitle = %q", code)
	}
	var frame struct {
		RequestID string `json:"request_id"`
		Service   string `json:"service"`
		Action    string `json:"action"`
		Params    struct {
			Topic          string `json:"topic"`
			TimeoutSeconds int    `json:"timeout_seconds"`
			Model          string `json:"model"`
		} `json:"params"`
	}
	if err := json.Unmarshal([]byte(content), &frame); err != nil {
		t.Fatalf("unmarshal request: %v", err)
	}
	if !strings.HasPrefix(frame.RequestID, titlePrefix) {
		t.Fatalf("request id = %q, want %q prefix", frame.RequestID, titlePrefix)
	}
	if frame.Service != titleService || frame.Action != titleAction {
		t.Fatalf("service/action = %q/%q", frame.Service, frame.Action)
	}
	if frame.Params.Topic != "如何用 AI 做动画" {
		t.Fatalf("topic = %q", frame.Params.Topic)
	}
	if frame.Params.TimeoutSeconds != titleWaitCapSeconds {
		t.Fatalf("timeout_seconds = %d, want %d", frame.Params.TimeoutSeconds, titleWaitCapSeconds)
	}
	if frame.Params.Model != "provider/model" {
		t.Fatalf("model = %q", frame.Params.Model)
	}
}

// 同步跑一次完整往返：Start → 设备回包 → Await。
func titleRoundTrip(t *testing.T, replyTitle string) (string, string) {
	t.Helper()
	b, gotID := titleAnsweringBroker(t)
	requestID, code := b.StartTitle(context.Background(), NodeRequestHost{
		AIUserID: titleTestHost, TimeoutSeconds: 5,
	}, "topic", "")
	if code != "" {
		t.Fatalf("StartTitle = %q", code)
	}
	if !b.AcceptResponse(titleTestHost, titleOKResponse(*gotID, replyTitle)) {
		t.Fatalf("AcceptResponse did not claim title answer for %s", requestID)
	}
	return b.AwaitTitle(context.Background(), requestID)
}

func TestTitleRoundTripAndSanitize(t *testing.T) {
	title, code := titleRoundTrip(t, "《AI 动画制作》。")
	if code != "" {
		t.Fatalf("code = %q", code)
	}
	if title != "AI 动画制作" {
		t.Fatalf("title = %q, want %q", title, "AI 动画制作")
	}
}

func TestTitleTruncatesToTenRunes(t *testing.T) {
	title, code := titleRoundTrip(t, "这是一个非常非常长的标题超过十个字了")
	if code != "" {
		t.Fatalf("code = %q", code)
	}
	if got := []rune(title); len(got) != titleMaxChars {
		t.Fatalf("title = %q (%d runes), want %d", title, len(got), titleMaxChars)
	}
}

func TestTitleInvalidPayload(t *testing.T) {
	_, code := titleRoundTrip(t, "   ")
	if code != titleErrorCodeInvalid {
		t.Fatalf("code = %q, want %q", code, titleErrorCodeInvalid)
	}
}

func TestTitleTimeoutSettlesInTitleFamily(t *testing.T) {
	b := titleBroker(t, silentSender)
	requestID, code := b.StartTitle(context.Background(), NodeRequestHost{
		AIUserID: titleTestHost, TimeoutSeconds: 5,
	}, "topic", "")
	if code != "" {
		t.Fatalf("StartTitle = %q", code)
	}
	b.expireNowForTest(requestID)
	_, code = b.AwaitTitle(context.Background(), requestID)
	if code != titleErrorCodeTimeout {
		t.Fatalf("code = %q, want %q", code, titleErrorCodeTimeout)
	}
	if b.pendingCount() != 0 {
		t.Fatalf("pending = %d, want 0", b.pendingCount())
	}
}

func TestNormalizeDiscussionTitle(t *testing.T) {
	cases := []struct{ in, want string }{
		{"AI 动画", "AI 动画"},
		{"《AI 动画》。", "AI 动画"},
		{"\"标题\"", "标题"},
		{"标题\n说明文字", "标题"},
		{"一二三四五六七八九十十一", "一二三四五六七八九十"},
		{"   ", ""},
	}
	for _, c := range cases {
		if got := normalizeDiscussionTitle(c.in); got != c.want {
			t.Errorf("normalizeDiscussionTitle(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
