import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../dist/server.js';
import { TaxDomainClient } from '../dist/domains/tax/bridge.js';
import { SubsidyDomainClient } from '../dist/domains/subsidy/bridge.js';
import { memoryDomainClient } from './tax/fixtures/memory-domain-client.mjs';

function lifecycleDomainClient(name, events, { delayMs = 0, rejectClose = false } = {}) {
  let status = { configured: true, state: 'uninitialized', verified_tool_names: [], verified_tool_count: 0 };
  let listener = () => {};
  let closeCalls = 0;
  const initialize = async (contracts = []) => {
    status = { configured: true, state: 'ready', verified_tool_names: contracts.map(({ publicName }) => publicName), verified_tool_count: contracts.length };
    listener({ ...status });
    return { ...status };
  };
  return {
    get closeCalls() { return closeCalls; },
    initialize,
    refresh: initialize,
    getStatus() { return { ...status, verified_tool_names: [...status.verified_tool_names] }; },
    setStatusListener(next) { listener = next; listener(this.getStatus()); },
    async callTool() { return {}; },
    async callToolResult() { return { content: [{ type: 'text', text: '{}' }], structuredContent: {} }; },
    async close() {
      closeCalls++;
      events.push(`${name}:started`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      events.push(`${name}:finished`);
      if (rejectClose) throw new Error(`${name} close failure`);
    },
  };
}

const invalidTax = () => new TaxDomainClient({ command: '', args: [], configInvalid: true });
const invalidSubsidy = () => new SubsidyDomainClient({ command: '', args: [], configInvalid: true });
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const installedUpper = join(repoRoot, 'dist', 'index.js');
const fakeTaxChild = join(repoRoot, 'tests', 'tax', 'fixtures', 'fake-child.mjs');

async function waitForPidExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { return error?.code === 'ESRCH'; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  try { process.kill(pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
}

function killOwnedPids(pids) {
  for (const pid of pids) {
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
    }
  }
}

async function launchInstalledUpper(scratch, mode = 'stderr-secret') {
  const pidFile = join(scratch, 'child-pids.log');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: scratch,
    TMPDIR: scratch,
    AGENTLINK_TAX_MCP_COMMAND: process.execPath,
    AGENTLINK_TAX_MCP_ARGS: JSON.stringify([fakeTaxChild, pidFile, mode]),
    AGENTLINK_CREDENTIALS_PATH: join(scratch, 'missing-credentials.json'),
  };
  const transport = new StdioClientTransport({ command: process.execPath, args: [installedUpper], cwd: scratch, env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'server-lifecycle-test', version: '1' });
  await client.connect(transport);
  const status = (await client.callTool({ name: 'agentlink_bridge_status', arguments: {} })).structuredContent;
  assert.equal(status.tax.state, 'ready');
  return { client, transport, pidFile, get stderr() { return stderr; } };
}

async function openServer(options) {
  const server = await createServer(options);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'server-assembly-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

test('default assembly hides demo/subsidy tools and keeps a safe diagnostic tool', async () => {
  const { server, client } = await openServer({ taxDomainClient: invalidTax() });
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['agentlink_bridge_status']);
    const status = (await client.callTool({ name: 'agentlink_bridge_status', arguments: {} })).structuredContent;
    assert.equal(status.tax.state, 'invalid');
    assert.equal(status.subsidy.state, 'not_configured');
    assert.equal(status.subsidy.configured, false);
  } finally {
    await client.close();
    await server.close();
  }
});

test('demo tools require explicit opt-in', async () => {
  const { server, client } = await openServer({ taxDomainClient: invalidTax(), demo: true });
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === 'get_vat_data'));
    assert.ok(tools.some((tool) => tool.name === 'get_business_info'));
    assert.equal(tools.some((tool) => tool.name.startsWith('subsidy_')), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test('an unavailable optional subsidy domain does not hide verified tax tools', async () => {
  const tax = memoryDomainClient();
  const { server, client } = await openServer({ taxDomainClient: tax, subsidyDomainClient: invalidSubsidy() });
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.filter((tool) => tool.name.startsWith('tax_')).length, 21);
    assert.equal(tools.some((tool) => tool.name.startsWith('subsidy_')), false);
    const status = (await client.callTool({ name: 'agentlink_bridge_status', arguments: {} })).structuredContent;
    assert.equal(status.tax.state, 'ready');
    assert.equal(status.tax.verified_tool_count, 21);
    assert.equal(status.subsidy.state, 'invalid');
  } finally {
    await client.close();
    await server.close();
  }
});

test('close awaits both domains and memoizes cleanup across EOF, rejection and repeated calls', async () => {
  const events = [];
  const tax = lifecycleDomainClient('tax', events, { delayMs: 80, rejectClose: true });
  const subsidy = lifecycleDomainClient('subsidy', events, { delayMs: 30 });
  const { server, client } = await openServer({ taxDomainClient: tax, subsidyDomainClient: subsidy });

  await client.close(); // The transport onclose hook also starts domain cleanup.
  const firstClose = server.close();
  const repeatedClose = server.close();
  assert.strictEqual(repeatedClose, firstClose, 'concurrent close calls should share one promise');
  await assert.doesNotReject(firstClose, 'a failed domain close must not skip or reject the other cleanup');
  assert.deepEqual(events, ['tax:started', 'subsidy:started', 'subsidy:finished', 'tax:finished']);
  assert.equal(tax.closeCalls, 1);
  assert.equal(subsidy.closeCalls, 1);
  assert.strictEqual(server.close(), firstClose, 'later close calls should reuse the completed close promise');
});

test('stdio EOF waits for the tax child shutdown and closes both owned processes', { timeout: 15_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'agentlink-upper-eof-'));
  let runtime;
  let ownedPids = [];
  try {
    runtime = await launchInstalledUpper(scratch);
    const upperPid = runtime.transport.pid;
    const [childPid, recordedUpperPid] = readFileSync(runtime.pidFile, 'utf8').trim().split(/\s+/).map(Number);
    ownedPids = [childPid, upperPid];
    assert.equal(recordedUpperPid, upperPid);

    await runtime.client.close(); // StdioClientTransport ends stdin; index.ts receives EOF and close.
    const exited = await Promise.all(ownedPids.map(pid => waitForPidExit(pid, 1_000)));
    if (exited.some(value => !value)) killOwnedPids(ownedPids);
    assert.deepEqual(exited, [true, true]);
    assert.doesNotMatch(runtime.stderr, /CHILD_STDERR_SECRET_SENTINEL|\/private\/fixture\/path/);
  } finally {
    try { await runtime?.client.close(); } catch { /* process may already be gone */ }
    if (runtime?.transport.pid) {
      try { await runtime.transport.close(); } catch { /* test cleanup */ }
    }
    killOwnedPids(ownedPids);
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('repeated SIGTERM signals reuse one awaited upper shutdown', { timeout: 15_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'agentlink-upper-sigterm-'));
  let runtime;
  let ownedPids = [];
  try {
    runtime = await launchInstalledUpper(scratch);
    const upperPid = runtime.transport.pid;
    const [childPid, recordedUpperPid] = readFileSync(runtime.pidFile, 'utf8').trim().split(/\s+/).map(Number);
    ownedPids = [childPid, upperPid];
    assert.equal(recordedUpperPid, upperPid);

    process.kill(upperPid, 'SIGTERM');
    try { process.kill(upperPid, 'SIGTERM'); } catch { /* first signal may already have completed shutdown */ }
    const exited = await Promise.all(ownedPids.map(pid => waitForPidExit(pid, 6_000)));
    if (exited.some(value => !value)) killOwnedPids(ownedPids);
    assert.deepEqual(exited, [true, true]);
    assert.doesNotMatch(runtime.stderr, /CHILD_STDERR_SECRET_SENTINEL|\/private\/fixture\/path/);
  } finally {
    try { await runtime?.client.close(); } catch { /* process may already be gone */ }
    if (runtime?.transport.pid) {
      try { await runtime.transport.close(); } catch { /* test cleanup */ }
    }
    killOwnedPids(ownedPids);
    rmSync(scratch, { recursive: true, force: true });
  }
});
