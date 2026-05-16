# Live test — CDP reconnect & connect-failure tracing

This doc walks an operator through a **live integration test** of the F4 CDP reconnect path: stop TradingView, wait for the tracer to capture failure events, restart TradingView, confirm the tracer captures success events. It complements the unit tests in [`tests/reconnect.test.js`](../tests/reconnect.test.js) — those prove the code emits the right events in isolation; this doc proves the events fire correctly end-to-end against a real Chrome DevTools Protocol attachment.

The test is **safe and reversible** — at most you lose ~60 seconds of live TradingView access. No data is destroyed.

## What this validates

| Event family | Path tested |
|---|---|
| `cdp.connect_attempt` (per retry) | `connect()` retry loop, every spawn |
| `cdp.connect_ok` (success) | Happy path — TV up, CDP bound |
| `cdp.connect_failed` (retry exhaustion) | Failure path — TV down or CDP not bound |
| `cdp.disconnected` (WS close) | Only when a long-lived MCP is attached AND TV closes during its lifetime — covered by the optional **long-lived server variant** below |
| `cdp.reconnect_*` (watchdog) | Same — long-lived variant only |

## Prerequisites

- TradingView Desktop installed at `/Applications/TradingView.app/` or `~/Applications/TradingView.app/`.
- The MCP server's caller (e.g. AURUM in this deployment) must have **`MCP_TRACE_FILE=/tmp/mcp-trace-aurum.log`** exported when it spawns MCP subprocesses. See [TRACING.md](./TRACING.md) for tracer activation.
- A way to stop and restart TradingView with `--remote-debugging-port=9222`. The signal-system deployment provides `make stop-tradingview` / `make start-tradingview` targets; the underlying shell is reproduced below for portability.
- `jq` for parsing NDJSON.

## Extracted shell scripts (deployment-agnostic)

The signal-system Makefile wraps these in `stop-tradingview` and `start-tradingview` targets. Reproduced here so anyone running the fork can adapt them — they're plain shell, no Make dependency.

### Stop TradingView

Equivalent to `make stop-tradingview`:

```bash
echo "Stopping TradingView Desktop..."
pkill -9 -f "TradingView" 2>/dev/null \
  && echo "✅ TradingView force-stopped" \
  || echo "  TradingView was not running"

pgrep -fal "TradingView" >/dev/null 2>&1 \
  && echo "⚠️  TradingView process still detected" \
  || echo "✅ TradingView fully terminated"
```

The `⚠️` line can be a false positive when other processes have "TradingView" in their command line (e.g. an MCP subprocess from the fork named `tradingview-mcp-aurum`). Verify with `curl -s --max-time 2 http://localhost:9222/json/list` — if it returns empty, the app is genuinely down regardless of the `pgrep` warning.

### Start TradingView with CDP enabled

Equivalent to `make start-tradingview`. The signal-system version lives in [`scripts/start_tradingview_cdp.sh`](https://github.com/ephico2real2/signal_system/blob/main/scripts/start_tradingview_cdp.sh); inlined here for self-containment:

```bash
#!/bin/bash
# Launch TradingView Desktop with Chrome DevTools Protocol enabled.

PORT="${1:-9222}"

# ── Locate the app
APP=""
for loc in \
  "/Applications/TradingView.app/Contents/MacOS/TradingView" \
  "$HOME/Applications/TradingView.app/Contents/MacOS/TradingView"; do
  if [ -f "$loc" ]; then APP="$loc"; break; fi
done
if [ -z "$APP" ]; then
  echo "❌ TradingView Desktop not found"; exit 1
fi

# ── Skip if already running with CDP
if curl -s "http://localhost:$PORT/json/version" >/dev/null 2>&1; then
  echo "✅ TradingView CDP already running on port $PORT"
  exit 0
fi

# ── Kill stale TV (no CDP) and relaunch
pkill -f "TradingView" 2>/dev/null
sleep 2

echo "Launching TradingView with --remote-debugging-port=$PORT ..."
open -a "TradingView" --args --remote-debugging-port=$PORT

# ── Wait up to 30s for CDP to come up
for i in $(seq 1 30); do
  if curl -s "http://localhost:$PORT/json/version" >/dev/null 2>&1; then
    echo "✅ TradingView CDP ready on port $PORT"
    exit 0
  fi
  sleep 1
done

echo "⚠️  CDP not responding after 30s"
exit 1
```

**Why `open -a` instead of running the binary directly**: `open -a` uses the macOS Launch Services path, which handles app-sandbox provisioning, Electron startup, and entitlements correctly. Running the binary directly (`/Applications/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=9222 &`) often races on Electron's window initialisation and leaves you with a partially-loaded app.

**Why port 9222**: Chrome's default for `--remote-debugging-port`. The fork's `src/connection.js` reads `CDP_PORT` from env (defaults to `9222`). Change both in lockstep if you need a different port.

### Linux / Windows operators

The same pattern works — just swap `pkill -f` (Linux) or `taskkill /F /IM TradingView.exe` (Windows) for the stop step, and adapt the launch step to whatever puts your platform's TradingView Desktop on the CDP port. The MCP server doesn't care about platform; it just connects to `http://$CDP_HOST:$CDP_PORT`.

## Test procedure

### Step 1 — Confirm baseline

```bash
# Trace file is hot
grep -n MCP_TRACE_FILE /Users/olasumbo/signal_system/.env  # should show MCP_TRACE_FILE=/tmp/mcp-trace-aurum.log

# CDP bound
curl -s --max-time 2 http://localhost:9222/json/list | \
  jq -r '.[] | select(.url | contains("tradingview.com/chart")) | "  ✅ TV chart: " + .id[0:12] + " " + .url[0:60]'

# AURUM running (or whatever your MCP consumer is)
ps -ef | grep "aurum.py" | grep -v grep | awk '{print "  ✅ AURUM PID=" $2}'
```

If any of these fails, fix it before continuing (e.g. `make reload-bridge`, `make start-tradingview`).

### Step 2 — Mark the trace position

```bash
MARK=$(wc -c < /tmp/mcp-trace-aurum.log)
echo "$MARK" > /tmp/mcp-trace-mark.txt
echo "MARK: $MARK bytes"
```

Save this number. Every later slice will read events from this byte forward.

### Step 3 — Stop TradingView

```bash
make stop-tradingview      # or the extracted shell from above
```

Confirm CDP is genuinely down:

```bash
curl -s --max-time 2 http://localhost:9222/json/list
# Expected: empty body (no targets) OR connection refused
```

### Step 4 — Wait for AURUM to spawn at least one failing MCP

AURUM polls TradingView every ~30 seconds for chart state. With CDP down, each spawn will hit the retry loop, retry 5 times with exponential backoff (≈15.5s total), then throw. Wait **at least 60 seconds** to capture 2-3 failure spawns.

Optional: trigger faster spawns by sending an AURUM Telegram query (e.g. "How's gold?") — that forces an immediate MCP spawn instead of waiting for the poll cycle.

### Step 5 — Slice the down-window

```bash
MARK=$(cat /tmp/mcp-trace-mark.txt)
CUR=$(wc -c < /tmp/mcp-trace-aurum.log)
NEW=$((CUR - MARK))
tail -c "$NEW" /tmp/mcp-trace-aurum.log > /tmp/mcp-trace-down.ndjson

echo "Events in down-window:"
jq -r '.kind' /tmp/mcp-trace-down.ndjson | sort | uniq -c | sort -rn
```

Expected output:

```
  N cdp.connect_attempt     # 5 per spawn (or fewer if MCP killed early)
  M cdp.connect_failed      # 1 per spawn IF the drain fix is in
  K evaluate.start          # the tool calls AURUM made
```

**For a single spawn, the failure-path NDJSON looks like**:

```json
{"kind":"cdp.connect_attempt","attempt":1,"max":5,"pid":47807}
{"kind":"cdp.connect_attempt","attempt":2,"max":5,"pid":47807}
{"kind":"cdp.connect_attempt","attempt":3,"max":5,"pid":47807}
{"kind":"cdp.connect_attempt","attempt":4,"max":5,"pid":47807}
{"kind":"cdp.connect_attempt","attempt":5,"max":5,"pid":47807}
{"kind":"cdp.connect_failed","attempts":5,"dur_ms":15609,"error":"fetch failed","pid":47807}
```

Timing between attempts traces the exponential backoff exactly — gaps of ~500ms, ~1000ms, ~2000ms, ~4000ms, ~8000ms. Total `dur_ms` on the terminal `cdp.connect_failed` event is ~15,500–15,700ms.

### Step 6 — Restart TradingView

```bash
make start-tradingview    # or the extracted shell
```

Wait for the script's `✅ TradingView CDP ready on port 9222` line. CDP is now bound again.

### Step 7 — Re-mark and capture the happy path

```bash
MARK2=$(wc -c < /tmp/mcp-trace-aurum.log)
echo "POST-RESTART MARK: $MARK2"
```

Wait another ~30 seconds for AURUM's next poll. Then slice:

```bash
CUR=$(wc -c < /tmp/mcp-trace-aurum.log)
NEW=$((CUR - MARK2))
tail -c "$NEW" /tmp/mcp-trace-aurum.log > /tmp/mcp-trace-up.ndjson

echo "Events in happy-path window:"
jq -r '.kind' /tmp/mcp-trace-up.ndjson | sort | uniq -c | sort -rn
```

Expected output:

```
  N cdp.connect_attempt     # 1 per spawn (succeeds on first try)
  N cdp.connect_ok          # 1 per spawn
  K evaluate.start
  K evaluate.end            # equal to start count — paired
```

Single-spawn happy path:

```json
{"kind":"cdp.connect_attempt","attempt":1,"max":5,"pid":48500}
{"kind":"cdp.connect_ok","target_id":"00C977CEFC31","target_url":"https://www.tradingview.com/chart/...","attempt":1,"dur_ms":124,"pid":48500}
{"kind":"evaluate.start","tool":"chart_get_state",...,"pid":48500}
{"kind":"evaluate.end","tool":"chart_get_state","dur_ms":2.4,"pid":48500}
```

## Validation table

Copy-paste this to your verification notes and fill in actuals:

| # | Check | Expected | Actual | Pass? |
|---|---|---|---|---|
| 1 | Down-window has `cdp.connect_attempt` events | ≥5 per failing spawn | | |
| 2 | Down-window has `cdp.connect_failed` events | 1 per failing spawn (100% w/ drain fix) | | |
| 3 | Failure `attempts` field equals `MAX_RETRIES` (5 by default) | 5 | | |
| 4 | Failure `dur_ms` ≈ 15.5s | 15,400–15,700ms | | |
| 5 | Failure `error` contains a meaningful string | "fetch failed" or "No TradingView chart target found" | | |
| 6 | Post-restart MCP spawns emit `cdp.connect_ok` | 1 per spawn | | |
| 7 | Happy-path `cdp.connect_ok` has `attempt: 1` | yes — succeeds on first try when CDP is bound | | |
| 8 | Happy-path `cdp.connect_ok.dur_ms` is small | <500ms typical, <2s worst | | |
| 9 | Happy-path `evaluate.start` count matches `evaluate.end` | exact 1:1 pairing | | |
| 10 | No `cdp.connect_failed` events in happy-path window | 0 | | |

## Long-lived server variant — exercises `cdp.disconnected` + `cdp.reconnect_*`

The above procedure tests the **spawn-per-call** pattern (AURUM's default). The watchdog path and the WS-close disconnect handler require a **long-lived** MCP server that survives the TV close+reopen cycle. To test those:

```bash
# Terminal 1 — start a long-lived MCP server with a fast watchdog
cd /Users/olasumbo/tradingview-mcp-aurum
MCP_TRACE_FILE=/tmp/mcp-trace-aurum.log \
MCP_TRACE_BUFFER_MS=0 \
CDP_WATCHDOG_INTERVAL_MS=5000 \
node src/server.js < /dev/null
# Leave running. Note the PID (echoed to your shell prompt or via `pgrep -f "src/server.js$"`)
```

```bash
# Terminal 2 — mark the trace, then close+reopen TV
MARK=$(wc -c < /tmp/mcp-trace-aurum.log)
make stop-tradingview
sleep 20                    # let the watchdog tick a few times with no CDP
make start-tradingview
sleep 15                    # let the watchdog detect recovery
```

```bash
# Terminal 1 — Ctrl-C the long-lived server now
# Terminal 2 — slice and inspect
PID=<the long-lived server's pid>
tail -c +$((MARK+1)) /tmp/mcp-trace-aurum.log | \
  jq "select(.pid == $PID and (.kind | startswith(\"cdp.\")))"
```

Expected sequence:

```json
{"kind":"cdp.connect_attempt","attempt":1,"pid":50000}
{"kind":"cdp.connect_ok","dur_ms":150,"pid":50000}                              // initial connect
{"kind":"cdp.disconnected","target_id":"...","pid":50000}                       // TV closed → WS close
{"kind":"cdp.reconnect_attempt","reason":"no_client","pid":50000}               // watchdog tick #1
{"kind":"cdp.connect_attempt","attempt":1,"pid":50000}
{"kind":"cdp.connect_failed","attempts":5,"error":"fetch failed","pid":50000}
{"kind":"cdp.reconnect_failed","reason":"no_client","dur_ms":15500,"error":"...","pid":50000}
// ...repeated while TV is down...
{"kind":"cdp.reconnect_attempt","reason":"no_client","pid":50000}               // first tick after TV comes back
{"kind":"cdp.connect_attempt","attempt":1,"pid":50000}
{"kind":"cdp.connect_ok","dur_ms":120,"pid":50000}
{"kind":"cdp.reconnect_ok","reason":"no_client","dur_ms":121,"reconnect_count":1,"pid":50000}
```

## Known limitation — `cdp.connect_failed` and SIGKILL

**Historical issue** (resolved 2026-05-16): The tracer's `emit()` was fire-and-forget. In the spawn-per-call pattern, AURUM's Python MCP client SIGKILLs the subprocess after a tool-call timeout (~15s) — close to the 15.5s retry-exhaustion duration. The race meant ~56% of `cdp.connect_failed` events were lost to truncation before the `appendFile` syscall completed.

**Fix shipped**: `emit()` now returns the write-queue Promise; `logOne()` propagates it; `trace.drain()` exposes a `Promise<void>` that resolves when all queued writes settle; `connect()` `await`s `trace.drain()` before throwing on retry exhaustion.

**Validation evidence (2026-05-16)** — pre-fix: 4 of 9 spawns captured `cdp.connect_failed` (44%):

```
12:46:12.310  pid=47807  attempts=5  dur_ms=15609  "fetch failed"
12:46:44.793  pid=47949  attempts=5  dur_ms=15598  "fetch failed"
12:47:01.028  pid=48024  attempts=5  dur_ms=15604  "fetch failed"
12:47:54.573  pid=48258  attempts=5  dur_ms=15606  "fetch failed"
```

**Post-fix** — every retry-exhaustion path must reach disk before the throw. Re-run the procedure with the latest `feat/cdp-reconnect` branch to verify 100% capture.

## When to run this test

- Before opening the upstream PR for F4 — final pre-flight against a real Chrome.
- After changing anything in `src/connection.js` (mutex, retry, watchdog, disconnect handler).
- After changing the tracer's `emit()` / `flush()` / `drain()` paths.
- When investigating a production "MCP went dark and didn't recover" report — re-run with the operator's exact env to reproduce.

## When NOT to run this test

- During an active trading session — the 60-second TV outage will interrupt any live chart-dependent tooling.
- If you don't have `MCP_TRACE_FILE` set — without the tracer the test produces no evidence.

## See also

- [`docs/TRACING.md`](./TRACING.md) — tracer architecture, env vars, NDJSON schema, jq recipes.
- [`tests/reconnect.test.js`](../tests/reconnect.test.js) — unit + integration tests for the same code paths.
- [`src/connection.js`](../src/connection.js) — the implementation under test.
