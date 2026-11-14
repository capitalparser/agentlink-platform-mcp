// Required installed-package integration for the owned-invoice child and upper bridge.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const python = process.env.AGENTLINK_TEST_TAX_PYTHON;
const upperEntry = process.env.AGENTLINK_TEST_UPPER_ENTRY;
const required = process.env.AGENTLINK_REQUIRE_TAX_INTEGRATION === "1";
const missingPython = !python || !existsSync(python);
const invalidUpperEntry = upperEntry !== undefined && (!isAbsolute(upperEntry) || !isFile(upperEntry));

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function containsDeepValue(value, expected) {
  if (value !== null && typeof value === "object") {
    try { assert.deepEqual(value, expected); return true; } catch { /* keep walking */ }
    return Object.values(value).some((child) => containsDeepValue(child, expected));
  }
  return false;
}

async function connectStdio({ command, args, cwd, env, name }) {
  const transport = new StdioClientTransport({ command, args, cwd, env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    if (stderr.length < 8 * 1024) stderr += String(chunk).slice(0, 8 * 1024 - stderr.length);
  });
  const client = new Client({ name, version: "1" });
  await client.connect(transport);
  return { client, transport, get stderr() { return stderr; } };
}

async function call(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  assert.notEqual(response.isError, true, `${name} returned an MCP error: ${JSON.stringify(response)}`);
  assert.ok(response.structuredContent && typeof response.structuredContent === "object",
    `${name} must preserve structuredContent`);
  return response.structuredContent;
}

test("installed owned-invoice tools work directly and through the upper bridge", {
  timeout: 90_000,
  skip: (missingPython || upperEntry === undefined) && !required && !invalidUpperEntry
    ? "Set AGENTLINK_TEST_TAX_PYTHON and AGENTLINK_TEST_UPPER_ENTRY to run the installed owned-invoice integration."
    : false,
}, async () => {
  assert.ok(python && existsSync(python), "AGENTLINK_TEST_TAX_PYTHON must name the installed tax-wheel interpreter");
  assert.equal(process.env.AGENTLINK_TEST_TAX_REGISTRY, undefined,
    "the owned-invoice integration uses the installed wheel's canonical registry");
  assert.equal(process.env.PYTHONPATH, undefined, "installed mode must not receive a source PYTHONPATH");
  assert.equal(process.env.PYTHONHOME, undefined, "installed mode must not receive a Python home override");
  if (required) {
    assert.ok(upperEntry !== undefined, "required installed mode needs AGENTLINK_TEST_UPPER_ENTRY");
  }
  assert.ok(upperEntry && isAbsolute(upperEntry) && isFile(upperEntry),
    "AGENTLINK_TEST_UPPER_ENTRY must name the built upper MCP entry point");

  const scratch = mkdtempSync(join(tmpdir(), "agentlink-owned-invoice-integration-"));
  const profilePath = join(scratch, "invoice-profile.json");
  const missingCredentials = join(scratch, "intentionally-missing-credentials.json");
  const profile = {
    schema_version: "owned-tax-invoice-profile.v1",
    workspace_id: "invoice-test-workspace",
    issuer: { corp_num: "1234567890", corp_name: "합성 발급 사업자", ceo_name: "홍길동" },
    buyers: [{
      id: "buyer-gaon",
      aliases: ["가온"],
      party: { corp_num: "2345678901", corp_name: "가온 주식회사", ceo_name: "김가온" },
    }],
    default_item: "합성 테스트 용역",
    purpose: "청구",
    tax_preset: "operator_asserted_taxable_10pct_floor",
    max_supply_amount: "1000000000",
  };
  writeFileSync(profilePath, `${JSON.stringify(profile)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(profilePath, 0o600);
  assert.equal(statSync(profilePath).mode & 0o777, 0o600, "the synthetic profile must be private");

  const baseEnv = {
    PATH: process.env.PATH ?? "",
    HOME: scratch,
    TMPDIR: scratch,
    AGENTLINK_CREDENTIALS_PATH: missingCredentials,
  };
  const directEnv = { ...baseEnv, AGENTLINK_TAX_INVOICE_PROFILE: profilePath };
  const upperProfileEnv = {
    ...baseEnv,
    AGENTLINK_TAX_MCP_COMMAND: python,
    AGENTLINK_TAX_MCP_ARGS: JSON.stringify(["-I", "-B", "-m", "agentlink_tax.server"]),
    AGENTLINK_TAX_INVOICE_PROFILE: profilePath,
  };
  const upperNoProfileEnv = {
    ...baseEnv,
    AGENTLINK_TAX_MCP_COMMAND: python,
    AGENTLINK_TAX_MCP_ARGS: JSON.stringify(["-I", "-B", "-m", "agentlink_tax.server"]),
  };

  const request = {
    request_id: "invoice-installed-pair-01",
    buyer: "가온",
    supply_amount: "1000001",
    write_date: "2026-11-14",
    source: {
      kind: "screenshot",
      reference: "synthetic-upload-01",
      extraction: "host_model",
      fields: {
        buyer: { evidence: "가온 주식회사 선택", ambiguous: false },
        supply_amount: { evidence: "공급가액 1,000,001원", ambiguous: false },
        write_date: { evidence: "작성일 2026-11-14", ambiguous: false },
      },
    },
  };

  let native;
  let upper;
  let noProfile;
  try {
    native = await connectStdio({
      command: python,
      args: ["-I", "-B", "-m", "agentlink_tax.server"],
      cwd: scratch,
      env: directEnv,
      name: "owned-invoice-native-installed-test",
    });
    const { tools: nativeTools } = await native.client.listTools();
    for (const name of ["prepare_invoice", "get_invoice_status", "get_invoice_handoff"]) {
      assert.ok(nativeTools.some((tool) => tool.name === name), `installed native server must expose ${name}`);
    }
    const nativePrepareTool = nativeTools.find((tool) => tool.name === "prepare_invoice");
    assert.deepEqual(nativePrepareTool.annotations, {
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    const prepared = await call(native.client, "prepare_invoice", { request });
    assert.equal(prepared.schema_version, "owned-tax-invoice-result.v1");
    assert.equal(prepared.status, "prepared");
    assert.equal(prepared.revision, 1);
    assert.equal(prepared.request_id, request.request_id);
    assert.equal(prepared.issued, false);
    assert.deepEqual(prepared.execution, {
      state: "not_started", blocker: "authenticated_hometax_driver_not_implemented",
    });
    assert.deepEqual(prepared.amounts, { supply: "1000001", tax: "100000", total: "1100001" });
    assert.ok(containsDeepValue(prepared, request.source), "the saved result must retain the complete source provenance");
    await native.client.close();
    native = undefined;

    // Starting a separate upper process checks that its child can read the durable native snapshot.
    upper = await connectStdio({
      command: process.execPath,
      args: [upperEntry],
      cwd: scratch,
      env: upperProfileEnv,
      name: "owned-invoice-upper-installed-test",
    });
    const { tools: upperTools } = await upper.client.listTools();
    for (const name of ["tax_prepare_invoice", "tax_get_invoice_status", "tax_get_invoice_handoff"]) {
      assert.ok(upperTools.some((tool) => tool.name === name), `installed upper bridge must expose ${name}`);
    }
    assert.deepEqual(upperTools.find((tool) => tool.name === "tax_prepare_invoice").annotations, {
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    const replay = await call(upper.client, "tax_prepare_invoice", { request });
    assert.deepEqual(replay, prepared, "upper replay must return the unchanged installed-child result");
    const status = await call(upper.client, "tax_get_invoice_status", { request_id: request.request_id });
    assert.deepEqual(status, prepared, "status after process restart must preserve the frozen result and provenance");
    assert.ok(containsDeepValue(status, request.source));
    const handoff = await call(upper.client, "tax_get_invoice_handoff", { request_id: request.request_id });
    assert.equal(handoff.status, "prepared");
    assert.equal(handoff.request_id, request.request_id);
    assert.equal(handoff.issued, false);
    assert.deepEqual(handoff.execution, prepared.execution);
    assert.ok(containsDeepValue(handoff, request.source));

    await upper.client.close();
    upper = undefined;
    noProfile = await connectStdio({
      command: process.execPath,
      args: [upperEntry],
      cwd: scratch,
      env: upperNoProfileEnv,
      name: "owned-invoice-no-profile-installed-test",
    });
    const { tools: noProfileTools } = await noProfile.client.listTools();
    const taxNames = noProfileTools.map((tool) => tool.name).filter((name) => name.startsWith("tax_"));
    assert.equal(taxNames.length, 22, "without a profile, only the existing required tax tools remain exposed");
    assert.ok(!taxNames.some((name) => name.startsWith("tax_" + "get_invoice_") || name === "tax_prepare_invoice"));
    const bridgeStatus = await call(noProfile.client, "agentlink_bridge_status");
    assert.equal(bridgeStatus.tax.state, "ready");
    assert.equal(bridgeStatus.tax.verified_tool_count, 22);
  } finally {
    for (const runtime of [native, upper, noProfile]) {
      try { await runtime?.client.close(); } catch { /* process may already be closed */ }
      try { await runtime?.transport.close(); } catch { /* integration cleanup */ }
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});
