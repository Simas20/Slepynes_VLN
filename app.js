/* Slėpynės client. Plain JS, no build step. */
(() => {
  'use strict';
  const C = window.CARDS;
  const Z = window.ZONES;
  const MIN = 60000;

  // ---------- tiny DOM helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  // ---------- utils ----------
  function dist(a, b) {
    const R = 6371000, r = (x) => x * Math.PI / 180;
    const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function fmt(ms) {
    const neg = ms < 0; ms = Math.abs(ms);
    const s = Math.floor(ms / 1000), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    const body = (hh ? hh + ':' + String(mm).padStart(2, '0') : String(mm).padStart(2, '0')) + ':' + String(ss).padStart(2, '0');
    return (neg ? '-' : '') + body;
  }
  const fmtM = (m) => (m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m');
  const clockTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function inPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((yi > p.lat) !== (yj > p.lat) && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const activeAreas = () => Object.values(Z.areas).filter((a) => !a.optional || !S || S.settings.includeNaujamiestis);
  const inPlayArea = (p) => activeAreas().some((a) => inPoly(p, a.coords));
  // local metric projection around an origin, for thermometer geometry
  const toXY = (o, p) => ({ x: (p.lng - o.lng) * 111320 * Math.cos(o.lat * Math.PI / 180), y: (p.lat - o.lat) * 110540 });
  const fromXY = (o, v) => [o.lat + v.y / 110540, o.lng + v.x / (111320 * Math.cos(o.lat * Math.PI / 180))];

  const store = {
    get() { try { return JSON.parse(localStorage.getItem('slepynes') || '{}'); } catch { return {}; } },
    set(v) { try { localStorage.setItem('slepynes', JSON.stringify(v)); } catch {} },
  };

  // ---------- state ----------
  let ws = null, S = null, offset = 0, myPos = null;
  let lastEventId = null, lastQuestionId = null, seenLog = 0;
  let tab = null, sheetKey = '', geoWatch = null, sentPos = null, sentAt = 0;
  let showNotes = true, showLandmarks = true, followMe = false;
  const openCats = new Set();
  const draft = { qid: null, choice: null, text: '', photo: null };
  const pick = { keep: new Set(), discard: new Set() };
  const now = () => Date.now() + offset;
  const meP = () => S && S.players.find((p) => p.id === S.me);
  const isHider = () => { const m = meP(); return !!m && m.role === 'hider'; };
  const isHost = () => S && S.me === S.hostId;

  // ---------- connection ----------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      $('#conn').hidden = true;
      const s = store.get();
      if (s.code && s.pid) send({ type: 'join', code: s.code, pid: s.pid, name: s.name });
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
    ws.onclose = () => { if (S) $('#conn').hidden = false; setTimeout(connect, 1500); };
  }
  function send(m, quiet) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true; }
    if (!quiet) toast('Not connected. Trying again in a moment.', 'err');
    return false;
  }

  function onMessage(m) {
    if (m.type === 'joined') {
      store.set({ ...store.get(), code: m.code, pid: m.pid, name: m.name });
      history.replaceState(null, '', '/?join=' + m.code);
      startGeo(); keepAwake();
    } else if (m.type === 'state') {
      const first = !S;
      offset = m.state.serverNow - Date.now();
      const prevPhase = S && S.phase;
      S = m.state;
      if (first) { lastEventId = S.events.length ? S.events[S.events.length - 1].id : 0; seenLog = S.qlog.length; }
      if (prevPhase !== S.phase) tab = null;
      render();
      if (prevPhase !== S.phase && ['lobby', 'hiding'].includes(S.phase)) fitArea();
      if (first) pushPos(true);
    } else if (m.type === 'error') {
      if (m.code === 'NO_ROOM') {
        const s = store.get(); delete s.code; delete s.pid; store.set(s);
        S = null; document.body.dataset.screen = 'home';
        $('#topbar').hidden = $('#sheet').hidden = $('#banners').hidden = true;
      }
      toast(m.message, 'err');
    }
  }

  // ---------- home ----------
  function nameValue() {
    const n = $('#name').value.trim();
    if (!n) { toast('Enter your name first.', 'err'); $('#name').focus(); return null; }
    store.set({ ...store.get(), name: n });
    return n;
  }
  $('#name').value = store.get().name || '';
  const urlCode = new URLSearchParams(location.search).get('join');
  if (urlCode) $('#code').value = urlCode.toUpperCase().slice(0, 4);
  $('#btn-create').addEventListener('click', () => { const n = nameValue(); if (n) { startGeo(); send({ type: 'create', name: n }); } });
  $('#btn-join').addEventListener('click', () => {
    const n = nameValue(); const code = $('#code').value.trim().toUpperCase();
    if (!n) return;
    if (code.length !== 4) { toast('The game code has 4 letters.', 'err'); return; }
    const s = store.get(); if (s.code !== code) { delete s.pid; s.code = code; store.set(s); }
    startGeo();
    send({ type: 'join', code, name: n, pid: store.get().pid });
  });
  $('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });

  // ---------- geolocation ----------
  function startGeo() {
    if (geoWatch != null || !navigator.geolocation) return;
    geoWatch = navigator.geolocation.watchPosition((p) => {
      myPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
      pushPos(); drawMe(); renderBanners();
      if (followMe && map) map.panTo([myPos.lat, myPos.lng]);
    }, (err) => {
      if (err.code === 1) toast('Location is blocked. Allow it in your browser settings, the game needs it.', 'err');
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }
  function pushPos(force) {
    if (!myPos || !S) return;
    const t = Date.now();
    const moved = !sentPos || dist(sentPos, myPos) > 8;
    if (force || (moved && t - sentAt > 3000) || t - sentAt > 15000) {
      if (send({ type: 'pos', lat: myPos.lat, lng: myPos.lng, acc: myPos.acc }, true)) { sentPos = myPos; sentAt = t; }
    }
  }
  setInterval(() => pushPos(), 5000);

  let wakeLock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { keepAwake(); pushPos(true); if (!ws || ws.readyState > 1) connect(); }
  });

  // ---------- feedback ----------
  function toast(text, kind) {
    const el = h('div', { class: 'toast ' + (kind || '') }, text);
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'err' ? 5000 : 4000);
    while ($('#toasts').children.length > 2) $('#toasts').firstChild.remove();
  }
  function buzz(pattern) { try { navigator.vibrate && navigator.vibrate(pattern); } catch {} }
  let audio = null;
  function beep() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + 0.18);
    } catch {}
  }

  function handleEvents() {
    const fresh = S.events.filter((e) => e.id > lastEventId);
    if (fresh.length) lastEventId = fresh[fresh.length - 1].id;
    fresh.slice(-3).forEach((e) => {
      const curse = e.text.startsWith('Curse!');
      toast(e.text, curse ? 'curse' : '');
      if (curse && !isHider()) buzz([300, 100, 300]);
    });
    const q = S.question;
    if (q && q.status === 'asked' && q.id !== lastQuestionId) {
      lastQuestionId = q.id;
      if (isHider()) { buzz([200, 100, 200, 100, 400]); beep(); tab = 'question'; openSheet(); renderSheet(true); }
    }
  }

  function openModal(build) {
    const dlg = $('#modal'); const body = $('#modal-body');
    body.replaceChildren();
    const close = () => dlg.close();
    build(body, close);
    if (!dlg.open) dlg.showModal();
  }
  function confirmBox(title, text, okLabel, onOk, danger) {
    openModal((body, close) => body.append(
      h('h2', {}, title), text ? h('p', { class: 'muted' }, text) : '',
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { close(); if ($('#menu').open) $('#menu').close(); onOk(); } }, okLabel)),
    ));
  }
  function showPhoto(src) {
    openModal((body, close) => body.append(h('img', { src, class: 'zoom-img', alt: 'Answer photo' }), h('button', { class: 'btn wide', onclick: close }, 'Close')));
  }
  $('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) $('#modal').close(); });
  $('#menu').addEventListener('click', (e) => { if (e.target === $('#menu') || e.target.closest('[data-close]')) $('#menu').close(); });

  // ---------- render ----------
  function render() {
    const me = meP();
    document.body.dataset.screen = 'game';
    document.body.dataset.role = me ? me.role : 'seeker';
    document.body.dataset.paused = S.paused ? '1' : '0';
    $('#topbar').hidden = false; $('#sheet').hidden = false;
    $('#role-chip').textContent = me && me.role === 'hider' ? 'Hider' : 'Seeker';
    drawZones(); drawNotes(); drawPlayers(); drawMe();
    renderBanners(); renderSheet(); handleEvents(); tick();
    if ($('#menu').open) renderMenu();
  }
  let menuKey = '';

  function renderBanners() {
    if (!S) return;
    const box = $('#banners'); const b = [];
    const hider = isHider();
    if (S.paused) b.push(h('div', { class: 'banner info' }, 'Paused by the host.'));
    if (S.phase === 'hiding' && !hider) b.push(h('div', { class: 'banner' }, 'Hiding time. Wait at ' + Z.start.name + '.'));
    if (S.endgame && S.phase === 'seeking') b.push(h('div', { class: 'banner alert' }, hider ? 'Seekers are inside your zone. Do not move!' : 'A seeker is inside the hiding zone. The hider is frozen.'));
    if (S.moving) b.push(h('div', { class: 'banner alert' }, hider ? 'Walk to a new spot, then lock your zone. ' : 'The hider is relocating. Stay where you are. ', h('span', { 'data-countdown': S.moving.until })));
    if (hider && S.question && S.question.status === 'asked') b.push(h('div', { class: 'banner alert' }, 'New question! Time left ', h('span', { 'data-countdown': S.question.deadline })));
    if (!hider) S.curses.slice(0, 2).forEach((c) => b.push(h('div', { class: 'banner curse' }, c.name, c.expiresAt ? h('span', {}, ' ', h('span', { 'data-countdown': c.expiresAt })) : null)));
    if (myPos && ['hiding', 'seeking'].includes(S.phase) && !inPlayArea(myPos)) b.push(h('div', { class: 'banner alert' }, 'You are outside the play area.'));
    if (hider && myPos && S.zone && S.phase === 'seeking' && !S.moving) {
      const d = dist(myPos, S.zone);
      if (d > S.zone.r) b.push(h('div', { class: 'banner alert' }, `You are ${fmtM(d - S.zone.r)} outside your hiding zone. Go back in.`));
    }
    box.replaceChildren(...b);
    box.hidden = !b.length;
    const fog = !hider && S.phase === 'seeking' && S.curses.find((c) => c.blind);
    $('#fog').hidden = !fog;
    if (fog) $('[data-countdown-fog]').dataset.countdown = fog.expiresAt;
  }

  function tick() {
    if (!S) return;
    const t = now();
    let label = '', val = '--:--';
    if (S.phase === 'lobby') { label = `Lobby, round ${S.round}`; val = fmt(S.settings.hideMinutes * MIN); }
    else if (S.phase === 'hiding') { label = 'Hiding time left'; val = fmt(Math.max(0, S.hideEndsAt - (S.paused ? S.pausedAt : t))); }
    else if (S.phase === 'seeking') { label = 'Hider has survived'; val = fmt(S.elapsed + (S.paused ? 0 : t - S.serverNow)); }
    else if (S.phase === 'ended') { const r = S.results[S.results.length - 1]; label = 'Final time'; val = r ? fmt(r.totalMs) : '--:--'; }
    $('#phase-label').textContent = label + (S.paused ? ' (paused)' : '');
    $('#timer').textContent = val;
    document.querySelectorAll('[data-countdown]').forEach((el) => {
      const ts = +el.dataset.countdown; if (!ts) return;
      const left = ts - (S.paused ? S.pausedAt : t);
      el.textContent = left >= 0 ? fmt(left) : fmt(-left) + ' over';
      el.classList.toggle('late', left < 0);
    });
    const th = $('[data-thermo]');
    if (th && S.question && S.question.startPos) {
      th.textContent = myPos ? `${fmtM(dist(S.question.startPos, myPos))} of ${S.question.meters} m walked` : 'Waiting for GPS…';
    }
  }
  setInterval(tick, 500);

  // ---------- sheet ----------
  const sheet = $('#sheet');
  function openSheet() { sheet.classList.remove('collapsed'); }
  $('#sheet-handle').addEventListener('click', () => sheet.classList.toggle('collapsed'));

  function tabsFor() {
    if (S.phase === 'lobby') return [];
    const t = isHider()
      ? [['question', 'Question'], ['hand', 'Cards'], ['log', 'Answers'], ['zone', 'Zone']]
      : [['ask', 'Ask'], ['log', 'Answers'], ['curses', 'Curses'], ['tools', 'Tools']];
    if (S.phase === 'ended') t.unshift(['results', 'Results']);
    return t;
  }
  function defaultTab() {
    if (S.phase === 'ended') return 'results';
    if (isHider()) return S.phase === 'hiding' ? 'zone' : 'question';
    return 'ask';
  }
  function tabDot(id) {
    if (id === 'question') return S.question && S.question.status === 'asked';
    if (id === 'hand') return !!(S.hider.draw || S.hider.mustDiscard);
    if (id === 'curses') return S.curses.length > 0;
    if (id === 'log') return S.qlog.length > seenLog && tab !== 'log';
    return false;
  }

  function renderSheet(force) {
    const tabs = tabsFor();
    if (tabs.length && !tabs.some(([id]) => id === tab)) tab = defaultTab();
    if (tab === 'log') seenLog = S.qlog.length;
    const key = JSON.stringify([S.phase, S.me, S.hostId, S.players.map((p) => [p.id, p.name, p.role, p.connected]), S.settings,
      S.question, S.qlog.length, S.used, S.curses, S.hider, S.zone, S.zoneLocked, S.moving, S.endgame, S.paused, S.results.length, tab, S.round]);
    if (!force && key === sheetKey) return;
    sheetKey = key;
    const nav = $('#tabs');
    nav.replaceChildren(...tabs.map(([id, label]) => h('button', {
      role: 'tab', 'aria-selected': String(id === tab),
      onclick: () => { tab = id; openSheet(); renderSheet(true); },
    }, label, tabDot(id) ? h('span', { class: 'dot' }) : null)));
    nav.hidden = !tabs.length;
    const body = $('#sheet-body');
    const scroll = body.scrollTop;
    let content;
    if (S.phase === 'lobby') content = viewLobby();
    else content = ({ ask: viewAsk, log: viewLog, curses: viewCurses, tools: viewTools, question: viewQuestion,
      hand: viewHand, zone: viewZone, results: viewResults })[tab]();
    body.replaceChildren(...[].concat(content).flat(Infinity).filter(Boolean));
    body.scrollTop = scroll;
    tick();
  }

  // ----- lobby -----
  function viewLobby() {
    const host = isHost();
    const s = S.settings;
    const roleToggle = (p) => {
      const can = host || p.id === S.me;
      const set = (role) => send({ type: 'setRole', target: p.id, role });
      return h('div', { class: 'role-toggle' },
        h('button', { class: 'seeker' + (p.role === 'seeker' ? ' on' : ''), disabled: !can, onclick: () => set('seeker') }, 'Seeker'),
        h('button', { class: 'hider' + (p.role === 'hider' ? ' on' : ''), disabled: !can, onclick: () => set('hider') }, 'Hider'));
    };
    const hasHider = S.players.some((p) => p.role === 'hider');
    const hasSeeker = S.players.some((p) => p.role === 'seeker');
    return [
      h('div', { class: 'section' },
        h('div', { class: 'row' },
          h('div', {}, h('div', { class: 'muted small' }, 'Game code'), h('div', { class: 'code-big' }, S.code)),
          h('button', { class: 'btn', onclick: shareLink }, 'Invite friends'))),
      h('div', { class: 'section' },
        h('h3', {}, `Players (${S.players.length})`),
        h('ul', { class: 'players' }, S.players.map((p) => h('li', { class: p.connected ? '' : 'off' },
          h('span', { class: 'name' }, p.name, p.id === S.hostId ? ' (host)' : '', p.id === S.me ? ' (you)' : ''),
          roleToggle(p))))),
      h('div', { class: 'section' },
        h('h3', {}, 'Settings'),
        h('label', { class: 'setting' }, 'Hiding time',
          h('select', { disabled: !host, onchange: (e) => send({ type: 'settings', hideMinutes: +e.target.value }) },
            [10 / 60, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 75, 90].map((m) => h('option', { value: m, selected: Math.abs(s.hideMinutes - m) < 0.001 }, m < 1 ? '10 seconds (testing)' : m + ' min')))),
        h('label', { class: 'setting' }, 'Hiding zone radius (around the hider)',
          h('select', { disabled: !host, onchange: (e) => send({ type: 'settings', zoneRadius: +e.target.value }) },
            [100, 150, 200, 250, 300, 400, 500, 600, 750, 1000].map((m) => h('option', { value: m, selected: s.zoneRadius === m }, m < 1000 ? m + ' m' : '1 km')))),
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: s.includeNaujamiestis, disabled: !host, onchange: (e) => send({ type: 'settings', includeNaujamiestis: e.target.checked }) }),
          'Include Naujamiestis')),
      host
        ? h('button', { class: 'btn primary wide', disabled: !(hasHider && hasSeeker), onclick: () => send({ type: 'start' }) },
          hasHider && hasSeeker ? `Start round ${S.round}` : 'Pick at least one hider and one seeker')
        : h('p', { class: 'muted' }, 'Waiting for the host to start the round.'),
      h('button', { class: 'btn ghost wide', onclick: () => { renderMenu(true); $('#menu').showModal(); } }, 'Read the rules'),
    ];
  }
  function shareLink() {
    const url = `${location.origin}/?join=${S.code}`;
    if (navigator.share) navigator.share({ title: 'Slėpynės', text: `Join our hide and seek game, code ${S.code}`, url }).catch(() => {});
    else navigator.clipboard.writeText(url).then(() => toast('Link copied.'), () => toast(url));
  }

  // ----- seeker: ask -----
  function canAsk() {
    if (S.phase !== 'seeking') return 'Questions open when hiding time ends.';
    if (S.paused) return 'The game is paused.';
    if (S.moving) return 'The hider is relocating. Wait for their new zone.';
    if (S.question) return 'Wait for the current answer first.';
    const b = S.curses.find((c) => c.block);
    if (b) return `Clear "${b.name}" first (Curses tab).`;
    return null;
  }
  function viewAsk() {
    const out = [];
    const q = S.question;
    if (S.phase === 'hiding') out.push(h('div', { class: 'hint' }, `The hider is hiding. Stay at ${Z.start.name}. Seeking starts in `, h('b', { 'data-countdown': S.hideEndsAt })));
    if (q) out.push(questionCard(q, false));
    const block = canAsk();
    if (block && !q && S.phase === 'seeking') out.push(h('div', { class: 'hint' }, block));
    for (const [cat, def] of Object.entries(C.QUESTIONS)) {
      const left = def.items.filter((i) => i.custom || !S.used.includes(i.id)).length;
      const open = openCats.has(cat);
      out.push(h('div', { class: 'cat' + (open ? ' open' : ''), style: `--cat:${def.color}`, 'data-cat': cat },
        h('button', { class: 'cat-head', 'aria-expanded': String(open), onclick: () => toggleCat(cat) },
          h('b', {}, def.label), h('span', { class: 'muted' }, def.short), h('span', { class: 'count' }, `${left} left`),
          h('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '▴' : '▾')),
        open ? h('div', { class: 'reward' }, `${def.blurb} Hider draws ${def.reward.draw}, keeps ${def.reward.keep}. ${def.minutes} min to answer.`) : null,
        open ? h('div', { class: 'qlist' }, def.items.map((it) => h('button', {
          class: 'q' + (!it.custom && S.used.includes(it.id) ? ' used' : ''), disabled: (!it.custom && S.used.includes(it.id)) || !!block,
          onclick: () => askFlow(cat, it),
        }, it.custom ? 'Are you within ... of us? (choose a distance)' : it.text))) : null));
    }
    return out;
  }
  // Plain button accordion (native <details> misbehaves on some phones). One category open at a time.
  function toggleCat(cat) {
    const wasOpen = openCats.has(cat);
    openCats.clear();
    if (!wasOpen) openCats.add(cat);
    openSheet();
    renderSheet(true);
    if (!wasOpen) requestAnimationFrame(() => {
      const el = document.querySelector(`[data-cat="${cat}"]`);
      if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }
  function askFlow(cat, it) {
    if (it.custom) {
      openModal((body, close) => {
        const input = h('input', { type: 'number', min: 25, max: 3000, step: 25, value: 400, inputmode: 'numeric' });
        body.append(h('h2', {}, 'Custom radar'), h('label', { class: 'field' }, 'Distance in metres', input),
          h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
            h('button', { class: 'btn primary', onclick: () => { close(); send({ type: 'ask', qid: it.id, meters: +input.value }); } }, 'Ask')));
      });
      return;
    }
    const extra = cat === 'thermometer' ? 'Your current spot becomes the start. Walk the distance, then press Ask now.' : 'Your current location is shared with the hider for this question.';
    confirmBox(cat === 'thermometer' ? 'Start this thermometer?' : 'Ask this question?', `${it.text} ${extra}`, cat === 'thermometer' ? 'Start walking' : 'Ask', () => send({ type: 'ask', qid: it.id }));
  }

  function questionCard(q, forHider) {
    const def = C.QUESTIONS[q.cat];
    const parts = [h('div', { class: 'meta' }, h('span', {}, def.label), h('span', {}, 'by ' + q.askedByName), h('span', {}, clockTime(q.askedAt)), q.randomized ? h('span', {}, 'randomized') : null),
      h('div', { class: 'qtext' }, q.text)];
    if (q.status === 'walking') {
      parts.push(h('div', { class: 'hint' }, h('b', { 'data-thermo': '1' }, '')));
      if (!forHider) parts.push(h('div', { class: 'row' },
        h('button', { class: 'btn ghost', onclick: () => confirmBox('Cancel the thermometer?', 'You can start it again later.', 'Cancel it', () => send({ type: 'cancelQuestion' }), true) }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => send({ type: 'thermoAsk' }) }, 'Ask now')));
      else parts.push(h('p', { class: 'muted small' }, 'The seekers are walking. The question arrives when they finish.'));
    } else if (q.status === 'asked') {
      parts.push(h('div', { class: 'meta' }, h('span', {}, 'Answer due in ', h('b', { class: 'deadline', 'data-countdown': q.deadline }))));
      if (!forHider) parts.push(h('p', { class: 'muted small' }, 'Waiting for the hider…'));
    }
    return h('div', { class: 'qcard', style: `--cat:${def.color}` }, parts);
  }

  // ----- log -----
  function answerLine(q) {
    if (q.status === 'vetoed') return h('div', { class: 'a vetoed' }, 'Vetoed');
    const a = q.answer || {};
    const out = [];
    if (a.choice) out.push(h('div', { class: 'a' }, a.choice[0].toUpperCase() + a.choice.slice(1)));
    if (a.photo) out.push(h('img', { src: a.photo, alt: 'Photo answer', loading: 'lazy', onclick: () => showPhoto(a.photo) }));
    if (a.text) out.push(h('div', { class: a.choice || a.photo ? 'small' : 'a' }, a.text));
    return out;
  }
  function viewLog() {
    if (!S.qlog.length) return [h('p', { class: 'muted' }, 'No answers yet. Questions and answers show up here and on the map.')];
    return [
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: showNotes, onchange: (e) => { showNotes = e.target.checked; drawNotes(); } }), 'Show answers on the map'),
      h('ul', { class: 'log' }, S.qlog.slice().reverse().map((q) => h('li', { style: `--cat:${C.QUESTIONS[q.cat].color}` },
        h('div', { class: 'when' }, `${C.QUESTIONS[q.cat].label}, asked by ${q.askedByName} at ${clockTime(q.askedAt)}`),
        h('div', {}, q.text), answerLine(q)))),
    ];
  }

  // ----- curses -----
  function viewCurses() {
    if (!S.curses.length) return [h('p', { class: 'muted' }, 'No curses on you right now.')];
    return [h('div', { class: 'curse-list' }, S.curses.map((c) => h('div', { class: 'curse-item' },
      h('h4', {}, c.name), h('p', {}, c.text),
      c.input ? h('p', {}, h('b', {}, 'Hider chose ' + c.input)) : null,
      c.result != null ? h('p', {}, h('b', {}, typeof c.result === 'number' ? `Die roll ${c.result}` : `Coin ${c.result}`)) : null,
      c.expiresAt ? h('p', {}, 'Ends in ', h('b', { 'data-countdown': c.expiresAt })) : null,
      c.coin ? h('p', { class: 'muted small' }, 'Clears itself on your next question.')
        : h('button', { class: 'btn small', onclick: () => confirmBox('Mark as done?', `Only if you completed ${c.name}.`, 'Done', () => send({ type: 'clearCurse', uid: c.uid })) }, 'Done'))))];
  }

  // ----- tools (both roles) -----
  function commonTools() {
    return [
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => send({ type: 'roll', sides: 6 }) }, 'Roll a die'),
        h('button', { class: 'btn', onclick: () => send({ type: 'roll', sides: 2 }) }, 'Flip a coin')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: showLandmarks, onchange: (e) => { showLandmarks = e.target.checked; toggleLandmarks(); } }), 'Show landmarks used by questions'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: followMe, onchange: (e) => { followMe = e.target.checked; if (followMe && myPos) map.panTo([myPos.lat, myPos.lng]); } }), 'Keep the map centred on me'),
    ];
  }
  function foundButton(label) {
    return S.phase === 'seeking'
      ? h('button', { class: 'btn danger wide', onclick: () => confirmBox('End the round?', 'Only press this when a seeker has seen the hider and called them out.', 'Found!', () => send({ type: 'found' }), true) }, label)
      : null;
  }
  function viewTools() { return [...commonTools(), foundButton('We found the hider')]; }

  // ----- hider: question -----
  function hint(q) {
    const hp = myPos || (S.zone && { lat: S.zone.lat, lng: S.zone.lng });
    if (!hp) return 'Waiting for your GPS position to suggest an answer.';
    if (q.cat === 'radar' && q.askerPos) {
      const d = dist(hp, q.askerPos);
      return `You are about ${fmtM(d)} from where they asked. Suggested answer is ${d <= q.meters ? 'YES' : 'NO'}.`;
    }
    if (q.cat === 'measuring' && q.landmark && q.askerPos) {
      const L = C.LANDMARKS[q.landmark]; const dh = dist(hp, L), ds = dist(q.askerPos, L);
      return `${L.name} is ${fmtM(dh)} from you and ${fmtM(ds)} from them. Suggested answer is ${dh < ds ? 'CLOSER' : 'FURTHER'}.`;
    }
    if (q.cat === 'thermometer' && q.startPos && q.endPos) {
      const a = dist(hp, q.startPos), b = dist(hp, q.endPos);
      return `They went from ${fmtM(a)} to ${fmtM(b)} away from you. Suggested answer is ${b < a ? 'HOTTER' : 'COLDER'}.`;
    }
    if (q.askerPos) return `They asked from about ${fmtM(dist(hp, q.askerPos))} away (shown on your map). Answer honestly using your own position.`;
    return null;
  }
  function viewQuestion() {
    const q = S.question;
    const out = [];
    if (S.phase === 'hiding') return [h('p', { class: 'muted' }, 'Questions start once hiding time is over. Use the Zone tab to lock your spot.')];
    if (S.hider.draw) out.push(h('div', { class: 'hint' }, 'Pick your reward cards in the Cards tab before answering again.'));
    if (!q) {
      out.push(h('p', { class: 'muted' }, `No question right now. ${S.used.length} asked so far. Your phone buzzes when one arrives.`));
      return out;
    }
    out.push(questionCard(q, true));
    if (q.status !== 'asked') return out;
    if (draft.qid !== q.id + q.qid) { draft.qid = q.id + q.qid; draft.choice = null; draft.text = ''; draft.photo = null; }
    const def = C.QUESTIONS[q.cat];
    const hnt = hint(q); if (hnt) out.push(h('div', { class: 'hint' }, hnt));

    const sendBtn = (label) => h('button', { class: 'btn primary wide', onclick: submitAnswer }, label);
    if (q.silenced) {
      out.push(h('p', {}, 'The coin curse landed on tails. Send silence, you still draw cards.'), sendBtn('Send silence'));
    } else if (def.answer === 'photo') {
      const file = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try { draft.photo = await resizeImage(f); renderSheet(true); } catch { toast('Could not read that photo. Try again.', 'err'); }
      } });
      out.push(file,
        draft.photo ? h('img', { src: draft.photo, class: 'photo-preview', alt: 'Your photo' }) : null,
        h('button', { class: 'btn wide', onclick: () => file.click() }, draft.photo ? 'Retake photo' : 'Take or choose photo'),
        h('input', { placeholder: 'Caption (optional)', value: draft.text, oninput: (e) => { draft.text = e.target.value; } }),
        sendBtn('Send photo'));
    } else if (def.answer === 'text') {
      out.push(h('textarea', { placeholder: 'Name the place, or say none are in range', oninput: (e) => { draft.text = e.target.value; } }, draft.text), sendBtn('Send answer'));
    } else {
      const opts = { yesno: ['yes', 'no'], closer: ['closer', 'further'], hotter: ['hotter', 'colder'] }[def.answer];
      out.push(h('div', { class: 'choices' }, opts.map((o) => h('button', {
        class: 'btn' + (draft.choice === o ? ' sel' : ''), onclick: () => { draft.choice = o; renderSheet(true); },
      }, o[0].toUpperCase() + o.slice(1)))),
      h('input', { placeholder: 'Note (optional)', value: draft.text, oninput: (e) => { draft.text = e.target.value; } }),
      sendBtn('Send answer'));
    }
    const veto = S.hider.hand.find((c) => C.CARD_BY_ID[c.id].kind === 'veto');
    const rnd = S.hider.hand.find((c) => C.CARD_BY_ID[c.id].kind === 'randomize');
    if (veto || rnd) out.push(h('div', { class: 'row' },
      veto ? h('button', { class: 'btn', onclick: () => confirmBox('Play Veto?', 'The seekers get no answer and you draw nothing.', 'Veto', () => send({ type: 'play', uid: veto.uid })) }, 'Play Veto') : null,
      rnd && q.cat !== 'thermometer' ? h('button', { class: 'btn', onclick: () => confirmBox('Play Randomize?', 'The question is swapped for a random one of the same type.', 'Randomize', () => send({ type: 'play', uid: rnd.uid })) }, 'Play Randomize') : null));
    return out;
  }
  function submitAnswer() {
    const q = S.question; if (!q) return;
    const def = C.QUESTIONS[q.cat];
    if (!q.silenced) {
      if (def.answer === 'photo' && !draft.photo) return toast('Take a photo first.', 'err');
      if (def.answer === 'text' && !draft.text.trim()) return toast('Type an answer first.', 'err');
      if (['yesno', 'closer', 'hotter'].includes(def.answer) && !draft.choice) return toast('Pick an answer first.', 'err');
    }
    send({ type: 'answer', choice: draft.choice, text: draft.text, photo: draft.photo });
  }
  function resizeImage(file, max = 1280) {
    return new Promise((resolve, reject) => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.78));
      };
      img.onerror = reject; img.src = url;
    });
  }

  // ----- hider: cards -----
  function cardEl(inst, opts = {}) {
    const c = C.CARD_BY_ID[inst.id];
    const cls = c.kind === 'time' ? 'time' : c.kind === 'curse' ? 'curse' : 'power';
    const label = c.kind === 'time' ? 'Time bonus' : c.kind === 'curse' ? 'Curse' : 'Power up';
    return h('div', {
      class: `card ${cls}${opts.onpick ? ' selectable' : ''}${opts.selected ? ' selected' : ''}`,
      role: opts.onpick ? 'button' : null, tabindex: opts.onpick ? '0' : null,
      'aria-pressed': opts.onpick ? String(!!opts.selected) : null,
      onclick: opts.onpick || null,
      onkeydown: opts.onpick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onpick(); } } : null,
    }, h('span', { class: 'kind' }, label), h('h4', {}, c.name), h('p', {}, c.text),
    c.discard ? h('span', { class: 'cost' }, `Cost – discard ${c.discard}`) : null, opts.action || null);
  }
  function viewHand() {
    const H = S.hider; const out = [];
    if (H.draw) {
      const ids = new Set(H.draw.cards.map((c) => c.uid));
      [...pick.keep].forEach((u) => { if (!ids.has(u)) pick.keep.delete(u); });
      out.push(h('div', { class: 'drawbox' },
        h('h3', {}, `Pick ${H.draw.keep} of ${H.draw.cards.length}`), h('p', { class: 'muted small' }, H.draw.reason),
        h('div', { class: 'hand' }, H.draw.cards.map((c) => cardEl(c, {
          selected: pick.keep.has(c.uid),
          onpick: () => { if (pick.keep.has(c.uid)) pick.keep.delete(c.uid); else { if (pick.keep.size >= H.draw.keep) pick.keep.delete([...pick.keep][0]); pick.keep.add(c.uid); } renderSheet(true); },
        }))),
        h('button', { class: 'btn primary wide', disabled: pick.keep.size !== H.draw.keep, onclick: () => { send({ type: 'keep', uids: [...pick.keep] }); pick.keep.clear(); } }, 'Keep selected')));
    }
    if (H.mustDiscard && !H.draw) {
      const ids = new Set(H.hand.map((c) => c.uid));
      [...pick.discard].forEach((u) => { if (!ids.has(u)) pick.discard.delete(u); });
      out.push(h('div', { class: 'drawbox' }, h('h3', {}, `Too many cards. Discard ${H.mustDiscard}.`),
        h('p', { class: 'muted small' }, 'Tap cards in your hand below, then confirm.'),
        h('button', { class: 'btn danger wide', disabled: pick.discard.size !== H.mustDiscard, onclick: () => { send({ type: 'discard', uids: [...pick.discard] }); pick.discard.clear(); } }, 'Discard selected')));
    }
    const bonus = H.hand.reduce((s, c) => s + (C.CARD_BY_ID[c.id].kind === 'time' ? C.CARD_BY_ID[c.id].minutes : 0), 0);
    out.push(h('div', { class: 'row small muted' }, h('span', {}, `Hand ${H.hand.length} of ${H.handLimit}`), h('span', {}, `Time bonus +${bonus} min`), h('span', {}, `Deck ${H.deckCount}`)));
    if (!H.hand.length) out.push(h('p', { class: 'muted' }, 'No cards yet. You draw cards every time you answer a question.'));
    out.push(h('div', { class: 'hand' }, H.hand.map((c) => {
      const def = C.CARD_BY_ID[c.id];
      if (H.mustDiscard && !H.draw) {
        return cardEl(c, { selected: pick.discard.has(c.uid), onpick: () => {
          if (pick.discard.has(c.uid)) pick.discard.delete(c.uid); else if (pick.discard.size < H.mustDiscard) pick.discard.add(c.uid);
          renderSheet(true);
        } });
      }
      const playable = def.kind !== 'time' && S.phase === 'seeking' && !H.draw;
      return cardEl(c, { action: playable ? h('button', { class: 'btn small', onclick: () => playCard(c) }, 'Play') : null });
    })));
    return out;
  }
  function playCard(inst) {
    const c = C.CARD_BY_ID[inst.id];
    const need = c.discard || 0;
    if (!need && !c.input) { confirmBox(`Play ${c.name}?`, c.text, 'Play', () => send({ type: 'play', uid: inst.uid })); return; }
    const chosen = new Set(); let input = '';
    openModal(function build(body, close) {
      body.replaceChildren();
      body.append(h('h2', {}, `Play ${c.name}`), h('p', { class: 'muted' }, c.text));
      if (c.input === 'direction') {
        body.append(h('label', { class: 'field' }, 'Direction', h('select', { onchange: (e) => { input = e.target.value; } },
          h('option', { value: '' }, 'Choose'), ['North', 'North-east', 'East', 'South-east', 'South', 'South-west', 'West', 'North-west'].map((d) => h('option', { value: d, selected: input === d }, d)))));
      } else if (c.input === 'letter') {
        body.append(h('label', { class: 'field' }, 'Letter', h('input', { maxlength: 1, value: input, oninput: (e) => { input = e.target.value.toUpperCase(); } })));
      } else if (c.input === 'language') {
        body.append(h('label', { class: 'field' }, 'Language', h('input', { maxlength: 30, value: input, placeholder: 'e.g. Lithuanian', oninput: (e) => { input = e.target.value; } })));
      }
      if (need) {
        body.append(h('p', {}, `Choose ${need} other card${need > 1 ? 's' : ''} to discard.`),
          h('div', { class: 'hand' }, S.hider.hand.filter((x) => x.uid !== inst.uid).map((x) => cardEl(x, {
            selected: chosen.has(x.uid),
            onpick: () => { if (chosen.has(x.uid)) chosen.delete(x.uid); else if (chosen.size < need) chosen.add(x.uid); build(body, close); },
          }))));
      }
      body.append(h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => {
          if (c.input && !input.trim()) return toast('Fill in the choice first.', 'err');
          if (chosen.size !== need) return toast(`Choose ${need} card${need > 1 ? 's' : ''} to discard.`, 'err');
          send({ type: 'play', uid: inst.uid, discards: [...chosen], input }); close();
        } }, 'Play')));
    });
  }

  // ----- hider: zone -----
  function viewZone() {
    const out = [];
    const r = S.settings.zoneRadius;
    if (S.phase === 'hiding') {
      out.push(h('div', { class: 'hint' }, 'Time left to hide ', h('b', { 'data-countdown': S.hideEndsAt })),
        h('p', {}, `Walk to your spot inside the play area. Locking makes a ${r} m circle around where you stand. You may stay anywhere inside it once seeking starts. If you do not lock, it locks wherever you are when time runs out.`));
    }
    if (S.zone) {
      const d = myPos ? dist(myPos, S.zone) : null;
      out.push(h('p', {}, h('b', {}, 'Zone locked'), ` at ${clockTime(S.zone.lockedAt)}. `, d != null ? `You are ${fmtM(d)} from its centre.` : ''));
      if (S.phase === 'hiding') out.push(h('button', { class: 'btn wide', onclick: () => send({ type: 'unlockZone' }) }, 'Unlock and move on'));
    } else if (['hiding', 'seeking'].includes(S.phase)) {
      const outside = myPos && !inPlayArea(myPos);
      out.push(h('button', { class: 'btn primary wide', disabled: !myPos || outside, onclick: () => send({ type: 'lockZone' }) },
        !myPos ? 'Waiting for GPS…' : outside ? 'Get inside the play area first' : (S.moving ? 'Lock new zone here' : 'Lock zone here')));
      if (myPos) out.push(h('p', { class: 'muted small' }, `GPS accuracy about ${Math.round(myPos.acc)} m.`));
    }
    if (S.phase === 'seeking') out.push(h('p', { class: 'muted small' }, 'Once a seeker enters your zone, everyone is told and you must stop moving.'));
    out.push(...commonTools(), foundButton('I have been found'));
    return out;
  }

  // ----- results -----
  function viewResults() {
    const last = S.results[S.results.length - 1];
    const best = S.results.reduce((b, r) => (!b || r.totalMs > b.totalMs ? r : b), null);
    return [
      last ? h('div', { class: 'section' },
        h('div', { class: 'muted' }, `Round ${last.round}, hidden by ${last.hiders}`),
        h('div', { class: 'bigtime' }, fmt(last.totalMs)),
        h('div', { class: 'small' }, `${fmt(last.seekMs)} seeking plus ${last.bonusMin} min of time bonus cards`)) : null,
      h('table', { class: 'results' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Round'), h('th', {}, 'Hider'), h('th', {}, 'Total'))),
        h('tbody', {}, S.results.map((r) => h('tr', {}, h('td', {}, r.round), h('td', {}, r.hiders, r === best ? ' 🏆' : ''), h('td', { class: 'num' }, fmt(r.totalMs)))))),
      h('p', { class: 'muted small' }, 'The hider\'s zone and route positions are now shown on the map.'),
      isHost() ? h('button', { class: 'btn primary wide', onclick: () => send({ type: 'newRound' }) }, 'Back to lobby for the next round')
        : h('p', { class: 'muted' }, 'Waiting for the host to start the next round.'),
    ];
  }

  // ---------- menu ----------
  function renderMenu(force) {
    if (!S) return;
    const key = JSON.stringify([S.code, S.hostId, S.me, S.phase, S.paused, S.players.map((p) => [p.id, p.name, p.role, p.connected])]);
    if (!force && key === menuKey) return;
    menuKey = key;
    $('#menu-code').textContent = S.code;
    const host = isHost();
    const hostP = S.players.find((p) => p.id === S.hostId);
    const running = ['hiding', 'seeking'].includes(S.phase);
    $('#menu-body').replaceChildren(...[
      h('button', { class: 'btn wide', onclick: shareLink }, 'Invite friends'),
      h('div', { class: 'section' }, h('h3', {}, 'Players'),
        h('ul', { class: 'players' }, S.players.map((p) => h('li', { class: p.connected ? '' : 'off' },
          h('span', { class: 'name' }, p.name, p.id === S.hostId ? ' (host)' : ''), h('span', { class: 'small muted' }, p.role === 'hider' ? 'Hider' : 'Seeker', p.connected ? '' : ', offline'))))),
      host && running ? h('div', { class: 'section' }, h('h3', {}, 'Host controls'),
        S.paused ? h('button', { class: 'btn primary wide', onclick: () => { $('#menu').close(); send({ type: 'resume' }); } }, 'Resume game')
          : h('button', { class: 'btn wide', onclick: () => { $('#menu').close(); send({ type: 'pause' }); } }, 'Pause game'),
        S.phase === 'hiding' ? h('button', { class: 'btn wide', onclick: () => confirmBox('End hiding time now?', 'Seekers can start immediately.', 'End hiding', () => send({ type: 'endHiding' })) }, 'End hiding time now') : null,
        h('button', { class: 'btn danger wide', onclick: () => confirmBox('Abort this round?', 'Nothing is recorded. Everyone goes back to the lobby.', 'Abort round', () => send({ type: 'abort' }), true) }, 'Abort round')) : null,
      !host && hostP && !hostP.connected ? h('button', { class: 'btn wide', onclick: () => send({ type: 'claimHost' }) }, 'Become host (host is offline)') : null,
      h('div', { class: 'section' }, h('h3', {}, 'Rules'), h('ol', { class: 'rules' }, C.RULES.map((r) => h('li', {}, r)))),
      h('button', { class: 'btn ghost wide', onclick: () => confirmBox('Leave this game?', 'You can rejoin with the code later as a new player.', 'Leave', () => {
        send({ type: 'leave' }); const s = store.get(); delete s.code; delete s.pid; store.set(s); location.href = '/';
      }, true) }, 'Leave game'),
    ].filter(Boolean));
  }
  $('#btn-menu').addEventListener('click', () => { renderMenu(true); $('#menu').showModal(); });

  // ---------- map ----------
  let map = null;
  const layers = {};
  let zonesKey = '', notesKey = '';
  function initMap() {
    map = L.map('map', { zoomControl: false, attributionControl: true }).setView([Z.start.lat, Z.start.lng], 15);
    // OpenStreetMap tiles, no API key needed. Darkened with CSS (.map-tiles in style.css).
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, className: 'map-tiles',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);
    const Locate = L.Control.extend({
      onAdd() {
        const b = L.DomUtil.create('a', 'leaflet-bar leaflet-control');
        b.href = '#'; b.title = 'Show my position'; b.textContent = '◎';
        b.style.cssText = 'width:34px;height:34px;line-height:34px;text-align:center;font-size:20px;background:#fff;color:#16213A;display:block';
        L.DomEvent.on(b, 'click', (e) => { L.DomEvent.stop(e); if (myPos) map.setView([myPos.lat, myPos.lng], Math.max(map.getZoom(), 16)); else toast('No GPS position yet.', 'err'); });
        return b;
      },
    });
    new Locate({ position: 'topright' }).addTo(map);
    ['mask', 'zones', 'notes', 'landmarks', 'zone', 'players', 'me'].forEach((k) => { layers[k] = L.layerGroup(); });
    ['mask', 'zones', 'notes', 'zone', 'players', 'me'].forEach((k) => layers[k].addTo(map));
    for (const lm of Object.values(C.LANDMARKS)) {
      L.circleMarker([lm.lat, lm.lng], { radius: 4, color: '#F3E9D6', weight: 1.5, fillColor: '#16213A', fillOpacity: 1 }).addTo(layers.landmarks);
      L.marker([lm.lat, lm.lng], { interactive: false, icon: L.divIcon({ className: '', html: `<span class="lm">${lm.name}</span>`, iconSize: null }) }).addTo(layers.landmarks);
    }
    toggleLandmarks();
    drawZones(true);
    fitArea();
  }
  function toggleLandmarks() { if (!map) return; if (showLandmarks) layers.landmarks.addTo(map); else map.removeLayer(layers.landmarks); }
  function fitArea() {
    if (!map) return;
    const pts = activeAreas().flatMap((a) => a.coords);
    const sh = $('#sheet');
    const bottom = sh.hidden ? 40 : Math.min(sh.offsetHeight, window.innerHeight * 0.55) + 10;
    map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [10, 80], paddingBottomRight: [10, bottom] });
  }
  function drawZones(force) {
    const include = S ? S.settings.includeNaujamiestis : true;
    if (!force && zonesKey === String(include)) return;
    zonesKey = String(include);
    layers.mask.clearLayers(); layers.zones.clearLayers();
    const active = Object.values(Z.areas).filter((a) => !a.optional || include);
    L.polygon([[[85, -180], [85, 180], [-85, 180], [-85, -180]], ...active.map((a) => a.coords)],
      { stroke: false, fillColor: '#060a16', fillOpacity: 0.55, interactive: false }).addTo(layers.mask);
    for (const a of Object.values(Z.areas)) {
      const on = !a.optional || include;
      const poly = L.polygon(a.coords, { color: a.color, weight: on ? 3 : 1.5, dashArray: on ? null : '6 8', fillOpacity: on ? 0.06 : 0, interactive: false }).addTo(layers.zones);
      L.marker(poly.getBounds().getCenter(), { interactive: false, icon: L.divIcon({ className: '', html: `<span class="zone-label" style="color:${a.color}">${a.name}${on ? '' : ' (off)'}</span>`, iconSize: null }) }).addTo(layers.zones);
    }
  }

  function drawPlayers() {
    if (!map) return;
    layers.players.clearLayers(); layers.zone.clearLayers();
    for (const p of S.players) {
      if (p.id === S.me || !p.pos) continue;
      if (Date.now() + offset - p.pos.t > 10 * MIN && S.phase !== 'ended') continue;
      L.marker([p.pos.lat, p.pos.lng], { icon: L.divIcon({ className: '', html: `<span class="pin ${p.role === 'hider' ? 'hider' : ''}">${escapeHtml(p.name)}</span>`, iconSize: null }) }).addTo(layers.players);
    }
    if (S.zone) {
      L.circle([S.zone.lat, S.zone.lng], { radius: S.zone.r, color: '#5FC3B4', weight: 3, fillOpacity: 0.15 }).addTo(layers.zone)
        .bindPopup(S.phase === 'ended' ? 'The hiding zone' : 'Your hiding zone');
    }
    const q = S.question;
    if (isHider() && q && q.askerPos) {
      L.marker([q.askerPos.lat, q.askerPos.lng], { icon: L.divIcon({ className: '', html: `<span class="pin ask">? ${escapeHtml(q.askedByName)}</span>`, iconSize: null }) }).addTo(layers.zone);
      if (q.cat === 'radar' && q.meters) L.circle([q.askerPos.lat, q.askerPos.lng], { radius: q.meters, color: '#fff', weight: 1.5, dashArray: '4 6', fill: false }).addTo(layers.zone);
    }
    if (!isHider() && q && q.status === 'walking' && q.startPos) {
      L.circleMarker([q.startPos.lat, q.startPos.lng], { radius: 6, color: '#E06666', weight: 3, fillOpacity: 1 }).addTo(layers.zone).bindTooltip('Thermometer start');
      L.circle([q.startPos.lat, q.startPos.lng], { radius: q.meters, color: '#E06666', weight: 1.5, dashArray: '4 6', fill: false }).addTo(layers.zone);
    }
  }
  let meMarker = null, meCircle = null;
  function drawMe() {
    if (!map || !myPos) return;
    const ll = [myPos.lat, myPos.lng];
    if (!meMarker) {
      meCircle = L.circle(ll, { radius: myPos.acc, weight: 1, color: '#ffffff', fillOpacity: 0.08, interactive: false }).addTo(layers.me);
      meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 }).addTo(layers.me);
    } else { meMarker.setLatLng(ll); meCircle.setLatLng(ll); meCircle.setRadius(myPos.acc); }
  }

  function drawNotes() {
    if (!map) return;
    const key = showNotes + ':' + S.qlog.map((q) => q.id).join(',');
    if (key === notesKey) return;
    notesKey = key;
    layers.notes.clearLayers();
    if (!showNotes) return;
    const DARK = { color: '#000', fillColor: '#000', fillOpacity: 0.38, weight: 0 };
    for (const q of S.qlog) {
      if (q.status !== 'answered' || !q.answer) continue;
      const col = C.QUESTIONS[q.cat].color;
      const label = `${C.QUESTIONS[q.cat].label} – ${q.text} Answer ${q.answer.choice || q.answer.text || 'photo'}`;
      if (q.askerPos) L.circleMarker([q.askerPos.lat, q.askerPos.lng], { radius: 5, color: col, weight: 2, fillOpacity: 1 }).bindPopup(escapeHtml(label)).addTo(layers.notes);
      if (q.cat === 'radar' && q.askerPos && q.meters && q.answer.choice) {
        const yes = q.answer.choice === 'yes';
        L.circle([q.askerPos.lat, q.askerPos.lng], yes ? { radius: q.meters, color: col, weight: 2, fillOpacity: 0.08 } : { radius: q.meters, ...DARK, weight: 2, color: col, dashArray: '6 6' })
          .bindPopup(escapeHtml(label)).addTo(layers.notes);
      }
      if (q.cat === 'measuring' && q.landmark && q.askerPos && q.answer.choice) {
        const lm = C.LANDMARKS[q.landmark]; const r = dist(q.askerPos, lm);
        const closer = q.answer.choice === 'closer';
        L.circle([lm.lat, lm.lng], closer ? { radius: r, color: col, weight: 2, fillOpacity: 0.08 } : { radius: r, ...DARK, weight: 2, color: col, dashArray: '6 6' })
          .bindPopup(escapeHtml(label)).addTo(layers.notes);
      }
      if (q.cat === 'thermometer' && q.startPos && q.endPos && q.answer.choice) {
        const o = { lat: (q.startPos.lat + q.endPos.lat) / 2, lng: (q.startPos.lng + q.endPos.lng) / 2 };
        const e = toXY(o, q.endPos); const len = Math.hypot(e.x, e.y) || 1;
        const u = { x: e.x / len, y: e.y / len }; const p = { x: -u.y, y: u.x }; const Lm = 3000;
        const sgn = q.answer.choice === 'hotter' ? -1 : 1; // shade the side the hider is NOT on
        const a = { x: p.x * Lm, y: p.y * Lm }, b = { x: -p.x * Lm, y: -p.y * Lm };
        const poly = [a, b, { x: b.x + sgn * u.x * Lm, y: b.y + sgn * u.y * Lm }, { x: a.x + sgn * u.x * Lm, y: a.y + sgn * u.y * Lm }].map((v) => fromXY(o, v));
        L.polygon(poly, DARK).bindPopup(escapeHtml(label)).addTo(layers.notes);
        L.polyline([[q.startPos.lat, q.startPos.lng], [q.endPos.lat, q.endPos.lng]], { color: col, weight: 4 }).bindPopup(escapeHtml(label)).addTo(layers.notes);
      }
    }
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------- boot ----------
  initMap();
  connect();
  if (store.get().code && store.get().pid) startGeo();
})();
