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
	OpsChatCodeCancelled   = "OPS_CHAT_CANCELLED"

	// 不再有固定墙钟：设备端已取消执行层的 300s/600s 限时，改由「无进展」守卫
	// 收尾（见 CLI 1.3.60）。后台这道投递/轮询超时若仍留 120s，反而成了最短的
	// 一道墙——设备还在正常跑，页面就先报「未在规定时间内回复」。
	// OpsChatNoTimeoutSeconds=0 通过 context 下发给前端，表示「不要倒计时」。
	OpsChatNoTimeoutSeconds = 0

	// 仅作内存兜底：pending 记录挂满 24h 才强制收尾，避免进程内 map 无限堆积。
	// 正常用户永远等不到它；真不回包时用管理端「放弃等待」主动结束。
	opsChatPendingHardLimit = 24 * time.Hour

	// 结果保留时间：终态后再留 5 分钟，供轮询方拿到最后一次状态。
	opsChatResultRetention = 5 * time.Minute
	// 终帧先到、兜底整包文本后到：这段窗口内同节点的文本回包一律认领并丢弃。
	// 不丢的话它会掉进通用消息分发器，被当成一条新的用户消息（可能触发回声）。
	opsChatTextClaimWindow = 30 * time.Second
)

// OpsChatSender 把一条 RC:TxtMsg 私聊放到线上，返回融云的 msgUID。
// opsAgent 是入口提示（用户从哪个智能体的运维面板进来），发送时以
// `{content, opsAgent}` 信封带给设备端 —— 设备端用它做运维会话按 agent 分桶。
// 由 channel 层在凭据解析完成后绑定；未绑定时一切请求快速失败。
type OpsChatSender func(ctx context.Context, toUserID, text, opsAgent string) (msgUID string, err error)

// OpsChatSnapshot 是轮询接口返回的那一份状态，字段与管理端契约一一对应。
type OpsChatSnapshot struct {
	RequestID string `json:"request_id"`
	NodeID    string `json:"node_id"`
	OpsPeerID string `json:"ops_peer_id"`
	// 入口 agent（运维面板所属的智能体键）；空 = 未指定（老管理端）。
	OpsAgent  string `json:"ops_agent,omitempty"`
	Status    string `json:"status"`
	Reply     string `json:"reply"`
	ElapsedMs int64  `json:"elapsed_ms"`
	ErrorCode string `json:"error_code"`
}

// OpsChatRecorded 是结算瞬间交给落库层的一份不可变快照。
// 进程内记录 5 分钟后会被 sweep 掉，历史表靠它在 webhook 回包时就写定，
// 不依赖管理端页面是否还在轮询。question 只在落库用，不进轮询 API 的 snapshot。
type OpsChatRecorded struct {
	RequestID string
	NodeID    string
	OpsPeerID string
	OpsAgent  string
	Question  string
	Reply     string
	Status    string
	ErrorCode string
	ElapsedMs int64
	CreatedAt time.Time
	SettledAt time.Time
}

// OpsChatRecorder 由启动侧绑定（一般是 admin handler 的 DB 写入）。
// nil 表示不落库——老测试/本地跑不接数据库时保持原行为。
type OpsChatRecorder func(ctx context.Context, rec OpsChatRecorded) error

type opsChatRecord struct {
	requestID string
	nodeID    string
	opsPeerID string
	opsAgent  string
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
	recorder OpsChatRecorder
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

func (b *OpsChatBroker) BindRecorder(recorder OpsChatRecorder) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.recorder = recorder
}

// record 在锁外做 I/O，绝不把 DB 写放进 b.mu 里——webhook 线程会阻塞后续
// Accept/Get，而设备回包常常是连着来的。写失败只记日志：历史丢一条不该改变
// 本轮问答的结果，更不能让设备端重试。
func (b *OpsChatBroker) recordAll(recs []*OpsChatRecorded) {
	for _, rec := range recs {
		b.record(rec)
	}
}

func (b *OpsChatBroker) record(rec *OpsChatRecorded) {
	if rec == nil {
		return
	}
	b.mu.Lock()
	recorder := b.recorder
	b.mu.Unlock()
	if recorder == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := recorder(ctx, *rec); err != nil {
		b.logger.Warn("ops chat: history record failed", "request_id", rec.RequestID, "error", err)
	}
}

// Start 投递一条运维消息并登记在途请求。返回的 code 非空表示没发出去。
//
// 预留记录必须发生在 send 之前：设备回包可能比 HTTP 返回还快，先发后登记会让
// 第一条 chat_stream 帧在 webhook 侧找不到 pending 而被放走。
func (b *OpsChatBroker) Start(
	ctx context.Context, nodeID, opsPeerID, opsAgent, text string,
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
		opsAgent:  strings.TrimSpace(opsAgent),
		text:      text,
		createdAt: now,
		expiresAt: now.Add(opsChatPendingHardLimit),
		status:    "pending",
	}

	b.mu.Lock()
	swept := b.sweepLocked(now)
	if existingID := b.byTarget[opsPeerID]; existingID != "" {
		if existing := b.records[existingID]; existing != nil && existing.status == "pending" && now.Before(existing.expiresAt) {
			b.mu.Unlock()
			b.recordAll(swept)
			return "", OpsChatCodeBusy
		}
	}
	send := b.send
	b.records[requestID] = rec
	b.byTarget[opsPeerID] = requestID
	b.mu.Unlock()
	b.recordAll(swept)

	if send == nil {
		b.settle(requestID, "failed", "", OpsChatCodeUnavailable)
		return "", OpsChatCodeUnavailable
	}
	msgUID, err := send(ctx, opsPeerID, text, rec.opsAgent)
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
	var settled []*OpsChatRecorded
	defer func() {
		b.mu.Unlock()
		b.recordAll(settled)
	}()
	now := b.now()
	settled = b.sweepLocked(now)
	rec := b.records[requestID]
	if rec == nil {
		return OpsChatSnapshot{}, false
	}
	end := now
	if !rec.settledAt.IsZero() {
		end = rec.settledAt
	}
	return OpsChatSnapshot{
		RequestID: rec.requestID,
		NodeID:    rec.nodeID,
		OpsPeerID: rec.opsPeerID,
		OpsAgent:  rec.opsAgent,
		Status:    rec.status,
		Reply:     rec.reply,
		ElapsedMs: end.Sub(rec.createdAt).Milliseconds(),
		ErrorCode: rec.errorCode,
	}, true
}

// Cancel 主动放弃一轮还在等回包的请求。
//
// 没有固定超时后，设备彻底不回包时会一直占着 byTarget（同一对端 busy）。
// 管理端「放弃等待」把 pending 结成失败态：立即释放 busy、落一条历史，
// 设备迟到的回包仍按 settleLocked 的 pending 检查被丢弃，不会串进下一轮。
func (b *OpsChatBroker) Cancel(requestID, nodeID string) bool {
	b.mu.Lock()
	var settled *OpsChatRecorded
	if rec := b.records[requestID]; rec != nil && rec.nodeID == nodeID && rec.status == "pending" {
		settled = b.settleLocked(rec, "failed", "", OpsChatCodeCancelled)
	}
	b.mu.Unlock()
	b.record(settled)
	return settled != nil
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
	var settled []*OpsChatRecorded
	defer func() {
		b.mu.Unlock()
		b.recordAll(settled)
	}()
	now := b.now()
	settled = b.sweepLocked(now)

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
		settled = append(settled, b.settleLocked(rec, "completed", text, ""))
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
			settled = append(settled, b.settleLocked(rec, "completed", frame.Text, ""))
		case "failed", "cancelled":
			code := OpsChatCodeFailed
			if frame.ErrorCode != "" {
				code = frame.ErrorCode
			}
			settled = append(settled, b.settleLocked(rec, "failed", frame.Text, code))
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
	var settled *OpsChatRecorded
	if rec := b.records[requestID]; rec != nil {
		settled = b.settleLocked(rec, status, reply, code)
	}
	b.mu.Unlock()
	b.record(settled)
}

// settleLocked 只改内存态并返回一份给落库层的快照；同一条记录重复结算返回 nil。
func (b *OpsChatBroker) settleLocked(rec *opsChatRecord, status, reply, code string) *OpsChatRecorded {
	if rec.status != "pending" {
		return nil
	}
	rec.status = status
	rec.reply = reply
	rec.errorCode = code
	rec.settledAt = b.now()
	return &OpsChatRecorded{
		RequestID: rec.requestID,
		NodeID:    rec.nodeID,
		OpsPeerID: rec.opsPeerID,
		OpsAgent:  rec.opsAgent,
		Question:  rec.text,
		Reply:     rec.reply,
		Status:    rec.status,
		ErrorCode: rec.errorCode,
		ElapsedMs: rec.settledAt.Sub(rec.createdAt).Milliseconds(),
		CreatedAt: rec.createdAt,
		SettledAt: rec.settledAt,
	}
}

// sweepLocked 顺带返回本轮被判超时的记录，调用方在解锁后把它们交给落库层。
// 超时也要进历史：否则「点了没回」的那几轮恰恰在回看时消失。
func (b *OpsChatBroker) sweepLocked(now time.Time) []*OpsChatRecorded {
	var settled []*OpsChatRecorded
	for id, rec := range b.records {
		if rec.status == "pending" {
			if !now.Before(rec.expiresAt) {
				if snap := b.settleLocked(rec, "timeout", "", OpsChatCodeTimeout); snap != nil {
					settled = append(settled, snap)
				}
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
	return settled
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
