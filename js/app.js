/* ============================================================================
 * Where Do I Park? — UMD parking recommender (unofficial)
 * Static, client-side. Loads data/buildings.json + data/lots.json, then applies
 * a rules engine based on UMD DOTS published parking rules.
 * ========================================================================== */

const state = {
  who: null,          // 'visitor' | 'student' | 'facstaff'
  studentPermit: 'commuter',
  studentCredit: '0-29',
  studentHousing: 'fratrow',
  fsPermit: 'annual',
  primaryLot: '',     // faculty/staff assigned lot (user-entered)
  building: null,     // {name,lat,lng}
  day: 'weekday',
  time: '10:00',
  duration: 3,
};

/* Lot assignments, transcribed from the DOTS Parking Regulations (2025-26).
 * Tokens are matched against a lot's `base` OR its `aliases`
 * (Lot 6 = Terrapin Trail Garage, Lot 19 = Mowatt Garage, SDG = Stadium Dr). */
const COMMUTER_LOTS = {
  '0-29':  ['6', '9', '11'],
  '30-59': ['1', '6', '9', '11', 'SDG'],
  '60-89': ['1', '6', '9', '11', 'SDG'],
  '90+':   ['1', '6', '9', '11', 'SDG'],
};
const RESIDENT_LOTS = {          // plus60 lots require 60+ credits earned
  fratrow:     { lots: ['16'],            plus60: [] },
  northhill:   { lots: ['2', '3', '6'],   plus60: ['19'] },
  southcommons:{ lots: ['2', '3', '6'],   plus60: ['19'] },
  cambridge:   { lots: ['2', '6'],        plus60: [] },
  graham:      { lots: ['15', '16'],      plus60: [] },
};
const OVERNIGHT_LOTS = ['11', '17', '19'];

function lotMatches(lot, tokens) {
  return tokens.some(t => lot.base === t || (lot.aliases || []).includes(t));
}
function has60plus() {
  return state.studentCredit === '60-89' || state.studentCredit === '90+';
}

let BUILDINGS = [];
let LOTS = [];
let UPDATES = [];
let mapObj = null;

// Derived from active DOTS updates vs. today's date (see refreshAlerts).
let alerts = { active: [], upcoming: [] };
let liveParking = { openTokens: new Set(), affectedTokens: new Set(), freeAll: false };

/* --------------------------------------------------------- data loading --- */
async function loadData() {
  const [b, l, u] = await Promise.all([
    fetch('data/buildings.json').then(r => r.json()),
    fetch('data/lots.json').then(r => r.json()),
    fetch('data/updates.json').then(r => r.json()).catch(() => []),
  ]);
  BUILDINGS = b;
  LOTS = l;
  UPDATES = u;
  refreshAlerts();
  populateBuildings();
  populatePrimaryLots();
}

/* Split the DOTS updates snapshot into active / upcoming relative to today,
 * and precompute which lots are currently "open to all" or affected. */
function refreshAlerts() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const soon = new Date(today); soon.setDate(soon.getDate() + 14);
  const parse = s => s ? new Date(s + 'T00:00:00') : null;

  alerts = { active: [], upcoming: [] };
  liveParking = { openTokens: new Set(), affectedTokens: new Set(), freeAll: false };

  for (const u of UPDATES) {
    const start = parse(u.start), end = parse(u.end);
    const active = (!start || start <= today) && (!end || end >= today);
    const upcoming = start && start > today && start <= soon;
    if (active) alerts.active.push(u);
    else if (upcoming) alerts.upcoming.push(u);
    if (!active) continue;

    const toks = [...(u.lots || []), ...(u.garages || [])];
    if (u.category === 'open_parking') toks.forEach(t => liveParking.openTokens.add(t));
    if (u.category === 'closure') toks.forEach(t => liveParking.affectedTokens.add(t));
    if (u.category === 'free') liveParking.freeAll = true;
  }
}

function tokenHits(lot, set) {
  if (!set.size) return false;
  if (set.has(lot.base)) return true;
  return (lot.aliases || []).some(a => set.has(a));
}

function populateBuildings() {
  const dl = document.getElementById('building-list');
  dl.innerHTML = BUILDINGS.map(b => `<option value="${escapeHtml(b.name)}">`).join('');
}

function populatePrimaryLots() {
  const sel = document.getElementById('primary-lot');
  // Only real named lots (skip garages for the "assigned lot" picker unless FS)
  const opts = LOTS
    .filter(l => l.kind === 'lot' || l.kind === 'garage')
    .map(l => `<option value="${escapeHtml(l.code)}">${escapeHtml(l.code)}${l.kind === 'garage' ? ' (garage)' : ''}</option>`)
    .join('');
  sel.insertAdjacentHTML('beforeend', opts);
}

/* --------------------------------------------------------- geo helpers ---- */
function haversine(aLat, aLng, bLat, bLng) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (bLat - aLat) * toR, dLng = (bLng - aLng) * toR;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s)); // meters
}
const walkMin = m => Math.max(1, Math.round(m / 1.35 / 60)); // ~1.35 m/s

/* --------------------------------------------------------- time helpers --- */
function parseHour(t) {                 // "14:30" -> 14.5
  const [h, m] = t.split(':').map(Number);
  return h + (m || 0) / 60;
}
// Enforcement / rule windows keyed off the published DOTS language.
function timeContext() {
  const h = parseHour(state.time);
  const weekend = state.day === 'weekend';
  return {
    hour: h,
    weekend,
    after4: h >= 16,               // black-text lots unrestricted after 4pm
    after8: h >= 20,               // modified-restriction lots open after 8pm
    overnight: h >= 23 || h < 7,   // storage territory
    visitorEnforced: h >= 7 && h < 24, // 7am–midnight, 7 days
    // "generally open" = weekend any time, or weekday after 4pm
    generallyOpen: weekend || h >= 16,
  };
}

/* --------------------------------------------------------- rules engine --- */
/* Returns {eligible, cost, free, note, badge[]} for a lot given state+time. */
function evaluateLot(lot, tc) {
  const badges = [];
  const primary = state.primaryLot;

  /* -------- DOTS live "open to all" alert (overrides normal rules) -------- */
  if (tokenHits(lot, liveParking.openTokens)) {
    const b = [{ t: 'Open to all right now (DOTS)', c: 'free' }];
    if (lot.kind === 'garage') b.push({ t: 'Garage', c: 'type' });
    if (tokenHits(lot, liveParking.affectedTokens))
      b.push({ t: 'DOTS: spaces affected — check signs', c: 'warn' });
    return { eligible: true, cost: 0, free: true, badges: b, alert: true,
      note: 'Temporary open parking — no permit needed here right now.' };
  }

  /* ---------------- VISITOR ---------------- */
  if (state.who === 'visitor') {
    if (!lot.visitor_ok) return null;          // MVP: recommend visitor garages
    let cost, free;
    if (liveParking.freeAll) {                 // DOTS holiday free-parking day
      cost = 0; free = true;
      badges.push({ t: 'Free today (DOTS holiday)', c: 'free' });
    } else if (!tc.visitorEnforced) {          // free midnight–7am
      cost = 0; free = true;
      badges.push({ t: 'Free right now (before 7am)', c: 'free' });
    } else {
      cost = Math.min(state.duration * 4, 20); // $4/hr, $20 daily max
      free = false;
      badges.push({ t: `$${cost}${cost === 20 ? ' (daily max)' : ''}`, c: 'cost' });
    }
    badges.push({ t: 'Visitor garage', c: 'type' });
    return { eligible: true, cost, free, badges,
      note: 'Pay at the garage pay station or via ParkMobile.' };
  }

  /* ---------------- STUDENT ---------------- */
  if (state.who === 'student') {
    let eligible = false, note = '', free = false, assigned = false;

    if (state.studentPermit === 'overnight') {
      if (lotMatches(lot, OVERNIGHT_LOTS)) {
        eligible = assigned = true;
        note = 'Overnight storage lot (Lots 11, 17 & 19).';
      }
    } else if (state.studentPermit === 'commuter') {
      const lots = COMMUTER_LOTS[state.studentCredit] || [];
      if (lotMatches(lot, lots)) {
        eligible = assigned = true;
        note = 'Your commuter lot for this class standing.';
      }
    } else { // resident
      const cfg = RESIDENT_LOTS[state.studentHousing] || { lots: [], plus60: [] };
      if (lotMatches(lot, cfg.lots)) {
        eligible = assigned = true; note = 'Your resident lot.';
      } else if (lotMatches(lot, cfg.plus60)) {
        if (has60plus()) { eligible = assigned = true; note = 'Resident lot (60+ credits).'; }
      }
    }

    // After 4pm weekday / all weekend, non-restricted numbered lots open to all
    // students — a handy free option even if not your assigned lot.
    if (!eligible && tc.generallyOpen && lot.kind === 'lot'
        && lot.student_numbered && lot.base !== '2') {
      eligible = true; free = true;
      note = tc.weekend ? 'Open to all after 4pm Fri & weekends.'
                        : 'Unrestricted after 4pm.';
    }
    if (!eligible) return null;

    badges.unshift(free ? { t: 'Free after 4pm', c: 'free' }
                        : { t: 'Covered by permit', c: 'free' });
    if (lot.kind === 'garage') badges.push({ t: 'Garage', c: 'type' });
    // Commuter lots: no parking 3–5am Mon–Fri.
    if (assigned && state.studentPermit === 'commuter'
        && !tc.weekend && tc.hour >= 3 && tc.hour < 5) {
      badges.push({ t: 'Closed 3–5am (commuter)', c: 'warn' });
    }
    // Athletic/special-event relocation lots.
    if (lot.athletic) badges.push({ t: 'May move for games/events', c: 'warn' });
    return { eligible, cost: 0, free: true, badges, note };
  }

  /* ---------------- FACULTY / STAFF ---------------- */
  if (state.who === 'facstaff') {
    const isPrimary = primary && lot.code === primary;
    let eligible = false, note = '';

    if (state.fsPermit === 'annual' && isPrimary) {
      eligible = true; note = 'Your assigned lot.';
    } else if (lot.fs_overflow) {
      eligible = true;
      note = lot.kind === 'garage' ? 'Faculty/staff overflow garage.'
                                   : 'Faculty/staff overflow lot.';
    } else if (tc.after4 && lot.facstaff_lettered) {
      // After 4pm lettered lots become unrestricted to F/S w/ registration
      eligible = true; note = 'Unrestricted to faculty/staff after 4pm.';
    } else if (tc.generallyOpen && lot.student_numbered && lot.base !== '2') {
      eligible = true; note = 'Unrestricted after 4pm / weekends.';
    }
    if (!eligible) return null;
    badges.unshift({ t: 'Covered by permit', c: 'free' });
    if (lot.kind === 'garage') badges.push({ t: 'Garage', c: 'type' });
    if (lot.athletic) badges.push({ t: 'May move for games/events', c: 'warn' });
    return { eligible, cost: 0, free: true, badges, note };
  }
  return null;
}

/* Rank eligible lots: distance first, cost as tiebreak (matters for visitors). */
function recommend() {
  const tc = timeContext();
  const b = state.building;
  const scored = [];
  for (const lot of LOTS) {
    const ev = evaluateLot(lot, tc);
    if (!ev) continue;
    // Flag lots with an active DOTS closure/impact alert (unless already noted).
    if (!ev.alert && tokenHits(lot, liveParking.affectedTokens))
      ev.badges.push({ t: 'DOTS: spaces affected — check signs', c: 'warn' });
    const dist = haversine(b.lat, b.lng, lot.lat, lot.lng);
    scored.push({ lot, ev, dist });
  }
  const cmp = (a, z) => (a.ev.cost - z.ev.cost) * 30 + (a.dist - z.dist); // ~30m per $1
  scored.sort(cmp);

  // Collapse sub-lots: keep only the nearest entry per base lot (e.g. don't let
  // 16a/16b/16f take all three slots — they're one lot). Garages are their own base.
  const seenBase = new Set();
  const top = [];
  for (const s of scored) {
    if (seenBase.has(s.lot.base)) continue;
    seenBase.add(s.lot.base);
    top.push(s);
    if (top.length === 3) break;
  }

  // If none of the top picks is a garage, offer the closest eligible garage too —
  // some folks want covered/simple parking (weather, security).
  let extraGarage = null;
  if (!top.some(s => s.lot.kind === 'garage')) {
    extraGarage = scored.find(s => s.lot.kind === 'garage'
      && !seenBase.has(s.lot.base));
  }
  return { top, extraGarage };
}

/* --------------------------------------------------------- rendering ------ */
function recCard(r, rankLabel, opts = {}) {
  const badges = r.ev.badges.map(bd =>
    `<span class="badge ${bd.c}">${escapeHtml(bd.t)}</span>`).join('');
  const title = r.lot.kind === 'garage' ? escapeHtml(r.lot.code)
                                        : 'Lot ' + escapeHtml(r.lot.code);
  const tag = opts.tag ? `<span class="rec-tag">${escapeHtml(opts.tag)}</span>` : '';
  return `
  <div class="rec ${opts.best ? 'best' : ''} ${opts.garage ? 'garage-pick' : ''}">
    <div class="rank">${rankLabel}</div>
    <div class="rec-body">
      <h3>${title} ${tag}</h3>
      <div class="rec-meta">
        <span>🚶 <b>${walkMin(r.dist)} min</b> walk (${Math.round(r.dist)} m)</span>
        <span>${r.ev.cost > 0 ? `💵 <b>$${r.ev.cost}</b>` : '✅ <b>No extra cost</b>'}</span>
      </div>
      <div class="rec-note">${escapeHtml(r.ev.note || '')}</div>
      <div class="badges">${badges}</div>
    </div>
  </div>`;
}

function renderResults() {
  const { top, extraGarage } = recommend();
  const tc = timeContext();
  const list = document.getElementById('rec-list');
  const summary = document.getElementById('results-summary');

  const whoLabel = { visitor: 'Visitor', student: 'Student', facstaff: 'Faculty/Staff' }[state.who];
  summary.textContent =
    `${whoLabel} • ${state.building.name} • ${state.day === 'weekend' ? 'Weekend' : 'Weekday'} ` +
    `at ${fmtTime(state.time)}`;

  renderAlerts();

  if (!top.length) {
    list.innerHTML = `<div class="card"><p>No clearly-eligible lots found for this
      combination. Your safest option is a visitor garage (pay hourly) or checking the
      <a href="https://transportation.umd.edu/parking" target="_blank" rel="noopener">official rules</a>.</p></div>`;
  } else {
    let html = top.map((r, i) => recCard(r, String(i + 1), { best: i === 0 })).join('');
    if (extraGarage)
      html += recCard(extraGarage, '🅿️', { garage: true, tag: 'Closest garage' });
    list.innerHTML = html;
  }

  const mapMarkers = extraGarage ? top.concat(extraGarage) : top;
  renderCaveats(tc);
  showEl('results');
  hideEl('wizard');
  requestAnimationFrame(() => renderMap(mapMarkers, !!extraGarage));
  document.getElementById('results').scrollIntoView({ behavior: 'smooth' });
}

/* Active + upcoming DOTS alerts panel above the recommendations. */
function renderAlerts() {
  const box = document.getElementById('results-alerts');
  if (!box) return;
  const all = [...alerts.active.map(a => ({ a, live: true })),
               ...alerts.upcoming.map(a => ({ a, live: false }))];
  if (!all.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const rows = all.map(({ a, live }) => `
    <div class="alert ${live ? 'live' : 'soon'}">
      <span class="alert-flag">${live ? 'ACTIVE' : 'SOON'}</span>
      <div>
        <b>${escapeHtml(a.title)}</b>
        <span class="alert-when">${escapeHtml(fmtRange(a.start, a.end))}</span>
        <div class="alert-text">${escapeHtml(a.text)}</div>
      </div>
    </div>`).join('');
  box.innerHTML =
    `<div class="alerts-head">📣 DOTS parking updates</div>${rows}
     <a class="alerts-src" href="https://transportation.umd.edu/" target="_blank"
        rel="noopener">See all DOTS updates ↗</a>`;
}
function fmtRange(s, e) {
  const f = d => new Date(d + 'T00:00:00').toLocaleDateString(undefined,
    { month: 'short', day: 'numeric' });
  if (s && e) return `${f(s)} – ${f(e)}`;
  if (s) return `from ${f(s)}`;
  if (e) return `through ${f(e)}`;
  return 'ongoing';
}

function renderCaveats(tc) {
  const items = [
    `<strong>Always check the sign.</strong> A lot sign with <em>red text</em> has unique
     restrictions — it overrides any suggestion here.`,
    `Distances are straight-line estimates, not walking routes.`,
  ];
  if (state.who !== 'visitor')
    items.push(`Most lots are unrestricted after 4pm on weekdays and all weekend, but
      <em>Lot 2</em> and some restricted lots are not.`);
  if (state.who === 'visitor')
    items.push(`Beyond garages, many <em>surface lots</em> accept visitor payment via
      ParkMobile — look for a zone number on the sign. Visitor rate is $4/hr, $20/day max,
      enforced 7am–midnight daily.`);
  if (state.who === 'student' && state.studentPermit === 'commuter')
    items.push(`Commuter registrations may not park <strong>3–5am, Mon–Fri</strong> in
      commuter lots.`);
  if (state.who === 'student')
    items.push(`Lots marked <em>“may move for games/events”</em> require relocating for
      home football/basketball and some special events.`);
  const portal = (state.who === 'student' || state.who === 'facstaff')
    ? `<p class="portal-cta">Manage or renew your permit at the
       <a href="https://umd.aimsparking.com/" target="_blank" rel="noopener">UMD parking portal ↗</a>
       (login required).</p>` : '';
  document.getElementById('results-caveats').innerHTML =
    `<strong>Before you drive:</strong><ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>${portal}`;
}

/* --------------------------------------------------------- map ------------ */
function pin(cls, label) {
  return L.divIcon({ className: '', html:
    `<div class="map-pin ${cls}"><span>${label}</span></div>`,
    iconSize: [26, 26], iconAnchor: [13, 26] });
}
function renderMap(recs, hasGarage) {
  const b = state.building;
  if (mapObj) { mapObj.remove(); mapObj = null; }
  mapObj = L.map('map', { scrollWheelZoom: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap contributors',
  }).addTo(mapObj);

  const pts = [[b.lat, b.lng]];
  L.marker([b.lat, b.lng], { icon: pin('dest', '★') })
    .addTo(mapObj).bindPopup(`<b>${escapeHtml(b.name)}</b><br>Your destination`);

  const lastIsGarage = hasGarage;
  recs.forEach((r, i) => {
    const isExtra = lastIsGarage && i === recs.length - 1;
    const label = isExtra ? 'P' : String(i + 1);
    const cls = isExtra ? 'garage' : (i === 0 ? 'best' : '');
    pts.push([r.lot.lat, r.lot.lng]);
    L.marker([r.lot.lat, r.lot.lng], { icon: pin(cls, label) })
      .addTo(mapObj)
      .bindPopup(`<b>${r.lot.kind === 'garage' ? '' : 'Lot '}${escapeHtml(r.lot.code)}</b><br>${walkMin(r.dist)} min walk`);
    L.polyline([[b.lat, b.lng], [r.lot.lat, r.lot.lng]],
      { color: isExtra ? '#3b4ba8' : (i === 0 ? '#ffb300' : '#e21833'),
        weight: 2, dashArray: '4 5', opacity: .7 })
      .addTo(mapObj);
  });
  mapObj.fitBounds(pts, { padding: [40, 40] });
}

/* --------------------------------------------------------- wizard flow ---- */
function goStep(n) {
  document.querySelectorAll('#wizard .step').forEach(s =>
    s.classList.toggle('hidden', +s.dataset.step !== n));
  document.querySelectorAll('#stepbar li').forEach(li => {
    const s = +li.dataset.step;
    li.classList.toggle('active', s === n);
    li.classList.toggle('done', s < n);
  });
}

function configureStep2() {
  const s = state.who;
  showHide('permit-student', s === 'student');
  showHide('permit-facstaff', s === 'facstaff');
  showHide('visitor-note', s === 'visitor');
  showHide('portal-note', s === 'student' || s === 'facstaff');
  showHide('duration-field', s === 'visitor');  // duration only affects visitor cost
  updateStudentFields();
  updatePrimaryLotVisibility();
  document.getElementById('permit-title').textContent =
    s === 'visitor' ? 'Visitor parking' : 'Your permit';
}
function updateStudentFields() {
  if (state.who !== 'student') return;
  const p = state.studentPermit;
  // credits matter for commuters (lot set) and residents (Lot 19 access)
  showHide('credit-field', p === 'commuter' || p === 'resident');
  showHide('housing-field', p === 'resident');
}
function updatePrimaryLotVisibility() {
  // Only faculty/staff enter an individually-assigned lot; students are
  // assigned by class standing / housing (derived above).
  showHide('primary-lot-field', state.who === 'facstaff' && state.fsPermit === 'annual');
}

/* --------------------------------------------------------- utils ---------- */
function escapeHtml(s) { return String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function showEl(id) { document.getElementById(id).classList.remove('hidden'); }
function hideEl(id) { document.getElementById(id).classList.add('hidden'); }
function showHide(id, on) { document.getElementById(id).classList.toggle('hidden', !on); }
function fmtTime(t) {
  let [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}

/* --------------------------------------------------------- events --------- */
function wire() {
  // Step 1
  document.querySelectorAll('#who-choices .choice').forEach(btn => {
    btn.addEventListener('click', () => {
      state.who = btn.dataset.value;
      document.querySelectorAll('#who-choices .choice').forEach(b => b.classList.remove('sel'));
      btn.classList.add('sel');
      configureStep2();
      goStep(2);
    });
  });
  // Step 2 selects
  document.getElementById('student-permit').addEventListener('change', e => {
    state.studentPermit = e.target.value; updateStudentFields();
  });
  document.getElementById('student-credit').addEventListener('change', e => {
    state.studentCredit = e.target.value;
  });
  document.getElementById('student-housing').addEventListener('change', e => {
    state.studentHousing = e.target.value;
  });
  document.getElementById('fs-permit').addEventListener('change', e => {
    state.fsPermit = e.target.value; updatePrimaryLotVisibility();
  });
  document.getElementById('primary-lot').addEventListener('change', e => {
    state.primaryLot = e.target.value;
  });
  document.getElementById('to-step3').addEventListener('click', () => goStep(3));

  // Step 3 building search
  const bin = document.getElementById('building-search');
  bin.addEventListener('input', () => {
    const m = BUILDINGS.find(b => b.name.toLowerCase() === bin.value.trim().toLowerCase());
    state.building = m || null;
    document.getElementById('to-step4').disabled = !m;
  });
  document.getElementById('to-step4').addEventListener('click', () => goStep(4));

  // Step 4
  document.getElementById('day-select').addEventListener('change', e => state.day = e.target.value);
  document.getElementById('time-select').addEventListener('change', e => state.time = e.target.value);
  document.getElementById('duration-select').addEventListener('change', e => state.duration = +e.target.value);
  document.getElementById('get-results').addEventListener('click', () => {
    if (!state.building) { goStep(3); return; }
    renderResults();
  });

  // back buttons + start over
  document.querySelectorAll('[data-goto]').forEach(b =>
    b.addEventListener('click', () => goStep(+b.dataset.goto)));
  document.getElementById('start-over').addEventListener('click', () => {
    hideEl('results'); showEl('wizard'); goStep(1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

loadData().then(wire).catch(err => {
  document.querySelector('main').insertAdjacentHTML('afterbegin',
    `<div class="card"><p>Couldn't load parking data (${escapeHtml(err.message)}).
     If you're viewing this as a local file, run it from a small web server instead.</p></div>`);
});
