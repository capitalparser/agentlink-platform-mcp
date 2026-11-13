import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assessInstallation } from "../../dist/tax-doctor.js";

const here = dirname(fileURLToPath(import.meta.url));
const doctorEntry = join(here, "../../dist/tax-doctor.js");
const childFixture = join(here, "fixtures/fake-child.mjs");
const toolNames = ["tax_route_question", "tax_health", "tax_list_workflows"];

async function processExited(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { return error?.code === "ESRCH"; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try { process.kill(pid, 0); return false; } catch (error) { return error?.code === "ESRCH"; }
}

function terminateTestChild(pid) {
  try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
}

function recordedPids(pidFile) {
  if (!existsSync(pidFile)) return [];
  return readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
}

function cleanupRecordedPids(pidFile, recorded = []) {
  for (const pid of recorded.length ? recorded : recordedPids(pidFile)) terminateTestChild(pid);
}

function healthyObservations(overrides = {}) {
  return {
    upperConnected: true,
    bridgeStatus: {
      schema_version: "agentlink-bridge-status.v1",
      tax: { state: "ready", verified_tool_names: toolNames, verified_tool_count: toolNames.length },
    },
    toolNames,
    health: { status: "ok", version: "0.1.0", workflows: 3, credentials: { law_go_kr_oc: false } },
    workflowList: { domain: "tax", workflows: [
      { id: "withholding-payment" }, { id: "vat-return" }, { id: "corporate-adjustment" },
    ] },
    ...overrides,
  };
}

test("healthy installed-pair assessment stays ready without law credentials or an exact workflow count", () => {
  const report = assessInstallation(healthyObservations());
  assert.equal(report.schema_version, "tax-installation-check.v1");
  assert.equal(report.preparation_status, "ready");
  assert.deepEqual(report.checks.map(({ id, status }) => [id, status]), [
    ["upper_connection", "passed"], ["tax_bridge", "passed"], ["tax_tools", "passed"],
    ["tax_health", "passed"], ["workflow_catalog", "passed"],
  ]);
  assert.deepEqual(report.credentials, { law_go_kr_oc: false });
  assert.equal(report.live_provider_status, "not_checked");
  assert.equal(report.filing_status, "not_supported");
});

test("malformed health and workflow count mismatches block preparation with fixed codes", () => {
  const malformedHealth = assessInstallation(healthyObservations({
    health: { status: "ok", version: "0.1.0", workflows: "3", credentials: { law_go_kr_oc: true } },
  }));
  assert.equal(malformedHealth.preparation_status, "blocked");
  assert.deepEqual(malformedHealth.credentials, { law_go_kr_oc: null });
  assert.equal(malformedHealth.checks.find(({ id }) => id === "tax_health").code, "TAX_HEALTH_INVALID");

  const wrongCatalog = assessInstallation(healthyObservations({
    workflowList: { workflows: [{ id: "withholding-payment" }, { id: "vat-return" }] },
  }));
  assert.equal(wrongCatalog.checks.find(({ id }) => id === "workflow_catalog").code, "WORKFLOW_CATALOG_INVALID");
});

test("missing new upper tools fail closed without leaking unrelated tool names", () => {
  const report = assessInstallation(healthyObservations({ toolNames: ["tax_list_workflows"] }));
  assert.equal(report.preparation_status, "blocked");
  assert.equal(report.checks.find(({ id }) => id === "tax_tools").code, "TAX_TOOLS_MISSING");
  assert.deepEqual(report.credentials, { law_go_kr_oc: false });
});

test("doctor CLI emits one safe JSON report and closes its child process", { timeout: 60_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "agentlink-tax-doctor-"));
  const pidFile = join(scratch, "child.pid");
  let ownedPids = [];
  try {
    assert.equal(existsSync(doctorEntry), true, "run npm run build before the doctor smoke test");
    const result = spawnSync(process.execPath, [doctorEntry], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 50_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: scratch,
        TMPDIR: scratch,
        AGENTLINK_TAX_MCP_COMMAND: process.execPath,
        AGENTLINK_TAX_MCP_ARGS: JSON.stringify([childFixture, pidFile, "stderr-secret"]),
        AGENTLINK_CREDENTIALS_PATH: join(scratch, "missing-credentials.json"),
      },
    });
    ownedPids = recordedPids(pidFile);
    assert.equal(result.error, undefined, "doctor subprocess should finish within its time limit");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /CHILD_STDERR_SECRET_SENTINEL|\/private\/fixture\/path/);
    const report = JSON.parse(result.stdout);
    assert.equal(report.preparation_status, "ready");
    assert.equal(report.credentials.law_go_kr_oc, false);
    assert.equal(report.live_provider_status, "not_checked");
    assert.equal(report.filing_status, "not_supported");
    const [childPid, upperPid] = ownedPids;
    assert.equal(ownedPids.length, 2);
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    assert.ok(Number.isInteger(upperPid) && upperPid > 0);
    const exited = await Promise.all([processExited(childPid, 1_000), processExited(upperPid, 1_000)]);
    if (!exited[0]) terminateTestChild(childPid);
    if (!exited[1]) terminateTestChild(upperPid);
    assert.deepEqual(exited, [true, true], "doctor cleanup should stop both installed upper and tax child");
  } finally {
    cleanupRecordedPids(pidFile, ownedPids);
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("doctor CLI reports a missing child safely without echoing its command", { timeout: 20_000 }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "agentlink-tax-doctor-missing-"));
  const secretCommand = join(scratch, "CHILD_COMMAND_SECRET_SENTINEL");
  try {
    const result = spawnSync(process.execPath, [doctorEntry], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: scratch,
        TMPDIR: scratch,
        AGENTLINK_TAX_MCP_COMMAND: secretCommand,
        AGENTLINK_TAX_MCP_ARGS: "[]",
        AGENTLINK_CREDENTIALS_PATH: join(scratch, "missing-credentials.json"),
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /CHILD_COMMAND_SECRET_SENTINEL|\/private\/|Error:|stack/);
    const report = JSON.parse(result.stdout);
    assert.equal(report.preparation_status, "blocked");
    assert.equal(report.checks.find(({ id }) => id === "tax_bridge").code, "TAX_BRIDGE_NOT_READY");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the npm-style .bin symlink runs the doctor once from an empty cwd", { timeout: 60_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "agentlink-tax-doctor-bin-"));
  const npmBinDir = join(scratch, "node_modules", ".bin");
  const doctorBin = join(npmBinDir, "agentlink-tax-doctor");
  const pidFile = join(scratch, "child.pid");
  let ownedPids = [];
  try {
    mkdirSync(npmBinDir, { recursive: true });
    symlinkSync(relative(realpathSync(npmBinDir), doctorEntry), doctorBin);
    assert.equal(lstatSync(doctorBin).isSymbolicLink(), true);
    const importOnly = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(doctorEntry).href)})`], {
      cwd: scratch, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(importOnly.status, 0);
    assert.equal(importOnly.stdout, "");
    assert.equal(importOnly.stderr, "");

    const healthy = spawnSync(process.execPath, [doctorBin], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 50_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: scratch,
        TMPDIR: scratch,
        AGENTLINK_TAX_MCP_COMMAND: process.execPath,
        AGENTLINK_TAX_MCP_ARGS: JSON.stringify([childFixture, pidFile, "stderr-secret"]),
        AGENTLINK_CREDENTIALS_PATH: join(scratch, "missing-credentials.json"),
      },
    });
    ownedPids = recordedPids(pidFile);
    assert.equal(healthy.error, undefined, "npm bin invocation should finish within its time limit");
    assert.equal(healthy.status, 0, `${healthy.stderr}\n${healthy.stdout}`);
    assert.equal(healthy.stderr, "");
    assert.notEqual(healthy.stdout.trim(), "", "npm bin invocation must not silently succeed without a report");
    assert.equal(healthy.stdout.trim().split("\n").length, 1, "doctor writes exactly one report");
    assert.equal(JSON.parse(healthy.stdout).preparation_status, "ready");
    assert.doesNotMatch(`${healthy.stdout}\n${healthy.stderr}`, /CHILD_STDERR_SECRET_SENTINEL|\/private\/fixture\/path/);
    const exited = await Promise.all(ownedPids.map(pid => processExited(pid, 1_000)));
    assert.deepEqual(exited, [true, true], "npm bin invocation should close both owned processes");

    const secretCommand = join(scratch, "CHILD_COMMAND_SECRET_SENTINEL");
    const missing = spawnSync(process.execPath, [doctorBin], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: scratch,
        TMPDIR: scratch,
        AGENTLINK_TAX_MCP_COMMAND: secretCommand,
        AGENTLINK_TAX_MCP_ARGS: "[]",
        AGENTLINK_CREDENTIALS_PATH: join(scratch, "missing-credentials.json"),
      },
    });
    assert.equal(missing.error, undefined);
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr, "");
    assert.equal(missing.stdout.trim().split("\n").length, 1, "blocked result is still exactly one report");
    assert.equal(JSON.parse(missing.stdout).preparation_status, "blocked");
    assert.doesNotMatch(`${missing.stdout}\n${missing.stderr}`, /CHILD_COMMAND_SECRET_SENTINEL|\/private\/|Error:|stack/);
  } finally {
    cleanupRecordedPids(pidFile, ownedPids);
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("doctor request timeout is bounded and its blocked report stays safe", { timeout: 35_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "agentlink-tax-doctor-timeout-"));
  const pidFile = join(scratch, "child.pid");
  let ownedPids = [];
  try {
    const started = Date.now();
    const result = spawnSync(process.execPath, [doctorEntry], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: scratch,
        TMPDIR: scratch,
        AGENTLINK_TAX_MCP_COMMAND: process.execPath,
        AGENTLINK_TAX_MCP_ARGS: JSON.stringify([childFixture, pidFile, "health-timeout"]),
        AGENTLINK_CREDENTIALS_PATH: join(scratch, "missing-credentials.json"),
      },
    });
    ownedPids = recordedPids(pidFile);
    assert.ok(Date.now() - started < 45_000, "doctor should honor its total runtime bound");
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /\/private\/|stack|timeout path/i);
    const report = JSON.parse(result.stdout);
    assert.equal(report.preparation_status, "blocked");
    assert.equal(report.checks.find(({ id }) => id === "tax_health").code, "TAX_HEALTH_INVALID");
    const [childPid, upperPid] = ownedPids;
    assert.equal(ownedPids.length, 2);
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    assert.ok(Number.isInteger(upperPid) && upperPid > 0);
    const exited = await Promise.all([processExited(childPid, 1_000), processExited(upperPid, 1_000)]);
    if (!exited[0]) terminateTestChild(childPid);
    if (!exited[1]) terminateTestChild(upperPid);
    assert.deepEqual(exited, [true, true], "timeout cleanup should stop both installed upper and tax child");
  } finally {
    cleanupRecordedPids(pidFile, ownedPids);
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("doctor startup timeout kills an initialization-hung child that ignores EOF and SIGTERM", { timeout: 55_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "agentlink-tax-doctor-init-hang-"));
  const pidFile = join(scratch, "child.pid");
  let ownedPids = [];
  try {
    const started = Date.now();
    const result = spawnSync(process.execPath, [doctorEntry], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 45_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: scratch,
        TMPDIR: scratch,
        AGENTLINK_TAX_MCP_COMMAND: process.execPath,
        AGENTLINK_TAX_MCP_ARGS: JSON.stringify([childFixture, pidFile, "initialization-hang-ignore-sigterm"]),
        AGENTLINK_CREDENTIALS_PATH: join(scratch, "missing-credentials.json"),
      },
    });
    ownedPids = recordedPids(pidFile);
    assert.ok(Date.now() - started < 46_000, "doctor should remain within its total 45 second deadline plus exit tolerance");
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /\/private\/|stack|CHILD_STDERR_SECRET_SENTINEL/);
    const report = JSON.parse(result.stdout);
    assert.equal(report.preparation_status, "blocked");
    assert.equal(report.checks.find(({ id }) => id === "upper_connection").code, "UPPER_UNAVAILABLE");
    assert.ok(ownedPids.length === 2 && ownedPids.every(pid => Number.isInteger(pid) && pid > 0));
    const exited = await Promise.all(ownedPids.map(pid => processExited(pid, 1_000)));
    assert.deepEqual(exited, [true, true], "initialization failure must not leave the nested tax child alive");
  } finally {
    cleanupRecordedPids(pidFile, ownedPids);
    rmSync(scratch, { recursive: true, force: true });
  }
});
