/** Verified AgentLink MCP server assembly. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DomainStatus, TaxDomainClientLike } from "./domains/tax/bridge.js";
import { TaxDomainClient } from "./domains/tax/bridge.js";
import type { SubsidyDomainClientLike, SubsidyDomainStatus } from "./domains/subsidy/bridge.js";
import { SubsidyDomainClient, subsidyConfigFromEnv, subsidyDomainConfigured } from "./domains/subsidy/bridge.js";
import { registerTaxDomainTools } from "./domains/tax/tools.js";
import { registerSubsidyDomainTools } from "./domains/subsidy/tools.js";
import { StubDataProvider } from "./types/index.js";
import type { DataProvider } from "./types/index.js";
import { registerTaxTools } from "./tools/tax.js";
import { registerBusinessTools } from "./tools/business.js";
import { registerPublicDataTools } from "./tools/public-data.js";
import { registerLegalTools } from "./tools/legal.js";
import { registerDisasterTools } from "./tools/disaster.js";
import { z } from "zod";

export interface CreateServerOptions {
  /** Explicit provider exposes the legacy data tools. */
  provider?: DataProvider;
  /** Explicit demonstration opt-in for StubDataProvider tools. */
  demo?: boolean;
  taxDomainClient?: TaxDomainClientLike;
  subsidyDomainClient?: SubsidyDomainClientLike;
  /** Receives cleanup ownership before configured domain discovery begins. */
  onServerCreated?: (server: McpServer) => void;
}

function emptySubsidyStatus(): SubsidyDomainStatus {
  return { configured: false, state: "not_configured", verified_tool_names: [], verified_tool_count: 0 };
}

/** Build the server and expose cleanup ownership before configured domain discovery. */
export async function createServer(options: CreateServerOptions = {}): Promise<McpServer> {
  const server = new McpServer({ name: "agentlink-korea", version: "0.1.0" });
  const demo = options.demo === true || process.env.AGENTLINK_DEMO_TOOLS === "1";
  if (demo || options.provider) {
    const provider = options.provider ?? new StubDataProvider();
    registerTaxTools(server, provider);
    registerBusinessTools(server, provider);
    registerPublicDataTools(server, provider);
    registerLegalTools(server, provider);
    registerDisasterTools(server, provider);
  }

  const taxClient = options.taxDomainClient ?? new TaxDomainClient();
  const subsidyConfigured = options.subsidyDomainClient !== undefined || subsidyDomainConfigured();
  const subsidyClient = options.subsidyDomainClient ?? (subsidyConfigured ? new SubsidyDomainClient(subsidyConfigFromEnv()) : undefined);
  const taxTools = registerTaxDomainTools(server, taxClient);
  const subsidyTools = subsidyClient ? registerSubsidyDomainTools(server, subsidyClient) : undefined;

  server.tool("agentlink_bridge_status", "Show which optional domain tools passed MCP discovery, or refresh unavailable domains.",
    { refresh: z.boolean().optional().describe("Retry configured domains that are unavailable or invalid.") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ refresh }) => {
      if (refresh) {
        await Promise.all([
          taxClient.refresh(taxTools.contracts),
          ...(subsidyClient && subsidyTools ? [subsidyClient.refresh(subsidyTools.contracts)] : []),
        ]);
      }
      const status = {
        schema_version: "agentlink-bridge-status.v1",
        tax: taxClient.getStatus(),
        subsidy: subsidyClient?.getStatus() ?? emptySubsidyStatus(),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(status) }], structuredContent: status };
    });

  const prevOnClose = server.server.onclose;
  let closing = false;
  let domainClosePromise: Promise<void> | undefined;
  const closeDomainClients = (): Promise<void> => {
    closing = true;
    if (!domainClosePromise) {
      domainClosePromise = Promise.allSettled([
        Promise.resolve().then(() => taxClient.close()),
        ...(subsidyClient ? [Promise.resolve().then(() => subsidyClient.close())] : []),
      ]).then(() => undefined);
    }
    return domainClosePromise;
  };

  server.server.onclose = () => {
    void closeDomainClients();
    prevOnClose?.();
  };

  const originalClose = server.close.bind(server);
  let serverClosePromise: Promise<void> | undefined;
  server.close = (): Promise<void> => {
    closing = true;
    if (!serverClosePromise) {
      serverClosePromise = Promise.allSettled([
        Promise.resolve().then(() => originalClose()),
        closeDomainClients(),
      ]).then(() => undefined);
    }
    return serverClosePromise;
  };

  try {
    options.onServerCreated?.(server);
    if (closing) return server;

    await Promise.all([
      taxClient.initialize(taxTools.contracts).catch(() => ({
        configured: true, state: "unavailable", error_code: "TAX_DOMAIN_UNAVAILABLE", verified_tool_names: [], verified_tool_count: 0,
      } satisfies DomainStatus)),
      ...(subsidyClient && subsidyTools ? [subsidyClient.initialize(subsidyTools.contracts).catch(() => ({
        configured: true, state: "unavailable", error_code: "SUBSIDY_DOMAIN_UNAVAILABLE", verified_tool_names: [], verified_tool_count: 0,
      } satisfies SubsidyDomainStatus))] : []),
    ]);

    return server;
  } catch (error) {
    await server.close();
    throw error;
  }
}
