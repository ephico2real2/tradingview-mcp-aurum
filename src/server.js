import { randomUUID } from "node:crypto";
import * as http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { trace, withToolName } from "./tracer.js";
import { registerHealthTools } from "./tools/health.js";
import { registerChartTools } from "./tools/chart.js";
import { registerPineTools } from "./tools/pine.js";
import { registerDataTools } from "./tools/data.js";
import { registerCaptureTools } from "./tools/capture.js";
import { registerDrawingTools } from "./tools/drawing.js";
import { registerAlertTools } from "./tools/alerts.js";
import { registerBatchTools } from "./tools/batch.js";
import { registerReplayTools } from "./tools/replay.js";
import { registerIndicatorTools } from "./tools/indicators.js";
import { registerWatchlistTools } from "./tools/watchlist.js";
import { registerUiTools } from "./tools/ui.js";
import { registerPaneTools } from "./tools/pane.js";
import { registerTabTools } from "./tools/tab.js";
import { registerMorningTools } from "./tools/morning.js";

const server = new McpServer(
  {
    name: "tradingview",
    version: "2.0.0",
    description:
      "AI-assisted TradingView chart analysis and Pine Script development via Chrome DevTools Protocol",
  },
  {
    instructions: `TradingView MCP — 78 tools for reading and controlling a live TradingView Desktop chart.

TOOL SELECTION GUIDE — use this to pick the right tool:

Reading your chart:
- chart_get_state → get symbol, timeframe, all indicator names + entity IDs (call first)
- data_get_study_values → get current numeric values from ALL visible indicators (RSI, MACD, BB, EMA, etc.)
- quote_get → get real-time price snapshot (last, OHLC, volume)
- data_get_ohlcv → get price bars. ALWAYS pass summary=true unless you need individual bars

Reading custom Pine indicator output (line.new/label.new/table.new/box.new drawings):
- data_get_pine_lines → horizontal price levels from custom indicators (deduplicated, sorted)
- data_get_pine_labels → text annotations with prices ("PDH 24550", "Bias Long", etc.)
- data_get_pine_tables → table data as formatted rows (session stats, analytics dashboards)
- data_get_pine_boxes → price zones as {high, low} pairs
- ALWAYS pass study_filter to target a specific indicator by name (e.g., study_filter="Profiler")
- Indicators must be VISIBLE on chart for these to work

Changing the chart:
- chart_set_symbol, chart_set_timeframe, chart_set_type → change ticker/resolution/style
- chart_manage_indicator → add/remove studies. USE FULL NAMES: "Relative Strength Index" not "RSI"
- chart_scroll_to_date → jump to a date (ISO format)
- indicator_set_inputs → change indicator settings (length, source, etc.)

Pine Script development:
- pine_set_source → inject code, pine_smart_compile → compile + check errors
- pine_get_errors → read errors, pine_get_console → read log output
- WARNING: pine_get_source can return 200KB+ for complex scripts — avoid unless editing

Screenshots: capture_screenshot → regions: "full", "chart", "strategy_tester"
Replay: replay_start → replay_step → replay_trade → replay_status → replay_stop
Batch: batch_run → run action across multiple symbols/timeframes
Drawing: draw_shape → horizontal_line, trend_line, rectangle, text
Alerts: alert_create, alert_list, alert_delete
Launch: tv_launch → auto-detect and start TradingView with CDP on any platform
Panes: pane_list, pane_set_layout (s, 2h, 2v, 4, 6, 8), pane_focus, pane_set_symbol
Tabs: tab_list, tab_new, tab_close, tab_switch

CONTEXT MANAGEMENT:
- ALWAYS use summary=true on data_get_ohlcv
- ALWAYS use study_filter on pine tools when you know which indicator you want
- NEVER use verbose=true unless user specifically asks for raw data
- Prefer capture_screenshot for visual context over pulling large datasets
- Call chart_get_state ONCE at start, reuse entity IDs`,
  },
);

// Tracer hook: wrap server.tool so every registered handler runs inside
// the tracer's AsyncLocalStorage context. When MCP_TRACE_FILE is unset
// this is a no-op (withToolName returns the handler unchanged) — zero
// overhead. When tracing is on, every evaluate/evaluateWrite inside the
// handler picks up the originating MCP tool name automatically.
const _origTool = server.tool.bind(server);
server.tool = function (name, ...rest) {
  const handlerIdx = rest.findIndex((x) => typeof x === "function");
  if (handlerIdx >= 0) {
    rest[handlerIdx] = withToolName(name, rest[handlerIdx]);
  }
  return _origTool(name, ...rest);
};

// Register all tool groups
registerHealthTools(server);
registerChartTools(server);
registerPineTools(server);
registerDataTools(server);
registerCaptureTools(server);
registerDrawingTools(server);
registerAlertTools(server);
registerBatchTools(server);
registerReplayTools(server);
registerIndicatorTools(server);
registerWatchlistTools(server);
registerUiTools(server);
registerPaneTools(server);
registerTabTools(server);
registerMorningTools(server);

// Startup notice (stderr so it doesn't interfere with MCP stdio protocol)
process.stderr.write(
  "⚠  tradingview-mcp  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.\n",
);
process.stderr.write(
  "   Ensure your usage complies with TradingView's Terms of Use.\n\n",
);

// ─────────────────────────────────────────────────────────────────────
// Transport selection — stdio (default) or Streamable HTTP
//
// MCP_TRANSPORT=stdio (default, unchanged) — legacy stdio-per-consumer
//   pattern. Each MCP client spawns its own subprocess; the in-process
//   write mutex covers ONE consumer per process.
//
// MCP_TRANSPORT=http — Streamable HTTP transport per MCP spec
//   (https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
//   One server process serves N consumers over HTTP; the in-process
//   write mutex now covers ALL callers, eliminating the cross-process
//   race that the per-consumer-subprocess pattern can still hit. Bind
//   defaults to 127.0.0.1 (no external exposure on single-machine
//   deployments).
//
// Env vars:
//   MCP_TRANSPORT       stdio|http (default: stdio)
//   MCP_HTTP_HOST       bind address (default: 127.0.0.1)
//   MCP_HTTP_PORT       listen port (default: 8765)
//   MCP_HTTP_PATH       MCP endpoint path (default: /mcp)
//   MCP_HTTP_MAX_BODY   max request body bytes (default: 4194304 = 4MB)
// ─────────────────────────────────────────────────────────────────────

const TRANSPORT = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();

if (TRANSPORT === "http") {
  await startHttpTransport();
} else {
  // Legacy stdio behavior (default, unchanged for backward compat)
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function startHttpTransport() {
  const HOST = process.env.MCP_HTTP_HOST || "127.0.0.1";
  const PORT = parseInt(process.env.MCP_HTTP_PORT || "8765", 10);
  const PATH = process.env.MCP_HTTP_PATH || "/mcp";
  const MAX_BODY = parseInt(process.env.MCP_HTTP_MAX_BODY || "4194304", 10);

  // Per-session transport map. Each MCP session (one Mcp-Session-Id
  // header value) maps to its own StreamableHTTPServerTransport
  // instance. The same McpServer is connect()-ed to each transport —
  // the server's tool handlers are shared, the transport state
  // (initialized, message history) is per-session.
  const transports = new Map(); // sessionId -> StreamableHTTPServerTransport

  const httpServer = http.createServer(async (req, res) => {
    try {
      // Health probe — useful for `make health` integrations and
      // launchd liveness checks. Returns active-session count so
      // operators can spot session leaks.
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          transport: "http",
          active_sessions: transports.size,
          uptime_sec: process.uptime(),
        }));
        return;
      }

      // Only the configured MCP path is served — everything else 404s
      // so probes don't accidentally hit MCP handlers.
      const url = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
      if (url.pathname !== PATH) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found", path: url.pathname }));
        return;
      }

      // Body parsing — POST carries the JSON-RPC payload; GET/DELETE
      // do not. The SDK transport needs the pre-parsed body for POSTs.
      let body;
      if (req.method === "POST") {
        body = await readJsonBody(req, MAX_BODY);
      }

      const sessionId = req.headers["mcp-session-id"];
      let transport;

      if (typeof sessionId === "string" && transports.has(sessionId)) {
        // Existing session — route to its transport
        transport = transports.get(sessionId);
      } else if (req.method === "POST" && !sessionId && body && isInitializeRequest(body)) {
        // New session — initialize. Create a fresh transport with a
        // generated session ID; register cleanup on session close.
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport);
            trace("mcp.http.session_start", {
              sid,
              active_sessions: transports.size,
            });
          },
          onsessionclosed: (sid) => {
            transports.delete(sid);
            trace("mcp.http.session_end", {
              sid,
              active_sessions: transports.size,
            });
          },
        });
        // The SDK Transport interface attaches handlers; connect the
        // shared McpServer to this new transport instance.
        await server.connect(transport);
      } else {
        // No valid session AND not an initialize request — bad request
        // per MCP spec.
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: missing session ID and not an initialize request",
          },
          id: null,
        }));
        return;
      }

      // Hand off to the SDK transport — it handles the SSE/HTTP
      // streaming, JSON-RPC dispatch, 404 on invalid session ID,
      // session-termination on DELETE, etc., per the spec.
      await transport.handleRequest(req, res, body);
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 200);
      trace("mcp.http.error", { error: msg });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: `Internal error: ${msg}` },
          id: null,
        }));
      }
    }
  });

  httpServer.listen(PORT, HOST, () => {
    process.stderr.write(
      `   Streamable HTTP transport listening at http://${HOST}:${PORT}${PATH}\n` +
      `   Health: http://${HOST}:${PORT}/health\n\n`,
    );
  });

  // Graceful shutdown — close the HTTP server and any active session
  // transports cleanly so the SDK transport's session-close handlers
  // fire (which propagate cleanup to clients).
  const shutdown = async (signal) => {
    process.stderr.write(`\n[mcp-http] ${signal} received — shutting down\n`);
    for (const t of transports.values()) {
      try { await t.close(); } catch {}
    }
    httpServer.close(() => process.exit(0));
    // Force-exit if close hangs (e.g. on a long-running SSE stream)
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

/**
 * Read a JSON body from an IncomingMessage. Caps at maxBytes to
 * prevent unbounded memory usage. Returns null for empty bodies.
 */
function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        req.destroy();
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve(null);
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error(`Invalid JSON body: ${e.message}`)); }
    });
    req.on("error", reject);
  });
}
