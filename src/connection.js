import CDP from 'chrome-remote-interface';
import { Mutex } from 'async-mutex';
import { trace } from './tracer.js';

let client = null;
let targetInfo = null;

// Write-tool serialization mutex.
//
// Why: stdio MCP and Streamable HTTP both support concurrent in-flight
// requests; the MCP SDK dispatches handlers as async tasks. CDP itself
// supports concurrent commands (response matching by id), so two
// evaluate() calls reach Chrome on the same connection and Chrome's
// single JS thread runs them in arrival order. For READ tools that's
// fine. For WRITE tools (chart_set_symbol, chart_set_timeframe,
// chart_manage_indicator, draw_shape, etc.) interleaving can leave the
// page in an inconsistent state — e.g. two rapid chart_set_symbol calls
// from different clients can race on the symbol-load lifecycle and the
// "winner" depends on Chrome's microtask scheduling rather than arrival
// order.
//
// Solution: evaluateWrite() runs inside a process-wide async mutex.
// Concurrent writes serialize; reads stay unblocked. The classification
// is per-handler (see src/core/<module>.js) — handlers calling
// state-mutating JS expressions use evaluateWrite(); read-only handlers
// stay on evaluate().
//
// Per-instance scope: one MCP server process = one mutex. If you run
// multiple MCP processes against the same Chrome (legacy stdio
// per-consumer pattern), the mutex does NOT cross processes — each MCP
// has its own. The recommended deployment is one MCP process serving
// multiple consumers via Streamable HTTP, where the mutex covers all
// callers.
const writeMutex = new Mutex();
const CDP_HOST = process.env.CDP_HOST || 'localhost';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);
const MAX_RETRIES = parseInt(process.env.CDP_MAX_RETRIES || '5', 10);
const BASE_DELAY = parseInt(process.env.CDP_BASE_DELAY_MS || '500', 10);

// CDP connection lifecycle state.
//
// Why: Chrome can restart (user-initiated, crash, TradingView Desktop
// updates the embedded Chromium). The pre-F4 per-call liveness ping in
// getClient() catches this LAZILY — only on the next tool call, often
// surfacing as a confusing "TargetClosed"/"WebSocket closed" error
// inside whatever handler happens to fire first. For consumers that
// poll every 30-60s (LENS, AURUM) this can mean a minute of dead air
// before the system self-heals.
//
// F4 adds two cooperating mechanisms:
//   1. Disconnect handler — chrome-remote-interface emits 'disconnect'
//      when the underlying WebSocket closes. We null the cached
//      client/targetInfo IMMEDIATELY so the next caller doesn't reuse a
//      dead handle.
//   2. Watchdog timer — every CDP_WATCHDOG_INTERVAL_MS, ping the live
//      client; on failure, fire a fresh connect(). This surfaces a dead
//      connection within one watchdog interval rather than waiting for
//      a tool call.
//
// Both are observable via the tracer: cdp.disconnected,
// cdp.reconnect_attempt, cdp.reconnect_ok, cdp.reconnect_failed.
// getConnectionStatus() exposes the state machine for the
// tv_cdp_status tool / /api/health probes.
let lastPingMs = 0;
let reconnectCount = 0;
let watchdogTimer = null;
let reconnectInFlight = false;

const WATCHDOG_INTERVAL_MS = parseInt(process.env.CDP_WATCHDOG_INTERVAL_MS || '30000', 10);
const WATCHDOG_ENABLED = WATCHDOG_INTERVAL_MS > 0;

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

export async function getClient() {
  if (client) {
    try {
      // Quick liveness check
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      lastPingMs = Date.now();
      return client;
    } catch {
      client = null;
      targetInfo = null;
    }
  }
  return connect();
}

export async function connect() {
  let lastError;
  const t0 = Date.now();
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    trace('cdp.connect_attempt', { attempt: attempt + 1, max: MAX_RETRIES });
    try {
      const target = await findChartTarget();
      if (!target) {
        throw new Error('No TradingView chart target found. Is TradingView open with a chart?');
      }
      targetInfo = target;
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Register disconnect handler — null the cached handle the moment
      // chrome-remote-interface tells us the WebSocket closed. Without
      // this, the next caller hits a stale client and only learns of
      // the failure mid-evaluate.
      client.on('disconnect', () => {
        const wasConnected = client !== null;
        client = null;
        targetInfo = null;
        if (wasConnected) {
          trace('cdp.disconnected', { target_id: target.id, target_url: target.url });
        }
      });

      // Enable required domains
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();

      lastPingMs = Date.now();
      startWatchdog();
      trace('cdp.connect_ok', {
        target_id: target.id,
        target_url: target.url,
        attempt: attempt + 1,
        dur_ms: +(Date.now() - t0).toFixed(2),
      });
      return client;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  trace('cdp.connect_failed', {
    attempts: MAX_RETRIES,
    dur_ms: +(Date.now() - t0).toFixed(2),
    error: String(lastError?.message || lastError || 'unknown').slice(0, 200),
  });
  // Critical path — about to throw. A parent process (e.g. AURUM's
  // Python MCP client with a ~15s tool-call timeout) may SIGKILL this
  // subprocess the moment we throw, before the fire-and-forget
  // appendFile chain settles. Await drain() to guarantee the
  // cdp.connect_failed event reaches disk first.
  await trace.drain();
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

// Watchdog: periodically ping the live CDP connection so disconnects
// surface within one interval even when no tool calls are happening.
//
// Idempotent — safe to call from connect() on every reconnect. Stops
// itself if disconnect() is called explicitly.
function startWatchdog() {
  if (!WATCHDOG_ENABLED) return;
  if (watchdogTimer) return;
  watchdogTimer = setInterval(watchdogTick, WATCHDOG_INTERVAL_MS);
  // Don't keep the process alive purely for the watchdog — let stdio
  // shutdown / SIGTERM end cleanly.
  if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
}

function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

async function watchdogTick() {
  if (reconnectInFlight) return;          // serialize reconnects
  if (!client) {
    // No client cached — try to (re)connect proactively so the next
    // tool call doesn't pay the cold-start cost.
    await reconnectFromWatchdog('no_client');
    return;
  }
  try {
    await client.Runtime.evaluate({ expression: '1', returnByValue: true });
    lastPingMs = Date.now();
  } catch (err) {
    // Ping failed — connection is dead but the 'disconnect' event may
    // not have fired yet (or we missed it). Force reconnect.
    client = null;
    targetInfo = null;
    await reconnectFromWatchdog(String(err?.message || err).slice(0, 200));
  }
}

async function reconnectFromWatchdog(reason) {
  reconnectInFlight = true;
  const t0 = Date.now();
  trace('cdp.reconnect_attempt', { reason });
  try {
    await connect();
    reconnectCount += 1;
    trace('cdp.reconnect_ok', {
      reason,
      dur_ms: +(Date.now() - t0).toFixed(2),
      reconnect_count: reconnectCount,
    });
  } catch (err) {
    trace('cdp.reconnect_failed', {
      reason,
      dur_ms: +(Date.now() - t0).toFixed(2),
      error: String(err?.message || err).slice(0, 200),
    });
    // Don't rethrow — watchdog runs in background; next tick will retry.
  } finally {
    reconnectInFlight = false;
  }
}

/**
 * Return a snapshot of the CDP connection state. Used by the
 * tv_cdp_status MCP tool and any operator health probe.
 */
export function getConnectionStatus() {
  return {
    connected: client !== null,
    target_id: targetInfo?.id ?? null,
    target_url: targetInfo?.url ?? null,
    last_ping_ms_ago: lastPingMs > 0 ? Date.now() - lastPingMs : null,
    reconnect_count: reconnectCount,
    watchdog_enabled: WATCHDOG_ENABLED,
    watchdog_interval_ms: WATCHDOG_ENABLED ? WATCHDOG_INTERVAL_MS : 0,
    reconnect_in_flight: reconnectInFlight,
  };
}

async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  // Prefer targets with tradingview.com/chart in the URL
  return targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
    || null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const span = trace.start('evaluate', expression);
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    span.error(msg);
    throw new Error(`JS evaluation error: ${msg}`);
  }
  span.end();
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

/**
 * Run an evaluate() under the process-wide write mutex.
 *
 * Use this for any handler whose JS expression MUTATES chart/page state
 * — chart_set_*, indicator add/remove, draw_*, alert_create/delete,
 * pane_set_*, tab_*, pine_set_source, pine_smart_compile, replay_*,
 * batch_run when it contains write subtasks.
 *
 * Read-only handlers stay on evaluate() — no contention, no overhead.
 *
 * @param {string} expression - JS expression to evaluate on the page.
 * @param {object} [opts] - Same options as evaluate().
 * @returns {Promise<*>} - Same return shape as evaluate().
 */
export async function evaluateWrite(expression, opts = {}) {
  const span = trace.startWrite(expression);
  return writeMutex.runExclusive(async () => {
    span.acquired();
    try {
      const r = await evaluate(expression, opts);
      span.released();
      return r;
    } catch (e) {
      span.error(String(e.message || e));
      throw e;
    }
  });
}

/**
 * Run a multi-step write sequence (multiple evaluate() calls) atomically
 * under the write mutex. Use this when a single logical operation issues
 * 2+ JS evaluations that must NOT interleave with another writer's
 * sequence — e.g. chart_manage_indicator captures the before-snapshot,
 * runs the add/remove, then captures the after-snapshot.
 *
 * The callback receives the unlocked evaluate() so it can run multiple
 * reads/writes inside the critical section without re-locking.
 *
 * @param {function((string, object?) => Promise<*>): Promise<*>} fn
 *   Async callback that receives evaluate() and returns its result.
 * @returns {Promise<*>}
 */
export async function withWriteLock(fn) {
  const span = trace.startSection();
  return writeMutex.runExclusive(async () => {
    span.acquired();
    try {
      const r = await fn(evaluate);
      span.released();
      return r;
    } catch (e) {
      span.error(String(e.message || e));
      throw e;
    }
  });
}

export async function disconnect() {
  stopWatchdog();
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
