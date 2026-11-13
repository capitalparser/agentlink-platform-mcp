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
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown: close server (and tax child) with a bounded wait.
  // StdioServerTransport does not fire onclose on stdin EOF, so listen explicitly.
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (code: number): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        let fallbackTimer: NodeJS.Timeout | undefined;
        const fallback = new Promise<void>((resolve) => {
          fallbackTimer = setTimeout(resolve, 6000);
          fallbackTimer.unref();
        });
        try {
          await Promise.race([server.close(), fallback]);
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

  process.stdin.on("end", () => void shutdown(0));
  process.stdin.on("close", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
}

main().catch(() => {
  console.error("Failed to start AgentLink MCP server.");
  process.exit(1);
});
