import { describe, expect, it } from "vitest";
import { buildChatStreamFrame, encodeChatStreamWireFrames, parseChatStopRequest } from "./chat-stream.js";
import { agentSupportsReasoning, extractStreamJsonFinalText, parseStreamJsonLine } from "./agents.js";

const baseFrame = {
  streamId: "stream-1", requestMessageId: "req-1", requesterId: "user-1", nodeId: "node-1",
  conversationType: 1 as const, conversationId: "conv-1", seq: 1, status: "streaming" as const, text: "你好",
};

describe("chat_stream 帧编码", () => {
  it("reasoning 非空时进帧、空时省略", () => {
    const withReasoning = JSON.parse(buildChatStreamFrame({ ...baseFrame, reasoning: "让我想想…" }));
    expect(withReasoning.reasoning).toBe("让我想想…");
    const without = JSON.parse(buildChatStreamFrame(baseFrame));
    expect("reasoning" in without).toBe(false);
  });

  it("activity 非空时进帧、空数组时省略", () => {
    const steps = [{ id: "t1", kind: "search" as const, label: "联网搜索", detail: "虾说", status: "done" as const }];
    const withActivity = JSON.parse(buildChatStreamFrame({ ...baseFrame, activity: steps }));
    expect(withActivity.activity).toEqual(steps);
    const empty = JSON.parse(buildChatStreamFrame({ ...baseFrame, activity: [] }));
    expect("activity" in empty).toBe(false);
    const without = JSON.parse(buildChatStreamFrame(baseFrame));
    expect("activity" in without).toBe(false);
  });

  it("error_code 正确从 errorCode 输出", () => {
    const frame = JSON.parse(buildChatStreamFrame({ ...baseFrame, status: "failed", errorCode: "boom" }));
    expect(frame.error_code).toBe("boom");
  });

  it("小帧直发 chat_stream；大帧切 chat_stream_chunk 分块", () => {
    const small = encodeChatStreamWireFrames({ ...JSON.parse(buildChatStreamFrame(baseFrame)) });
    expect(small).toHaveLength(1);
    expect(small[0].objectName).toBe("chat_stream");

    const bigPayload = { ...JSON.parse(buildChatStreamFrame({ ...baseFrame, text: "长".repeat(5000), reasoning: "思".repeat(3000) })) };
    const chunks = encodeChatStreamWireFrames(bigPayload);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => c.objectName === "chat_stream_chunk")).toBe(true);

    // 重组验证：块参数与 web fixture 编码器一致，能拼回原帧
    const parsed = chunks.map(c => JSON.parse(c.content));
    expect(new Set(parsed.map(c => c.sha256)).size).toBe(1);
    expect(parsed.map(c => c.chunkIndex)).toEqual(parsed.map((_, i) => i));
    const bytes = Buffer.concat(parsed.map(c => Buffer.from(c.data, "base64")));
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(bigPayload);
  });
});

describe("stream-json 解析器", () => {
  it("claude thinking_delta / text_delta 分流", () => {
    expect(parseStreamJsonLine(JSON.stringify({
      type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "思考中" } },
    }))).toEqual({ reasoning: "思考中" });
    expect(parseStreamJsonLine(JSON.stringify({
      type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "正文" } },
    }))).toEqual({ text: "正文" });
  });

  it("codex item.completed 的 reasoning / agent_message 分流，噪声行丢弃", () => {
    expect(parseStreamJsonLine(JSON.stringify({
      type: "item.completed", item: { type: "reasoning", text: "推理" },
    }))).toEqual({ reasoning: "推理" });
    expect(parseStreamJsonLine(JSON.stringify({
      type: "item.completed", item: { type: "agent_message", text: "回答" },
    }))).toEqual({ text: "回答" });
    expect(parseStreamJsonLine("WARNING: failed to clean up stale arg0 temp dirs")).toBeNull();
    expect(parseStreamJsonLine("2026-10-15T03:35:24.714256Z ERROR rmcp::transport::worker: worker quit")).toBeNull();
    expect(parseStreamJsonLine('{"type":"turn.completed","usage":{"output_tokens":33}}')).toBeNull();
    expect(parseStreamJsonLine('{"type":"item.started","item":{"type":"agent_message"}}')).toBeNull();
  });

  it("最终正文提取：claude result 优先、codex 聚合 agent_message", () => {
    const claude = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"部分"}]}}',
      '{"type":"result","result":"最终全文"}',
    ].join("\n");
    expect(extractStreamJsonFinalText(claude)).toBe("最终全文");
    const codex = [
      '{"type":"item.completed","item":{"type":"reasoning","text":"思考"}}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"你好"}}',
      '{"type":"turn.completed","usage":{"output_tokens":33}}',
    ].join("\n");
    expect(extractStreamJsonFinalText(codex)).toBe("你好");
    expect(extractStreamJsonFinalText("完全不是 JSON")).toBeUndefined();
  });

  // opencode 1.19 `run --format json --thinking` 的真实事件形状（实测抓取）：
  // 与另外两家不同，它上报的是整段 part 全文，所以解析结果带 partId + replace，
  // 由调用方换算成增量。
  it("opencode reasoning / text 事件带上 partId 与整段语义", () => {
    expect(parseStreamJsonLine(JSON.stringify({
      type: "reasoning",
      part: { id: "prt_r1", type: "reasoning", text: "先跑 ls 看看" },
    }))).toEqual({ reasoning: "先跑 ls 看看", partId: "prt_r1", replace: true });
    expect(parseStreamJsonLine(JSON.stringify({
      type: "text",
      part: { id: "prt_t1", type: "text", text: "done" },
    }))).toEqual({ text: "done", partId: "prt_t1", replace: true });
    // 非正文/思考的事件不进文本通道（工具走 activity 追踪器）
    expect(parseStreamJsonLine('{"type":"step_start","part":{"type":"step-start"}}')).toBeNull();
    expect(parseStreamJsonLine('{"type":"tool_use","part":{"type":"tool","tool":"bash"}}')).toBeNull();
    expect(parseStreamJsonLine('{"type":"text","part":{"type":"text","text":""}}')).toBeNull();
  });

  it("opencode 最终正文：按 part 去重再拼接（同一 part 重复上报不翻倍）", () => {
    const raw = [
      '{"type":"step_start","part":{"type":"step-start"}}',
      '{"type":"text","part":{"id":"prt_1","type":"text","text":"答"}}',
      '{"type":"text","part":{"id":"prt_1","type":"text","text":"答案"}}',
      '{"type":"text","part":{"id":"prt_2","type":"text","text":"。"}}',
      '{"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}',
    ].join("\n");
    expect(extractStreamJsonFinalText(raw)).toBe("答案。");
  });

  it("hermes：text 事件是增量（没有 part），result 里带权威全文", () => {
    expect(parseStreamJsonLine('{"type":"text","text":"上海"}'))
      .toEqual({ text: "上海" });
    const raw = [
      '{"type":"system","subtype":"init","model":"glm-5.3"}',
      '{"type":"text","text":"上海"}',
      '{"type":"text","text":"多云。"}',
      '{"type":"result","exit_code":0,"text":"上海多云。"}',
    ].join("\n");
    expect(extractStreamJsonFinalText(raw)).toBe("上海多云。");
    // 没有 result（被截断/提前退出）时退回增量拼接
    expect(extractStreamJsonFinalText('{"type":"text","text":"a"}\n{"type":"text","text":"b"}'))
      .toBe("ab");
    // 工具事件不进文本通道
    expect(parseStreamJsonLine('{"type":"tool_use","name":"web_search","input":{"query":"天气"}}')).toBeNull();
  });

  it("hermes：reasoning 事件是增量、无 part，与 opencode 的同名事件区分开", () => {
    // hermes 0.21.3 的 reasoning_callback 已经接进 JSONL（本机补丁），形状与 text 一样
    // 是「无 part 的增量」；opencode 的 reasoning 一定带 part 且是整段全文。
    expect(parseStreamJsonLine('{"type":"reasoning","text":"先比较"}'))
      .toEqual({ reasoning: "先比较" });
    expect(parseStreamJsonLine(JSON.stringify({
      type: "reasoning", part: { id: "prt_1", type: "reasoning", text: "整段" },
    }))).toEqual({ reasoning: "整段", partId: "prt_1", replace: true });
    // 空文本不产出（避免把空帧推给前端）
    expect(parseStreamJsonLine('{"type":"reasoning","text":""}')).toBeNull();
  });

  it("思考流可用性标记", () => {
    expect(agentSupportsReasoning("claude")).toBe(true);
    expect(agentSupportsReasoning("codex")).toBe(true);
    expect(agentSupportsReasoning("opencode")).toBe(true);
    // hermes 走 chat -q --format stream-json：text 增量 + tool_use/tool_result，
    // 思考事件由本机 stream_json.py 补丁接上 reasoning_callback 后才有。
    expect(agentSupportsReasoning("hermes")).toBe(true);
    // qwen 走 -p + -o stream-json --include-partial-messages，事件与 claude 同构。
    expect(agentSupportsReasoning("qwen")).toBe(true);
    // B 类十家（2026-11-04 批量接入）：cursor-agent（抓包在仓）/ codebuddy
    // （claude fork）/ pi+omp（pi 家族）/ kimi（正文流升级，thinking 官方
    // 不写 JSONL）/ traecli / qodercli+qoderclicn（宽松匹配）/ dsh（原生
    // thinking 帧）/ agy（宽松匹配）。
    expect(agentSupportsReasoning("cursor-agent")).toBe(true);
    expect(agentSupportsReasoning("pi")).toBe(true);
    expect(agentSupportsReasoning("dsh")).toBe(true);
    expect(agentSupportsReasoning("agy")).toBe(true);
    // C/D 类不在名单：C 类走「缓冲末尾整段」模式，D 类无思考数据源。
    expect(agentSupportsReasoning("openclaw")).toBe(false);
    expect(agentSupportsReasoning("grok")).toBe(false);
    expect(agentSupportsReasoning("dim")).toBe(false);
    expect(agentSupportsReasoning(undefined)).toBe(false);
  });

  // ── qwen（Qwen Code 0.25.3）───────────────────────────────────────────────
  // 事件协议与 claude 完全同构（本机实测 2026-11-04，quukk 网关 glm-5.2）：
  // stream_event/content_block_delta 承载 thinking_delta 与 text_delta 增量，
  // assistant 汇总消息（含 thinking 块），result 带权威全文。下面的 fixture
  // 按实测抓取的真实形状构造，含 qwen 特有的噪声事件（system init /
  // goal_state / message_stop）。
  const qwenFixtureLines = [
    '{"type":"system","subtype":"init","session_id":"s1","model":"glm-5.2","qwen_code_version":"0.25.3"}',
    '{"type":"stream_event","uuid":"u0","session_id":"s1","parent_tool_use_id":null,"event":{"type":"goal_state","goal_state":{"v":2,"goal":null,"activity":"idle"}}}',
    '{"type":"stream_event","uuid":"u1","session_id":"s1","parent_tool_use_id":null,"event":{"type":"message_start","message":{"id":"m1","role":"assistant","model":"glm-5.2","content":[]}}}',
    '{"type":"stream_event","uuid":"u2","session_id":"s1","parent_tool_use_id":null,"event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}}',
    '{"type":"stream_event","uuid":"u3","session_id":"s1","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"用户要"}}}',
    '{"type":"stream_event","uuid":"u4","session_id":"s1","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"一个字"}}}',
    '{"type":"stream_event","uuid":"u5","session_id":"s1","parent_tool_use_id":null,"event":{"type":"content_block_stop","index":0}}',
    '{"type":"assistant","uuid":"u6","session_id":"s1","parent_tool_use_id":null,"message":{"id":"m1","type":"message","role":"assistant","model":"glm-5.2","content":[{"type":"thinking","thinking":"用户要一个字","signature":""}],"stop_reason":null}}',
    '{"type":"stream_event","uuid":"u7","session_id":"s1","parent_tool_use_id":null,"event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}',
    '{"type":"stream_event","uuid":"u8","session_id":"s1","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}}',
    '{"type":"stream_event","uuid":"u9","session_id":"s1","parent_tool_use_id":null,"event":{"type":"content_block_stop","index":0}}',
    '{"type":"stream_event","uuid":"u10","session_id":"s1","parent_tool_use_id":null,"event":{"type":"message_stop"}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"好"}',
  ].join("\n");

  it("qwen：thinking_delta / text_delta 增量分流（claude 分支复用）", () => {
    expect(parseStreamJsonLine(
      '{"type":"stream_event","uuid":"u3","session_id":"s1","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"用户要"}}}',
    )).toEqual({ reasoning: "用户要" });
    expect(parseStreamJsonLine(
      '{"type":"stream_event","uuid":"u8","session_id":"s1","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}}',
    )).toEqual({ text: "好" });
    // qwen 特有噪声事件不进正文/思考通道
    expect(parseStreamJsonLine(
      '{"type":"system","subtype":"init","session_id":"s1","model":"glm-5.2"}',
    )).toBeNull();
    expect(parseStreamJsonLine(
      '{"type":"stream_event","uuid":"u0","session_id":"s1","parent_tool_use_id":null,"event":{"type":"goal_state","goal_state":{"v":2,"goal":null,"activity":"idle"}}}',
    )).toBeNull();
    expect(parseStreamJsonLine(
      '{"type":"stream_event","uuid":"u10","session_id":"s1","parent_tool_use_id":null,"event":{"type":"message_stop"}}',
    )).toBeNull();
  });

  it("qwen：完整事件流的正文提取走 claude 的 result 通道", () => {
    expect(extractStreamJsonFinalText(qwenFixtureLines)).toBe("好");
  });

  // ── B 类十家解析器回归（2026-11-04 批量接入）──────────────────────────────
  // cursor-agent：事件逐字取自仓内真实抓包
  // server/pkg/agent/testdata/cursor-agent-2026.07.20-stream-json.jsonl（字段零
  // 猜测）。顶层 thinking/subtype=delta 是思考流；subtype=completed 无 text、
  // system/user/tool_call/result 元事件全部丢弃。
  it("cursor-agent：顶层 thinking delta 进思考，completed/元事件丢弃（真实抓包形状）", () => {
    // 抓包 :3-5 原样
    expect(parseStreamJsonLine(
      '{"type":"thinking","subtype":"delta","text":"Reading notes.txt.","session_id":"ebb","timestamp_ms":1784819288883}',
    )).toEqual({ reasoning: "Reading notes.txt." });
    expect(parseStreamJsonLine(
      '{"type":"thinking","subtype":"delta","text":"\\n\\nRunning wc -l on notes.txt.","session_id":"ebb","timestamp_ms":1784819289514}',
    )).toEqual({ reasoning: "\n\nRunning wc -l on notes.txt." });
    // 抓包 :7 completed 无 text —— 不产出
    expect(parseStreamJsonLine(
      '{"type":"thinking","subtype":"completed","session_id":"ebb","timestamp_ms":1784819289515}',
    )).toBeNull();
    // 未知 subtype 不得折叠进思考（MUL-5231 教训）
    expect(parseStreamJsonLine('{"type":"thinking","subtype":"summary","text":"未知"}')).toBeNull();
    // 抓包 :8 assistant 正文（claude 分支复用）
    expect(parseStreamJsonLine(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"3 lines."}]},"session_id":"ebb"}',
    )).toEqual({ text: "3 lines." });
    // 抓包 :1/:2/:9-12/:23 元事件与工具事件全部丢弃
    expect(parseStreamJsonLine(
      '{"type":"system","subtype":"init","apiKeySource":"login","model":"Auto"}',
    )).toBeNull();
    expect(parseStreamJsonLine(
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"session_id":"ebb"}',
    )).toBeNull();
    expect(parseStreamJsonLine('{"type":"tool_call","subtype":"started","call_id":"c1","tool_call":{}}')).toBeNull();
  });

  it("cursor-agent：完整抓包流的正文提取（assistant 聚合 + result 权威全文）", () => {
    const captured = [
      '{"type":"system","subtype":"init","session_id":"ebb","model":"Auto"}',
      '{"type":"thinking","subtype":"delta","text":"Reading notes.txt.","session_id":"ebb"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I\'ll read notes.txt."}]},"session_id":"ebb"}',
      '{"type":"thinking","subtype":"delta","text":"notes.txt contains 3 lines.","session_id":"ebb"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"`notes.txt` has 3 lines."}]},"session_id":"ebb"}',
      '{"type":"result","subtype":"success","is_error":false,"result":"I\'ll read notes.txt.`notes.txt` has 3 lines.","session_id":"ebb"}',
    ].join("\n");
    expect(extractStreamJsonFinalText(captured))
      .toBe("I'll read notes.txt.`notes.txt` has 3 lines.");
  });

  // codebuddy：Claude Code fork，claude 分支直接消化（上游 codebuddy.go:414-417
  // 的 assistant thinking 块与本分支的 stream_event thinking_delta 同构）。
  it("codebuddy：thinking_delta / text_delta 走 claude 分支（fork 同形）", () => {
    expect(parseStreamJsonLine(
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"先查"}}}',
    )).toEqual({ reasoning: "先查" });
    expect(parseStreamJsonLine(
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"正文"}}}',
    )).toEqual({ text: "正文" });
    expect(agentSupportsReasoning("codebuddy")).toBe(true);
  });

  // pi / omp：上游 pi.go:545-559，message_update.assistantMessageEvent 的
  // thinking_delta / text_delta 增量在 delta 字段。
  it("pi/omp：message_update 增量分流，tool_execution/turn_end 等噪声丢弃", () => {
    expect(parseStreamJsonLine(
      '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"想想"}}',
    )).toEqual({ reasoning: "想想" });
    expect(parseStreamJsonLine(
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"答案"}}',
    )).toEqual({ text: "答案" });
    // 上游消费但设备端不关心的事件
    expect(parseStreamJsonLine('{"type":"agent_start"}')).toBeNull();
    expect(parseStreamJsonLine('{"type":"turn_start"}')).toBeNull();
    expect(parseStreamJsonLine('{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"ls"}}')).toBeNull();
    expect(parseStreamJsonLine('{"type":"tool_execution_end","toolCallId":"t1","result":"ok"}')).toBeNull();
    expect(parseStreamJsonLine('{"type":"turn_end","message":{"role":"assistant","usage":{"input":1,"output":2}}}')).toBeNull();
    expect(agentSupportsReasoning("pi")).toBe(true);
    expect(agentSupportsReasoning("omp")).toBe(true);
  });

  // kimi：官方明示 stream-json 不写 thinking —— 只有正文（claude 同构事件），
  // 思考通道如实为空。
  it("kimi：正文事件走 claude 分支（thinking 官方不写 JSONL）", () => {
    expect(parseStreamJsonLine(
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}}',
    )).toEqual({ text: "你好" });
    expect(agentSupportsReasoning("kimi")).toBe(true);
  });

  // dsh：版本化 stdio JSONL（v=1）原生 thinking 帧；版本不符整行丢弃。
  it("dsh：thinking/text 帧分流（v=1），版本不符与元帧丢弃", () => {
    expect(parseStreamJsonLine('{"v":1,"type":"thinking","content":"先想"}'))
      .toEqual({ reasoning: "先想" });
    expect(parseStreamJsonLine('{"v":1,"type":"text","content":"答案"}'))
      .toEqual({ text: "答案" });
    // 噪声帧
    expect(parseStreamJsonLine('{"v":1,"type":"ready","runtime":"dsh"}')).toBeNull();
    expect(parseStreamJsonLine('{"v":1,"type":"session","session_id":"d1"}')).toBeNull();
    expect(parseStreamJsonLine('{"v":1,"type":"tool_call","call_id":"c1","name":"terminal","arguments":"{}"}')).toBeNull();
    expect(parseStreamJsonLine('{"v":1,"type":"tool_result","call_id":"c1","output":"ok"}')).toBeNull();
    expect(parseStreamJsonLine('{"v":1,"type":"usage","input_tokens":1}')).toBeNull();
    // 版本不符（协议演进）→ 整行丢弃，绝不按旧版字段猜
    expect(parseStreamJsonLine('{"v":2,"type":"thinking","content":"新版"}')).toBeNull();
    expect(agentSupportsReasoning("dsh")).toBe(true);
  });

  it("dsh：正文提取 result.output 权威全文优先，text 帧增量兜底", () => {
    const withResult = [
      '{"v":1,"type":"thinking","content":"想"}',
      '{"v":1,"type":"text","content":"答"}',
      '{"v":1,"type":"text","content":"案"}',
      '{"v":1,"type":"result","status":"completed","output":"答案"}',
    ].join("\n");
    expect(extractStreamJsonFinalText(withResult)).toBe("答案");
    expect(extractStreamJsonFinalText('{"v":1,"type":"text","content":"只"}\n{"v":1,"type":"text","content":"有增量"}'))
      .toBe("只有增量");
  });

  // agy：上游 antigravity.go 的 event 判型骨架。正文在 step_update.text_delta
  // （step_type=agent_response 才算），权威全文在 result.result.response。
  // 思考字段未实测 → 宽松匹配（置信度中）。
  it("agy：step_update 正文增量 + 宽松思考匹配 + result.response 权威全文", () => {
    expect(parseStreamJsonLine(
      '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"答"}}',
    )).toEqual({ text: "答" });
    // 非 agent_response 的 step（工具执行等）不进正文
    expect(parseStreamJsonLine(
      '{"event":"step_update","step_update":{"step_index":0,"state":"ACTIVE","step_type":"tool_execution","text_delta":"工具输出"}}',
    )).toBeNull();
    // 宽松思考匹配：thinking_delta / thought_delta / reasoning_delta 任一
    expect(parseStreamJsonLine(
      '{"event":"step_update","step_update":{"step_type":"thinking","thinking_delta":"琢磨"}}',
    )).toEqual({ reasoning: "琢磨" });
    expect(parseStreamJsonLine(
      '{"event":"step_update","step_update":{"step_type":"thinking","thought_delta":"琢磨"}}',
    )).toEqual({ reasoning: "琢磨" });
    expect(parseStreamJsonLine(
      '{"event":"step_update","step_update":{"step_type":"thinking","reasoning_delta":"琢磨"}}',
    )).toEqual({ reasoning: "琢磨" });
    // init / result 元事件不产出增量（result 的全文由提取器拿）
    expect(parseStreamJsonLine('{"event":"init","conversation_id":"c1","init":{"model":"m"}}')).toBeNull();
    expect(parseStreamJsonLine('{"event":"result","result":{"status":"SUCCESS","response":"全文"}}')).toBeNull();
    expect(agentSupportsReasoning("agy")).toBe(true);
  });

  it("agy：正文提取 result.response 权威全文优先，step_update 增量兜底", () => {
    const withResult = [
      '{"event":"init","conversation_id":"c1","init":{"model":"m"}}',
      '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"答"}}',
      '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"案"}}',
      '{"event":"result","result":{"status":"SUCCESS","response":"答案"}}',
    ].join("\n");
    expect(extractStreamJsonFinalText(withResult)).toBe("答案");
    expect(extractStreamJsonFinalText(
      '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"只"}}\n{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"有增量"}}',
    )).toBe("只有增量");
    // 工具 step 的 text_delta 不进正文
    expect(extractStreamJsonFinalText(
      '{"event":"step_update","step_update":{"step_type":"tool_execution","text_delta":"工具输出"}}',
    )).toBeUndefined();
  });

  // traecli / qodercli：宽松思考匹配（⚠️ thought 字段待装机实测，置信度中）。
  // 证据优先级：官方文档描述 > 上游源码 > 合理推断；确认后收窄字段名。
  it("traecli/qodercli：宽松思考匹配（thinking/thought/reasoning）且不污染正文通道", () => {
    expect(agentSupportsReasoning("traecli")).toBe(true);
    expect(agentSupportsReasoning("qodercli")).toBe(true);
    expect(agentSupportsReasoning("qoderclicn")).toBe(true);
    // 各家候选字段都命中思考
    expect(parseStreamJsonLine('{"type":"assistant","thinking":"a"}')).toEqual({ reasoning: "a" });
    expect(parseStreamJsonLine('{"type":"assistant","thought":"a"}')).toEqual({ reasoning: "a" });
    expect(parseStreamJsonLine('{"type":"assistant","reasoning":"a"}')).toEqual({ reasoning: "a" });
    // 嵌套对象（thought:{delta|text|content}）
    expect(parseStreamJsonLine('{"type":"assistant","thought":{"text":"a"}}')).toEqual({ reasoning: "a" });
    // claude 同形正文不被宽松分支截胡（精确分支优先）
    expect(parseStreamJsonLine(
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"正文"}}}',
    )).toEqual({ text: "正文" });
    // result 权威全文照常走 codex/claude 通道
    expect(parseStreamJsonLine('{"type":"result","result":"全文"}')).toEqual({ text: "全文" });
    // 空与非字符串不命中
    expect(parseStreamJsonLine('{"type":"assistant","thinking":""}')).toBeNull();
    expect(parseStreamJsonLine('{"type":"assistant","thinking":42}')).toBeNull();
  });
});

describe("chat_stop 解析（回归）", () => {
  it("解析停止请求并透传非停止消息", () => {
    expect(parseChatStopRequest(JSON.stringify({ msg_type: "chat_stop", stream_id: "s1", request_id: "r1" })))
      .toEqual({ requestId: "r1", streamId: "s1", requestMessageId: "" });
    expect(parseChatStopRequest(JSON.stringify({ msg_type: "other" }))).toBeNull();
    expect(parseChatStopRequest("not json")).toBeNull();
  });

  it("带上 request_message_id 时透传，供设备端按轮次回找", () => {
    // stream_id 对不上是停止失效的主因（见 handleChatStop 的三级定位）：
    // 有轮次 id 就能退一步命中，老 web 不带这个字段时缺省空串。
    expect(parseChatStopRequest(JSON.stringify({
      msg_type: "chat_stop", stream_id: "s1", request_id: "r1", request_message_id: "D1ER-XYZ",
    }))).toEqual({ requestId: "r1", streamId: "s1", requestMessageId: "D1ER-XYZ" });
    expect(parseChatStopRequest(JSON.stringify({
      msg_type: "chat_stop", stream_id: "s1", request_message_id: 42,
    }))).toEqual({ requestId: "", streamId: "s1", requestMessageId: "" });
  });
});

// ---- 帧内步骤详情瘦身：终帧块数从 16 降到 3~4 ----
//
// 2026-10-26 现场：codex 一轮 13 个工具步骤，每步带 inputDetail(≤2000)/outputDetail(≤1500)，
// 终帧序列化 90 KB → 16 个 wire 块 → 16 条融云消息。任何一块没落地，前端就收不到
// 终帧（气泡一直转圈），随后兜底整包文本被当成第二条回复 → 界面上两条一样的回答。
describe("chat_stream 帧内 detail 瘦身", () => {
  const heavySteps = Array.from({ length: 13 }, (_, i) => ({
    id: `step_${i}`,
    kind: "command" as const,
    label: "执行命令",
    detail: "d".repeat(120),
    inputDetail: "i".repeat(2000),
    outputDetail: "o".repeat(1500),
    status: "done" as const,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
  }));

  it("单步 inputDetail/outputDetail 在帧里被截到 160 字（detail 摘要不动）", () => {
    const frame = JSON.parse(buildChatStreamFrame({ ...baseFrame, activity: heavySteps }));
    expect(frame.activity).toHaveLength(13);
    for (const step of frame.activity) {
      expect(step.inputDetail.length).toBe(160);
      expect(step.inputDetail.endsWith("…")).toBe(true);
      expect(step.outputDetail.length).toBe(160);
      expect(step.detail).toBe("d".repeat(120));
      // id/kind/label/status/时间戳原样保留（web 端要按它渲染与算耗时）
      expect(step.kind).toBe("command");
      expect(step.startedAt).toBe(1_700_000_000_000);
    }
  });

  it("重终帧（13 步 + 6366 字思考）块数从 16 降到个位数", () => {
    const reasoning = "想".repeat(6366);
    const frame = buildChatStreamFrame({
      ...baseFrame,
      seq: 35,
      status: "completed",
      text: "长".repeat(848),
      reasoning,
      activity: heavySteps,
      timeline: [["r", reasoning] as ["r", string], ...heavySteps.map((s) => ["s", s.id] as ["s", string])],
    });
    const bytes = Buffer.byteLength(frame, "utf8");
    const chunks = encodeChatStreamWireFrames(JSON.parse(frame) as Record<string, unknown>);
    // 未瘦身时实测 90,482 字节 / 16 块；瘦身后 ~49KB / 9 块。
    // 剩下的体量主要是「思考全文 ×2」（reasoning 与 timeline 各存一份），
    // 那属于协议结构问题，不在这一刀里动。
    expect(bytes).toBeLessThan(50_000);
    expect(chunks.length).toBeLessThanOrEqual(9);
  });

  it("没有详情字段时不凭空造出 undefined（帧体与原样一致）", () => {
    const plain = [{ id: "t1", kind: "search" as const, label: "联网搜索", status: "running" as const }];
    const frame = JSON.parse(buildChatStreamFrame({ ...baseFrame, activity: plain }));
    expect(frame.activity).toEqual(plain);
    expect("inputDetail" in frame.activity[0]).toBe(false);
  });
});
