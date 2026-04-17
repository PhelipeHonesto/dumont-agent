/**
 * Dumont MCP Server — stdio transport for local use (Claude Desktop, CLI).
 *
 * Usage: npx tsx src/mcp/server.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeDb, setPgBridge } from "../memory/database.js";
import { registerTools } from "./tools.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("mcp-server");

// Initialize PG bridge if postgres mode
if (process.env.DATABASE_TYPE === "postgres") {
  const { getPgBridge } = await import("../memory/pg-database.js");
  setPgBridge(getPgBridge());
}

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
  log.fatal({ err }, "MCP server failed to start");
  process.exit(1);
});
