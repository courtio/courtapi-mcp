#!/usr/bin/env node
/**
 * CourtAPI MCP Server
 *
 * Transport:
 *   stdio (default) — Claude Desktop, local agents
 *   HTTP            — pass --http  (PORT env, default 3000)
 *
 * Credentials:
 *   COURTAPI_APP_ID   your app_id
 *   COURTAPI_APP_KEY  your app_key
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { tools } from "./tools.js";

const server = new McpServer({ name: "courtapi", version: "0.1.0" });

for (const { name, description, inputSchema, handler } of tools) {
  server.registerTool(
    name,
    { description, inputSchema },
    async (args) => {
      const result = await handler(args as Record<string, unknown>);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );
}

async function main() {
  if (process.argv.includes("--http")) {
    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );
    const { createServer } = await import("node:http");
    const port = Number(process.env.PORT ?? 3000);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
    await server.connect(transport);
    createServer((req, res) => transport.handleRequest(req, res)).listen(port, () =>
      process.stderr.write(`CourtAPI MCP listening on http://localhost:${port}\n`)
    );
  } else {
    await server.connect(new StdioServerTransport());
    process.stderr.write("CourtAPI MCP running on stdio\n");
  }
}

main().catch(err => { process.stderr.write(`Fatal: ${err}\n`); process.exit(1); });
