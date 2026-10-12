'use strict';
/* Hide + seek game server. One process, all state in memory.
   Run with `npm start`, then open http://localhost:3000 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const C = require('./public/cards.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

const MIN = 60 * 1000;
const rooms = new Map();          // code -> room
const conns = new Map();          // code -> Set<ws>

// ---------- helpers ----------
const rid = (n = 6) => crypto.randomBytes(n).toString('hex');
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function dist(a, b) {
  const R = 6371000, r = (x) => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function cleanText(s, max = 40) { return String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max); }
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(c));
  return c;
}
class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };

// ---------- room lifecycle ----------
function createRoom() {
  const room = {
    code: newCode(), created: Date.now(), touched: Date.now(), hostId: null, round: 1,
    players: {},
    settings: { hideMinutes: 30, zoneRadius: 200, includeNaujamiestis: true },
    results: [], photos: {}, events: [], eventSeq: 0,
  };
  resetRound(room);
  rooms.set(room.code, room);
  return room;
}

function resetRound(room) {
  Object.assign(room, {
    phase: 'lobby', hideEndsAt: null, seekStartedAt: null, endedAt: null,
    paused: false, pausedAt: null, pausedTotal: 0,
    zone: null, endgame: false, moving: null,
    used: [], question: null, qlog: [],
    deck: [], discard: [], hand: [], handLimit: 6, draw: null, drawQueue: [], mustDiscard: 0,
    curses: [],
  });
}

function event(room, text, to) {
  room.events.push({ id: ++room.eventSeq, t: Date.now(), text, to: to || null });
  if (room.events.length > 200) room.events.splice(0, room.events.length - 200);
}

const hiders = (room) => Object.values(room.players).filter((p) => p.role === 'hider');
const seekers = (room) => Object.values(room.players).filter((p) => p.role === 'seeker');
function hiderPos(room) { const h = hiders(room).find((p) => p.pos); return h ? h.pos : null; }

function seekElapsed(room, now = Date.now()) {
  if (!room.seekStartedAt) return 0;
  const end = room.endedAt || (room.paused ? room.pausedAt : now);
  return Math.max(0, end - room.seekStartedAt - room.pausedTotal);
}

// ---------- cards ----------
function buildDeck(room) {
  room.deck = shuffle(C.DECK.map((c) => ({ uid: rid(4), id: c.id })));
  room.discard = [];
  room.hand = [];
}
function takeCards(room, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!room.deck.length) {
      if (!room.discard.length) break;
      room.deck = shuffle(room.discard);
      room.discard = [];
      event(room, 'The hider deck was reshuffled.', 'hider');
    }
    out.push(room.deck.pop());
  }
  return out;
}
function queueDraw(room, n, keep, reason) {
  room.drawQueue.push({ n, keep, reason });
  nextDraw(room);
}
function nextDraw(room) {
  while (!room.draw && room.drawQueue.length) {
    const { n, keep, reason } = room.drawQueue.shift();
    const cards = takeCards(room, n);
    if (!cards.length) continue;
    room.draw = { cards, keep: Math.min(keep, cards.length), reason };
  }
}
function drawToHand(room, n) {
  const cards = takeCards(room, n);
  room.hand.push(...cards);
  checkHandLimit(room);
  return cards;
}
function checkHandLimit(room) { room.mustDiscard = Math.max(0, room.hand.length - room.handLimit); }
function removeFromHand(room, uids) {
  for (const u of uids) {
    const i = room.hand.findIndex((c) => c.uid === u);
    if (i < 0) fail('That card is not in your hand.');
    room.discard.push(room.hand.splice(i, 1)[0]);
  }
}
const cardName = (inst) => (C.CARD_BY_ID[inst.id] || {}).name || inst.id;

// ---------- phases ----------
function beginSeeking(room) {
  if (!room.zone) {
    const pos = hiderPos(room);
    if (pos) {
      room.zone = { lat: pos.lat, lng: pos.lng, r: room.settings.zoneRadius, lockedAt: Date.now() };
      event(room, 'Hiding zone locked automatically where you stood.', 'hider');
    } else {
      event(room, 'No GPS from the hider. Lock your zone now!', 'hider');
    }
  }
  room.phase = 'seeking';
  room.seekStartedAt = Date.now();
  event(room, 'Hiding time is over. Seekers, go!');
}

function checkEndgame(room) {
  if (room.phase !== 'seeking' || !room.zone || room.endgame || room.moving) return;
  const inside = seekers(room).some((s) => s.pos && Date.now() - s.pos.t < 2 * MIN && dist(s.pos, room.zone) <= room.zone.r);
  if (inside) {
    room.endgame = true;
    event(room, 'A seeker is inside the hiding zone. The hider must not move from now on.');
  }
}

function finish(room, by) {
  if (room.phase !== 'seeking') fail('The game is not running.');
  if (room.paused) resume(room);
  room.phase = 'ended';
  room.endedAt = Date.now();
  const seekMs = seekElapsed(room);
  const bonusMin = room.hand.reduce((s, c) => s + (C.CARD_BY_ID[c.id].kind === 'time' ? C.CARD_BY_ID[c.id].minutes : 0), 0);
  room.results.push({
    round: room.round, hiders: hiders(room).map((p) => p.name).join(' & ') || '?',
    seekMs, bonusMin, totalMs: seekMs + bonusMin * MIN, at: room.endedAt,
  });
  room.question = null;
  room.draw = null; room.drawQueue = [];
  event(room, `Found by ${by}! Round ${room.round} is over.`);
}

function pause(room) { room.paused = true; room.pausedAt = Date.now(); }
function resume(room) {
  const d = Date.now() - room.pausedAt;
  if (room.phase === 'hiding' && room.hideEndsAt) room.hideEndsAt += d;
  if (room.phase === 'seeking') room.pausedTotal += d;
  if (room.question && room.question.deadline) room.question.deadline += d;
  room.curses.forEach((c) => { if (c.expiresAt) c.expiresAt += d; });
  if (room.moving) room.moving.until += d;
  room.paused = false; room.pausedAt = null;
}

// ---------- per-player view (hides secret info) ----------
function viewFor(room, pid) {
  const me = room.players[pid];
  const isHider = !!me && me.role === 'hider';
  const reveal = room.phase === 'ended';
  return {
    serverNow: Date.now(), me: pid, code: room.code, round: room.round, phase: room.phase,
    settings: room.settings, hostId: room.hostId,
    players: Object.values(room.players).map((p) => ({
      id: p.id, name: p.name, role: p.role, connected: p.connected,
      pos: (p.id === pid || reveal || (p.role === 'seeker' && !isHider) || (isHider && p.role === 'hider')) ? p.pos : null,
    })),
    hideEndsAt: room.hideEndsAt, seekStartedAt: room.seekStartedAt, endedAt: room.endedAt,
    paused: room.paused, pausedAt: room.pausedAt, pausedTotal: room.pausedTotal,
    elapsed: seekElapsed(room),
    zone: (isHider || reveal) ? room.zone : null,
    zoneLocked: !!room.zone, endgame: room.endgame, moving: room.moving,
    used: room.used, question: room.question, qlog: room.qlog, curses: room.curses,
    hider: isHider
      ? { hand: room.hand, handLimit: room.handLimit, draw: room.draw, mustDiscard: room.mustDiscard,
          deckCount: room.deck.length, discardCount: room.discard.length }
      : { handCount: room.hand.length },
    events: room.events.filter((e) => !e.to || (e.to === 'hider') === isHider).slice(-30),
    results: room.results,
  };
}

function broadcast(room) {
  const set = conns.get(room.code);
  if (!set) return;
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'state', state: viewFor(room, ws.meta.pid) }));
  }
}

// ---------- message handlers ----------
function attach(ws, room, pid) {
  if (ws.meta) detach(ws);
  ws.meta = { code: room.code, pid };
  if (!conns.has(room.code)) conns.set(room.code, new Set());
  conns.get(room.code).add(ws);
  room.players[pid].connected = true;
  ws.send(JSON.stringify({ type: 'joined', code: room.code, pid, name: room.players[pid].name }));
}
function detach(ws) {
  if (!ws.meta) return;
  const room = rooms.get(ws.meta.code);
  const set = conns.get(ws.meta.code);
  if (set) set.delete(ws);
  if (room && room.players[ws.meta.pid]) {
    const still = set && [...set].some((w) => w.meta.pid === ws.meta.pid);
    if (!still) room.players[ws.meta.pid].connected = false;
    broadcast(room);
  }
  ws.meta = null;
}

function newPlayer(room, name) {
  const pid = rid(6);
  room.players[pid] = { id: pid, name: cleanText(name, 20) || 'Player', role: 'seeker', connected: true, pos: null };
  if (!room.hostId) room.hostId = pid;
  return pid;
}

const H = {
  create(ws, m) {
    const room = createRoom();
    const pid = newPlayer(room, m.name);
    room.hostId = pid;
    event(room, `${room.players[pid].name} created the game.`);
    attach(ws, room, pid);
    return room;
  },

  join(ws, m) {
    const room = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!room) { ws.send(JSON.stringify({ type: 'error', code: 'NO_ROOM', message: 'No game with that code. Check the code or create a new game.' })); return null; }
    let pid = m.pid && room.players[m.pid] ? m.pid : null;
    if (pid) { if (m.name) room.players[pid].name = cleanText(m.name, 20) || room.players[pid].name; }
    else { pid = newPlayer(room, m.name); event(room, `${room.players[pid].name} joined.`); }
    attach(ws, room, pid);
    return room;
  },

  setRole(ws, m, room, me) {
    if (!['lobby', 'ended'].includes(room.phase)) fail('Roles can only change between rounds.');
    const target = room.players[m.target || me.id];
    if (!target) fail('Unknown player.');
    if (target.id !== me.id && me.id !== room.hostId) fail('Only the host can change other players.');
    if (!['hider', 'seeker'].includes(m.role)) fail('Unknown role.');
    target.role = m.role;
  },

  settings(ws, m, room, me) {
    if (me.id !== room.hostId) fail('Only the host can change settings.');
    if (room.phase !== 'lobby') fail('Settings are locked during a round.');
    const s = room.settings;
    if (m.hideMinutes != null) s.hideMinutes = Math.min(90, Math.max(1, Math.round(+m.hideMinutes) || 30));
    if (m.zoneRadius != null) s.zoneRadius = Math.min(500, Math.max(50, Math.round(+m.zoneRadius) || 200));
    if (m.includeNaujamiestis != null) s.includeNaujamiestis = !!m.includeNaujamiestis;
  },

  start(ws, m, room, me) {
    if (me.id !== room.hostId) fail('Only the host can start.');
    if (room.phase !== 'lobby') fail('A round is already running.');
    if (!hiders(room).length) fail('Pick at least one hider.');
    if (!seekers(room).length) fail('Pick at least one seeker.');
    resetRound(room);
    buildDeck(room);
    room.phase = 'hiding';
    room.hideEndsAt = Date.now() + room.settings.hideMinutes * MIN;
    event(room, `Round ${room.round} started. ${room.settings.hideMinutes} minutes to hide!`);
  },

  endHiding(ws, m, room, me) {
    if (me.id !== room.hostId) fail('Only the host can do that.');
    if (room.phase !== 'hiding') fail('Not in hiding time.');
    if (room.paused) resume(room);
    beginSeeking(room);
  },

  pos(ws, m, room, me) {
    const lat = +m.lat, lng = +m.lng;
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    me.pos = { lat, lng, acc: Math.round(+m.acc || 0), t: Date.now() };
    checkEndgame(room);
  },

  lockZone(ws, m, room, me) {
    if (me.role !== 'hider') fail('Only the hider can lock the zone.');
    if (!me.pos) fail('No GPS position yet. Allow location access and wait a moment.');
    if (room.phase === 'seeking' && room.zone && !room.moving) fail('Your zone is already locked.');
    if (!['hiding', 'seeking'].includes(room.phase)) fail('Not now.');
    room.zone = { lat: me.pos.lat, lng: me.pos.lng, r: room.settings.zoneRadius, lockedAt: Date.now() };
    if (room.moving) { room.moving = null; event(room, 'The hider has a new zone. Seekers may move again.'); }
    else event(room, 'The hider locked their hiding zone.');
  },

  unlockZone(ws, m, room, me) {
    if (me.role !== 'hider') fail('Only the hider can do that.');
    if (room.phase !== 'hiding') fail('You can only unlock during hiding time.');
    room.zone = null;
    event(room, 'Zone unlocked. Lock it again before time runs out.', 'hider');
  },

  ask(ws, m, room, me) {
    if (me.role !== 'seeker') fail('Only seekers ask questions.');
    if (room.phase !== 'seeking') fail('Questions open when hiding time ends.');
    if (room.paused) fail('The game is paused.');
    if (room.moving) fail('The hider is relocating. Wait until they lock a new zone.');
    if (room.question) fail('Wait for the current question to be answered.');
    const blocker = room.curses.find((c) => c.block);
    if (blocker) fail(`Clear "${blocker.name}" first.`);
    const q = C.QUESTION_BY_ID[m.qid];
    if (!q) fail('Unknown question.');
    if (room.used.includes(q.id)) fail('That question was already asked this round.');
    const def = C.QUESTIONS[q.cat];
    const needsPos = ['radar', 'measuring', 'thermometer', 'tentacles', 'matching'].includes(q.cat);
    if (needsPos && !me.pos) fail('This question needs your GPS position. Allow location access first.');
    let text = q.text, meters = q.meters || null;
    if (q.custom) {
      meters = Math.round(+m.meters);
      if (!(meters >= 25 && meters <= 3000)) fail('Pick a distance between 25 and 3000 m.');
      text = text.replace('{m}', meters);
    }
    const coin = room.curses.find((c) => c.coin);
    room.question = {
      id: rid(4), qid: q.id, cat: q.cat, text, meters, landmark: q.landmark || null,
      askedBy: me.id, askedByName: me.name, askedAt: Date.now(),
      askerPos: me.pos ? { lat: me.pos.lat, lng: me.pos.lng } : null,
      status: q.cat === 'thermometer' ? 'walking' : 'asked',
      deadline: q.cat === 'thermometer' ? null : Date.now() + def.minutes * MIN,
      silenced: coin ? coin.result === 'tails' : false,
    };
    if (coin) room.curses = room.curses.filter((c) => c !== coin);
    if (!q.custom) room.used.push(q.id);
    if (q.cat === 'thermometer') {
      room.question.startPos = room.question.askerPos;
      event(room, `${me.name} started a ${meters} m thermometer.`);
    } else event(room, `${me.name} asked a ${def.label} question.`);
  },

  thermoAsk(ws, m, room, me) {
    const q = room.question;
    if (me.role !== 'seeker') fail('Only seekers can do that.');
    if (!q || q.status !== 'walking') fail('No thermometer in progress.');
    if (!me.pos) fail('No GPS position.');
    q.endPos = { lat: me.pos.lat, lng: me.pos.lng };
    q.walked = Math.round(dist(q.startPos, q.endPos));
    if (q.walked < q.meters * 0.8) fail(`You have only walked about ${q.walked} m of ${q.meters} m.`);
    q.status = 'asked';
    q.deadline = Date.now() + C.QUESTIONS.thermometer.minutes * MIN;
    event(room, `${me.name} finished the thermometer walk (${q.walked} m).`);
  },

  cancelQuestion(ws, m, room, me) {
    const q = room.question;
    if (me.role !== 'seeker') fail('Only seekers can do that.');
    if (!q || q.status !== 'walking') fail('Only a thermometer that is still walking can be cancelled.');
    room.used = room.used.filter((id) => id !== q.qid);
    room.question = null;
    event(room, 'The thermometer was cancelled.');
  },

  answer(ws, m, room, me) {
    const q = room.question;
    if (me.role !== 'hider') fail('Only the hider answers.');
    if (!q || q.status !== 'asked') fail('There is no question to answer.');
    if (room.draw) fail('Finish picking your cards first.');
    const def = C.QUESTIONS[q.cat];
    const ans = { by: me.name };
    if (q.silenced) {
      ans.text = '(silence, the coin landed on tails)';
    } else if (def.answer === 'photo') {
      const mt = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(m.photo || ''));
      if (!mt) fail('Attach a photo first.');
      const buf = Buffer.from(mt[3], 'base64');
      if (buf.length > 4 * 1024 * 1024) fail('Photo is too large.');
      const photoId = rid(8);
      room.photos[photoId] = { mime: mt[1], buf };
      ans.photo = `/photo/${room.code}/${photoId}`;
      ans.text = cleanText(m.text, 200);
    } else if (def.answer === 'text') {
      ans.text = cleanText(m.text, 200);
      if (!ans.text) fail('Type an answer.');
    } else {
      const allowed = { yesno: ['yes', 'no'], closer: ['closer', 'further'], hotter: ['hotter', 'colder'] }[def.answer];
      if (!allowed.includes(m.choice)) fail('Pick an answer.');
      ans.choice = m.choice;
      ans.text = cleanText(m.text, 200);
    }
    q.answer = ans;
    q.status = 'answered';
    q.answeredAt = Date.now();
    room.qlog.push(q);
    room.question = null;
    queueDraw(room, def.reward.draw, def.reward.keep, `Reward for answering (${def.label})`);
    event(room, `The hider answered the ${def.label} question.`);
  },

  keep(ws, m, room, me) {
    if (me.role !== 'hider') fail('Only the hider has cards.');
    const d = room.draw;
    if (!d) fail('Nothing to pick.');
    const uids = [...new Set(m.uids || [])];
    if (uids.length !== d.keep) fail(`Pick exactly ${d.keep}.`);
    if (!uids.every((u) => d.cards.some((c) => c.uid === u))) fail('Invalid pick.');
    for (const c of d.cards) (uids.includes(c.uid) ? room.hand : room.discard).push(c);
    room.draw = null;
    nextDraw(room);
    checkHandLimit(room);
  },

  discard(ws, m, room, me) {
    if (me.role !== 'hider') fail('Only the hider has cards.');
    if (!room.mustDiscard) fail('Your hand is within the limit.');
    const uids = [...new Set(m.uids || [])];
    if (uids.length !== room.mustDiscard) fail(`Discard exactly ${room.mustDiscard}.`);
    removeFromHand(room, uids);
    checkHandLimit(room);
  },

  play(ws, m, room, me) {
    if (me.role !== 'hider') fail('Only the hider plays cards.');
    if (room.phase !== 'seeking') fail('Cards can be played once seeking has started.');
    if (room.paused) fail('The game is paused.');
    if (room.draw) fail('Finish picking your cards first.');
    const inst = room.hand.find((c) => c.uid === m.uid);
    if (!inst) fail('That card is not in your hand.');
    const card = C.CARD_BY_ID[inst.id];
    const discards = [...new Set(m.discards || [])].filter((u) => u !== inst.uid);
    const need = card.discard || 0;
    if (discards.length !== need) fail(need ? `Choose ${need} other card${need > 1 ? 's' : ''} to discard.` : 'This card has no discard cost.');
    if (!discards.every((u) => room.hand.some((c) => c.uid === u))) fail('Discards must come from your hand.');
    const q = room.question;

    switch (card.kind) {
      case 'time': fail('Time bonuses work by staying in your hand.'); break;
      case 'veto':
        if (!q || q.status !== 'asked') fail('There is no question to veto.');
        q.status = 'vetoed'; q.answeredAt = Date.now();
        room.qlog.push(q); room.question = null;
        event(room, 'The hider vetoed the question!');
        break;
      case 'randomize': {
        if (!q || q.status !== 'asked') fail('There is no question to randomize.');
        if (q.cat === 'thermometer') fail('A thermometer cannot be randomized.');
        const pool = C.QUESTIONS[q.cat].items.filter((i) => !i.custom && !room.used.includes(i.id) && i.id !== q.qid);
        if (!pool.length) fail('No unused questions left in that category.');
        const nq = pool[crypto.randomInt(pool.length)];
        room.used.push(nq.id);
        Object.assign(q, { qid: nq.id, text: nq.text, meters: nq.meters || null, landmark: nq.landmark || null,
          deadline: Date.now() + C.QUESTIONS[q.cat].minutes * MIN, randomized: true });
        event(room, 'The hider randomized the question. New question below.');
        break;
      }
      case 'swap':
        removeFromHand(room, [inst.uid]); removeFromHand(room, discards);
        drawToHand(room, card.draw);
        event(room, `You played ${card.name}.`, 'hider');
        return;
      case 'expand':
        removeFromHand(room, [inst.uid]);
        room.handLimit += 1;
        drawToHand(room, card.draw);
        event(room, `Hand limit is now ${room.handLimit}.`, 'hider');
        return;
      case 'move':
        if (!room.zone) fail('Lock a zone before relocating.');
        room.zone = null; room.endgame = false;
        room.moving = { until: Date.now() + 10 * MIN };
        if (q && q.status === 'walking') { room.used = room.used.filter((id) => id !== q.qid); room.question = null; }
        event(room, 'The hider is relocating! Seekers, stop where you are until they lock a new zone.');
        break;
      case 'curse': {
        if (room.moving) fail('Not while relocating.');
        let input = null;
        if (card.input) {
          input = cleanText(m.input, 30);
          if (!input) fail(`Enter a ${card.input} for this curse.`);
        }
        const c = { uid: rid(4), id: card.id, name: card.name, text: card.text, input, castAt: Date.now(),
          block: !!card.block, blind: !!card.blind };
        if (card.minutes) c.expiresAt = Date.now() + card.minutes * MIN;
        if (card.roll) { c.result = 1 + crypto.randomInt(6); c.expiresAt = Date.now() + c.result * MIN; }
        if (card.coin) { c.coin = true; c.result = crypto.randomInt(2) ? 'heads' : 'tails'; }
        room.curses.push(c);
        let extra = input ? ` (${input})` : '';
        if (card.roll) extra = ` The die shows ${c.result}.`;
        if (card.coin) extra = ` The coin landed on ${c.result}.`;
        event(room, `Curse! ${card.name}.${extra}`);
        break;
      }
      default: fail('Unknown card.');
    }
    removeFromHand(room, [inst.uid]);
    if (discards.length) removeFromHand(room, discards);
    checkHandLimit(room);
  },

  clearCurse(ws, m, room, me) {
    const c = room.curses.find((x) => x.uid === m.uid);
    if (!c) fail('That curse is no longer active.');
    if (c.coin) fail('This curse clears itself on the next question.');
    room.curses = room.curses.filter((x) => x !== c);
    event(room, `${me.name} cleared ${c.name}.`);
  },

  roll(ws, m, room, me) {
    const sides = [2, 6, 20].includes(+m.sides) ? +m.sides : 6;
    const r = 1 + crypto.randomInt(sides);
    event(room, sides === 2 ? `${me.name} flipped a coin and got ${r === 1 ? 'heads' : 'tails'}.` : `${me.name} rolled a d${sides} and got ${r}.`);
  },

  found(ws, m, room, me) { finish(room, me.name); },

  pause(ws, m, room, me) {
    if (me.id !== room.hostId) fail('Only the host can pause.');
    if (!['hiding', 'seeking'].includes(room.phase) || room.paused) fail('Nothing to pause.');
    pause(room); event(room, 'Game paused.');
  },
  resume(ws, m, room, me) {
    if (me.id !== room.hostId) fail('Only the host can resume.');
    if (!room.paused) fail('The game is not paused.');
    resume(room); event(room, 'Game resumed.');
  },

  newRound(ws, m, room, me) {
    if (me.id !== room.hostId) fail('Only the host can start a new round.');
    if (room.phase !== 'ended') fail('Finish the current round first, or abort it.');
    room.round += 1;
    resetRound(room);
    room.photos = {};
    event(room, `Back in the lobby for round ${room.round}. Pick the next hider.`);
  },

  abort(ws, m, room, me) {
    if (me.id !== room.hostId) fail('Only the host can abort.');
    resetRound(room);
    event(room, 'The host aborted the round.');
  },

  claimHost(ws, m, room, me) {
    const host = room.players[room.hostId];
    if (host && host.connected) fail('The host is still connected.');
    room.hostId = me.id;
    event(room, `${me.name} is now the host.`);
  },

  rename(ws, m, room, me) { me.name = cleanText(m.name, 20) || me.name; },

  leave(ws, m, room, me) {
    if (room.phase === 'lobby') {
      delete room.players[me.id];
      if (room.hostId === me.id) room.hostId = (Object.values(room.players).find((p) => p.connected) || {}).id || null;
    }
    detach(ws);
  },
};

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(url.pathname);
  if (p === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  const ph = /^\/photo\/([A-Z]{4})\/([a-f0-9]{16})$/.exec(p);
  if (ph) {
    const room = rooms.get(ph[1]);
    const photo = room && room.photos[ph[2]];
    if (!photo) { res.writeHead(404); return res.end('Photo not found'); }
    res.writeHead(200, { 'Content-Type': photo.mime, 'Cache-Control': 'private, max-age=86400' });
    return res.end(photo.buf);
  }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(d2);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 * 1024 });
wss.on('connection', (ws) => {
  ws.meta = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string' || !H[m.type]) return;
    try {
      let room;
      if (m.type === 'create' || m.type === 'join') {
        room = H[m.type](ws, m);
      } else {
        if (!ws.meta) fail('Join a game first.');
        room = rooms.get(ws.meta.code);
        const me = room && room.players[ws.meta.pid];
        if (!me) fail('You are no longer in this game.');
        H[m.type](ws, m, room, me);
      }
      if (room) { room.touched = Date.now(); broadcast(room); }
    } catch (e) {
      if (!(e instanceof GameError)) console.error(e);
      ws.send(JSON.stringify({ type: 'error', message: e instanceof GameError ? e.message : 'Something went wrong on the server.' }));
    }
  });
  ws.on('close', () => detach(ws));
});

// Heartbeat (keeps proxies from closing idle sockets, drops dead ones)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);

// Game clock
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    let changed = false;
    if (!room.paused) {
      if (room.phase === 'hiding' && now >= room.hideEndsAt) { beginSeeking(room); changed = true; }
      const before = room.curses.length;
      room.curses = room.curses.filter((c) => !c.expiresAt || c.expiresAt > now);
      if (room.curses.length !== before) { event(room, 'A timed curse has worn off.'); changed = true; }
      if (room.moving && now >= room.moving.until) {
        const pos = hiderPos(room);
        if (pos) {
          room.zone = { lat: pos.lat, lng: pos.lng, r: room.settings.zoneRadius, lockedAt: now };
          room.moving = null;
          event(room, 'Relocation time is up. The hider\'s new zone was locked automatically.');
          changed = true;
        }
      }
      if (room.phase === 'seeking' && !room.zone && !room.moving && hiderPos(room)) {
        const pos = hiderPos(room);
        room.zone = { lat: pos.lat, lng: pos.lng, r: room.settings.zoneRadius, lockedAt: now };
        event(room, 'Hiding zone locked at your position.', 'hider');
        changed = true;
      }
    }
    if (changed) broadcast(room);
    const idle = !(conns.get(room.code) || new Set()).size;
    if (idle && now - room.touched > 12 * 60 * MIN) { rooms.delete(room.code); conns.delete(room.code); }
  }
}, 1000);

server.listen(PORT, () => console.log(`Hide + seek server on http://localhost:${PORT}`));
