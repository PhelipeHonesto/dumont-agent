/**
 * Dumont MCP Server — stdio transport for local use (Claude Desktop, CLI).
 *
 * Usage: npx tsx src/mcp/server.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeDb } from "../memory/database.js";
import { registerTools } from "./tools.js";

const server = new McpServer(
  { name: "dumont-intelligence", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Dumont Aviation Intelligence — query FAA registry, ADS-B flight data, " +
      "ghost fleet candidates, market listings, and route analytics for US " +
      "charter-class aircraft.",
  },
);

registerTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", async () => {
    closeDb();
    await server.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    closeDb();
    await server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("MCP server failed to start:", err);
  process.exit(1);
});
