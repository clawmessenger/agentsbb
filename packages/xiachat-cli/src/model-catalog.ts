import {
  grokRouteFromCliModelId,
  stripAnsiCodes,
  type OutputStopPredicate,
} from "./agents.js";
import { agentModelCapability } from "./agent-model-capabilities.js";
import { isModelRoute } from "./agent-default-model.js";
import {
  probeProviderModels,
  readAgentConfig,
  type AgentConfig,
  type ProviderEndpoint,
} from "./model-providers.js";
import { staticModelCatalogFor } from "./model-static-catalogs.js";

// Protocol v2 model-catalog responder for the web's 设备管理 → 默认模型 panel.
//
// agentsbb-web sends a private "command" message
//   { msg_type: "discussion_model_catalog_request", protocolVersion: 2,
//     requestId: <uuid>, timestamp: <ms> }
// to the node's RongCloud user and waits 8s (15s when the node looks offline)
// for a "discussion_model_catalog_response" from that same user. Only the
// OpenClaw plugin (oepnclaw-agentsbb) implemented that responder, so nodes
// driven by this CLI (opencode / codex / hermes / ...) never answered and the
// panel stayed on "正在获取设备模型目录…".
//
// Wire shape must stay byte-compatible with the web's normalizeCatalog
// (agentsbb-web/src/services/node-model-catalog.ts): exactly the keys
// msg_type/protocolVersion/requestId/defaultModel/providers/timestamp, each
// provider exactly {id,name,models}, each model exactly {id,name}.

export interface DiscussionModelCatalog {
  defaultModel: string | null;
  providers: Array<{
    id: string;
    name: string;
    models: Array<{ id: string; name: string }>;
  }>;
}

export const EMPTY_MODEL_CATALOG: DiscussionModelCatalog = Object.freeze({
  defaultModel: null,
  providers: [],
}) as DiscussionModelCatalog;

const MAX_PROVIDERS = 64;
const MAX_MODELS_PER_PROVIDER = 500;
const MAX_LINES_SCANNED = 32_000;

// A `provider/model` route: matches the web's segment() rules (non-empty, <=128
// chars, no whitespace, exactly one slash).
const ROUTE_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;

export interface ModelListSpec {
  argv: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  /**
   * 「输出够了就收工」判据（可选，透传给 runAgentCommand）。dsh 的列举命令
   * 打完帧**不会自己退出**（2026-11 实测），等 EOF 只能等到超时 → 空目录。
   */
  stopWhen?: OutputStopPredicate;
}

// Agents whose CLI can enumerate models as `provider/model` routes — the only
// shape the web's provider+model dropdowns can persist and hand back to the
// agent. openclaw needs the `list` subcommand (`openclaw models` alone prints
// status, not the catalog).
//
// Every entry must be mirrored in agent-model-capabilities.ts with
// catalogSource 'cli' — that table is the single source of truth for "where a
// catalog comes from" and "can a picked model actually be injected".
//
//   dsh  — `--profile multica --list-models` (2026-11 真机实测；**不能带
//          --stdio**，二者互斥)。输出是一行完整的 JSONL 帧
//          `{"v":1,"type":"models","models":[…]}` —— 注意版本字段名是 `v` 不是
//          `version`。这条命令打完帧**不会自己退出**，所以必须配 stopWhen
//          （dshModelsFrameComplete）命中即收工，不能等 EOF。解析见
//          parseDshModelListJsonl；注入走 stdin 的 execute 帧。
//   agy  — `agy models` 是本地枚举（models.go:2407-2425，MUL-3125）。输出是
//          `id\tlabel` 行、无 provider 列，parseAgyModelsList 归到虚拟 provider
//          `agy`，buildModelArgs 注入时剥掉。
//   pi   — `pi --list-models`（models.go:1232-1307，兼容 `provider:model` 与多列
//          表格）。parsePiModelsList 解析。
//   grok — `grok models`（2026-11 真机实测，exit 0，人类可读文本）：`- <id>` /
//          `* <id> (default)` 行 + 头部 `Default model: <id>`；id 是**连字符**
//          形式（`quukk-glm-5.2`）或裸 id（`grok-4.7`）。parseGrokModelsList 负责
//          转成单斜杠路由（wire 硬要求），注入侧 grokCliModelId 转回去。
//   kimi — `kimi provider list --json`（2026-11 真机实测，exit 0）：models 的 key
//          就是 `provider/model` 路由，逐项还带 displayName。⚠️ 同一份输出里的
//          providers.*.apiKey 是明文真实密钥 —— parseKimiProviderListJson **只读
//          models 段**，不打印、不透传任何 providers 内容。
//
// NOTE: none of these lists is complete on its own. openclaw's covers the
// provider's configured/OAuth catalogue but not the gateway's pass-through
// models, and codex/hermes have no usable listing command at all. Endpoint
// probing (see model-providers.ts) unions the agent's list with the live
// `/models` answer.
const AGENT_MODEL_LIST: Readonly<Record<string, ModelListSpec>> = {
  opencode: { argv: ["models"], timeoutMs: 30_000, maxOutputBytes: 256 * 1024 },
  openclaw: { argv: ["models", "list", "--json"], timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 },
  dsh: {
    argv: ["--profile", "multica", "--list-models"],
    timeoutMs: 10_000,
    maxOutputBytes: 256 * 1024,
    stopWhen: dshModelsFrameComplete,
  },
  agy: { argv: ["models"], timeoutMs: 10_000, maxOutputBytes: 256 * 1024 },
  pi: { argv: ["--list-models"], timeoutMs: 15_000, maxOutputBytes: 256 * 1024 },
  grok: { argv: ["models"], timeoutMs: 15_000, maxOutputBytes: 256 * 1024 },
  kimi: { argv: ["provider", "list", "--json"], timeoutMs: 15_000, maxOutputBytes: 512 * 1024 },
};

export function modelListSpec(agentName: string | undefined): ModelListSpec | null {
  if (!agentName) return null;
  return AGENT_MODEL_LIST[agentName] ?? null;
}

interface ProviderGroup {
  name: string;
  models: Map<string, string>;
}

type GroupedProviders = Map<string, ProviderGroup>;

function groupRoutes(
  routes: Iterable<string>,
  names: ReadonlyMap<string, string> = new Map(),
): GroupedProviders {
  const grouped: GroupedProviders = new Map();
  let scanned = 0;
  for (const route of routes) {
    if (++scanned > MAX_LINES_SCANNED) break;
    const match = ROUTE_RE.exec(route);
    if (!match) continue;
    const [, providerId, modelId] = match;
    let group = grouped.get(providerId);
    if (!group) {
      if (grouped.size >= MAX_PROVIDERS) continue;
      group = { name: providerId, models: new Map() };
      grouped.set(providerId, group);
    }
    if (!group.models.has(modelId) && group.models.size < MAX_MODELS_PER_PROVIDER) {
      group.models.set(modelId, names.get(route) ?? modelId);
    }
  }
  return grouped;
}

function finalizeCatalog(
  grouped: GroupedProviders,
  defaultModel: string | null,
): DiscussionModelCatalog {
  const providers = [...grouped.entries()]
    .filter(([, group]) => group.models.size > 0)
    .map(([id, group]) => ({
      id,
      name: group.name,
      models: [...group.models.entries()]
        .map(([modelId, name]) => ({ id: modelId, name }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const wanted = defaultModel && ROUTE_RE.test(defaultModel) ? defaultModel : null;
  const inCatalog = wanted !== null
    && providers.some((provider) => provider.id === wanted.split("/")[0]
      && provider.models.some((model) => model.id === wanted.split("/")[1]));
  if (providers.length === 0 && !inCatalog) return EMPTY_MODEL_CATALOG;
  return { defaultModel: inCatalog ? wanted : null, providers };
}

// Folds an endpoint's `/models` answer into the provider group.
//
// This is a UNION, not a replacement, and that matters: an agent's own list
// and the endpoint enumerate different halves. openclaw's `models list` covers
// the provider's configured/OAuth catalogue (`openai/gpt-5.6-sol`, which the
// proxy does serve — verified), while `/models` lists the gateway's
// pass-through models (`glm-5.2`, `deepseek-v4-pro`, …) that openclaw does not
// know about. Both sets run, so both belong in the panel.
function mergeEndpointModels(
  grouped: GroupedProviders,
  endpoint: ProviderEndpoint,
  modelIds: readonly string[],
): number {
  const group = grouped.get(endpoint.id) ?? { name: endpoint.name ?? endpoint.id, models: new Map() };
  // A display name from the agent's own config (e.g. codex's
  // `name = "Quukk Direct"`) beats the raw id.
  if (endpoint.name) group.name = endpoint.name;
  let added = 0;
  for (const modelId of modelIds) {
    if (group.models.size >= MAX_MODELS_PER_PROVIDER) break;
    if (group.models.has(modelId)) continue;
    if (!ROUTE_RE.test(`${endpoint.id}/${modelId}`)) continue;
    group.models.set(modelId, modelId);
    added += 1;
  }
  grouped.set(endpoint.id, group);
  return added;
}

/** Groups flat `provider/model` routes into the web's catalog shape. */
export function catalogFromRoutes(
  routes: Iterable<string>,
  defaultModel: string | null = null,
  names: ReadonlyMap<string, string> = new Map(),
): DiscussionModelCatalog {
  return finalizeCatalog(groupRoutes(routes, names), defaultModel);
}

// Text output shapes handled here:
//   opencode models        -> one `provider/model` per line
//   openclaw models        -> `Default       : openai/gpt-5.6-sol`
//   openclaw models list   -> a table row tagged `default` in its last column
export function parseModelListText(stdout: string): DiscussionModelCatalog {
  const routes: string[] = [];
  let defaultModel: string | null = null;
  const lines = stripAnsiCodes(stdout).split(/\r?\n/).slice(0, MAX_LINES_SCANNED);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const labelled = /^(?:default|默认模型|节点默认)\s*[:：]\s*(\S+)/i.exec(line);
    if (labelled) {
      const candidate = labelled[1].replace(/[.,;]+$/, "");
      if (ROUTE_RE.test(candidate)) {
        defaultModel = candidate;
        // The default must also be selectable, so it joins the route list.
        routes.push(candidate);
      }
      continue;
    }
    let lineRoute: string | null = null;
    for (const token of line.split(/[\s,|]+/)) {
      if (!ROUTE_RE.test(token)) continue;
      routes.push(token);
      lineRoute = token;
    }
    // openclaw's table marks the current default with a trailing `default` tag.
    if (lineRoute && /(^|[\s|])default([\s|]|$)/.test(line)) defaultModel = lineRoute;
  }
  return catalogFromRoutes(routes, defaultModel);
}

// `openclaw models list --json` -> { count, models: [{ key, name, tags: [...] }] }
export function parseOpenclawModelListJson(stdout: string): DiscussionModelCatalog | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const models = (parsed as { models?: unknown }).models;
  if (!Array.isArray(models)) return null;

  const routes: string[] = [];
  const names = new Map<string, string>();
  let defaultModel: string | null = null;
  for (const entry of models) {
    if (typeof entry !== "object" || entry === null) continue;
    const key = (entry as { key?: unknown }).key;
    if (typeof key !== "string" || !ROUTE_RE.test(key)) continue;
    routes.push(key);
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0 && name.length <= 500) names.set(key, name);
    const tags = (entry as { tags?: unknown }).tags;
    if (Array.isArray(tags) && tags.includes("default")) defaultModel = key;
  }
  return catalogFromRoutes(routes, defaultModel, names);
}

// dsh `--profile multica --list-models`（2026-11 真机实测，不能带 --stdio）。
//
// 输出是一行完整的 JSONL 帧：
//   {"v":1,"type":"models","models":[
//     {"id":"quukk/glm-5.2","label":"GLM 5.2","provider":"Quukk AI","default":true,
//      "thinking":{"supported_levels":[…],"default_level":"high"}}, …]}
//
// 三个关键点（踩过的坑，逐条钉住）：
//   1. 版本字段名是 `v`（值 1），不是 `version`；
//   2. **`id` 本身已经是 `provider/model` 斜杠路由**，而 `provider` 字段是
//      **展示名**（"Quukk AI"/"DeepSeek"，含空格）—— 直接拿它当 provider id
//      会让前端 normalizeCatalog 判非法。所以 provider id 取 `id` 的第一个
//      斜杠前段，展示名单独记下来覆盖 group name；
//   3. `thinking` 档位在 wire 协议里没有字段（白名单只有 id/name），丢弃。
export function parseDshModelListJsonl(stdout: string): DiscussionModelCatalog {
  const routes: string[] = [];
  const names = new Map<string, string>();
  const providerNames = new Map<string, string>();
  let defaultModel: string | null = null;
  for (const rawLine of stdout.split(/\r?\n/).slice(0, MAX_LINES_SCANNED)) {
    const line = rawLine.trim();
    if (!line) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      continue; // 半行 / 非 JSON 噪声跳过，不当作损坏
    }
    if (typeof frame !== "object" || frame === null) continue;
    const record = frame as Record<string, unknown>;
    // 版本不符的帧整行丢弃（与流解析器同一降级策略，agents.ts DSH_PROTOCOL_VERSION）。
    if (record.v !== 1 || record.type !== "models" || !Array.isArray(record.models)) continue;
    for (const item of record.models) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as Record<string, unknown>;
      const route = typeof entry.id === "string" ? entry.id.trim() : "";
      if (!ROUTE_RE.test(route)) continue;
      if (!routes.includes(route)) routes.push(route);
      const label = typeof entry.label === "string" && entry.label.trim() !== ""
        ? entry.label.trim().slice(0, 500)
        : route.split("/")[1];
      if (!names.has(route)) names.set(route, label);
      const display = typeof entry.provider === "string" ? entry.provider.trim() : "";
      const providerId = route.split("/")[0];
      if (display && display.length <= 500 && !providerNames.has(providerId)) {
        providerNames.set(providerId, display);
      }
      if (entry.default === true && !defaultModel) defaultModel = route;
    }
  }
  const catalog = catalogFromRoutes(routes, defaultModel, names);
  // catalogFromRoutes 只能用 provider id 当展示名；dsh 的帧里有真正的展示名
  // （"Quukk AI"），在这里补上（finalizeCatalog 已经把 id 收口过了）。
  return {
    defaultModel: catalog.defaultModel,
    providers: catalog.providers.map((provider) => ({
      ...provider,
      name: providerNames.get(provider.id) ?? provider.name,
    })),
  };
}

/**
 * dsh 列举命令的「够用了」判据：累计输出里出现一条完整的 `v:1,type:"models"`
 * 帧（且帧里有模型）即视为完成。
 *
 * 该命令打完帧**不会退出**（2026-11 实测，只能等 timeout 被杀），所以
 * runAgentCommand 必须靠这条判据早退，否则永远拿不到目录。
 */
export function dshModelsFrameComplete(partialStdout: string): boolean {
  for (const rawLine of partialStdout.split(/\r?\n/).slice(0, MAX_LINES_SCANNED)) {
    const line = rawLine.trim();
    if (!line || line[0] !== "{") continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof frame !== "object" || frame === null) continue;
    const record = frame as Record<string, unknown>;
    if (record.v !== 1 || record.type !== "models") continue;
    if (Array.isArray(record.models) && record.models.length > 0) return true;
  }
  return false;
}

// `grok models`（2026-11 真机实测，exit 0，人类可读文本，不是 JSON）：
//
//   Model 'quukk-glm-5.2' is using its own API key.     ← 噪声，跳过
//
//   Default model: quukk-glm-5.2                        ← 默认值（最稳的来源）
//
//   Available models:
//     - grok-4.7                                        ← 裸 id
//     * quukk-glm-5.2 (default)                         ← 当前默认标记
//     - quukk-kimi-k2-7-code
//
// CLI 的 id 是**连字符**形状，wire 协议要求单斜杠 —— 用 grokRouteFromCliModelId
// 转换。规则是**严格双射**：第一个 `-` 之前为 provider，其余为 model
// （`quukk-glm-5.2` → `quukk`+`glm-5.2`；裸 `grok-4.7` → `grok`+`4.7`）。
// 因为「provider-model」能逐字符还原，注入侧 grokCliModelId 是它的逆函数。
// **不用前缀白名单猜 `xai`** —— 白名单不可靠，双射不需要它。
// 已知展示局限（可接受）：裸 id `grok-4.7` 在面板里显示为 `grok/4.7`，
// 注入出去的仍是 CLI 认的 `grok-4.7`，功能不受影响。
export function parseGrokModelsList(stdout: string): DiscussionModelCatalog {
  const routes: string[] = [];
  const names = new Map<string, string>();
  let defaultModel: string | null = null;
  for (const rawLine of stripAnsiCodes(stdout).split(/\r?\n/).slice(0, MAX_LINES_SCANNED)) {
    const line = rawLine.trim();
    if (!line) continue;
    const labelled = /^default model\s*:\s*(\S+)/i.exec(line);
    if (labelled) {
      const route = grokRouteFromCliModelId(labelled[1]);
      if (route && !routes.includes(route)) routes.push(route);
      if (route) {
        defaultModel = route;
        names.set(route, labelled[1]);
      }
      continue;
    }
    const bullet = /^[-*]\s+(\S+)/.exec(line);
    if (!bullet) continue; // 表头 / 噪声行（"Model '…' is using its own API key." 等）
    const cliId = bullet[1];
    const route = grokRouteFromCliModelId(cliId);
    if (!route) continue;
    if (!routes.includes(route)) routes.push(route);
    names.set(route, cliId);
    // 列表里的 `* … (default)` 标记与头部 Default model 行一致，任一命中即可。
    if (line.startsWith("*") && /\(default\)/i.test(line) && !defaultModel) defaultModel = route;
  }
  return catalogFromRoutes(routes, defaultModel, names);
}

// `kimi provider list --json`（2026-11 真机实测，exit 0）：
//
//   { "providers": { "quukk": { …, "apiKey": "sk-…" } },   ← ⚠️ 明文真实密钥
//     "models": { "quukk/glm-5.2": { "provider":"quukk","model":"glm-5.2",
//                                     "displayName":"GLM 5.2", … }, … } }
//
// models 的 key 本身就是 `provider/model` 路由，逐项还带 displayName —— 直接映射，
// 不需要猜。**只读 models 段**：providers 段（含 apiKey）一律不读、不打印、
// 不进 catalog（安全红线，测试用假值）。
export function parseKimiProviderListJson(stdout: string): DiscussionModelCatalog | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const models = (parsed as { models?: unknown }).models;
  if (typeof models !== "object" || models === null || Array.isArray(models)) return null;

  const routes: string[] = [];
  const names = new Map<string, string>();
  for (const [rawKey, value] of Object.entries(models as Record<string, unknown>)) {
    const key = rawKey.trim();
    // Provider 与 model 两侧都从 key 推导；entry.provider/model 只在 key 不合法时
    // 作为兜底（它们的组合仍是同一条路由）。
    let route: string | null = ROUTE_RE.test(key) ? key : null;
    if (!route && typeof value === "object" && value !== null) {
      const entry = value as Record<string, unknown>;
      const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
      const model = typeof entry.model === "string" ? entry.model.trim() : "";
      const candidate = provider && model ? `${provider}/${model}` : "";
      if (candidate && ROUTE_RE.test(candidate)) route = candidate;
    }
    if (!route || routes.includes(route)) continue;
    routes.push(route);
    const displayName = typeof value === "object" && value !== null
      ? (value as Record<string, unknown>).displayName
      : undefined;
    const fallback = route.split("/")[1];
    if (typeof displayName === "string" && displayName.trim() !== "") {
      names.set(route, displayName.trim().slice(0, 500));
    } else {
      names.set(route, fallback);
    }
  }
  if (routes.length === 0) return null;
  // provider list 不报当前默认（kimi 的默认在 config.toml 的 default_model 里，
  // 设备端没有那份解析器），defaultModel 交给上层兜底。
  return catalogFromRoutes(routes, null, names);
}

// `agy models` -> `id\tlabel` lines (agy 1.1.11+) or one bare id per line
// (older builds). Items carry no provider (models.go:2427-2452
// parseAntigravityModels), so every id is grouped under the synthetic `agy`
// provider; buildModelArgs strips that prefix back off when injecting.
export function parseAgyModelsList(stdout: string): DiscussionModelCatalog {
  const routes: string[] = [];
  const names = new Map<string, string>();
  for (const rawLine of stripAnsiCodes(stdout).split(/\r?\n/).slice(0, MAX_LINES_SCANNED)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [idField, labelField] = line.split("\t");
    const id = idField.trim();
    if (!id) continue;
    const route = `agy/${id}`;
    if (!ROUTE_RE.test(route) || routes.includes(route)) continue;
    routes.push(route);
    const label = labelField?.trim();
    if (label) names.set(route, label.slice(0, 500));
  }
  return catalogFromRoutes(routes, null, names);
}

// `pi --list-models` -> either legacy `provider:model` rows or a multi-column
// `provider model context …` table; both normalize to `provider/model`
// (models.go:1249-1308 parsePiModels). Diagnostic lines (pi interleaves
// "Warning: No models match pattern …" prose with the catalog) and the
// `provider` header row are skipped so prose tokens are never coined into
// bogus models (#3729).
export function parsePiModelsList(stdout: string): DiscussionModelCatalog {
  const routes: string[] = [];
  for (const rawLine of stripAnsiCodes(stdout).split(/\r?\n/).slice(0, MAX_LINES_SCANNED)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Prose diagnostics: `Warning: …` / the unmatched-pattern message itself.
    if (/^warning\b/i.test(line) || /no models match/i.test(line)) continue;
    const fields = line.split(/\s+/);
    const first = fields[0];
    if (/^provider$/i.test(first)) continue; // table header
    let route: string;
    if (first.includes(":") || first.includes("/")) {
      // Legacy `provider:model` — normalize the first colon to a slash. Kept
      // to this branch so a table row's model column never gets rewritten.
      route = first.replace(":", "/");
    } else if (fields.length >= 2) {
      route = `${first}/${fields[1]}`;
    } else {
      continue;
    }
    if (!ROUTE_RE.test(route) || routes.includes(route)) continue;
    routes.push(route);
  }
  return catalogFromRoutes(routes, null);
}

export function parseModelCatalogOutput(
  agentName: string | undefined,
  stdout: string,
): DiscussionModelCatalog {
  if (agentName === "openclaw") {
    const json = parseOpenclawModelListJson(stdout);
    if (json && json.providers.length > 0) return json;
  }
  // dsh / agy / pi / grok / kimi 的输出形态与「文本里找 provider/model 路由」的
  // 通用解析器不兼容（JSONL 帧 / 无 provider 的裸 id / 冒号分隔 / 连字符 id /
  // JSON 信封），各自走专属解析器。
  if (agentName === "dsh") return parseDshModelListJsonl(stdout);
  if (agentName === "agy") return parseAgyModelsList(stdout);
  if (agentName === "pi") return parsePiModelsList(stdout);
  if (agentName === "grok") return parseGrokModelsList(stdout);
  if (agentName === "kimi") return parseKimiProviderListJson(stdout) ?? EMPTY_MODEL_CATALOG;
  return parseModelListText(stdout);
}

export interface ModelCatalogRequest {
  msg_type: "discussion_model_catalog_request";
  protocolVersion: 2;
  requestId: string;
  // When the web client sent the request (epoch ms), as carried on the wire.
  // The dispatcher uses it to drop requests the web has already timed out on —
  // notably 融云's offline backlog, which is replayed in full on every
  // reconnect (the Node shim has no IndexDB, so the SDK cannot dedupe). Each
  // replay would otherwise fire dozens of responses at once and trip
  // RongCloud's SEND_FREQUENCY_TOO_FAST (20604), losing all of them.
  timestamp?: number;
}

export function parseModelCatalogRequest(content: string): ModelCatalogRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.msg_type !== "discussion_model_catalog_request") return null;
  if (record.protocolVersion !== 2) return null;
  const requestId = record.requestId;
  if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128) return null;
  const timestamp = record.timestamp;
  if (timestamp !== undefined && (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp))) {
    return null;
  }
  return {
    msg_type: "discussion_model_catalog_request",
    protocolVersion: 2,
    requestId,
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}

export function buildModelCatalogResponse(
  request: ModelCatalogRequest,
  catalog: DiscussionModelCatalog,
  clock: () => number = Date.now,
): string {
  return JSON.stringify({
    msg_type: "discussion_model_catalog_response",
    protocolVersion: 2,
    requestId: request.requestId,
    defaultModel: catalog.defaultModel,
    providers: catalog.providers,
    timestamp: clock(),
  });
}

// 「默认对话模型」的写协议。
//
// 读走上面那对 request/response（目录里本来就带 defaultModel）；写必须单独一对，
// 因为「改设置」是一个有副作用的动作，不能塞进只读查询里 —— 面板每展开一次都会
// 发目录请求，塞进去就等于每展开一次都写一次盘，且目录刷新失败时改动去向不明。
//
// model 传 null = 清除，恢复 agent CLI 自身默认。
export interface AgentDefaultModelRequest {
  msg_type: "discussion_agent_default_model_request";
  protocolVersion: 2;
  requestId: string;
  model: string | null;
  timestamp?: number;
}

export function parseAgentDefaultModelRequest(content: string): AgentDefaultModelRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.msg_type !== "discussion_agent_default_model_request") return null;
  if (record.protocolVersion !== 2) return null;
  const requestId = record.requestId;
  if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128) return null;
  const model = record.model;
  // 只接受 null 或合法 route：写进设备的偏好必须是 runAgentTurn 真能用的形状，
  // 否则下一轮会带着一个 agent 认不出的 --model 起来（直接退出，比不生效更糟）。
  if (model !== null && !isModelRoute(model)) return null;
  const timestamp = record.timestamp;
  if (timestamp !== undefined && (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp))) {
    return null;
  }
  return {
    msg_type: "discussion_agent_default_model_request",
    protocolVersion: 2,
    requestId,
    model,
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}

/** 写请求的回执。`model` 是**落盘后**的真实值（null = 已清除），不是请求里的值。 */
export function buildAgentDefaultModelResponse(
  request: AgentDefaultModelRequest,
  model: string | null,
  error: string | null,
  clock: () => number = Date.now,
): string {
  return JSON.stringify({
    msg_type: "discussion_agent_default_model_response",
    protocolVersion: 2,
    requestId: request.requestId,
    ok: error === null,
    model,
    ...(error === null ? {} : { error }),
    timestamp: clock(),
  });
}

export interface ModelCatalogLoaderOpts {
  agentName?: string;
  /**
   * Runs one agent subcommand. `stopWhen`（可选，第 4 参）来自 ModelListSpec：
   * 命令打完帧不肯退出时（dsh）靠它早退，实现可以忽略它。
   */
  runCommand: (
    argv: string[],
    timeoutMs: number,
    maxOutputBytes: number,
    stopWhen?: OutputStopPredicate,
  ) => Promise<string>;
  // Reads the agent's own config (provider endpoints + configured default).
  // Defaults to the real readers; inject a stub to keep tests hermetic.
  readConfig?: (agentName: string | undefined) => AgentConfig | null;
  // 主人给这台 agent 设置的默认模型（见 agent-default-model.ts）。它比 agent CLI
  // 自身的 default_model 更该被回显 —— 面板上"当前默认"显示的就是用户自己设的值。
  readAgentDefaultModel?: () => string | undefined;
  // Probes one OpenAI-compatible endpoint; `null` = unusable.
  probe?: (endpoint: ProviderEndpoint) => Promise<string[] | null>;
  logger?: (message: string) => void;
  /** How long a cached catalog is served before a background refresh kicks in. */
  ttlMs?: number;
  now?: () => number;
}

export interface ModelCatalogLoader {
  /** Catalog for the current request; never rejects. */
  load(): Promise<DiscussionModelCatalog>;
  /** Kick off a background refresh so the first panel open is served warm. */
  warm(): void;
  /** Drop the cached catalog (call right after the default model is rewritten). */
  invalidate(): void;
}

/**
 * 日志打码：runCommand 的失败信息里会夹带 agent 的原始 stderr/stdout，而
 * `kimi provider list --json` 的输出里 providers.*.apiKey 是**明文真实密钥**
 * （2026-11 实测）。日志只该说明「哪条命令失败」，不该顺手把密钥写进日志——
 * 这里把 `sk-…` 形态的 token 统一打码。
 */
export function redactSecrets(text: string): string {
  return text.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***");
}

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

/**
 * 配置里已经声明了模型清单时，给 CLI 列举的**短预算**。
 *
 * 声明清单足够让面板先有内容，但它是手写的一份子集：opencode 还会列出自己的
 * 内置模型（`opencode/*`）和配置里没声明的 provider（`deepseek/*`），这些只在
 * `opencode models` 的输出里。实测热启动 ~1.4s，4s 足够；超时就退回声明清单。
 */
const DECLARED_CLI_TIMEOUT_MS = 4_000;

function groupsFromCatalog(catalog: DiscussionModelCatalog): GroupedProviders {
  const grouped: GroupedProviders = new Map();
  for (const provider of catalog.providers) {
    if (grouped.size >= MAX_PROVIDERS) break;
    grouped.set(provider.id, {
      name: provider.name,
      models: new Map(provider.models.map((model) => [model.id, model.name])),
    });
  }
  return grouped;
}

/** UNION-merges a catalog into the grouped accumulator without shrinking it. */
function mergeCatalogGroups(grouped: GroupedProviders, catalog: DiscussionModelCatalog): void {
  for (const [id, group] of groupsFromCatalog(catalog)) {
    const existing = grouped.get(id);
    if (!existing) {
      grouped.set(id, group);
      continue;
    }
    for (const [modelId, name] of group.models) {
      if (existing.models.size >= MAX_MODELS_PER_PROVIDER) break;
      if (!existing.models.has(modelId)) existing.models.set(modelId, name);
    }
  }
}

// The web aborts after 8s, while `openclaw models list` alone takes ~10s on a
// cold start, so a cache-warm path is required for anything beyond opencode.
export function createModelCatalogLoader(opts: ModelCatalogLoaderOpts): ModelCatalogLoader {
  const spec = modelListSpec(opts.agentName);
  const readConfig = opts.readConfig ?? ((name: string | undefined) => readAgentConfig(name));
  const probe = opts.probe ?? ((endpoint: ProviderEndpoint) => probeProviderModels(endpoint));
  const ttlMs = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;
  let cached: DiscussionModelCatalog | null = null;
  let cachedAt = 0;
  let inflight: Promise<DiscussionModelCatalog> | null = null;

  const describe = (err: unknown): string => redactSecrets(err instanceof Error ? err.message : String(err));

  // Never rejects: a failing CLI command or an unreachable endpoint degrades to
  // whatever we already know rather than taking the panel down with it.
  const resolveCatalog = async (): Promise<DiscussionModelCatalog> => {
    const config = readConfig(opts.agentName);
    // 配置缺失不再静默：readAgentConfig 在文件不存在时返回 null、加载器不报错，
    // 面板上就只剩「设备未返回可用模型目录」——这正是「看起来像故障」的成因。
    // 把这个事实写进日志，运维排查时能直接看到是哪一环为空。
    if (!config) {
      opts.logger?.(
        `model catalog: ${opts.agentName} has no readable provider config; relying on CLI/static sources`,
      );
    }
    const grouped: GroupedProviders = new Map();
    // 主人设置的默认模型压过 agent CLI 自身的 default_model：前者是显式意图，
    // 后者只是兜底。finalizeCatalog 还会把它收口一次 —— 不在目录里的值当没设过，
    // 免得多米诺：provider 被删了还回传一个不存在的 route，web 的 normalizeCatalog
    // 会整包判非法，面板直接变"无可用模型"。
    let defaultModel = opts.readAgentDefaultModel?.() ?? config?.defaultModel ?? null;

    // 配置文件里**显式声明**的清单先落袋：它离线、瞬时、稳定，不依赖任何一次
    // 网络往返 —— 后面 `opencode models` 失败或端点 probe 超时都不会把它冲掉。
    // 这也是 opencode 唯一能在 web 的 8s 窗口内稳定给出目录的路子。
    // 计的是**真正进了目录**的条数（已过 ROUTE_RE 与容量上限），不是配置里的原始
    // 条数：一份全是不合法 slug 的配置不该让我们跳过 CLI 却交出空目录。
    let declaredAdded = 0;
    for (const [id, slugs] of Object.entries(config?.declaredModels ?? {})) {
      // 与 groupRoutes / mergeEndpointModels 用同一把尺子：wire 上的 provider id 与
      // model id 必须能拼成 `provider/model` 路由，否则前端既存不下也回传不了。
      // 配置是用户手写的，`"my provider": {...}` 这种 key 完全可能，不能裸推进目录。
      const valid = slugs.filter((slug) => ROUTE_RE.test(`${id}/${slug}`));
      if (valid.length === 0) continue;
      const existing = grouped.get(id);
      if (!existing && grouped.size >= MAX_PROVIDERS) continue;
      const group = existing ?? { name: id, models: new Map<string, string>() };
      for (const slug of valid) {
        if (group.models.size >= MAX_MODELS_PER_PROVIDER) break;
        if (!group.models.has(slug)) group.models.set(slug, slug);
      }
      grouped.set(id, group);
      declaredAdded += valid.length;
      opts.logger?.(
        `model catalog: ${opts.agentName} provider ${id} +${valid.length} model(s) from config`,
      );
    }

    // 配置里已经有合法清单时，CLI 照样要跑，但只给一小段预算。
    //
    // 以前这里是「有声明就整个跳过 CLI」，理由是 `opencode models` 冷启动 3–5s、
    // 超时上限 30s，会吃掉 web 的 8s 窗口。代价是**目录永远缺一块**：opencode
    // 自己列出的内置 `opencode/*` 免费模型、以及配置里没声明的 provider
    // （这台机器上是 `deepseek/*`）只存在于这条命令的输出里 —— 现场实测
    // `opencode models` = 32 条（opencode 10 / agent-plan 14 / quukk 6 /
    // deepseek 2），而面板只显示配置里那 20 条，用户看到的就是「模型列表不全」。
    //
    // 折中：跑，但把超时压到 DECLARED_CLI_TIMEOUT_MS。实测热启动 ~1.4s，4s 足够
    // 吸收抖动；真的超时/报错就退回声明清单，与旧行为等价，不会让面板变空。
    const hasDeclared = declaredAdded > 0;

    // 静态兜底（agent-model-capabilities.ts 是准入闸门：modelInjection 'none'
    // 的 agent 一律不进这里 —— 给一个选了不生效的目录比空态更糟）。它先落袋，
    // 后面的 CLI / 端点 probe 只做并集追加，永远不会把它挤掉：面板因此在
    // 「配置缺失 + CLI 失败 + probe 不通」三路全断时仍有最小可用目录。
    const capability = agentModelCapability(opts.agentName);
    const staticCatalog = capability.modelInjection === "none"
      ? null
      : staticModelCatalogFor(opts.agentName, {
        hasProviderConfig: (config?.endpoints.length ?? 0) > 0,
      });
    if (staticCatalog && staticCatalog.providers.length > 0) {
      mergeCatalogGroups(grouped, staticCatalog);
      if (!defaultModel) defaultModel = staticCatalog.defaultModel;
      opts.logger?.(
        `model catalog: ${opts.agentName} + static fallback (${staticCatalog.providers.length} provider(s))`,
      );
    }

    if (spec) {
      const label = `${opts.agentName} ${spec.argv.join(" ")}`;
      const cliTimeoutMs = hasDeclared
        ? Math.min(spec.timeoutMs, DECLARED_CLI_TIMEOUT_MS)
        : spec.timeoutMs;
      try {
        const stdout = await opts.runCommand(
          spec.argv,
          cliTimeoutMs,
          spec.maxOutputBytes,
          spec.stopWhen,
        );
        const fromCli = parseModelCatalogOutput(opts.agentName, stdout);
        // 并集而不是覆盖：同一个 provider 既在配置里声明了清单、CLI 又回报了
        // 一份时（opencode 两条路都会命中），覆盖会把配置里那份**更完整**的
        // 清单缩成 CLI 那份子集。静态兜底（上面已并入）同理不被挤掉。
        mergeCatalogGroups(grouped, fromCli);
        if (!defaultModel) defaultModel = fromCli.defaultModel;
        opts.logger?.(`model catalog: ${label} -> ${fromCli.providers.length} provider(s)`);
      } catch (err) {
        opts.logger?.(
          hasDeclared
            ? `model catalog: ${label} failed (${describe(err)}); keeping ${declaredAdded} declared model(s)`
            : `model catalog: ${label} failed: ${describe(err)}`,
        );
      }
    }

    // 配置里已经写死了模型清单的端点不再 probe：白等最多 8s（正是 web 超时窗口
    // 的元凶），而且再探一遍也只可能得到同一份清单的子集。
    const endpoints = (config?.endpoints ?? []).filter(
      (endpoint) => !config?.declaredModels?.[endpoint.id]?.length,
    );
    if (endpoints.length > 0) {
      const probed = await Promise.all(
        endpoints.map(async (endpoint) => ({ endpoint, ids: await probe(endpoint) })),
      );
      for (const { endpoint, ids } of probed) {
        if (!ids) {
          // A failed probe keeps the CLI's list: a transient outage must not
          // shrink the panel.
          opts.logger?.(
            `model catalog: ${opts.agentName} provider ${endpoint.id} unreachable at ${endpoint.baseUrl}; keeping the CLI list`,
          );
          continue;
        }
        const added = mergeEndpointModels(grouped, endpoint, ids);
        opts.logger?.(
          `model catalog: ${opts.agentName} provider ${endpoint.id} +${added} model(s) from ${endpoint.baseUrl}`,
        );
      }
    }

    return finalizeCatalog(grouped, defaultModel);
  };

  const refresh = (): Promise<DiscussionModelCatalog> => {
    if (inflight) return inflight;
    const startedAt = now();
    inflight = resolveCatalog()
      .then((catalog) => {
        cached = catalog;
        cachedAt = now();
        opts.logger?.(
          `model catalog: ${opts.agentName} -> ${catalog.providers.length} provider(s) in ${cachedAt - startedAt}ms`,
        );
        return catalog;
      })
      .catch((err: unknown) => {
        opts.logger?.(
          `model catalog refresh failed after ${now() - startedAt}ms: ${describe(err)}`,
        );
        return cached ?? EMPTY_MODEL_CATALOG;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    async load() {
      if (cached) {
        const served = cached;
        if (now() - cachedAt >= ttlMs) void refresh();
        return served;
      }
      return refresh();
    },
    warm() {
      void refresh();
    },
    // 设置默认模型之后必须让缓存失效：面板保存完会立刻重拉目录回显，5 分钟内
    // 的旧缓存会把刚写进去的值"打回去"，用户看到的就是"设了没生效"。
    invalidate() {
      cached = null;
      cachedAt = 0;
    },
  };
}
