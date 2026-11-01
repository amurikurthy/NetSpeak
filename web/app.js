import { Engine, supported } from './audio.js';

export const $ = (s, r = document) => r.querySelector(s);
export function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style') e.style.cssText = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
export function toast(msg, ms = 3500) {
  const t = h('div', { class: 'toast' }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}
export async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(j.error || r.statusText); e.status = r.status; throw e; }
  return j;
}

// ---------- prefs ----------
const defaults = { micId: '', spkId: '', micGain: 1, master: 1, wake: true,
  roomVol: {}, feedVol: {}, joined: [], listening: [], feedGain: 1, left: [], feedsOff: [], seeded: false, ver: 3 };
export const prefs = (() => { try { return { ...defaults, ...JSON.parse(localStorage.getItem('ns.prefs') || '{}') }; } catch { return { ...defaults }; } })();
// v2: rooms are no longer all auto-joined. Forget the join list v1 built up so people start with one room.
if (!prefs.ver || prefs.ver < 2) { prefs.joined = []; prefs.left = []; prefs.seeded = false; delete prefs.autoJoin; }   // v2: rooms are not all auto-joined
if (!prefs.ver || prefs.ver < 3) prefs.wake = true;                                                              // v3: keep screen on is the default
prefs.ver = 3;
// Volume sliders top out at 100% (normal level, no boost). Cap anything saved from the old 150%/200% range.
prefs.master = Math.min(1, prefs.master); prefs.micGain = Math.min(1.25, prefs.micGain);
for (const m of [prefs.roomVol, prefs.feedVol]) for (const k of Object.keys(m)) m[k] = Math.min(1, m[k]);
export const savePrefs = () => { try { localStorage.setItem('ns.prefs', JSON.stringify(prefs)); } catch {} };

// ---------- state ----------
const S = { me: null, rooms: [], feeds: [], presence: { rooms: {}, feeds: {} }, joined: new Set(), talking: new Set(),
  listening: new Set(), calls: new Set(), active: null, publishing: null, connected: false, c: 0 };
const engine = new Engine();
let syncTimer = null;
let ws = null, wsTimer = null, backoff = 500, lastRx = 0, pingTimer = null, voice = null, micPromise = null, micError = '', wakeLock = null;
let lastFbToast = 0;
const root = $('#app');

if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

// ---------- boot ----------
async function boot() {
  try { S.me = await api('GET', '/api/me'); } catch { return loginView(); }
  appView();
}
addEventListener('hashchange', () => { if (S.me) appView(); });

function loginView() {
  const err = h('div', { class: 'err' });
  const u = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', placeholder: 'Username' });
  const p = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password' });
  const go = async (e) => {
    e.preventDefault(); err.textContent = '';
    try { S.me = await api('POST', '/api/login', { username: u.value, password: p.value }); appView(); }
    catch (x) { err.textContent = x.message; }
  };
  root.replaceChildren(h('div', { class: 'center' }, h('form', { class: 'card', onsubmit: go },
    h('h1', {}, 'NetSpeak'), h('p', { class: 'sub' }, 'Sign in to your intercom'),
    h('label', { class: 'f' }, 'Username'), u, h('label', { class: 'f' }, 'Password'), p,
    err, h('button', { class: 'primary', style: 'width:100%;margin-top:8px' }, 'Sign in'))));
}

// ---------- main view ----------
let cards = new Map(), sig = '', ui = {};

async function appView() {
  if (location.hash === '#admin' && S.me.role === 'admin') {
    const m = await import('./admin.js');
    return m.adminView(root, { me: S.me, back: () => { location.hash = ''; }, });
  }
  cards = new Map(); sig = '';
  ui.dot = h('span', { class: 'dot' });
  ui.who = h('div', { class: 'who' }, S.me.displayName);
  ui.rooms = h('div'); ui.feeds = h('div'); ui.warn = h('div');
  ui.audio = h('div', { class: 'warn', hidden: true, style: 'cursor:pointer;font-weight:600', onclick: () => enableAudio() }, '🔇 Audio is off: tap here to start listening');
  ui.micMeter = makeMeter(); ui.micRow = ui.micMeter.el;
  const masterMeter = addMeter('master', () => engine.masterLevel());
  const micPct = h('span', {}, Math.round(prefs.micGain * 100) + '%');
  const mv = h('input', { type: 'range', min: 0, max: 1.25, step: 0.01, value: prefs.micGain, oninput: (e) => { prefs.micGain = +e.target.value; micPct.textContent = Math.round(prefs.micGain * 100) + '%'; savePrefs(); voice?.setGain(prefs.micGain); } });
  const lv = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: prefs.master, oninput: (e) => { prefs.master = +e.target.value; savePrefs(); engine.setMaster(prefs.master); } });
  engine.vol.master = prefs.master;
  root.replaceChildren(
    h('div', { class: 'top' }, h('div', { class: 'brand' }, ui.dot, h('div', {}, h('div', {}, 'NetSpeak'), ui.who)),
      S.me.role === 'admin' && h('button', { class: 'ghost', onclick: () => { location.hash = '#admin'; } }, 'Admin'),
      pipSupported() && h('button', { class: 'ghost', title: 'Floating window: who is talking', 'aria-label': 'Floating window', onclick: pipToggle }, '⧉', h('span', { class: 'lbl' }, ' Float')),
      h('button', { class: 'ghost', title: 'Pocket lock', 'aria-label': 'Pocket lock', onclick: pocketLock }, '🔒', h('span', { class: 'lbl' }, ' Pocket lock')),
      h('button', { class: 'ghost', title: 'Settings', 'aria-label': 'Settings', onclick: settings }, '⚙', h('span', { class: 'lbl' }, ' Settings'))),
    h('div', { class: 'wrap' }, ui.warn, ui.audio, h('h2', {}, 'Rooms'), ui.rooms, h('h2', {}, 'Program feeds'), ui.feeds),
    h('div', { class: 'bar' }, h('div', { class: 'in' },
      h('div', {}, h('label', {}, h('span', {}, 'Listening volume')), lv, masterMeter.el),
      h('div', {}, h('label', {}, h('span', {}, 'Microphone volume'), micPct), mv, ui.micRow))));
  if (!supported) ui.warn.append(h('div', { class: 'warn' }, 'This browser lacks WebCodecs audio. Use a current Chrome, Edge, Firefox or Safari 26+.'));
  if (!window.isSecureContext) ui.warn.append(h('div', { class: 'warn' }, 'Microphone needs HTTPS. Open this page over https://.'));
  connect();
  updateMediaSession();
  setWake();
}

function connect() {
  clearTimeout(wsTimer);
  if (S.publishing) S.republish = true;   // the server forgets a sender when its connection ends: announce it again once the new one is up
  if (ws) { ws.onclose = null; try { ws.close(); } catch {} S.talking.clear(); stopSending(); }   // the server drops talk state with the old connection
  const w = ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  w.binaryType = 'arraybuffer';
  w.onopen = () => { backoff = 500; lastRx = Date.now(); setConn(true); startClockSync(); };
  w.onmessage = (e) => {
    lastRx = Date.now();
    if (typeof e.data !== 'string') return engine.receive(e.data);
    onMsg(JSON.parse(e.data));
  };
  w.onclose = async () => {
    if (w !== ws) return;
    setConn(false);
    S.talking.clear(); stopSending();
    try { await api('GET', '/api/me'); } catch (x) { if (x.status === 401) { S.me = null; return loginView(); } }
    wsTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 8000);
  };
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    if (Date.now() - lastRx > 45000) return ws.close();
    send({ t: 'ping' });
  }, 15000);
}
// Measure this device's clock against the server's: a quick burst, then every 5 s. Used to play the program
// feed at the same instant as every other listener.
engine.onClockTrouble = () => { if (S.connected) startClockSync(); };
function startClockSync() {
  clearInterval(syncTimer);   // (existing measurements are kept: they stay valid, and a real clock jump is detected from fresh ones)
  const ping = () => send({ t: 'sync', c: performance.now() });
  let n = 0; ping();
  syncTimer = setInterval(() => { ping(); if (++n === 8) { clearInterval(syncTimer); syncTimer = setInterval(ping, 5000); } }, 150);
}
const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
function setConn(on) { S.connected = on; ui.dot?.classList.toggle('on', on); }

// Coming back to the app after swiping away or switching apps. While it was away the phone may have suspended the
// sound engine, stopped the microphone and silently killed the connection, so repair all of it at once instead of
// waiting for timeouts.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
  recover(hiddenAt ? Date.now() - hiddenAt : 0);
});
addEventListener('pageshow', (e) => { if (e.persisted) recover(60000); });   // restored from the back/forward cache
addEventListener('online', () => recover(60000));
async function recover(awayMs) {
  if (!S.me) return;
  setWake();
  if (engine.ctx && engine.ctx.state === 'closed') return location.reload();   // the phone destroyed the sound engine: start over
  // Leaving the app is not always being away: with the floating window open the page keeps running and the audio never
  // stopped. If the connection is open, the sound engine is running and packets or clock replies are still arriving,
  // there is nothing to repair, and tearing it down would only make the sound glitch.
  const t = performance.now();
  const healthy = !!ws && ws.readyState === 1 && !!engine.ctx && engine.ctx.state === 'running'
    && (t - (engine.stats.rxLast || 0) < 2000 || t - (S.pongAt || 0) < 8000);
  const stale = awayMs > 3000 && !healthy;
  if (stale) engine.resetVoices();                                              // anything decoded before leaving is stale
  engine.resume();                                                              // may need a tap on some phones: the banner covers that
  // A connection that was open before an absence is usually dead now, even if it still says "open".
  if (stale || !ws || ws.readyState !== 1) connect();
  // The phone may have stopped the microphone while the app was away.
  if (voice && voice.track && voice.track.readyState !== 'live') await closeMic();
  if (S.rooms.some((r) => r.talk)) ensureMic();
  if (!healthy && ws && ws.readyState === 1) startClockSync();   // the device clock may have lost time while away: measure it again
  audioBanner();
}

function onMsg(m) {
  switch (m.t) {
    case 'state': {
      const rooms = m.rooms || [], feeds = m.feeds || [];   // a user with no access gets empty lists, never null
      if (m.feedDelayMs) engine.feedDelayMs = m.feedDelayMs;
      S.rooms = rooms; S.feeds = feeds; S.c = m.you.c; S.me = { ...S.me, displayName: m.you.name, role: m.you.role };
      if (ui.who) ui.who.textContent = m.you.name;   // an admin may rename this user while they are connected
      engine.registerChannels(rooms, feeds);
      const ids = new Set(rooms.map((r) => r.id)), fids = new Set(feeds.map((f) => f.id));
      // Rooms: remembered ones, plus (by default) every room this user can hear except those they left on purpose.
      for (const id of prefs.joined) if (ids.has(id)) S.joined.add(id);
      if (!prefs.seeded && rooms.length) { S.joined.add((rooms.find((r) => r.talk) || rooms[0]).id); prefs.seeded = true; }   // first visit: just one room
      for (const id of [...S.joined]) { if (ids.has(id)) send({ t: 'join', room: id }); else S.joined.delete(id); }
      for (const id of prefs.listening) if (fids.has(id)) S.listening.add(id);
      for (const f of feeds) if (f.listen && !prefs.feedsOff.includes(f.id)) S.listening.add(f.id);
      for (const id of [...S.listening]) { if (fids.has(id)) send({ t: 'listen', feed: id, on: true }); else S.listening.delete(id); }
      // Drop anything that was deleted or lost its permission while we were using it.
      for (const id of [...S.talking]) { const r = rooms.find((x) => x.id === id); if (!r || !r.talk || !S.joined.has(id)) talkStop(id); }
      for (const id of [...S.calls]) if (!S.joined.has(id)) S.calls.delete(id);
      if (S.active && !ids.has(S.active)) S.active = null;
      if (S.publishing && !fids.has(S.publishing)) stopPublish(false);
      persist();
      render();
      if (S.republish) { S.republish = false; const f = feeds.find((x) => x.id === S.publishing); if (f && f.source) startPublish(f, S.pubDevice); else if (S.publishing) stopPublish(true); }
      for (const id of [...S.calls]) { if (!S.talking.has(id)) talkStart(id); }
      if (rooms.some((r) => r.talk)) ensureMic(); else closeMic();   // mic stays open while the user can talk anywhere
      if (S.joined.size || S.listening.size) enableAudio();   // starts at once where the browser allows it
      break;
    }
    case 'sync': S.pongAt = performance.now(); engine.clock.add(m.c, m.s, performance.now()); break;
    case 'presence': S.presence = m; notePresence(m); update(); break;
    case 'publish': if (!m.on && S.publishing === m.feed) stopPublish(true); break;
    case 'error': toast(m.msg); break;
    case 'kicked': toast('Your access was removed'); break;
  }
}

function render() {
  const s = JSON.stringify([S.rooms, S.feeds]);
  if (s === sig) return update();
  sig = s; cards.clear(); for (const k of [...meters.keys()]) if (k !== 'master') meters.delete(k);
  ui.rooms.replaceChildren(...(S.rooms.length ? S.rooms.map(roomCard) : [h('p', { class: 'sub' }, 'No rooms available to you yet. Ask an admin for access.')]));
  ui.feeds.replaceChildren(...(S.feeds.length ? S.feeds.map(feedCard) : [h('p', { class: 'sub' }, 'No program feeds available.')]));
  update();
}

// A speaker stays highlighted for a moment after they stop, so a name does not flash on and off between words.
const TAIL_MS = 3000;
const heard = new Map();      // "roomId:connection" -> when that person was last speaking
const lastSpoke = {};         // roomId -> the most recent person to speak there (kept for the floating window)
let tailTimer = 0;
function notePresence(m) {
  const now = Date.now();
  for (const [rid, ms] of Object.entries(m.rooms || {})) for (const x of ms || []) if (x.t) { heard.set(rid + ':' + x.c, now); lastSpoke[rid] = { n: x.c === S.c ? 'You' : x.n }; }
  scheduleTail();
}
const isHot = (rid, x) => !!x.t || Date.now() - (heard.get(rid + ':' + x.c) || 0) < TAIL_MS;
function scheduleTail() {
  clearTimeout(tailTimer); const now = Date.now(); let next = Infinity;
  for (const [k, t] of heard) { if (now - t >= TAIL_MS) heard.delete(k); else next = Math.min(next, t + TAIL_MS); }
  if (next < Infinity) tailTimer = setTimeout(() => { update(); scheduleTail(); }, next - now + 30);   // redraw when the next highlight runs out
}
function update() { for (const c of cards.values()) c(); audioBanner(); pip.baseOk = false; pipDraw(); }

// Browsers only start audio after a tap/click. Rooms remembered from a previous visit are re-joined
// automatically, so without this the room looks joined while nothing is actually playing.
function audioNeeded() {
  return (S.joined.size > 0 || S.listening.size > 0) && (!engine.ctx || engine.ctx.state !== 'running' || engine.el?.paused);
}
engine.onState = () => audioBanner();
engine.onAecOff = () => toast('This device is too busy for echo cancellation, so it was switched off to keep the sound smooth. Earbuds avoid echo.', 8000);
function audioBanner() { if (ui.audio) ui.audio.hidden = !audioNeeded(); }
async function enableAudio() {
  try {
    await engine.start(); await engine.resume();
    for (const id of S.joined) applyRoom(id);
    for (const id of S.listening) applyVol('feed', id, prefs.feedVol[id] ?? 1);
  } catch (e) { toast('Could not start audio: ' + e.message); }
  audioBanner();
}
for (const ev of ['pointerup', 'keydown', 'click', 'touchend']) addEventListener(ev, () => { if (S.me && audioNeeded()) enableAudio(); }, true);
setInterval(audioBanner, 1000);

function persist() { prefs.joined = [...S.joined]; prefs.listening = [...S.listening]; savePrefs(); }

// ----- rooms -----
function roomCard(r) {
  const chips = h('div', { class: 'chips' });
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: prefs.roomVol[r.id] ?? 1,
    oninput: (e) => { prefs.roomVol[r.id] = +e.target.value; savePrefs(); applyRoom(r.id); } });
  const sw = h('input', { type: 'checkbox', onchange: async (e) => {
    if (e.target.checked) { prefs.left = prefs.left.filter((x) => x !== r.id); engine.startChannel('room', r.id); S.joined.add(r.id); send({ t: 'join', room: r.id }); await engine.start(); applyRoom(r.id); }
    else { if (!prefs.left.includes(r.id)) prefs.left.push(r.id); if (S.talking.has(r.id)) talkStop(r.id); S.joined.delete(r.id); send({ t: 'leave', room: r.id }); engine.stopChannel('room', r.id); }
    persist(); update();
  } });
  const btn = r.talk ? talkButton(r) : null;
  const mt = addMeter('r' + r.id, () => engine.level('room', r.id));
  const el = h('section', { class: 'card room', style: `--c:${r.color}` },
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, r.name), h('div', { class: 'sub' }, r.talk ? 'Listen & talk' : 'Listen only')),
      h('label', { class: 'sw' }, sw, h('i'))),
    chips, h('div', { class: 'sub' }, 'Room volume'), vol, mt.el, btn);
  cards.set(r.id, () => {
    const on = S.joined.has(r.id);
    sw.checked = on; el.classList.toggle('joined', on); mt.el.hidden = !on;
    const ms = S.presence.rooms?.[r.id] || [];
    // Everyone in the room is listed, and whoever is speaking lit up, whether or not you have joined it yourself.
    chips.replaceChildren(...(ms.length ? ms.map((m) => [m, isHot(r.id, m)]).sort((a, b) => b[1] - a[1]).map(([m, hot]) => h('span', { class: 'chip' + (hot ? ' talk' : '') }, m.n + (m.c === S.c ? ' (you)' : ''))) : [h('span', { class: 'sub' }, 'Nobody here')]));
    if (btn) { btn.hidden = !on; btn.classList.toggle('on', S.talking.has(r.id)); btn._label(); }
  });
  if (S.joined.has(r.id)) setTimeout(() => applyRoom(r.id), 0);
  return el;
}

// Volume for a room. Everyone stays audible while you talk; feedback is handled on the mic path instead.
function applyRoom(id) { applyVol('room', id, prefs.roomVol[id] ?? 1); }
function applyVol(kind, id, v) { if (engine.ctx) engine.setVolume(kind, id, v); }

function talkButton(r) {
  const b = h('button', { class: 'talk-btn', oncontextmenu: (e) => e.preventDefault() });
  let downAt = 0;
  b._label = () => {
    const on = S.talking.has(r.id), latched = S.calls.has(r.id);
    b.replaceChildren(on ? 'TALKING' : (r.pttOnly ? 'HOLD TO TALK' : 'TAP OR HOLD TO TALK'),
      h('small', {}, on ? (latched ? 'tap to stop' : 'release to stop') : (r.pttOnly ? 'push-to-talk only' : 'tap to latch · hold for push-to-talk')));
  };
  b.addEventListener('pointerdown', async (e) => {
    e.preventDefault(); b.setPointerCapture(e.pointerId);
    if (S.talking.has(r.id)) return talkStop(r.id);   // tap while latched: stop
    downAt = Date.now(); await talkStart(r.id);
  });
  const up = () => {
    if (!S.talking.has(r.id) || !downAt) return;
    const held = Date.now() - downAt; downAt = 0;
    if (held < 350 && !r.pttOnly) { S.calls.add(r.id); b._label(); update(); } else talkStop(r.id);   // quick tap latches
  };
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', () => { downAt = 0; if (!S.calls.has(r.id)) talkStop(r.id); });
  b.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat) { e.preventDefault(); S.talking.has(r.id) ? talkStop(r.id) : toggleCall(r.id); } });
  return b;
}

function toggleCall(id) {
  if (S.calls.has(id)) return talkStop(id);
  S.calls.add(id); S.active = id; talkStart(id);
}
// Earbud / headset button: toggles latched talk in the active room.
function earbudToggle() {
  const talkable = S.rooms.filter((r) => r.talk && S.joined.has(r.id));
  const id = (S.active && talkable.find((r) => r.id === S.active)?.id) || talkable[0]?.id;
  if (!id) return toast('Join a room first');
  if (S.talking.has(id)) { talkStop(id); toast('Mic off'); } else { toggleCall(id); toast('Mic on'); }
}

// ----- mic / talking -----
function micOpts() {
  return { channels: 1, bitrate: 32000, application: 'voip', deviceId: prefs.micId, gain: prefs.micGain,
    // Browser echo cancellation is OFF on purpose: on Android it switches the whole phone into "call" audio mode
    // (a separate call volume slider, wrong routing). Echo is removed by our own software canceller in the mic
    // worklet (aec: it learns from what this device is playing), and howling by the feedback suppressor.
    ec: false, ns: true, agc: false, hpf: 80, gate: false, feedback: true, aec: true,
    onAec: (db) => { S.aecDb = db; },
    onFeedback: (f) => { S.fb = f; if (Date.now() - lastFbToast > 20000) { lastFbToast = Date.now(); toast('Feedback detected and suppressed. Earbuds, or moving devices apart, will stop it for good.'); } },
    onLevel: (l) => { setMeter(l); vadFrame(l); },
    onFrame: (seq, d) => {
      if (!ws || ws.readyState !== 1) return;
      for (const id of S.talking) {
        const r = S.rooms.find((x) => x.id === id); if (!r) continue;
        const msg = new Uint8Array(7 + d.length); const dv = new DataView(msg.buffer);
        dv.setUint8(0, 1); dv.setUint16(1, r.ch); dv.setUint32(3, seq); msg.set(d, 7);
        ws.send(msg);
      }
    } };
}

// The microphone stays open for as long as the app is open (and the user can talk anywhere). Opening and
// closing it makes phones and PCs switch audio modes, which glitches what you hear. Nothing is sent
// until a talk button is pressed.
function ensureMic() {
  if (voice) return Promise.resolve(voice);
  if (!micPromise) {
    micPromise = engine.capture('voice', micOpts())
      .then((v) => { voice = v; micError = ''; return v; })
      .catch((e) => { micError = e.name === 'NotAllowedError' ? 'permission denied' : e.message; return null; })
      .finally(() => { micPromise = null; });
  }
  return micPromise;
}
async function closeMic() { if (voice) { const v = voice; voice = null; await engine.stopCapture('voice'); setMeter(0); } }
// Level meter in dB: -60 dBFS at the left edge to 0 dBFS at the right. The colour bands are fixed on the bar
// (green, yellow from -30 dB, orange from -21 dB, red from -12 dB); the level only decides how much is lit.
function setMeter(l) {
  if (!ui.micMeter) return;
  const db = 20 * Math.log10(Math.max(Number.isFinite(l) ? l : 0, 1e-5));
  ui.micMeter.update(db, db, performance.now());
}

// A dB meter for something you hear (a room, the program feed, everything): -60 dBFS at the left to 0 at the right, the
// same look as the microphone meter: colour bands and a white peak tick that holds for a second. It rises at once and
// falls steadily, like a VU meter.
function makeMeter() {
  const mask = h('b'), tick = h('i');
  const el = h('div', { class: 'meter' }, mask, tick);
  let disp = -90, peak = -90, peakAt = 0, last = 0;
  const pct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  return { el, update(rms, pk, now) {
    const dt = last ? Math.min(0.2, (now - last) / 1000) : 0.016; last = now;
    disp = Math.max(Number.isFinite(rms) ? rms : -90, disp - 28 * dt);
    if (disp > peak) { peak = disp; peakAt = now; } else if (now - peakAt > 1000) peak = Math.max(disp, peak - 20 * dt);
    mask.style.width = (100 - pct(disp)) + '%';
    tick.style.left = 'calc(' + pct(peak) + '% - 2px)';   // the line ends exactly where the bar ends
    tick.style.display = peak > -58 ? 'block' : 'none';
  } };
}
const meters = new Map();   // key -> { m, get, el }
let meterRaf = 0;
let lagMax = 0;   // longest time the page's main thread was stuck, measured with a 50 ms timer
{ let t = performance.now(); setInterval(() => { const n = performance.now(); lagMax = Math.max(lagMax, Math.round(n - t - 50)); t = n; }, 50); }
function meterLoop(now) {
  meterRaf = requestAnimationFrame(meterLoop);   // once per screen refresh: 120 times a second on a 120 Hz display
  for (const x of meters.values()) { if (x.m.el.hidden || !engine.ctx) continue; const lv = x.get(); x.m.update(lv.rms, lv.peak, now); }
}
function addMeter(key, get) { const m = makeMeter(); meters.set(key, { m, get }); return m; }
if (!meterRaf) meterRaf = requestAnimationFrame(meterLoop);

// Voice detection, run on every 20 ms mic frame: tells the room who is actually speaking (as opposed to
// merely having talk switched on). The noise floor is tracked so quiet rooms and noisy rooms both work.
const vad = { floor: 0.01, on: false, run: 0, quiet: 0 };
function vadFrame(l) {
  if (!Number.isFinite(l)) return;                                  // never let a bad reading poison the noise-floor tracking
  if (!Number.isFinite(vad.floor)) vad.floor = 0.01;
  vad.floor = l < vad.floor ? l : vad.floor + (l - vad.floor) * 0.0002;
  if (l > Math.max(0.006, vad.floor * 4)) { vad.quiet = 0; if (!vad.on && ++vad.run >= 2) setSpeaking(true); }
  else { vad.run = 0; if (vad.on && ++vad.quiet >= 15) setSpeaking(false); }   // 300 ms hangover
}
function setSpeaking(on) { vad.on = on; for (const id of S.talking) send({ t: 'speak', room: id, on }); }

async function talkStart(id) {
  await engine.start(); engine.resume();
  for (const o of [...S.talking]) if (o !== id) talkStop(o);   // only ever transmit to one room
  S.talking.add(id); S.active = id; update();
  const v = await ensureMic();
  if (!v) { toast('Microphone unavailable: ' + micError); S.talking.delete(id); update(); return; }
  if (!S.talking.has(id)) return;
  v.sending = true; S.active = id;
  send({ t: 'talk', room: id, on: true });
  if (vad.on) send({ t: 'speak', room: id, on: true });
}
function talkStop(id) {
  S.talking.delete(id); S.calls.delete(id); send({ t: 'talk', room: id, on: false });
  if (!S.talking.size) stopSending();
  update();
}
function stopSending() { if (voice) voice.sending = false; }

// ----- feeds -----
function feedCard(f) {
  const live = h('span', { class: 'badge' }, 'OFFLINE'), n = h('span', { class: 'sub' });
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: prefs.feedVol[f.id] ?? 1,
    oninput: (e) => { prefs.feedVol[f.id] = +e.target.value; savePrefs(); applyVol('feed', f.id, prefs.feedVol[f.id]); } });
  // Listener controls. Hidden while this device is the sender: the server never plays a feed back to its own sender.
  const fm = addMeter('f' + f.id, () => engine.level('feed', f.id));
  const volBox = h('div', {}, h('div', { class: 'sub', style: 'margin-top:8px' }, 'Feed volume'), vol, fm.el);
  const play = h('button', { class: 'primary', onclick: async () => {
    if (S.listening.has(f.id)) { if (!prefs.feedsOff.includes(f.id)) prefs.feedsOff.push(f.id); S.listening.delete(f.id); send({ t: 'listen', feed: f.id, on: false }); engine.stopChannel('feed', f.id); }
    else { prefs.feedsOff = prefs.feedsOff.filter((x) => x !== f.id); engine.startChannel('feed', f.id); S.listening.add(f.id); send({ t: 'listen', feed: f.id, on: true }); await engine.start(); applyVol('feed', f.id, prefs.feedVol[f.id] ?? 1); }
    persist(); update();
  } });
  const src = f.source ? h('button', { onclick: () => publishDialog(f) }, 'Send from this device') : null;
  const lvl = f.source ? h('div', { hidden: true }, h('div', { class: 'sub', style: 'margin-top:8px' }, 'Send level'),
    h('input', { type: 'range', min: 0, max: 2, step: 0.01, value: prefs.feedGain, oninput: (e) => { prefs.feedGain = +e.target.value; savePrefs(); engine.captures.get('feed')?.setGain(prefs.feedGain); } })) : null;
  const el = h('section', { class: 'card' },
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, f.name), h('div', { class: 'sub' }, f.description || 'Program audio')),
      live), volBox,
    lvl, h('div', { class: 'row', style: 'margin-top:10px' }, play, src, n));
  cards.set('f' + f.id, () => {
    const p = S.presence.feeds?.[f.id] || {};
    live.textContent = p.live ? '● LIVE' : 'OFFLINE'; live.classList.toggle('live', !!p.live);
    n.textContent = `${p.n || 0} listening`;
    const on = S.listening.has(f.id);
    fm.el.hidden = !on;
    play.textContent = on ? '■ Stop listening' : '▶ Listen';
    const sending = S.publishing === f.id;
    volBox.hidden = sending; play.hidden = sending;
    if (lvl) lvl.hidden = !sending;
    if (src) { src.textContent = S.publishing === f.id ? '■ Stop sending' : 'Send from this device'; src.classList.toggle('danger', S.publishing === f.id); }
  });
  if (S.listening.has(f.id)) setTimeout(() => applyVol('feed', f.id, prefs.feedVol[f.id] ?? 1), 0);
  return el;
}

async function publishDialog(f) {
  if (S.publishing === f.id) return stopPublish();
  let devs = [];
  try { const t = await navigator.mediaDevices.getUserMedia({ audio: true }); t.getTracks().forEach((x) => x.stop()); devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); }
  catch (e) { return toast('Audio input unavailable: ' + e.message); }
  const sel = h('select', {}, devs.map((d) => h('option', { value: d.deviceId }, d.label || 'Input')));
  const close = () => sheet.remove();
  const sheet = h('div', { class: 'sheet', onclick: (e) => { if (e.target === sheet) close(); } }, h('div', {},
    h('h3', {}, `Send to “${f.name}”`),
    h('p', { class: 'sub' }, 'Sent as stereo at high quality with echo cancellation, noise suppression and auto gain OFF. A compressor and limiter even out the level and stop peaks clipping. Use a line-in or audio interface, not a phone mic. You can adjust the send level while live.'),
    h('label', { class: 'f' }, 'Input'), sel,
    h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'primary', onclick: async () => {
      close(); await startPublish(f, sel.value);
    } }, 'Start sending'), h('button', { onclick: close }, 'Cancel'))));
  document.body.append(sheet);
}
const sendStat = { last: 0, gap: 0, backlog: 0 };   // while sending a feed: longest wait between frames leaving this page, and the most data stuck behind a slow connection
async function startPublish(f, deviceId) {
  sendStat.last = 0; sendStat.gap = 0; sendStat.backlog = 0;
  S.pubDevice = deviceId;   // remembered so sending can resume by itself after the connection is replaced
  try {
    await engine.start(); engine.resume();
    send({ t: 'publish', feed: f.id, on: true });
    const ch = f.ch;
    const cap = await engine.capture('feed', { channels: 2, bitrate: 192000, application: 'audio', deviceId, gain: prefs.feedGain, ec: false, ns: false, agc: false, hpf: 0, gate: false, compressor: true,
      onLevel: (l) => setMeter(l),
      onFrame: (seq, d) => { if (!ws || ws.readyState !== 1) return;
        const tn = performance.now(); if (sendStat.last) sendStat.gap = Math.max(sendStat.gap, Math.round(tn - sendStat.last)); sendStat.last = tn; sendStat.backlog = Math.max(sendStat.backlog, ws.bufferedAmount);   // sender-side stall evidence
        const m = new Uint8Array(7 + d.length), dv = new DataView(m.buffer); dv.setUint8(0, 1); dv.setUint16(1, ch); dv.setUint32(3, seq); m.set(d, 7); ws.send(m); } });
    cap.sending = true; S.publishing = f.id; update();
  } catch (e) { send({ t: 'publish', feed: f.id, on: false }); toast('Could not start: ' + e.message); }
}
function stopPublish(fromServer) {
  const id = S.publishing; S.publishing = null;
  engine.stopCapture('feed');
  if (!fromServer && id) send({ t: 'publish', feed: id, on: false });
  update();
}

// ----- floating "who is talking" window (Picture-in-Picture) -----
// A small always-on-top window, like a video, so you can use other apps and still see who is speaking. A phone cannot
// float arbitrary buttons, only video, so the status is drawn on a canvas and shown as a video.
const PIP_FAST = 33, PIP_SLOW = 100;   // floating-window meter redraw interval (ms): about 30 a second, easing to 10 on a phone that cannot keep up
const pip = { video: null, canvas: null, bg: null, baseOk: false, ms: PIP_FAST, tickAt: 0, slow: 0, g: null, track: null, on: false, timer: 0, disp: -90, peak: -90, peakAt: 0, last: 0 };
function pipSupported() {
  return !!HTMLCanvasElement.prototype.captureStream && !!(document.pictureInPictureEnabled || HTMLVideoElement.prototype.webkitSetPresentationMode);
}
// What to show: the rooms you have joined (the ones you can hear), rooms with someone speaking first.
function pipModel() {
  const rows = S.rooms.filter((r) => S.joined.has(r.id)).map((r, i) => {
    const ms = S.presence.rooms?.[r.id] || [];
    return { id: r.id, name: r.name, color: r.color, here: ms.length, order: i, speakers: ms.filter((m) => isHot(r.id, m)).map((m) => (m.c === S.c ? 'You' : m.n)), last: lastSpoke[r.id]?.n || '' };
  });
  rows.sort((a, b) => (b.speakers.length > 0) - (a.speakers.length > 0) || a.order - b.order);
  return { live: S.rooms.filter((r) => S.talking.has(r.id)).map((r) => r.name), rows };
}
// The names, rooms and header change only on events, so they are drawn once into a spare canvas and reused; only the
// level meter is redrawn on each tick. That keeps the floating window cheap enough for slow phones.
function pipBase() {
  const g = pip.bg.getContext('2d'), W = 480, H = 270, m = pipModel();
  const fit = (t, px, maxW) => { g.font = px; if (g.measureText(t).width <= maxW) return t; while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t + '…'; };
  g.fillStyle = '#0b0d12'; g.fillRect(0, 0, W, H);
  // header: red and clear when your own mic is live
  g.fillStyle = m.live.length ? '#dc2626' : '#151922'; g.fillRect(0, 0, W, 40);
  g.textBaseline = 'middle'; g.fillStyle = m.live.length ? '#fff' : '#8a93a6'; g.font = '600 20px system-ui, sans-serif';
  g.fillText(fit(m.live.length ? '● You are live: ' + m.live.join(', ') : 'NetSpeak', g.font, W - 24), 12, 21);
  if (!m.rows.length) { g.fillStyle = '#8a93a6'; g.font = '500 24px system-ui, sans-serif'; g.fillText('Not in any room', 12, 100); }
  const maxRows = 4, rowH = 50, shown = m.rows.length > maxRows ? m.rows.slice(0, maxRows - 1) : m.rows;
  shown.forEach((r, i) => {
    const y = 48 + i * rowH, talking = r.speakers.length > 0;
    if (talking) { g.fillStyle = 'rgba(74,222,128,0.14)'; g.fillRect(0, y, W, rowH - 4); }
    g.fillStyle = r.color; g.fillRect(0, y, 8, rowH - 4);
    g.fillStyle = talking ? '#e8ecf4' : '#aab3c5'; g.font = '600 21px system-ui, sans-serif';
    g.fillText(fit(r.name, g.font, 150), 22, y + 23);
    if (talking) { g.fillStyle = '#4ade80'; g.font = '700 27px system-ui, sans-serif'; g.fillText(fit(r.speakers.join(', '), g.font, W - 190), 180, y + 23); }
    else if (r.last) { g.fillStyle = '#7d879b'; g.font = '500 20px system-ui, sans-serif'; g.fillText(fit('Last: ' + r.last, g.font, W - 190), 180, y + 23); }   // nobody speaking now: show who spoke last
    else { g.fillStyle = '#6b7487'; g.font = '500 18px system-ui, sans-serif'; g.fillText(r.here ? r.here + (r.here === 1 ? ' person here' : ' people here') : 'empty', 180, y + 23); }
  });
  if (m.rows.length > maxRows) { const rest = m.rows.length - (maxRows - 1); g.fillStyle = '#8a93a6'; g.font = '500 19px system-ui, sans-serif'; g.fillText('+' + rest + ' more room' + (rest === 1 ? '' : 's'), 22, 48 + (maxRows - 1) * rowH + 21); }
}
function pipDraw(force, tick) {
  if (!pip.on && !force) return;
  if (!pip.canvas) { pip.canvas = document.createElement('canvas'); pip.canvas.width = 480; pip.canvas.height = 270; pip.bg = document.createElement('canvas'); pip.bg.width = 480; pip.bg.height = 270; pip.baseOk = false; }
  const g = pip.g = pip.g || pip.canvas.getContext('2d'), W = 480;
  if (!tick || !pip.baseOk) { pipBase(); pip.baseOk = true; }
  g.drawImage(pip.bg, 0, 0);
  // listening level: the same colours, falling and peak line as the meters in the app
  {
    const now = performance.now(), lv = engine.ctx ? engine.masterLevel() : { rms: -90, peak: -90 }, dt = pip.last ? Math.min(0.5, (now - pip.last) / 1000) : 0.1; pip.last = now;
    pip.disp = Math.max(Number.isFinite(lv.rms) ? lv.rms : -90, pip.disp - 28 * dt);
    if (pip.disp > pip.peak) { pip.peak = pip.disp; pip.peakAt = now; } else if (now - pip.peakAt > 1000) pip.peak = Math.max(pip.disp, pip.peak - 20 * dt);
    const x = 96, w = W - 12 - x, y = 254, pct = (db) => Math.max(0, Math.min(1, (db + 60) / 60));
    g.fillStyle = '#8a93a6'; g.font = '500 15px system-ui, sans-serif'; g.fillText('Listening', 12, y + 5);
    g.fillStyle = '#1c2230'; g.fillRect(x, y, w, 10);
    const lit = Math.round(w * pct(pip.disp));
    for (const [from, to, col] of [[0, .5, '#22c55e'], [.5, .65, '#eab308'], [.65, .8, '#f97316'], [.8, 1, '#ef4444']]) {
      const a = Math.round(w * from), b = Math.min(lit, Math.round(w * to)); if (b > a) { g.fillStyle = col; g.fillRect(x + a, y, b - a, 10); }
    }
    if (pip.peak > -58) { g.fillStyle = '#fff'; g.fillRect(x + Math.max(0, Math.min(w, Math.round(w * pct(pip.peak))) - 2), y, 2, 10); }
  }
  if (pip.track && pip.track.requestFrame) pip.track.requestFrame();   // push the new picture out at once
}
// While the window is open the level meter needs a steady redraw (the rest of the picture only changes on events).
function pipOn(on) {
  pip.on = on; clearTimeout(pip.timer); pip.timer = 0;
  if (!on) return;
  pip.ms = PIP_FAST; pip.slow = 0; pip.tickAt = 0; pip.baseOk = false; pipDraw();
  const loop = () => {
    const t = performance.now();
    // If ticks keep arriving much later than asked, the phone is struggling: draw less often rather than lag behind.
    if (pip.tickAt) { if (t - pip.tickAt > pip.ms * 1.8) { if (++pip.slow >= 8 && pip.ms < PIP_SLOW) { pip.ms = PIP_SLOW; } } else if (pip.slow > 0) pip.slow--; }
    pip.tickAt = t;
    pipDraw(false, true);
    pip.timer = setTimeout(loop, pip.ms);
  };
  pip.timer = setTimeout(loop, pip.ms);
}
async function pipToggle() {
  try {
    if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }
    if (pip.video && pip.video.webkitPresentationMode === 'picture-in-picture') { pip.video.webkitSetPresentationMode('inline'); return; }
    if (!pipSupported()) return toast('A floating window is not supported by this browser.');
    if (!pip.video) {
      pipDraw(true);
      const stream = pip.canvas.captureStream(30);
      pip.track = stream.getVideoTracks()[0];
      const v = pip.video = document.createElement('video');
      v.muted = true; v.playsInline = true; v.srcObject = stream;
      v.width = 480; v.height = 270;   // 16:9, the same shape as the picture, in case the browser sizes the window from the element
      v.style.cssText = 'position:fixed;left:0;bottom:0;width:32px;height:18px;opacity:0;pointer-events:none';
      v.addEventListener('enterpictureinpicture', () => pipOn(true));
      v.addEventListener('leavepictureinpicture', () => pipOn(false));
      v.addEventListener('webkitpresentationmodechanged', () => pipOn(v.webkitPresentationMode === 'picture-in-picture'));
      document.body.append(v);
    }
    pipOn(true); pipDraw(true);
    await pip.video.play();
    if (pip.video.requestPictureInPicture) await pip.video.requestPictureInPicture(); else pip.video.webkitSetPresentationMode('picture-in-picture');
  } catch (e) { pipOn(false); toast('Could not open the floating window: ' + e.message); }
}

// ----- settings -----
async function settings() {
  let ins = [], outs = [];
  try { const all = await navigator.mediaDevices.enumerateDevices(); ins = all.filter((d) => d.kind === 'audioinput'); outs = all.filter((d) => d.kind === 'audiooutput'); } catch {}
  const labeled = ins.some((d) => d.label);
  const opt = (d, sel) => h('option', { value: d.deviceId, selected: d.deviceId === sel }, d.label || 'Default');
  const mic = h('select', { onchange: (e) => { prefs.micId = e.target.value; savePrefs(); reopenMic(); } }, h('option', { value: '' }, 'System default'), ins.filter((d) => d.deviceId && d.deviceId !== 'default').map((d) => opt(d, prefs.micId)));
  const spk = h('select', { onchange: (e) => { prefs.spkId = e.target.value; savePrefs(); engine.setSink(prefs.spkId); } }, h('option', { value: '' }, 'System default'), outs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d) => opt(d, prefs.spkId)));
  const chk = (label, key, fn) => h('label', { class: 'row', style: 'margin:12px 0' }, h('label', { class: 'sw' }, h('input', { type: 'checkbox', checked: !!prefs[key], onchange: (e) => { prefs[key] = e.target.checked; savePrefs(); fn?.(); } }), h('i')), h('span', { class: 'grow' }, label));
  const diag = h('pre', { style: 'white-space:pre-wrap' });
  const tick = () => {
    const st = engine.stats, v = engine.captures.get('voice');
    diag.textContent = [
      `connection:   ${S.connected ? 'online' : 'OFFLINE'}`,
      `codec:        ${supported ? 'WebCodecs Opus OK' : 'NOT SUPPORTED in this browser'}`,
      `audio engine: ${engine.ctx ? engine.ctx.state : 'not started'}${engine.el?.paused ? ' (output paused)' : ''}`,
      `microphone:   ${v ? (v.track?.readyState + ' / ' + (v.track?.label || '?') + (v.track?.muted ? ' (MUTED by OS)' : '')) : 'closed'}`,
      `joined rooms: ${S.rooms.filter((r) => S.joined.has(r.id)).map((r) => r.name + (r.talk ? '' : ' (listen only)')).join(', ') || 'none'}`,
      `talking in:   ${S.rooms.filter((r) => S.talking.has(r.id)).map((r) => r.name).join(', ') || 'nobody'}`,
      `echo cancel:  ${engine.aecOff ? 'OFF: this device was too busy' : S.aecDb === undefined ? 'waiting for sound to learn from' : S.aecDb > 6 ? 'working, removing about ' + S.aecDb + ' dB of echo' : 'learning (' + S.aecDb + ' dB so far)'}`,
      `feedback:     ${S.fb ? `${S.fb.notches} tone(s) cut, send level ${S.fb.guardDb.toFixed(0)} dB` : 'none detected'}`,
      `feed sync:    ${engine.clock.ready ? `clock within ±${engine.clock.uncertaintyMs.toFixed(0)} ms of the server` : 'measuring…'} · plays ${engine.feedDelayMs} ms after server stamp · ${st.syncDrops} late chunks skipped`,
      S.publishing && `sending:      longest gap between frames leaving this page ${sendStat.gap} ms · most data waiting to upload ${Math.round(sendStat.backlog / 1024)} KB`,
      `feed health:  buffer ran dry ${[...engine.voices.values()].reduce((a, v) => a + (v.sp ? v.sp.stats.dry : 0), 0)}x (worst ${Math.max(0, ...[...engine.voices.values()].map((v) => v.sp ? v.sp.stats.dryMaxMs : 0))} ms) · longest gap between packets ${st.gapMax || 0} ms · longest page stall ${lagMax} ms`,
      `packets sent: ${st.tx}   received: ${st.rx}${st.rx ? ' (' + Math.round((performance.now() - st.rxLast) / 1000) + 's ago)' : ''}   decode errors: ${st.decodeErr}`,
    ].filter(Boolean).join('\n');
  };
  tick(); const dt = setInterval(tick, 500);
  const close = () => { clearInterval(dt); sheet.remove(); };
  const sheet = h('div', { class: 'sheet', onclick: (e) => { if (e.target === sheet) close(); } }, h('div', {},
    h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Settings'), h('button', { class: 'ghost', onclick: close }, '✕')),
    h('h2', {}, 'Microphone'),
    h('label', { class: 'f' }, 'Input device' + (labeled ? '' : ' (talk once to list names)')), mic,
    h('h2', {}, 'Listening'),
    outs.length && h('div', {}, h('label', { class: 'f' }, 'Output device'), spk),
    chk('Keep screen on', 'wake', setWake),
    h('p', { class: 'sub' }, 'Earbud button: click toggles talk (latched) in the active room (next-track switches room). Audio keeps playing with the screen off. For the best background behaviour install the app (Add to Home Screen) and keep it in the recent apps list.'),
    h('h2', {}, 'Diagnostics'), diag,
    h('h2', {}, 'Account'),
    h('button', { onclick: () => location.reload() }, 'Reload app'),
    h('button', { class: 'danger', style: 'margin-left:8px', onclick: async () => { await api('POST', '/api/logout'); location.href = '/'; } }, 'Sign out')));
  document.body.append(sheet);
}
async function reopenMic() { if (voice) { const was = voice.sending; await closeMic(); const v = await ensureMic(); if (v) v.sending = was; } }

// ----- background / lock-screen niceties -----
function updateMediaSession() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch {}
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: 'Intercom live', artist: 'NetSpeak', artwork: [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }] });
  navigator.mediaSession.playbackState = 'playing';
  const on = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch {} };
  // Earbud click arrives as play/pause: use it as a latch-talk toggle.
  on('pause', earbudToggle); on('play', () => { engine.resume(); earbudToggle(); });
  on('enterpictureinpicture', () => pipToggle());   // browsers that offer it when you leave while on a call
  on('togglemicrophone', earbudToggle); on('hangup', () => { for (const id of [...S.talking]) talkStop(id); });
  on('nexttrack', () => { const t = S.rooms.filter((r) => S.joined.has(r.id)); if (t.length) { S.active = t[(t.findIndex((r) => r.id === S.active) + 1) % t.length].id; toast('Active room: ' + t.find((r) => r.id === S.active).name); } });
  try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch {}
}
let pocket = false;
async function setWake() {
  try {
    const want = prefs.wake || pocket;
    if (want && document.visibilityState === 'visible' && 'wakeLock' in navigator) {
      if (wakeLock && !wakeLock.released) return;
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { if (document.visibilityState === 'visible') setWake(); });
    } else if (!want && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}

// Black full-screen overlay: screen stays awake, OLED draws almost nothing, touches are ignored
// until a deliberate 1.5 s press-and-hold. Audio and talking keep running underneath.
function pocketLock() {
  if (pocket) return;
  pocket = true; setWake();
  if (!('wakeLock' in navigator)) toast('This browser cannot keep the screen awake; the lock still blocks touches.');
  const bar = h('i', { style: 'display:block;height:4px;width:0;background:#4ade80;border-radius:2px;transition:width 1.5s linear' });
  const o = h('div', { style: 'position:fixed;inset:0;background:#000;z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#444;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none' },
    h('div', {}, 'Locked · hold to unlock'), h('div', { style: 'width:160px;margin-top:14px' }, bar));
  let t = null;
  const stop = () => { clearTimeout(t); bar.style.transition = 'none'; bar.style.width = '0'; };
  o.addEventListener('pointerdown', (e) => { e.preventDefault(); bar.style.transition = 'width 0.75s linear'; bar.style.width = '100%'; t = setTimeout(() => { o.remove(); pocket = false; setWake(); }, 750); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) o.addEventListener(ev, stop);
  o.addEventListener('contextmenu', (e) => e.preventDefault());
  document.body.append(o);
}

window.netspeak = { engine, S, prefs, recover: (ms) => recover(ms), setMeter, pip: { model: () => pipModel(), draw: () => pipDraw(true), tick: () => pipDraw(false, true), state: () => ({ ms: pip.ms }), canvas: () => pip.canvas } };
boot();
