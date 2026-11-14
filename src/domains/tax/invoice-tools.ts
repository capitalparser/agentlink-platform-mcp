/** Optional owned-invoice preparation tools bridged to the tax domain. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TaxDomainClientLike } from "./bridge.js";
import { isBridgeError } from "./bridge.js";
import type { ToolContract } from "../discovery.js";

type ExpectedAnnotations = NonNullable<ToolContract["expectedAnnotations"]>;

const PREPARE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const LOOKUP_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const requestShape: z.ZodRawShape = {
  request: z.record(z.string(), z.unknown()).describe("Complete owned-invoice request and source provenance envelope"),
};

const requestIdShape: z.ZodRawShape = {
  request_id: z.string().describe("Stable request identifier (고정 요청 ID)"),
};

export interface RegisteredInvoiceTools {
  contracts: ToolContract[];
  handles: RegisteredTool[];
}

function registerOptionalTool(
  server: McpServer,
  client: TaxDomainClientLike,
  name: string,
  domainName: string,
  description: string,
  shape: z.ZodRawShape,
  expectedAnnotations: ExpectedAnnotations,
): { contract: ToolContract; handle: RegisteredTool } {
  const handle = server.tool(name, description, shape, expectedAnnotations, async (args) => {
    const result: CallToolResult = await client.callToolResult(domainName, args as Record<string, unknown>);
    return { ...result, ...(isBridgeError(result.structuredContent) ? { isError: true } : {}) };
  });
  handle.disable();

  return {
    handle,
    contract: {
      publicName: name,
      domainName,
      inputSchema: toJsonSchemaCompat(z.object(shape), { pipeStrategy: "input" }),
      optional: true,
      expectedAnnotations,
    },
  };
}

/** Register the locally backed, optional invoice tools without the generic review-draft notice. */
export function registerInvoiceTools(server: McpServer, client: TaxDomainClientLike): RegisteredInvoiceTools {
  const prepare = registerOptionalTool(
    server,
    client,
    "tax_prepare_invoice",
    "prepare_invoice",
    "Prepare or correct a locally saved invoice request from explicit structured facts and their provenance. This tool does not connect to an invoice provider or issue an invoice (명시적 구조화 사실과 출처 정보로 로컬 세금계산서 요청을 준비·수정합니다. 제공처에 연결하거나 발급하지 않습니다).",
    requestShape,
    PREPARE_ANNOTATIONS,
  );
  const status = registerOptionalTool(
    server,
    client,
    "tax_get_invoice_status",
    "get_invoice_status",
    "Read the saved status and frozen facts for an owned invoice request (저장된 요청 상태와 고정된 사실을 읽습니다).",
    requestIdShape,
    LOOKUP_ANNOTATIONS,
  );
  const handoff = registerOptionalTool(
    server,
    client,
    "tax_get_invoice_handoff",
    "get_invoice_handoff",
    "Read the neutral HomeTax handoff fields for a prepared request. This tool does not control a browser or submit anything (준비된 요청의 중립적인 홈택스 전달 필드를 읽습니다. 브라우저 제어나 제출은 하지 않습니다).",
    requestIdShape,
    LOOKUP_ANNOTATIONS,
  );

  return {
    contracts: [prepare.contract, status.contract, handoff.contract],
    handles: [prepare.handle, status.handle, handoff.handle],
  };
}
