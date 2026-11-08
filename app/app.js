// FareLink — Build 1: unified transit commerce (simulated).
// "One journey. One payment. Every ride."
//
// ILLUSTRATIVE MOCK DATA ONLY. Checkout is SIMULATED: no real payment is
// processed and NO real or authorized tickets are issued. Every ticket is a
// DEMO artifact and is not valid for travel.
//
// Flow: select a journey -> review a combined ticket basket (existing passes
// cover matching legs for $0) -> complete a simulated checkout -> tickets land
// in a persistent (localStorage) journey wallet.

const ORDERS_KEY = 'farelink_demo_orders_v1';
const PASSES_KEY = 'farelink_demo_passes_v1';

let FARES = null;
let selectedJourneyId = null;     // current selection (session)
const heldPasses = {};            // periodPassId -> bool (existing passes held)
let orders = [];                  // persisted simulated orders

const money = n => `$${n.toFixed(2)}`;

// ---- Robust helpers: never fail silently -----------------------------------

// Get an element by id or throw a clear, debuggable error.
function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing page element #${id} (HTML/JS out of sync — try a hard refresh).`);
  return node;
}

// Show a visible banner at the top of the page if anything fails to load.
function showFatalError(err) {
  console.error('[FareLink] load failed:', err);
  let banner = document.getElementById('fatal-error');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'fatal-error';
    banner.style.cssText =
      'margin:0 auto 20px;max-width:540px;background:#7f1d1d;color:#fff;border:1px solid #ef4444;' +
      'border-radius:12px;padding:14px 16px;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;';
    const wrap = document.querySelector('.wrap') || document.body;
    wrap.insertBefore(banner, wrap.firstChild);
  }
  banner.innerHTML =
    '<strong>FareLink couldn\u2019t load.</strong> ' +
    String(err && err.message ? err.message : err) +
    '<br><span style="opacity:.85">Fix: run <code>python3 -m http.server</code> from the <code>app/</code> folder and hard-refresh (Cmd/Ctrl+Shift+R).</span>';
}

// ---- Persistence (safe if storage unavailable) -----------------------------

function loadState() {
  try { orders = JSON.parse(localStorage.getItem(ORDERS_KEY)) || []; } catch { orders = []; }
  let savedPasses = {};
  try { savedPasses = JSON.parse(localStorage.getItem(PASSES_KEY)) || {}; } catch { savedPasses = {}; }
  for (const pass of allPasses()) heldPasses[pass.id] = !!savedPasses[pass.id];
}
function saveOrders() { try { localStorage.setItem(ORDERS_KEY, JSON.stringify(orders)); } catch {} }
function savePasses() { try { localStorage.setItem(PASSES_KEY, JSON.stringify(heldPasses)); } catch {} }

// ---- Helpers ---------------------------------------------------------------

function allPasses() {
  const out = [];
  for (const s of FARES.systems) for (const p of s.periodPasses) out.push({ ...p, system: s.id, operator: s.operator });
  return out;
}

// Does any held pass cover this leg under the mock rules? (system-level coverage)
function coveringPassFor(leg) {
  for (const pass of allPasses()) {
    if (heldPasses[pass.id] && pass.system === leg.system) return pass;
  }
  return null;
}

// Build the basket for a journey: each leg becomes a line, covered or charged.
function buildBasket(journey) {
  const lines = journey.legs.map(leg => {
    const cover = coveringPassFor(leg);
    return {
      leg,
      covered: !!cover,
      coveringPassName: cover ? cover.name : null,
      charge: cover ? 0 : leg.price
    };
  });
  const total = lines.reduce((s, l) => s + l.charge, 0);
  return { lines, total };
}

function randId(prefix) {
  return prefix + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ---- UI: Step 1 (journey + existing passes) --------------------------------

function renderJourneySelect() {
  const sel = el('journey');
  sel.innerHTML = '<option value="">Select a journey…</option>';
  for (const j of FARES.journeys) {
    const opt = document.createElement('option');
    opt.value = j.id;
    opt.textContent = j.name;
    if (j.id === selectedJourneyId) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', e => {
    selectedJourneyId = e.target.value || null;
    renderBasket();
  });
}

function renderPasses() {
  const box = el('passes');
  box.innerHTML = '';
  for (const pass of allPasses()) {
    const row = document.createElement('label');
    row.className = 'pass';
    row.innerHTML = `
      <input type="checkbox" data-pass="${pass.id}" ${heldPasses[pass.id] ? 'checked' : ''} />
      <span class="pass-name">${pass.name} <span class="mock-tag">MOCK</span></span>
      <span class="pass-detail">${pass.operator} · covers matching legs at no charge</span>`;
    row.querySelector('input').addEventListener('change', e => {
      heldPasses[pass.id] = e.target.checked;
      savePasses();
      renderBasket();
    });
    box.appendChild(row);
  }
}

// ---- UI: Step 2 (combined basket + simulated checkout) ---------------------

function renderBasket() {
  const out = el('basket');
  const journey = FARES.journeys.find(j => j.id === selectedJourneyId);
  if (!journey) {
    out.innerHTML = `<p class="result-hint">Pick a journey in Step 1 to see your combined ticket basket.</p>`;
    return;
  }
  const { lines, total } = buildBasket(journey);
  const items = lines.map(l => `
    <li>
      <div class="leg-top">
        <span class="leg-label"><span class="op-chip">${l.leg.operator}</span> ${l.leg.label}</span>
        <span class="leg-price">${l.covered ? 'Covered' : money(l.charge)}</span>
      </div>
      ${l.covered
        ? `<div class="leg-reason">Covered by your ${l.coveringPassName} — no new ticket charged.</div>`
        : `<div class="leg-reason">New single ticket (illustrative mock fare).</div>`}
    </li>`).join('');

  out.innerHTML = `
    <div class="basket-head">One basket · ${journey.legs.length} legs · ${new Set(journey.legs.map(l=>l.operator)).size} operators</div>
    <ul class="legs">${items}</ul>
    <div class="total-card">
      <div class="total-label">One combined payment (simulated)</div>
      <div class="total-value">${money(total)}</div>
    </div>
    <button class="btn" id="checkoutBtn">Complete simulated checkout</button>
    <p class="note">Simulated only — no real payment is processed and no real tickets are issued.</p>`;

  document.getElementById('checkoutBtn').addEventListener('click', () => simulateCheckout(journey));
}

// ---- Simulated checkout ----------------------------------------------------

function simulateCheckout(journey) {
  const { lines, total } = buildBasket(journey);
  const order = {
    id: randId('FL-SIM-'),
    simulated: true,
    journeyName: journey.name,
    paidTotal: total,
    issuedAt: new Date().toISOString(),
    tickets: lines.map(l => ({
      ticketId: randId('FL-DEMO-'),
      operator: l.leg.operator,
      legLabel: l.leg.label,
      covered: l.covered,
      coveringPassName: l.coveringPassName,
      charge: l.charge,
      status: l.covered ? 'Covered by pass' : 'Valid (demo)'
    }))
  };
  orders.unshift(order);
  saveOrders();

  // Start a fresh journey for the next order.
  selectedJourneyId = null;
  document.getElementById('journey').value = '';
  renderBasket();
  renderWallet();
  document.getElementById('wallet').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- UI: Step 3 (persistent journey wallet) --------------------------------

function renderWallet() {
  const out = el('wallet');
  if (orders.length === 0) {
    out.innerHTML = `<p class="result-hint">Your simulated journey tickets will appear here after checkout. They persist across refreshes on this device.</p>`;
    return;
  }

  const ordersHtml = orders.map(o => {
    const tickets = o.tickets.map(t => `
      <div class="ticket">
        <div class="ticket-top">
          <span class="op-chip">${t.operator}</span>
          <span class="demo-badge">DEMO — Not valid for travel</span>
        </div>
        <div class="ticket-route">${t.legLabel}</div>
        <div class="ticket-meta">
          <span class="ticket-status ${t.covered ? 'covered' : 'valid'}">${t.status}</span>
          <span class="ticket-id">${t.ticketId}</span>
        </div>
        ${t.covered ? `<div class="leg-reason">Covered by ${t.coveringPassName}.</div>` : ''}
      </div>`).join('');
    return `
      <div class="order">
        <div class="order-head">
          <div>
            <span class="sim-badge">SIMULATED ORDER</span>
            <span class="order-id">${o.id}</span>
          </div>
          <span class="order-total">${money(o.paidTotal)} paid (simulated)</span>
        </div>
        <div class="order-journey">${o.journeyName} · ${new Date(o.issuedAt).toLocaleString()}</div>
        <div class="tickets">${tickets}</div>
      </div>`;
  }).join('');

  out.innerHTML = `
    ${ordersHtml}
    <button class="btn btn-ghost" id="clearWalletBtn">Clear demo wallet</button>
    <p class="note">Demonstration wallet only. Orders are simulated and stored locally in your browser — not real purchases, not valid for travel.</p>`;

  document.getElementById('clearWalletBtn').addEventListener('click', () => {
    orders = [];
    saveOrders();
    renderWallet();
  });
}

// ---- Boot ------------------------------------------------------------------

async function init() {
  // Cache-bust so a stale app.js/JSON can never run against new markup.
  let res;
  try {
    res = await fetch('data/mock_fares.json?v=' + Date.now(), { cache: 'no-store' });
  } catch (e) {
    throw new Error('Could not fetch mock_fares.json (are you serving over http, not file://?).');
  }
  if (!res.ok) throw new Error(`mock_fares.json returned HTTP ${res.status}.`);
  try {
    FARES = await res.json();
  } catch (e) {
    throw new Error('mock_fares.json is not valid JSON.');
  }
  if (!FARES || !Array.isArray(FARES.journeys) || !Array.isArray(FARES.systems)) {
    throw new Error('mock_fares.json is missing "journeys" or "systems".');
  }

  loadState();
  renderJourneySelect();
  renderPasses();
  renderBasket();
  renderWallet();

  el('newJourneyBtn').addEventListener('click', () => {
    selectedJourneyId = null;
    el('journey').value = '';
    renderBasket();
    el('journey').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

init().catch(showFatalError);
