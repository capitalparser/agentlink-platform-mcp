// Optional installed-package integration. Run with an installed tax wheel
// (which carries its canonical registry) and a selected upper entry point.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  assertWorkflowMatrix,
  FOCUS_EXPECTATIONS,
  GUIDANCE_CAPABILITIES,
  WORKFLOW_EXPECTATIONS,
} from "./fixtures/review-expectations.mjs";

const python = process.env.AGENTLINK_TEST_TAX_PYTHON;
const registry = process.env.AGENTLINK_TEST_TAX_REGISTRY;
const upperEntry = process.env.AGENTLINK_TEST_UPPER_ENTRY;
const draftFixtureDir = process.env.AGENTLINK_TEST_TAX_DRAFT_FIXTURES;
const missingPython = !python || !existsSync(python);
const invalidOverride = registry !== undefined && !existsSync(registry);
const invalidUpperEntry = upperEntry !== undefined && (!isAbsolute(upperEntry) || !isFile(upperEntry));
const required = process.env.AGENTLINK_REQUIRE_TAX_INTEGRATION === "1";
const STDERR_LIMIT = 8 * 1024;
const DRAFT_FIXTURES = [
  "draft-vat.json",
  "draft-corporate.json",
  "draft-withholding.json",
  "expected.json",
];

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readDraftFixture(filename) {
  assert.ok(draftFixtureDir && isAbsolute(draftFixtureDir) && isDirectory(draftFixtureDir),
    "AGENTLINK_TEST_TAX_DRAFT_FIXTURES must name the absolute fixture directory from the domain-tax checkout");
  return JSON.parse(readFileSync(join(draftFixtureDir, filename), "utf8"));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  assert.equal(quoted, false, "CSV must have balanced RFC4180 quotes");
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  assert.ok(rows.length > 0, "CSV export must have a header row");
  const [headers, ...values] = rows;
  assert.equal(new Set(headers).size, headers.length, "CSV headers must be unique");
  const parsedRows = values.map((valuesRow) => {
    assert.equal(valuesRow.length, headers.length, "CSV rows must match their header width");
    return Object.fromEntries(headers.map((header, index) => [header, valuesRow[index]]));
  });
  return { headers, rows: parsedRows };
}

function assertDraftExports(result) {
  assert.equal(result.schema_version, "tax-draft-bundle.v1");
  assert.equal(result.status, "draft");
  assert.equal(result.review, "pending");
  assert.equal(result.applicability, "not_determined");
  assert.equal(result.filing_status, "not_supported");
  assert.equal(result.source_verification, "user_supplied_unverified");
  assert.deepEqual(result.storage, { mode: "response_only", server_persisted: false, expires_at: null });
  assert.equal(result.exports.length, 2);
  const jsonExport = result.exports.find((item) => item.filename === "draft.json");
  const csvExport = result.exports.find((item) => item.filename === "workpaper.csv");
  assert.equal(jsonExport?.media_type, "application/json");
  assert.equal(csvExport?.media_type, "text/csv");
  const exported = JSON.parse(jsonExport.text);
  assert.deepEqual(exported.draft, result.draft, "draft.json must preserve the full draft");
  assert.deepEqual(exported.report, result.report, "draft.json must preserve the common report");
  const csv = parseCsv(csvExport.text);
  return { csvHeaders: csv.headers, csvRows: csv.rows, csvText: csvExport.text };
}

function payment(overrides = {}) {
  return {
    payment_id: "p1",
    income_type: "wage",
    payee_type: "resident",
    payment_date: "2026-03-25",
    gross_amount: 3_000_000,
    withheld_amount: "10000",
    ...overrides,
  };
}

function matter({ approval = false, payments = [payment()], workflowId = "withholding-payment" } = {}) {
  return {
    matter_id: "p0-test",
    workflow_id: workflowId,
    as_of: "2026-04-01",
    taxpayer: { type: "corporation", small_business_semiannual_approval: approval },
    facts: { payments },
  };
}

test("installed tax child matches the native and upper review matrix over MCP stdio", {
  timeout: 90_000,
  skip: missingPython && !required && !invalidOverride && !invalidUpperEntry && upperEntry === undefined
    ? "Set AGENTLINK_TEST_TAX_PYTHON to run the installed tax integration."
    : false,
}, async () => {
  if (required) {
    assert.equal(registry, undefined,
      "AGENTLINK_REQUIRE_TAX_INTEGRATION=1 forbids AGENTLINK_TEST_TAX_REGISTRY");
    assert.ok(draftFixtureDir && isAbsolute(draftFixtureDir) && isDirectory(draftFixtureDir),
      "required installed mode needs an absolute AGENTLINK_TEST_TAX_DRAFT_FIXTURES directory");
    for (const filename of DRAFT_FIXTURES) {
      assert.ok(isFile(join(draftFixtureDir, filename)),
        `required installed mode needs the fixed ${filename} test fixture`);
    }
  }
  assert.ok(python && existsSync(python), "AGENTLINK_TEST_TAX_PYTHON must name an installed tax-wheel interpreter");
  if (registry !== undefined) {
    assert.ok(existsSync(registry), "AGENTLINK_TEST_TAX_REGISTRY was explicitly set but does not exist");
  }
  if (required) {
    assert.equal(process.env.PYTHONPATH, undefined, "installed mode must not receive a source PYTHONPATH");
    assert.equal(process.env.PYTHONHOME, undefined, "installed mode must not receive a Python home override");
    assert.ok(upperEntry !== undefined,
      "AGENTLINK_REQUIRE_TAX_INTEGRATION=1 requires an explicit AGENTLINK_TEST_UPPER_ENTRY");
  }

  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  if (upperEntry !== undefined) {
    assert.ok(isAbsolute(upperEntry), "AGENTLINK_TEST_UPPER_ENTRY must be an absolute file path");
    assert.ok(isFile(upperEntry), "AGENTLINK_TEST_UPPER_ENTRY must name an existing file");
  }
  const serverPath = upperEntry ?? join(root, "dist", "index.js");
  assert.ok(isFile(serverPath), "the selected upper MCP entry point must be an existing file");

  const scratch = mkdtempSync(join(tmpdir(), "agentlink-tax-only-integration-"));
  const credentialsPath = join(scratch, "intentionally-missing-credentials.json");
  const childEnv = {
    PATH: process.env.PATH ?? "",
    HOME: scratch,
    TMPDIR: scratch,
    AGENTLINK_TAX_MCP_COMMAND: python,
    AGENTLINK_TAX_MCP_ARGS: JSON.stringify(["-I", "-B", "-m", "agentlink_tax.server"]),
    AGENTLINK_CREDENTIALS_PATH: credentialsPath,
  };
  if (registry !== undefined) childEnv.AGENTLINK_TAX_REGISTRY = registry;
  const upperTransport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: scratch,
    stderr: "pipe",
    env: childEnv,
  });
  const nativeEnv = {
    PATH: process.env.PATH ?? "",
    HOME: scratch,
    TMPDIR: scratch,
    AGENTLINK_CREDENTIALS_PATH: credentialsPath,
  };
  if (registry !== undefined) nativeEnv.AGENTLINK_TAX_REGISTRY = registry;
  const nativeTransport = new StdioClientTransport({
    command: python,
    args: ["-I", "-B", "-m", "agentlink_tax.server"],
    cwd: scratch,
    stderr: "pipe",
    env: nativeEnv,
  });
  const upperClient = new Client({ name: "agentlink-tax-upper-integration", version: "0.1.0" });
  const nativeClient = new Client({ name: "agentlink-tax-native-integration", version: "0.1.0" });
  let upperStderr = "";
  let nativeStderr = "";
  const captureStderr = (transport, setText) => transport.stderr?.on("data", (chunk) => {
    if (setText.value.length < STDERR_LIMIT) {
      setText.value += String(chunk).slice(0, STDERR_LIMIT - setText.value.length);
    }
  });
  const upperStderrCapture = { get value() { return upperStderr; }, set value(value) { upperStderr = value; } };
  const nativeStderrCapture = { get value() { return nativeStderr; }, set value(value) { nativeStderr = value; } };
  captureStderr(upperTransport, upperStderrCapture);
  captureStderr(nativeTransport, nativeStderrCapture);

  let passed = false;
  try {
    await Promise.all([
      upperClient.connect(upperTransport),
      nativeClient.connect(nativeTransport),
    ]);

    const callSurface = async (client, name, args = {}) => {
      const response = await client.callTool({ name, arguments: args });
      assert.notEqual(response.isError, true, `${name} returned an MCP error: ${JSON.stringify(response)}`);
      assert.ok(response.structuredContent && typeof response.structuredContent === "object",
        `${name} must preserve structuredContent`);
      const text = response.content?.find((item) => item.type === "text")?.text;
      assert.equal(typeof text, "string", `${name} must preserve its text result`);
      assert.deepEqual(JSON.parse(text), response.structuredContent,
        `${name} text and structuredContent should carry the same domain result`);
      return response.structuredContent;
    };
    const call = (name, args = {}) => callSurface(upperClient, name, args);
    const callNative = (name, args = {}) => callSurface(nativeClient, name, args);

    const [{ tools }, { tools: nativeTools }] = await Promise.all([
      upperClient.listTools(),
      nativeClient.listTools(),
    ]);
    const names = tools.map((tool) => tool.name);
    const nativeNames = nativeTools.map((tool) => tool.name);
    const taxNames = names.filter((name) => name.startsWith("tax_"));
    const bridgeStatus = await call("agentlink_bridge_status");
    assert.equal(taxNames.length, 22,
      `all mapped tax tools should be exposed after real child discovery; status=${JSON.stringify(bridgeStatus)}; tools=${names.join(",")}`);
    for (const name of ["tax_route_question", "tax_health"]) {
      assert.ok(names.includes(name), `missing required ${name}`);
    }
    const lawArticleTool = tools.find((tool) => tool.name === "tax_get_law_article");
    assert.ok(lawArticleTool, "the public law article tool should be advertised");
    assert.deepEqual(lawArticleTool.inputSchema.properties.lookup_basis.enum, ["promulgation", "effective"]);
    assert.ok(!lawArticleTool.inputSchema.required?.includes("lookup_basis"),
      "lookup_basis remains optional in the installed upper contract");
    const nativeLawArticleTool = nativeTools.find((tool) => tool.name === "get_law_article");
    assert.ok(nativeLawArticleTool, "the native law article tool should be advertised");
    assert.deepEqual(nativeLawArticleTool.inputSchema.properties.lookup_basis.enum, ["promulgation", "effective"]);
    assert.ok(!nativeLawArticleTool.inputSchema.required?.includes("lookup_basis"),
      "lookup_basis remains optional in the native contract");
    for (const name of ["tax_list_workflows", "tax_get_workflow_contract", "tax_plan_work", "tax_route_question", "tax_health"]) {
      assert.ok(names.includes(name), `missing ${name}`);
    }
    for (const name of ["list_tax_workflows", "get_workflow_contract", "plan_tax_work", "route_tax_question", "health",
      "answer_practitioner_question", "get_law_article"]) {
      assert.ok(nativeNames.includes(name), `native tools/list is missing ${name}`);
    }
    assert.ok(names.includes("agentlink_bridge_status"), "the bridge status tool should remain available");
    assert.ok(names.every((name) => name === "agentlink_bridge_status" || name.startsWith("tax_")),
      "default startup should expose only verified tax tools and bridge status");
    assert.ok(!names.some((name) => name.startsWith("subsidy_")), "the optional subsidy domain must stay absent");
    const draftBundleTool = tools.find((tool) => tool.name === "tax_create_draft_bundle");
    assert.ok(draftBundleTool, "the public draft bundle tool must be advertised after child discovery");
    assert.deepEqual(draftBundleTool.inputSchema.required?.slice().sort(), ["draft", "matter"]);
    assert.deepEqual(Object.keys(draftBundleTool.inputSchema.properties).sort(), ["draft", "matter"]);
    assert.notEqual(draftBundleTool.inputSchema.properties.matter.additionalProperties, false,
      "the upper contract must pass through future matter fields");
    assert.notEqual(draftBundleTool.inputSchema.properties.draft.additionalProperties, false,
      "the upper contract must pass through the versioned draft object intact");
    assert.deepEqual(draftBundleTool.annotations, {
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    const nativeDraftBundleTool = nativeTools.find((tool) => tool.name === "create_tax_draft_bundle");
    assert.ok(nativeDraftBundleTool, "the native draft bundle tool must be advertised");
    assert.deepEqual(nativeDraftBundleTool.inputSchema.required?.slice().sort(), ["draft", "matter"]);
    assert.deepEqual(nativeDraftBundleTool.annotations, {
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });

    if (draftFixtureDir !== undefined || required) {
      assert.ok(draftFixtureDir && isAbsolute(draftFixtureDir) && isDirectory(draftFixtureDir),
        "AGENTLINK_TEST_TAX_DRAFT_FIXTURES must name an absolute directory");
      const fixtureInputs = [
        ["vat", readDraftFixture("draft-vat.json")],
        ["corporate", readDraftFixture("draft-corporate.json")],
        ["withholding", readDraftFixture("draft-withholding.json")],
      ];
      const expected = readDraftFixture("expected.json");
      for (const [caseName, fixture] of fixtureInputs) {
        const args = { matter: fixture.matter, draft: fixture.draft };
        const [nativeResult, upperResult] = await Promise.all([
          callNative("create_tax_draft_bundle", args),
          call("tax_create_draft_bundle", args),
        ]);
        assert.deepEqual(upperResult, nativeResult,
          `${caseName} upper result must preserve the actual installed native result`);
        assertDraftExports(nativeResult);
        assertDraftExports(upperResult);
        assert.equal(upperResult.report.tier, "public");
        assert.deepEqual(upperResult.report.insights_included, []);

        if (caseName === "vat") {
          assert.equal(upperResult.kind, "vat_purchase");
          assert.equal(upperResult.workflow_id, "vat-return");
          assert.equal(upperResult.focus_id, "purchase-review");
          assert.equal(upperResult.draft.summary.supply_amount.value, expected.vat.supply_amount.value);
          assert.equal(upperResult.draft.summary.supply_amount.supplied_subtotal.value,
            expected.vat.supply_amount.supplied_subtotal);
          assert.equal(upperResult.draft.summary.vat_amount.value, expected.vat.vat_amount.value);
          assert.equal(upperResult.draft.summary.vat_amount.supplied_subtotal.value,
            expected.vat.vat_amount.supplied_subtotal);
          assert.equal(upperResult.draft.summary.vat_amount.missing_count, expected.vat.vat_amount.missing_count);
          assert.deepEqual(upperResult.draft.summary.vat_amount.supplied_subtotal.provenance.input_refs,
            expected.vat.vat_input_refs);
          const vatRows = Object.fromEntries(upperResult.draft.rows.map((row) => [row.row_id, row]));
          assert.equal(vatRows["v-b"].vat_amount.value, null, "null VAT must remain missing rather than zero");
          assert.equal(vatRows["v-b"].vat_amount.status, "missing");
          assert.equal(vatRows["v-c"].supply_amount.value, "0", "explicit zero must survive the upper bridge");
          assert.equal(vatRows["v-d"].supply_amount.value, "-25.5", "signed corrections must survive the upper bridge");
          assert.deepEqual(vatRows["v-a"].supply_amount.provenance.input_refs, ["rows[v-a].supply_amount"]);
          assert.deepEqual(vatRows["v-a"].supply_amount.provenance.evidence_refs, ["ev-a"]);
          const { csvHeaders, csvRows } = assertDraftExports(upperResult);
          assert.equal(csvHeaders[0], "row_kind");
          assert.equal(csvRows.filter((row) => row.row_kind === "data").length, 4);
          assert.equal(csvRows.filter((row) => row.row_kind === "summary").length, 2);
          const vatMissingRow = csvRows.find((row) => row.row_id === "v-b");
          assert.equal(vatMissingRow.vat_amount, "");
          assert.ok(vatMissingRow.missing_fields.includes("vat_amount"),
            "CSV must explicitly identify null VAT values as missing");
          assert.equal(csvRows.find((row) => row.row_id === "v-c").supply_amount, "0");
          assert.ok(csvRows.find((row) => row.row_id === "v-a").evidence_refs.includes("ev-a"),
            "CSV must retain row evidence references");
          const vatSummary = csvRows.find((row) => row.summary_field === "vat_amount");
          assert.equal(vatSummary.summary_value, "");
          assert.equal(vatSummary.summary_missing_count, String(expected.vat.vat_amount.missing_count));
          assert.equal(vatSummary.contributing_row_ids, "v-a;v-c;v-d");
        } else if (caseName === "corporate") {
          assert.equal(upperResult.kind, "corporate_reconciliation");
          assert.equal(upperResult.workflow_id, "corporate-adjustment");
          assert.equal(upperResult.focus_id, "closing-reconciliation");
          const summary = upperResult.draft.summary;
          for (const key of ["comparable_count", "incomplete_count", "nonzero_difference_count", "review_status",
            "differences_unresolved"]) {
            assert.equal(summary[key], expected.corporate[key], `corporate ${key} expectation mismatch`);
          }
          assert.equal(summary.comparable_difference_sum.value, expected.corporate.comparable_difference_sum);
          assert.equal(summary.absolute_difference_sum.value, expected.corporate.absolute_difference_sum);
          assert.equal(upperResult.draft.book_verification, "user_supplied_unverified");
          const corporateRows = Object.fromEntries(upperResult.draft.rows.map((row) => [row.row_id, row]));
          assert.equal(corporateRows["c-a"].difference.value, "10");
          assert.equal(corporateRows["c-b"].difference.value, "-10");
          assert.equal(corporateRows["c-c"].difference.value, null);
          assert.equal(corporateRows["c-c"].comparison_status, "incomplete");
          assert.equal(corporateRows["c-z"].difference.value, "0");
          assert.equal(corporateRows["c-z"].comparison_status, "equal_unverified");
          assert.deepEqual(corporateRows["c-a"].difference.provenance.input_refs,
            ["rows[c-a].ledger_amount", "rows[c-a].return_amount"]);
          assert.deepEqual(corporateRows["c-a"].difference.provenance.evidence_refs, ["ev-corp-a"]);
          const { csvHeaders, csvRows } = assertDraftExports(upperResult);
          assert.equal(csvHeaders[0], "row_kind");
          assert.equal(csvRows.filter((row) => row.row_kind === "data").length, 4);
          const corporateCsvRows = Object.fromEntries(csvRows.filter((row) => row.row_kind === "data")
            .map((row) => [row.row_id, row]));
          assert.equal(corporateCsvRows["c-a"].difference, "10");
          assert.equal(corporateCsvRows["c-b"].difference, "-10");
          assert.equal(corporateCsvRows["c-c"].difference, "");
          assert.ok(corporateCsvRows["c-c"].missing_fields.includes("return_amount"),
            "CSV must explicitly identify incomplete corporate amounts");
          assert.equal(corporateCsvRows["c-z"].difference, "0");
          const corporateSummary = Object.fromEntries(csvRows.filter((row) => row.row_kind === "summary")
            .map((row) => [row.summary_field, row]));
          assert.equal(corporateSummary.comparable_difference_sum.summary_value,
            expected.corporate.comparable_difference_sum);
          assert.equal(corporateSummary.absolute_difference_sum.summary_value,
            expected.corporate.absolute_difference_sum);
          assert.equal(corporateSummary.absolute_difference_sum.contributing_row_ids, "c-a;c-b;c-z");
        } else {
          assert.equal(upperResult.kind, "withholding");
          assert.equal(upperResult.workflow_id, "withholding-payment");
          assert.equal(upperResult.focus_id, null);
          assert.deepEqual(upperResult.draft.summary, {
            sheet_count: expected.withholding.sheet_count,
            payment_count: expected.withholding.payment_count,
          });
          assert.deepEqual(upperResult.draft.rows, []);
          const a01 = upperResult.draft.filling_guide.flatMap((sheet) => sheet.rows)
            .find((row) => row.code === "A01");
          assert.ok(a01, "withholding should reuse the existing A01 filling guide");
          const cells = Object.fromEntries(a01.cells.map((cell) => [cell.column, cell]));
          assert.equal(cells["⑤총지급액"].value, expected.withholding.a01_gross);
          assert.equal(cells["④인원"].value, expected.withholding.a01_headcount);
          assert.equal(cells["⑥징수세액-소득세 등"].value, expected.withholding.a01_withheld);
          assert.equal(cells["⑥징수세액-소득세 등"].status, expected.withholding.a01_withheld_status);
          assert.deepEqual(cells["⑤총지급액"].provenance.fact_refs,
            expected.withholding.a01_gross_payment_ids);
          const { csvHeaders, csvRows } = assertDraftExports(upperResult);
          assert.deepEqual(csvHeaders,
            ["sheet_id", "row_id", "payment_ids", "column", "value", "status", "unit", "flags"]);
          assert.ok(csvRows.every((row) => !Object.hasOwn(row, "row_kind")));
          const grossCsv = csvRows.find((row) => row.column === "⑤총지급액");
          assert.equal(grossCsv.value, expected.withholding.a01_gross);
          assert.equal(grossCsv.payment_ids, expected.withholding.a01_gross_payment_ids.join(";"));
          const withheldCsv = csvRows.find((row) => row.column === "⑥징수세액-소득세 등");
          assert.equal(withheldCsv.value, "");
          assert.equal(withheldCsv.status, expected.withholding.a01_withheld_status);
        }
      }

      const vatFixture = readDraftFixture("draft-vat.json");
      vatFixture.draft.rows[0].evidence_refs = ["missing-evidence"];
      const malformedArgs = { matter: vatFixture.matter, draft: vatFixture.draft };
      const [nativeMalformed, upperMalformed] = await Promise.all([
        callNative("create_tax_draft_bundle", malformedArgs),
        call("tax_create_draft_bundle", malformedArgs),
      ]);
      assert.deepEqual(upperMalformed, nativeMalformed,
        "malformed references must fail identically across native and upper surfaces");
      assert.deepEqual(upperMalformed, {
        error: "invalid_input", field: "draft", code: "invalid_reference",
      });
      assert.ok(!Object.hasOwn(upperMalformed, "draft") && !Object.hasOwn(upperMalformed, "exports"),
        "malformed reference errors must not include partial artifacts");
    }

    const plan = (taxMatter) => call("tax_plan_work", { matter: taxMatter, include_evidence: false });
    const planNative = (taxMatter) => callNative("plan_tax_work", { matter: taxMatter, include_evidence: false });

    const [workflowList, nativeWorkflowList] = await Promise.all([
      call("tax_list_workflows"),
      callNative("list_tax_workflows"),
    ]);
    const [health, nativeHealth] = await Promise.all([call("tax_health"), callNative("health")]);
    assert.deepEqual(health, nativeHealth, "upper health should preserve native health fields");
    assert.equal(health.status, "ok");
    assert.ok(Number.isInteger(health.workflows));
    const question = "부가세 매입 세금계산서 검토";
    const [route, nativeRoute] = await Promise.all([
      call("tax_route_question", { question }),
      callNative("route_tax_question", { question }),
    ]);
    assert.deepEqual(route, nativeRoute, "upper question routing should preserve the native result");
    assert.equal(route.status, "matched");
    assert.equal(route.candidates[0]?.workflow_id, "vat-return");
    assert.equal(workflowList.domain, "tax");
    assertWorkflowMatrix(workflowList.workflows);
    assertWorkflowMatrix(nativeWorkflowList.workflows);
    const workflowProjection = ({ workflows }) => workflows.map(({ id, status, capabilities }) => ({
      id, status, capabilities,
    }));
    assert.deepEqual(workflowProjection(nativeWorkflowList), workflowProjection(workflowList),
      "native and upper workflow status/capability matrices should match");
    const contractOnly = workflowList.workflows.filter((item) => item.status === "contract_only");
    assert.equal(contractOnly.length, 10);
    assert.ok(contractOnly.some((item) => item.id === "vat-return"), "VAT remains contract-only");

    const nativeContracts = new Map();
    const upperContracts = new Map();
    for (const expected of WORKFLOW_EXPECTATIONS) {
      const [nativeContract, upperContract] = await Promise.all([
        callNative("get_workflow_contract", { workflow_id: expected.id }),
        call("tax_get_workflow_contract", { workflow_id: expected.id }),
      ]);
      for (const [surface, workflowContract] of [["native", nativeContract], ["upper", upperContract]]) {
        assert.equal(workflowContract.id, expected.id, `${surface} ${expected.id} contract ID mismatch`);
        assert.equal(workflowContract.status, expected.status,
          `${surface} ${expected.id} contract status mismatch`);
        assert.deepEqual(workflowContract.capabilities, expected.capabilities,
          `${surface} ${expected.id} contract capabilities mismatch`);
        if (expected.status === "contract_only") {
          assert.equal(workflowContract.guidance_contract?.schema, "tax-task-guidance.v1",
            `${surface} ${expected.id} guidance contract schema mismatch`);
          assert.deepEqual(workflowContract.guidance_contract?.available_focus_ids,
            FOCUS_EXPECTATIONS.filter((item) => item.workflow_id === expected.id).map((item) => item.focus),
            `${surface} ${expected.id} guidance focus contract mismatch`);
        }
      }
      assert.equal(nativeContract.status, upperContract.status,
        `${expected.id} contract status should match across surfaces`);
      assert.deepEqual(nativeContract.capabilities, upperContract.capabilities,
        `${expected.id} contract capabilities should match across surfaces`);
      nativeContracts.set(expected.id, nativeContract);
      upperContracts.set(expected.id, upperContract);
    }
    const [contract, nativeContract] = [upperContracts.get("withholding-payment"), nativeContracts.get("withholding-payment")];
    assert.equal(contract.id, "withholding-payment");
    assert.equal(contract.status, "implemented");
    assert.deepEqual(nativeContract.facts_schema, contract.facts_schema,
      "the upper bridge should preserve the native withholding facts schema");
    const paymentRef = contract.facts_schema?.properties?.payments?.items?.$ref;
    assert.match(paymentRef ?? "", /^#\/\$defs\//,
      "the upper bridge should preserve the native payment schema reference");
    const paymentSchemaName = paymentRef.slice("#/$defs/".length);
    const paymentProperties = contract.facts_schema?.$defs?.[paymentSchemaName]?.properties;
    assert.ok(paymentProperties, "the upper bridge should preserve the native Payment definition");
    assert.deepEqual([...(paymentProperties.withholding_profile?.enum ?? [])].sort(), [
      "business_lecture", "business_personal_service", "other_lecture", "other_personal_service", "unknown",
    ], "the upper contract should preserve the bounded payment-profile enum");
    assert.deepEqual([...(paymentProperties.service_subtype?.enum ?? [])].sort(), [
      "artwork_design", "authorship", "composition", "entertainment_direction", "entertainment_filming",
      "illustration", "proofreading", "shorthand", "translation", "unknown", "unsupported", "voice_acting",
    ], "the upper contract should preserve the strict personal-service subtype enum");
    assert.deepEqual([...(paymentProperties.other_service_subtype?.enum ?? [])].sort(), [
      "broadcast_commentary", "expert_advisory", "manuscript_fee", "unknown", "unsupported",
    ], "the upper contract should preserve the strict temporary-service subtype enum");

    const practiceCards = await call("tax_list_practice_cards", { workflow_id: "withholding-payment" });
    assert.equal(practiceCards.workflow_id, "withholding-payment");
    assert.equal(practiceCards.authority, "practice");
    assert.equal(practiceCards.verification_status, "practice_signal_unverified");
    assert.ok(Array.isArray(practiceCards.cards));

    const formTips = await call("tax_get_form_field_tips", { form_id: "wh-payment-report", code: "A25" });
    assert.ok(JSON.stringify(formTips).includes("A25"));
    const formGuides = await call("tax_list_form_guides");
    assert.equal(formGuides.status, "ok");
    assert.ok(Array.isArray(formGuides.guides));

    const missingFacts = await plan({
      matter_id: "p0-test",
      workflow_id: "withholding-payment",
      as_of: "2026-04-01",
      facts: { payments: [] },
    });
    assert.equal(missingFacts.status, "needs_facts");
    assert.ok(missingFacts.questions.length > 0);
    assert.ok(missingFacts.questions.some((question) => question.fact_key === "payments"));

    const completed = await plan(matter());
    assert.equal(completed.status, "draft_ready");
    assert.equal(completed.applicability, "not_determined");
    assert.equal(completed.calculation_status, "not_determined");
    assert.equal(completed.withholding_calculations.length, 1);
    assert.equal(completed.withholding_calculations[0].status, "unsupported",
      "a wage payment with no lecture profile remains outside the calculation scope");
    for (const field of ["expense_rate", "expense_amount", "income_amount", "tax_base", "national_rate",
      "national_tax", "local_rate", "local_tax", "total_withholding", "net_payment"]) {
      assert.equal(completed.withholding_calculations[0][field], null,
        `unsupported wage payments must not contain a calculated ${field}`);
    }
    const dueActions = completed.next_actions.filter((action) => action.due_date);
    assert.equal(dueActions.length, 1);
    assert.equal(dueActions[0].due_date, "2026-04-10");
    assert.equal(dueActions[0].due_basis, "WH-PAY-MONTHLY");
    assert.equal(dueActions[0].deadline_status, "candidate_unverified");
    assert.match(dueActions[0].holiday_adjustment, /weekend_and_statutory_may1_fallback/);
    assert.match(dueActions[0].holiday_adjustment, /public\/substitute holidays not applied/);
    assert.ok(completed.unresolved.some((item) => item.code === "HOLIDAY_DATA_UNAVAILABLE"),
      "the unavailable holiday-provider warning should survive the bridge");
    assert.ok(Array.isArray(completed.filling_guide) && completed.filling_guide.length > 0,
      "the default filling guide should remain enabled");
    assert.ok(Array.isArray(completed.sources) && completed.sources.length > 0);
    assert.ok(completed.sources.every((source) => source.verification_status !== "verified"));
    assert.ok(Array.isArray(completed.why) && completed.why.length > 0);
    assert.ok(completed.why.some((item) => item.verification_status === "text_checked"));
    assert.ok(completed.why.every((item) => ["text_checked", "unverified_seed"].includes(item.verification_status)));
    assert.ok(completed.confirmed_facts.every((fact) => fact.verification === "user_supplied_unverified"));
    assert.deepEqual(completed.evidence_candidates, [], "include_evidence=false should avoid external evidence lookup");

    const practitionerAnswer = await call("tax_answer_practitioner_question", { matter: matter() });
    assert.equal(practitionerAnswer.schema_version, "practitioner-answer.v1");
    assert.equal(practitionerAnswer.final_decision, "not_issued");

    const missingWithheldAmount = await plan(matter({ payments: [payment({ withheld_amount: null })] }));
    assert.equal(missingWithheldAmount.status, "needs_facts");
    assert.ok(missingWithheldAmount.questions.some((question) => question.fact_key === "payments[p1].withheld_amount"));
    const paymentFacts = missingWithheldAmount.confirmed_facts.find((fact) => fact.key === "payments");
    assert.equal(paymentFacts.value[0].withheld_amount, null);
    assert.equal(missingWithheldAmount.withholding_calculations[0].status, "unsupported");
    assert.equal(missingWithheldAmount.withholding_calculations[0].national_tax, null,
      "legacy wage rows must not receive lecture calculation amounts");

    const unknownApproval = await plan(matter({ approval: null }));
    assert.equal(unknownApproval.status, "needs_facts");
    assert.ok(unknownApproval.questions.some((question) =>
      question.fact_key === "taxpayer.small_business_semiannual_approval"));
    assert.ok(!unknownApproval.next_actions.some((action) => action.due_date),
      "no due-date candidate should be offered until the approval fact is known");

    const nonresident = await plan(matter({ payments: [payment({ payee_type: "nonresident" })] }));
    assert.equal(nonresident.status, "blocked");
    assert.ok(nonresident.unresolved.some((item) => item.code === "NONRESIDENT_PAYMENT_REVIEW"));
    assert.ok(!nonresident.next_actions.some((action) => action.due_date));

    const guidanceMatter = (workflowId, focus) => ({
      matter_id: `review-${workflowId}-${focus ?? "overview"}`,
      workflow_id: workflowId,
      as_of: "2026-04-01",
      facts: focus ? { guidance_focus: focus } : {},
    });
    const assertPreparationPlan = (result, workflowId, focusIds, expectedFocusRows) => {
      assert.equal(result.status, "contract_only", `${workflowId} should remain guidance-only`);
      assert.ok(result.unresolved.some((item) => item.code === "WORKFLOW_NOT_IMPLEMENTED"));
      assert.deepEqual(result.why, []);
      assert.ok(Array.isArray(result.next_actions) && result.next_actions.length > 0,
        `${workflowId} must retain preparation next_actions`);
      assert.ok(!result.withholding_calculations?.length,
        `${workflowId} must not produce withholding calculations`);
      assert.deepEqual(result.task_guidance.selected_focus_ids, focusIds,
        `${workflowId} selected focus mismatch`);
      assert.deepEqual(result.task_guidance.capabilities, GUIDANCE_CAPABILITIES,
        `${workflowId} guidance capabilities mismatch`);
      assert.deepEqual(result.task_guidance.sources.map((source) => ({ law_id: source.law_id, article: source.locator })),
        expectedFocusRows.map(({ law_id, article }) => ({ law_id, article })),
        `${workflowId} guidance source mapping mismatch`);
    };
    const assertPlanPair = (nativePlan, upperPlan, context) => {
      assert.equal(nativePlan.status, upperPlan.status, `${context} plan status should match across surfaces`);
      assert.deepEqual(nativePlan.task_guidance.capabilities, upperPlan.task_guidance.capabilities,
        `${context} plan capabilities should match across surfaces`);
      assert.deepEqual(nativePlan.task_guidance.selected_focus_ids, upperPlan.task_guidance.selected_focus_ids,
        `${context} plan focus IDs should match across surfaces`);
    };
    const assertPractitionerGuidance = (answer, expectedFocusRow, context, toolName, toolNames) => {
      assert.equal(answer.schema_version, "practitioner-answer.v1");
      assert.equal(answer.final_decision, "not_issued");
      assert.equal(answer.applicability, "not_determined");
      assert.ok(Array.isArray(answer.next_actions) && answer.next_actions.length > 0,
        `${context} must retain practitioner next_actions`);
      const articleAction = answer.next_actions.find((action) => action.tool?.name === toolName);
      assert.ok(articleAction, `${context} should expose root action ${toolName}`);
      assert.ok(toolNames.includes(toolName), `${context} selected tool must appear in its surface's tools/list`);
      const args = articleAction.tool.arguments;
      assert.ok(args && typeof args === "object" && !Array.isArray(args), `${context} action arguments must be an object`);
      assert.deepEqual(Object.keys(args).sort(), ["article", "law_id", "law_name", "lookup_basis"],
        `${context} must preserve exactly the four lookup arguments`);
      assert.equal(typeof args.law_name, "string");
      assert.ok(args.law_name.length > 0, `${context} law name must be present`);
      assert.equal(args.law_id, expectedFocusRow.law_id, `${context} law ID mismatch`);
      assert.equal(args.article, expectedFocusRow.article, `${context} article mismatch`);
      assert.equal(args.lookup_basis, "effective", `${context} lookup basis mismatch`);
      return { name: articleAction.tool.name, arguments: args };
    };
    const assertPractitionerPair = async (nativeAnswer, upperAnswer, expectedFocusRow, context) => {
      const nativeAction = assertPractitionerGuidance(
        nativeAnswer, expectedFocusRow, `${context} native`, "get_law_article", nativeNames,
      );
      const upperAction = assertPractitionerGuidance(
        upperAnswer, expectedFocusRow, `${context} upper`, "tax_get_law_article", names,
      );
      assert.deepEqual(nativeAction.arguments, upperAction.arguments,
        `${context} lookup arguments should match across surfaces`);
      assert.equal(nativeAnswer.final_decision, upperAnswer.final_decision,
        `${context} practitioner decision status should match across surfaces`);
      assert.equal(nativeAnswer.applicability, upperAnswer.applicability,
        `${context} practitioner applicability should match across surfaces`);
      const [nativeLookup, upperLookup] = await Promise.all([
        callNative(nativeAction.name, nativeAction.arguments),
        call(upperAction.name, upperAction.arguments),
      ]);
      assert.equal(nativeLookup.status, "credential_missing", `${context} native lookup should be credential-gated`);
      assert.equal(upperLookup.status, "credential_missing", `${context} upper lookup should be credential-gated`);
    };

    const expectedGuidanceWorkflows = WORKFLOW_EXPECTATIONS.filter((item) => item.status === "contract_only");
    for (const workflow of expectedGuidanceWorkflows) {
      const expectedFocusRows = FOCUS_EXPECTATIONS.filter((item) => item.workflow_id === workflow.id);
      assert.equal(expectedFocusRows.length, 2, `${workflow.id} should have two independent focus expectations`);

      const overviewMatter = guidanceMatter(workflow.id);
      const [overviewPlan, nativeOverviewPlan] = await Promise.all([
        plan(overviewMatter), planNative(overviewMatter),
      ]);
      assertPreparationPlan(overviewPlan, workflow.id, expectedFocusRows.map(({ focus }) => focus), expectedFocusRows);
      assertPreparationPlan(nativeOverviewPlan, workflow.id, expectedFocusRows.map(({ focus }) => focus), expectedFocusRows);
      assertPlanPair(nativeOverviewPlan, overviewPlan, `${workflow.id} overview`);
      const [overviewAnswer, nativeOverviewAnswer] = await Promise.all([
        call("tax_answer_practitioner_question", { matter: overviewMatter, include_evidence: false }),
        callNative("answer_practitioner_question", { matter: overviewMatter, include_evidence: false }),
      ]);
      await assertPractitionerPair(nativeOverviewAnswer, overviewAnswer, expectedFocusRows[0], `${workflow.id} overview`);

      for (const focusRow of expectedFocusRows) {
        const focusMatter = guidanceMatter(workflow.id, focusRow.focus);
        const [focusPlan, nativeFocusPlan] = await Promise.all([
          plan(focusMatter), planNative(focusMatter),
        ]);
        assertPreparationPlan(focusPlan, workflow.id, [focusRow.focus], [focusRow]);
        assertPreparationPlan(nativeFocusPlan, workflow.id, [focusRow.focus], [focusRow]);
        assertPlanPair(nativeFocusPlan, focusPlan, `${workflow.id}/${focusRow.focus}`);
        const [focusAnswer, nativeFocusAnswer] = await Promise.all([
          call("tax_answer_practitioner_question", { matter: focusMatter, include_evidence: false }),
          callNative("answer_practitioner_question", { matter: focusMatter, include_evidence: false }),
        ]);
        await assertPractitionerPair(
          nativeFocusAnswer, focusAnswer, focusRow, `${workflow.id}/${focusRow.focus}`,
        );
      }
    }

    const unknownMatter = {
      matter_id: "p0-test",
      workflow_id: "p0-unknown-workflow",
      as_of: "2026-04-01",
    };
    const [unknownWorkflow, nativeUnknownWorkflow] = await Promise.all([
      plan(unknownMatter), planNative(unknownMatter),
    ]);
    assert.equal(unknownWorkflow.status, "invalid_input");
    assert.equal(nativeUnknownWorkflow.status, "invalid_input");
    assert.equal(nativeUnknownWorkflow.status, unknownWorkflow.status,
      "unknown workflow errors should match across surfaces");
    const [unknownAnswer, nativeUnknownAnswer] = await Promise.all([
      call("tax_answer_practitioner_question", { matter: unknownMatter, include_evidence: false }),
      callNative("answer_practitioner_question", { matter: unknownMatter, include_evidence: false }),
    ]);
    assert.equal(unknownAnswer.error, "invalid_input");
    assert.equal(nativeUnknownAnswer.error, "invalid_input");
    assert.equal(nativeUnknownAnswer.field, unknownAnswer.field,
      "unknown workflow answer errors should match across surfaces");
    const invalidFocusMatter = guidanceMatter("vat-return", "unsupported-focus");
    const [invalidFocus, nativeInvalidFocus] = await Promise.all([
      plan(invalidFocusMatter), planNative(invalidFocusMatter),
    ]);
    assert.equal(invalidFocus.status, "invalid_input");
    assert.equal(nativeInvalidFocus.status, "invalid_input");
    assert.equal(nativeInvalidFocus.status, invalidFocus.status,
      "invalid focus errors should match across surfaces");
    const [invalidFocusAnswer, nativeInvalidFocusAnswer] = await Promise.all([
      call("tax_answer_practitioner_question", { matter: invalidFocusMatter, include_evidence: false }),
      callNative("answer_practitioner_question", { matter: invalidFocusMatter, include_evidence: false }),
    ]);
    assert.equal(invalidFocusAnswer.error, "invalid_input");
    assert.equal(nativeInvalidFocusAnswer.error, "invalid_input");
    assert.equal(invalidFocusAnswer.code, "unsupported_guidance_focus");
    assert.equal(nativeInvalidFocusAnswer.code, invalidFocusAnswer.code,
      "invalid focus answer errors should match across surfaces");
    passed = true;
  } catch (error) {
    const upperStderrPath = join(scratch, "upper.stderr.log");
    const nativeStderrPath = join(scratch, "native.stderr.log");
    writeFileSync(upperStderrPath, upperStderr || "<no upper-server stderr captured>\n", "utf8");
    writeFileSync(nativeStderrPath, nativeStderr || "<no native-server stderr captured>\n", "utf8");
    if (error instanceof Error) {
      error.message = `${error.message}\nBounded server stderr saved locally at ${upperStderrPath} and ${nativeStderrPath}`;
    }
    throw error;
  } finally {
    await upperClient.close().catch(() => {});
    await upperTransport.close().catch(() => {});
    await nativeClient.close().catch(() => {});
    await nativeTransport.close().catch(() => {});
    if (passed) rmSync(scratch, { recursive: true, force: true });
  }
});
