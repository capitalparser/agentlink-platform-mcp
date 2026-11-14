import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server as LowLevelServer } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../../dist/server.js";
import { registerTaxDomainTools } from "../../dist/domains/tax/tools.js";
import { discoverAndVerifyTools } from "../../dist/domains/discovery.js";

const annotations = {
  tax_prepare_invoice: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  tax_get_invoice_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  tax_get_invoice_handoff: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const discoverySchema = {
  type: "object",
  properties: { request_id: { type: "string" } },
  required: ["request_id"],
  additionalProperties: false,
};
const expectedDiscoveryAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

async function discoverThroughSdk(optionalDelta = {}) {
  const contracts = [
    { publicName: "tax_required", domainName: "required", inputSchema: discoverySchema },
    {
      publicName: "tax_optional",
      domainName: "optional",
      inputSchema: discoverySchema,
      optional: true,
      expectedAnnotations: expectedDiscoveryAnnotations,
    },
  ];
  const server = new LowLevelServer({ name: "invoice-sdk-discovery-test", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "required", inputSchema: discoverySchema },
      { name: "optional", inputSchema: discoverySchema, annotations: expectedDiscoveryAnnotations, ...optionalDelta },
    ],
  }));
  const client = new Client({ name: "invoice-sdk-discovery-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return await discoverAndVerifyTools(client, contracts, 1000);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

async function assertSdkRejectsWholeInvalidList(delta, expectedPath) {
  let verified;
  await assert.rejects(
    async () => { verified = await discoverThroughSdk(delta); },
    (error) => {
      assert.ok(error.issues?.some((issue) =>
        issue.code === "invalid_type" && JSON.stringify(issue.path) === JSON.stringify(expectedPath)));
      return true;
    },
  );
  assert.equal(verified, undefined, "protocol-invalid tools/list must return no verified map");
}

function makeTaxClient({ verifiedInvoices = "all" } = {}) {
  let listener = () => {};
  let status = { configured: true, state: "uninitialized", verified_tool_names: [], verified_tool_count: 0 };
  const calls = [];
  let contracts = [];
  const publish = (next) => {
    status = { ...next, verified_tool_names: [...next.verified_tool_names] };
    listener({ ...status, verified_tool_names: [...status.verified_tool_names] });
  };
  return {
    calls,
    get contracts() { return contracts; },
    getStatus() { return { ...status, verified_tool_names: [...status.verified_tool_names] }; },
    setStatusListener(next) { listener = next; listener(this.getStatus()); },
    async initialize(next) {
      contracts = [...next];
      const required = contracts.filter((contract) => !contract.optional).map((contract) => contract.publicName);
      const optional = contracts.filter((contract) => contract.optional).map((contract) => contract.publicName);
      const verified = verifiedInvoices === "all"
        ? [...required, ...optional]
        : [...required, ...optional.filter((name) => verifiedInvoices.includes(name))];
      publish({ configured: true, state: "ready", verified_tool_names: verified, verified_tool_count: verified.length });
      return this.getStatus();
    },
    async refresh(next) { return this.initialize(next ?? contracts); },
    async callTool(name, args) { return (await this.callToolResult(name, args)).structuredContent; },
    async callToolResult(name, args) {
      calls.push([name, args]);
      const structuredContent = { schema_version: "owned-tax-invoice-result.v1", tool: name, args };
      return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
    },
    async close() {},
  };
}

async function openServer(taxDomainClient) {
  const server = await createServer({ taxDomainClient });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "owned-invoice-contract-test", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

function registeredContracts() {
  const source = new McpServer({ name: "owned-invoice-contract-source", version: "1" });
  const client = makeTaxClient();
  return registerTaxDomainTools(source, client).contracts;
}

test("three owned-invoice contracts are optional and verify their pinned schemas and annotations", async () => {
  const contracts = registeredContracts();
  const invoiceContracts = contracts.filter((contract) => contract.optional);
  assert.deepEqual(invoiceContracts.map((contract) => [contract.publicName, contract.domainName]), [
    ["tax_prepare_invoice", "prepare_invoice"],
    ["tax_get_invoice_status", "get_invoice_status"],
    ["tax_get_invoice_handoff", "get_invoice_handoff"],
  ]);
  assert.deepEqual(invoiceContracts.map((contract) => contract.expectedAnnotations), [
    annotations.tax_prepare_invoice,
    annotations.tax_get_invoice_status,
    annotations.tax_get_invoice_handoff,
  ]);

  const childTools = contracts.map((contract) => ({
    name: contract.domainName,
    inputSchema: contract.inputSchema,
    ...(contract.expectedAnnotations ? { annotations: contract.expectedAnnotations } : {}),
  }));
  const verified = await discoverAndVerifyTools({ async listTools() { return { tools: childTools }; } }, contracts, 1000);
  assert.equal(verified.size, contracts.length);

  const noAnnotations = childTools.map((tool) => tool.name === "prepare_invoice" ? { ...tool, annotations: undefined } : tool);
  const withoutPrepared = await discoverAndVerifyTools({ async listTools() { return { tools: noAnnotations }; } }, contracts, 1000);
  assert.equal(withoutPrepared.size, contracts.length - 1);
  assert.equal(withoutPrepared.has("prepare_invoice"), false);
  assert.equal(withoutPrepared.has("get_invoice_status"), true);
  assert.equal(withoutPrepared.has("get_invoice_handoff"), true);
});

test("SDK wire validation rejects optional inputSchema arrays before discovery returns any capabilities", async () => {
  await assertSdkRejectsWholeInvalidList({ inputSchema: [] }, ["tools", 1, "inputSchema"]);
});

test("SDK wire validation rejects null optional annotations before discovery returns any capabilities", async () => {
  await assertSdkRejectsWholeInvalidList({ annotations: null }, ["tools", 1, "annotations"]);
});

test("protocol-valid optional schema, annotation, and missing-annotation mismatches isolate that tool", async () => {
  const schemaMismatch = await discoverThroughSdk({ inputSchema: { ...discoverySchema, required: [] } });
  const annotationMismatch = await discoverThroughSdk({ annotations: { ...expectedDiscoveryAnnotations, readOnlyHint: true } });
  const missingAnnotations = await discoverThroughSdk({ annotations: undefined });
  assert.deepEqual([...schemaMismatch.keys()], ["required"]);
  assert.deepEqual([...annotationMismatch.keys()], ["required"]);
  assert.deepEqual([...missingAnnotations.keys()], ["required"]);
});

test("protocol-valid compatible optional tool is verified alongside the required tool", async () => {
  const verified = await discoverThroughSdk();
  assert.deepEqual([...verified.keys()], ["required", "optional"]);
});

test("enabled tools expose accurate annotations and pass the complete request unchanged", async () => {
  const tax = makeTaxClient();
  const { server, client } = await openServer(tax);
  try {
    const { tools } = await client.listTools();
    for (const [name, expected] of Object.entries(annotations)) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `missing ${name}`);
      assert.deepEqual(tool.annotations, expected);
      assert.doesNotMatch(tool.description, /Results are review drafts|결과는 검토용 초안/);
    }

    const request = {
      request_id: "req.synthetic-01",
      buyer: "가온",
      supply_amount: "1000001",
      write_date: "2026-11-14",
      source: {
        kind: "screenshot",
        reference: "upload-42",
        extraction: "host_model",
        fields: {
          buyer: { evidence: "가온", ambiguous: false },
          supply_amount: { evidence: "공급가액 1,000,001원", ambiguous: false },
          write_date: { evidence: "2026-11-14", ambiguous: false },
        },
      },
      expected_revision: 3,
    };
    const prepared = await client.callTool({ name: "tax_prepare_invoice", arguments: { request } });
    assert.deepEqual(tax.calls.at(-1), ["prepare_invoice", { request }]);
    assert.deepEqual(prepared.structuredContent.args, { request });
    assert.deepEqual(JSON.parse(prepared.content[0].text), prepared.structuredContent);

    const statusArgs = { request_id: request.request_id };
    const status = await client.callTool({ name: "tax_get_invoice_status", arguments: statusArgs });
    assert.deepEqual(tax.calls.at(-1), ["get_invoice_status", statusArgs]);
    assert.deepEqual(status.structuredContent.args, statusArgs);

    const handoff = await client.callTool({ name: "tax_get_invoice_handoff", arguments: statusArgs });
    assert.deepEqual(tax.calls.at(-1), ["get_invoice_handoff", statusArgs]);
    assert.deepEqual(handoff.structuredContent.args, statusArgs);
  } finally {
    await client.close();
    await server.close();
  }
});

test("a missing optional invoice handle stays disabled while verified tools remain available", async () => {
  const tax = makeTaxClient({ verifiedInvoices: ["tax_prepare_invoice"] });
  const { server, client } = await openServer(tax);
  try {
    const { tools } = await client.listTools();
    const taxNames = tools.map((tool) => tool.name).filter((name) => name.startsWith("tax_"));
    assert.equal(taxNames.length, 23);
    assert.ok(taxNames.includes("tax_prepare_invoice"));
    assert.ok(!taxNames.includes("tax_get_invoice_status"));
    assert.ok(!taxNames.includes("tax_get_invoice_handoff"));
    assert.equal(tax.getStatus().state, "ready");
  } finally {
    await client.close();
    await server.close();
  }
});
