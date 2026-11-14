// Baby log: a shared feeding and diaper log for one baby.
//
// Records live in three places: this phone (localStorage, written first, so the
// app works offline), a queue of edits not yet sent, and the server, which every
// phone polls. Each record carries updatedAt, and the newest edit wins.
//
// Record shapes (all have id, kind, start, updatedAt, notes, and maybe deleted):
//   nurse:  segments [{ side: 'L'|'R', start, end|null }], end|null (null while
//           the timer runs), heft 'light'|'medium'|'heavy'|null
//   bottle: oz, milk 'breast'|'formula'|'hybrid', vitD true if the day's
//           Vitamin D drops went in this bottle
//   diaper: type 'wet'|'dirty'|'both'

const LS_RECORDS = 'babylog:records';
const LS_PENDING = 'babylog:pending';
const LS_UI = 'babylog:ui';
const POLL_MS = 15000;
const DAY_MS = 86400000;

// Display names for whoever logged an entry, sent by the server (the NAMES
// setting in wrangler.jsonc); anyone not listed shows as the part of their
// email before the @.
let names = {};

const records = new Map();
const pending = new Map();
const ui = { tab: 'feeds', view: 'day', day: startOfDay(Date.now()) };
let syncStatus = 'local';
let pushTimer = null;
let syncing = false;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// --- Time helpers ---

function startOfDay(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function addDays(dayTs, n) {
  const d = new Date(dayTs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtDayName(dayTs) {
  const today = startOfDay(Date.now());
  if (dayTs === today) return 'Today';
  if (dayTs === addDays(today, -1)) return 'Yesterday';
  return new Date(dayTs).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtWhen(ts) {
  const day = startOfDay(ts);
  const today = startOfDay(Date.now());
  if (day === today) return fmtTime(ts);
  if (day === addDays(today, -1)) return 'yesterday ' + fmtTime(ts);
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + fmtTime(ts);
}

// "2h 05m", "12m"
function fmtDur(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return mins + 'm';
  return Math.floor(mins / 60) + 'h ' + String(mins % 60).padStart(2, '0') + 'm';
}

// "4:07", "1:02:09"
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function fmtOz(oz) {
  return String(Math.round(oz * 100) / 100);
}

function toInputValue(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function who(email) {
  if (!email) return '';
  return names[email] || email.split('@')[0];
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Record helpers ---

function live() {
  return [...records.values()].filter(r => !r.deleted);
}

function feeds() {
  return live().filter(r => r.kind === 'nurse' || r.kind === 'bottle').sort((a, b) => a.start - b.start);
}

function running() {
  return live().find(r => r.kind === 'nurse' && r.end == null) || null;
}

function sideMs(r, side, now = Date.now()) {
  return (r.segments || [])
    .filter(s => s.side === side)
    .reduce((sum, s) => sum + ((s.end ?? now) - s.start), 0);
}

function activeSegment(r) {
  const last = (r.segments || [])[r.segments.length - 1];
  return last && last.end == null ? last : null;
}

function feedEnd(r, now = Date.now()) {
  if (r.kind !== 'nurse') return r.start;
  return r.end ?? now;
}

function describe(r) {
  if (r.kind === 'bottle') {
    const milk = { formula: 'Formula', hybrid: 'Hybrid' }[r.milk] || 'Breast milk';
    return { main: `Bottle · ${fmtOz(r.oz)} oz`, sub: r.vitD ? milk + ' · Vit D' : milk };
  }
  if (r.kind === 'diaper') {
    return { main: { wet: 'Wet', dirty: 'Dirty', both: 'Wet + dirty' }[r.type] || 'Diaper', sub: '' };
  }
  const parts = [];
  const l = sideMs(r, 'L');
  const rr = sideMs(r, 'R');
  if (l >= 30000 || !rr) parts.push('L ' + fmtDur(l));
  if (rr >= 30000) parts.push('R ' + fmtDur(rr));
  if (r.heft) parts.push(r.heft[0].toUpperCase() + r.heft.slice(1));
  return { main: r.end == null ? 'Nursing now' : 'Nursed', sub: parts.join(' · ') };
}

// --- Saving and sync ---

function load() {
  try {
    for (const r of JSON.parse(localStorage.getItem(LS_RECORDS) || '[]')) records.set(r.id, r);
    for (const r of JSON.parse(localStorage.getItem(LS_PENDING) || '[]')) {
      pending.set(r.id, r);
      records.set(r.id, r);
    }
    Object.assign(ui, JSON.parse(localStorage.getItem(LS_UI) || '{}'), { day: startOfDay(Date.now()) });
  } catch {}
}

function persist() {
  try {
    localStorage.setItem(LS_RECORDS, JSON.stringify([...records.values()]));
    localStorage.setItem(LS_PENDING, JSON.stringify([...pending.values()]));
  } catch {}
}

function saveUi() {
  try { localStorage.setItem(LS_UI, JSON.stringify({ tab: ui.tab, view: ui.view })); } catch {}
}

function save(record) {
  const r = { ...structuredClone(record), updatedAt: Math.max(Date.now(), (records.get(record.id)?.updatedAt || 0) + 1) };
  records.set(r.id, r);
  pending.set(r.id, r);
  persist();
  render();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(sync, 300);
  return r;
}

async function api(method, body) {
  try {
    const res = await fetch('/api/records', {
      method,
      credentials: 'include',
      redirect: 'manual', // a signed-out request gets redirected to the login page
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      setSync('signed-out');
      return null;
    }
    setSync('synced');
    const data = await res.json();
    if (data && data.names && typeof data.names === 'object') names = data.names;
    return data;
  } catch {
    setSync('offline');
    return null;
  }
}

async function sync() {
  if (syncing) return;
  syncing = true;
  clearTimeout(pushTimer);
  try {
    if (pending.size) {
      const sent = [...pending.values()];
      const res = await api('PUT', { records: sent });
      if (!res) return;
      for (const server of res.records) {
        const mine = pending.get(server.id);
        if (!mine || mine.updatedAt <= server.updatedAt) {
          pending.delete(server.id);
          records.set(server.id, server);
        }
      }
      // Anything the server rejected outright won't come back; stop resending it.
      for (const r of sent) {
        if (!res.records.some(s => s.id === r.id) && pending.get(r.id) === r) pending.delete(r.id);
      }
    }
    const res = await api('GET');
    if (!res) return;
    const seen = new Set();
    for (const server of res.records) {
      seen.add(server.id);
      if (!pending.has(server.id)) records.set(server.id, server);
    }
    for (const id of [...records.keys()]) {
      if (!seen.has(id) && !pending.has(id)) records.delete(id);
    }
    persist();
    render();
  } finally {
    syncing = false;
  }
}

function setSync(status) {
  syncStatus = status;
  const el = $('#sync');
  el.className = 'sync ' + status;
  el.textContent = {
    synced: '',
    'signed-out': 'Sign in again',
    offline: pending.size ? 'Offline · saved here' : 'Offline',
    local: '',
  }[status];
  el.title = status === 'synced' ? 'Synced' : '';
}

// --- Rendering ---

// The date that was "today" at the last render, to notice midnight passing.
let shownToday = startOfDay(Date.now());

function render() {
  shownToday = startOfDay(Date.now());
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
  $('#feeds').hidden = ui.tab !== 'feeds';
  $('#diapers').hidden = ui.tab !== 'diapers';
  $$('.seg [data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === ui.view));

  const weekMode = ui.tab === 'feeds' && ui.view === 'week';
  const today = startOfDay(Date.now());
  for (const label of $$('.date-label')) {
    label.textContent = weekMode
      ? `${new Date(addDays(ui.day, -6)).toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${new Date(ui.day).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
      : fmtDayName(ui.day);
  }
  for (const btn of $$('.nav-btn[data-step="1"]')) btn.disabled = ui.day >= today;

  if (ui.tab === 'feeds') {
    renderSince();
    renderNursing();
    $('#day-view').hidden = ui.view !== 'day';
    $('#week-view').hidden = ui.view !== 'week';
    if (ui.view === 'day') renderDay(); else renderWeek();
  } else {
    renderDiapers();
  }
}

function renderSince() {
  const all = feeds().filter(r => r.start <= Date.now());
  const last = all[all.length - 1];
  const now = Date.now();
  if (!last) {
    $('#since-value').textContent = '—';
    $('#since-detail').textContent = 'No feedings yet';
  } else if (last.kind === 'nurse' && last.end == null) {
    $('#since-value').textContent = 'Feeding now';
    $('#since-detail').textContent = `started ${fmtTime(last.start)}`;
  } else {
    const ago = now - last.start;
    $('#since-value').textContent = ago < 60000 ? 'Just now' : fmtDur(ago) + ' ago';
    const d = describe(last);
    $('#since-detail').textContent = `started ${fmtWhen(last.start)} · ${d.main}${d.sub ? ', ' + d.sub : ''}`;
  }

  // Mark the side the last nursing session ended on.
  const lastNurse = all.filter(r => r.kind === 'nurse').pop();
  const lastSide = lastNurse?.segments?.length ? lastNurse.segments[lastNurse.segments.length - 1].side : null;
  $$('[data-start]').forEach(b => b.classList.toggle('last', b.dataset.start === lastSide));
}

function renderNursing() {
  const r = running();
  $('#nursing').hidden = !r;
  $('#start').hidden = !!r;
  if (!r) return;
  const seg = activeSegment(r);
  for (const side of ['L', 'R']) {
    $('#time-' + side).textContent = fmtClock(sideMs(r, side));
    $('#state-' + side).textContent = seg?.side === side ? 'running · tap to pause' : (seg ? 'tap to switch' : 'tap to resume');
    $(`.side[data-side="${side}"]`).classList.toggle('on', seg?.side === side);
  }
  $('#nurse-total').textContent = fmtClock(sideMs(r, 'L') + sideMs(r, 'R'));
}

function renderStrip(el, dayStart, list, now) {
  const dayEnd = addDays(dayStart, 1);
  const span = dayEnd - dayStart;
  const pct = (t) => ((Math.min(Math.max(t, dayStart), dayEnd) - dayStart) / span) * 100;
  let html = '';
  for (const r of list) {
    const end = feedEnd(r, now);
    if (end < dayStart || r.start >= dayEnd) continue;
    if (r.kind === 'nurse') {
      html += `<span class="mark nurse${r.end == null ? ' running' : ''}" style="left:${pct(r.start)}%;width:${pct(end) - pct(r.start)}%"></span>`;
    } else {
      html += `<span class="mark bottle" style="left:${pct(r.start)}%"></span>`;
    }
  }
  if (now >= dayStart && now < dayEnd) html += `<span class="now-line" style="left:${pct(now)}%"></span>`;
  el.innerHTML = html;
}

function dayTotals(dayStart, list) {
  const dayEnd = addDays(dayStart, 1);
  const inDay = list.filter(r => r.start >= dayStart && r.start < dayEnd);
  const oz = inDay.filter(r => r.kind === 'bottle').reduce((s, r) => s + (r.oz || 0), 0);
  const nurseMs = inDay.filter(r => r.kind === 'nurse').reduce((s, r) => s + sideMs(r, 'L') + sideMs(r, 'R'), 0);
  return { inDay, count: inDay.length, oz, nurseMs };
}

// The bottle that carried Vitamin D drops on the day containing ts, if any.
function vitDOn(ts, exceptId) {
  const day = startOfDay(ts);
  return live().find(r => r.kind === 'bottle' && r.vitD && r.id !== exceptId && startOfDay(r.start) === day) || null;
}

function totalsText(t) {
  const parts = [`<b>${t.count}</b> feed${t.count === 1 ? '' : 's'}`];
  if (t.oz) parts.push(`<b>${fmtOz(t.oz)}</b> oz bottle`);
  if (t.nurseMs) parts.push(`<b>${fmtDur(t.nurseMs)}</b> nursing`);
  return parts.join(' · ');
}

function renderDay() {
  const now = Date.now();
  const all = feeds();
  const t = dayTotals(ui.day, all);
  $('#day-totals').innerHTML = totalsText(t) + (vitDOn(ui.day) ? ' <span class="vitd-done" title="Vitamin D drops given">· D ✓</span>' : '');
  renderStrip($('#day-strip'), ui.day, all, now);

  const items = [...t.inDay].reverse();
  $('#day-list').innerHTML = items.length ? items.map(r => {
    const i = all.indexOf(r);
    const prev = i > 0 ? all[i - 1] : null;
    const gap = prev ? `<span class="entry-gap">+${fmtDur(r.start - prev.start)}</span>` : '';
    return entryHtml(r, gap);
  }).join('') : '<li class="empty">No feedings logged.</li>';
}

function entryHtml(r, extra = '') {
  const d = describe(r);
  return `<li><button class="entry ${r.kind}" data-id="${esc(r.id)}">
    <span class="entry-time">${fmtTime(r.start)}${extra}</span>
    <span>
      <span class="entry-main">${esc(d.main)}</span>
      ${d.sub ? `<div class="entry-sub">${esc(d.sub)}</div>` : ''}
      ${r.notes ? `<div class="entry-notes">${esc(r.notes)}</div>` : ''}
    </span>
  </button></li>`;
}

function renderWeek() {
  const now = Date.now();
  const all = feeds();
  const today = startOfDay(now);
  let html = '';
  let sumCount = 0, sumOz = 0, sumMs = 0, days = 0;
  for (let i = 6; i >= 0; i--) {
    const day = addDays(ui.day, -i);
    const t = dayTotals(day, all);
    const d = new Date(day);
    const bits = [`${t.count} feed${t.count === 1 ? '' : 's'}`];
    if (t.oz) bits.push(`${fmtOz(t.oz)} oz`);
    if (t.nurseMs) bits.push(fmtDur(t.nurseMs) + ' nursing');
    html += `<button class="week-row${day === today ? ' today' : ''}" data-day="${day}">
      <span class="wd">${d.toLocaleDateString([], { weekday: 'short' })}<b>${d.getDate()}</b></span>
      <span class="strip" data-strip="${day}"></span>
      <span class="wt">${bits.join(' · ')}</span>
    </button>`;
    // Average only over finished days that have something logged.
    if (day < today && t.count) {
      sumCount += t.count; sumOz += t.oz; sumMs += t.nurseMs; days++;
    }
  }
  $('#week-rows').innerHTML = html;
  for (const el of $$('[data-strip]')) renderStrip(el, Number(el.dataset.strip), all, now);
  $('#week-avg').innerHTML = days
    ? `Daily average: ${totalsText({ count: Math.round(sumCount / days * 10) / 10, oz: Math.round(sumOz / days * 10) / 10, nurseMs: sumMs / days })}`
    : '';
}

function renderDiapers() {
  const dayEnd = addDays(ui.day, 1);
  const items = live()
    .filter(r => r.kind === 'diaper' && r.start >= ui.day && r.start < dayEnd)
    .sort((a, b) => b.start - a.start);
  const wet = items.filter(r => r.type === 'wet' || r.type === 'both').length;
  const dirty = items.filter(r => r.type === 'dirty' || r.type === 'both').length;
  $('#diaper-totals').innerHTML = `<b>${wet}</b> wet · <b>${dirty}</b> dirty`;
  $('#diaper-list').innerHTML = items.length
    ? items.map(r => entryHtml(r)).join('')
    : '<li class="empty">No diapers logged.</li>';
}

// Cheap per-second update for the clocks.
function tick() {
  if (ui.tab !== 'feeds') return;
  renderSince();
  renderNursing();
}

// --- Nursing timer ---

function startNursing(side) {
  if (running()) return;
  const now = Date.now();
  save({ id: crypto.randomUUID(), kind: 'nurse', start: now, end: null, segments: [{ side, start: now, end: null }], heft: null, notes: '' });
}

function tapSide(side) {
  const r = running();
  if (!r) return;
  const now = Date.now();
  const segments = r.segments.map(s => ({ ...s }));
  const seg = segments[segments.length - 1];
  if (seg && seg.end == null) {
    seg.end = now;
    if (seg.side !== side) segments.push({ side, start: now, end: null });
  } else {
    segments.push({ side, start: now, end: null });
  }
  save({ ...r, segments });
}

function finishNursing() {
  const r = running();
  if (!r) return;
  const now = Date.now();
  const segments = r.segments.map(s => ({ ...s, end: s.end ?? now }));
  const end = segments.length ? segments[segments.length - 1].end : now;
  const done = save({ ...r, segments, end });
  openSheet(done, false, 'How did it go?');
}

// --- Edit sheet ---

let sheetRecord = null;
let sheetIsNew = false;

function segHtml(name, options, value) {
  return `<div class="seg" data-seg="${name}">${options.map(([v, label]) =>
    `<button type="button" data-value="${v}" class="${v === value ? 'on' : ''}">${label}</button>`).join('')}</div>`;
}

function openSheet(record, isNew, title) {
  sheetRecord = structuredClone(record);
  sheetIsNew = isNew;
  const r = sheetRecord;
  let body = `<div class="field"><label for="f-start">${r.kind === 'nurse' ? 'Started' : 'Time'}</label>
    <input type="datetime-local" id="f-start" value="${toInputValue(r.start)}"></div>`;

  if (r.kind === 'nurse') {
    if (r.end != null) {
      body += `<div class="row">
        <div class="field"><label for="f-l">Left (min)</label><input type="number" inputmode="numeric" min="0" id="f-l" value="${Math.round(sideMs(r, 'L') / 60000)}"></div>
        <div class="field"><label for="f-r">Right (min)</label><input type="number" inputmode="numeric" min="0" id="f-r" value="${Math.round(sideMs(r, 'R') / 60000)}"></div>
      </div>`;
    }
    body += `<div class="field"><span class="label">How heavy it seemed</span>
      ${segHtml('heft', [['light', 'Light'], ['medium', 'Medium'], ['heavy', 'Heavy']], r.heft)}</div>`;
  } else if (r.kind === 'bottle') {
    body += `<div class="field"><label for="f-oz">Ounces</label>
      <div class="stepper"><button type="button" data-oz="-0.25">−</button>
      <input type="number" inputmode="decimal" step="0.25" min="0" id="f-oz" value="${fmtOz(r.oz)}">
      <button type="button" data-oz="0.25">+</button></div></div>
      <div class="field"><span class="label">Milk</span>
      ${segHtml('milk', [['breast', 'Breast milk'], ['formula', 'Formula'], ['hybrid', 'Hybrid']], r.milk)}</div>`;
    const given = vitDOn(r.start, r.id);
    body += `<label class="vitd"><input type="checkbox" id="f-vitd"${r.vitD ? ' checked' : ''}> Vitamin D drops${
      given ? ` <span class="vitd-note">· already given ${startOfDay(r.start) === startOfDay(Date.now()) ? 'today' : 'that day'} at ${fmtTime(given.start)}</span>` : ''}</label>`;
  } else {
    body += `<div class="field"><span class="label">Type</span>
      ${segHtml('type', [['wet', 'Wet'], ['dirty', 'Dirty'], ['both', 'Both']], r.type)}</div>`;
  }
  body += `<div class="field"><label for="f-notes">Notes</label>
    <textarea id="f-notes" rows="2" placeholder="Anything worth remembering">${esc(r.notes)}</textarea></div>`;

  $('#sheet-title').textContent = title || (isNew ? 'Add ' : 'Edit ') + { nurse: 'nursing', bottle: 'bottle', diaper: 'diaper' }[r.kind];
  $('#sheet-body').innerHTML = body;
  $('#sheet-delete').hidden = isNew;
  const meta = [];
  if (r.by) meta.push('Logged by ' + who(r.by));
  if (r.updatedBy && r.updatedBy !== r.by) meta.push('edited by ' + who(r.updatedBy));
  $('#sheet-meta').textContent = meta.join(', ');

  for (const seg of $$('#sheet-body .seg')) {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const wasOn = btn.classList.contains('on');
      seg.querySelectorAll('button').forEach(b => b.classList.remove('on'));
      // Heft can be cleared by tapping it again; the others always keep a value.
      if (!(wasOn && seg.dataset.seg === 'heft')) btn.classList.add('on');
    });
  }
  for (const btn of $$('[data-oz]')) {
    btn.addEventListener('click', () => {
      const input = $('#f-oz');
      input.value = fmtOz(Math.max(0, (parseFloat(input.value) || 0) + parseFloat(btn.dataset.oz)));
    });
  }
  $('#sheet').showModal();
}

function segValue(name) {
  return $(`#sheet-body [data-seg="${name}"] button.on`)?.dataset.value || null;
}

function saveSheet() {
  const r = sheetRecord;
  const original = records.get(r.id) || r;
  const startInput = new Date($('#f-start').value).getTime();
  const start = Number.isFinite(startInput) ? startInput : r.start;
  r.notes = $('#f-notes').value.trim();

  if (r.kind === 'nurse') {
    r.heft = segValue('heft');
    const delta = start - r.start;
    const current = records.get(r.id);
    if (r.end == null) {
      // Opened while running: only the start moves. Take the latest segments,
      // in case someone switched sides or finished while the sheet was open.
      r.segments = structuredClone(current?.segments || r.segments);
      r.end = current?.end ?? null;
      if (r.segments.length) r.segments[0].start += delta;
      r.start = start;
    } else {
      const lMin = Math.max(0, parseFloat($('#f-l').value) || 0);
      const rMin = Math.max(0, parseFloat($('#f-r').value) || 0);
      const changed = lMin !== Math.round(sideMs(original, 'L') / 60000)
        || rMin !== Math.round(sideMs(original, 'R') / 60000);
      if (changed || sheetIsNew) {
        // Rebuild as one stretch per side, keeping whichever side came first.
        const first = r.segments[0]?.side || 'L';
        const order = first === 'L' ? [['L', lMin], ['R', rMin]] : [['R', rMin], ['L', lMin]];
        let t = start;
        r.segments = [];
        for (const [side, min] of order) {
          if (!min) continue;
          r.segments.push({ side, start: t, end: t + min * 60000 });
          t += min * 60000;
        }
        r.end = t;
      } else {
        r.segments = r.segments.map(s => ({ ...s, start: s.start + delta, end: s.end + delta }));
        r.end += delta;
      }
      r.start = start;
    }
  } else if (r.kind === 'bottle') {
    r.start = start;
    r.oz = Math.max(0, parseFloat($('#f-oz').value) || 0);
    r.milk = segValue('milk') || 'breast';
    r.vitD = $('#f-vitd').checked;
  } else {
    r.start = start;
    r.type = segValue('type') || 'wet';
  }
  save(r);
  if (sheetIsNew || startOfDay(r.start) !== ui.day) {
    ui.day = Math.min(startOfDay(r.start), startOfDay(Date.now()));
    render();
  }
}

function newBottle() {
  const lastBottle = live().filter(r => r.kind === 'bottle').sort((a, b) => b.start - a.start)[0];
  openSheet({
    id: crypto.randomUUID(), kind: 'bottle', start: Date.now(),
    oz: lastBottle?.oz ?? 3, milk: lastBottle?.milk ?? 'breast', notes: '',
  }, true);
}

function deleteRecord(r) {
  save({ ...records.get(r.id), deleted: true });
  toast('Deleted', () => save({ ...records.get(r.id), deleted: false }));
}

// --- Toast ---

let toastTimer = null;
let toastUndo = null;

function toast(text, undo) {
  $('#toast-text').textContent = text;
  $('#toast-undo').hidden = !undo;
  toastUndo = undo;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}

// --- Export ---

function exportCsv() {
  const rows = [['type', 'start', 'end', 'left_min', 'right_min', 'oz', 'milk', 'heft', 'diaper', 'vit_d', 'notes', 'logged_by']];
  const iso = (ts) => (ts == null ? '' : toInputValue(ts).replace('T', ' '));
  for (const r of live().sort((a, b) => a.start - b.start)) {
    rows.push([
      r.kind, iso(r.start), r.kind === 'nurse' ? iso(r.end) : '',
      r.kind === 'nurse' ? Math.round(sideMs(r, 'L') / 60000) : '',
      r.kind === 'nurse' ? Math.round(sideMs(r, 'R') / 60000) : '',
      r.kind === 'bottle' ? r.oz : '', r.kind === 'bottle' ? r.milk : '',
      r.heft || '', r.kind === 'diaper' ? r.type : '', r.vitD ? 'yes' : '', r.notes || '', who(r.by),
    ]);
  }
  const csv = rows.map(row => row.map(v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `baby-log-${toInputValue(Date.now()).slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --- Wiring ---

function wire() {
  $('.tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]')?.dataset.tab;
    if (!tab) return;
    ui.tab = tab;
    saveUi();
    render();
  });

  $('.seg[role="tablist"]').addEventListener('click', (e) => {
    const view = e.target.closest('[data-view]')?.dataset.view;
    if (!view) return;
    ui.view = view;
    saveUi();
    render();
  });

  for (const btn of $$('.nav-btn')) {
    btn.addEventListener('click', () => {
      const weekMode = ui.tab === 'feeds' && ui.view === 'week';
      ui.day = Math.min(addDays(ui.day, Number(btn.dataset.step) * (weekMode ? 7 : 1)), startOfDay(Date.now()));
      render();
    });
  }
  for (const label of $$('.date-label')) {
    label.addEventListener('click', () => { ui.day = startOfDay(Date.now()); render(); });
  }

  $$('[data-start]').forEach(b => b.addEventListener('click', () => startNursing(b.dataset.start)));
  $$('.side').forEach(b => b.addEventListener('click', () => tapSide(b.dataset.side)));
  $('#nurse-finish').addEventListener('click', finishNursing);
  $('#nurse-discard').addEventListener('click', () => {
    const r = running();
    if (r) deleteRecord(r);
  });
  $('#bottle-btn').addEventListener('click', newBottle);
  $('#add-past').addEventListener('click', () => {
    const start = Math.min(Date.now() - 30 * 60000, addDays(ui.day, 1) - 60 * 60000);
    openSheet({ id: crypto.randomUUID(), kind: 'nurse', start, end: start, segments: [], heft: null, notes: '' }, true);
  });

  $$('[data-diaper]').forEach(b => b.addEventListener('click', () => {
    const r = save({ id: crypto.randomUUID(), kind: 'diaper', start: Date.now(), type: b.dataset.diaper, notes: '' });
    ui.day = startOfDay(Date.now());
    render();
    toast(`Logged ${describe(r).main.toLowerCase()} at ${fmtTime(r.start)}`, () => save({ ...records.get(r.id), deleted: true }));
  }));
  $('#add-diaper').addEventListener('click', () => {
    const start = Math.min(Date.now() - 30 * 60000, addDays(ui.day, 1) - 60 * 60000);
    openSheet({ id: crypto.randomUUID(), kind: 'diaper', start, type: 'wet', notes: '' }, true);
  });

  document.addEventListener('click', (e) => {
    const entry = e.target.closest('.entry');
    if (entry) {
      const r = records.get(entry.dataset.id);
      if (r) openSheet(r, false);
      return;
    }
    const row = e.target.closest('.week-row');
    if (row) {
      ui.day = Number(row.dataset.day);
      ui.view = 'day';
      saveUi();
      render();
    }
  });

  $('#sheet-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveSheet();
    $('#sheet').close();
  });
  $('#sheet-cancel').addEventListener('click', () => $('#sheet').close());
  $('#sheet-delete').addEventListener('click', () => {
    $('#sheet').close();
    deleteRecord(sheetRecord);
  });
  $('#sheet').addEventListener('click', (e) => {
    if (e.target === $('#sheet')) $('#sheet').close(); // tap on the backdrop
  });

  $('#toast-undo').addEventListener('click', () => {
    if (toastUndo) toastUndo();
    toastUndo = null;
    $('#toast').hidden = true;
  });

  $('#export').addEventListener('click', exportCsv);
  $('#sync').addEventListener('click', (e) => {
    e.preventDefault();
    if (syncStatus === 'signed-out') location.reload();
    else sync();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Coming back to the app after midnight should land on the new day.
      if (startOfDay(Date.now()) !== shownToday) ui.day = startOfDay(Date.now());
      render();
      sync();
    }
  });
  window.addEventListener('online', sync);
  setInterval(tick, 1000);
  setInterval(render, 60000);
  setInterval(() => { if (document.visibilityState === 'visible') sync(); }, POLL_MS);
}

load();
wire();
render();
sync();
