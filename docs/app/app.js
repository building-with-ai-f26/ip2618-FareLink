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

  // Is this service powered by a real-time API (not mock)?
  isLive(serviceId) { const s = this.service(serviceId); return !!(s && s.live); },

  // Live cache keyed by serviceId:
  //   { status: 'loading'|'live'|'unavailable', reason, departures:[{when,route,epoch}], feedTs, fetchedAt }
  _liveCache: {},
  liveState(serviceId) { return this._liveCache[serviceId] || { status: 'loading' }; },

  // Fetch + parse the real MTA feed for a live service, updating the cache.
  // Never throws: any failure sets status 'unavailable' with a reason.
  async refreshLive(serviceId) {
    const svc = this.service(serviceId);
    if (!svc || !svc.live) return;
    const set = (o) => { this._liveCache[serviceId] = Object.assign({ fetchedAt: Date.now() }, o); };
    let buf;
    try {
      const res = await fetch(svc.feedUrl, { cache: 'no-store' });
      if (!res.ok) return set({ status: 'unavailable', reason: `feed HTTP ${res.status}`, departures: [] });
      buf = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      return set({ status: 'unavailable', reason: 'network error reaching the MTA feed', departures: [] });
    }
    let parsed;
    try {
      parsed = parseMtaDepartures(buf, { stopId: svc.gtfsStopId, route: svc.routeFilter });
    } catch (e) {
      return set({ status: 'unavailable', reason: 'could not parse GTFS-Realtime feed', departures: [] });
    }
    const nowS = Date.now() / 1000;
    const maxAge = svc.maxFeedAgeSeconds || 120;
    if (parsed.feedTs && (nowS - parsed.feedTs) > maxAge) {
      return set({ status: 'unavailable', reason: 'live feed is stale', feedTs: parsed.feedTs, departures: [] });
    }
    const future = parsed.departures
      .filter(d => d.epoch * 1000 >= Date.now() - 15000) // allow 15s grace
      .map(d => ({ serviceId, when: new Date(d.epoch * 1000), epoch: d.epoch, route: d.route, live: true }))
      .sort((a, b) => a.when - b.when);
    if (!future.length) {
      return set({ status: 'unavailable', reason: 'no upcoming departures returned', feedTs: parsed.feedTs, departures: [] });
    }
    set({ status: 'live', feedTs: parsed.feedTs, departures: future });
  },

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

// ===========================================================================
//  GTFS-Realtime adapter (pure functions) for the official MTA subway feed.
//  No dependencies: a minimal protobuf wire-format decoder extracts just the
//  fields we need (FeedHeader.timestamp, TripUpdate.trip.route_id, and each
//  StopTimeUpdate.stop_id + departure/arrival time). Exposed for unit testing.
// ===========================================================================

// Read a base-128 varint starting at index i. Uses multiplication (not <<) so
// values beyond 31 bits (e.g. epoch seconds) stay exact in JS numbers.
function _pbVarint(bytes, i) {
  let shift = 1, result = 0, b;
  do { b = bytes[i++]; result += (b & 0x7f) * shift; shift *= 128; } while (b & 0x80);
  return [result, i];
}

// Walk one protobuf message, returning [{ f: fieldNumber, w: wireType, v }].
// For length-delimited fields v is a Uint8Array slice; for varints v is a number.
function _pbFields(bytes) {
  const out = [];
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    let key; [key, i] = _pbVarint(bytes, i);
    const f = Math.floor(key / 8), w = key & 7;
    if (w === 0) { let v; [v, i] = _pbVarint(bytes, i); out.push({ f, w, v }); }
    else if (w === 2) { let ln; [ln, i] = _pbVarint(bytes, i); out.push({ f, w, v: bytes.subarray(i, i + ln) }); i += ln; }
    else if (w === 1) { out.push({ f, w, v: bytes.subarray(i, i + 8) }); i += 8; }
    else if (w === 5) { out.push({ f, w, v: bytes.subarray(i, i + 4) }); i += 4; }
    else throw new Error('unsupported wire type ' + w);
  }
  return out;
}

function _pbStr(u8) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8);
  return Buffer.from(u8).toString('utf8'); // Node fallback (tests)
}

// Parse a GTFS-Realtime FeedMessage and return upcoming departures for one
// GTFS stop_id (e.g. '127S'), optionally filtered to a route_id (e.g. '1').
// Returns { feedTs, departures: [{ epoch, route }] } sorted soonest-first.
function parseMtaDepartures(bytes, { stopId, route = null } = {}) {
  const top = _pbFields(bytes);
  let feedTs = null;
  const departures = [];
  for (const { f, w, v } of top) {
    if (f === 1 && w === 2) {                 // FeedHeader
      for (const h of _pbFields(v)) if (h.f === 3 && h.w === 0) feedTs = h.v;
    } else if (f === 2 && w === 2) {          // FeedEntity
      let tu = null;
      for (const e of _pbFields(v)) if (e.f === 3 && e.w === 2) tu = e.v; // trip_update
      if (!tu) continue;
      let routeId = null;
      const stus = [];
      for (const t of _pbFields(tu)) {
        if (t.f === 1 && t.w === 2) {         // TripDescriptor
          for (const d of _pbFields(t.v)) if (d.f === 5 && d.w === 2) routeId = _pbStr(d.v);
        } else if (t.f === 2 && t.w === 2) {  // StopTimeUpdate (repeated)
          stus.push(t.v);
        }
      }
      if (route && routeId !== route) continue;
      for (const stu of stus) {
        let sid = null, depT = null, arrT = null;
        for (const s of _pbFields(stu)) {
          if (s.f === 4 && s.w === 2) sid = _pbStr(s.v);               // stop_id
          else if (s.f === 3 && s.w === 2) {                           // departure event
            for (const x of _pbFields(s.v)) if (x.f === 2 && x.w === 0) depT = x.v;
          } else if (s.f === 2 && s.w === 2) {                         // arrival event
            for (const x of _pbFields(s.v)) if (x.f === 2 && x.w === 0) arrT = x.v;
          }
        }
        const t = depT || arrT;
        if (sid === stopId && t) departures.push({ epoch: t, route: routeId });
      }
    }
  }
  departures.sort((a, b) => a.epoch - b.epoch);
  return { feedTs, departures };
}

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

function sampleToCommute(c) {
  return {
    id: c.id,
    name: c.name,
    recurringDays: c.recurringDays.slice(),
    legs: c.legs.map(l => ({ serviceId: l.serviceId, preferredTime: l.preferredTime }))
  };
}

function loadCommutes() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(COMMUTES_KEY)); } catch { saved = null; }
  if (Array.isArray(saved) && saved.length) {
    commutes = saved;
  } else {
    // First run: seed from the clearly-labeled sample commutes.
    commutes = ScheduleService.sampleCommutes.map(sampleToCommute);
  }
  // Ensure any sample commutes added in later builds (e.g. the Live API Demo)
  // appear for returning users too, without disturbing their own commutes.
  let added = false;
  for (const s of ScheduleService.sampleCommutes) {
    if (!commutes.some(c => c.id === s.id)) { commutes.push(sampleToCommute(s)); added = true; }
  }
  if (added || !Array.isArray(saved) || !saved.length) saveCommutes();
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
// preferred time (today), else the next available.
function legDepartures(leg, now) {
  // LIVE legs read from the real-time cache (populated by the background poller).
  if (ScheduleService.isLive(leg.serviceId)) {
    const st = ScheduleService.liveState(leg.serviceId);
    if (st.status !== 'live') return [];
    return st.departures.filter(d => d.when >= now);
  }
  const preferred = leg.preferredTime && leg.preferredTime !== 'next' ? leg.preferredTime : null;
  // Always fetch the raw next departures (soonest first).
  const next = ScheduleService.upcomingDepartures(leg.serviceId, now, { lookaheadDays: 7 });
  if (!preferred) return next;
  // With a preferred time, bias toward the first departure >= preferred today,
  // but still fall through to next available once that has passed.
  const biased = ScheduleService.upcomingDepartures(leg.serviceId, now, { lookaheadDays: 7, afterTime: preferred });
  return biased.length ? biased : next;
}

// Data-source status for a leg: 'LIVE' | 'MOCK' | 'UNAVAILABLE' | 'LOADING'.
function legStatus(leg) {
  if (!ScheduleService.isLive(leg.serviceId)) return 'MOCK';
  const st = ScheduleService.liveState(leg.serviceId);
  if (st.status === 'live') return 'LIVE';
  if (st.status === 'loading') return 'LOADING';
  return 'UNAVAILABLE';
}

// Trigger a live refresh for the active leg if it is live and the cache is
// missing or older than ~25s. Re-renders when fresh data arrives. Debounced.
let _liveRefreshing = {};
function maybeRefreshLive(leg, onDone) {
  if (!leg || !ScheduleService.isLive(leg.serviceId)) return;
  const sid = leg.serviceId;
  const st = ScheduleService.liveState(leg.serviceId);
  const fresh = st.fetchedAt && (Date.now() - st.fetchedAt) < 25000 && st.status === 'live';
  if (fresh || _liveRefreshing[sid]) return;
  _liveRefreshing[sid] = true;
  ScheduleService.refreshLive(sid).finally(() => {
    _liveRefreshing[sid] = false;
    if (typeof onDone === 'function') onDone();
  });
}

// Fire a PostHog event the first time a live-powered countdown renders for a
// given commute+leg (guarded so it doesn't fire on every 1-second tick).
const _capturedLiveViews = new Set();
function capturedLiveView(commuteId, serviceId) {
  const key = commuteId + '|' + serviceId;
  if (_capturedLiveViews.has(key)) return;
  _capturedLiveViews.add(key);
  try {
    if (typeof window !== 'undefined' && window.posthog) {
      window.posthog.capture('viewed_live_countdown', { commute_id: commuteId, service_id: serviceId, source: 'mta_gtfs_realtime' });
    }
  } catch (e) { /* analytics must never break the app */ }
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
  const status = legStatus(leg);
  const isLive = ScheduleService.isLive(leg.serviceId);

  // Keep the live cache warm; re-render when fresh data lands.
  if (isLive) maybeRefreshLive(leg, renderCountdown);

  const legHdr = `Leg ${activeLegIndex + 1} of ${c.legs.length} · ${esc(c.name)}`;

  // LIVE leg still loading its first response.
  if (status === 'LOADING') {
    box.innerHTML = `
      <div class="cd-card state-none">
        <div class="cd-leg">${legHdr}</div>
        <div class="cd-op" style="--op:${info ? info.operatorColor : '#8b5cf6'}"><span class="cd-op-dot"></span>${info ? esc(info.operatorName) : ''}</div>
        <div class="cd-status loading">FETCHING LIVE DATA…</div>
        <p class="hint">Contacting the official MTA GTFS-Realtime feed for ${info ? esc(info.originName) : 'this station'}…</p>
      </div>`;
    return;
  }

  // LIVE leg that could not be used reliably — honest UNAVAILABLE state.
  if (status === 'UNAVAILABLE') {
    const reason = ScheduleService.liveState(leg.serviceId).reason || 'live data unavailable';
    box.innerHTML = `
      <div class="cd-card state-none">
        <div class="cd-leg">${legHdr}</div>
        <div class="cd-op" style="--op:${info ? info.operatorColor : '#8b5cf6'}"><span class="cd-op-dot"></span>${info ? esc(info.operatorName) : ''}</div>
        <div class="cd-status unavailable">UNAVAILABLE</div>
        <div class="cd-details" style="margin-top:14px">
          <div class="cd-row"><span class="cd-k">Station</span><span class="cd-v">${info ? esc(info.originName) : '—'}</span></div>
          ${info && info.line ? `<div class="cd-row"><span class="cd-k">Line</span><span class="cd-v">${esc(info.line)} train</span></div>` : ''}
          <div class="cd-row"><span class="cd-k">Reason</span><span class="cd-v">${esc(reason)}</span></div>
        </div>
        <div class="cd-actions"><button class="btn btn-ghost" id="retryLiveBtn">Retry live feed</button></div>
        <p class="cd-note">The live MTA feed couldn’t be used right now. No departure is shown rather than guessing.</p>
      </div>`;
    const r = document.getElementById('retryLiveBtn');
    if (r) r.addEventListener('click', () => { delete ScheduleService._liveCache[leg.serviceId]; renderCountdown(); });
    return;
  }

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

  // Fire a PostHog event the first time a live-powered countdown is shown.
  if (status === 'LIVE') capturedLiveView(c.id, leg.serviceId);

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

  // Source badge + freshness + footnote differ for LIVE vs MOCK.
  const statusPill = isLive
    ? '<span class="cd-status live">\u25cf LIVE</span>'
    : '<span class="cd-status mock">MOCK</span>';
  const subChip = isLive ? '<span class="live-chip">LIVE</span>' : '<span class="mock-chip">MOCK</span>';
  let freshness = '';
  if (isLive) {
    const ts = ScheduleService.liveState(leg.serviceId).feedTs;
    if (ts) freshness = `<div class="cd-fresh">MTA feed updated ${Math.max(0, Math.round(Date.now() / 1000 - ts))}s ago</div>`;
  }
  const note = isLive
    ? 'LIVE data from the official MTA GTFS-Realtime feed (public, no API key). Not affiliated with the MTA.'
    : 'Illustrative MOCK departure data — not live or verified schedule information.';

  box.innerHTML = `
    <div class="cd-card state-${state}">
      <div class="cd-leg">Leg ${activeLegIndex + 1} of ${c.legs.length} · ${esc(c.name)}</div>
      <div class="cd-op" style="--op:${info.operatorColor}">
        <span class="cd-op-dot"></span>${esc(info.operatorName)}
      </div>
      <div class="cd-badges">${statusPill}</div>
      <div class="cd-headline">${headline}</div>
      <div class="cd-timer${fmtCountdown(msAway).length >= 7 ? ' long' : ''}" id="cdTimer" aria-live="polite">${fmtCountdown(msAway)}</div>
      <div class="cd-sub">until departure at <strong>${fmtClock(primary.when)}</strong> ${subChip}</div>
      ${freshness}

      <div class="cd-details">
        <div class="cd-row"><span class="cd-k">Board at</span><span class="cd-v">${esc(info.originName)}</span></div>
        ${info.line ? `<div class="cd-row"><span class="cd-k">Line</span><span class="cd-v">${esc(info.line)}${isLive ? ' train' : ''}</span></div>` : ''}
        <div class="cd-row"><span class="cd-k">Toward</span><span class="cd-v">${esc(info.destinationName)}</span></div>
        <div class="cd-row"><span class="cd-k">Direction</span><span class="cd-v">${esc(info.direction)}</span></div>
        ${following ? `<div class="cd-row"><span class="cd-k">Following</span><span class="cd-v">${fmtClock(following.when)}</span></div>` : ''}
      </div>

      <div class="cd-legs">${legPills}</div>

      <div class="cd-actions">
        <button class="btn" id="onTrainBtn">${activeLegIndex < c.legs.length - 1 ? "I'm on this train \u2192 Next leg" : "I'm on this train \u2713"}</button>
        ${activeLegIndex > 0 ? '<button class="btn btn-ghost" id="prevLegBtn">\u2190 Previous leg</button>' : ''}
      </div>
      <p class="cd-note">${note}</p>
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
    if (ScheduleService.isLive(leg.serviceId)) maybeRefreshLive(leg, renderCountdown); // keep live data warm
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
