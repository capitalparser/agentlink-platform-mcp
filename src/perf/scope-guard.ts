/**
 * Scope guard for search-like tools that can trigger a very large scan.
 *
 * When none of the configured scope fields carries a value, the guard returns
 * structured guidance instead of calling the backend. The guidance is marked
 * transient (the caller can retry with a narrower request). An operator can
 * disable the guard with an environment variable whose name is configurable.
 */

export interface ScopeGuardConfig<A extends object = Record<string, unknown>> {
  /** Argument names that narrow a request. The call passes when at least one has a value. */
  scopeFields: readonly string[];
  /**
   * Message template. Placeholders: `{fields}` (comma separated scope fields),
   * `{subject}` (value of `subjectField`, if any).
   */
  messageTemplate: string;
  /** Optional argument whose value is interpolated into `{subject}`. */
  subjectField?: string;
  /** Only guard calls for which this returns true (e.g. when a free-text query is present). Default: always. */
  appliesTo?: (args: A) => boolean;
  /** Environment variable that, when truthy, disables the guard. */
  bypassEnvVar?: string;
  /** Include the bypass variable name in the guidance (off by default: it is an operator setting). */
  revealBypass?: boolean;
  /** Error code placed in the guidance. Default `scope_required`. */
  code?: string;
  /** Environment source (injectable for tests). Default `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface ScopeGuidance {
  error: string;
  transient: true;
  message: string;
  required_any_of: string[];
  bypass_env?: string;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** True for undefined, null, blank strings, empty arrays and empty plain objects. */
export function isEmptyScopeValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.every(isEmptyScopeValue);
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

export function isUnscoped(args: object, scopeFields: readonly string[]): boolean {
  const record = args as Record<string, unknown>;
  return scopeFields.every((field) => isEmptyScopeValue(record[field]));
}

function bypassed(config: ScopeGuardConfig<never>): boolean {
  if (!config.bypassEnvVar) return false;
  const env = config.env ?? process.env;
  return TRUTHY.has((env[config.bypassEnvVar] ?? "").trim().toLowerCase());
}

export function renderScopeMessage(config: ScopeGuardConfig<never>, args: object): string {
  const subjectRaw = config.subjectField
    ? (args as Record<string, unknown>)[config.subjectField]
    : undefined;
  const subject = Array.isArray(subjectRaw) ? subjectRaw.join(", ") : String(subjectRaw ?? "");
  return config.messageTemplate
    .split("{fields}").join(config.scopeFields.join(", "))
    .split("{subject}").join(subject);
}

/** Returns guidance when the call must be blocked, otherwise `null`. */
export function checkScope<A extends object>(
  args: A,
  config: ScopeGuardConfig<A>,
): ScopeGuidance | null {
  if (config.appliesTo && !config.appliesTo(args)) return null;
  if (bypassed(config as ScopeGuardConfig<never>)) return null;
  if (!isUnscoped(args, config.scopeFields)) return null;
  const guidance: ScopeGuidance = {
    error: config.code ?? "scope_required",
    transient: true,
    message: renderScopeMessage(config as ScopeGuardConfig<never>, args),
    required_any_of: [...config.scopeFields],
  };
  if (config.revealBypass && config.bypassEnvVar) guidance.bypass_env = config.bypassEnvVar;
  return guidance;
}

/**
 * Wrap a handler so unscoped calls return guidance without invoking it.
 * The backend is never touched on the blocked path.
 */
export function withScopeGuard<A extends object, R>(
  handler: (args: A) => Promise<R> | R,
  config: ScopeGuardConfig<A>,
): (args: A) => Promise<R | ScopeGuidance> {
  return async (args: A) => checkScope(args, config) ?? handler(args);
}
