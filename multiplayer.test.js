'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const net = require('node:net');
const WebSocket = require('ws');

async function start(t, extraEnv = {}) {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', (data) => { output += data; });
  const exited = once(child, 'exit');
  const stop = async (signal = 'SIGTERM') => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    return exited;
  };
  t.after(() => stop('SIGKILL'));
  await Promise.race([
    once(child.stdout, 'data'),
    exited.then(() => { throw new Error(`Server exited: ${output}`); }),
  ]);
  return { stop, port, url: `ws://127.0.0.1:${port}/ws` };
}

async function connect(t, url) {
  const socket = new WebSocket(url);
  const messages = [];
  socket.on('message', (raw) => messages.push(JSON.parse(raw)));
  t.after(() => socket.terminate());
  await once(socket, 'open');
  async function next(predicate, after = 0) {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const message = messages.slice(after).find(predicate);
      if (message) return message;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Message not received; got ${JSON.stringify(messages.slice(after))}`);
  }
  const send = (message) => socket.send(JSON.stringify(message));
  const act = async (message, predicate = (m) => m.type === 'state') => {
    const cursor = messages.length;
    send(message);
    return next(predicate, cursor);
  };
  return { socket, messages, next, send, act };
}

async function create(t, server) {
  const host = await connect(t, server.url);
  const identity = await host.act({ type: 'create', name: 'Host' }, (m) => m.type === 'joined');
  await host.next((m) => m.type === 'state');
  return { host, identity };
}


test('rejoining with the private token restores the same player, and the token is never broadcast', { timeout: 10000 }, async (t) => {
  const server = await start(t);
  const { host, identity } = await create(t, server);
  assert.match(identity.token || '', /^[a-f0-9]{64}$/);
  const other = await connect(t, server.url);
  await other.act({ type: 'join', code: identity.code, name: 'Seeker' }, (m) => m.type === 'joined');
  const state = await other.next((m) => m.type === 'state');
  assert.equal(JSON.stringify(state).includes(identity.token), false);
  host.socket.terminate();
  await new Promise((r) => setTimeout(r, 100));
  const returning = await connect(t, server.url);
  const resumed = await returning.act({ type: 'join', code: identity.code, pid: identity.pid, token: identity.token }, (m) => m.type === 'joined');
  assert.equal(resumed.pid, identity.pid);
});

test('a visible player id without the token cannot take over an online player', { timeout: 10000 }, async (t) => {
  const server = await start(t);
  const { identity } = await create(t, server);
  const intruder = await connect(t, server.url);
  for (const token of [undefined, 'incorrect']) {
    const joined = await intruder.act({ type: 'join', code: identity.code, pid: identity.pid, token, name: 'Host' }, (m) => m.type === 'joined');
    assert.notEqual(joined.pid, identity.pid);
  }
});

test('a player whose phone died gets their seat back on another phone by name', { timeout: 10000 }, async (t) => {
  const server = await start(t);
  const { host, identity } = await create(t, server);
  const ona = await connect(t, server.url);
  const first = await ona.act({ type: 'join', code: identity.code, name: 'Ona' }, (m) => m.type === 'joined');
  await ona.act({ type: 'setRole', role: 'hider' });
  ona.socket.terminate();
  await host.next((m) => m.type === 'state' && m.state.players.some((p) => p.name === 'Ona' && !p.connected));
  const borrowed = await connect(t, server.url);
  const back = await borrowed.act({ type: 'join', code: identity.code, name: 'ona' }, (m) => m.type === 'joined');
  assert.equal(back.pid, first.pid);
  const { state } = await borrowed.next((m) => m.type === 'state');
  assert.equal(state.players.find((p) => p.id === first.pid).role, 'hider');
  assert.equal(state.players.length, 2);
});

test('10 second test hiding time switches to seeking on its own', { timeout: 20000 }, async (t) => {
  const server = await start(t);
  const { host, identity } = await create(t, server);
  const seeker = await connect(t, server.url);
  await seeker.act({ type: 'join', code: identity.code, name: 'Seeker' }, (m) => m.type === 'joined');
  await host.act({ type: 'setRole', role: 'hider' });
  const set = await host.act({ type: 'settings', hideMinutes: 10 / 60, zoneRadius: 1000 });
  assert.equal(set.state.settings.zoneRadius, 1000);
  const started = await host.act({ type: 'start' });
  assert.ok(started.state.hideEndsAt - Date.now() <= 10000);
  const deadline = Date.now() + 13000;
  while (Date.now() < deadline) {
    const last = host.messages.filter((m) => m.type === 'state').at(-1);
    if (last.state.phase === 'seeking') { assert.equal(last.state.seekStartedAt, started.state.hideEndsAt); return; }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail('never switched to seeking');
});

test('keepalive gets a pong without joining a room or broadcasting game state', { timeout: 10000 }, async (t) => {
  const server = await start(t);
  const client = await connect(t, server.url);
  const pong = await client.act({ type: 'ping' }, (m) => m.type === 'pong');
  assert.equal(typeof pong.serverNow, 'number');
  assert.equal(client.messages.some((m) => m.type === 'state'), false);
});

test('repeated stale GPS cannot freeze the hider', { timeout: 10000 }, async (t) => {
  const server = await start(t);
  const { host, identity } = await create(t, server);
  const seeker = await connect(t, server.url);
  await seeker.act({ type: 'join', code: identity.code, name: 'Seeker' }, (m) => m.type === 'joined');
  await host.act({ type: 'setRole', role: 'hider' });
  await host.act({ type: 'start' });
  await host.act({ type: 'pos', lat: 54.68577, lng: 25.28766, acc: 5, t: Date.now() });
  await host.act({ type: 'lockZone' });
  await host.act({ type: 'endHiding' });
  const stale = await seeker.act({ type: 'pos', lat: 54.68577, lng: 25.28766, acc: 5, t: Date.now() - 180000 });
  assert.equal(stale.state.endgame, false);
  const fresh = await seeker.act({ type: 'pos', lat: 54.68577, lng: 25.28766, acc: 5, t: Date.now() });
  assert.equal(fresh.state.endgame, true);
});

test('the server rejects an out-of-area hiding zone and does not auto-lock it', { timeout: 10000 }, async (t) => {
  const server = await start(t);
  const { host, identity } = await create(t, server);
  const seeker = await connect(t, server.url);
  await seeker.act({ type: 'join', code: identity.code, name: 'Seeker' }, (m) => m.type === 'joined');
  await host.act({ type: 'setRole', role: 'hider' });
  await host.act({ type: 'start' });
  await host.act({ type: 'pos', lat: 0, lng: 0, acc: 5, t: Date.now() });
  const rejected = await host.act({ type: 'lockZone' }, (m) => m.type === 'error');
  assert.match(rejected.message, /play area/i);
  const seeking = await host.act({ type: 'endHiding' });
  assert.equal(seeking.state.zone, null);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const state = await host.act({ type: 'rename', name: 'Host' });
  assert.equal(state.state.zone, null);
});

test('pausing prevents answers, zone changes, and seekers freezing the hider', { timeout: 10000 }, async (t) => {
  const server = await start(t);
  const { host, identity } = await create(t, server);
  const seeker = await connect(t, server.url);
  await seeker.act({ type: 'join', code: identity.code, name: 'Seeker' }, (m) => m.type === 'joined');
  await host.act({ type: 'setRole', role: 'hider' });
  await host.act({ type: 'start' });
  await host.act({ type: 'pos', lat: 54.68577, lng: 25.28766, acc: 5, t: Date.now() });
  await host.act({ type: 'lockZone' });
  await host.act({ type: 'endHiding' });
  await seeker.act({ type: 'ask', qid: 'ph-sky' });
  await host.act({ type: 'pause' });
  const paused = await seeker.act({ type: 'pos', lat: 54.68577, lng: 25.28766, acc: 5, t: Date.now() });
  assert.equal(paused.state.endgame, false);
  for (const message of [{ type: 'answer', photo: 'data:image/png;base64,AQ==' }, { type: 'lockZone' }]) {
    const rejected = await host.act(message, (m) => m.type === 'error');
    assert.match(rejected.message, /paused/i);
  }
  const resumed = await host.act({ type: 'resume' });
  assert.equal(resumed.state.endgame, true);
});

test('message flooding is rejected without disconnecting another player', { timeout: 10000 }, async (t) => {
  const server = await start(t);
  const { host } = await create(t, server);
  const spammer = await connect(t, server.url);
  for (let i = 0; i < 80; i++) spammer.send({ type: 'join', code: 'AAAA', name: 'Spam' });
  await spammer.next((m) => m.type === 'error' && m.code === 'RATE_LIMIT');
  const pong = await host.act({ type: 'ping' }, (m) => m.type === 'pong');
  assert.equal(typeof pong.serverNow, 'number');
});
