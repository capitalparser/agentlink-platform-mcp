import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from '../../dist/server.js';
import { SubsidyDomainClient, subsidyConfigFromEnv } from '../../dist/domains/subsidy/bridge.js';
import { registerSubsidyDomainTools } from '../../dist/domains/subsidy/tools.js';
import { memoryDomainClient, genericContracts } from '../tax/fixtures/memory-domain-client.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-child.mjs', import.meta.url));
export const SUBSIDY = ['list_workflows', 'get_reference_bundle', 'search_references', 'get_reference',
  'answer_practitioner_question', 'list_practitioner_topics', 'get_official_text'];
const BASELINE = [
  'agentlink_bridge_status',
  'get_business_info', 'get_disaster_alerts', 'get_income_tax_summary', 'get_procurement_data', 'get_tax_invoice',
  'get_vat_data', 'search_court_precedents', 'search_public_notices', 'tax_answer_practitioner_question',
  'tax_check_business_status', 'tax_create_draft_bundle', 'tax_export_rule_cards', 'tax_find_office', 'tax_get_automation_offer',
  'tax_get_form_field_tips', 'tax_get_law_article', 'tax_get_schedule', 'tax_get_tribunal_decision', 'tax_get_workflow_contract',
  'tax_list_form_guides', 'tax_list_holidays', 'tax_list_practice_cards', 'tax_list_rule_cards', 'tax_list_workflows',
  'tax_plan_work', 'tax_route_question', 'tax_health', 'tax_search_forms', 'tax_search_interpretations', 'tax_search_law', 'verify_business_registration',
];
const schemaSource = new McpServer({ name: 'subsidy-contract-source', version: '0' });
const DOMAIN_CONTRACTS = registerSubsidyDomainTools(schemaSource, memoryDomainClient()).contracts;
const FAKE_TOOL_NAMES = ['ping', 'crash', 'sleep', 'env_check', 'fail', 'structural_error', 'missing_structured', 'array_structured'];
const FAKE_CONTRACTS = [...DOMAIN_CONTRACTS, ...genericContracts(FAKE_TOOL_NAMES)];
const fake = async (config = {}, env = { PATH: process.env.PATH }) => {
  const client = new SubsidyDomainClient({ command: process.execPath, args: [FAKE], ...config }, env);
  await client.initialize(FAKE_CONTRACTS);
  return client;
};
const spawnLog = () => join(mkdtempSync(join(tmpdir(), 'subsidybridge-')), 'pids.log');
const pids = p => readFileSync(p, 'utf8').trim().split('\n');
async function connect(t, subsidy) {
  const tax = memoryDomainClient();
  const domain = typeof subsidy.initialize === 'function' ? subsidy : memoryDomainClient(subsidy);
  const server = await createServer({ subsidyDomainClient: domain, taxDomainClient: tax, demo: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'subsidy-tests', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); await subsidy.close(); });
  return client;
}
const call = (client, name, args = {}) => client.callTool({ name: `subsidy_${name}`, arguments: args });
const rejected = async (client, name, args) => {
  let failed = false;
  try { failed = (await call(client, name, args)).isError === true; } catch { failed = true; }
  assert.ok(failed, `${name} must reject invalid arguments`);
};

test('T1: exact tax and subsidy tools, notices, annotations and stdio structured passthrough', async t => {
  const log = spawnLog();
  const subsidy = await fake({ args: [FAKE, log] });
  const client = await connect(t, subsidy);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(x => x.name).sort(), [...BASELINE, ...SUBSIDY.map(x => `subsidy_${x}`)].sort());
  assert.equal(tools.filter(x => x.name.startsWith('tax_')).length, 22);
  for (const name of SUBSIDY) {
    const tool = tools.find(x => x.name === `subsidy_${name}`);
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.match(tool.description, /결과는 검토용 초안/);
    assert.match(tool.description, /public_url/);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const referenceBundleSchema = tools.find(x => x.name === 'subsidy_get_reference_bundle').inputSchema;
  assert.equal(referenceBundleSchema.properties.limit.default, 8);
  assert.equal(referenceBundleSchema.properties.context.additionalProperties, false,
    'subsidy context must reject unknown fields');
  const practitionerDescription = tools.find(x => x.name === 'subsidy_answer_practitioner_question').description;
  for (const marker of ['action.action_id', 'followed_action_id', '$conversation_state', '$answer', '직전 응답', '사용자 답변']) assert.ok(practitionerDescription.includes(marker));
  // Funding MCP PR #2 integration: re-read its registry, then update this exact full list and count.
  const res = await call(client, 'list_workflows');
  assert.equal(res.isError, undefined);
  assert.deepEqual(res.structuredContent, { name: 'list_workflows', args: {}, nested: { applicability: 'not_determined', values: [1, null, '원문'] } });
  assert.deepEqual(JSON.parse(res.content[0].text), res.structuredContent);
  assert.equal(pids(log).length, 1);
});

test('P3-1 Unicode guard rejects malformed surrogate text and preserves valid Unicode', async t => {
  const calls = [];
  const client = await connect(t, { async callTool(name, args) { calls.push([name, args]); return {}; }, async close() {} });
  const malformed = '\ud800';
  await rejected(client, 'answer_practitioner_question', { question: malformed });
  await rejected(client, 'answer_practitioner_question', { question: 'x', stage: '\udfff' });
  await rejected(client, 'get_reference', { reference_id: '\udfff' });
  await rejected(client, 'get_reference_bundle', { query: 'x', context: {}, matter: { ['bad\ud800']: 'x' } });
  await rejected(client, 'get_reference_bundle', { query: 'x', context: {}, matter: { good: '\udfff' } });
  await rejected(client, 'answer_practitioner_question', { question: 'x', conversation_state: { ['nested\ud800']: 'ok' } });
  await rejected(client, 'answer_practitioner_question', { question: 'x', conversation_state: { nested: ['ok', '\udfff'] } });
  await rejected(client, 'get_reference_bundle', { query: 'x', context: { facts: { ['bad\ud800']: 'x' } } });
  await rejected(client, 'get_reference_bundle', { query: 'x', context: { facts: { good: '\ud800' } } });
  const proto = JSON.parse('{"bad":"x"}');
  Object.defineProperty(proto, '__proto__', { enumerable: true, value: { text: '\ud800' } });
  await rejected(client, 'get_reference_bundle', { query: 'x', context: {}, matter: proto });
  assert.equal(calls.length, 0);
  const valid = { question: '한글 e\u0301 😀\u0000', conversation_state: { ['키😀\u0000']: ['عربي', '١٢'] } };
  assert.notEqual((await call(client, 'answer_practitioner_question', valid)).isError, true);
  assert.deepEqual(calls.at(-1)[1], valid);
  const validEnvelope = { query: '😀\u0000', context: { facts: { ['키😀\u0000']: 'عربي\u0000' } }, matter: { ['مفتاح😀\u0000']: '한글😀\u0000' } };
  assert.notEqual((await call(client, 'get_reference_bundle', validEnvelope)).isError, true);
  assert.deepEqual(calls.at(-1)[1], { ...validEnvelope, limit: 8 });
});

test('P3-2 rejects own enumerable __proto__ keys before parsing all subsidy record boundaries', async t => {
  const calls = [];
  const client = await connect(t, { async callTool(name, args) { calls.push([name, args]); return {}; }, async close() {} });
  const marker = 'PROTO_VALUE_MUST_NOT_LEAK';
  const ownProtoRecord = value => {
    const record = JSON.parse('{"safe":"retained"}');
    Object.defineProperty(record, '__proto__', { enumerable: true, configurable: true, value });
    return record;
  };
  const malformedObject = { secret: marker, malformed: '\ud800' };
  const malformedString = `${marker}\ud800`;
  const rejectedCases = [
    ['matter benign', 'get_reference_bundle', { query: 'x', context: {}, matter: ownProtoRecord(marker) }],
    ['matter malformed', 'get_reference_bundle', { query: 'x', context: {}, matter: ownProtoRecord(malformedObject) }],
    ['conversation_state benign', 'answer_practitioner_question', { question: 'x', conversation_state: ownProtoRecord(marker) }],
    ['conversation_state malformed', 'answer_practitioner_question', { question: 'x', conversation_state: ownProtoRecord(malformedObject) }],
    ['context facts benign', 'get_reference_bundle', { query: 'x', context: { facts: ownProtoRecord(marker) } }],
    ['context facts malformed', 'get_reference_bundle', { query: 'x', context: { facts: ownProtoRecord(malformedString) } }],
    ['practitioner facts benign', 'answer_practitioner_question', { question: 'x', facts: ownProtoRecord(marker) }],
    ['practitioner facts malformed', 'answer_practitioner_question', { question: 'x', facts: ownProtoRecord(malformedString) }],
  ];
  for (const [label, name, args] of rejectedCases) {
    let diagnostic;
    try {
      const result = await call(client, name, args);
      assert.equal(result.isError, true, `${label} must be rejected`);
      diagnostic = JSON.stringify(result);
    } catch (error) {
      diagnostic = String(error);
    }
    assert.ok(!diagnostic.includes(marker), `${label} error must not echo the attacker value`);
  }
  assert.equal(calls.length, 0, 'rejected arguments must not reach the child');

  const validBundle = {
    query: 'x',
    context: { facts: { constructor: 'zero', prototype: 'null', '鍵': '値' } },
    matter: { constructor: 0, prototype: null, nested: { constructor: [0, null], prototype: 'retained' }, 'ключ': 'значение' },
  };
  const validAnswer = {
    question: 'x',
    facts: { constructor: 'zero', prototype: 'null', safe_name: 'retained' },
    conversation_state: { constructor: 0, prototype: null, nested: { constructor: 0, prototype: [0, null, '✓'] }, '鍵': '値' },
  };
  assert.notEqual((await call(client, 'get_reference_bundle', validBundle)).isError, true);
  assert.notEqual((await call(client, 'answer_practitioner_question', validAnswer)).isError, true);
  assert.deepEqual(calls[0], ['get_reference_bundle', { ...validBundle, limit: 8 }]);
  assert.deepEqual(calls[1], ['answer_practitioner_question', validAnswer]);
});

test('P3-1 depth guard accepts depth 20 and rejects depth 21 for state and matter', async t => {
  let calls = 0;
  const client = await connect(t, { async callTool() { calls++; return {}; }, async close() {} });
  const nested = depth => { let value = 'leaf'; for (let i = depth; i >= 1; i--) value = i % 2 ? { child: value } : [value]; return value; };
  for (const [name, args] of [['answer_practitioner_question', { question: 'x', conversation_state: { root: nested(19) } }],
    ['get_reference_bundle', { query: 'x', context: {}, matter: nested(20) }]]) assert.notEqual((await call(client, name, args)).isError, true);
  assert.equal(calls, 2);
  await rejected(client, 'answer_practitioner_question', { question: 'x', conversation_state: { root: nested(20) } });
  await rejected(client, 'get_reference_bundle', { query: 'x', context: {}, matter: nested(21) });
  assert.equal(calls, 2);
});

test('P3-1 serialized argument envelope enforces inclusive 65,536-byte UTF-8 limit', async t => {
  let calls = 0;
  const client = await connect(t, { async callTool() { calls++; return {}; }, async close() {} });
  const withBytes = (target, base) => {
    const overhead = Buffer.byteLength(JSON.stringify(base));
    const holder = base.matter || base.context?.facts || base.conversation_state;
    holder.filler = 'a'.repeat(target - overhead);
    assert.equal(Buffer.byteLength(JSON.stringify(base)), target);
    const { limit: _limit, ...args } = base; // schema supplies the same default before the guard
    return args;
  };
  const matter = target => withBytes(target, { query: 'x', context: {}, matter: { filler: '' }, limit: 8 });
  const contextFacts = target => withBytes(target, { query: 'x', context: { facts: { prefix: '😀\u0000', filler: '' } }, limit: 8 });
  const state = target => withBytes(target, { question: 'x', conversation_state: { filler: '' } });
  for (const args of [matter(65_536), contextFacts(65_536), state(65_536)]) {
    const name = 'matter' in args || 'context' in args ? 'get_reference_bundle' : 'answer_practitioner_question';
    assert.notEqual((await call(client, name, args)).isError, true);
  }
  assert.equal(calls, 3);
  await rejected(client, 'get_reference_bundle', matter(65_537));
  await rejected(client, 'get_reference_bundle', contextFacts(65_537));
  await rejected(client, 'answer_practitioner_question', state(65_537));
  await rejected(client, 'get_reference_bundle', { query: 'x', context: { facts: { f: 'a'.repeat(33_000) } }, matter: { m: 'b'.repeat(33_000) } });
  assert.equal(calls, 3);
});

test('P3-2 stale failed client cannot reset a replacement child', async t => {
  const log = spawnLog();
  const c = await fake({ args: [FAKE, log], timeoutMs: 5000 });
  t.after(() => c.close());
  const first = await c.callTool('ping', {});
  const old = c.generation.client;
  let signalCaught;
  const caught = new Promise(resolve => { signalCaught = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const original = old.callTool.bind(old);
  old.callTool = async (...args) => { try { return await original(...args); } catch (error) { signalCaught(); await gate; throw error; } };
  try {
    const failed = c.callTool('crash', {});
    await caught;
    const replacement = await c.callTool('ping', {});
    assert.notEqual(replacement.pid, first.pid);
    assert.equal(pids(log).length, 2);
    release();
    assert.equal((await failed).error_code, 'SUBSIDY_DOMAIN_UNAVAILABLE');
    assert.equal((await c.callTool('ping', {})).pid, replacement.pid);
    assert.equal(pids(log).length, 2);
  } finally { release(); }
});

test('T2: exact forwarding, defaults, nullable objects and all valid boundary values', async t => {
  const calls = [];
  const client = await connect(t, { async callTool(name, args) { calls.push([name, args]); return {}; }, async close() {} });
  const inputs = [
    ['list_workflows', {}, {}],
    ['get_reference_bundle', { query: ' ', context: {} }, { query: ' ', context: {}, limit: 8 }],
    ['get_reference_bundle', { query: '😀'.repeat(2000), context: { role: 'tax_practitioner', facts: { '任意': '😀'.repeat(101) }, as_of: '0001-01-01' }, limit: 20, matter: { arbitrary: [1] } }],
    ['get_reference_bundle', { query: 'x', context: { task: null, role: null, facts: {} }, matter: null, limit: 1 }],
    ['search_references', { query: 'x' }, { query: 'x', limit: 8 }],
    ['search_references', { query: 'x', context: null, limit: 20 }],
    ['get_reference', { reference_id: '' }],
    ['answer_practitioner_question', { question: '😀'.repeat(500), perspective: 'recipient', regime: 'national_rnd', stage: '😀'.repeat(80), as_of: '2000-02-29', facts: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, '😀'.repeat(100)])), need_id: 'pn.subsidy.labor.١٢', conversation_state: { arbitrary: [1] }, followed_action_id: 'na.01' }],
    ['answer_practitioner_question', { question: ' ', perspective: null, regime: null, stage: null, as_of: null, facts: null, need_id: null, conversation_state: null, followed_action_id: null }],
    ['answer_practitioner_question', { question: 'x', stage: '', as_of: '9999-12-31' }],
    ['list_practitioner_topics', {}, { include_uncarded: false }],
    ['list_practitioner_topics', { regime: null, include_uncarded: true }],
    ['get_official_text', { doc_ref_id: 'law.test', article_key: '٠٠٠١٠٠٠', search: null }],
    ['get_official_text', { doc_ref_id: 'law.test', article_key: null, search: '😀'.repeat(60) }],
    ['get_official_text', { doc_ref_id: 'law.test', search: '\ufeff' }],
  ];
  for (const [name, args] of inputs) assert.notEqual((await call(client, name, args)).isError, true);
  assert.deepEqual(calls, inputs.map(([name, args, expected]) => [name, expected ?? args]));
  for (const role of ['applicant', 'official', 'reviewer', 'compliance', 'fund_manager', 'accountant', 'taxpayer']) {
    await call(client, 'search_references', { query: 'x', context: { role } });
  }
  for (const regime of ['subsidy', 'local_gov_subsidy', 'national_rnd', 'sme_support_general']) await call(client, 'list_practitioner_topics', { regime });
});

test('T2: invalid type/range/shape/XOR rejected before domain invocation', async t => {
  let calls = 0;
  const client = await connect(t, { async callTool() { calls++; return {}; }, async close() {} });
  const bad = [];
  const answer = patch => ['answer_practitioner_question', { question: 'x', ...patch }];
  for (const question of ['', 'q'.repeat(501), '😀'.repeat(501), null, 1]) bad.push(answer({ question }));
  for (const facts of [Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, 'x'])), { Bad: 'x' }, { 'x\n': 'x' }, { x: 'x'.repeat(101) }, { x: 1 }, []]) bad.push(answer({ facts }));
  for (const need_id of ['pn.subsidy.labor.1', 'pn.subsidy.labor.01\n', 'pn.x.y.01x', 'x'.repeat(121), 1]) bad.push(answer({ need_id }));
  for (const followed_action_id of ['na.1', 'na.01\n', 'na.١٢', 1]) bad.push(answer({ followed_action_id }));
  for (const as_of of ['2025-02-29', '2026-04-31', '0000-01-01', '2026-01-01\n', '2026-1-1', '2026-01-01T00:00:00', 0]) bad.push(answer({ as_of }));
  for (const patch of [{ stage: 'x'.repeat(81) }, { perspective: 'applicant' }, { regime: 'mixed_unclear' }, { conversation_state: [] }, { unexpected: 'x' }]) bad.push(answer(patch));
  for (const name of ['search_references', 'get_reference_bundle']) {
    for (const limit of [0, 21, 1.5, '8', true, null]) bad.push([name, { query: 'x', context: {}, limit }]);
    for (const query of ['', 'x'.repeat(2001), 1]) bad.push([name, { query, context: {} }]);
    for (const context of ['{}', [], { extra: 1 }, { role: 'other' }, { task: 'other' }, { funding_scheme: 'other' }, { facts: null }, { facts: { x: 1 } }, { as_of: 0 }, { ministry: 'x'.repeat(101) }, { project: 'x'.repeat(201) }, { domain: 'x'.repeat(81) }, { workflow: 'x'.repeat(101) }]) bad.push([name, { query: 'x', context }]);
  }
  bad.push(['get_reference_bundle', { query: 'x' }], ['get_reference_bundle', { query: 'x', context: null }], ['get_reference_bundle', { query: 'x', context: {}, matter: [] }]);
  for (const args of [{}, { article_key: null, search: null }, { article_key: '0001000', search: 'x' }, { article_key: '000100' }, { article_key: '0001000\n' }, { search: '' }, { search: '\u0085\u001c' }, { search: 'x'.repeat(61) }, { search: 1 }, { search: 'x', doc_ref_id: 'Law.test' }, { search: 'x', doc_ref_id: 'law.test\n' }, { search: 'x', doc_ref_id: 'law.' + 'x'.repeat(80) }]) bad.push(['get_official_text', { doc_ref_id: 'law.test', ...args }]);
  for (const include_uncarded of ['false', 0, null]) bad.push(['list_practitioner_topics', { include_uncarded }]);
  bad.push(['list_workflows', { extra: true }], ['get_reference', { reference_id: 1 }]);
  for (const [name, args] of bad) await rejected(client, name, args);
  assert.equal(calls, 0);
  t.diagnostic(`${bad.length} invalid boundary cases rejected before domain calls`);
});

test('T3: config defaults and invalid JSON use safe defaults', () => {
  assert.deepEqual(subsidyConfigFromEnv({}), { command: 'python3', args: ['-m', 'regulation_reference.server'], pythonPath: undefined });
  for (const value of ['bad', '{}', '[1]']) assert.deepEqual(subsidyConfigFromEnv({ AGENTLINK_SUBSIDY_MCP_ARGS: value }).args, ['-m', 'regulation_reference.server']);
  assert.deepEqual(subsidyConfigFromEnv({ AGENTLINK_SUBSIDY_MCP_COMMAND: 'custom', AGENTLINK_SUBSIDY_MCP_ARGS: '["-B","-m","regulation_reference.server"]', AGENTLINK_SUBSIDY_MCP_PYTHONPATH: '/src' }), { command: 'custom', args: ['-B', '-m', 'regulation_reference.server'], pythonPath: '/src' });
});

test('T3: safe unavailable, timeout, tool and malformed-result errors', async t => {
  const clients = [
    new SubsidyDomainClient({ command: '/nonexistent/SECRET_PATH', args: [] }),
    new SubsidyDomainClient({ command: process.execPath, args: ['-e', 'console.error("RAW_STDERR /secret/path"); process.exit(3)'] }),
    new SubsidyDomainClient({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 300 }), await fake(),
  ];
  await Promise.all(clients.slice(0, 3).map(client => client.initialize(genericContracts(['ping', 'fail', 'missing_structured', 'array_structured']))));
  t.after(async () => { await Promise.all(clients.map(c => c.close())); });
  for (const [index, name, expected] of [[0, 'ping', 'UNAVAILABLE'], [1, 'ping', 'UNAVAILABLE'], [2, 'ping', 'TIMEOUT'], [3, 'fail', 'TOOL_ERROR'], [3, 'missing_structured', 'ERROR'], [3, 'array_structured', 'ERROR']]) {
    const res = await clients[index].callTool(name, {});
    assert.equal(res.schema_version, 'subsidy-bridge-error.v1');
    assert.equal(res.error_code, `SUBSIDY_DOMAIN_${expected}`);
    assert.doesNotMatch(JSON.stringify(res), /SECRET|RAW_|\/secret|\/private|nonexistent/);
  }
  assert.deepEqual(await clients[3].callTool('fail', {}), { schema_version: 'subsidy-bridge-error.v1', error_code: 'SUBSIDY_DOMAIN_TOOL_ERROR', message: 'Subsidy domain tool reported an error.' });
});

test('T3: crash reconnect, first-call concurrency, timeout leaves shared child intact', async t => {
  const log = spawnLog();
  const c = await fake({ args: [FAKE, log], timeoutMs: 500 });
  t.after(() => c.close());
  const results = await Promise.all([1, 2, 3, 4].map(() => c.callTool('ping', {})));
  assert.equal(new Set(results.map(r => r.pid)).size, 1);
  assert.equal(pids(log).length, 1);
  assert.equal((await c.callTool('sleep', {})).error_code, 'SUBSIDY_DOMAIN_TIMEOUT');
  assert.equal((await c.callTool('ping', {})).pid, results[0].pid);
  assert.equal(pids(log).length, 1);
  assert.equal((await c.callTool('crash', {})).error_code, 'SUBSIDY_DOMAIN_UNAVAILABLE');
  const reconnected = await c.callTool('ping', {});
  assert.notEqual(reconnected.pid, results[0].pid);
  assert.equal(pids(log).length, 2);
});

test('T4: actual child receives only allowlisted env; SDK defaults are removed', async t => {
  const allowed = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'PYTHONPATH', 'REGULATION_CATALOG',
    'REGULATION_PRACTITIONER_REGISTRY_DIR', 'REGULATION_OFFICIAL_TEXT_DIR', 'REGULATION_USAGE_DIR', 'REGULATION_USAGE_SIGNALS'];
  const denied = ['AGENTLINK_CREDENTIALS_PATH', 'LAW_API_ID', 'AGENTLINK_CORE_URL', 'REGULATION_HOST', 'REGULATION_PORT',
    'REGULATION_EXPOSURE', 'REGULATION_ALLOWED_HOSTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy',
    'no_proxy', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'FOO_SECRET', 'LOGNAME', 'SHELL', 'TERM', 'USER'];
  const env = Object.fromEntries([...allowed, ...denied].map(k => [k, `test_${k}`]));
  env.PATH = process.env.PATH;
  env.__CF_USER_TEXT_ENCODING = 'parent_marker_must_not_forward';
  const previous = Object.fromEntries(['LOGNAME', 'SHELL', 'TERM', 'USER'].map(k => [k, process.env[k]]));
  for (const k of Object.keys(previous)) process.env[k] = `parent_${k}`;
  t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const c = await fake({ pythonPath: '/configured/pythonpath' }, env);
  t.after(() => c.close());
  const child = (await c.callTool('env_check', {})).env;
  // macOS initializes this native runtime variable even with spawn(env: {}).
  assert.notEqual(child.__CF_USER_TEXT_ENCODING, env.__CF_USER_TEXT_ENCODING);
  const keys = Object.keys(child).filter(k => process.platform !== 'darwin' || k !== '__CF_USER_TEXT_ENCODING');
  assert.deepEqual(keys.sort(), allowed.sort());
  for (const k of allowed) assert.equal(child[k], k === 'PYTHONPATH' ? '/configured/pythonpath' : env[k]);
  for (const k of denied) assert.equal(child[k], undefined, `${k} leaked to child`);
});

test('T5: structural domain errors and topic result wrappers pass unchanged without isError', async t => {
  const domain = await fake();
  const payload = await domain.callTool('structural_error', {});
  t.after(() => domain.close());
  for (const result of [payload, { result: [{ need_id: 'pn.subsidy.labor.01' }] }, { result: { error: 'practitioner_registry_unavailable' } }]) {
    const client = await connect(t, { async callTool() { return result; }, async close() {} });
    const response = await call(client, 'list_practitioner_topics');
    assert.equal(response.isError, undefined);
    assert.deepEqual(response.structuredContent, result);
    assert.deepEqual(JSON.parse(response.content[0].text), result);
  }
  const client = await connect(t, { async callTool() { return { schema_version: 'subsidy-bridge-error.v1', error_code: 'SUBSIDY_DOMAIN_ERROR', message: 'Subsidy domain call failed.' }; }, async close() {} });
  assert.equal((await call(client, 'list_workflows')).isError, true);
});

test('SDK eager close and subsidy shutdown share one awaited transport close', { timeout: 10_000 }, async () => {
  const originalClose = StdioClientTransport.prototype.close;
  let closeCalls = 0;
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  StdioClientTransport.prototype.close = function (...args) {
    closeCalls++;
    return gate.then(() => originalClose.apply(this, args));
  };
  const domain = new SubsidyDomainClient({ command: 'missing-subsidy-child-command', args: [], timeoutMs: 1_000 }, { PATH: process.env.PATH });
  let initializing;
  let closing;
  try {
    initializing = domain.initialize(FAKE_CONTRACTS);
    const deadline = Date.now() + 3_000;
    while (closeCalls === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(closeCalls, 1, 'the SDK eager close enters the owned transport close once');

    let closeSettled = false;
    closing = domain.close().then(() => { closeSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(closeCalls, 1, 'subsidy shutdown reuses the eager transport close');
    assert.equal(closeSettled, false, 'subsidy shutdown waits for that close to finish');
  } finally {
    StdioClientTransport.prototype.close = originalClose;
    releaseGate();
    await Promise.allSettled([initializing, closing].filter(Boolean));
  }
});
