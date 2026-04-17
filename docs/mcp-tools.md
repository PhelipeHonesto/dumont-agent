# MCP tools

Exposes Dumont intelligence to Claude clients (Desktop, Code) via the
Model Context Protocol.

- **Stdio transport** (local use): `npm run mcp:serve` → `src/mcp/server.ts`. Registered in `claude_desktop_config.json`.
- **SSE transport** (remote use): `npm run mcp:sse` → `src/mcp/server-sse.ts` on port 3002. Claude Code pulls from `api.orangesunshineaviation.com/sse` (see `.mcp.json`). Auth: `MCP_AUTH_TOKEN` (Bearer). Skipped when unset (dev mode).
- **Server name**: `dumont-intelligence`. Tools query the database directly (no HTTP round-trip).

## Tool inventory (12 tools, `src/mcp/tools.ts`)

| Tool | Purpose |
|------|---------|
| `lookup_aircraft` | Full aircraft profile by tail number |
| `get_flights` | Flight history for an aircraft |
| `find_ghosts` | Ghost fleet candidates near an airport |
| `fleet_stats` | Fleet intelligence summary |
| `route_intel` | Route analytics between two airports |
| `active_listings` | For-sale aircraft listings |
| `recent_transactions` | FAA ownership changes |
| `data_health` | Data freshness traffic light |
| `feed_health` | ADS-B feed status |
| `market_overview` | Monthly market intelligence (WINGX-equivalent) |
| `operator_analysis` | Operator deep dive — utilization, routes, trend |
| `airport_report` | Hourly airport activity report |

## Notes on stdio safety

The stdio server communicates MCP protocol messages on **stdout**. All
Dumont logging writes to **stderr only** (`src/utils/logger.ts`
configures pino with `destination: 2`). Do not add `console.log`
anywhere on the stdio server's hot path — it will corrupt the protocol
stream.

## External MCP servers (`.mcp.json`)

- **Sentry MCP** (`https://mcp.sentry.dev/mcp`) — production error queries from Claude Code. OAuth flow the first time.
