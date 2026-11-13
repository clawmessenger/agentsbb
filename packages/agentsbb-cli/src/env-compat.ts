/**
 * Environment-variable compatibility layer for the ClawMessenger → AgentsBB
 * rebrand.
 *
 * All `CLAWMESSENGER_*` variables were renamed to `AGENTSBB_*`. During the
 * transition a legacy supervisor (or watchdog / scheduled task) may still spawn
 * new processes while passing the *old* variable names, so reads are dual:
 * the new name wins, the old name answers when the new one is absent.
 * Writes always use the new name.
 *
 * Every dual-read site must carry a `TODO(rebrand-retire)` comment — the old
 * prefix is removed in v1.6+ once no legacy process can be alive anymore.
 */

/**
 * Read a variable by its *unprefixed* name, new prefix first.
 *
 *   envCompat("HOME")  →  AGENTSBB_HOME ?? CLAWMESSENGER_HOME
 */
export function envCompat(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  // TODO(rebrand-retire): 双读过渡，移除 CLAWMESSENGER_ 前缀于 v1.6+
  return env[`AGENTSBB_${name}`] ?? env[`CLAWMESSENGER_${name}`];
}

/**
 * The legacy (CLAWMESSENGER_-prefixed) spelling of a variable that now goes by
 * `AGENTSBB_<name>`. Used where a *constant string* is needed (help text,
 * child-env keys) and by tests that pin the legacy spelling.
 */
export function legacyEnvName(name: string): string {
  return `CLAWMESSENGER_${name}`;
}
