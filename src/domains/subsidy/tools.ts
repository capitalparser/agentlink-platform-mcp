/** Read-only, source-preserving subsidy/R&D practitioner bridge. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { isBridgeError, type SubsidyDomainClientLike } from "./bridge.js";
import type { ToolContract } from "../discovery.js";

const NOTICE =
  " Results are drafts for review; applicability is not determined. Official text is a local copy from the National Law Information Center; check public_url for amendments." +
  " (결과는 검토용 초안이며 적용 여부는 판단되지 않습니다. 공식 원문은 국가법령정보센터 로컬 사본이며 개정 여부는 public_url에서 확인하세요.)";
const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const MAX_CONTAINER_DEPTH = 20;
const MAX_ARGUMENT_BYTES = 65_536;
function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function validPayload(args: Record<string, unknown>, rootDepth = 0): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: args, depth: rootDepth }];
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (typeof value === "string") { if (!wellFormed(value)) return false; continue; }
    if (value === null || typeof value !== "object") continue;
    if (depth > MAX_CONTAINER_DEPTH) return false;
    for (const key of Object.keys(value)) {
      if (!wellFormed(key)) return false;
      pending.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
    }
  }
  try { return Buffer.byteLength(JSON.stringify(args), "utf8") <= MAX_ARGUMENT_BYTES; }
  catch { return false; }
}
const unknownPayload = z.unknown().superRefine((value, ctx) => {
  if (!validPayload({ value }, 1)) ctx.addIssue({ code: "custom", message: "Invalid nested payload." });
});
const recordKey = z.string().refine(wellFormed);
const rejectOwnProtoKey = <T extends z.ZodType>(schema: T) => {
  const metadata = toJsonSchemaCompat(schema, { pipeStrategy: "input" });
  delete metadata.$schema;
  return z.preprocess((value, ctx) => {
    if (value !== null && typeof value === "object" && Object.prototype.propertyIsEnumerable.call(value, "__proto__")) {
      ctx.addIssue({ code: "custom", message: "Invalid nested payload." });
      return z.NEVER;
    }
    return value;
  }, schema).meta(metadata);
};

// Python len(str) counts Unicode code points, unlike JavaScript string.length.
const text = (max: number, min = 0) => z.string().refine(
  (v) => wellFormed(v) && Array.from(v).length >= min && Array.from(v).length <= max,
  { message: `Expected ${min}–${max} Unicode code points.` },
);
// (?![\s\S]) is a true end anchor; JS $ also matches before a final newline.
const full = (pattern: string) => z.string().regex(new RegExp(`^(?:${pattern})(?![\\s\\S])`, "u"));
const date = z.string().refine((v) => {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}(?![\s\S])/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}, { message: "Expected an ISO calendar date (YYYY-MM-DD)." });
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable().optional();
const regime = z.enum(["subsidy", "local_gov_subsidy", "national_rnd", "sme_support_general"]);
const context = z.object({
  task: nullable(z.enum(["labor", "travel", "purchasing", "plan_change", "settlement"])),
  role: nullable(z.enum(["applicant", "official", "reviewer", "compliance", "fund_manager", "accountant", "taxpayer", "tax_practitioner"])),
  ministry: nullable(text(100)), project: nullable(text(200)), as_of: nullable(date),
  funding_scheme: nullable(z.enum(["national", "local"])), domain: nullable(text(80)), workflow: nullable(text(100)),
  facts: rejectOwnProtoKey(z.record(recordKey, z.string().refine(wellFormed))).optional(),
}).strict();
const limit = z.number().int().min(1).max(20).default(8);
const facts = rejectOwnProtoKey(z.record(full("[a-z][a-z0-9_]*").refine(wellFormed), text(100)).refine((v) => Object.keys(v).length <= 20,
  { message: "Expected at most 20 fact entries." }));
// Python str.strip whitespace (FEFF is deliberately not included).
const pythonBlank = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*(?![\s\S])/u;

export interface RegisteredSubsidyTools {
  contracts: ToolContract[];
  handles: RegisteredTool[];
}

export function registerSubsidyDomainTools(server: McpServer, client: SubsidyDomainClientLike): RegisteredSubsidyTools {
  const contracts: ToolContract[] = [];
  const handles: RegisteredTool[] = [];
  const reg = (name: string, description: string, shape: z.ZodRawShape,
    validate?: (args: Record<string, unknown>) => boolean) => {
    const publicName = `subsidy_${name}`;
    const handle = server.registerTool(publicName, {
      description: description + NOTICE, inputSchema: z.object(shape).strict(), annotations: ANNOTATIONS,
    }, async (args) => {
      if (!validPayload(args)) return {
        isError: true, content: [{ type: "text" as const, text: "Invalid arguments: payload exceeds supported limits or contains malformed text." }],
      };
      // Cross-field constraints stay here so the published input schema remains
      // an object schema supported by MCP clients and the SDK's schema exporter.
      if (validate && !validate(args)) return {
        isError: true, content: [{ type: "text" as const, text: "Invalid arguments: provide exactly one of article_key or search." }],
      };
      const result = await client.callToolResult(name, args);
      return { ...result, ...(isBridgeError(result.structuredContent) ? { isError: true } : {}) };
    });
    handle.disable();
    handles.push(handle);
    contracts.push({ publicName, domainName: name, inputSchema: toJsonSchemaCompat(z.object(shape), { pipeStrategy: "input" }) });
  };
  reg("list_workflows", "List subsidy/R&D workflows and context fields.", {});
  reg("get_reference_bundle", "Get reference candidates, drafting templates and missing context.", {
    query: text(2000, 1), context, limit, matter: nullable(rejectOwnProtoKey(z.record(recordKey, unknownPayload))),
  });
  reg("search_references", "Search stored regulation excerpts; matches are candidates.", {
    query: text(2000, 1), context: nullable(context), limit,
  });
  reg("get_reference", "Get a stored reference and its provenance.", { reference_id: z.string().refine(wellFormed) });
  reg("answer_practitioner_question", "Answer a practitioner question. Present next_actions. To invoke a selected next action, prefix its supported domain tool name with subsidy_ (answer_practitioner_question -> subsidy_answer_practitioner_question; get_official_text -> subsidy_get_official_text). Replace $conversation_state with the exact previous response state and $answer with the user answer, preserve remaining arguments and state, and add followed_action_id: action.action_id (na.NN). Do not add followed_action_id to get_official_text. 선택한 다음 작업을 호출할 때 지원되는 도메인 도구 이름 앞에 subsidy_를 붙이세요. $conversation_state는 직전 응답의 상태로, $answer는 사용자 답변으로 바꾸고 나머지 인수와 상태를 보존한 뒤 followed_action_id에 action.action_id(na.NN)를 전달하세요. get_official_text에는 followed_action_id를 추가하지 마세요.", {
    question: text(500, 1), perspective: nullable(z.enum(["recipient", "verifier"])), regime: nullable(regime),
    stage: nullable(text(80)), as_of: nullable(date), facts: nullable(facts),
    need_id: nullable(text(120).and(full("pn\\.[a-z_]+\\.[a-z_]+\\.\\p{Decimal_Number}{2}"))),
    conversation_state: nullable(rejectOwnProtoKey(z.record(recordKey, unknownPayload))), followed_action_id: nullable(full("na\\.[0-9]{2}")),
  });
  reg("list_practitioner_topics", "List practitioner topics and linked cards.", {
    regime: nullable(regime), include_uncarded: z.boolean().default(false),
  });
  reg("get_official_text", "Read an article or search candidates in official local copies. Provide exactly one of article_key or search.", {
    doc_ref_id: text(80).and(full("[a-z]+\\.[a-z0-9-]+")),
    article_key: nullable(full("\\p{Decimal_Number}{7}")),
    search: nullable(text(60).refine((v) => !pythonBlank.test(v), { message: "Expected a nonblank search." })),
  }, (args) => (args.article_key != null) !== (args.search != null));

  client.setStatusListener((status) => {
    for (const handle of handles) status.state === "ready" ? handle.enable() : handle.disable();
  });
  return { contracts, handles };
}
