import test from 'node:test';
import assert from 'node:assert/strict';
import { checkScope, withScopeGuard, isEmptyScopeValue } from '../../dist/perf/scope-guard.js';

const config = (extra = {}) => ({
  scopeFields: ['group', 'category_prefix'],
  messageTemplate: 'Searching "{subject}" needs one of: {fields}.',
  subjectField: 'keyword',
  appliesTo: (args) => Boolean(args.keyword),
  bypassEnvVar: 'EXAMPLE_ALLOW_UNSCOPED',
  env: {},
  ...extra,
});

test('empty values are recognized', () => {
  for (const value of [undefined, null, '', '  ', [], [''], {}]) assert.equal(isEmptyScopeValue(value), true);
  for (const value of ['a', ['a'], 0, false, { a: 1 }]) assert.equal(isEmptyScopeValue(value), false);
});

test('unscoped call is blocked with structured guidance and never reaches the backend', async () => {
  let backendCalls = 0;
  const guarded = withScopeGuard(async () => {
    backendCalls += 1;
    return { rows: [] };
  }, config());
  const result = await guarded({ keyword: 'widgets' });
  assert.equal(backendCalls, 0);
  assert.equal(result.error, 'scope_required');
  assert.equal(result.transient, true);
  assert.deepEqual(result.required_any_of, ['group', 'category_prefix']);
  assert.equal(result.message, 'Searching "widgets" needs one of: group, category_prefix.');
  assert.equal('bypass_env' in result, false);
});

test('scoped call passes through', async () => {
  const guarded = withScopeGuard(async (args) => ({ rows: [args.group] }), config());
  assert.deepEqual(await guarded({ keyword: 'widgets', group: 'g1' }), { rows: ['g1'] });
});

test('calls the guard does not apply to pass through', async () => {
  const guarded = withScopeGuard(async () => 'ok', config());
  assert.equal(await guarded({}), 'ok');
});

test('bypass variable disables the guard; name is revealed only when configured', async () => {
  const bypass = config({ env: { EXAMPLE_ALLOW_UNSCOPED: 'true' } });
  assert.equal(checkScope({ keyword: 'x' }, bypass), null);
  const reveal = checkScope({ keyword: 'x' }, config({ revealBypass: true }));
  assert.equal(reveal.bypass_env, 'EXAMPLE_ALLOW_UNSCOPED');
  assert.notEqual(checkScope({ keyword: 'x' }, config({ env: { EXAMPLE_ALLOW_UNSCOPED: '0' } })), null);
});
