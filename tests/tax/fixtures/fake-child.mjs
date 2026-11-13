// Stdio fixture whose tools/list schemas come from the public tax registrations.
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { registerTaxDomainTools } from '../../../dist/domains/tax/tools.js';

if (process.argv[2]) appendFileSync(process.argv[2], `${process.pid} ${process.ppid}\n`);
if (process.argv[3] === 'stderr-secret') process.stderr.write('CHILD_STDERR_SECRET_SENTINEL /private/fixture/path\n');
if (process.argv[3] === 'health-timeout') process.on('SIGTERM', () => {});
if (process.argv[3] === 'initialization-hang' || process.argv[3] === 'initialization-hang-ignore-sigterm') {
  if (process.argv[3] === 'initialization-hang-ignore-sigterm') process.on('SIGTERM', () => {});
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else {

const schemaServer = new McpServer({ name: 'tax-schema-source', version: '0' });
const registered = registerTaxDomainTools(schemaServer, {
  setStatusListener(listener) { listener({ configured: true, state: 'ready', verified_tool_names: [], verified_tool_count: 0 }); },
  async initialize() { return this.getStatus(); }, async refresh() { return this.getStatus(); },
  getStatus() { return { configured: true, state: 'ready', verified_tool_names: [], verified_tool_count: 0 }; },
  async callTool() { return {}; }, async callToolResult() { return { content: [{ type: 'text', text: '{}' }], structuredContent: {} }; },
  async close() {},
});

const server = new McpServer({ name: 'fake-tax', version: '0' });
const ok = (structuredContent) => ({ content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent });
for (let index = 0; index < registered.contracts.length; index++) {
  const { domainName } = registered.contracts[index];
  server.registerTool(domainName, { inputSchema: registered.handles[index].inputSchema }, async (args) => {
    if (domainName === 'health') {
      if (process.argv[3] === 'health-timeout') await new Promise((resolve) => setTimeout(resolve, 15_000));
      return ok({ status: 'ok', version: 'fixture-1', workflows: 3, credentials: { law_go_kr_oc: false } });
    }
    if (domainName === 'list_tax_workflows') {
      return ok({ domain: 'tax', workflows: [
        { id: 'withholding-payment' }, { id: 'vat-return' }, { id: 'corporate-adjustment' },
      ] });
    }
    if (domainName === 'route_tax_question') {
      return ok({ schema_version: 'tax-question-route.v1', status: 'unmatched', requires_confirmation: true, candidates: [] });
    }
    return ok({ name: domainName, args });
  });
}
server.tool('ping', 'ping', {}, async () => ok({ pid: process.pid }));
server.tool('crash', 'crash', {}, async () => { process.exit(1); });
server.tool('sleep', 'sleep', {}, async () => {
  // Exceeds the request-timeout regression's 3000 ms client budget.
  await new Promise((resolve) => setTimeout(resolve, 10000));
  return ok({ slept: true });
});
server.tool('env_check', 'env', {}, async () => ok({
  has_secret: process.env.FOO_SECRET !== undefined,
  has_proxy: process.env.HTTPS_PROXY !== undefined,
  automation_offer_path: process.env.AGENTLINK_AUTOMATION_OFFER_PATH,
}));
server.tool('fail', 'fail', {}, async () => ({
  isError: true,
  content: [{ type: 'text', text: 'RAW_DOMAIN_SECRET /private/path' }],
}));
await server.connect(new StdioServerTransport());
}
