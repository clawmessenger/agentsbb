package rongcloud

// 管理端「运维对话」的服务端代理。
//
// 为什么需要它：管理端浏览器没有融云 IM SDK（只有 @rongcloud/embed-console-sdk），
// 做不到 C 端那样直连设备开一条私聊；但设备端 CLI 早就实现了「收到 RC:TxtMsg
// 私聊 → 跑一次 agent → 回一条 RC:TxtMsg 全文 + 一串 chat_stream 帧」这条链路
// （packages/agentsbb-cli/src/im.ts 的 handle / runStreamedTurn / deliverAgentReply）。
// 所以这里只做代理，不改任何 CLI：
//
//	管理端 POST → 服务端以系统账号发 RC:TxtMsg 给运维对端 → 设备回包到系统账号
//	→ 融云 webhook 收到 → Accept() 认领 → 管理端轮询 Get() 拿结果
//
// 关联用两条互为退路的线索：
//   - 精确：sendPrivateMessage 返回的 msgUID 会变成设备侧 messageUId，设备把它
//     当 requestMessageId 写进 chat_stream 帧（chat-stream.ts 的
//     request_message_id 字段），因此终帧能一一对应；
//   - 兜底：chat_stream 自定义消息未必都进回调，但 runStreamedTurn 收尾**必定**
//     再发一条 RC:TxtMsg 全文（deliverAgentReply）。这条没有 id，只能按
//     fromUserId + 「该节点当前唯一一个 pending 请求」认领；所以同一对端同一时刻
//     只允许一个在途请求（busy 时直接 409，不做隐式排队）。
//
// 进程内状态就够了：admin API 与融云 webhook 在同一个 Go 进程里（与
// NodeRequestBroker 同构），不需要落库；掉进程时最坏是一次超时，不是数据丢失。

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// 对外可见的具名错误码。管理端只按这些码给文案，不回传设备细节。
const (
	OpsChatCodeUnavailable = "OPS_CHAT_UNAVAILABLE"
	OpsChatCodeBusy        = "OPS_CHAT_BUSY"
	OpsChatCodeSendFailed  = "OPS_CHAT_SEND_FAILED"
	OpsChatCodeTimeout     = "OPS_CHAT_TIMEOUT"
	OpsChatCodeFailed      = "OPS_CHAT_FAILED"

	// 运维一轮要跑完一次完整 agent 回合（还可能带工具调用），旗舰模型几十秒很常见。
	// C 端的轮次超时也是这个量级，压到 20s 会把正常回答判成超时。
	OpsChatDefaultTimeoutSeconds = 120

	// 结果保留时间：轮询方最多等 timeout+5s，留足余量让它拿到终态。
	opsChatResultRetention = 5 * time.Minute
	// 终帧先到、兜底整包文本后到：这段窗口内同节点的文本回包一律认领并丢弃。
	// 不丢的话它会掉进通用消息分发器，被当成一条新的用户消息（可能触发回声）。
	opsChatTextClaimWindow = 30 * time.Second
)

// OpsChatSender 把一条 RC:TxtMsg 私聊放到线上，返回融云的 msgUID。
// 由 channel 层在凭据解析完成后绑定；未绑定时一切请求快速失败。
type OpsChatSender func(ctx context.Context, toUserID, text string) (msgUID string, err error)

// OpsChatSnapshot 是轮询接口返回的那一份状态，字段与管理端契约一一对应。
type OpsChatSnapshot struct {
	RequestID string `json:"request_id"`
	NodeID    string `json:"node_id"`
	OpsPeerID string `json:"ops_peer_id"`
	Status    string `json:"status"`
	Reply     string `json:"reply"`
	ElapsedMs int64  `json:"elapsed_ms"`
	ErrorCode string `json:"error_code"`
}

type opsChatRecord struct {
	requestID string
	nodeID    string
	opsPeerID string
	msgUID    string
	text      string
	createdAt time.Time
	expiresAt time.Time
	settledAt time.Time
	status    string
	reply     string
	errorCode string
}

type OpsChatBroker struct {
	logger *slog.Logger
	now    func() time.Time

	mu       sync.Mutex
	send     OpsChatSender
	records  map[string]*opsChatRecord
	byTarget map[string]string // 对端融云 id -> requestID；结算后仍保留到 retention
}

func NewOpsChatBroker(logger *slog.Logger) *OpsChatBroker {
	if logger == nil {
		logger = slog.Default()
	}
	return &OpsChatBroker{
		logger:   logger,
		now:      time.Now,
		records:  make(map[string]*opsChatRecord),
		byTarget: make(map[string]string),
	}
}

func (b *OpsChatBroker) BindSender(send OpsChatSender) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.send = send
}

// Start 投递一条运维消息并登记在途请求。返回的 code 非空表示没发出去。
//
// 预留记录必须发生在 send 之前：设备回包可能比 HTTP 返回还快，先发后登记会让
// 第一条 chat_stream 帧在 webhook 侧找不到 pending 而被放走。
func (b *OpsChatBroker) Start(
	ctx context.Context, nodeID, opsPeerID, text string,
) (requestID string, code string) {
	if opsPeerID == "" || strings.TrimSpace(text) == "" {
		return "", OpsChatCodeUnavailable
	}

	requestID = "opschat_" + uuid.NewString()
	now := b.now()
	rec := &opsChatRecord{
		requestID: requestID,
		nodeID:    nodeID,
		opsPeerID: opsPeerID,
		text:      text,
		createdAt: now,
		expiresAt: now.Add(OpsChatDefaultTimeoutSeconds * time.Second),
		status:    "pending",
	}

	b.mu.Lock()
	b.sweepLocked(now)
	if existingID := b.byTarget[opsPeerID]; existingID != "" {
		if existing := b.records[existingID]; existing != nil && existing.status == "pending" && now.Before(existing.expiresAt) {
			b.mu.Unlock()
			return "", OpsChatCodeBusy
		}
	}
	send := b.send
	b.records[requestID] = rec
	b.byTarget[opsPeerID] = requestID
	b.mu.Unlock()

	if send == nil {
		b.settle(requestID, "failed", "", OpsChatCodeUnavailable)
		return "", OpsChatCodeUnavailable
	}
	msgUID, err := send(ctx, opsPeerID, text)
	if err != nil {
		b.logger.Warn("ops chat: send failed", "request_id", requestID, "peer", opsPeerID, "error", err)
		b.settle(requestID, "failed", "", OpsChatCodeSendFailed)
		return "", OpsChatCodeSendFailed
	}
	b.mu.Lock()
	if b.records[requestID] != nil {
		b.records[requestID].msgUID = msgUID
	}
	b.mu.Unlock()
	b.logger.Info("ops chat: request sent", "request_id", requestID, "node_id", nodeID, "peer", opsPeerID)
	return requestID, ""
}

// Get 取一次状态；顺带把过期的 pending 判成 timeout。
func (b *OpsChatBroker) Get(requestID string) (OpsChatSnapshot, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	b.sweepLocked(now)
	rec := b.records[requestID]
	if rec == nil {
		return OpsChatSnapshot{}, false
	}
	if rec.status == "pending" && !now.Before(rec.expiresAt) {
		rec.status = "timeout"
		rec.errorCode = OpsChatCodeTimeout
		rec.settledAt = now
	}
	end := now
	if !rec.settledAt.IsZero() {
		end = rec.settledAt
	}
	return OpsChatSnapshot{
		RequestID: rec.requestID,
		NodeID:    rec.nodeID,
		OpsPeerID: rec.opsPeerID,
		Status:    rec.status,
		Reply:     rec.reply,
		ElapsedMs: end.Sub(rec.createdAt).Milliseconds(),
		ErrorCode: rec.errorCode,
	}, true
}

// Accept 让 webhook 把一条入站消息交给运维通道认领。
//
// 返回 true 表示「这条已经被运维通道消费，不要再进通用分发」——尤其是那条兜底
// RC:TxtMsg：放走会被系统账号当成一条新的用户消息处理。没有对应请求时一律
// 返回 false，绝不改变既有消息链路的行为。
func (b *OpsChatBroker) Accept(msg NormalizedMessage) bool {
	if msg.FromUserID == "" {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	b.sweepLocked(now)

	requestID := b.byTarget[msg.FromUserID]
	if requestID == "" {
		return false
	}
	rec := b.records[requestID]
	if rec == nil {
		delete(b.byTarget, msg.FromUserID)
		return false
	}

	// 已结算：只吞掉「紧接着到的重复回包」，窗口外一律放行，别把这台节点
	// 之后正常的文本消息全吃掉。
	if rec.status != "pending" {
		if msg.ObjectName == objectNameText && now.Sub(rec.settledAt) <= opsChatTextClaimWindow {
			return true
		}
		return false
	}

	switch msg.ObjectName {
	case objectNameText:
		text := opsChatTextContent(msg.Content)
		if text == "" {
			return false
		}
		// 私聊闸门拒绝时设备会回一条占位说明（sendGateRejectNotice）。它也是
		// 文本、也应该给管理员看到——那是「这台节点为什么不干活」的唯一线索。
		b.settleLocked(rec, "completed", text, "")
		return true

	case "chat_stream", "chat_stream_chunk":
		// 分块帧内容不完整，整帧未重组前不解析；但在途期间一律吞掉，别让
		// 自定义消息落进通用分发器。
		if msg.ObjectName == "chat_stream_chunk" {
			return true
		}
		var frame struct {
			RequestMessageID string `json:"request_message_id"`
			Status           string `json:"status"`
			Text             string `json:"text"`
			ErrorCode        string `json:"error_code"`
		}
		if err := json.Unmarshal([]byte(msg.Content), &frame); err != nil {
			return true
		}
		// 精确关联：msgUID 已记下且帧里带了别的 requestMessageId → 是另一轮，不认。
		if rec.msgUID != "" && frame.RequestMessageID != "" && frame.RequestMessageID != rec.msgUID {
			return true
		}
		switch frame.Status {
		case "completed":
			b.settleLocked(rec, "completed", frame.Text, "")
		case "failed", "cancelled":
			code := OpsChatCodeFailed
			if frame.ErrorCode != "" {
				code = frame.ErrorCode
			}
			b.settleLocked(rec, "failed", frame.Text, code)
		default:
			// processing / streaming：全量快照，暂不结算（首版不做流式展示）。
		}
		return true
	default:
		return false
	}
}

func (b *OpsChatBroker) settle(requestID, status, reply, code string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if rec := b.records[requestID]; rec != nil {
		b.settleLocked(rec, status, reply, code)
	}
}

func (b *OpsChatBroker) settleLocked(rec *opsChatRecord, status, reply, code string) {
	if rec.status != "pending" {
		return
	}
	rec.status = status
	rec.reply = reply
	rec.errorCode = code
	rec.settledAt = b.now()
}

func (b *OpsChatBroker) sweepLocked(now time.Time) {
	for id, rec := range b.records {
		if rec.status == "pending" {
			if !now.Before(rec.expiresAt) {
				rec.status = "timeout"
				rec.errorCode = OpsChatCodeTimeout
				rec.settledAt = now
			}
			continue
		}
		if now.Sub(rec.settledAt) > opsChatResultRetention {
			delete(b.records, id)
			if b.byTarget[rec.opsPeerID] == id {
				delete(b.byTarget, rec.opsPeerID)
			}
		}
	}
}

// opsChatTextContent 拆 RC:TxtMsg 的 {"content": "..."} 信封；不是 JSON 时按原文
// 处理（融云回调偶尔直接给裸文本）。
func opsChatTextContent(raw string) string {
	var envelope struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal([]byte(raw), &envelope); err == nil && envelope.Content != "" {
		return envelope.Content
	}
	return strings.TrimSpace(raw)
}
