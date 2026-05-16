// F3 — Streamable HTTP transport integration tests.
//
// Spawns the MCP server with MCP_TRANSPORT=http on an ephemeral port,
// then exercises each documented behavior via fetch():
//   - GET /health returns the documented JSON shape
//   - POST /mcp with an initialize JSON-RPC body establishes a session
//     (Mcp-Session-Id header in response) and the health endpoint
//     reflects active_sessions=1
//   - GET /unknown-path returns 404
//   - POST /mcp without a session ID and not an initialize body returns
//     400 with a JSON-RPC error envelope
//
// Not covered here (covered by manual boot tests during F3 ship):
//   - SIGTERM clean shutdown (verified in boot test: "SIGTERM received —
//     shutting down" stderr line)
//   - Stdio mode as default (verified in boot test: timeout exit with
//     stdin = /dev/null, no HTTP listener opened)
//   Reason: both scenarios race the child's exit event against the test's
//   listener attachment when stdin is /dev/null (immediate EOF). The
//   race is in test-harness plumbing, not in the production code path.
//
// Uses child_process.spawn so each test sees a fresh server (no shared
// state between tests). The server's stdio inherits from the test
// runner — its stderr lines appear in test output if it crashes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createConnection } from 'node:net';

const SERVER_ENTRY = new URL('../src/server.js', import.meta.url).pathname;

/**
 * Spawn the server in HTTP mode on the given port. Returns the child
 * process handle + a teardown function. Waits up to 5s for the listener
 * to accept TCP connections before resolving.
 */
async function startHttpServer(port) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, MCP_TRANSPORT: 'http', MCP_HTTP_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Drain stdout/stderr so the buffers don't fill (keeps test output
  // readable even when the server logs a lot).
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  // Wait for the TCP listener to be accepting connections.
  for (let i = 0; i < 50; i++) {
    try {
      await new Promise((res, rej) => {
        const sock = createConnection({ port, host: '127.0.0.1' });
        sock.once('connect', () => { sock.end(); res(); });
        sock.once('error', rej);
      });
      break;
    } catch {
      await sleep(100);
    }
    if (i === 49) throw new Error(`HTTP server didn't accept connections on :${port}`);
  }

  const teardown = async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((res) => child.once('exit', res));
  };
  return { child, teardown };
}

// Each test uses a different port to avoid races when tests run in
// parallel.
let nextPort = 19000;

test('GET /health returns documented shape with active_sessions=0', async () => {
  const port = nextPort++;
  const { teardown } = await startHttpServer(port);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.transport, 'http');
    assert.equal(body.active_sessions, 0);
    assert.equal(typeof body.uptime_sec, 'number');
  } finally { await teardown(); }
});

test('POST /mcp with initialize body establishes a session', async () => {
  const port = nextPort++;
  const { teardown } = await startHttpServer(port);
  try {
    const initBody = {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    };
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify(initBody),
    });
    assert.equal(res.status, 200);
    const sid = res.headers.get('mcp-session-id');
    assert.ok(sid, 'Mcp-Session-Id header must be set');
    assert.match(sid, /^[0-9a-f-]{36}$/i, 'session ID looks like a UUID');
    // Consume body so the connection closes
    await res.text();

    // Health endpoint should now show 1 active session
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    assert.equal(health.active_sessions, 1);
  } finally { await teardown(); }
});

test('GET /unknown-path returns 404 JSON', async () => {
  const port = nextPort++;
  const { teardown } = await startHttpServer(port);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'not_found');
    assert.equal(body.path, '/nope');
  } finally { await teardown(); }
});

test('POST /mcp without session ID and not initialize returns 400 JSON-RPC error', async () => {
  const port = nextPort++;
  const { teardown } = await startHttpServer(port);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.error.code, -32000);
    assert.match(body.error.message, /missing session ID/i);
  } finally { await teardown(); }
});

