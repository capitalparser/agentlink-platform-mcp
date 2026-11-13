import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { discoverAndVerifyTools, DiscoveryFailure, inputSchemasCompatible } from '../dist/domains/discovery.js';

const expected = toJsonSchemaCompat(z.object({
  amount: z.number(),
  role: z.enum(['payer', 'recipient']).nullable().optional(),
  payments: z.array(z.object({ id: z.string().min(1), amount: z.number().int().min(0) })),
}), { pipeStrategy: 'input' });
const childSchema = {
  type: 'object',
  title: 'ignored',
  properties: {
    amount: { type: 'number', description: 'ignored' },
    role: { anyOf: [{ type: 'string', enum: ['payer', 'recipient'] }, { type: 'null' }] },
    payments: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string', minLength: 1 }, amount: { type: 'integer', minimum: 0 },
    }, required: ['id', 'amount'], additionalProperties: false } },
  },
  required: ['amount', 'payments'],
};
const contracts = [{ publicName: 'tax_plan', domainName: 'plan_tax', inputSchema: expected }];

const zod4CompatibilitySchema = toJsonSchemaCompat(z.object({
  limit: z.number().int().min(1).max(20).default(8),
  omitted: z.string().nullable().optional(),
  matter: z.object({}).passthrough(),
}).strict(), { pipeStrategy: 'input' });

test('Zod 4 input schema conversion preserves defaults, optionality, and object key policies', () => {
  assert.equal(zod4CompatibilitySchema.properties.limit.default, 8);
  assert.ok(!zod4CompatibilitySchema.required.includes('limit'));
  assert.ok(!zod4CompatibilitySchema.required.includes('omitted'));
  assert.notEqual(zod4CompatibilitySchema.properties.matter.additionalProperties, false,
    'passthrough schemas must accept future fields');
  assert.equal(zod4CompatibilitySchema.additionalProperties, false,
    'strict schemas must reject unknown fields');
});

test('schema contracts tolerate nullable optional extension, titles, descriptions and key order', () => {
  assert.equal(inputSchemasCompatible(expected, childSchema), true);
});

test('schema contracts reject required-property, type, enum, nested and restrictive-bound changes', () => {
  const variants = [
    { ...childSchema, required: ['amount', 'payments', 'extra'] },
    { ...childSchema, properties: { ...childSchema.properties, amount: { type: 'string' } } },
    { ...childSchema, properties: { ...childSchema.properties, role: { type: 'string', enum: ['payer'] } } },
    { ...childSchema, properties: { ...childSchema.properties, payments: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string', minLength: 1 }, amount: { type: 'string' },
    }, required: ['id', 'amount'] } } } },
    { ...childSchema, properties: { ...childSchema.properties, amount: { type: 'number', maximum: 10 } } },
    { ...childSchema, properties: { ...childSchema.properties, payments: { type: 'array', minItems: 1, items: childSchema.properties.payments.items } } },
  ];
  for (const schema of variants) assert.equal(inputSchemasCompatible(expected, schema), false);
});

test('schema contracts fail closed on restrictive constraints, nullable siblings, and malformed child schemas', () => {
  const wrapper = (value) => ({ type: 'object', properties: { value }, required: ['value'], additionalProperties: false });
  const cases = [
    [wrapper({ type: 'string' }), wrapper({ type: 'string', enum: ['only'] })],
    [wrapper({ type: 'number', minimum: 100 }), wrapper({ type: 'number', exclusiveMinimum: 100 })],
    [wrapper({ type: 'string' }), wrapper({ anyOf: [{ type: 'string' }, { type: 'null' }], maxLength: 2 })],
    [wrapper({ type: 'string', maxLength: 10 }), wrapper({ anyOf: [{ type: 'string', maxLength: 2 }, { type: 'null' }], maxLength: 10 })],
    [wrapper({ type: 'string', enum: ['a', 'b'] }), wrapper({ anyOf: [{ type: 'string', enum: ['a'] }, { type: 'null' }], enum: ['a', 'b'] })],
    [wrapper({ type: 'string' }), wrapper({ type: 42 })],
    [{ type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      { type: 'object', properties: { value: { type: 'string' } }, required: 'value' }],
    [wrapper({ type: 'string' }), wrapper({ type: 'string', dependentRequired: { value: ['other'] } })],
  ];
  for (const [expectedSchema, actualSchema] of cases) assert.equal(inputSchemasCompatible(expectedSchema, actualSchema), false);
});

test('schema contracts accept safely removed upper bounds and broader numeric bounds', () => {
  const wrapper = (value) => ({ type: 'object', properties: { value }, required: ['value'] });
  assert.equal(inputSchemasCompatible(wrapper({ type: 'number', maximum: 100 }), wrapper({ type: 'number' })), true);
  assert.equal(inputSchemasCompatible(wrapper({ type: 'number', minimum: 100 }), wrapper({ type: 'number', minimum: 90 })), true);
  assert.equal(inputSchemasCompatible(wrapper({ type: 'number', maximum: 100 }), wrapper({ type: 'number', maximum: 110 })), true);
  assert.equal(inputSchemasCompatible(wrapper({ type: 'string', maxLength: 100 }), wrapper({ type: 'string' })), true);
  assert.equal(inputSchemasCompatible(wrapper({ type: 'array', items: { type: 'string' }, maxItems: 100 }),
    wrapper({ type: 'array', items: { type: 'string' } })), true);
  assert.equal(inputSchemasCompatible(wrapper({ type: 'string', pattern: '^\\d{1,12}$' }),
    wrapper({ type: 'string', minLength: 1, maxLength: 12 })), true);
  assert.equal(inputSchemasCompatible(wrapper({ type: 'string', pattern: '^\\d{1,12}$' }),
    wrapper({ type: 'string', minLength: 1, maxLength: 10 })), false);
  assert.equal(inputSchemasCompatible(wrapper({ type: 'number', minimum: 100 }), wrapper({ type: 'number', exclusiveMinimum: 100 })), false);
  assert.equal(inputSchemasCompatible(wrapper({ type: 'number', exclusiveMinimum: 100 }), wrapper({ type: 'number', minimum: 100 })), true);
});

test('bounded local refs resolve while remote refs and unsupported constructs fail closed', () => {
  const referenced = {
    $defs: { payload: childSchema },
    $ref: '#/$defs/payload',
  };
  assert.equal(inputSchemasCompatible(expected, referenced), true);
  assert.equal(inputSchemasCompatible(expected, { $ref: 'https://example.invalid/schema' }), false);
  assert.equal(inputSchemasCompatible(expected, { ...childSchema, oneOf: [{ type: 'object' }] }), false);
});

test('matching supported allOf contracts pass while changed conjunctions fail closed', () => {
  const expectedSchema = { type: 'object', properties: { value: { allOf: [{ type: 'string' }, { type: 'string', pattern: '^x$' }] } }, required: ['value'] };
  const sameSchema = { type: 'object', properties: { value: { allOf: [{ type: 'string' }, { type: 'string', pattern: '^x$', description: 'ignored' }] } }, required: ['value'] };
  const changedSchema = { type: 'object', properties: { value: { allOf: [{ type: 'string' }, { type: 'string', pattern: '^y$' }] } }, required: ['value'] };
  assert.equal(inputSchemasCompatible(expectedSchema, sameSchema), true);
  assert.equal(inputSchemasCompatible(expectedSchema, changedSchema), false);
  assert.equal(inputSchemasCompatible(
    { type: 'object', allOf: [{ properties: { title: { type: 'string' } } }] },
    { type: 'object', allOf: [{ properties: { title: { type: 'number' } } }] },
  ), false);
  assert.equal(inputSchemasCompatible(
    { type: 'object', allOf: [{ enum: [{ title: 'a' }] }] },
    { type: 'object', allOf: [{ enum: [{ title: 'b' }] }] },
  ), false);
});

function paged(pages) {
  const cursors = [];
  return {
    cursors,
    async listTools(params) {
      cursors.push(params?.cursor);
      return pages[params?.cursor ?? 'first'];
    },
  };
}

test('discovery lists every page before verifying mapped tools and ignores unknown extras', async () => {
  const client = paged({
    first: { tools: [{ name: 'unmapped', inputSchema: { type: 'object' }, description: 'extra' }], nextCursor: 'next' },
    next: { tools: [{ name: 'plan_tax', inputSchema: childSchema, title: 'ignored' }] },
  });
  const verified = await discoverAndVerifyTools(client, contracts, 1000);
  assert.deepEqual(client.cursors, [undefined, 'next']);
  assert.deepEqual([...verified.keys()], ['plan_tax']);
});

test('missing tools, malformed/duplicate schemas, repeated cursors, and bounded response limits fail closed', async () => {
  const cases = [
    [paged({ first: { tools: [] } }), 'DOMAIN_TOOL_MISSING'],
    [paged({ first: { tools: [{ name: 'plan_tax', inputSchema: [] }] } }), 'DOMAIN_SCHEMA_MISMATCH'],
    [paged({ first: { tools: [{ name: 'plan_tax', inputSchema: childSchema }, { name: 'plan_tax', inputSchema: childSchema }] } }), 'DOMAIN_SCHEMA_MISMATCH'],
    [paged({ first: { tools: [], nextCursor: 'again' }, again: { tools: [], nextCursor: 'again' } }), 'DOMAIN_SCHEMA_MISMATCH'],
  ];
  for (const [client, code] of cases) await assert.rejects(discoverAndVerifyTools(client, contracts, 1000), (error) => error instanceof DiscoveryFailure && error.code === code);

  const tooMany = Array.from({ length: 1025 }, (_, index) => ({ name: `extra_${index}`, inputSchema: { type: 'object' } }));
  await assert.rejects(discoverAndVerifyTools(paged({ first: { tools: tooMany } }), contracts, 1000),
    (error) => error instanceof DiscoveryFailure && error.code === 'DOMAIN_SCHEMA_MISMATCH');

  const oversized = { name: 'extra', inputSchema: { type: 'object' }, description: 'x'.repeat(2 * 1024 * 1024) };
  await assert.rejects(discoverAndVerifyTools(paged({ first: { tools: [oversized] } }), contracts, 1000),
    (error) => error instanceof DiscoveryFailure && error.code === 'DOMAIN_SCHEMA_MISMATCH');

  const manyPages = {};
  for (let i = 0; i < 32; i++) manyPages[i === 0 ? 'first' : `c${i}`] = { tools: [], nextCursor: `c${i + 1}` };
  await assert.rejects(discoverAndVerifyTools(paged(manyPages), contracts, 1000),
    (error) => error instanceof DiscoveryFailure && error.code === 'DOMAIN_SCHEMA_MISMATCH');
});

test('list pagination shares one deadline and aborts an unresponsive page', async () => {
  const client = { async listTools(_params, options) {
    await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
    throw new Error('aborted');
  } };
  const started = Date.now();
  await assert.rejects(discoverAndVerifyTools(client, contracts, 30),
    (error) => error instanceof DiscoveryFailure && error.code === 'DOMAIN_TIMEOUT');
  assert.ok(Date.now() - started < 500);
});
