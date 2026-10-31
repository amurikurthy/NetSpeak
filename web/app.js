import { Engine, PRESETS, supported } from './audio.js';

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
const defaults = { preset: 'phone', micId: '', spkId: '', micGain: 1, master: 1, duck: 0.4, wake: false, micOpen: false,
  gateDb: -52, roomVol: {}, feedVol: {}, joined: [], listening: [], feedBuf: 0.25, autoJoin: true, autoFeeds: true, left: [], feedsOff: [] };
export const prefs = (() => { try { return { ...defaults, ...JSON.parse(localStorage.getItem('ns.prefs') || '{}') }; } catch { return { ...defaults }; } })();
export const savePrefs = () => { try { localStorage.setItem('ns.prefs', JSON.stringify(prefs)); } catch {} };

// ---------- state ----------
const S = { me: null, rooms: [], feeds: [], presence: { rooms: {}, feeds: {} }, joined: new Set(), talking: new Set(),
  listening: new Set(), calls: new Set(), active: null, publishing: null, connected: false, c: 0 };
const engine = new Engine();
let ws = null, wsTimer = null, backoff = 500, lastRx = 0, pingTimer = null, lingerTimer = null, voice = null, wakeLock = null;
let installEvt = null;
const root = $('#app');

addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });
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
  ui.rooms = h('div'); ui.feeds = h('div'); ui.warn = h('div');
  ui.audio = h('div', { class: 'warn', hidden: true, style: 'cursor:pointer;font-weight:600', onclick: () => enableAudio() }, '🔇 Audio is off: tap here to start listening');
  ui.mic = h('b'); ui.micRow = h('div', { class: 'meter' }, ui.mic);
  const mv = h('input', { type: 'range', min: 0, max: 2, step: 0.01, value: prefs.micGain, oninput: (e) => { prefs.micGain = +e.target.value; savePrefs(); voice?.setGain(prefs.micGain); } });
  const lv = h('input', { type: 'range', min: 0, max: 1.5, step: 0.01, value: prefs.master, oninput: (e) => { prefs.master = +e.target.value; savePrefs(); engine.setMaster(prefs.master); } });
  engine.vol.master = prefs.master; engine.duck = prefs.duck; engine.jitter.feed = prefs.feedBuf;
  root.replaceChildren(
    h('div', { class: 'top' }, h('div', { class: 'brand' }, ui.dot, 'NetSpeak'),
      S.me.role === 'admin' && h('button', { class: 'ghost', onclick: () => { location.hash = '#admin'; } }, 'Admin'),
      h('button', { class: 'ghost', onclick: pocketLock }, '🔒 Pocket lock'),
      h('button', { class: 'ghost', onclick: settings }, '⚙ Settings')),
    h('div', { class: 'wrap' }, ui.warn, ui.audio, h('h2', {}, 'Rooms'), ui.rooms, h('h2', {}, 'Program feeds'), ui.feeds),
    h('div', { class: 'bar' }, h('div', { class: 'in' },
      h('div', {}, h('label', {}, h('span', {}, 'Listening volume')), lv),
      h('div', {}, h('label', {}, h('span', {}, 'Microphone volume')), mv, ui.micRow))));
  if (!supported) ui.warn.append(h('div', { class: 'warn' }, 'This browser lacks WebCodecs audio. Use a current Chrome, Edge, Firefox or Safari 26+.'));
  if (!window.isSecureContext) ui.warn.append(h('div', { class: 'warn' }, 'Microphone needs HTTPS. Open this page over https://.'));
  connect();
  updateMediaSession();
  setWake();
}

function connect() {
  clearTimeout(wsTimer);
  if (ws) { ws.onclose = null; try { ws.close(); } catch {} }
  const w = ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  w.binaryType = 'arraybuffer';
  w.onopen = () => { backoff = 500; lastRx = Date.now(); setConn(true); };
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
const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
function setConn(on) { S.connected = on; ui.dot?.classList.toggle('on', on); }

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  engine.resume(); setWake();
  if (S.me && (!ws || ws.readyState > 1)) connect();
});

function onMsg(m) {
  switch (m.t) {
    case 'state': {
      const rooms = m.rooms || [], feeds = m.feeds || [];   // a user with no access gets empty lists, never null
      S.rooms = rooms; S.feeds = feeds; S.c = m.you.c; S.me = { ...S.me, displayName: m.you.name, role: m.you.role };
      engine.registerChannels(rooms, feeds);
      const ids = new Set(rooms.map((r) => r.id)), fids = new Set(feeds.map((f) => f.id));
      // Rooms: remembered ones, plus (by default) every room this user can hear except those they left on purpose.
      for (const id of prefs.joined) if (ids.has(id)) S.joined.add(id);
      if (prefs.autoJoin) for (const id of ids) if (!prefs.left.includes(id)) S.joined.add(id);
      for (const id of [...S.joined]) { if (ids.has(id)) send({ t: 'join', room: id }); else S.joined.delete(id); }
      for (const id of prefs.listening) if (fids.has(id)) S.listening.add(id);
      if (prefs.autoFeeds) for (const f of feeds) if (f.listen && !prefs.feedsOff.includes(f.id)) S.listening.add(f.id);
      for (const id of [...S.listening]) { if (fids.has(id)) send({ t: 'listen', feed: id, on: true }); else S.listening.delete(id); }
      // Drop anything that was deleted or lost its permission while we were using it.
      for (const id of [...S.talking]) { const r = rooms.find((x) => x.id === id); if (!r || !r.talk || !S.joined.has(id)) talkStop(id); }
      for (const id of [...S.calls]) if (!S.joined.has(id)) S.calls.delete(id);
      if (S.active && !ids.has(S.active)) S.active = null;
      if (S.publishing && !fids.has(S.publishing)) stopPublish(false);
      persist();
      render();
      for (const id of [...S.calls]) { if (!S.talking.has(id)) talkStart(id); }
      if (S.joined.size || S.listening.size) enableAudio();   // starts at once where the browser allows it
      break;
    }
    case 'presence': S.presence = m; update(); break;
    case 'publish': if (!m.on && S.publishing === m.feed) stopPublish(true); break;
    case 'error': toast(m.msg); break;
    case 'kicked': toast('Your access was removed'); break;
  }
}

function render() {
  const s = JSON.stringify([S.rooms, S.feeds]);
  if (s === sig) return update();
  sig = s; cards.clear();
  ui.rooms.replaceChildren(...(S.rooms.length ? S.rooms.map(roomCard) : [h('p', { class: 'sub' }, 'No rooms available to you yet. Ask an admin for access.')]));
  ui.feeds.replaceChildren(...(S.feeds.length ? S.feeds.map(feedCard) : [h('p', { class: 'sub' }, 'No program feeds available.')]));
  update();
}

function update() { for (const c of cards.values()) c(); audioBanner(); }

// Browsers only start audio after a tap/click. Rooms remembered from a previous visit are re-joined
// automatically, so without this the room looks joined while nothing is actually playing.
function audioNeeded() {
  return (S.joined.size > 0 || S.listening.size > 0) && (!engine.ctx || engine.ctx.state !== 'running' || engine.el?.paused);
}
engine.onState = () => audioBanner();
function audioBanner() { if (ui.audio) ui.audio.hidden = !audioNeeded(); }
async function enableAudio() {
  try {
    await engine.start(); await engine.resume();
    for (const id of S.joined) applyVol('room', id, prefs.roomVol[id] ?? 1);
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
  const vol = h('input', { type: 'range', min: 0, max: 1.5, step: 0.01, value: prefs.roomVol[r.id] ?? 1,
    oninput: (e) => { prefs.roomVol[r.id] = +e.target.value; savePrefs(); applyVol('room', r.id, prefs.roomVol[r.id]); } });
  const sw = h('input', { type: 'checkbox', onchange: async (e) => {
    if (e.target.checked) { prefs.left = prefs.left.filter((x) => x !== r.id); S.joined.add(r.id); send({ t: 'join', room: r.id }); await engine.start(); applyVol('room', r.id, prefs.roomVol[r.id] ?? 1); }
    else { if (!prefs.left.includes(r.id)) prefs.left.push(r.id); if (S.talking.has(r.id)) talkStop(r.id); S.joined.delete(r.id); send({ t: 'leave', room: r.id }); }
    persist(); update();
  } });
  const btn = r.talk ? talkButton(r) : null;
  const call = r.talk ? h('button', { style: 'width:100%;margin-top:8px', onclick: () => toggleCall(r.id) }) : null;
  const el = h('section', { class: 'card room', style: `--c:${r.color}` },
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, r.name), h('div', { class: 'sub' }, r.talk ? 'Listen & talk' : 'Listen only')),
      h('label', { class: 'sw' }, sw, h('i'))),
    chips, h('div', { class: 'sub' }, 'Room volume'), vol, btn, call);
  cards.set(r.id, () => {
    const on = S.joined.has(r.id);
    sw.checked = on; el.classList.toggle('joined', on);
    const ms = S.presence.rooms?.[r.id] || [];
    chips.replaceChildren(...(on ? ms.map((m) => h('span', { class: 'chip' + (m.t ? ' talk' : '') }, m.n + (m.c === S.c ? ' (you)' : ''))) : [h('span', { class: 'sub' }, `${ms.length} in room`)]));
    if (call) { call.hidden = !on; const c = S.calls.has(r.id); call.textContent = c ? '📞 In call: tap to hang up' : '📞 Hands-free call mode'; call.classList.toggle('primary', c); }
    if (btn) { btn.hidden = !on; btn.classList.toggle('on', S.talking.has(r.id)); btn._label(); }
  });
  if (S.joined.has(r.id)) setTimeout(() => applyVol('room', r.id, prefs.roomVol[r.id] ?? 1), 0);
  return el;
}

function applyVol(kind, id, v) { if (engine.ctx) engine.setVolume(kind, id, v); }

function talkButton(r) {
  const b = h('button', { class: 'talk-btn', oncontextmenu: (e) => e.preventDefault() });
  let downAt = 0, latched = false;
  b._label = () => { const on = S.talking.has(r.id); b.replaceChildren(on ? (latched ? 'TALKING' : 'TALKING') : 'HOLD TO TALK',
    h('small', {}, on ? (latched ? 'tap to stop' : 'release to stop') : (r.pttOnly ? 'push-to-talk only' : 'tap to latch'))); };
  b.addEventListener('pointerdown', async (e) => {
    e.preventDefault(); b.setPointerCapture(e.pointerId);
    if (S.talking.has(r.id)) { latched = false; return talkStop(r.id); }
    downAt = Date.now(); latched = false; await talkStart(r.id);
  });
  const up = () => {
    if (!S.talking.has(r.id) || !downAt) return;
    const held = Date.now() - downAt; downAt = 0;
    if (held < 350 && !r.pttOnly) { latched = true; b._label(); } else talkStop(r.id);
  };
  b.addEventListener('pointerup', up); b.addEventListener('pointercancel', () => { downAt = 0; if (!latched) talkStop(r.id); });
  b.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat) { e.preventDefault(); S.talking.has(r.id) ? talkStop(r.id) : talkStart(r.id); } });
  return b;
}

function toggleCall(id) {
  if (S.calls.has(id)) return talkStop(id);
  S.calls.add(id); S.active = id; talkStart(id);
}
// Earbud / headset button: toggles hands-free talk in the active room.
function earbudToggle() {
  const talkable = S.rooms.filter((r) => r.talk && S.joined.has(r.id));
  const id = (S.active && talkable.find((r) => r.id === S.active)?.id) || talkable[0]?.id;
  if (!id) return toast('Join a room first');
  if (S.talking.has(id)) { talkStop(id); toast('Mic off'); } else { toggleCall(id); toast('Mic on'); }
}

// ----- mic / talking -----
function micOpts() {
  const p = PRESETS[prefs.preset] || PRESETS.phone;
  return { channels: 1, bitrate: 32000, application: 'voip', deviceId: prefs.micId, gain: prefs.micGain,
    ec: p.ec, ns: p.ns, agc: p.agc, hpf: p.hpf, gate: p.gate || S.calls.size > 0, gateDb: prefs.gateDb,
    onLevel: (l) => { if (ui.mic) ui.mic.style.width = Math.min(100, Math.sqrt(l) * 160) + '%'; },
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

async function ensureMic() {
  clearTimeout(lingerTimer);
  if (voice) return voice;
  try { voice = await engine.capture('voice', micOpts()); }
  catch (e) { toast('Microphone unavailable: ' + (e.name === 'NotAllowedError' ? 'permission denied' : e.message)); return null; }
  return voice;
}
function releaseMic() {
  clearTimeout(lingerTimer);
  if (prefs.micOpen || S.talking.size) return;
  lingerTimer = setTimeout(() => { if (!S.talking.size && !prefs.micOpen) { engine.stopCapture('voice'); voice = null; if (ui.mic) ui.mic.style.width = 0; } }, 8000);
}
async function talkStart(id) {
  await engine.start(); engine.resume();
  S.talking.add(id); update();
  const v = await ensureMic();
  if (!v || !S.talking.has(id)) { if (!v) { S.talking.delete(id); update(); } return; }
  engine.talkingNow = true; v.sending = true; S.active = id; applyGate();
  const tx0 = engine.stats.tx;
  setTimeout(() => { if (S.talking.has(id) && engine.stats.tx === tx0) toast('Mic is open but no sound is being sent: speak up, or lower the noise gate / pick "Headset" in Settings'); }, 2500);
  send({ t: 'talk', room: id, on: true });
}
function talkStop(id) {
  S.talking.delete(id); S.calls.delete(id); applyGate(); send({ t: 'talk', room: id, on: false });
  if (!S.talking.size) stopSending();
  update(); releaseMic();
}
function applyGate() { voice?.setGate((PRESETS[prefs.preset] || PRESETS.phone).gate || S.calls.size > 0, prefs.gateDb); }
function stopSending() { engine.talkingNow = false; if (voice) voice.sending = false; releaseMic(); }

// ----- feeds -----
function feedCard(f) {
  const live = h('span', { class: 'badge' }, 'OFFLINE'), n = h('span', { class: 'sub' });
  const vol = h('input', { type: 'range', min: 0, max: 1.5, step: 0.01, value: prefs.feedVol[f.id] ?? 1,
    oninput: (e) => { prefs.feedVol[f.id] = +e.target.value; savePrefs(); applyVol('feed', f.id, prefs.feedVol[f.id]); } });
  const play = h('button', { class: 'primary', onclick: async () => {
    if (S.listening.has(f.id)) { if (!prefs.feedsOff.includes(f.id)) prefs.feedsOff.push(f.id); S.listening.delete(f.id); send({ t: 'listen', feed: f.id, on: false }); }
    else { prefs.feedsOff = prefs.feedsOff.filter((x) => x !== f.id); S.listening.add(f.id); send({ t: 'listen', feed: f.id, on: true }); await engine.start(); applyVol('feed', f.id, prefs.feedVol[f.id] ?? 1); }
    persist(); update();
  } });
  const src = f.source ? h('button', { onclick: () => publishDialog(f) }, 'Send from this device') : null;
  const el = h('section', { class: 'card' },
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, f.name), h('div', { class: 'sub' }, f.description || 'Clean program audio, no processing')),
      live), h('div', { class: 'sub', style: 'margin-top:8px' }, 'Feed volume'), vol,
    h('div', { class: 'row', style: 'margin-top:10px' }, play, src, n));
  cards.set('f' + f.id, () => {
    const p = S.presence.feeds?.[f.id] || {};
    live.textContent = p.live ? '● LIVE' : 'OFFLINE'; live.classList.toggle('live', !!p.live);
    n.textContent = `${p.n || 0} listening`;
    const on = S.listening.has(f.id);
    play.textContent = on ? '■ Stop listening' : '▶ Listen';
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
  const br = h('select', {}, [['128000', '128 kbps'], ['192000', '192 kbps (recommended)'], ['256000', '256 kbps']].map(([v, l]) => h('option', { value: v, selected: v === '192000' }, l)));
  const close = () => sheet.remove();
  const sheet = h('div', { class: 'sheet', onclick: (e) => { if (e.target === sheet) close(); } }, h('div', {},
    h('h3', {}, `Send to “${f.name}”`),
    h('p', { class: 'sub' }, 'Captured as stereo with echo cancellation, noise suppression and auto gain all OFF, so the audio goes out exactly as your interface delivers it. Use a line-in or audio interface, not a phone mic.'),
    h('label', { class: 'f' }, 'Input'), sel, h('label', { class: 'f' }, 'Opus bitrate'), br,
    h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'primary', onclick: async () => {
      close(); await startPublish(f, sel.value, +br.value);
    } }, 'Start sending'), h('button', { onclick: close }, 'Cancel'))));
  document.body.append(sheet);
}
async function startPublish(f, deviceId, bitrate) {
  try {
    await engine.start(); engine.resume();
    send({ t: 'publish', feed: f.id, on: true });
    const ch = f.ch;
    const cap = await engine.capture('feed', { channels: 2, bitrate, application: 'audio', deviceId, gain: 1, ec: false, ns: false, agc: false, hpf: 0, gate: false,
      onLevel: (l) => { if (ui.mic) ui.mic.style.width = Math.min(100, Math.sqrt(l) * 160) + '%'; },
      onFrame: (seq, d) => { if (!ws || ws.readyState !== 1) return; const m = new Uint8Array(7 + d.length), dv = new DataView(m.buffer); dv.setUint8(0, 1); dv.setUint16(1, ch); dv.setUint32(3, seq); m.set(d, 7); ws.send(m); } });
    cap.sending = true; S.publishing = f.id; update();
  } catch (e) { send({ t: 'publish', feed: f.id, on: false }); toast('Could not start: ' + e.message); }
}
function stopPublish(fromServer) {
  const id = S.publishing; S.publishing = null;
  engine.stopCapture('feed');
  if (!fromServer && id) send({ t: 'publish', feed: id, on: false });
  update();
}

// ----- settings -----
async function settings() {
  let ins = [], outs = [];
  try { const all = await navigator.mediaDevices.enumerateDevices(); ins = all.filter((d) => d.kind === 'audioinput'); outs = all.filter((d) => d.kind === 'audiooutput'); } catch {}
  const labeled = ins.some((d) => d.label);
  const opt = (d, sel) => h('option', { value: d.deviceId, selected: d.deviceId === sel }, d.label || 'Default');
  const preset = h('select', { onchange: (e) => { prefs.preset = e.target.value; savePrefs(); reopenMic(); } },
    Object.entries(PRESETS).map(([k, p]) => h('option', { value: k, selected: k === prefs.preset }, p.label)));
  const mic = h('select', { onchange: (e) => { prefs.micId = e.target.value; savePrefs(); reopenMic(); } }, h('option', { value: '' }, 'System default'), ins.filter((d) => d.deviceId && d.deviceId !== 'default').map((d) => opt(d, prefs.micId)));
  const spk = h('select', { onchange: (e) => { prefs.spkId = e.target.value; savePrefs(); engine.setSink(prefs.spkId); } }, h('option', { value: '' }, 'System default'), outs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d) => opt(d, prefs.spkId)));
  const gate = h('input', { type: 'range', min: -75, max: -25, step: 1, value: prefs.gateDb, oninput: (e) => { prefs.gateDb = +e.target.value; savePrefs(); voice?.setGate(PRESETS[prefs.preset].gate, prefs.gateDb); } });
  const duck = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: prefs.duck, oninput: (e) => { prefs.duck = +e.target.value; engine.duck = prefs.duck; savePrefs(); } });
  const buf = h('input', { type: 'range', min: 0.1, max: 1, step: 0.05, value: prefs.feedBuf, oninput: (e) => { prefs.feedBuf = +e.target.value; engine.jitter.feed = prefs.feedBuf; savePrefs(); } });
  const chk = (label, key, fn) => h('label', { class: 'row', style: 'margin:12px 0' }, h('label', { class: 'sw' }, h('input', { type: 'checkbox', checked: !!prefs[key], onchange: (e) => { prefs[key] = e.target.checked; savePrefs(); fn?.(); } }), h('i')), h('span', { class: 'grow' }, label));
  const name = h('input', { type: 'text', value: S.me.displayName, maxlength: 40 });
  const testBtn = h('button', { onclick: async () => { if (!await ensureMic()) return; testBtn.textContent = 'Mic open: speak and watch the meter'; releaseMic(); } }, 'Test microphone');
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
      `packets sent: ${st.tx}   received: ${st.rx}${st.rx ? ' (' + Math.round((performance.now() - st.rxLast) / 1000) + 's ago)' : ''}   decode errors: ${st.decodeErr}`,
    ].join('\n');
  };
  tick(); const dt = setInterval(tick, 500);
  const close = () => { clearInterval(dt); sheet.remove(); };
  const sheet = h('div', { class: 'sheet', onclick: (e) => { if (e.target === sheet) close(); } }, h('div', {},
    h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Settings'), h('button', { class: 'ghost', onclick: close }, '✕')),
    h('label', { class: 'f' }, 'Your name'), h('div', { class: 'row' }, name, h('button', { onclick: async () => { try { S.me = await api('POST', '/api/me', { displayName: name.value }); toast('Saved'); location.reload(); } catch (e) { toast(e.message); } } }, 'Save')),
    h('h2', {}, 'Microphone'),
    h('label', { class: 'f' }, 'Noise handling'), preset,
    h('p', { class: 'sub' }, 'Phone / noisy: echo cancel, noise suppression, auto gain, low-cut and a noise gate that stops sending when you are silent. Headset: echo cancel + noise suppression. Raw: nothing.'),
    h('label', { class: 'f' }, `Noise gate threshold (Phone preset)`), gate,
    h('label', { class: 'f' }, 'Input device' + (labeled ? '' : ' (talk once to list names)')), mic, h('div', { style: 'margin-top:10px' }, testBtn),
    chk('Keep microphone open between talks (faster push-to-talk)', 'micOpen', () => { micOpenChanged(); }),
    h('h2', {}, 'Listening'),
    outs.length && h('div', {}, h('label', { class: 'f' }, 'Output device'), spk),
    h('label', { class: 'f' }, 'Lower program while people talk'), duck,
    h('label', { class: 'f' }, 'Program buffer (higher = more robust on bad networks)'), buf,
    chk('Join all my rooms automatically', 'autoJoin', () => { if (prefs.autoJoin && S.connected) { prefs.left = []; ws.close(); } }),
    chk('Listen to program feeds automatically', 'autoFeeds', () => { if (prefs.autoFeeds && S.connected) { prefs.feedsOff = []; ws.close(); } }),
    chk('Keep screen on', 'wake', setWake),
    h('p', { class: 'sub' }, 'Earbud button: click toggles hands-free talk in the active room (next-track switches room). Audio keeps playing with the screen off. For the best background behaviour install the app (Add to Home Screen) and keep it in the recent apps list.'),
    h('h2', {}, 'Diagnostics'), diag,
    h('h2', {}, 'Account'),
    h('button', { onclick: changePassword }, 'Change password'),
    installEvt && h('button', { style: 'margin-left:8px', onclick: () => { installEvt.prompt(); } }, 'Install app'),
    h('button', { class: 'danger', style: 'margin-left:8px', onclick: async () => { await api('POST', '/api/logout'); location.href = '/'; } }, 'Sign out')));
  document.body.append(sheet);
}
function micOpenChanged() { if (prefs.micOpen) ensureMic(); else releaseMic(); }
async function reopenMic() { if (voice) { const was = voice.sending; await engine.stopCapture('voice'); voice = null; if (was || prefs.micOpen) { const v = await ensureMic(); if (v) v.sending = was; } } }
function changePassword() {
  const o = h('input', { type: 'password', autocomplete: 'current-password' }), n = h('input', { type: 'password', autocomplete: 'new-password' });
  const close = () => sheet.remove();
  const sheet = h('div', { class: 'sheet', onclick: (e) => { if (e.target === sheet) close(); } }, h('div', {},
    h('h3', {}, 'Change password'), h('label', { class: 'f' }, 'Current password'), o, h('label', { class: 'f' }, 'New password'), n,
    h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'primary', onclick: async () => { try { await api('POST', '/api/me', { oldPassword: o.value, newPassword: n.value }); toast('Password changed'); close(); } catch (e) { toast(e.message); } } }, 'Change'), h('button', { onclick: close }, 'Cancel'))));
  document.body.append(sheet);
}

// ----- background / lock-screen niceties -----
function updateMediaSession() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch {}
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: 'Intercom live', artist: 'NetSpeak', artwork: [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }] });
  navigator.mediaSession.playbackState = 'playing';
  const on = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch {} };
  // Earbud click arrives as play/pause: use it as a hands-free talk toggle.
  on('pause', earbudToggle); on('play', () => { engine.resume(); earbudToggle(); });
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
// until a deliberate 1.5 s press-and-hold. Audio, talking and call mode keep running underneath.
function pocketLock() {
  if (pocket) return;
  pocket = true; setWake();
  if (!('wakeLock' in navigator)) toast('This browser cannot keep the screen awake; the lock still blocks touches.');
  const bar = h('i', { style: 'display:block;height:4px;width:0;background:#4ade80;border-radius:2px;transition:width 1.5s linear' });
  const o = h('div', { style: 'position:fixed;inset:0;background:#000;z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#444;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none' },
    h('div', {}, 'Locked · hold to unlock'), h('div', { style: 'width:160px;margin-top:14px' }, bar));
  let t = null;
  const stop = () => { clearTimeout(t); bar.style.transition = 'none'; bar.style.width = '0'; };
  o.addEventListener('pointerdown', (e) => { e.preventDefault(); bar.style.transition = 'width 1.5s linear'; bar.style.width = '100%'; t = setTimeout(() => { o.remove(); pocket = false; setWake(); }, 1500); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) o.addEventListener(ev, stop);
  o.addEventListener('contextmenu', (e) => e.preventDefault());
  document.body.append(o);
}

window.netspeak = { engine, S, prefs };
boot();
