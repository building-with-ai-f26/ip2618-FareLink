// Deterministic tests for LinkWise core logic (no browser, no network).
//
// Loads app/app.js inside a vm sandbox with minimal browser stubs so we can
// exercise the REAL ScheduleService + helpers against fixed timestamps.
//
// Run:  node tests/schedule_logic.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const schedule = JSON.parse(fs.readFileSync(path.join(root, 'app/data/mock_schedule.json'), 'utf8'));
const appSrc = fs.readFileSync(path.join(root, 'app/app.js'), 'utf8')
  // Expose const/function bindings (vm doesn't surface lexical decls on the context).
  + '\n;Object.assign(globalThis, { ScheduleService, toMinutes, fmtCountdown, suggestCommuteId, loadCommutes, getCommutes: () => commutes });';

// --- Minimal browser stubs --------------------------------------------------
const noop = () => {};
const fakeEl = () => ({
  innerHTML: '', className: '', style: {}, classList: { add: noop, remove: noop, contains: () => false },
  addEventListener: noop, querySelectorAll: () => [], querySelector: () => null,
  appendChild: noop, insertBefore: noop, scrollIntoView: noop, setAttribute: noop,
  getAttribute: () => null, closest: () => null, textContent: ''
});
const sandbox = {
  console,
  document: {
    getElementById: () => fakeEl(),
    querySelector: () => fakeEl(),
    createElement: () => fakeEl(),
    body: fakeEl()
  },
  localStorage: (() => { const m = {}; return {
    getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; }
  }; })(),
  setInterval: () => 0, clearInterval: noop,
  // init() fetches the schedule; resolve it so boot succeeds.
  fetch: async () => ({ ok: true, status: 200, json: async () => schedule }),
  Date, Math, JSON, Array, Object
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(appSrc, sandbox, { filename: 'app.js' });

const { ScheduleService, toMinutes, fmtCountdown, suggestCommuteId, loadCommutes } = sandbox;
ScheduleService.init(schedule); // ensure initialized regardless of boot timing
loadCommutes();                 // seed sample commutes synchronously for tests

// --- Tiny assert harness ----------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${detail ? ' — ' + detail : ''}`); }
}

// Fixed reference day: Wednesday, Jan 15 2025 (getDay() === 3, a weekday).
const wed = (h, m, s = 0) => new Date(2025, 0, 15, h, m, s);
const sat = (h, m) => new Date(2025, 0, 18, h, m, 0); // Saturday

console.log('\ntoMinutes / fmtCountdown');
check('toMinutes parses 07:56', toMinutes('07:56') === 7 * 60 + 56);
check('toMinutes rejects junk', toMinutes('nope') === null);
check('toMinutes rejects 24:00', toMinutes('24:00') === null);
check('fmtCountdown mm:ss under an hour', fmtCountdown(5 * 60000 + 9000) === '5:09');
check('fmtCountdown h:mm:ss over an hour', fmtCountdown(3600000 + 2 * 60000 + 3000) === '1:02:03');
check('fmtCountdown clamps negatives to 0:00', fmtCountdown(-5000) === '0:00');

console.log('\nScheduleService.upcomingDepartures — next eligible departure');
{
  // Light rail Port Imperial->Hoboken has a 07:56 departure.
  const deps = ScheduleService.upcomingDepartures('hblr_port_imperial_to_hoboken', wed(7, 50));
  check('at 7:50 the soonest HBLR departure is 07:56', deps[0] && deps[0].hhmm === '07:56', deps[0] && deps[0].hhmm);
  check('following departure is 08:04', deps[1] && deps[1].hhmm === '08:04', deps[1] && deps[1].hhmm);
}
{
  // Once 07:56 passes, it must roll forward to the next one.
  const deps = ScheduleService.upcomingDepartures('hblr_port_imperial_to_hoboken', wed(7, 57));
  check('at 7:57 (just missed 07:56) soonest is 08:04', deps[0] && deps[0].hhmm === '08:04', deps[0] && deps[0].hhmm);
}
{
  // afterTime (preferred window) filters earlier departures today.
  const deps = ScheduleService.upcomingDepartures('hblr_port_imperial_to_hoboken', wed(6, 0), { afterTime: '07:56' });
  check('afterTime=07:56 yields 07:56 as first even at 6:00', deps[0] && deps[0].hhmm === '07:56', deps[0] && deps[0].hhmm);
}

console.log('\nWeekday validity — weekend rolls to next weekday');
{
  // Saturday: these services run Mon-Fri only, so the next departure is Monday.
  const deps = ScheduleService.upcomingDepartures('hblr_port_imperial_to_hoboken', sat(7, 0));
  check('no departures found earlier than Monday on a Saturday',
    deps.length > 0 && deps[0].when.getDay() === 1, deps[0] && String(deps[0].when));
  check('runsOn is false on Saturday', ScheduleService.runsOn('hblr_port_imperial_to_hoboken', sat(7, 0)) === false);
  check('runsOn is true on Wednesday', ScheduleService.runsOn('hblr_port_imperial_to_hoboken', wed(7, 0)) === true);
}

console.log('\ndescribeService — display fields');
{
  const info = ScheduleService.describeService('path_hoboken_to_33rd');
  check('operator name resolves', info.operatorName === 'PATH');
  check('origin resolves to Hoboken', info.originName === 'Hoboken', info.originName);
  check('direction is present', /33rd Street-bound/.test(info.direction), info.direction);
}

console.log('\nsuggestCommuteId — day/time relevance');
{
  // Seed the two sample commutes into the loaded `commutes` array via localStorage path.
  // suggestCommuteId reads module-level `commutes`; it was seeded during boot.
  const morningId = suggestCommuteId(wed(7, 30)); // morning window
  check('morning time suggests "Morning to NYU"', morningId === 'morning_to_nyu', morningId);
  const eveningId = suggestCommuteId(wed(17, 0)); // evening window
  check('evening time suggests "Evening Home"', eveningId === 'evening_home', eveningId);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
