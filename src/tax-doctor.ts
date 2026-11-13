#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUEST_TIMEOUT_MS = 10_000;
const TOTAL_WORK_TIMEOUT_MS = 34_000;
const UPPER_SHUTDOWN_TIMEOUT_MS = 7_000;
const MAX_TOOL_LIST_BYTES = 1_000_000;
const MAX_STATUS_BYTES = 16_384;
const MAX_HEALTH_BYTES = 16_384;
const MAX_WORKFLOWS_BYTES = 128 * 1024;
const MAX_TOOLS = 512;
const MAX_WORKFLOWS = 1_000;
const REQUIRED_NEW_TOOLS = ["tax_route_question", "tax_health"] as const;
const REQUIRED_CATALOG_TOOL = "tax_list_workflows";
const REPRESENTATIVE_WORKFLOWS = ["withholding-payment", "vat-return", "corporate-adjustment"] as const;

export type DoctorCheckId =
  | "upper_connection"
  | "tax_bridge"
  | "tax_tools"
  | "tax_health"
  | "workflow_catalog";

export interface DoctorCheck {
  id: DoctorCheckId;
  status: "passed" | "failed" | "not_checked";
  code: string;
}

export interface DoctorReport {
  schema_version: "tax-installation-check.v1";
  preparation_status: "ready" | "blocked";
  checks: DoctorCheck[];
  credentials: { law_go_kr_oc: boolean | null };
  live_provider_status: "not_checked";
  filing_status: "not_supported";
}

export interface InstallationObservations {
  upperConnected: boolean;
  bridgeStatus?: unknown;
  toolNames?: unknown;
  health?: unknown;
  workflowList?: unknown;
}

type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function withinJsonLimit(value: unknown, maximumBytes: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && Buffer.byteLength(serialized, "utf8") <= maximumBytes;
  } catch {
    return false;
  }
}

function stringList(value: unknown, maximumLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maximumLength) return null;
  if (!value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 128)) return null;
  const result = value as string[];
  return new Set(result).size === result.length ? result : null;
}

function check(id: DoctorCheckId, status: DoctorCheck["status"], code: string): DoctorCheck {
  return { id, status, code };
}

export function assessInstallation(observations: InstallationObservations): DoctorReport {
  const connected = observations.upperConnected === true;
  const bridgeStatus = isRecord(observations.bridgeStatus) && withinJsonLimit(observations.bridgeStatus, MAX_STATUS_BYTES)
    ? observations.bridgeStatus
    : null;
  const taxStatus = bridgeStatus && isRecord(bridgeStatus.tax) ? bridgeStatus.tax : null;
  const bridgeReady = connected && taxStatus?.state === "ready";

  const names = connected ? stringList(observations.toolNames, MAX_TOOLS) : null;
  const verifiedNames = taxStatus ? stringList(taxStatus.verified_tool_names, MAX_TOOLS) : null;
  const toolListValid = names !== null;
  const requiredToolsPresent = toolListValid && verifiedNames !== null &&
    REQUIRED_NEW_TOOLS.every((name) => names.includes(name) && verifiedNames.includes(name)) &&
    names.includes(REQUIRED_CATALOG_TOOL) && verifiedNames.includes(REQUIRED_CATALOG_TOOL);

  const health = isRecord(observations.health) && withinJsonLimit(observations.health, MAX_HEALTH_BYTES)
    ? observations.health
    : null;
  const healthValid = health !== null && health.status === "ok" &&
    typeof health.version === "string" && health.version.trim().length > 0 && health.version.length <= 100 &&
    Number.isInteger(health.workflows) && (health.workflows as number) >= 0 && (health.workflows as number) <= MAX_WORKFLOWS &&
    (health.credentials === undefined || isRecord(health.credentials)) &&
    (!isRecord(health.credentials) || health.credentials.law_go_kr_oc === undefined || typeof health.credentials.law_go_kr_oc === "boolean");
  const lawCredential = healthValid && isRecord(health?.credentials) && typeof health.credentials.law_go_kr_oc === "boolean"
    ? health.credentials.law_go_kr_oc
    : null;

  const workflowList = isRecord(observations.workflowList) && withinJsonLimit(observations.workflowList, MAX_WORKFLOWS_BYTES)
    ? observations.workflowList
    : null;
  const workflowRows = workflowList && Array.isArray(workflowList.workflows) && workflowList.workflows.length <= MAX_WORKFLOWS
    ? workflowList.workflows
    : null;
  const workflowIds = workflowRows && workflowRows.every((row) => isRecord(row) && typeof row.id === "string" && row.id.length > 0 && row.id.length <= 80)
    ? workflowRows.map((row) => (row as RecordValue).id as string)
    : null;
  const workflowCatalogValid = healthValid && workflowIds !== null && new Set(workflowIds).size === workflowIds.length &&
    workflowIds.length === health.workflows && REPRESENTATIVE_WORKFLOWS.every((id) => workflowIds.includes(id));

  const checks: DoctorCheck[] = [
    check("upper_connection", connected ? "passed" : "failed", connected ? "UPPER_CONNECTED" : "UPPER_UNAVAILABLE"),
    check("tax_bridge", !connected ? "not_checked" : bridgeReady ? "passed" : "failed",
      !connected ? "NOT_CHECKED" : bridgeReady ? "TAX_BRIDGE_READY" : "TAX_BRIDGE_NOT_READY"),
    check("tax_tools", !connected || !bridgeReady ? "not_checked" : requiredToolsPresent ? "passed" : "failed",
      !connected || !bridgeReady ? "NOT_CHECKED" : !toolListValid ? "TAX_TOOL_LIST_INVALID" : requiredToolsPresent ? "TAX_TOOLS_VERIFIED" : "TAX_TOOLS_MISSING"),
    check("tax_health", !connected || !requiredToolsPresent ? "not_checked" : healthValid ? "passed" : "failed",
      !connected || !requiredToolsPresent ? "NOT_CHECKED" : healthValid ? "TAX_HEALTH_OK" : "TAX_HEALTH_INVALID"),
    check("workflow_catalog", !connected || !requiredToolsPresent ? "not_checked" : workflowCatalogValid ? "passed" : "failed",
      !connected || !requiredToolsPresent ? "NOT_CHECKED" : workflowCatalogValid ? "WORKFLOW_CATALOG_VERIFIED" : "WORKFLOW_CATALOG_INVALID"),
  ];

  return {
    schema_version: "tax-installation-check.v1",
    preparation_status: checks.every((item) => item.status === "passed") ? "ready" : "blocked",
    checks,
    credentials: { law_go_kr_oc: lawCredential },
    live_provider_status: "not_checked",
    filing_status: "not_supported",
  };
}

function requestTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("doctor_deadline");
  return Math.min(REQUEST_TIMEOUT_MS, remaining);
}

function structuredResponse(value: unknown, maximumBytes: number): unknown | undefined {
  if (!isRecord(value) || value.isError === true || !withinJsonLimit(value, maximumBytes)) return undefined;
  return isRecord(value.structuredContent) ? value.structuredContent : undefined;
}

function callerEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function safeRequest<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await operation();
  } catch {
    return undefined;
  }
}

async function requestUpperShutdown(transport: StdioClientTransport): Promise<void> {
  const pid = transport.pid;
  if (!Number.isInteger(pid) || (pid as number) <= 0) return;

  const previousOnClose = transport.onclose;
  let timer: NodeJS.Timeout | undefined;
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const finish = () => {
    if (timer) clearTimeout(timer);
    resolveClosed?.();
  };
  const onClose = () => {
    try { previousOnClose?.(); } catch { /* keep SDK close notification errors private */ }
    finish();
  };
  transport.onclose = onClose;
  timer = setTimeout(finish, UPPER_SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  try { process.kill(pid as number, "SIGTERM"); } catch { /* fall back to SDK transport cleanup */ }
  await closed;
  if (transport.onclose === onClose) transport.onclose = previousOnClose;
}

function toolNamesFromList(value: unknown): string[] | undefined {
  if (!isRecord(value) || !withinJsonLimit(value, MAX_TOOL_LIST_BYTES) || !Array.isArray(value.tools) || value.tools.length > MAX_TOOLS) {
    return undefined;
  }
  const names = value.tools.map((tool) => isRecord(tool) ? tool.name : undefined);
  const parsed = stringList(names, MAX_TOOLS);
  return parsed ?? undefined;
}

function ownUpperTransport(transport: StdioClientTransport): () => Promise<void> {
  let closePromise: Promise<void> | undefined;
  const originalClose = transport.close.bind(transport);
  const close = (): Promise<void> => {
    if (!closePromise) {
      closePromise = Promise.resolve().then(async () => {
        try {
          await requestUpperShutdown(transport);
        } finally {
          await originalClose();
        }
      });
    }
    return closePromise;
  };
  transport.close = close;
  return close;
}

export async function runDoctor(): Promise<DoctorReport> {
  const deadline = Date.now() + TOTAL_WORK_TIMEOUT_MS;
  const observations: InstallationObservations = { upperConnected: false };
  let transport: StdioClientTransport | undefined;
  let client: Client | undefined;
  try {
    const installedUpper = join(dirname(fileURLToPath(import.meta.url)), "index.js");
    transport = new StdioClientTransport({ command: process.execPath, args: [installedUpper], stderr: "pipe", env: callerEnvironment() });
    transport.stderr?.on("data", () => {});
    transport.onerror = () => {};
    ownUpperTransport(transport);
    client = new Client({ name: "agentlink-tax-doctor", version: "1.0.0" });
    client.onerror = () => {};
    await client.connect(transport, { timeout: requestTimeout(deadline) });
    observations.upperConnected = true;

    const bridgeResult = await safeRequest(() => client!.callTool(
      { name: "agentlink_bridge_status", arguments: {} }, CallToolResultSchema, { timeout: requestTimeout(deadline) },
    ));
    observations.bridgeStatus = structuredResponse(bridgeResult, MAX_STATUS_BYTES);

    const listedTools = await safeRequest(() => client!.listTools({}, { timeout: requestTimeout(deadline) }));
    observations.toolNames = toolNamesFromList(listedTools);
    const availableTools = stringList(observations.toolNames, MAX_TOOLS) ?? [];

    if (availableTools.includes("tax_health")) {
      const healthResult = await safeRequest(() => client!.callTool(
        { name: "tax_health", arguments: {} }, CallToolResultSchema, { timeout: requestTimeout(deadline) },
      ));
      observations.health = structuredResponse(healthResult, MAX_HEALTH_BYTES);
    }
    if (availableTools.includes(REQUIRED_CATALOG_TOOL)) {
      const workflowsResult = await safeRequest(() => client!.callTool(
        { name: REQUIRED_CATALOG_TOOL, arguments: {} }, CallToolResultSchema, { timeout: requestTimeout(deadline) },
      ));
      observations.workflowList = structuredResponse(workflowsResult, MAX_WORKFLOWS_BYTES);
    }
  } catch {
    // Fixed check codes below carry all public diagnostics.
  } finally {
    if (client) {
      try { await client.close(); } catch { /* startup and transport failures stay private */ }
    }
    if (transport) {
      try { await transport.close(); } catch { /* startup and transport failures stay private */ }
    }
  }
  return assessInstallation(observations);
}

async function main(): Promise<void> {
  let report: DoctorReport;
  try {
    report = await runDoctor();
  } catch {
    report = assessInstallation({ upperConnected: false });
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.preparation_status !== "ready") process.exitCode = 1;
}

const isCliEntry = (() => {
  const argumentEntry = process.argv[1];
  if (!argumentEntry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(argumentEntry));
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  void main();
}
