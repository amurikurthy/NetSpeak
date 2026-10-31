import { h, api, toast } from './app.js';

const state = { tab: 'users', data: null };
let rootEl, ctx;

export async function adminView(root, c) {
  rootEl = root; ctx = c;
  await load();
}
async function load() {
  try { state.data = await api('GET', '/api/admin/state'); } catch (e) { toast(e.message); return; }
  draw();
}
const D = () => state.data;
const gname = (id) => D().groups.find((g) => g.id === id)?.name || '?';
const tabs = ['users', 'groups', 'rooms', 'feeds'];

function draw() {
  const body = { users: usersTab, groups: groupsTab, rooms: roomsTab, feeds: feedsTab }[state.tab]();
  rootEl.replaceChildren(
    h('div', { class: 'top' }, h('div', { class: 'brand' }, 'NetSpeak · admin'), h('button', { onclick: ctx.back }, '← Back to intercom')),
    h('div', { class: 'wrap' },
      h('div', { class: 'tabs' }, tabs.map((t) => h('button', { class: state.tab === t ? 'sel' : '', onclick: () => { state.tab = t; draw(); } }, t[0].toUpperCase() + t.slice(1)))),
      body));
}

async function act(fn, ok) {
  try { await fn(); if (ok) toast(ok); await load(); } catch (e) { toast(e.message); }
}
function confirmDel(what, fn) { if (confirm(`Delete ${what}? This cannot be undone.`)) act(fn, 'Deleted'); }

function sheet(title, content, onSave, saveLabel = 'Save') {
  const close = () => s.remove();
  const s = h('div', { class: 'sheet', onclick: (e) => { if (e.target === s) close(); } }, h('div', {}, h('h3', {}, title), content,
    h('div', { class: 'row', style: 'margin-top:18px' }, onSave && h('button', { class: 'primary', onclick: async () => { try { await onSave(); close(); await load(); } catch (e) { toast(e.message); } } }, saveLabel), h('button', { onclick: close }, onSave ? 'Cancel' : 'Close'))));
  document.body.append(s);
}
const field = (label, input) => [h('label', { class: 'f' }, label), input];
function groupPicker(selected) {
  const set = new Set(selected);
  return h('div', {}, D().groups.map((g) => h('label', { class: 'row', style: 'margin:6px 0' },
    h('input', { type: 'checkbox', checked: set.has(g.id), onchange: (e) => { e.target.checked ? set.add(g.id) : set.delete(g.id); } }),
    h('span', { class: 'pill', style: `border-color:${g.color}` }, g.name))), Object.assign(h('span'), { get: () => [...set] }));
}
function pickerGet(el) { return el.lastChild.get(); }

// ---- users ----
function usersTab() {
  const users = D().users;
  const row = (u) => h('tr', {}, h('td', {}, h('b', {}, u.displayName), h('div', { class: 'sub' }, u.username + (u.role === 'admin' ? ' · admin' : ''))),
    h('td', {}, u.groups.map((g) => h('span', { class: 'pill' }, gname(g)))), h('td', {}, u.online ? h('span', { class: 'badge live', style: 'background:var(--accent);color:#052e12' }, 'online') : u.disabled ? h('span', { class: 'badge' }, 'disabled') : ''),
    h('td', {}, h('button', { onclick: () => userForm(u) }, 'Edit'), ' ',
      u.online ? h('button', { onclick: () => act(() => api('POST', `/api/admin/users/${u.id}/kick`), 'Disconnected') }, 'Kick') : '', ' ',
      u.id !== ctx.me.id && h('button', { class: 'danger', onclick: () => confirmDel(u.displayName, () => api('DELETE', `/api/admin/users/${u.id}`)) }, '✕')));
  return h('div', {}, h('button', { class: 'primary', onclick: () => userForm() }, '+ New user'),
    h('table', {}, h('tbody', {}, users.map(row))));
}
function userForm(u) {
  const f = { username: h('input', { type: 'text', value: u?.username || '', disabled: !!u, autocapitalize: 'none' }),
    name: h('input', { type: 'text', value: u?.displayName || '' }),
    pw: h('input', { type: 'password', placeholder: u ? 'Leave blank to keep' : 'Password', autocomplete: 'new-password' }),
    role: h('select', {}, h('option', { value: 'user', selected: u?.role !== 'admin' }, 'User'), h('option', { value: 'admin', selected: u?.role === 'admin' }, 'Admin (full access)')),
    dis: h('input', { type: 'checkbox', checked: !!u?.disabled }) };
  const gp = groupPicker(u?.groups || []);
  sheet(u ? 'Edit user' : 'New user', h('div', {}, field('Username', f.username), field('Display name', f.name), field('Password', f.pw), field('Role', f.role),
    h('label', { class: 'f' }, 'Groups'), gp, h('label', { class: 'row', style: 'margin-top:12px' }, f.dis, 'Disabled (cannot sign in)')),
    () => api(u ? 'PUT' : 'POST', u ? `/api/admin/users/${u.id}` : '/api/admin/users',
      { username: f.username.value, displayName: f.name.value, password: f.pw.value, role: f.role.value, groups: pickerGet(gp), disabled: f.dis.checked }));
}

// ---- groups ----
function groupsTab() {
  return h('div', {}, h('p', { class: 'sub' }, 'Groups are how you grant access. Put users in groups, then give groups access to rooms and feeds.'),
    h('button', { class: 'primary', onclick: () => groupForm() }, '+ New group'),
    h('table', {}, h('tbody', {}, D().groups.map((g) => h('tr', {}, h('td', {}, h('span', { class: 'pill', style: `border-color:${g.color}` }, g.name)),
      h('td', { class: 'sub' }, D().users.filter((u) => u.groups.includes(g.id)).length + ' members'),
      h('td', {}, h('button', { onclick: () => groupForm(g) }, 'Edit'), ' ', h('button', { class: 'danger', onclick: () => confirmDel(g.name, () => api('DELETE', `/api/admin/groups/${g.id}`)) }, '✕')))))));
}
function groupForm(g) {
  const n = h('input', { type: 'text', value: g?.name || '' }), c = h('input', { type: 'color', value: g?.color || '#3b82f6', style: 'width:60px;height:40px' });
  sheet(g ? 'Edit group' : 'New group', h('div', {}, field('Name', n), field('Colour', c)), () => api(g ? 'PUT' : 'POST', g ? `/api/admin/groups/${g.id}` : '/api/admin/groups', { name: n.value, color: c.value }));
}

// ---- access editor ----
function aclEditor(access, feed) {
  const rows = new Map(access.map((a) => [a.principal, { ...a }]));
  const wrap = h('div');
  const principals = () => [['everyone', 'Everyone signed in'], ...D().groups.map((g) => ['group:' + g.id, 'Group: ' + g.name]),
    ...[...rows.keys()].filter((k) => k.startsWith('user:')).map((k) => [k, 'User: ' + (D().users.find((u) => 'user:' + u.id === k)?.displayName || '?')])];
  const redraw = () => {
    const addSel = h('select', { onchange: (e) => { if (e.target.value) { rows.set(e.target.value, { principal: e.target.value }); redraw(); } } },
      h('option', { value: '' }, '+ Add a specific user…'), D().users.filter((u) => !rows.has('user:' + u.id)).map((u) => h('option', { value: 'user:' + u.id }, u.displayName)));
    const cb = (p, k) => { const r = rows.get(p) || { principal: p }; return h('input', { type: 'checkbox', checked: !!r[k], onchange: (e) => { const x = rows.get(p) || { principal: p }; x[k] = e.target.checked; if (k === 'talk' && x.talk) x.listen = true; if (k === 'listen' && !x.listen) { x.talk = false; } rows.set(p, x); redraw(); } }); };
    wrap.replaceChildren(h('table', { class: 'acl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Who'), h('th', {}, 'Listen'), !feed && h('th', {}, 'Talk'), feed && h('th', {}, 'Send'))),
      h('tbody', {}, principals().map(([p, l]) => h('tr', {}, h('td', {}, l), h('td', {}, cb(p, 'listen')), !feed && h('td', {}, cb(p, 'talk')), feed && h('td', {}, cb(p, 'source')))))), addSel);
  };
  redraw();
  return Object.assign(wrap, { get: () => [...rows.values()].filter((r) => r.listen || r.talk || r.source) });
}

// ---- rooms ----
function roomsTab() {
  return h('div', {}, h('button', { class: 'primary', onclick: () => roomForm() }, '+ New room'),
    D().rooms.map((r) => h('div', { class: 'card room', style: `--c:${r.color};margin-top:12px` }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, r.name),
      h('div', { class: 'sub' }, summarize(r.access, false))), h('button', { onclick: () => roomForm(r) }, 'Edit'), h('button', { class: 'danger', onclick: () => confirmDel(r.name, () => api('DELETE', `/api/admin/rooms/${r.id}`)) }, '✕')))));
}
function summarize(access, feed) {
  if (!access.length) return 'Admins only';
  const who = (a) => a.principal === 'everyone' ? 'Everyone' : a.principal.startsWith('group:') ? gname(a.principal.slice(6)) : (D().users.find((u) => 'user:' + u.id === a.principal)?.displayName || '?');
  return access.map((a) => `${who(a)} (${[a.listen && 'listen', a.talk && 'talk', a.source && 'send'].filter(Boolean).join('+')})`).join(' · ');
}
function roomForm(r) {
  const n = h('input', { type: 'text', value: r?.name || '' }), c = h('input', { type: 'color', value: r?.color || '#22c55e', style: 'width:60px;height:40px' });
  const o = h('input', { type: 'number', value: r?.order ?? D().rooms.length + 1 }), ptt = h('input', { type: 'checkbox', checked: !!r?.pttOnly });
  const acl = aclEditor(r?.access || [], false);
  sheet(r ? 'Edit room' : 'New room', h('div', {}, field('Name', n), h('div', { class: 'grid2' }, h('div', {}, field('Colour', c)), h('div', {}, field('Sort order', o))),
    h('label', { class: 'row', style: 'margin-top:12px' }, ptt, 'Push-to-talk only (no latching)'), h('h2', {}, 'Who can use this room'), acl),
    () => api(r ? 'PUT' : 'POST', r ? `/api/admin/rooms/${r.id}` : '/api/admin/rooms', { name: n.value, color: c.value, order: +o.value, pttOnly: ptt.checked, access: acl.get() }));
}

// ---- feeds ----
function feedsTab() {
  return h('div', {}, h('p', { class: 'sub' }, 'Program feeds are one-way, unprocessed audio. Send them from a browser (line-in/interface) or push Opus from ffmpeg/OBS to the ingest URL.'),
    h('button', { class: 'primary', onclick: () => feedForm() }, '+ New feed'),
    D().feeds.map((f) => h('div', { class: 'card', style: 'margin-top:12px' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, f.name), h('div', { class: 'sub' }, summarize(f.access, true))),
      h('button', { onclick: () => ingestInfo(f) }, 'Ingest'), h('button', { onclick: () => feedForm(f) }, 'Edit'), h('button', { class: 'danger', onclick: () => confirmDel(f.name, () => api('DELETE', `/api/admin/feeds/${f.id}`)) }, '✕')))));
}
function feedForm(f) {
  const n = h('input', { type: 'text', value: f?.name || '' }), d = h('input', { type: 'text', value: f?.description || '' }), o = h('input', { type: 'number', value: f?.order ?? D().feeds.length + 1 });
  const acl = aclEditor(f?.access || [{ principal: 'everyone', listen: true }], true);
  sheet(f ? 'Edit feed' : 'New feed', h('div', {}, field('Name', n), field('Description', d), field('Sort order', o), h('h2', {}, 'Who can listen / send'), acl),
    () => api(f ? 'PUT' : 'POST', f ? `/api/admin/feeds/${f.id}` : '/api/admin/feeds', { name: n.value, description: d.value, order: +o.value, access: acl.get() }));
}
function ingestInfo(f) {
  const url = `${location.origin}/ingest/${f.ingestKey}`;
  const cmd = `ffmpeg -re -i INPUT -c:a libopus -b:a 192k -frame_duration 20 -ac 2 -ar 48000 -f ogg - | curl -sS -T - ${url}`;
  const cmd2 = `ffmpeg -f pulse -i default -c:a libopus -b:a 192k -frame_duration 20 -ac 2 -ar 48000 -f ogg - | curl -sS -T - ${url}`;
  sheet(`Ingest: ${f.name}`, h('div', {}, h('p', { class: 'sub' }, 'Opus packets are relayed untouched: no re-encoding on the server. Keep this URL secret.'),
    h('label', { class: 'f' }, 'Ingest URL (PUT/POST an Ogg/Opus stream)'), h('pre', {}, url),
    h('label', { class: 'f' }, 'From a file / any source'), h('pre', {}, cmd), h('label', { class: 'f' }, 'From a sound card (Linux example)'), h('pre', {}, cmd2),
    h('button', { class: 'danger', style: 'margin-top:12px', onclick: () => { if (confirm('Rotate the key? The old URL stops working.')) act(() => api('POST', `/api/admin/feeds/${f.id}/rotate`), 'Key rotated'); } }, 'Rotate key')), null);
}
