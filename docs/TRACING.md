# MCP Packet Tracing

Optional NDJSON trace of every CDP `evaluate()` and `evaluateWrite()` call inside the MCP server. Disabled by default; turn it on by setting one environment variable. Useful for:

- **Troubleshooting** — see exactly which tool a slow/failing CDP call belongs to, what JS it evaluated, and how long it took.
- **Latency profiling** — measure tool-call distributions over time without bolting on an APM.
- **Mutex visibility** — when the write-tool mutex queues calls, the trace exposes `wait_ms` (queue latency) and `work_ms` (critical-section duration) per call.
- **Operational forensics** — after an incident, replay exactly which Chrome calls fired and in what order.
- **Reconnect validation** — see [`RECONNECT_TESTING.md`](./RECONNECT_TESTING.md) for an end-to-end procedure that uses the tracer to validate the CDP reconnect path (stop TV → capture failure events → restart TV → capture success events).

The tracer is implemented in [`src/tracer.js`](../src/tracer.js). It is **off by default and zero-cost when off** — `evaluate()` / `evaluateWrite()` skip the trace branch in a single `if`. Tests live at [`tests/tracer.test.js`](../tests/tracer.test.js).

## Activate

```bash
# Minimal — write events to /tmp/mcp-trace.log
MCP_TRACE_FILE=/tmp/mcp-trace.log node src/server.js

# Tune the buffer + rotation
MCP_TRACE_FILE=/tmp/mcp-trace.log \
MCP_TRACE_BUFFER_MS=50 \
MCP_TRACE_MAX_MB=50 \
node src/server.js
```

When deployed as a launchd / systemd service, add to the service's environment block.

## Env vars

| Variable | Default | Meaning |
|---|---|---|
| `MCP_TRACE_FILE` | unset → **disabled** | NDJSON output path. Created if missing; appended otherwise. |
| `MCP_TRACE_MAX_MB` | `50` | Rotation threshold. When the file exceeds this, it's renamed to `<path>.1` (replacing any prior `.1`) and a fresh file is started. Single-level rotation only. |
| `MCP_TRACE_BUFFER_MS` | `50` | Internal flush interval (ms). Events are buffered in memory and flushed on this timer or when the buffer hits 64KB, whichever comes first. Plus a final flush on `process.beforeExit`. |
| `MCP_TRACE_SAMPLE` | `1.0` | Probabilistic sampling fraction `[0, 1]`. Set to `0.1` in high-volume production to cap trace volume. Sampling decision is per-span at start, so partial spans never appear. |
| `MCP_TRACE_DEBUG` | unset | When set, trace internal errors (disk full, rotation failure) print to stderr instead of being swallowed silently. |

### CDP connection knobs

Tracing-adjacent: these knobs control the connection / reconnect behavior the tracer reports on. Defaults are fine for normal use — change them when running multiple TradingView instances, debugging with a non-default CDP port, or stress-testing the retry path.

| Variable | Default | Meaning |
|---|---|---|
| `CDP_HOST` | `localhost` | Hostname/IP for the Chrome DevTools Protocol listener. |
| `CDP_PORT` | `9222` | TCP port for CDP. Must match TradingView's `--remote-debugging-port`. |
| `CDP_MAX_RETRIES` | `5` | How many attempts `connect()` makes before throwing. Emits one `cdp.connect_attempt` per try; on exhaustion emits `cdp.connect_failed`. |
| `CDP_BASE_DELAY_MS` | `500` | Initial delay before retry 2; subsequent retries use exponential backoff (`BASE × 2^attempt`, capped at 30s). Total wall-clock for 5 retries with default = ~15.5s. |
| `CDP_WATCHDOG_INTERVAL_MS` | `30000` | Period of the background ping that detects dead connections. Set to `0` to disable. Set to a small value (e.g. `5000`) when debugging reconnect behavior. |

### Streamable HTTP transport (F3)

Switch the MCP server from the default stdio transport to Streamable HTTP, serving N consumers from a single process (per MCP spec [2025-11-25/basic/transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)).

| Variable | Default | Meaning |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | Set to `http` to switch the server to Streamable HTTP transport. Any other value (including unset) keeps the legacy stdio behavior unchanged. |
| `MCP_HTTP_HOST` | `127.0.0.1` | Bind address for the HTTP listener. Default is localhost-only (no external exposure). Change to `0.0.0.0` only if you understand the security implications. |
| `MCP_HTTP_PORT` | `8765` | TCP port for the HTTP listener. |
| `MCP_HTTP_PATH` | `/mcp` | URL path for the MCP endpoint. The server also exposes `/health` regardless of this setting. |
| `MCP_HTTP_MAX_BODY` | `4194304` (4 MB) | Max bytes accepted per request body. Requests exceeding this are dropped to prevent memory exhaustion. |

Quick start:

```bash
MCP_TRANSPORT=http node src/server.js
# Stderr:
#   ⚠  tradingview-mcp  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.
#      Streamable HTTP transport listening at http://127.0.0.1:8765/mcp
#      Health: http://127.0.0.1:8765/health

# Probe health:
curl -s http://127.0.0.1:8765/health
#   {"status":"ok","transport":"http","active_sessions":0,"uptime_sec":1.05}

# Initialize a session:
curl -s -X POST http://127.0.0.1:8765/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}'
#   Response includes Mcp-Session-Id header. Reuse it on subsequent requests.
```

Combine with the tracer to observe session lifecycle:

```bash
MCP_TRACE_FILE=/tmp/mcp-trace.log MCP_TRANSPORT=http node src/server.js
# Watch sessions live:
tail -F /tmp/mcp-trace.log | jq -r 'select(.kind | startswith("mcp.http")) | [.ts[11:23], .kind, .sid // "", .active_sessions // ""] | @tsv'
```

## Output schema (NDJSON)

Each line is one JSON object terminated by `\n`. Multi-process safe: POSIX `write()` calls under PIPE_BUF (4KB) are atomic, and lines stay well under that. Multiple MCP subprocesses appending to the same file interleave cleanly at line granularity.

Fields:

| Field | Type | Always present? | Meaning |
|---|---|---|---|
| `ts` | string (ISO 8601) | yes | Event timestamp |
| `pid` | number | yes | Emitting process PID — useful to separate concurrent MCP subprocesses |
| `seq` | number | yes | Per-process monotonic sequence (starts at 1, increments per emitted line) |
| `kind` | string | yes | Event kind (see table below) |
| `id` | number | for span events | Span identifier — `start`/`end` of one logical call share the same `id` |
| `tool` | string | when attribution is active | MCP tool name (`chart_set_symbol`, `quote_get`, etc.) — attributed via the `withToolName` wrapper applied in `src/server.js` to every registered tool handler |
| `excerpt` | string | on `*.start` and `*.queued` events | First 80 chars of the JS expression (whitespace collapsed). Lets you tell at a glance which code path fired. |
| `dur_ms` | number | on `evaluate.end` and `evaluate.error` | Wall-clock duration of the underlying CDP call |
| `wait_ms` | number | on `evaluateWrite.acquired` | Time spent waiting in the mutex queue before this writer was granted the lock |
| `work_ms` | number | on `evaluateWrite.released` | Critical-section duration — how long the CDP work itself took inside the lock |
| `error` | string | on `*.error` | Truncated error message (200 char cap) |

Event kinds:

| Kind | Emitted by | What it means |
|---|---|---|
| `evaluate.start` | `evaluate()` | A read-class CDP call began |
| `evaluate.end` | `evaluate()` | Read completed normally |
| `evaluate.error` | `evaluate()` | Read threw — `error` field has the message |
| `evaluateWrite.queued` | `evaluateWrite()` | Single-evaluate write call entered the wrapper and is now queued behind the mutex |
| `evaluateWrite.acquired` | `evaluateWrite()` | Mutex granted to this writer; `wait_ms` shows the queue latency |
| `evaluateWrite.released` | `evaluateWrite()` | Inner CDP call returned and the mutex was released; `work_ms` shows critical-section time |
| `evaluateWrite.error` | `evaluateWrite()` | Inner CDP call threw — `error` field has the message |
| `writeLock.queued` | `withWriteLock(fn)` | Multi-step write SECTION entered the wrapper; queued behind the mutex |
| `writeLock.acquired` | `withWriteLock(fn)` | Mutex granted to this section; `wait_ms` = queue latency. The inner `fn` may now issue multiple `evaluate` calls (recorded as `evaluate.*` events) atomically under the lock. |
| `writeLock.released` | `withWriteLock(fn)` | Section finished; `work_ms` = total time the lock was held (covers all inner evaluate calls + sleeps + JS work) |
| `writeLock.error` | `withWriteLock(fn)` | Inner section threw |
| `cdp.connect_attempt` | `connect()` | One attempt to (re)establish the CDP attachment. Fields: `attempt` (1-indexed), `max` (= `CDP_MAX_RETRIES`). Emitted before each `findChartTarget()` + `CDP({...})` call inside the retry loop. |
| `cdp.connect_ok` | `connect()` | CDP attachment succeeded. Fields: `target_id`, `target_url`, `attempt` (which retry won), `dur_ms` (total time across all retries that ran). |
| `cdp.connect_failed` | `connect()` | All `CDP_MAX_RETRIES` attempts exhausted. Fields: `attempts`, `dur_ms`, `error` (truncated 200 char message from the last attempt). The throw that follows is what callers see. |
| `cdp.disconnected` | `client.on('disconnect')` | WebSocket to Chrome closed (Chrome restart, TV close, OS sleep). Fields: `target_id`, `target_url`. Cached client + targetInfo are nulled simultaneously. |
| `cdp.reconnect_attempt` | watchdog | The CDP_WATCHDOG_INTERVAL_MS ticker detected a dead client (ping failed or `client === null`) and is about to retry. Fields: `reason` (the ping error message or `"no_client"`). |
| `cdp.reconnect_ok` | watchdog | Watchdog-initiated `connect()` succeeded. Fields: `reason`, `dur_ms`, `reconnect_count` (monotonic, increments per success). |
| `cdp.reconnect_failed` | watchdog | Watchdog-initiated `connect()` threw — the next tick will retry. Fields: `reason`, `dur_ms`, `error`. |
| `mcp.http.session_start` | `StreamableHTTPServerTransport` (F3) | A new HTTP session initialized via POST /mcp + initialize JSON-RPC. Fields: `sid` (UUID), `active_sessions` (count post-increment). Only emits when `MCP_TRANSPORT=http`. |
| `mcp.http.session_end` | `StreamableHTTPServerTransport` (F3) | An HTTP session closed (explicit DELETE /mcp, transport close, or client disconnect). Fields: `sid`, `active_sessions` (count post-decrement). |
| `mcp.http.error` | HTTP request handler (F3) | A request handler threw — caller receives 500 with JSON-RPC error envelope. Fields: `error` (truncated 200 char). |

## Sample analysis (jq)

```bash
TRACE=/tmp/mcp-trace.log

# 1) Distribution of mutex acquire times.
#    A healthy single-MCP run should see most values <1ms.
jq -r 'select(.kind=="evaluateWrite.acquired") | .wait_ms' "$TRACE" \
  | sort -n \
  | awk '{a[NR]=$1} END {
      print "count:", NR;
      print "p50:  ", a[int(NR*0.5)];
      print "p95:  ", a[int(NR*0.95)];
      print "p99:  ", a[int(NR*0.99)];
      print "max:  ", a[NR];
    }'

# 2) Calls per tool (requires tool attribution).
jq -r 'select(.kind=="evaluate.start" or .kind=="evaluateWrite.queued")
       | .tool // "unattributed"' "$TRACE" \
  | sort | uniq -c | sort -rn

# 3) Outliers — reads taking longer than 50ms.
jq 'select(.kind=="evaluate.end" and .dur_ms > 50)' "$TRACE"

# 4) Time-series of mutex contention.
#    Each line: timestamp, wait_ms. Plot in your tool of choice.
jq -r 'select(.kind=="evaluateWrite.acquired")
       | [.ts, .wait_ms] | @tsv' "$TRACE"

# 5) Errors.
jq 'select(.kind | endswith(".error"))' "$TRACE"

# 6) Find concurrent writer races across processes —
#    pairs of evaluateWrite.queued events that overlap in wall time.
#    Within one PID the mutex serializes, but across PIDs (legacy
#    stdio-per-consumer pattern) they can race in Chrome.
jq -s 'map(select(.kind=="evaluateWrite.queued"))
       | group_by(.pid)
       | length as $n
       | if $n > 1 then "multiple PIDs writing: \($n)" else "single PID" end' "$TRACE"

# 7) Live tail with friendly formatting.
tail -F "$TRACE" \
  | jq -r 'select(.kind | startswith("evaluateWrite"))
           | [.ts[11:19], .pid, .kind, .tool // "-",
              (.wait_ms // .work_ms // "" | tostring)] | @tsv'

# 8) CDP connection lifecycle — every attempt, success, failure, reconnect.
#    Useful when investigating "why did MCP fail at 12:27:46?" — the
#    cdp.connect_failed event names the retry exhaustion explicitly.
jq -r 'select(.kind | startswith("cdp.")) | [.ts[11:23], .pid, .kind, .attempt//.attempts//"", .dur_ms//"", .reason//"", (.error // "")[:60]] | @tsv' "$TRACE"

# 9) Reconnect rate — how often did the watchdog have to recover?
#    High counts indicate Chrome instability or laptop sleep cycles.
jq -r 'select(.kind=="cdp.reconnect_ok") | .reconnect_count' "$TRACE" | tail -1

# 10) Time to recover from each disconnect.
#    Pairs cdp.reconnect_attempt (start) with cdp.reconnect_ok/failed (end).
jq -r 'select(.kind=="cdp.reconnect_ok" or .kind=="cdp.reconnect_failed") | [.ts[11:23], .kind, .dur_ms, .reason] | @tsv' "$TRACE"
```

## Multi-process notes

Each MCP subprocess writes to the same file. Lines interleave by completion order. To analyse a single process in isolation, filter by `pid`:

```bash
jq 'select(.pid == 16220)' "$TRACE"
```

The `seq` field is **per-process**, not global — two different PIDs can both have `seq: 5`. Use the `ts` for global ordering.

## Performance

The tracer is asynchronous and buffered. Concretely:

- Each call adds one JSON line to an in-memory array.
- The flush timer (default 50ms) writes the accumulated batch as one `fs.appendFile` call.
- The buffer also flushes synchronously when it hits 64KB.

When `MCP_TRACE_FILE` is unset (default), the trace code paths in `src/connection.js` short-circuit to a no-op stub before any string formatting or memory allocation. The cost is one `if (!config().enabled)` check per call — effectively free.

When the tracer is active, the per-call cost is dominated by `JSON.stringify` of the event object — typically a few microseconds. Disk write is amortised across the buffer interval.

## Rotation

When the trace file exceeds `MCP_TRACE_MAX_MB`, it's renamed to `<path>.1` (overwriting any prior `.1`) and a fresh empty file starts. **Single-level rotation, no compression.** This is intentionally minimal — for long-term retention pipe through logrotate, or run a sidecar that rotates by date.

## When to enable

| Scenario | Recommended setting |
|---|---|
| Local debugging — see what tools an agent called | `MCP_TRACE_FILE=/tmp/mcp-trace.log` |
| Production with periodic forensics | `MCP_TRACE_FILE=/var/log/mcp/trace.log` + `MCP_TRACE_MAX_MB=200` |
| High-volume production — keep volume cap | Add `MCP_TRACE_SAMPLE=0.1` to retain 10% of spans |
| Investigating a specific incident | Enable just before reproducing, disable after — no service restart needed if you can set env on the next subprocess spawn |

## Disabling

Unset the env var. Restart the server (or, for spawn-per-call patterns where each subprocess reads env at start, the next subprocess spawn picks up the absence and is tracer-free).

## Limitations

- Tracer state (buffer, counter) is per-OS-process. Long-running daemons keep their buffer in memory; short-lived spawn-per-query subprocesses flush + exit cleanly via `beforeExit`.
- `SIGKILL` (kill -9) and OOM kills lose any unflushed events. `SIGTERM` flushes via the `beforeExit` hook (Node's default lifecycle handles this).
- Rotation is not atomic relative to concurrent writers in other processes — if two MCPs both check size at the same moment, one might write to the (just-rotated) `.1`. This is rare and acceptable for diagnostics use.
- Sampling drops at the SPAN level (not per-event), so write-span lifecycle events (`queued`/`acquired`/`released`) all emit or none emit for a given call.
