import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

// Exercise the actual CLI with isolated configuration, including startup failures.
async function launch(t, overrides = {}) {
  const env = { ...process.env };
  for (const key of ['HOST', 'TRUST_PROXY', 'ALLOW_INSECURE_HTTP', 'TLS_CERT', 'TLS_KEY', 'MAX_ROOMS', 'MAX_CONNECTIONS', 'MAX_CONN_PER_IP', 'SIGNAL_BURST', 'SIGNAL_RATE', 'TURN_URL', 'TURN_SECRET', 'TURN_USER', 'TURN_PASS', 'TURN_USERNAME', 'TURN_CREDENTIAL', 'STUN_URL']) delete env[key];
  const child = spawn(process.execPath, ['server.js'], { cwd: import.meta.dirname, env: { ...env, PORT: '0', ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill(); await exited; });
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk; });
  const ready = new Promise((resolve) => child.stdout.on('data', (chunk) => {
    output += chunk;
    const match = output.match(/TrueMeet ready on (\S+)/);
    if (match) resolve({ base: match[1], child });
  }));
  return Promise.race([ready, exited.then(([code]) => ({ code, output }))]);
}

async function open(t, base, room, headers = {}) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events?room=${room}&name=Guest`, { headers, signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store', 'session credentials must not be cached');
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  const close = async () => { ctrl.abort(); await reader.cancel().catch(() => {}); };
  t.after(close);
  const next = async () => {
    for (;;) {
      const end = buf.indexOf('\n\n');
      if (end >= 0) {
        const frame = buf.slice(0, end); buf = buf.slice(end + 2);
        const line = frame.split('\n').find((s) => s.startsWith('data: '));
        if (line) return JSON.parse(line.slice(6));
      } else {
        const { value, done } = await reader.read();
        assert.equal(done, false, 'SSE ended before the expected message');
        buf += dec.decode(value, { stream: true });
      }
    }
  };
  return { next, close, until: async (type) => { for (;;) { const m = await next(); if (m.type === type) return m; } } };
}
const post = (base, room, who, msg) => fetch(`${base}/api/signal`, { method: 'POST', body: JSON.stringify({ room, id: who.id, key: who.key, ...msg }) });
const status = async (...args) => (await post(...args)).status;
async function recovered(t, base, room) {
  for (let i = 0; i < 100; i++) {
    const stream = await open(t, base, room), msg = await stream.next();
    if (msg.type === 'welcome') return stream;
    await stream.close();
    await delay(10);
  }
  assert.fail('capacity was not released after disconnect');
}

test('CLI binds to loopback by default', { timeout: 10_000 }, async (t) => {
  const { base } = await launch(t);
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(`${base}/config`)).status, 200);
  const lan = Object.values(networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal);
  if (lan) {
    const socket = connect({ host: lan.address, port: Number(new URL(base).port) });
    t.after(() => socket.destroy());
    const [error] = await once(socket, 'error');
    assert.equal(error.code, 'ECONNREFUSED', 'loopback listener must not accept LAN connections');
  }
});

test('CLI refuses non-loopback HTTP without an exact opt-in', { timeout: 10_000 }, async (t) => {
  for (const host of ['0.0.0.0', '192.0.2.1', '::']) {
    const result = await launch(t, { HOST: host, ALLOW_INSECURE_HTTP: 'true', TRUST_PROXY: 'true' });
    assert.equal(result.code, 1);
    assert.match(result.output, /Refusing to serve plain HTTP/);
    for (const option of ['TLS_CERT', 'TLS_KEY', 'TRUST_PROXY=1', 'ALLOW_INSECURE_HTTP=1']) assert.ok(result.output.includes(option), option);
  }
});

test('CLI allows explicit LAN testing and HTTPS proxy opt-ins', { timeout: 10_000 }, async (t) => {
  for (const option of ['ALLOW_INSECURE_HTTP', 'TRUST_PROXY']) {
    const { base } = await launch(t, { HOST: '0.0.0.0', [option]: '1' });
    assert.match(base, /^http:\/\/0\.0\.0\.0:/);
    assert.equal((await fetch(`${base.replace('0.0.0.0', '127.0.0.1')}/config`)).status, 200);
  }
});

test('CLI requires both TLS files instead of silently serving HTTP', { timeout: 10_000 }, async (t) => {
  for (const key of ['TLS_CERT', 'TLS_KEY']) {
    const result = await launch(t, { HOST: '0.0.0.0', [key]: 'not-a-certificate' });
    assert.equal(result.code, 1);
    assert.match(result.output, /Set both TLS_CERT and TLS_KEY/);
  }
});

test('resource configuration cannot disable caps with invalid values', { timeout: 10_000 }, async (t) => {
  for (const [key, value] of [['MAX_ROOMS', '0'], ['MAX_CONNECTIONS', '-1'], ['MAX_CONN_PER_IP', 'NaN'], ['SIGNAL_BURST', 'Infinity'], ['SIGNAL_RATE', '0.5']]) {
    const result = await launch(t, { [key]: value });
    assert.equal(result.code, 1);
    assert.ok(result.output.includes(`${key} must be a positive integer`));
  }
});

test('global room cap preserves existing rooms and recovers when a room empties', { timeout: 10_000 }, async (t) => {
  const { base } = await launch(t, { MAX_ROOMS: '2' });
  const a = await open(t, base, 'cap-one'); await a.next();
  const b = await open(t, base, 'cap-two'); await b.next();
  const denied = await open(t, base, 'cap-three');
  assert.match((await denied.next()).reason, /room limit/);
  const same = await open(t, base, 'cap-one');
  assert.equal((await same.next()).type, 'welcome', 'existing rooms can still accept people');
  await a.close(); await same.close();
  await recovered(t, base, 'cap-three');
});

test('global connection cap counts waiting streams and releases denied participants', { timeout: 10_000 }, async (t) => {
  const { base } = await launch(t, { MAX_CONNECTIONS: '2' });
  const a = await open(t, base, 'global-cap'), wa = await a.next();
  assert.equal(await status(base, 'global-cap', wa, { type: 'waiting', on: true }), 204);
  const b = await open(t, base, 'global-cap');
  assert.equal((await b.next()).type, 'waiting');
  const knock = await a.until('knock');
  const denied = await open(t, base, 'another-room');
  assert.match((await denied.next()).reason, /connection limit/);
  assert.equal(await status(base, 'global-cap', wa, { type: 'deny', target: knock.peer.id }), 204);
  await b.until('error');
  await recovered(t, base, 'another-room');
});

test('per-IP cap includes the lobby, ignores untrusted forwarded headers, and recovers', { timeout: 10_000 }, async (t) => {
  const { base } = await launch(t, { MAX_CONN_PER_IP: '2' });
  const a = await open(t, base, 'ip-cap'), wa = await a.next();
  assert.equal(await status(base, 'ip-cap', wa, { type: 'waiting', on: true }), 204);
  const b = await open(t, base, 'ip-cap');
  assert.equal((await b.next()).type, 'waiting'); await a.until('knock');
  const denied = await open(t, base, 'different-room', { 'x-forwarded-for': '198.51.100.1' });
  assert.match((await denied.next()).reason, /IP address/);
  await b.close(); await a.until('knock-cancel');
  await recovered(t, base, 'different-room');
});

test('trusted proxy uses the last valid forwarded IP, so earlier spoofed values cannot evade caps', { timeout: 10_000 }, async (t) => {
  const { base } = await launch(t, { TRUST_PROXY: '1', MAX_CONN_PER_IP: '1' });
  const a = await open(t, base, 'proxy-one', { 'x-forwarded-for': '198.51.100.1' }); await a.next();
  const denied = await open(t, base, 'proxy-two', { 'x-forwarded-for': '198.51.100.2, 198.51.100.1' });
  assert.match((await denied.next()).reason, /IP address/);
  const b = await open(t, base, 'proxy-two', { 'x-forwarded-for': '198.51.100.2' });
  assert.equal((await b.next()).type, 'welcome');
  const direct = await open(t, base, 'proxy-direct'); await direct.next();
  const bad = await open(t, base, 'proxy-invalid', { 'x-forwarded-for': 'invalid' });
  assert.match((await bad.next()).reason, /IP address/, 'invalid header falls back to the socket address');
});

test('signaling token bucket returns 429 per peer and replenishes without reconnecting', { timeout: 10_000 }, async (t) => {
  const { base } = await launch(t, { SIGNAL_BURST: '3', SIGNAL_RATE: '1' });
  const a = await open(t, base, 'rate-cap'), wa = await a.next();
  const b = await open(t, base, 'rate-cap'), wb = await b.next();
  const chat = { type: 'chat', text: 'hello' };
  for (let i = 0; i < 3; i++) assert.equal(await status(base, 'rate-cap', wa, chat), 204);
  const limited = await post(base, 'rate-cap', wa, chat);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '1');
  assert.equal(await status(base, 'rate-cap', wb, chat), 204, 'another peer has an independent bucket');
  await delay(1050);
  assert.equal(await status(base, 'rate-cap', wa, chat), 204, 'sustained rate replenishes tokens');
  assert.equal(await status(base, 'rate-cap', wa, chat), 429, 'refill does not reset the whole burst');
});

test('default signaling budget supports negotiation bursts and smooth 25 fps drawing', { timeout: 10_000 }, async (t) => {
  const { base } = await launch(t);
  const a = await open(t, base, 'normal-rate'), wa = await a.next();
  const ice = { type: 'ice', candidate: { candidate: 'candidate:test', sdpMid: '0', sdpMLineIndex: 0 } };
  assert.deepEqual(await Promise.all(Array.from({ length: 80 }, () => status(base, 'normal-rate', wa, ice))), Array(80).fill(204));
  const ink = { type: 'ink', s: 'board', op: 'pts', sid: 's1', tool: 'pen', color: '#ffffff', pts: [0.2, 0.3] };
  for (let i = 0; i < 25; i++) {
    assert.equal(await status(base, 'normal-rate', wa, ink), 204);
    await delay(40);
  }
});

test('public config and waiting room reveal no TURN credentials; admission issues valid ephemeral HMAC credentials', { timeout: 10_000 }, async (t) => {
  const secret = 'test-only-shared-secret', turn = 'turn:relay.example.test:3478';
  const { base } = await launch(t, { TURN_URL: turn, TURN_SECRET: secret, TURN_USER: 'static-user', TURN_PASS: 'static-pass' });
  const config = await (await fetch(`${base}/config`)).json();
  assert.deepEqual(config, { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const check = (welcome) => {
    assert.equal(welcome.iceServers.length, 2);
    const ice = welcome.iceServers[1], [expires, id] = ice.username.split(':');
    assert.equal(ice.urls, turn);
    assert.equal(id, welcome.id);
    assert.ok(Math.abs(Number(expires) - Math.floor(Date.now() / 1000) - 14_400) <= 1, 'four-hour TTL');
    assert.equal(ice.credential, createHmac('sha1', secret).update(ice.username).digest('base64'));
    assert.ok(!JSON.stringify(welcome).includes(secret), 'the shared secret never leaves the server');
    return ice;
  };
  const a = await open(t, base, 'turn-room'), wa = await a.next(), hostIce = check(wa);
  assert.equal(await status(base, 'turn-room', wa, { type: 'waiting', on: true }), 204);
  const b = await open(t, base, 'turn-room');
  assert.deepEqual(await b.next(), { type: 'waiting' }, 'waiting participants receive no credentials or session key');
  const knock = await a.until('knock');
  assert.equal(knock.peer.key, undefined);
  assert.equal(knock.peer.iceServers, undefined);
  assert.equal(await status(base, 'turn-room', knock.peer, { type: 'chat', text: 'not admitted' }), 403);
  assert.deepEqual(await (await fetch(`${base}/config?room=turn-room&id=${knock.peer.id}`)).json(), config);
  assert.equal(await status(base, 'turn-room', wa, { type: 'admit', target: knock.peer.id }), 204);
  const guestIce = check(await b.until('welcome'));
  assert.notEqual(hostIce.username, guestIce.username);
  assert.notEqual(hostIce.credential, guestIce.credential);
  assert.equal((await a.until('join')).peer.iceServers, undefined, 'credentials are never broadcast');
});

for (const [username, password] of [['TURN_USER', 'TURN_PASS'], ['TURN_USERNAME', 'TURN_CREDENTIAL']]) {
  test(`static TURN credentials (${username}) are only delivered after admission`, { timeout: 10_000 }, async (t) => {
    const { base } = await launch(t, { TURN_URL: 'turn:relay.example.test', [username]: 'test-user', [password]: 'test-password' });
    const config = await (await fetch(`${base}/config`)).json();
    assert.equal(config.iceServers.length, 1);
    const a = await open(t, base, 'static-turn'), wa = await a.next();
    assert.deepEqual(wa.iceServers[1], { urls: 'turn:relay.example.test', username: 'test-user', credential: 'test-password' });
    assert.equal(await status(base, 'static-turn', wa, { type: 'waiting', on: true }), 204);
    const b = await open(t, base, 'static-turn');
    assert.deepEqual(await b.next(), { type: 'waiting' });
    const knock = await a.until('knock');
    assert.ok(!JSON.stringify(knock).includes('test-password'));
    assert.equal(await status(base, 'static-turn', wa, { type: 'admit', target: knock.peer.id }), 204);
    assert.deepEqual((await b.until('welcome')).iceServers[1], wa.iceServers[1]);
  });
}
