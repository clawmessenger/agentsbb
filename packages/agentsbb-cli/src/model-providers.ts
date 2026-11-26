import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Provider-endpoint discovery for the 设备管理 → 默认模型 panel.
//
// The web only understands `provider/model` routes, so every node must report
// pairs its agent CLI will actually accept. No single source enumerates all of
// them:
//
//   * openclaw's `models list` only reports the provider's *configured* /
//     OAuth catalogue. When that provider is an OpenAI-compatible gateway
//     fronting several upstreams, the gateway's pass-through models are absent
//     from it — verified on a real machine: `openclaw models list` never
//     mentions glm/deepseek/kimi, yet the endpoint serves them and openclaw
//     runs `openai/glm-4.5` successfully.
//   * codex's `debug models` returns bare slugs with no provider prefix (and
//     they are not all runnable — `gpt-6-astra` is rejected by its ChatGPT
//     account), and hermes has no non-interactive listing command at all.
//
// What every agent does have is a configured OpenAI-compatible endpoint
// (`baseUrl` / `base_url` in its own config file), and `GET {base}/models` is
// the authoritative answer for what that endpoint serves. So we read each
// agent's config, collect its endpoints, probe them, and let model-catalog.ts
// union the result with whatever the agent's own CLI reported.

export interface ProviderEndpoint {
  id: string;
  // Human label for the panel's provider dropdown; falls back to `id`.
  name?: string;
  baseUrl: string;
  apiKey?: string;
  /** 配置里 `env_key` 声明的环境变量名（codex 0.169+ 认这个，不认 `api_key`）。
   *  探测时已经把变量值取进 `apiKey`；spawn 时设备端会按它兜底注入。 */
  envKey?: string;
  /** 配置里内联的 `Authorization` 头 token（`http_headers` 表 / 内联表）。
   *  codex 自己能带上它，设备端无需再注入。 */
  authHeader?: string;
}

export interface AgentConfig {
  endpoints: ProviderEndpoint[];
  // The agent's own configured default, as a `provider/model` route.
  defaultModel: string | null;
  /** 配置文件里**显式声明**的模型清单（provider id → slugs）。
   *  有它时不必 probe 端点：省掉 8s 超时窗口，且离线可用。 */
  declaredModels?: Record<string, string[]>;
}

export interface DiscoverOpts {
  home?: string;
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string;
  /** 当前任务工作目录，用来找项目级配置（deveco 的 `<cwd>/.deveco/`）。 */
  cwd?: string;
}

export interface ProbeOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 8_000;
const MAX_MODELS = 500;

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// --- probing ---------------------------------------------------------------

// Gateways list every model they front — embedding, rerank, TTS, vision-only
// endpoints included (quukk returns ~200 entries, a third of them unusable for
// a chat turn). Selecting one of those in 设备管理 → 默认模型 makes every later
// turn fail, so the probe drops them. Agent CLIs' own `models list` output is
// not filtered: those are models the agent itself vouches for.
const NON_CHAT_MODEL_RE =
  /(embed|rerank|bge|whisper|\btts\b|\basr\b|moderation|dall-e|stable-diffusion|inpaint|-vl\b|\bvl-|vl-chat|vision-only)/i;

function isChatModel(id: string): boolean {
  return !NON_CHAT_MODEL_RE.test(id);
}

// `GET {base}/models` — tolerate the several envelopes seen in the wild:
// OpenAI's `{data:[{id}]}`, openclaw-style `{models:[{key}]}`, and plain
// arrays. `null` means "not a model list", so callers can tell an unusable
// response from a legitimately empty one.
export function parseModelIds(body: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const ids: string[] = [];
  const pushEntry = (entry: unknown): void => {
    if (ids.length >= MAX_MODELS) return;
    if (typeof entry === "string") {
      const id = asString(entry);
      if (id !== null && isChatModel(id)) ids.push(id);
      return;
    }
    if (typeof entry !== "object" || entry === null) return;
    const record = entry as Record<string, unknown>;
    const id = asString(record.id ?? record.key ?? record.model);
    if (id !== null && isChatModel(id)) ids.push(id);
  };

  if (Array.isArray(parsed)) {
    for (const entry of parsed) pushEntry(entry);
    return ids;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : null;
  if (!list) return null;
  for (const entry of list) pushEntry(entry);
  return ids;
}

export function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

/** Probes one OpenAI-compatible endpoint. Never rejects; `null` = unusable. */
export async function probeProviderModels(
  endpoint: ProviderEndpoint,
  opts: ProbeOpts = {},
): Promise<string[] | null> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;
  const headers: Record<string, string> = { accept: "application/json" };
  if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;
  try {
    const response = await fetchImpl(modelsUrl(endpoint.baseUrl), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return parseModelIds(await response.text());
  } catch {
    return null;
  }
}

// --- minimal config readers ------------------------------------------------
// Only the handful of keys we consume is read; a full TOML/YAML parser would
// be overkill and would have to be bundled into the SEA binary.

// Drops a trailing `# comment`, ignoring hashes inside quoted strings.
function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote && line[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "#") return line.slice(0, i);
  }
  return line;
}

function unquote(value: string): string | null {
  const trimmed = value.trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(trimmed);
  if (quoted) return quoted[2].trim() === "" ? null : quoted[2];
  return /^[A-Za-z0-9_./:@-]+$/.test(trimmed) ? trimmed : null;
}

// `~/.codex/config.toml`:
//   model_provider = "<id>"
//   model          = "<slug>"
//   [model_providers.<id>]
//   base_url     = "https://llmapi.quukk.com/v1"
//   api_key      = "sk-…"                                  # ⚠️ 见下
//   env_key      = "QUUKK_API_KEY"                         # 从环境变量取
//   http_headers = { Authorization = "Bearer sk-…" }       # 内联表
//   # 或标准子表：
//   [model_providers.<id>.http_headers]
//   Authorization = "Bearer sk-…"
//
// ⚠️ codex 0.169 起**不再读 `api_key`**（启动告警 `api_key is ignored`），请求
// 于是不带 Authorization，服务端回 401「无效的令牌」。真正生效的只有
// `env_key` 和 `http_headers`（2026-11-25 在 0.172.0 上逐字段实测）。
// 三个字段都要读：`api_key` 是旧形状（也是 opencodex 之类工具会回写的形状），
// 保留它才能在这种配置下探到模型目录；`env_key` / `http_headers` 是新形状，
// 决定设备端要不要在 spawn 时兜底注入（见 planCodexCredential）。
export function parseCodexConfig(text: string, env: NodeJS.ProcessEnv = {}): AgentConfig {
  const endpoints: ProviderEndpoint[] = [];
  let activeProvider: string | null = null;
  let model: string | null = null;
  let table: string | null = null;
  // 当前是否处在 `[model_providers.<id>.http_headers]` 子表里（值为 provider id）。
  let headerTable: string | null = null;
  let current: Partial<ProviderEndpoint> & { id?: string } = {};
  // 极少数配置把 http_headers 子表写在主表前面；先攒着，flush 时再合并。
  const pendingHeaders = new Map<string, string>();
  // `api_key` 原值：子表可能出现在主表之后（最常见），那时 endpoint 已 push，
  // 凭据要重新按优先级算一遍，原值得留着。
  const rawKeys = new Map<string, string>();
  // WEB-048 复测：codex 的 `model` 不只在顶层 —— 用 profile 的机器写的是
  //   profile = "work"
  //   [profiles.work]
  //   model = "gpt-5-codex"
  // 顶层 model 为空时，目录（以及 defaultModel）要从当前 profile 里取，否则
  // 面板永远「设备模型目录 · 0」，用户连正在用的模型都看不到。
  let activeProfile: string | null = null;
  // 当前所处的 `[profiles.<name>]` 段（不在 profile 段里时为 null）。
  let profile: string | null = null;
  const profileModels = new Map<string, string>();
  const profileProviders = new Map<string, string>();

  // 探测用的 token：codex 运行时真正会带的优先（env_key 解析值 > 内联头），
  // `api_key` 只作最后兜底 —— 它是 0.169+ 被忽略的旧形状。
  const finalizeKey = (endpoint: ProviderEndpoint): void => {
    const fromEnv = endpoint.envKey ? asString(env[endpoint.envKey]) : null;
    const key = fromEnv ?? endpoint.authHeader ?? rawKeys.get(endpoint.id) ?? null;
    if (key) endpoint.apiKey = key;
    else delete endpoint.apiKey;
  };

  const setAuthHeader = (providerId: string, raw: string): void => {
    const token = normalizeBearer(rawValue(raw) ?? "");
    if (!token) return;
    const endpoint = endpoints.find((entry) => entry.id === providerId);
    if (endpoint) {
      endpoint.authHeader = token;
      finalizeKey(endpoint);
    } else {
      pendingHeaders.set(providerId, token);
    }
  };

  const flush = (): void => {
    if (current.id && asString(current.baseUrl)) {
      const id = current.id;
      const envKey = current.envKey;
      const header = current.authHeader ?? pendingHeaders.get(id) ?? null;
      pendingHeaders.delete(id);
      if (current.apiKey) rawKeys.set(id, current.apiKey);
      const endpoint: ProviderEndpoint = {
        id,
        ...(current.name ? { name: current.name } : {}),
        baseUrl: current.baseUrl as string,
        ...(envKey ? { envKey } : {}),
        ...(header ? { authHeader: header } : {}),
      };
      finalizeKey(endpoint);
      endpoints.push(endpoint);
    }
    current = {};
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      flush();
      table = header[1];
      headerTable = null;
      profile = null;
      // 子表必须先判：`[model_providers.x.http_headers]` 里的 `x.http_headers`
      // 会被下面那条 provider 正则的多余点挡掉，但显式判断更不易出错。
      const sub = /^model_providers\.(?:"([^"]+)"|([^.]+))\.http_headers$/.exec(table);
      if (sub) {
        headerTable = sub[1] ?? sub[2];
        continue;
      }
      const provider = /^model_providers\.(?:"([^"]+)"|([^.]+))$/.exec(table);
      if (provider) current.id = provider[1] ?? provider[2];
      // `[profiles.<name>]`：只收「这个 profile 用哪个模型」，不产生端点。
      const profileTable = /^profiles\.(?:"([^"]+)"|([^.]+))$/.exec(table);
      if (profileTable) profile = profileTable[1] ?? profileTable[2];
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    if (table === null) {
      const value = unquote(kv[2]);
      if (kv[1] === "model_provider") activeProvider = value;
      else if (kv[1] === "model") model = value;
      else if (kv[1] === "profile") activeProfile = value;
      continue;
    }
    if (profile !== null) {
      // profile 段里只关心这两个键；其它（如 approval_policy）与模型目录无关。
      const value = unquote(kv[2]);
      if (kv[1] === "model" && value) profileModels.set(profile, value);
      else if (kv[1] === "model_provider" && value) profileProviders.set(profile, value);
      continue;
    }
    if (headerTable !== null) {
      if (kv[1].toLowerCase() === "authorization") setAuthHeader(headerTable, kv[2]);
      continue;
    }
    if (!current.id) continue;
    const value = unquote(kv[2]);
    if (kv[1] === "base_url" || kv[1] === "baseUrl") current.baseUrl = value ?? undefined;
    else if (kv[1] === "name") current.name = value ?? undefined;
    else if (kv[1] === "api_key" || kv[1] === "apiKey") current.apiKey = value ?? undefined;
    else if (kv[1] === "env_key" || kv[1] === "envKey") current.envKey = value ?? undefined;
    else if (kv[1] === "http_headers") {
      // 内联表：`{ Authorization = "Bearer sk-…", X-Foo = "bar" }`
      const auth = /(?:^|[{,\s])["']?authorization["']?\s*=\s*(.+?)\s*(?:[,}]|$)/i.exec(kv[2]);
      if (auth) setAuthHeader(current.id, auth[1]);
    }
  }
  flush();

  // 顶层没写 model 时用当前 profile（没指定 profile 且只有一个带 model 的
  // profile 时就用它 —— 那种配置只可能是在说这一个）。
  let effectiveModel = model;
  let effectiveProvider = activeProvider;
  if (!effectiveModel) {
    const picked = activeProfile && profileModels.get(activeProfile)
      ? activeProfile
      : (profileModels.size === 1 ? [...profileModels.keys()][0] : null);
    if (picked) {
      effectiveModel = profileModels.get(picked) ?? null;
      effectiveProvider = effectiveProvider ?? profileProviders.get(picked) ?? null;
    }
  }
  const provider = effectiveProvider ?? endpoints[0]?.id ?? null;
  // WEB-048：把配置里 `model = "<slug>"` 这一条也当成「设备已知的模型」交给
  // 目录。它一定跑得起来（这就是 codex 此刻正在用的模型），而此前目录只由
  // 端点 probe 产生 —— 用 ChatGPT 账号登录、没写 `[model_providers.*]` 的
  // 机器 probe 无从下手，面板上就是「设备模型目录 · 0」，用户连当前用的模型
  // 都看不到、更选不了。
  //
  // provider 兜底 "openai"：codex 的内置默认 provider id 就是它（OAuth 登录
  // 走的正是这条），注入 `-c model_provider=openai -m <slug>` 与不注入等价。
  const declaredProvider = provider ?? "openai";
  return {
    endpoints,
    defaultModel: provider && effectiveModel ? `${provider}/${effectiveModel}` : (effectiveModel ? `${declaredProvider}/${effectiveModel}` : null),
    ...(effectiveModel ? { declaredModels: { [declaredProvider]: [effectiveModel] } } : {}),
  };
}

/** 取出 TOML 值的字面量：允许引号内含空格（`"Bearer sk-…"`），裸值原样返回。 */
function rawValue(value: string): string | null {
  const trimmed = value.trim().replace(/[,}]$/, "").trim();
  if (trimmed === "") return null;
  const quoted = /^(['"])([\s\S]*)\1$/.exec(trimmed);
  if (quoted) return quoted[2].trim() === "" ? null : quoted[2].trim();
  return trimmed;
}

/** `"Bearer sk-…"` → `sk-…`；已经是裸 token 时原样返回。 */
function normalizeBearer(value: string): string | null {
  const token = value.replace(/^bearer\s+/i, "").trim();
  return token === "" ? null : token;
}

/** 设备端给 codex 注入凭据时用的环境变量名（配置里没有 `env_key` 的情况）。 */
export const CODEX_INJECTED_ENV_KEY = "AGENTSBB_CODEX_API_KEY";

export interface CodexCredentialPlan {
  /** 实际要用的 provider id。 */
  provider: string;
  /** 密钥写进哪个环境变量（配置声明了 `env_key` 就沿用它，否则用内置名）。 */
  envKey: string;
  apiKey: string;
  /** true = 配置里没有 `env_key`，argv 需补 `-c model_providers.<id>.env_key=…`。 */
  needsConfigOverride: boolean;
  /** 需要追加到 codex argv 的参数（不需要时为空数组）。 */
  args: string[];
}

/**
 * 决定 spawn codex 前要不要补凭据。
 *
 * codex 0.169+ 忽略 `api_key`，只认 `env_key` / `http_headers`。设备端改不了
 * 用户配置文件，但可以在**子进程层面**补上：把密钥放进环境变量，再用
 * `-c` 让 codex 去读那个变量。密钥只走环境、不进命令行（`ps` 看不到）。
 *
 * 返回 null 的三种情况都是「codex 自己能行，别插手」：
 *   有内联 Authorization 头、配置的 `env_key` 在真实环境里有值、端点没有密钥。
 */
export function planCodexCredential(
  config: AgentConfig | null | undefined,
  opts: { provider?: string | null; env?: NodeJS.ProcessEnv } = {},
): CodexCredentialPlan | null {
  if (!config || config.endpoints.length === 0) return null;
  const wanted = opts.provider ?? null;
  const endpoint = wanted
    ? config.endpoints.find((entry) => entry.id === wanted) ?? null
    : config.endpoints.find((entry) => entry.apiKey) ?? config.endpoints[0] ?? null;
  if (!endpoint?.apiKey) return null;
  if (endpoint.authHeader) return null;
  const env = opts.env ?? process.env;
  if (endpoint.envKey && asString(env[endpoint.envKey])) return null;
  const envKey = endpoint.envKey ?? CODEX_INJECTED_ENV_KEY;
  const needsConfigOverride = !endpoint.envKey;
  return {
    provider: endpoint.id,
    envKey,
    apiKey: endpoint.apiKey,
    needsConfigOverride,
    args: needsConfigOverride
      ? ["-c", `model_providers.${endpoint.id}.env_key="${envKey}"`]
      : [],
  };
}

// `~/AppData/Local/hermes/config.yaml` (or `~/.hermes/config.yaml`):
//   custom_providers:
//     - name: quukk
//       base_url: https://llmapi.quukk.com/v1
//       api_key: sk-...
//   model:
//     default: glm-5.3
//     provider: quukk
export function parseHermesConfig(text: string): AgentConfig {
  const endpoints: ProviderEndpoint[] = [];
  let current: Partial<ProviderEndpoint> & { id?: string } = {};
  let provider: string | null = null;
  let model: string | null = null;
  let section: "custom_providers" | "model" | null = null;
  let sectionIndent = -1;

  const flush = (): void => {
    if (current.id && asString(current.baseUrl)) {
      endpoints.push({
        id: current.id,
        ...(current.name ? { name: current.name } : {}),
        baseUrl: current.baseUrl as string,
        ...(current.apiKey ? { apiKey: current.apiKey } : {}),
      });
    }
    current = {};
  };

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    if (section !== null && indent <= sectionIndent) {
      flush();
      section = null;
    }
    if (section === null) {
      if (/^custom_providers\s*:/.test(line)) {
        section = "custom_providers";
        sectionIndent = indent;
      } else if (/^model\s*:/.test(line)) {
        section = "model";
        sectionIndent = indent;
      }
      continue;
    }
    const item = /^-\s*(.*)$/.exec(line);
    if (section === "custom_providers") {
      if (item) {
        flush();
        const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(item[1]);
        if (kv) applyHermesEntry(current, kv[1], kv[2]);
        continue;
      }
      const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
      if (kv) applyHermesEntry(current, kv[1], kv[2]);
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[1] === "provider") provider = unquote(kv[2]);
    else if (kv[1] === "default") model = unquote(kv[2]);
  }
  flush();

  return {
    endpoints,
    defaultModel: provider && model ? `${provider}/${model}` : null,
  };
}

function applyHermesEntry(
  target: Partial<ProviderEndpoint> & { id?: string },
  key: string,
  rawValue: string,
): void {
  const value = unquote(rawValue);
  if (!value) return;
  if (key === "name") {
    // hermes' `--provider <name>` uses this same slug, so it doubles as the id.
    target.id = value;
    target.name = value;
  } else if (key === "base_url" || key === "baseUrl") target.baseUrl = value;
  else if (key === "api_key" || key === "apiKey") target.apiKey = value;
}

// `~/.openclaw/openclaw.json`: models.providers.<id>.{baseUrl,apiKey,name}.
// The configured default lives in the model list (`tags: ["default"]`), not
// here, so `defaultModel` stays null and the loader fills it from the CLI.
export function parseOpenclawConfig(text: string): AgentConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { endpoints: [], defaultModel: null };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { endpoints: [], defaultModel: null };
  }
  const providers = (parsed as { models?: { providers?: unknown } }).models?.providers;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
    return { endpoints: [], defaultModel: null };
  }
  const endpoints: ProviderEndpoint[] = [];
  for (const [id, value] of Object.entries(providers as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    const baseUrl = asString(record.baseUrl ?? record.base_url);
    if (!baseUrl) continue;
    const name = asString(record.name);
    const apiKey = asString(record.apiKey ?? record.api_key);
    endpoints.push({ id, ...(name ? { name } : {}), baseUrl, ...(apiKey ? { apiKey } : {}) });
  }
  const configuredDefault = asString(
    (parsed as { models?: { default?: unknown } }).models?.default,
  );
  return {
    endpoints,
    defaultModel: configuredDefault && configuredDefault.includes("/") ? configuredDefault : null,
  };
}

// Derives the provider id the web panel shows from the endpoint host, so a
// gateway like `llmapi.quukk.com` presents as `quukk` instead of a generic
// `openai` bucket. Unusable hosts (bare `com`, `localhost`) fall back.
function providerIdFromBaseUrl(baseUrl: string, fallback: string): string {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return fallback;
  }
  const labels = host
    .split(".")
    .filter((label) => label !== "" && !/^(www|api|llmapi|gateway|openai|v1)$/i.test(label));
  const first = labels[0];
  if (!first || /^(com|cn|net|org|io|ai|local|localhost)$/i.test(first)) return fallback;
  const slug = first.replace(/[^A-Za-z0-9._-]/g, "");
  return slug === "" ? fallback : slug;
}

// `~/.qwen/settings.json` — qwen-code 的鉴权走 `security.auth.selectedType`，
// 端点与密钥放在 `env` 里（实测 `OPENAI_BASE_URL` / `OPENAI_API_KEY` /
// `OPENAI_MODEL` 三项生效；qwen 自己没有可枚举模型目录的子命令）。
export function parseQwenConfig(text: string): AgentConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { endpoints: [], defaultModel: null };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { endpoints: [], defaultModel: null };
  }
  const record = parsed as Record<string, unknown>;
  const env = (typeof record.env === "object" && record.env !== null
    ? record.env
    : {}) as Record<string, unknown>;
  const baseUrl = asString(env.OPENAI_BASE_URL ?? env.OPENAI_API_BASE);
  if (!baseUrl) return { endpoints: [], defaultModel: null };
  const apiKey = asString(env.OPENAI_API_KEY ?? env.OPENAI_KEY);
  const id = providerIdFromBaseUrl(baseUrl, "openai");
  const modelField = record.model;
  const model = asString(env.OPENAI_MODEL ?? env.QWEN_MODEL)
    ?? (typeof modelField === "object" && modelField !== null
      ? asString((modelField as Record<string, unknown>).name)
      : asString(modelField));
  return {
    endpoints: [{ id, baseUrl, ...(apiKey ? { apiKey } : {}) }],
    defaultModel: model ? `${id}/${model}` : null,
  };
}

// `~/.codebuddy/agentsbb-provider.json` — codebuddy 自己的 settings.json
// 只认 `custom-local:<m>`（走 WorkBuddy 托管通道，有周/月限额），且这个 build
// 丢掉了 ANTHROPIC_BASE_URL 支持，唯一可直连自建网关的入口是环境变量
// `CODEBUDDY_BASE_URL`（OpenAI 兼容，实测 `/v1/chat/completions`）。
// 所以端点写在这份独立文件里：model-providers 用它 probe 模型目录，
// agents.ts 用同一份文件给子进程注入 CODEBUDDY_* 环境变量。
//
//   { "provider": "quukk", "baseUrl": "https://llmapi.quukk.com/v1",
//     "apiKey": "sk-…", "defaultModel": "glm-5.2" }
export function parseCodebuddyProviderConfig(text: string): AgentConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { endpoints: [], defaultModel: null };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { endpoints: [], defaultModel: null };
  }
  const record = parsed as Record<string, unknown>;
  const baseUrl = asString(record.baseUrl ?? record.base_url);
  if (!baseUrl) return { endpoints: [], defaultModel: null };
  const apiKey = asString(record.apiKey ?? record.api_key);
  const id = asString(record.provider) ?? providerIdFromBaseUrl(baseUrl, "codebuddy");
  const name = asString(record.name);
  const model = asString(record.defaultModel ?? record.default_model ?? record.model);
  return {
    endpoints: [{ id, ...(name ? { name } : {}), baseUrl, ...(apiKey ? { apiKey } : {}) }],
    defaultModel: model ? `${id}/${model}` : null,
  };
}

// `~/.config/opencode/opencode.json`（或 `.jsonc`）—— opencode 的配置天生允许
// 注释，真实的 `.jsonc` 就带 `//`，所以先剥注释再交给 JSON.parse。剥注释时
// **必须跳过字符串字面量内部**：`"baseURL": "https://…"` 里的 `//` 一旦被当成
// 行注释，整个 baseURL 连同后面半份配置都会被吞掉（provider 全都消失）。
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === "\\") {
        // 转义序列整体照抄，`\"` 不能被当成字符串结束。
        if (i + 1 < text.length) {
          out += text[i + 1];
          i += 1;
        }
        continue;
      }
      if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      // 用换行替换注释，避免把前后两个 token 粘在一起。
      out += "\n";
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1; // 落在 `/` 上，for 的 i += 1 越过它
      continue;
    }
    out += char;
  }
  return out;
}

// `~/.config/opencode/opencode.json` —— opencode 与上面几个 agent 不同：它把
// **模型清单本身**写进配置（`provider.<id>.models` 的 key 就是 slug），所以
// 这里除了端点，还能直接交出 `declaredModels`：离线、瞬时、不赌 8s 窗口。
//
//   { "model": "quukk/glm-5.2",            ← 默认路由，本来就是 provider/model
//     "provider": {
//       "quukk": { "name": "Quukk AI",
//                  "options": { "baseURL": "https://…/v1", "apiKey": "sk-…" },
//                  "models": { "glm-5.2": {…}, "k3": {…} } } } }
//
// 注意 key 的大小写：baseURL / apiKey 是驼峰，别写成 baseUrl。
//
// 2026-11-16 现场教训（小久，opencode 2.1.4）：opencode 有**两代配置格式** ——
//   V1（opencode 1.x）：`provider`（单数）+ `npm` + `options`（baseURL/apiKey）
//   V2（opencode 2.x）：`providers`（复数）+ `package` + `settings`
// 两个键在官方 config schema 里并存，但**运行时只认自己那一代**：V1 引擎读到
// `providers` 段会打 WARN「Omitted native setting that cannot be represented
// in V1」后整段丢弃；V2 引擎则保留旧 `provider` 的迁移逻辑。解析器两代都收，
// 同 id 并存时 V2 条目整体优先（与上游 v2 规范化行为一致），保证不管设备装的是
// 哪一代 opencode，目录都不会丢供应商。
export function parseOpencodeConfig(text: string): AgentConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = JSON.parse(stripJsonComments(text));
    } catch {
      return { endpoints: [], defaultModel: null };
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { endpoints: [], defaultModel: null };
  }
  const record = parsed as Record<string, unknown>;
  const endpoints: ProviderEndpoint[] = [];
  const declaredModels: Record<string, string[]> = {};

  // 把一个 provider 条目收进 endpoints / declaredModels。settingsOrOptions 是
  // 两代格式的端点配置（V1 options / V2 settings，字段同名 baseURL/apiKey）。
  const collect = (
    id: string,
    provider: Record<string, unknown>,
    settingsOrOptions: Record<string, unknown>,
  ): void => {
    const name = asString(provider.name);
    const baseUrl = asString(
      settingsOrOptions.baseURL ?? settingsOrOptions.baseUrl ?? settingsOrOptions.base_url,
    );
    const apiKey = asString(settingsOrOptions.apiKey ?? settingsOrOptions.api_key);
    if (baseUrl) {
      endpoints.push({ id, ...(name ? { name } : {}), baseUrl, ...(apiKey ? { apiKey } : {}) });
    }
    const models = provider.models;
    if (typeof models !== "object" || models === null || Array.isArray(models)) return;
    const slugs: string[] = [];
    for (const rawSlug of Object.keys(models as Record<string, unknown>)) {
      const slug = asString(rawSlug);
      if (!slug || slugs.includes(slug)) continue;
      slugs.push(slug);
    }
    if (slugs.length > 0) declaredModels[id] = slugs;
  };

  // V1：`provider.<id>.options`。
  const v1 = record.provider;
  if (typeof v1 === "object" && v1 !== null && !Array.isArray(v1)) {
    for (const [rawId, value] of Object.entries(v1 as Record<string, unknown>)) {
      // provider 的 key 就是 id（`provider.<id>.name` 只是展示名）。
      const id = asString(rawId);
      if (!id) continue;
      if (typeof value !== "object" || value === null) continue;
      const provider = value as Record<string, unknown>;
      const options = (typeof provider.options === "object" && provider.options !== null
        ? provider.options
        : {}) as Record<string, unknown>;
      collect(id, provider, options);
    }
  }

  // V2：`providers.<id>.settings`。同 id 时整体覆盖 V1 条目（endpoints 先删后
  // 加；declaredModels 直接覆盖）。
  const v2 = record.providers;
  if (typeof v2 === "object" && v2 !== null && !Array.isArray(v2)) {
    for (const [rawId, value] of Object.entries(v2 as Record<string, unknown>)) {
      const id = asString(rawId);
      if (!id) continue;
      if (typeof value !== "object" || value === null) continue;
      const provider = value as Record<string, unknown>;
      const settings = (typeof provider.settings === "object" && provider.settings !== null
        ? provider.settings
        : {}) as Record<string, unknown>;
      // V2 优先：同 id 的 V1 条目先挤掉再收 V2 的（declaredModels 的覆盖在
      // collect 里天然成立）。
      for (let i = endpoints.length - 1; i >= 0; i--) {
        if (endpoints[i].id === id) endpoints.splice(i, 1);
      }
      collect(id, provider, settings);
    }
  }

  return {
    endpoints,
    // 顶层 `model` 本来就是 `provider/model` 路由，原样返回，不要重新拼。
    defaultModel: asString(record.model),
    ...(Object.keys(declaredModels).length > 0 ? { declaredModels } : {}),
  };
}

/**
 * mcode（MiniMax Code）的 `~/.minimax/config.yaml` 解析（2026-11-17 真机）。
 *
 * 配置是 opencode 血统的 YAML，但没有 JSON 解析器可用（本包无 yaml 依赖），
 * 这里按缩进手写解析。关心的三层：
 *   `provider.<id>.options.{baseURL,apiKey}`  → endpoint
 *   `provider.<id>.models` 下的键              → declaredModels[id]
 *   `custom_provider.<id>`                     → 同上（自定义网关，本机 quukkai 就是）
 *   `defaultModel: custom_provider:quukkai/glm-5.2` → 转成 `quukkai/glm-5.2`
 *
 * `custom_provider:` 前缀是 mcode 的内部命名空间，不是 wire 路由的一部分；
 * 面板与 `-m provider/model` 都只认 `quukkai/glm-5.2`，必须剥掉。
 */
export function parseMcodeConfig(text: string): AgentConfig {
  const endpoints: ProviderEndpoint[] = [];
  const declaredModels: Record<string, string[]> = {};
  let defaultModel: string | null = null;
  // 当前 provider 块：namespace 为 provider / custom_provider，id 为 provider 名。
  let namespace: string | null = null;
  let providerId: string | null = null;
  let section: "options" | "models" | null = null;
  let sectionIndent = -1;

  const flush = (): void => {
    // 端点在 options 段收集，这里只负责清空状态。
    providerId = null;
    section = null;
    sectionIndent = -1;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;

    // 顶层 defaultModel / provider: / custom_provider:
    if (indent === 0) {
      flush();
      namespace = null;
      const dm = /^defaultModel\s*:\s*(\S+)\s*$/.exec(trimmed);
      if (dm) {
        const raw = dm[1].replace(/^["']|["']$/g, "");
        // `custom_provider:quukkai/glm-5.2` → `quukkai/glm-5.2`
        defaultModel = raw.replace(/^custom_provider:/, "");
        continue;
      }
      if (/^provider\s*:\s*$/.test(trimmed)) { namespace = "provider"; continue; }
      if (/^custom_provider\s*:\s*$/.test(trimmed)) { namespace = "custom_provider"; continue; }
      namespace = null;
      continue;
    }

    // provider 块下的 id（缩进 2）：`  quukkai:`
    if (namespace && indent === 2) {
      flush();
      const idMatch = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*:\s*$/.exec(trimmed);
      providerId = idMatch ? idMatch[1] : null;
      section = null;
      continue;
    }

    if (!namespace || !providerId) continue;

    // options / models 段头（缩进 4）
    if (indent === 4) {
      if (/^options\s*:\s*$/.test(trimmed)) { section = "options"; sectionIndent = 4; continue; }
      if (/^models\s*:\s*$/.test(trimmed)) { section = "models"; sectionIndent = 4; continue; }
      section = null;
    }

    // options 段的 baseURL / apiKey（缩进 6）
    if (section === "options" && indent > sectionIndent) {
      const key = /^(baseURL|baseUrl|base_url|apiKey|api_key)\s*:\s*(\S+)\s*$/.exec(trimmed);
      if (key) {
        const value = key[2].replace(/^["']|["']$/g, "");
        const existing = endpoints.find((e) => e.id === providerId);
        if (key[1].toLowerCase().startsWith("baseurl")) {
          if (existing) existing.baseUrl = value;
          else endpoints.push({ id: providerId, baseUrl: value });
        } else if (existing) {
          existing.apiKey = value;
        } else {
          endpoints.push({ id: providerId, baseUrl: "", apiKey: value });
        }
      }
      continue;
    }

    // models 段的模型名：**严格缩进 6**（`provider.<id>.models.<name>`）。
    // 缩进 8+ 是模型的子键（limit / modalities / thinking_config / variants…），
    // 用 `indent > sectionIndent` 会把它们误当模型 —— 面板出现
    // `quukkai/thinking_config` 这种假条目。必须锁死层级。
    if (section === "models" && indent === 6) {
      const modelMatch = /^([A-Za-z0-9][A-Za-z0-9._:-]*)\s*:\s*$/.exec(trimmed);
      if (modelMatch) {
        const slug = modelMatch[1];
        const list = declaredModels[providerId] ?? [];
        if (!list.includes(slug)) list.push(slug);
        declaredModels[providerId] = list;
      }
    }
  }

  // 丢掉没有 baseUrl 的残项（apiKey-only 的半截 provider 不能当端点用）。
  const usable = endpoints.filter((e) => e.baseUrl);
  return {
    endpoints: usable,
    defaultModel,
    ...(Object.keys(declaredModels).length > 0 ? { declaredModels } : {}),
  };
}

// --- per-agent wiring ------------------------------------------------------

const AGENT_CONFIG_PARSERS: Readonly<
  Record<string, (text: string, env?: NodeJS.ProcessEnv) => AgentConfig>
> = {
  openclaw: parseOpenclawConfig,
  codex: parseCodexConfig,
  hermes: parseHermesConfig,
  qwen: parseQwenConfig,
  codebuddy: parseCodebuddyProviderConfig,
  opencode: parseOpencodeConfig,
  // codearts / deveco 都是 opencode 血统：`provider.<id>.options.baseURL` +
  // `provider.<id>.models`，parseOpencodeConfig 直接吃得下。deveco 的官方用户
  // 配置在 `~/.config/deveco/deveco.jsonc`（Windows 同路径），见 configPaths。
  codearts: parseOpencodeConfig,
  deveco: parseOpencodeConfig,
  mcode: parseMcodeConfig,
};

function configPaths(
  agentName: string,
  home: string,
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): string[] {
  if (agentName === "openclaw") return [join(home, ".openclaw", "openclaw.json")];
  if (agentName === "codex") {
    const codexHome = env.CODEX_HOME ?? join(home, ".codex");
    return [join(codexHome, "config.toml")];
  }
  if (agentName === "hermes") {
    const candidates: string[] = [];
    if (env.HERMES_CONFIG) candidates.push(env.HERMES_CONFIG);
    if (env.HERMES_HOME) candidates.push(join(env.HERMES_HOME, "config.yaml"));
    if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, "hermes", "config.yaml"));
    candidates.push(join(home, ".hermes", "config.yaml"));
    candidates.push(join(home, ".config", "hermes", "config.yaml"));
    return candidates;
  }
  if (agentName === "qwen") {
    const candidates: string[] = [];
    if (env.QWEN_HOME) candidates.push(join(env.QWEN_HOME, "settings.json"));
    candidates.push(join(home, ".qwen", "settings.json"));
    return candidates;
  }
  if (agentName === "codebuddy") {
    // AGENTSBB_CODEBUDDY_PROVIDER lets a machine point at a second gateway
    // without editing the shared profile.
    const candidates: string[] = [];
    // TODO(rebrand-retire): 双读过渡，移除 CLAWMESSENGER_CODEBUDDY_PROVIDER 于 v1.6+
    if (env.AGENTSBB_CODEBUDDY_PROVIDER ?? env.CLAWMESSENGER_CODEBUDDY_PROVIDER) {
      candidates.push((env.AGENTSBB_CODEBUDDY_PROVIDER ?? env.CLAWMESSENGER_CODEBUDDY_PROVIDER) as string);
    }
    // 新文件名优先；旧名文件（改名前落盘的）继续兜底。
    // TODO(rebrand-retire): 旧文件名移除于 v1.6+
    candidates.push(join(home, ".codebuddy", "agentsbb-provider.json"));
    candidates.push(join(home, ".codebuddy", "clawmessenger-provider.json"));
    return candidates;
  }
  if (agentName === "opencode") {
    // opencode 自己按 XDG 找配置；Windows 上 XDG_CONFIG_HOME 通常缺失，所以
    // 无条件再补一条 ~/.config（opencode 自身也是这么回落的）。
    const candidates: string[] = [];
    // TODO(rebrand-retire): 双读过渡，移除 CLAWMESSENGER_OPENCODE_CONFIG 于 v1.6+
    const opencodeConfig = env.AGENTSBB_OPENCODE_CONFIG ?? env.CLAWMESSENGER_OPENCODE_CONFIG;
    if (opencodeConfig) candidates.push(opencodeConfig);
    const xdg = env.XDG_CONFIG_HOME;
    if (xdg) {
      candidates.push(join(xdg, "opencode", "opencode.json"));
      candidates.push(join(xdg, "opencode", "opencode.jsonc"));
    }
    candidates.push(join(home, ".config", "opencode", "opencode.json"));
    candidates.push(join(home, ".config", "opencode", "opencode.jsonc"));
    return candidates;
  }
  // codearts（华为 CodeArts Doer）：官方 launcher 的 OPENCODE_CONFIG 指向
  // ~/.codeartsdoer/codearts_cli.json（opencode 血统，provider.models 里就是
  // 已配置目录）。设备端之前没 parser 也没路径，面板一直空态。
  if (agentName === "codearts") {
    const candidates: string[] = [];
    if (env.OPENCODE_CONFIG) candidates.push(env.OPENCODE_CONFIG);
    candidates.push(join(home, ".codeartsdoer", "codearts_cli.json"));
    return candidates;
  }
  // deveco（华为 DevEco Code）：同为 opencode 血统，但官方用户级配置路径是
  // `~/.config/deveco/deveco.jsonc`（Windows 同样是 `<用户目录>/.config/deveco/`，
  // 鸿蒙电脑才是 `~/.deveco/deveco.jsonc`）；项目级是 `<cwd>/.deveco/deveco.jsonc`。
  // 1.3.47 只猜了 `~/.deveco/deveco.json[.jsonc]`，在 Windows 上永远读不到，
  // 于是 CLI 列举为空时面板仍然是「暂未开放模型选择」。这里按官方优先级补齐。
  if (agentName === "deveco") {
    const candidates: string[] = [];
    if (env.DEVECO_CONFIG) candidates.push(env.DEVECO_CONFIG);
    // 项目级优先于用户级（DevEco 官方优先级）：同一台机器不同工程挂不同模型时，
    // 面板必须显示当前工程实际会用的那一份。
    if (cwd) {
      candidates.push(join(cwd, ".deveco", "deveco.jsonc"));
      candidates.push(join(cwd, ".deveco", "deveco.json"));
    }
    const xdg = env.XDG_CONFIG_HOME;
    if (xdg) {
      candidates.push(join(xdg, "deveco", "deveco.jsonc"));
      candidates.push(join(xdg, "deveco", "deveco.json"));
    }
    candidates.push(join(home, ".config", "deveco", "deveco.jsonc"));
    candidates.push(join(home, ".config", "deveco", "deveco.json"));
    candidates.push(join(home, ".deveco", "deveco.jsonc"));
    candidates.push(join(home, ".deveco", "deveco.json"));
    return candidates;
  }
  // mcode（MiniMax Code）：~/.minimax/config.yaml，provider + custom_provider
  // 两段都可能有网关；defaultModel 用 `custom_provider:<id>/<slug>` 记法。
  if (agentName === "mcode") {
    const candidates: string[] = [];
    if (env.MCODE_CONFIG) candidates.push(env.MCODE_CONFIG);
    candidates.push(join(home, ".minimax", "config.yaml"));
    return candidates;
  }
  return [];
}

/**
 * 找出 opencode 实际会读的那份配置文件（第一个存在的候选）。
 *
 * 只给「派生设备端精简配置」用 —— 原文件必须原样不动：里面可能有用户自己
 * 维护的 plugin / MCP，删掉会改变他交互使用 opencode 的体验。
 */
export function discoverOpencodeConfigPath(opts: DiscoverOpts = {}): string | null {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const readFile = opts.readFile ?? defaultReadFile;
  for (const path of configPaths("opencode", home, env, opts.cwd)) {
    try {
      readFile(path);
      return path;
    } catch {
      continue;
    }
  }
  return null;
}

export interface DeviceOpencodeConfigOpts {
  /**
   * 「文件读写禁止」限制态（见 agent-permissions.ts fsRestriction）。
   *
   * 为什么把键写进配置而不是加命令行参数：opencode 没有「禁用工具」的 CLI 参数，
   * 工具授权只在配置里。写入两套键是为了同时覆盖 1.x 与 2.x：
   *   · `permission`（1.x 起就有，2.x 仍接受，schema 里标 deprecated 但保留）
   *     —— `edit` / `bash` 等工具级的 allow|ask|deny；
   *   · `tools`（更老的版本只认这个）—— 工具名 → 布尔开关。
   * 两套都写、语义一致，任一版本生效即可，不必猜版本。
   */
  fsRestricted?: boolean;
  /**
   * 追加到 `instructions` 的行为规范文件路径（不存在就不传）。
   *
   * opencode 的 `instructions` 是「补充环境指令」的路径数组（schema:
   * `instructions: string[]`），正好是「指令层」而不是用户消息层。
   */
  instructions?: string[];
  /**
   * 「精简回合」：把 `build` agent 的系统提示换掉、工具全关，用于角色推荐这类
   * 「问一句、拿一段 JSON」的短回合。
   *
   * 为什么要动这一层（2026-11-12 实测，quukk/glm-5.2，同一条推荐提示词）：
   *   · 默认 build agent：输入 **29,397 token**、单轮 21~28s；
   *   · 关掉工具：22,316 token；
   *   · 换掉系统提示 + 关掉全部工具：**1,722 token**、单轮 13~18s。
   * 那 2.8 万 token 与推荐毫无关系（build 的系统提示 + 15 个工具定义 + 技能清单），
   * 却要在每一轮里重新 prefill 一遍 —— 上游网关越慢，这笔开销越大，最后撞上
   * 服务端 60s 的等待窗口，用户看到的就是「推荐超时」。
   *
   * 只写 `agent.build` 而不新增 agent 名：serve 的 message 接口给 `agent` 传参
   * 需要 2.x 协议配合，而配置里覆盖 build 是 1.x/2.x 通吃的（本地 1.19.4 实测
   * `agent.build.prompt` + `tools:{"*":false}` 生效）。精简配置走**独立文件**
   * （见 deviceOpencodeConfigPath 的 lean 参数），聊天轮次那份配置不受影响。
   */
  lean?: boolean;
  /**
   * 「发言回合」的提示精简：**只替换** `build` 的系统提示，工具照旧可用。
   *
   * 与 `lean` 的区别是分寸：`lean` 是给「问一句、拿一段 JSON」的推荐回合用的，
   * 连工具一起关掉；`terse` 给讨论组/群聊的发言回合用 —— 那里 agent 仍然要能
   * 读写文件、跑命令（用户在群里让它干活是正常用法），所以只砍提示、不砍工具。
   *
   * 为什么值得单独做（2026-11-24 实测，quukk/glm-5.2）：
   *   · 裸问一句「什么是 HTTP」，输入 17 token，思考量 3,255 字符、出正文 13.5s；
   *   · 讨论组真实回合（输入约 2.9 万 token）思考量上万字符，单轮耗时中位 70s。
   * 也就是说耗时 ≈ prefill(输入 token) + 输出(思考+正文)，而 build 那套系统提示
   * （约 1.9 万 token 的工具规范与技能清单）与「按角色说一段话」毫无关系，却每轮
   * 都要重新 prefill，并且诱导模型长篇展开。换掉它，工具不动，能力不降。
   */
  terse?: boolean;
  /**
   * 禁用 opencode 的原生 question / ask_user 交互工具。
   *
   * 设备端是 headless serve，没有 TUI 去接这两种工具的弹窗；模型一旦调用就会
   * 永远挂在 `running`，整轮不产出正文（2026-11-26 现场：单聊里模型问「三选
   * 一」，卡片一直转圈直到设备端停滞提示）。替代方案是行为指令里的
   * `[interaction:question]` 文本标记——CLI 收到后发可点击卡片，用户选择作为
   * 新一轮用户输入续流。两套工具键位都写，兼容 1.x/2.x。
   */
  noInteractiveTools?: boolean;
}

/** 精简回合的 `build` agent：只输出用户要的 JSON，零工具、零寒暄。 */
export const LEAN_AGENT_SYSTEM_PROMPT =
  "你是角色推荐器：不要使用任何工具，不要分析或解释，直接输出用户要求的 JSON 对象。";

/**
 * 发言回合（讨论组/群聊/聊天室）的 `build` 系统提示。
 *
 * 三条要求都对着实测过的病灶：
 *   1. 不复述指令 —— 服务端拼的 role_prompt 已经很长，模型照着念一遍就是纯浪费；
 *   2. 不先描述再动手 —— 讨论场景里"我准备先查一下…"这类宣告会先产出一大段
 *      与结论无关的正文，用户看到的就是"说了半天没干货"；
 *   3. 给篇幅上限 —— 没有上限时 GLM 会写到被 max_tokens 截断（实测「正文 2 字」
 *      的回合就是这么来的）。
 */
export const TERSE_AGENT_SYSTEM_PROMPT =
  "你是这场对话中的一位参与者。直接给出你的观点与论证，不要客套、不要复述用户的话或上面的指令，"
  + "不要先宣告你打算做什么。需要调用工具时直接调用。回答控制在 300 字以内，除非用户明确要求更长。";

// 文件读写限制态要关掉的工具。`read`/`glob`/`grep`/`list` 是读，`edit`/`write`/
// `patch` 是写；`bash` 既能读也能写，一并关掉 —— 否则「禁了文件工具但留一个
// shell」等于没禁。`task`（子 agent）也关：子 agent 会重新拿到全套工具。
const FS_DENY_PERMISSION: Readonly<Record<string, string>> = {
  read: "deny",
  edit: "deny",
  glob: "deny",
  grep: "deny",
  list: "deny",
  bash: "deny",
  task: "deny",
  external_directory: "deny",
  webfetch: "deny",
  websearch: "deny",
};

const FS_DENY_TOOLS: Readonly<Record<string, boolean>> = {
  read: false,
  write: false,
  edit: false,
  patch: false,
  bash: false,
  glob: false,
  grep: false,
  list: false,
  webfetch: false,
};

/**
 * 从用户的 opencode 配置派生出「设备端专用」精简版：去掉 `plugin` 与 `mcp`，
 * 再按权限快照写入限制/指令。
 *
 * 为什么要这么做（2026-10-26 实测）：那两段里的 `superpowers@git+https://…`
 * 插件与 `uvx --from git+https://…` 的 MCP，会让 `opencode run` 在
 * `message=init` 上卡七十秒以上、零输出 —— 设备端每轮都要重新付这笔启动
 * 开销，用户看到的就是「先想很久」。provider / model / instructions /
 * permission 全部保留，所以模型与人格不变。
 *
 * 返回 null 表示这份配置读不懂（带 BOM、非对象、JSON 破损）——调用方这时
 * 应该什么都不做，让 opencode 用原配置，别把它弄成「配置没了」。
 */
export function buildDeviceOpencodeConfig(
  rawText: string,
  opts: DeviceOpencodeConfigOpts = {},
): { text: string; dropped: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(rawText.replace(/^\uFEFF/, "")));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };
  const dropped: string[] = [];
  for (const key of ["plugin", "mcp"]) {
    if (key in out) {
      delete out[key];
      dropped.push(key);
    }
  }
  // small_model（title 生成等内部小调用用的小模型）指向的 provider/model 与主
  // model 不一致时，对齐到主 model。2026-11-05 现场：small_model=
  // quukk/deepseek-v4-flash 已欠费（Insufficient Balance），而主 model glm-5.2
  // 正常 —— 每轮 title 生成先失败重试（stream error + 步进重试），把主回答的
  // 起跑拖慢约 4~5 秒，且日志噪音大。设备端会话的 title 没有任何消费方，
  // 用主模型生成一次标题的代价可以忽略，换来的是不再被小模型的配额状态绑架。
  // 用户没配 small_model 时不主动添加（保持其原有行为）。
  if (typeof out.small_model === "string"
    && typeof out.model === "string"
    && out.small_model !== out.model) {
    dropped.push(`small_model:${out.small_model}`);
    out.small_model = out.model;
  }
  if (opts.instructions && opts.instructions.length > 0) {
    // 追加而不是覆盖：用户自己的 instructions 必须原样保留。
    const existing = Array.isArray(out.instructions)
      ? out.instructions.filter((item): item is string => typeof item === "string")
      : [];
    out.instructions = [...new Set([...existing, ...opts.instructions])];
  }
  if (opts.fsRestricted) {
    const permission = (out.permission && typeof out.permission === "object" && !Array.isArray(out.permission))
      ? { ...(out.permission as Record<string, unknown>) }
      : {};
    out.permission = { ...permission, ...FS_DENY_PERMISSION };
    const tools = (out.tools && typeof out.tools === "object" && !Array.isArray(out.tools))
      ? { ...(out.tools as Record<string, unknown>) }
      : {};
    out.tools = { ...tools, ...FS_DENY_TOOLS };
  }
  // 精简/发言回合要覆盖 build 人格。opencode 1.x 与 2.x 的配置 schema 不同：
  //   · 1.x：`agent.build.prompt` + `agent.build.tools={"*":false}`
  //   · 2.x：`agents.build.system` + `agents.build.permissions=[{action:"*",effect:"deny"}]`
  //     （官方文档明说 2.x 忽略旧的顶层 `prompt`/`tools`/`permission` 字段）
  // 两套都写、语义一致，任一版本生效即可 —— 不必猜设备上装的是哪一版。
  // 2026-11-26 现场：主持设备 opencode 2.1.x，旧代码只写 1.x 键，lean 从未生效，
  // 模型一直拿完整的 1.9 万 token 系统提示 + 全套工具 + 默认思考跑，单轮 30~45s。
  const systemPrompt = opts.lean ? LEAN_AGENT_SYSTEM_PROMPT : TERSE_AGENT_SYSTEM_PROMPT;
  if (opts.lean || opts.terse) {
    // ---- 1.x 键（agent / prompt / tools）----
    const agentsLegacy = (out.agent && typeof out.agent === "object" && !Array.isArray(out.agent))
      ? { ...(out.agent as Record<string, unknown>) }
      : {};
    const buildLegacy = (agentsLegacy.build && typeof agentsLegacy.build === "object" && !Array.isArray(agentsLegacy.build))
      ? { ...(agentsLegacy.build as Record<string, unknown>) }
      : {};
    agentsLegacy.build = {
      ...buildLegacy,
      prompt: systemPrompt,
      // 发言回合（terse）只换提示、工具照旧；精简回合（lean）连工具一起关。
      ...(opts.lean ? { tools: { "*": false } } : {}),
    };
    out.agent = agentsLegacy;

    // ---- 2.x 键（agents / system / permissions）----
    const agentsV2 = (out.agents && typeof out.agents === "object" && !Array.isArray(out.agents))
      ? { ...(out.agents as Record<string, unknown>) }
      : {};
    const buildV2 = (agentsV2.build && typeof agentsV2.build === "object" && !Array.isArray(agentsV2.build))
      ? { ...(agentsV2.build as Record<string, unknown>) }
      : {};
    agentsV2.build = {
      ...buildV2,
      system: systemPrompt,
      // V2 用 permissions 数组按 action 授权；`*` + deny 等价于 1.x 的 tools 全关。
      // 只对 lean 写：terse 回合要保留工具，否则群里让 agent 干活就用不了了。
      ...(opts.lean ? { permissions: [{ action: "*", resource: "*", effect: "deny" }] } : {}),
    };
    out.agents = agentsV2;

    // ---- 关思考（reasoning）----
    // lean 回合只要一段 JSON，思考纯属浪费：2.1.x 官方实测「输入 17 token、思考
    // 3255 字符、出正文 13.5s」—— 段子级任务也是这个量级。对当前 model 注入
    // reasoningEffort=none（OpenAI 兼容 provider 认识这个字段），并同时兼容
    // 1.x 的 options 与 2.x 的 settings 两种键位。只作用于派生的精简配置，
    // 聊天/发言回合那份配置不受影响。
    if (opts.lean) {
      disableReasoningForSelectedModel(out, dropped);
    }
  }
  if (opts.noInteractiveTools) {
    const INTERACTIVE_TOOL_NAMES = ["question", "ask_user"] as const;
    // 1.x：只写 `agent.build.tools`，不碰顶层 `permission`/`tools` —— 后两者是
    // 「整机限制态」的契约键（见 fsRestricted 用例），留空才能与限制态区分。
    const agentsLegacy = (out.agent && typeof out.agent === "object" && !Array.isArray(out.agent))
      ? { ...(out.agent as Record<string, unknown>) }
      : {};
    const buildLegacy = (agentsLegacy.build && typeof agentsLegacy.build === "object" && !Array.isArray(agentsLegacy.build))
      ? { ...(agentsLegacy.build as Record<string, unknown>) }
      : {};
    const legacyTools = (buildLegacy.tools && typeof buildLegacy.tools === "object" && !Array.isArray(buildLegacy.tools))
      ? { ...(buildLegacy.tools as Record<string, unknown>) }
      : {};
    for (const name of INTERACTIVE_TOOL_NAMES) legacyTools[name] = false;
    agentsLegacy.build = { ...buildLegacy, tools: legacyTools };
    out.agent = agentsLegacy;

    // 2.x：agents.build.permissions 是数组，按 action 覆盖；保留用户已有规则，
    // 只在末尾追加 deny（opencode 的规则是「最后匹配优先」）。
    const agentsV2 = (out.agents && typeof out.agents === "object" && !Array.isArray(out.agents))
      ? { ...(out.agents as Record<string, unknown>) }
      : {};
    const buildV2 = (agentsV2.build && typeof agentsV2.build === "object" && !Array.isArray(agentsV2.build))
      ? { ...(agentsV2.build as Record<string, unknown>) }
      : {};
    const existingPermissions = Array.isArray(buildV2.permissions)
      ? buildV2.permissions.filter((rule) => {
        const record = rule as Record<string, unknown>;
        return !INTERACTIVE_TOOL_NAMES.includes(record.action as (typeof INTERACTIVE_TOOL_NAMES)[number]);
      })
      : [];
    agentsV2.build = {
      ...buildV2,
      permissions: [
        ...existingPermissions,
        ...INTERACTIVE_TOOL_NAMES.map((action) => ({ action, resource: "*", effect: "deny" })),
      ],
    };
    out.agents = agentsV2;
  }
  return { text: JSON.stringify(out, null, 2), dropped };
}

/**
 * 在派生的「精简回合」配置里，给当前选中的模型关掉 reasoning/thinking。
 *
 * 只动 `model` 指向的那一个 provider/model（不碰其它模型），这样用户在其它
 * 场景用同一 provider 的其它模型时行为不变。写入三处兼容键：
 *   · 2.x `providers.<id>.models.<slug>.settings.reasoningEffort = "none"`
 *   · 1.x `provider.<id>.models.<slug>.options.reasoningEffort = "none"`
 *   · 顶层 `model` 的 `#none` variant 不了（会影响调用方传来的 model route），
 *     故不写 variant，只落到 provider/model 配置层。
 * 另外 opencode 2.x 的模型名可带 `#variant`，先剥掉再匹配。
 */
function disableReasoningForSelectedModel(
  out: Record<string, unknown>,
  dropped: string[],
): void {
  const route = typeof out.model === "string" ? out.model : "";
  if (!route || !route.includes("/")) return;
  const [providerID, rest] = route.split("/", 2);
  const modelID = rest.split("#", 1)[0];
  if (!providerID || !modelID) return;

  // 2.x：providers.<id>.models.<slug>.settings
  const providersV2 = (out.providers && typeof out.providers === "object" && !Array.isArray(out.providers))
    ? (out.providers as Record<string, unknown>)
    : null;
  if (providersV2 && providersV2[providerID] && typeof providersV2[providerID] === "object") {
    const provider = providersV2[providerID] as Record<string, unknown>;
    const models = (provider.models && typeof provider.models === "object" && !Array.isArray(provider.models))
      ? (provider.models as Record<string, unknown>)
      : null;
    const model = models?.[modelID] as Record<string, unknown> | undefined;
    if (model && !Array.isArray(model)) {
      const settings = (model.settings && typeof model.settings === "object" && !Array.isArray(model.settings))
        ? { ...(model.settings as Record<string, unknown>) }
        : {};
      settings.reasoningEffort = "none";
      model.settings = settings;
      dropped.push("reasoning:none@" + providerID + "/" + modelID);
    }
  }

  // 1.x：provider.<id>.models.<slug>.options
  const providersV1 = (out.provider && typeof out.provider === "object" && !Array.isArray(out.provider))
    ? (out.provider as Record<string, unknown>)
    : null;
  if (providersV1 && providersV1[providerID] && typeof providersV1[providerID] === "object") {
    const provider = providersV1[providerID] as Record<string, unknown>;
    const models = (provider.models && typeof provider.models === "object" && !Array.isArray(provider.models))
      ? (provider.models as Record<string, unknown>)
      : null;
    const model = models?.[modelID] as Record<string, unknown> | undefined;
    if (model && !Array.isArray(model)) {
      const options = (model.options && typeof model.options === "object" && !Array.isArray(model.options))
        ? { ...(model.options as Record<string, unknown>) }
        : {};
      options.reasoningEffort = "none";
      model.options = options;
    }
  }
}


export function readAgentConfig(
  agentName: string | undefined,
  opts: DiscoverOpts = {},
): AgentConfig | null {
  if (!agentName) return null;
  const parser = AGENT_CONFIG_PARSERS[agentName];
  if (!parser) return null;
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const readFile = opts.readFile ?? defaultReadFile;
  for (const path of configPaths(agentName, home, env, opts.cwd)) {
    let text: string;
    try {
      text = readFile(path);
    } catch {
      continue;
    }
    try {
      const config = parser(text, env);
      return { ...config, endpoints: dedupeEndpoints(config.endpoints) };
    } catch {
      return null;
    }
  }
  return null;
}

/** Endpoints an agent's own config points at (empty when none/unreadable). */
export function discoverProviderEndpoints(
  agentName: string | undefined,
  opts: DiscoverOpts = {},
): ProviderEndpoint[] {
  return readAgentConfig(agentName, opts)?.endpoints ?? [];
}

/** The agent's configured default route, if it has one. */
export function discoverDefaultModel(
  agentName: string | undefined,
  opts: DiscoverOpts = {},
): string | null {
  return readAgentConfig(agentName, opts)?.defaultModel ?? null;
}

function dedupeEndpoints(endpoints: ProviderEndpoint[]): ProviderEndpoint[] {
  const seen = new Set<string>();
  const out: ProviderEndpoint[] = [];
  for (const endpoint of endpoints) {
    const key = `${endpoint.id}\u0000${endpoint.baseUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(endpoint);
  }
  return out;
}
