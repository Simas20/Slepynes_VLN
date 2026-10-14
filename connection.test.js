'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Run the actual browser connection code with only its browser APIs substituted.
function browser() {
  const appFile = [path.join(__dirname, '../public/app.js'), path.join(__dirname, '../app.js')].find((f) => fs.existsSync(f));
  const source = fs.readFileSync(appFile, 'utf8');
  const connection = source.slice(source.indexOf('  // ---------- connection ----------'), source.indexOf('  // ---------- home ----------'));
  const sockets = [], timers = new Map(), intervals = [];
  let timerId = 0;
  const saved = { code: 'ABCD', pid: 'player', name: 'Host', token: 'private' };
  const context = vm.createContext({
    WebSocket: class {
      constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
      send(raw) { this.sent.push(JSON.parse(raw)); }
      close() { this.readyState = 3; this.onclose?.(); }
    },
    location: { protocol: 'https:', host: 'example.test' },
    store: { get: () => saved, set: (value) => Object.assign(saved, value) },
    $: () => ({ hidden: false }), toast() {},
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, delay) { intervals.push({ fn, delay }); return intervals.length; },
    clearInterval() {}, Date, Math,
  });
  vm.runInContext(`let ws = null, S = { code: 'ABCD' }, offset = 0; ${connection}`, context);
  return { sockets, timers, intervals, run: (code) => vm.runInContext(code, context) };
}

test('reopening while a retry is pending creates only one active socket and sends the reconnect token', () => {
  const b = browser();
  b.run('connect(); connect();');
  assert.equal(b.sockets.length, 1);
  b.sockets[0].close();
  assert.equal(b.timers.size, 1);
  b.run('connect()');
  assert.equal(b.sockets.length, 2);
  assert.equal(b.timers.size, 0);
  const live = b.sockets[1];
  live.readyState = 1; live.onopen();
  assert.equal(live.sent[0].token, 'private');
  // A delayed event from the old socket must not replace the live connection.
  b.sockets[0].onclose();
  assert.equal(b.timers.size, 0);
});

test('the browser sends a keepalive each minute and replaces a socket when its pong never arrives', () => {
  const b = browser();
  b.run('connect()');
  const socket = b.sockets[0];
  socket.readyState = 1; socket.onopen();
  const keepalive = b.intervals.find((timer) => timer.delay === 60000);
  assert.ok(keepalive, 'a one-minute keepalive is scheduled');
  keepalive.fn();
  assert.equal(socket.sent.at(-1).type, 'ping');
  const watchdog = [...b.timers.values()].find((timer) => timer.delay === 15000);
  assert.ok(watchdog, 'a missing pong has a timeout');
  watchdog.fn();
  assert.equal(socket.readyState, 3);
  assert.equal([...b.timers.values()].some((timer) => timer.delay < 60000), true);
});

test('a pong cancels the watchdog and game actions wait for successful rejoining', () => {
  const b = browser();
  b.run('connect()');
  const socket = b.sockets[0];
  socket.readyState = 1; socket.onopen();
  assert.equal(b.run("send({type: 'found'}, true)"), false);
  b.intervals.find((timer) => timer.delay === 60000).fn();
  socket.onmessage({ data: JSON.stringify({ type: 'pong' }) });
  assert.equal(b.timers.size, 0);
});
