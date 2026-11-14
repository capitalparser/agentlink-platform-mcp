/** Bounded MCP tools/list discovery and structural input-schema checks. */

export interface ToolContract {
  publicName: string;
  domainName: string;
  inputSchema: Record<string, unknown>;
  optional?: boolean;
  expectedAnnotations?: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

export interface ListedTool {
  name: string;
  inputSchema: Record<string, unknown>;
  annotations?: unknown;
}

export interface DiscoveryClient {
  listTools(params?: { cursor?: string }, options?: { timeout?: number; signal?: AbortSignal }): Promise<unknown>;
}

export type DiscoveryFailureCode = "DOMAIN_TOOL_MISSING" | "DOMAIN_SCHEMA_MISMATCH" | "DOMAIN_ERROR" | "DOMAIN_TIMEOUT";

export class DiscoveryFailure extends Error {
  constructor(readonly code: DiscoveryFailureCode) {
    super(code);
    this.name = "DiscoveryFailure";
  }
}

const MAX_PAGES = 32;
const MAX_TOOLS = 1024;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SCHEMA_DEPTH = 48;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function jsonBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("not serializable");
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    throw new DiscoveryFailure("DOMAIN_ERROR");
  }
}

function localRef(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let value: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(value) || !(key in value)) return undefined;
    value = value[key];
  }
  return value;
}

const schemaTypes = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
const schemaKeywords = new Set([
  "$schema", "$id", "$defs", "definitions", "$ref", "title", "description", "default", "examples", "deprecated",
  "type", "nullable", "anyOf", "allOf", "properties", "required", "additionalProperties", "items", "enum", "const",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems",
  "pattern", "format", "propertyNames",
]);

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > MAX_SCHEMA_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

/** Reject malformed/unsupported schema syntax before interpreting its constraints. */
function validSchemaTree(
  raw: unknown,
  root: Record<string, unknown>,
  depth = 0,
  activeRefs = new Set<string>(),
): boolean {
  if (!isRecord(raw) || depth > MAX_SCHEMA_DEPTH) return false;
  if (Object.keys(raw).some((key) => !schemaKeywords.has(key))) return false;
  if (Object.hasOwn(raw, "$ref")) {
    if (typeof raw.$ref !== "string" || Object.keys(raw).some((key) => key !== "$ref" && !["title", "description", "default", "examples", "deprecated", "$schema", "$id", "$defs", "definitions"].includes(key))) return false;
    const ref = raw.$ref;
    if (activeRefs.has(ref)) return false;
    const target = localRef(root, ref);
    if (!target) return false;
    const refs = new Set(activeRefs);
    refs.add(ref);
    return validSchemaTree(target, root, depth + 1, refs);
  }
  if (raw.type !== undefined) {
    if (typeof raw.type === "string") {
      if (!schemaTypes.has(raw.type)) return false;
    } else if (Array.isArray(raw.type)) {
      if (raw.type.length === 0 || !raw.type.every((type) => typeof type === "string" && schemaTypes.has(type)) || new Set(raw.type).size !== raw.type.length) return false;
    } else return false;
  }
  if (raw.nullable !== undefined && typeof raw.nullable !== "boolean") return false;
  if (Object.hasOwn(raw, "oneOf")) return false;
  if (Object.hasOwn(raw, "anyOf")) {
    if (!Array.isArray(raw.anyOf) || raw.anyOf.length === 0 || !raw.anyOf.every((branch) => validSchemaTree(branch, root, depth + 1, activeRefs))) return false;
  }
  if (Object.hasOwn(raw, "allOf")) {
    if (!Array.isArray(raw.allOf) || raw.allOf.length === 0 || !raw.allOf.every((branch) => validSchemaTree(branch, root, depth + 1, activeRefs))) return false;
  }
  if (Object.hasOwn(raw, "required")) {
    if (!Array.isArray(raw.required) || !raw.required.every((key) => typeof key === "string") || new Set(raw.required).size !== raw.required.length) return false;
  }
  if (Object.hasOwn(raw, "properties")) {
    if (!isRecord(raw.properties) || !Object.values(raw.properties).every((schema) => validSchemaTree(schema, root, depth + 1, activeRefs))) return false;
  }
  if (Object.hasOwn(raw, "items") && !validSchemaTree(raw.items, root, depth + 1, activeRefs)) return false;
  if (Object.hasOwn(raw, "additionalProperties") && typeof raw.additionalProperties !== "boolean" && !validSchemaTree(raw.additionalProperties, root, depth + 1, activeRefs)) return false;
  if (Object.hasOwn(raw, "propertyNames") && !validSchemaTree(raw.propertyNames, root, depth + 1, activeRefs)) return false;
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
    if (raw[key] !== undefined && (typeof raw[key] !== "number" || !Number.isFinite(raw[key]))) return false;
  }
  if (raw.minimum !== undefined && raw.exclusiveMinimum !== undefined) return false;
  if (raw.maximum !== undefined && raw.exclusiveMaximum !== undefined) return false;
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
    if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0)) return false;
  }
  if (raw.minLength !== undefined && raw.maxLength !== undefined && (raw.minLength as number) > (raw.maxLength as number)) return false;
  if (raw.minItems !== undefined && raw.maxItems !== undefined && (raw.minItems as number) > (raw.maxItems as number)) return false;
  if (raw.pattern !== undefined && typeof raw.pattern !== "string") return false;
  if (raw.pattern !== undefined) {
    try { new RegExp(raw.pattern); } catch { return false; }
  }
  if (raw.format !== undefined && typeof raw.format !== "string") return false;
  if (Object.hasOwn(raw, "enum") && (!Array.isArray(raw.enum) || raw.enum.length === 0 || !isJsonValue(raw.enum))) return false;
  if (Object.hasOwn(raw, "const") && !isJsonValue(raw.const)) return false;
  return true;
}

function resolved(schema: unknown, root: Record<string, unknown>, depth: number, refs = new Set<string>()): Record<string, unknown> | null {
  if (!isRecord(schema) || depth > MAX_SCHEMA_DEPTH) return null;
  if (typeof schema.$ref !== "string") return schema;
  if (Object.keys(schema).some((key) => key !== "$ref" && !["description", "title", "default", "examples", "$defs", "definitions"].includes(key))) return null;
  const ref = schema.$ref;
  if (refs.has(ref)) return null;
  const target = localRef(root, ref);
  if (!target) return null;
  const next = new Set(refs);
  next.add(ref);
  return resolved(target, root, depth + 1, next);
}

type Normalized = {
  schema: Record<string, unknown>;
  root: Record<string, unknown>;
  nullable: boolean;
  branches?: Record<string, unknown>[];
};

const annotationKeys = new Set(["title", "description", "default", "examples", "deprecated"]);

function schemaMapEqual(left: unknown, right: unknown, depth: number): boolean {
  if (!isRecord(left) || !isRecord(right) || depth > MAX_SCHEMA_DEPTH) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && schemaValuesEqual(left[key], right[key], depth + 1));
}

function schemaArrayEqual(left: unknown, right: unknown, depth: number): boolean {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((value, index) => schemaValuesEqual(value, right[index], depth + 1));
}

function schemaValuesEqual(left: unknown, right: unknown, depth = 0, context = "schema"): boolean {
  if (depth > MAX_SCHEMA_DEPTH) return false;
  if (["properties", "$defs", "definitions"].includes(context)) return schemaMapEqual(left, right, depth);
  if (["allOf", "anyOf"].includes(context)) return schemaArrayEqual(left, right, depth);
  if (["items", "propertyNames"].includes(context)) return schemaValuesEqual(left, right, depth + 1);
  if (context === "additionalProperties" && (isRecord(left) || isRecord(right))) return schemaValuesEqual(left, right, depth + 1);
  if (context !== "schema") return deepEqualJson(left, right);
  if (left === right) return true;
  if (!isRecord(left) || !isRecord(right)) return deepEqualJson(left, right);
  const leftKeys = Object.keys(left).filter((key) => !annotationKeys.has(key)).sort();
  const rightKeys = Object.keys(right).filter((key) => !annotationKeys.has(key)).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => {
    if (key !== rightKeys[index]) return false;
    const valueContext = ["properties", "$defs", "definitions", "allOf", "anyOf", "items", "propertyNames", "additionalProperties"].includes(key) ? key : "value";
    return schemaValuesEqual(left[key], right[key], depth + 1, valueContext);
  });
}

function schemaContainsRef(value: unknown, depth = 0): boolean {
  if (depth > MAX_SCHEMA_DEPTH) return true;
  if (Array.isArray(value)) return value.some((item) => schemaContainsRef(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.hasOwn(value, "$ref") || Object.values(value).some((item) => schemaContainsRef(item, depth + 1));
}

function normalize(schema: unknown, root: Record<string, unknown>, depth: number): Normalized | null {
  const value = resolved(schema, root, depth);
  if (!value) return null;
  let nullable = value.nullable === true;
  if (value.nullable !== undefined && typeof value.nullable !== "boolean") return null;
  if (value.type !== undefined && !(typeof value.type === "string" || (Array.isArray(value.type) && value.type.every((t) => typeof t === "string")))) return null;
  if (Array.isArray(value.type)) {
    nullable ||= value.type.includes("null");
    const types = value.type.filter((t) => t !== "null");
    const copy = { ...value, type: types.length === 1 ? types[0] : types };
    if (types.length === 0) return { schema: { type: "null" }, root, nullable: true };
    return { schema: copy, root, nullable };
  }
  if (value.type === "null") return { schema: value, root, nullable: true };
  if (Array.isArray(value.anyOf)) {
    const arms = value.anyOf.map((arm) => resolved(arm, root, depth + 1));
    if (arms.some((arm) => arm === null)) return null;
    const nonNull = (arms as Record<string, unknown>[]).filter((arm) => arm.type !== "null" && !(Array.isArray(arm.type) && arm.type.includes("null")));
    nullable ||= nonNull.length !== arms.length;
    if (nonNull.length === 0) return { schema: { type: "null" }, root, nullable: true };
    const siblings = { ...value };
    delete siblings.anyOf;
    const annotations = new Set(["$schema", "title", "description", "default", "examples", "deprecated"]);
    for (const branch of nonNull) {
      for (const [key, sibling] of Object.entries(siblings)) {
        if (annotations.has(key) || branch[key] === undefined) continue;
        if (!schemaValuesEqual(branch[key], sibling, depth + 1, key)) return null;
      }
    }
    const merged = nonNull.map((branch) => ({ ...branch, ...siblings }));
    if (merged.length === 1) {
      const normalized = normalize(merged[0], root, depth + 1);
      return normalized ? { ...normalized, nullable: nullable || normalized.nullable } : null;
    }
    return { schema: { ...value, anyOf: merged }, root, nullable, branches: merged };
  }
  return { schema: value, root, nullable };
}

const benignKeys = new Set([
  "$schema", "$id", "$defs", "definitions", "title", "description", "default", "examples", "deprecated",
  "type", "nullable", "anyOf", "allOf", "properties", "required", "additionalProperties", "items", "enum", "const",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems",
  "pattern", "format", "propertyNames",
]);

function hasUnknownConstraint(schema: Record<string, unknown>): boolean {
  return Object.keys(schema).some((key) => !benignKeys.has(key) && key !== "$ref");
}

function typeSet(schema: Record<string, unknown>): Set<string> | null {
  const value = schema.type;
  if (typeof value === "string") return new Set([value]);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return new Set(value as string[]);
  if (value === undefined) {
    if (isRecord(schema.properties) || schema.required !== undefined || schema.additionalProperties !== undefined) return new Set(["object"]);
    if (schema.items !== undefined) return new Set(["array"]);
    if (schema.enum !== undefined || schema.const !== undefined) {
      const items = Array.isArray(schema.enum) ? schema.enum : [schema.const];
      const types = new Set(items.map((item) => item === null ? "null" : Array.isArray(item) ? "array" : typeof item === "object" ? "object" : typeof item === "number" && Number.isInteger(item) ? "integer" : typeof item));
      return types;
    }
    return null;
  }
  return null;
}

function typeCompatible(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  if (expected === "integer" && actual === "number") return true;
  if (expected === "number" && actual === "integer") return false;
  return false;
}

interface NumericBound { value: number; exclusive: boolean }

function numericBound(schema: Record<string, unknown>, side: "minimum" | "maximum"): NumericBound | undefined | null {
  const exclusive = schema[side === "minimum" ? "exclusiveMinimum" : "exclusiveMaximum"];
  const plain = schema[side];
  if (exclusive !== undefined && typeof exclusive !== "number") return null;
  if (plain !== undefined && typeof plain !== "number") return null;
  if (exclusive !== undefined) return { value: exclusive as number, exclusive: true };
  if (plain !== undefined) return { value: plain as number, exclusive: false };
  return undefined;
}

function lowerBoundIsPermissive(actual: NumericBound | undefined, expected: NumericBound | undefined): boolean {
  if (!expected) return !actual;
  if (!actual) return true;
  if (actual.value !== expected.value) return actual.value < expected.value;
  return !actual.exclusive || expected.exclusive;
}

function upperBoundIsPermissive(actual: NumericBound | undefined, expected: NumericBound | undefined): boolean {
  if (!expected) return !actual;
  if (!actual) return true;
  if (actual.value !== expected.value) return actual.value > expected.value;
  return !actual.exclusive || expected.exclusive;
}

/** Derive only the length bounds of a tightly recognized digit-count pattern. */
function digitPatternLengthBounds(pattern: unknown): { minimum: number; maximum: number } | undefined {
  if (typeof pattern !== "string") return undefined;
  const match = /^\^\\d\{([0-9]+),([0-9]+)\}\$$/.exec(pattern);
  if (!match) return undefined;
  const minimum = Number(match[1]);
  const maximum = Number(match[2]);
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum < 0 || maximum < minimum) return undefined;
  return { minimum, maximum };
}

function compatible(expectedRaw: unknown, actualRaw: unknown, depth = 0): boolean {
  if (depth > MAX_SCHEMA_DEPTH) return false;
  const expectedRoot = isRecord(expectedRaw) ? expectedRaw : null;
  const actualRoot = isRecord(actualRaw) ? actualRaw : null;
  if (!expectedRoot || !actualRoot) return false;
  const expected = normalize(expectedRoot, expectedRoot, depth);
  const actual = normalize(actualRoot, actualRoot, depth);
  if (!expected || !actual) return false;
  return compareNormalized(expected, actual, depth + 1);
}

function compareNormalized(expected: Normalized, actual: Normalized, depth: number): boolean {
  if (depth > MAX_SCHEMA_DEPTH) return false;
  if (expected.nullable && !actual.nullable && typeSet(actual.schema)?.has("null") !== true) return false;
  if (expected.branches) {
    return expected.branches.every((branch) => {
      const candidate = normalize(branch, expected.root, depth + 1);
      if (!candidate) return false;
      if (actual.branches) return actual.branches.some((actualBranch) => {
        const normalizedActual = normalize(actualBranch, actual.root, depth + 1);
        return !!normalizedActual && compareNormalized(candidate, normalizedActual, depth + 1);
      });
      return compareNormalized(candidate, actual, depth + 1);
    });
  }
  if (actual.branches) {
    return actual.branches.some((branch) => {
      const candidate = normalize(branch, actual.root, depth + 1);
      return !!candidate && compareNormalized(expected, candidate, depth + 1);
    });
  }
  const e = expected.schema;
  const a = actual.schema;
  if (hasUnknownConstraint(e) || hasUnknownConstraint(a)) return false;
  if (e.allOf !== undefined || a.allOf !== undefined) {
    if (!Array.isArray(e.allOf) || !Array.isArray(a.allOf) || schemaContainsRef(e) || schemaContainsRef(a)) return false;
    return schemaValuesEqual(e, a);
  }
  const et = typeSet(e);
  const at = typeSet(a);
  if (et && (!at || ![...et].every((expectedType) => [...at].some((actualType) => typeCompatible(expectedType, actualType))))) return false;
  if (!et && at) return false;
  if (a.format !== undefined && e.format !== a.format) return false;
  if (a.pattern !== undefined && e.pattern !== a.pattern) return false;
  const expectedValues = Array.isArray(e.enum) ? e.enum : e.const !== undefined ? [e.const] : undefined;
  const actualValues = Array.isArray(a.enum) ? a.enum : a.const !== undefined ? [a.const] : undefined;
  if (actualValues && !expectedValues) return false;
  if (expectedValues && actualValues && !expectedValues.every((value) => actualValues.some((candidate) => deepEqualJson(value, candidate)))) return false;
  for (const [key, derivedMinimum] of [["minLength", digitPatternLengthBounds(e.pattern)?.minimum], ["minItems", undefined]] as const) {
    const expectedMinimum = typeof e[key] === "number" ? Math.max(e[key] as number, derivedMinimum ?? 0) : derivedMinimum;
    if (typeof a[key] === "number" && (expectedMinimum === undefined ? a[key] > 0 : a[key] > expectedMinimum)) return false;
  }
  for (const [key, derivedMaximum] of [["maxLength", digitPatternLengthBounds(e.pattern)?.maximum], ["maxItems", undefined]] as const) {
    const expectedMaximum = typeof e[key] === "number" ? Math.min(e[key] as number, derivedMaximum ?? Number.POSITIVE_INFINITY) : derivedMaximum;
    if (typeof a[key] === "number" && (expectedMaximum === undefined || a[key] < expectedMaximum)) return false;
  }
  const eMin = numericBound(e, "minimum");
  const aMin = numericBound(a, "minimum");
  const eMax = numericBound(e, "maximum");
  const aMax = numericBound(a, "maximum");
  if (eMin === null || aMin === null || eMax === null || aMax === null) return false;
  if (!lowerBoundIsPermissive(aMin, eMin) || !upperBoundIsPermissive(aMax, eMax)) return false;

  const eObject = et?.has("object") || isRecord(e.properties) || e.required !== undefined || e.additionalProperties !== undefined;
  const aObject = at?.has("object") || isRecord(a.properties) || a.required !== undefined || a.additionalProperties !== undefined;
  if (eObject) {
    if (!aObject) return false;
    const eRequired = Array.isArray(e.required) ? e.required : [];
    const aRequired = Array.isArray(a.required) ? a.required : [];
    if (!eRequired.every((key) => typeof key === "string") || !aRequired.every((key) => typeof key === "string")) return false;
    if (eRequired.length !== aRequired.length || eRequired.some((key) => !aRequired.includes(key))) return false;
    const eProps = isRecord(e.properties) ? e.properties : {};
    const aProps = isRecord(a.properties) ? a.properties : {};
    for (const [key, child] of Object.entries(eProps)) {
      if (!(key in aProps) || !compatibleWithRoots(child, aProps[key], expected.root, actual.root, depth + 1)) return false;
    }
    if (e.additionalProperties === true || (isRecord(e.additionalProperties) && Object.keys(e.additionalProperties).length === 0)) {
      if (a.additionalProperties === false) return false;
      if (isRecord(a.additionalProperties) && Object.keys(a.additionalProperties).length > 0) return false;
    } else if (isRecord(e.additionalProperties)) {
      if (a.additionalProperties === false) return false;
      if (isRecord(a.additionalProperties) && !compatibleWithRoots(e.additionalProperties, a.additionalProperties, expected.root, actual.root, depth + 1)) return false;
    }
    if (e.propertyNames !== undefined && a.propertyNames !== undefined && !compatibleWithRoots(e.propertyNames, a.propertyNames, expected.root, actual.root, depth + 1)) return false;
  }
  const eArray = et?.has("array") || e.items !== undefined;
  if (eArray) {
    if (!(at?.has("array") || a.items !== undefined) || e.items === undefined || a.items === undefined) return false;
    if (!compatibleWithRoots(e.items, a.items, expected.root, actual.root, depth + 1)) return false;
  }
  return true;
}

function compatibleWithRoots(expected: unknown, actual: unknown, expectedRoot: Record<string, unknown>, actualRoot: Record<string, unknown>, depth: number): boolean {
  if (depth > MAX_SCHEMA_DEPTH) return false;
  const e = normalize(expected, expectedRoot, depth);
  const a = normalize(actual, actualRoot, depth);
  return !!e && !!a && compareNormalized(e, a, depth + 1);
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, index) => deepEqualJson(item, right[index]));
  const l = left as Record<string, unknown>;
  const r = right as Record<string, unknown>;
  const keys = Object.keys(l).sort();
  return keys.length === Object.keys(r).length && keys.every((key, index) => key === Object.keys(r).sort()[index] && deepEqualJson(l[key], r[key]));
}

export function inputSchemasCompatible(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  if (!validSchemaTree(expected, expected) || !validSchemaTree(actual, actual)) return false;
  const expectedResolved = resolved(expected, expected, 0);
  const actualResolved = resolved(actual, actual, 0);
  if (!expectedResolved || !actualResolved) return false;
  const expectedRootTypes = typeSet(expectedResolved);
  const actualRootTypes = typeSet(actualResolved);
  if (!expectedRootTypes?.has("object") || expectedRootTypes.size !== 1 || !actualRootTypes?.has("object") || actualRootTypes.size !== 1) return false;
  return compatible(expected, actual);
}

export async function discoverAndVerifyTools(
  client: DiscoveryClient,
  contracts: readonly ToolContract[],
  timeoutMs: number,
): Promise<Map<string, ListedTool>> {
  const deadline = Date.now() + timeoutMs;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const byName = new Map<string, ListedTool>();
  const optionalNames = new Set(contracts.filter((contract) => contract.optional).map((contract) => contract.domainName));
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new DiscoveryFailure("DOMAIN_TIMEOUT");
      let result: unknown;
      try {
        result = await client.listTools(cursor === undefined ? undefined : { cursor }, { timeout: remaining, signal: abort.signal });
      } catch (error) {
        if (abort.signal.aborted || Date.now() >= deadline) throw new DiscoveryFailure("DOMAIN_TIMEOUT");
        throw error;
      }
      bytes += jsonBytes(result);
      if (bytes > MAX_BYTES || !isRecord(result) || !Array.isArray(result.tools)) throw new DiscoveryFailure("DOMAIN_SCHEMA_MISMATCH");
      for (const candidate of result.tools) {
        if (!isRecord(candidate) || typeof candidate.name !== "string" || candidate.name.length === 0) {
          throw new DiscoveryFailure("DOMAIN_SCHEMA_MISMATCH");
        }
        if (byName.has(candidate.name)) throw new DiscoveryFailure("DOMAIN_SCHEMA_MISMATCH");
        if (!isRecord(candidate.inputSchema) && !optionalNames.has(candidate.name)) {
          throw new DiscoveryFailure("DOMAIN_SCHEMA_MISMATCH");
        }
        byName.set(candidate.name, {
          name: candidate.name,
          inputSchema: isRecord(candidate.inputSchema) ? candidate.inputSchema : {},
          ...(Object.hasOwn(candidate, "annotations") ? { annotations: candidate.annotations } : {}),
        });
        if (byName.size > MAX_TOOLS) throw new DiscoveryFailure("DOMAIN_SCHEMA_MISMATCH");
      }
      if (result.nextCursor === undefined) break;
      if (typeof result.nextCursor !== "string" || result.nextCursor.length === 0 || cursors.has(result.nextCursor)) {
        throw new DiscoveryFailure("DOMAIN_SCHEMA_MISMATCH");
      }
      if (page === MAX_PAGES - 1) throw new DiscoveryFailure("DOMAIN_SCHEMA_MISMATCH");
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
  } finally {
    clearTimeout(timer);
  }

  const verified = new Map<string, ListedTool>();
  for (const contract of contracts) {
    const child = byName.get(contract.domainName);
    if (!child) {
      if (contract.optional) continue;
      throw new DiscoveryFailure("DOMAIN_TOOL_MISSING");
    }
    const expectedAnnotations = contract.expectedAnnotations === undefined
      ? undefined
      : Object.entries(contract.expectedAnnotations);
    const childAnnotations = isRecord(child.annotations) ? child.annotations : undefined;
    const annotationsMatch = expectedAnnotations === undefined ||
      (childAnnotations !== undefined && Object.keys(childAnnotations).length === expectedAnnotations.length &&
        expectedAnnotations.every(([key, value]) => childAnnotations[key] === value));
    const schemaMatches = inputSchemasCompatible(contract.inputSchema, child.inputSchema);
    if (!schemaMatches || !annotationsMatch) {
      if (contract.optional) continue;
      throw new DiscoveryFailure("DOMAIN_SCHEMA_MISMATCH");
    }
    verified.set(contract.domainName, child);
  }
  return verified;
}
