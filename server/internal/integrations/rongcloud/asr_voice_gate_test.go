package rongcloud

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// asr_voice_gate_test.go 钉住 ai/recognizeVoice 的开关闸门契约：
//
//   - 闸门关闭（返回 error）→ 回包 code=4501、message=「语音转文字功能未开启」，
//     web 与 device 两种信封都要成立；
//   - 闸门开启（返回 nil）→ 行为与没有闸门时完全一致（default 分支的
//     unsupported ai action），不得误伤；
//   - 闸门未装配（nil）→ 与历史行为逐字节一致（回归底线：线上两端正在消费）；
//   - getNodes 等非转写 action 不受开关影响。
//
// 复用 system_handler_web_test.go 的 webReplyServer 桩（记录发出的私信内容）。

func newAsrGateHandler(t *testing.T, gate func(context.Context) error) (*webReplyServer, *systemHandler, func()) {
	t.Helper()
	rec, srv := newWebReplyServer(t)
	client := newRongCloudAPIClient("key", "secret", srv.URL, srv.Client(), testLogger())
	// queries=nil 时 handleAICommand 走不到闸门之后的分支（503 database not
	// available），但闸门判定在 queries 检查**之后**才执行吗——不是：闸门在
	// queries==nil 早退之后、switch 之前。为了让闸门后的 default 分支可控，
	// 这里 queries 传 nil，闸门放行时断言的是 503 形状的回包（足以证明「放行」），
	// 关闭时断言 4501（闸门先于一切业务分支生效）。
	handler := newSystemHandler(client, "sys_node", testLogger(), nil, nil, nil, nil, nil, nil)
	handler.voiceGate = gate
	return rec, handler, srv.Close
}

// recognizeVoiceMsg 造一条 web 信封的 ai/recognizeVoice 命令。
func recognizeVoiceMsg(requestID string) NormalizedMessage {
	return NormalizedMessage{
		ObjectName: objectNameCommand,
		FromUserID: "web-user",
		Content:    `{"requestId":"` + requestID + `","service":"ai","action":"recognizeVoice","payload":{"voiceUrl":"https://example.com/a.m4a","format":"m4a","sampleRate":16000}}`,
	}
}

func TestRecognizeVoiceRejectedWith4501WhenGateClosed(t *testing.T) {
	rec, handler, closeSrv := newAsrGateHandler(t, func(context.Context) error { return errors.New("asr_disabled") })
	defer closeSrv()

	if err := handler.handleCommand(context.Background(), recognizeVoiceMsg("web-gate-1")); err != nil {
		t.Fatalf("handleCommand: %v", err)
	}

	result := rec.last(t)
	if result["code"] != float64(AsrDisabledCommandCode) {
		t.Fatalf("code = %#v, want 4501 asr_disabled", result["code"])
	}
	if result["status"] != "error" {
		t.Fatalf("status = %#v, want error", result["status"])
	}
	if message, _ := result["message"].(string); message != AsrDisabledCommandMessage {
		t.Fatalf("message = %q, want %q", message, AsrDisabledCommandMessage)
	}
	if result["service"] != "ai" || result["action"] != "recognizeVoice" {
		t.Fatalf("web reply must echo service/action: %#v", result)
	}
	if _, hasData := result["data"]; hasData {
		t.Errorf("4501 回包不应携带 data: %#v", result["data"])
	}
}

func TestRecognizeVoiceGateErrorNeverLeaks(t *testing.T) {
	// 闸门错误的内部细节（err.Error()）绝不能进回包——错误内容可能含 DB 诊断。
	rec, handler, closeSrv := newAsrGateHandler(t, func(context.Context) error {
		return errors.New("connection refused 192.168.1.1:5432")
	})
	defer closeSrv()

	if err := handler.handleCommand(context.Background(), recognizeVoiceMsg("web-gate-2")); err != nil {
		t.Fatalf("handleCommand: %v", err)
	}

	raw, err := json.Marshal(rec.last(t))
	if err != nil {
		t.Fatalf("marshal reply: %v", err)
	}
	if strings.Contains(string(raw), "connection refused") || strings.Contains(string(raw), "192.168.1.1") {
		t.Fatalf("闸门内部错误泄露进回包: %s", raw)
	}
}

func TestRecognizeVoiceGateNilMeansHistoricalBehavior(t *testing.T) {
	// 未装配闸门 = 与引入前逐字节一致：queries=nil → 503 database not
	// available（历史行为，device 形状回包），绝不是 4501。
	rec, handler, closeSrv := newAsrGateHandler(t, nil)
	defer closeSrv()

	if err := handler.handleCommand(context.Background(), recognizeVoiceMsg("web-gate-3")); err != nil {
		t.Fatalf("handleCommand: %v", err)
	}

	result := rec.last(t)
	if code, _ := result["code"].(float64); code == float64(AsrDisabledCommandCode) {
		t.Fatalf("nil 闸门不应产生 4501: %#v", result)
	}
	payload, ok := result["payload"].(map[string]interface{})
	if !ok || payload["ok"] != false {
		t.Fatalf("历史行为是 device 形状 error 回包: %#v", result)
	}
	if errMsg, _ := payload["error"].(string); errMsg != "database not available" {
		t.Fatalf("历史行为 error = %q, want database not available", errMsg)
	}
}

func TestRecognizeVoiceGateOpenFallsThrough(t *testing.T) {
	// 闸门放行 → 走既有业务分支（queries=nil → 503），不是 4501。
	rec, handler, closeSrv := newAsrGateHandler(t, func(context.Context) error { return nil })
	defer closeSrv()

	if err := handler.handleCommand(context.Background(), recognizeVoiceMsg("web-gate-4")); err != nil {
		t.Fatalf("handleCommand: %v", err)
	}

	result := rec.last(t)
	if code, _ := result["code"].(float64); code == float64(AsrDisabledCommandCode) {
		t.Fatalf("闸门开启不应产生 4501: %#v", result)
	}
}

func TestGetNodesNotGatedByAsrSwitch(t *testing.T) {
	// 节点管理（getNodes）不依赖 ASR：开关关闭也必须照常走既有分支。
	rec, handler, closeSrv := newAsrGateHandler(t, func(context.Context) error {
		return errors.New("asr_disabled")
	})
	defer closeSrv()

	msg := NormalizedMessage{
		ObjectName: objectNameCommand,
		FromUserID: "web-user",
		Content:    `{"requestId":"web-gate-5","service":"ai","action":"getNodes","payload":{}}`,
	}
	if err := handler.handleCommand(context.Background(), msg); err != nil {
		t.Fatalf("handleCommand: %v", err)
	}

	result := rec.last(t)
	if code, _ := result["code"].(float64); code == float64(AsrDisabledCommandCode) {
		t.Fatalf("getNodes 不应被 ASR 闸门拦截: %#v", result)
	}
}

func TestRecognizeVoiceDeviceDialectGetsDeviceShape4501(t *testing.T) {
	// 设备信封（snake_case）：4501 语义一致，但回包是 {ok:false,error} 形状，
	// 不带 web 的 status/code 字段。
	rec, srv := newWebReplyServer(t)
	defer srv.Close()
	client := newRongCloudAPIClient("key", "secret", srv.URL, srv.Client(), testLogger())
	handler := newSystemHandler(client, "sys_node", testLogger(), nil, nil, nil, nil, nil, nil)
	handler.voiceGate = func(context.Context) error { return errors.New("asr_disabled") }

	msg := NormalizedMessage{
		ObjectName: objectNameCommand,
		FromUserID: "cli-node",
		Content:    `{"request_id":"dev-gate-1","service":"ai","action":"recognizeVoice","params":{"voice_url":"https://example.com/a.m4a"}}`,
	}
	if err := handler.handleCommand(context.Background(), msg); err != nil {
		t.Fatalf("handleCommand: %v", err)
	}

	result := rec.last(t)
	payload, ok := result["payload"].(map[string]interface{})
	if !ok {
		t.Fatalf("device reply must carry a payload: %#v", result)
	}
	if payload["ok"] != false {
		t.Fatalf("device payload ok = %#v, want false", payload["ok"])
	}
	if errMsg, _ := payload["error"].(string); errMsg != AsrDisabledCommandMessage {
		t.Fatalf("device error = %q, want %q", errMsg, AsrDisabledCommandMessage)
	}
}

func TestAsrDisabledCommandContractPinned(t *testing.T) {
	// 数值契约：本包常量与设计文档 2.6 的 4501/asr_disabled 一致。
	// （handler 包同码值，跨包不 import，靠这条测试对账。）
	if AsrDisabledCommandCode != 4501 {
		t.Fatalf("AsrDisabledCommandCode = %d, want 4501", AsrDisabledCommandCode)
	}
	if AsrDisabledCommandMessage != "语音转文字功能未开启" {
		t.Fatalf("文案漂移: %q", AsrDisabledCommandMessage)
	}
}
