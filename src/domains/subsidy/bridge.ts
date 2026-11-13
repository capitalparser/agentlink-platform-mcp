/** Verified stdio bridge to the optional subsidy/R&D MCP domain. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolResultSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { discoverAndVerifyTools, DiscoveryFailure, type ToolContract } from "../discovery.js";
import type { DomainState } from "../tax/bridge.js";

export const SUBSIDY_BRIDGE_ERROR_SCHEMA = "subsidy-bridge-error.v1";
export type SubsidyBridgeErrorCode =
  | "SUBSIDY_DOMAIN_UNAVAILABLE"
  | "SUBSIDY_DOMAIN_TIMEOUT"
  | "SUBSIDY_DOMAIN_TOOL_ERROR"
  | "SUBSIDY_DOMAIN_ERROR"
  | "SUBSIDY_DOMAIN_TOOL_MISSING"
  | "SUBSIDY_DOMAIN_SCHEMA_MISMATCH"
  | "SUBSIDY_DOMAIN_TOOL_UNKNOWN"
  | "SUBSIDY_DOMAIN_CONFIG_INVALID";

export interface SubsidyBridgeError {
  schema_version: typeof SUBSIDY_BRIDGE_ERROR_SCHEMA;
  error_code: SubsidyBridgeErrorCode;
  message: string;
}

export interface SubsidyDomainStatus {
  configured: boolean;
  state: DomainState;
  error_code?: SubsidyBridgeErrorCode;
  verified_tool_names: string[];
  verified_tool_count: number;
}

export interface SubsidyDomainClientLike {
  initialize(contracts: readonly ToolContract[]): Promise<SubsidyDomainStatus>;
  refresh(contracts?: readonly ToolContract[]): Promise<SubsidyDomainStatus>;
  getStatus(): SubsidyDomainStatus;
  setStatusListener(listener: (status: SubsidyDomainStatus) => void): void;
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  callToolResult(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface SubsidyDomainConfig {
  command: string;
  args: string[];
  pythonPath?: string;
  timeoutMs?: number;
  configInvalid?: boolean;
}

const ENV_ALLOWLIST = [
  "PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "PYTHONPATH",
  "REGULATION_CATALOG", "REGULATION_PRACTITIONER_REGISTRY_DIR", "REGULATION_OFFICIAL_TEXT_DIR",
  "REGULATION_USAGE_DIR", "REGULATION_USAGE_SIGNALS",
];
const DEFAULT_TIMEOUT_MS = 30_000;

const SAFE_MESSAGES: Record<SubsidyBridgeErrorCode, string> = {
  SUBSIDY_DOMAIN_UNAVAILABLE: "Subsidy domain server is unavailable.",
  SUBSIDY_DOMAIN_TIMEOUT: "Subsidy domain server did not respond in time.",
  SUBSIDY_DOMAIN_TOOL_ERROR: "Subsidy domain tool reported an error.",
  SUBSIDY_DOMAIN_ERROR: "Subsidy domain server returned an invalid result.",
  SUBSIDY_DOMAIN_TOOL_MISSING: "Subsidy domain server is missing a required tool.",
  SUBSIDY_DOMAIN_SCHEMA_MISMATCH: "Subsidy domain tool input does not match the supported contract.",
  SUBSIDY_DOMAIN_TOOL_UNKNOWN: "Subsidy domain tool is not supported by this bridge.",
  SUBSIDY_DOMAIN_CONFIG_INVALID: "Subsidy domain configuration is invalid.",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function bridgeError(code: SubsidyBridgeErrorCode, message = SAFE_MESSAGES[code]): SubsidyBridgeError {
  return { schema_version: SUBSIDY_BRIDGE_ERROR_SCHEMA, error_code: code, message };
}

export function isBridgeError(value: unknown): value is SubsidyBridgeError {
  return isRecord(value) && value.schema_version === SUBSIDY_BRIDGE_ERROR_SCHEMA && typeof value.error_code === "string";
}

export function subsidyDomainConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENTLINK_SUBSIDY_MCP_COMMAND !== undefined || env.AGENTLINK_SUBSIDY_MCP_ARGS !== undefined ||
    env.AGENTLINK_SUBSIDY_MCP_PYTHONPATH !== undefined;
}

export function subsidyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SubsidyDomainConfig {
  let args = ["-m", "regulation_reference.server"];
  let configInvalid = false;
  const raw = env.AGENTLINK_SUBSIDY_MCP_ARGS;
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) args = parsed as string[];
      else configInvalid = true;
    } catch {
      configInvalid = true;
    }
  }
  const command = env.AGENTLINK_SUBSIDY_MCP_COMMAND ?? "python3";
  if (!command.trim() || command.includes("\0")) configInvalid = true;
  const config: SubsidyDomainConfig = { command, args, pythonPath: env.AGENTLINK_SUBSIDY_MCP_PYTHONPATH || undefined };
  return configInvalid ? { ...config, configInvalid: true } : config;
}

function childEnv(config: SubsidyDomainConfig, env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of DEFAULT_INHERITED_ENV_VARS) out[key] = undefined;
  for (const key of ENV_ALLOWLIST) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  if (config.pythonPath) out.PYTHONPATH = config.pythonPath;
  return out;
}

interface Generation {
  id: number;
  client: Client;
  transport: StdioClientTransport;
  verified: Set<string>;
}

function mappedCode(error: unknown, connecting: boolean): SubsidyBridgeErrorCode {
  if (error instanceof DiscoveryFailure) {
    if (error.code === "DOMAIN_TOOL_MISSING") return "SUBSIDY_DOMAIN_TOOL_MISSING";
    if (error.code === "DOMAIN_SCHEMA_MISMATCH") return "SUBSIDY_DOMAIN_SCHEMA_MISMATCH";
    if (error.code === "DOMAIN_TIMEOUT") return "SUBSIDY_DOMAIN_TIMEOUT";
    return "SUBSIDY_DOMAIN_ERROR";
  }
  if (error instanceof McpError) {
    if (error.code === ErrorCode.RequestTimeout) return "SUBSIDY_DOMAIN_TIMEOUT";
    if (error.code === ErrorCode.ConnectionClosed) return "SUBSIDY_DOMAIN_UNAVAILABLE";
    return "SUBSIDY_DOMAIN_ERROR";
  }
  return connecting ? "SUBSIDY_DOMAIN_UNAVAILABLE" : "SUBSIDY_DOMAIN_ERROR";
}

function errorResult(code: SubsidyBridgeErrorCode): CallToolResult {
  const error = bridgeError(code);
  return { isError: true, content: [{ type: "text", text: error.message }], structuredContent: { ...error } };
}

export class SubsidyDomainClient implements SubsidyDomainClientLike {
  private generation: Generation | null = null;
  private connecting: Promise<Generation> | null = null;
  private pending: { client: Client; transport: StdioClientTransport; abort: AbortController; id: number } | null = null;
  private contracts: readonly ToolContract[] = [];
  private readonly timeoutMs: number;
  private readonly configInvalid: boolean;
  private terminal = false;
  private nextGeneration = 1;
  private status: SubsidyDomainStatus = { configured: true, state: "uninitialized", verified_tool_names: [], verified_tool_count: 0 };
  private statusListener: ((status: SubsidyDomainStatus) => void) | null = null;

  constructor(
    private readonly config: SubsidyDomainConfig = subsidyConfigFromEnv(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.configInvalid = config.configInvalid === true || !config.command.trim() || config.command.includes("\0") ||
      !Array.isArray(config.args) || !config.args.every((arg) => typeof arg === "string") ||
      !Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0;
    if (this.configInvalid) this.publish({ ...this.status, state: "invalid", error_code: "SUBSIDY_DOMAIN_CONFIG_INVALID" });
  }

  setStatusListener(listener: (status: SubsidyDomainStatus) => void): void {
    this.statusListener = listener;
    listener(this.getStatus());
  }

  getStatus(): SubsidyDomainStatus {
    return { ...this.status, verified_tool_names: [...this.status.verified_tool_names] };
  }

  private publish(next: SubsidyDomainStatus): void {
    this.status = { ...next, verified_tool_names: [...next.verified_tool_names] };
    try { this.statusListener?.(this.getStatus()); } catch { /* listener failures cannot affect bridge state */ }
  }

  async initialize(contracts: readonly ToolContract[]): Promise<SubsidyDomainStatus> {
    if (contracts.length) this.contracts = contracts;
    if (this.terminal) return this.getStatus();
    if (this.configInvalid) {
      this.publish({ configured: true, state: "invalid", error_code: "SUBSIDY_DOMAIN_CONFIG_INVALID", verified_tool_names: [], verified_tool_count: 0 });
      return this.getStatus();
    }
    try { await this.ensureGeneration(); } catch { /* status contains the safe failure */ }
    return this.getStatus();
  }

  async refresh(contracts?: readonly ToolContract[]): Promise<SubsidyDomainStatus> {
    if (contracts) this.contracts = contracts;
    if (this.terminal || this.configInvalid) return this.getStatus();
    if (this.generation && this.status.state === "ready") return this.getStatus();
    try { await this.ensureGeneration(); } catch { /* status contains the safe failure */ }
    return this.getStatus();
  }

  private async ensureGeneration(): Promise<Generation> {
    if (this.terminal) throw new Error("closed");
    if (this.generation) return this.generation;
    if (!this.contracts.length) throw new DiscoveryFailure("DOMAIN_SCHEMA_MISMATCH");
    if (!this.connecting) {
      const id = this.nextGeneration++;
      this.connecting = this.openAndVerify(id).finally(() => {
        if (this.connecting) this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async openAndVerify(id: number): Promise<Generation> {
    const deadline = Date.now() + this.timeoutMs;
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: childEnv(this.config, this.env) as Record<string, string>,
      stderr: "ignore",
    });
    const originalTransportClose = transport.close.bind(transport);
    let transportClosePromise: Promise<void> | undefined;
    transport.close = (): Promise<void> => {
      if (!transportClosePromise) transportClosePromise = Promise.resolve().then(originalTransportClose);
      return transportClosePromise;
    };
    const client = new Client({ name: "agentlink-subsidy-bridge", version: "0.1.0" });
    const abort = new AbortController();
    this.pending = { client, transport, abort, id };
    client.onerror = () => {};
    client.onclose = () => {
      if (this.generation?.client === client) {
        this.generation = null;
        this.publish({ configured: true, state: "unavailable", error_code: "SUBSIDY_DOMAIN_UNAVAILABLE", verified_tool_names: [], verified_tool_count: 0 });
      }
    };
    try {
      const connectionTimeout = deadline - Date.now();
      if (connectionTimeout <= 0) throw new DiscoveryFailure("DOMAIN_TIMEOUT");
      await client.connect(transport, { timeout: connectionTimeout, signal: abort.signal });
      if (this.terminal) throw new Error("closed");
      const discoveryTimeout = deadline - Date.now();
      if (discoveryTimeout <= 0) throw new DiscoveryFailure("DOMAIN_TIMEOUT");
      const tools = await discoverAndVerifyTools(client, this.contracts, discoveryTimeout);
      if (this.terminal || this.pending?.id !== id) throw new Error("closed");
      const generation: Generation = { id, client, transport, verified: new Set(tools.keys()) };
      this.generation = generation;
      this.publish({ configured: true, state: "ready", verified_tool_names: [...tools.keys()].map((name) => this.contracts.find((contract) => contract.domainName === name)?.publicName ?? name), verified_tool_count: tools.size });
      return generation;
    } catch (error) {
      const code = this.terminal ? "SUBSIDY_DOMAIN_UNAVAILABLE" : mappedCode(error, true);
      if (!this.terminal) {
        const state = code === "SUBSIDY_DOMAIN_UNAVAILABLE" || code === "SUBSIDY_DOMAIN_TIMEOUT" ? "unavailable" : "invalid";
        this.publish({ configured: true, state, error_code: code, verified_tool_names: [], verified_tool_count: 0 });
      }
      abort.abort();
      try { await transport.close(); } catch { /* ignore */ }
      try { await client.close(); } catch { /* ignore */ }
      throw error;
    } finally {
      if (this.pending?.id === id) this.pending = null;
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.callToolResult(name, args);
    return isRecord(result.structuredContent) ? result.structuredContent : { ...bridgeError("SUBSIDY_DOMAIN_ERROR") };
  }

  async callToolResult(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (this.terminal) return errorResult("SUBSIDY_DOMAIN_UNAVAILABLE");
    if (!this.contracts.some((candidate) => candidate.domainName === name)) return errorResult("SUBSIDY_DOMAIN_TOOL_UNKNOWN");
    let generation: Generation;
    try { generation = await this.ensureGeneration(); }
    catch (error) { return errorResult(this.status.error_code ?? mappedCode(error, true)); }
    if (!generation.verified.has(name)) return errorResult("SUBSIDY_DOMAIN_TOOL_MISSING");
    try {
      const result: unknown = await generation.client.callTool({ name, arguments: args }, undefined, { timeout: this.timeoutMs });
      if (isRecord(result) && result.isError === true) return errorResult("SUBSIDY_DOMAIN_TOOL_ERROR");
      if (!isRecord(result) || !Array.isArray(result.content) || !isRecord(result.structuredContent) || Array.isArray(result.structuredContent) ||
        !CallToolResultSchema.safeParse(result).success) return errorResult("SUBSIDY_DOMAIN_ERROR");
      return result as unknown as CallToolResult;
    } catch (error) {
      const code = mappedCode(error, false);
      if (code !== "SUBSIDY_DOMAIN_TIMEOUT") await this.reset(generation);
      return errorResult(code);
    }
  }

  private async reset(expected: Generation): Promise<void> {
    if (this.generation !== expected) return;
    this.generation = null;
    this.publish({ configured: true, state: "unavailable", error_code: "SUBSIDY_DOMAIN_UNAVAILABLE", verified_tool_names: [], verified_tool_count: 0 });
    try { await expected.client.close(); } catch { /* ignore */ }
  }

  async close(): Promise<void> {
    if (this.terminal) return;
    this.terminal = true;
    const pending = this.pending;
    pending?.abort.abort();
    if (pending) {
      try { await pending.transport.close(); } catch { /* ignore */ }
    }
    const generation = this.generation;
    this.generation = null;
    if (generation) {
      try { await generation.client.close(); } catch { /* ignore */ }
    }
    if (this.connecting) {
      try { await this.connecting; } catch { /* ignore */ }
    }
    this.publish({ configured: true, state: "closed", verified_tool_names: [], verified_tool_count: 0 });
  }
}
