#!/usr/bin/env node

/**
 * AgentLink Korea - MCP Server Entry Point
 *
 * Starts the MCP server with stdio transport for local integration
 * with Claude Desktop, Claude Code, and other MCP-compatible clients.
 *
 * Usage:
 *   npx agentlink-mcp-server
 *   node dist/index.js
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  type OwnedServer = Awaited<ReturnType<typeof createServer>>;
  let server: OwnedServer | undefined;
  let stopping = false;
  let ownershipSettled = false;
  let resolveOwnership!: (created: OwnedServer | undefined) => void;
  const ownership = new Promise<OwnedServer | undefined>((resolve) => { resolveOwnership = resolve; });
  const settleOwnership = (created: OwnedServer | undefined) => {
    if (ownershipSettled) return;
    ownershipSettled = true;
    resolveOwnership(created);
  };

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (code: number): Promise<void> => {
    stopping = true;
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        let fallbackTimer: NodeJS.Timeout | undefined;
        const fallback = new Promise<void>((resolve) => {
          fallbackTimer = setTimeout(resolve, 6000);
          fallbackTimer.unref();
        });
        try {
          const closing = (async () => {
            const owned = server ?? (ownershipSettled ? undefined : await ownership);
            await owned?.close();
          })();
          await Promise.race([closing, fallback]);
        } catch {
          // Cleanup is best-effort; do not print paths or child errors at shutdown.
        } finally {
          if (fallbackTimer) clearTimeout(fallbackTimer);
          process.exit(code);
        }
      })();
    }
    return shutdownPromise;
  };

  // Install lifecycle listeners before discovery starts. In particular, stdin
  // must remain buffered so the MCP transport can consume initialization bytes.
  process.stdin.on("end", () => void shutdown(0));
  process.stdin.on("close", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  try {
    server = await createServer({
      onServerCreated(created) {
        server = created;
        settleOwnership(created);
        if (stopping) void created.close();
      },
    });
    settleOwnership(server);
    if (stopping) {
      await shutdownPromise;
      return;
    }
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch {
    settleOwnership(server);
    if (!stopping) console.error("Failed to start AgentLink MCP server.");
    await shutdown(stopping ? 0 : 1);
  }
}

void main();
