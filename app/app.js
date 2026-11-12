// LinkWise — Smarter connections, every day.
//
// A personalized commuter assistant for NJ <-> NYC riders. The centerpiece is a
// large, colorful departure countdown that updates every second and rolls to
// the next eligible departure when one passes.
//
// ILLUSTRATIVE MOCK DATA ONLY. Departure times come from app/data/mock_schedule.json
// and are hand-entered recurring EXAMPLES — not live or verified PATH /
// NJ Transit / Hudson-Bergen Light Rail schedules. Nothing here is real-time.
//
// Architecture (future-API friendly):
//   mock_schedule.json  ->  ScheduleService (the single data seam)  ->  UI
// Swapping in a real transit API later means reimplementing ScheduleService
// only; the dashboard, countdown, and onboarding code stay the same.

const COMMUTES_KEY = 'linkwise_commutes_v1';

let SCHEDULE = null;          // raw mock schedule document
let commutes = [];            // user commutes (persisted)
let activeCommuteId = null;   // currently shown commute (session)
let activeLegIndex = 0;       // which leg of the active commute is in focus
let tickHandle = null;        // setInterval handle for the 1s countdown

// ---- Robust helpers: never fail silently -----------------------------------

function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing page element #${id} (HTML/JS out of sync — try a hard refresh).`);
  return node;
}

function showFatalError(err) {
  console.error('[LinkWise] load failed:', err);
  let banner = document.getElementById('fatal-error');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'fatal-error';
    banner.style.cssText =
      'margin:0 auto 20px;max-width:560px;background:#7f1d1d;color:#fff;border:1px solid #ef4444;' +
      'border-radius:12px;padding:14px 16px;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;';
    const wrap = document.querySelector('.wrap') || document.body;
    wrap.insertBefore(banner, wrap.firstChild);
  }
  banner.innerHTML =
    '<strong>LinkWise couldn\u2019t load.</strong> ' +
    String(err && err.message ? err.message : err) +
    '<br><span style="opacity:.85">Fix: run <code>python3 -m http.server</code> from the <code>app/</code> folder and hard-refresh (Cmd/Ctrl+Shift+R).</span>';
}

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ===========================================================================
//  ScheduleService — the ONLY place that knows about the data source.
//  Replace the internals here to connect a real PATH / NJT / HBLR API later.
// ===========================================================================

const ScheduleService = {
  doc: null,
  init(doc) { this.doc = doc; },

  operator(id) { return this.doc.operators.find(o => o.id === id) || null; },
  station(id) { return this.doc.stations.find(s => s.id === id) || null; },
  service(id) { return this.doc.services.find(s => s.id === id) || null; },
  get services() { return this.doc.services; },
  get sampleCommutes() { return this.doc.sampleCommutes || []; },

  // Human-readable summary of a service leg for display.
  describeService(serviceId) {
    const svc = this.service(serviceId);
    if (!svc) return null;
    const op = this.operator(svc.operator);
    return {
      serviceId,
      operatorId: svc.operator,
      operatorName: op ? op.name : svc.operator,
      operatorShort: op ? op.shortName : svc.operator,
      operatorColor: op ? op.color : '#8b5cf6',
      originName: (this.station(svc.origin) || {}).name || svc.origin,
      destinationName: (this.station(svc.destination) || {}).name || svc.destination,
      direction: svc.direction,
      line: svc.line
    };
  },

  // Does this service run on the given day? (0=Sun..6=Sat)
  runsOn(serviceId, date) {
    const svc = this.service(serviceId);
    if (!svc) return false;
    const days = Array.isArray(svc.validDays) ? svc.validDays : [0, 1, 2, 3, 4, 5, 6];
    return days.includes(date.getDay());
  },

  // Core seam: upcoming departures for a service as absolute Date timestamps,
  // searching today and the next few valid days. Returns soonest-first.
  // `afterTime` (optional "HH:MM") filters out departures earlier than it today.
  upcomingDepartures(serviceId, now, { lookaheadDays = 7, afterTime = null } = {}) {
    const svc = this.service(serviceId);
    if (!svc || !Array.isArray(svc.departures)) return [];
    const out = [];
    const minToday = afterTime ? toMinutes(afterTime) : null;

    for (let d = 0; d <= lookaheadDays; d++) {
      const day = new Date(now);
      day.setDate(now.getDate() + d);
      day.setHours(0, 0, 0, 0);
      if (!this.runsOn(serviceId, day)) continue;

      for (const hhmm of svc.departures) {
        const mins = toMinutes(hhmm);
        if (mins == null) continue;
        if (d === 0 && minToday != null && mins < minToday) continue; // respect preferred window today
        const when = new Date(day);
        when.setMinutes(mins);
        if (when.getTime() >= now.getTime()) {
          out.push({ serviceId, hhmm, when });
        }
      }
      if (out.length >= 6) break; // enough for "next" + "following"
    }
    out.sort((a, b) => a.when - b.when);
    return out;
  }
};

// ---- Time helpers ----------------------------------------------------------

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function fmtClock(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtCountdown(ms) {
  if (ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---- Persistence (safe if storage unavailable) -----------------------------

function loadCommutes() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(COMMUTES_KEY)); } catch { saved = null; }
  if (Array.isArray(saved) && saved.length) {
    commutes = saved;
  } else {
    // First run: seed from the clearly-labeled sample commutes.
    commutes = ScheduleService.sampleCommutes.map(c => ({
      id: c.id,
      name: c.name,
      recurringDays: c.recurringDays.slice(),
      legs: c.legs.map(l => ({ serviceId: l.serviceId, preferredTime: l.preferredTime }))
    }));
    saveCommutes();
  }
}
function saveCommutes() {
  try { localStorage.setItem(COMMUTES_KEY, JSON.stringify(commutes)); } catch {}
}

function randId(prefix) {
  return prefix + Math.random().toString(36).slice(2, 8);
}

// ===========================================================================
//  Dashboard suggestion: pick the most relevant commute for "now".
// ===========================================================================

// Score each commute by how soon its first leg departs today (running services
// only). The soonest upcoming first-leg wins; commutes not running today sink.
function suggestCommuteId(now) {
  let best = null;
  for (const c of commutes) {
    if (!c.legs.length) continue;
    const leg = c.legs[0];
    const after = leg.preferredTime && leg.preferredTime !== 'next' ? null : null;
    const deps = ScheduleService.upcomingDepartures(leg.serviceId, now, { lookaheadDays: 1 });
    if (!deps.length) continue;
    const runsToday = ScheduleService.runsOn(leg.serviceId, now) &&
      deps[0].when.toDateString() === now.toDateString();
    // Prefer commutes whose recurringDays include today.
    const recurToday = Array.isArray(c.recurringDays) && c.recurringDays.includes(now.getDay());
    const msAway = deps[0].when - now;
    const score = (recurToday ? 0 : 1e12) + (runsToday ? 0 : 5e11) + msAway;
    if (!best || score < best.score) best = { id: c.id, score };
  }
  return best ? best.id : (commutes[0] ? commutes[0].id : null);
}

// ===========================================================================
//  Rendering
// ===========================================================================

function activeCommute() {
  return commutes.find(c => c.id === activeCommuteId) || null;
}

// Resolve the chosen departure for a leg: the next departure at/after its
// preferred time (today), else the next available. Returns { deps, primaryIdx }.
function legDepartures(leg, now) {
  const preferred = leg.preferredTime && leg.preferredTime !== 'next' ? leg.preferredTime : null;
  // Always fetch the raw next departures (soonest first).
  const next = ScheduleService.upcomingDepartures(leg.serviceId, now, { lookaheadDays: 7 });
  if (!preferred) return next;
  // With a preferred time, bias toward the first departure >= preferred today,
  // but still fall through to next available once that has passed.
  const biased = ScheduleService.upcomingDepartures(leg.serviceId, now, { lookaheadDays: 7, afterTime: preferred });
  return biased.length ? biased : next;
}

function renderDashboard() {
  const box = el('dashboard');
  const now = new Date();
  const suggestedId = suggestCommuteId(now);

  const cards = commutes.map(c => {
    const isActive = c.id === activeCommuteId;
    const isSuggested = c.id === suggestedId;
    const legCount = c.legs.length;
    const days = (c.recurringDays || []).map(d => DAY_LABELS[d]).join(' ');
    const first = c.legs[0] ? ScheduleService.describeService(c.legs[0].serviceId) : null;
    const route = first ? `${esc(first.originName)} \u2192 ${esc((ScheduleService.describeService(c.legs[legCount-1].serviceId)||{}).destinationName || '')}` : '';
    return `
      <button class="commute-card ${isActive ? 'active' : ''}" data-commute="${c.id}">
        <div class="cc-top">
          <span class="cc-name">${esc(c.name)}</span>
          ${isSuggested ? '<span class="cc-sugg">Suggested now</span>' : ''}
        </div>
        <div class="cc-route">${route}</div>
        <div class="cc-meta">${legCount} leg${legCount === 1 ? '' : 's'} · ${days || 'No days set'}</div>
      </button>`;
  }).join('');

  box.innerHTML = `
    <div class="dash-head">
      <span class="dash-title">Your commutes</span>
      <button class="link-btn" id="addCommuteBtn">+ New</button>
    </div>
    <div class="commute-list">${cards || '<p class="hint">No commutes yet. Tap “+ New” to create one.</p>'}</div>`;

  box.querySelectorAll('[data-commute]').forEach(btn => {
    btn.addEventListener('click', () => {
      activeCommuteId = btn.getAttribute('data-commute');
      activeLegIndex = 0;
      renderAll();
    });
  });
  el('addCommuteBtn').addEventListener('click', openOnboarding);

  // Bring the active commute into view horizontally without jumping the page.
  const activeCard = box.querySelector('.commute-card.active');
  if (activeCard) activeCard.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function renderCountdown() {
  const box = el('countdown');
  const c = activeCommute();
  if (!c || !c.legs.length) {
    box.innerHTML = `<div class="cd-empty"><p class="hint">Select a commute above to start the departure countdown.</p></div>`;
    return;
  }
  if (activeLegIndex >= c.legs.length) activeLegIndex = c.legs.length - 1;

  const leg = c.legs[activeLegIndex];
  const info = ScheduleService.describeService(leg.serviceId);
  const now = new Date();
  const deps = legDepartures(leg, now);

  if (!info || !deps.length) {
    box.innerHTML = `
      <div class="cd-card state-none">
        <div class="cd-leg">Leg ${activeLegIndex + 1} of ${c.legs.length}</div>
        <div class="cd-route">${info ? esc(info.originName) : 'Unknown service'}</div>
        <p class="hint">No upcoming mock departures found for this leg in the next few days.</p>
      </div>`;
    return;
  }

  const primary = deps[0];
  const following = deps[1] || null;
  const msAway = primary.when - now;
  const minsAway = msAway / 60000;

  // Urgency states (safety-conscious wording — never "run").
  let state, headline;
  if (minsAway <= 1) { state = 'go'; headline = 'GO NOW!'; }
  else if (minsAway <= 4) { state = 'soon'; headline = 'Leaving soon'; }
  else { state = 'comfy'; headline = 'Comfortable'; }

  const legPills = c.legs.map((lg, i) => {
    const li = ScheduleService.describeService(lg.serviceId);
    return `<span class="leg-pill ${i === activeLegIndex ? 'on' : ''}">${i + 1}. ${li ? esc(li.operatorShort) : '?'}</span>`;
  }).join('');

  box.innerHTML = `
    <div class="cd-card state-${state}">
      <div class="cd-leg">Leg ${activeLegIndex + 1} of ${c.legs.length} · ${esc(c.name)}</div>
      <div class="cd-op" style="--op:${info.operatorColor}">
        <span class="cd-op-dot"></span>${esc(info.operatorName)}
      </div>
      <div class="cd-headline">${headline}</div>
      <div class="cd-timer${fmtCountdown(msAway).length >= 7 ? ' long' : ''}" id="cdTimer" aria-live="polite">${fmtCountdown(msAway)}</div>
      <div class="cd-sub">until departure at <strong>${fmtClock(primary.when)}</strong> <span class="mock-chip">MOCK</span></div>

      <div class="cd-details">
        <div class="cd-row"><span class="cd-k">Board at</span><span class="cd-v">${esc(info.originName)}</span></div>
        <div class="cd-row"><span class="cd-k">Toward</span><span class="cd-v">${esc(info.destinationName)}</span></div>
        <div class="cd-row"><span class="cd-k">Direction</span><span class="cd-v">${esc(info.direction)}</span></div>
        ${following ? `<div class="cd-row"><span class="cd-k">Following</span><span class="cd-v">${fmtClock(following.when)}</span></div>` : ''}
      </div>

      <div class="cd-legs">${legPills}</div>

      <div class="cd-actions">
        <button class="btn" id="onTrainBtn">${activeLegIndex < c.legs.length - 1 ? "I'm on this train \u2192 Next leg" : "I'm on this train \u2713"}</button>
        ${activeLegIndex > 0 ? '<button class="btn btn-ghost" id="prevLegBtn">\u2190 Previous leg</button>' : ''}
      </div>
      <p class="cd-note">Illustrative MOCK departure data — not live or verified schedule information.</p>
    </div>`;

  el('onTrainBtn').addEventListener('click', () => {
    if (activeLegIndex < c.legs.length - 1) {
      activeLegIndex += 1;
      renderCountdown();
    } else {
      activeLegIndex = 0;              // commute complete — reset to first leg
      renderCountdown();
    }
  });
  const prev = document.getElementById('prevLegBtn');
  if (prev) prev.addEventListener('click', () => { activeLegIndex -= 1; renderCountdown(); });
}

// The 1-second heartbeat. Updates just the timer text + urgency class in place
// (cheap), and re-renders fully when a departure passes so it rolls forward.
function startTicking() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = setInterval(() => {
    const c = activeCommute();
    if (!c || !c.legs.length) return;
    const leg = c.legs[activeLegIndex];
    if (!leg) return;
    const now = new Date();
    const deps = legDepartures(leg, now);
    const timer = document.getElementById('cdTimer');
    if (!deps.length || !timer) { renderCountdown(); return; }

    const msAway = deps[0].when - now;
    if (msAway <= 0) { renderCountdown(); return; } // departure passed -> roll to next

    const txt = fmtCountdown(msAway);
    timer.textContent = txt;
    timer.classList.toggle('long', txt.length >= 7); // shrink long h:mm:ss timers

    // Keep urgency state in sync without a full re-render.
    const card = timer.closest('.cd-card');
    const minsAway = msAway / 60000;
    let state = 'comfy', headline = 'Comfortable';
    if (minsAway <= 1) { state = 'go'; headline = 'GO NOW!'; }
    else if (minsAway <= 4) { state = 'soon'; headline = 'Leaving soon'; }
    if (card && !card.classList.contains('state-' + state)) {
      card.className = 'cd-card state-' + state;
      const h = card.querySelector('.cd-headline');
      if (h) h.textContent = headline;
    }
  }, 1000);
}

function renderAll() {
  renderDashboard();
  renderCountdown();
  startTicking();
}

// ===========================================================================
//  Minimal onboarding — create & name a commute with multiple legs.
// ===========================================================================

function serviceOptions(selectedId) {
  return ScheduleService.services.map(s => {
    const info = ScheduleService.describeService(s.id);
    const label = `${info.operatorShort}: ${info.originName} \u2192 ${info.destinationName}`;
    return `<option value="${s.id}" ${s.id === selectedId ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

// Draft held in memory while the sheet is open.
let draft = null;

function openOnboarding() {
  draft = {
    name: '',
    recurringDays: [1, 2, 3, 4, 5],
    legs: [{ serviceId: ScheduleService.services[0].id, preferredTime: 'next' }]
  };
  renderOnboarding();
  el('sheet').classList.add('open');
}
function closeOnboarding() {
  el('sheet').classList.remove('open');
  draft = null;
}

function renderOnboarding() {
  const body = el('sheetBody');
  const dayToggles = DAY_LABELS.map((lbl, i) =>
    `<button type="button" class="day-toggle ${draft.recurringDays.includes(i) ? 'on' : ''}" data-day="${i}">${lbl}</button>`
  ).join('');

  const legRows = draft.legs.map((leg, i) => `
    <div class="leg-edit" data-leg="${i}">
      <div class="leg-edit-head">
        <span>Leg ${i + 1}</span>
        ${draft.legs.length > 1 ? `<button type="button" class="link-btn danger" data-remove="${i}">Remove</button>` : ''}
      </div>
      <label class="fld">
        <span class="fld-k">Service</span>
        <select data-field="serviceId" data-leg="${i}">${serviceOptions(leg.serviceId)}</select>
      </label>
      <label class="fld">
        <span class="fld-k">Departure</span>
        <select data-field="preferredTime" data-leg="${i}">
          <option value="next" ${leg.preferredTime === 'next' ? 'selected' : ''}>Next available train</option>
          ${departureTimeOptions(leg.serviceId, leg.preferredTime)}
        </select>
      </label>
    </div>`).join('');

  body.innerHTML = `
    <label class="fld">
      <span class="fld-k">Commute name</span>
      <input id="draftName" type="text" placeholder="e.g. Morning to NYU" value="${esc(draft.name)}" />
    </label>

    <div class="fld">
      <span class="fld-k">Repeats on</span>
      <div class="day-row">${dayToggles}</div>
    </div>

    <div class="legs-edit">${legRows}</div>
    <button type="button" class="btn btn-ghost" id="addLegBtn">+ Add leg</button>

    <div class="sheet-actions">
      <button type="button" class="btn" id="saveCommuteBtn">Save commute</button>
      <button type="button" class="btn btn-ghost" id="cancelCommuteBtn">Cancel</button>
    </div>
    <p class="cd-note">Schedules use illustrative MOCK data — not live transit information.</p>`;

  // Wire up inputs.
  el('draftName').addEventListener('input', e => { draft.name = e.target.value; });

  body.querySelectorAll('[data-day]').forEach(btn => {
    btn.addEventListener('click', () => {
      const d = +btn.getAttribute('data-day');
      const idx = draft.recurringDays.indexOf(d);
      if (idx >= 0) draft.recurringDays.splice(idx, 1); else draft.recurringDays.push(d);
      draft.recurringDays.sort();
      renderOnboarding();
    });
  });

  body.querySelectorAll('select[data-field]').forEach(sel => {
    sel.addEventListener('change', e => {
      const i = +sel.getAttribute('data-leg');
      const field = sel.getAttribute('data-field');
      draft.legs[i][field] = e.target.value;
      if (field === 'serviceId') { draft.legs[i].preferredTime = 'next'; renderOnboarding(); }
    });
  });

  body.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      draft.legs.splice(+btn.getAttribute('data-remove'), 1);
      renderOnboarding();
    });
  });

  el('addLegBtn').addEventListener('click', () => {
    draft.legs.push({ serviceId: ScheduleService.services[0].id, preferredTime: 'next' });
    renderOnboarding();
  });

  el('saveCommuteBtn').addEventListener('click', saveDraft);
  el('cancelCommuteBtn').addEventListener('click', closeOnboarding);
}

function departureTimeOptions(serviceId, selected) {
  const svc = ScheduleService.service(serviceId);
  if (!svc || !Array.isArray(svc.departures)) return '';
  return svc.departures.map(t => {
    const [h, m] = t.split(':').map(Number);
    const d = new Date(); d.setHours(h, m, 0, 0);
    return `<option value="${t}" ${t === selected ? 'selected' : ''}>Usually ${fmtClock(d)}</option>`;
  }).join('');
}

function saveDraft() {
  if (!draft.name.trim()) { draft.name = 'My commute'; }
  if (!draft.legs.length) { closeOnboarding(); return; }
  const commute = {
    id: randId('cmt_'),
    name: draft.name.trim(),
    recurringDays: draft.recurringDays.slice().sort(),
    legs: draft.legs.map(l => ({ serviceId: l.serviceId, preferredTime: l.preferredTime }))
  };
  commutes.push(commute);
  saveCommutes();
  activeCommuteId = commute.id;
  activeLegIndex = 0;
  closeOnboarding();
  renderAll();
}

// ===========================================================================
//  Boot
// ===========================================================================

async function init() {
  let res;
  try {
    res = await fetch('data/mock_schedule.json?v=' + Date.now(), { cache: 'no-store' });
  } catch (e) {
    throw new Error('Could not fetch mock_schedule.json (are you serving over http, not file://?).');
  }
  if (!res.ok) throw new Error(`mock_schedule.json returned HTTP ${res.status}.`);
  try {
    SCHEDULE = await res.json();
  } catch (e) {
    throw new Error('mock_schedule.json is not valid JSON.');
  }
  if (!SCHEDULE || !Array.isArray(SCHEDULE.services) || !Array.isArray(SCHEDULE.operators)) {
    throw new Error('mock_schedule.json is missing "services" or "operators".');
  }

  ScheduleService.init(SCHEDULE);
  loadCommutes();

  // Open on the commute suggested for right now.
  activeCommuteId = suggestCommuteId(new Date());
  activeLegIndex = 0;

  renderAll();

  // Close the onboarding sheet by tapping the backdrop.
  el('sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeOnboarding(); });
}

init().catch(showFatalError);
