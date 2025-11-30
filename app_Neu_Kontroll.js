/* ========================================================================== */
/* Konfiguration via URL                                                     */
/* ========================================================================== */
const Q = new URLSearchParams(location.search);
const CONFIG = {
  INITIAL_OFFER: Number(Q.get('i')) || 5500,
  MIN_PRICE: Q.has('min') ? Number(Q.get('min')) : undefined,
  MIN_PRICE_FACTOR: Number(Q.get('mf')) || 0.70,
  ACCEPT_MARGIN: Number(Q.get('am')) || 0.12,
  MAX_RUNDEN: parseInt(Q.get('r') || '8', 10),
  THINK_DELAY_MS_MIN: parseInt(Q.get('tmin') || '1200', 10),
  THINK_DELAY_MS_MAX: parseInt(Q.get('tmax') || '2800', 10),
  ACCEPT_RANGE_MIN: Number(Q.get('armin')) || 4700,
  ACCEPT_RANGE_MAX: Number(Q.get('armax')) || 4800
};
CONFIG.MIN_PRICE = Number.isFinite(CONFIG.MIN_PRICE)
  ? CONFIG.MIN_PRICE
  : Math.round(CONFIG.INITIAL_OFFER * CONFIG.MIN_PRICE_FACTOR);

/* ========================================================================== */
/* Konstanten                                                                 */
/* ========================================================================== */
const UNACCEPTABLE_LIMIT = 2250;

const PERCENT_STEPS = [
  0.02, 0.021, 0.022, 0.023, 0.024, 0.025,
  0.026, 0.027, 0.028, 0.029, 0.03
];

const EURO_STEPS = [
  250, 260, 270, 280, 290, 300, 310,
  320, 330, 340, 350, 360, 370, 380, 390, 400, 410, 420
];

/* ========================================================================== */
/* Hilfsfunktionen                                                            */
/* ========================================================================== */
const app = document.getElementById('app');
const sendRow = (row) => (window.sendRow ? window.sendRow(row) : console.log('[sendRow fallback]', row));
const randInt = (a,b) => Math.floor(a + Math.random()*(b-a+1));
const eur = n => new Intl.NumberFormat('de-DE', {style:'currency', currency:'EUR'}).format(n);
const randomChoice = (arr) => arr[randInt(0, arr.length - 1)];
const roundToNearest25 = (v) => Math.round(v / 25) * 25;

/* ========================================================================== */
/* Zustand                                                                    */
/* ========================================================================== */
function newState(){
  return {
    participant_id: crypto.randomUUID?.() || ('x_'+Date.now()+Math.random().toString(36).slice(2)),
    runde: 1,
    min_price: CONFIG.MIN_PRICE,
    max_price: CONFIG.INITIAL_OFFER,
    initial_offer: CONFIG.INITIAL_OFFER,
    current_offer: CONFIG.INITIAL_OFFER,
    history: [],
    last_concession: null,
    finished: false,
    accepted: false,

    hasUnacceptable: false,
    hasCrossedThreshold: false,

    warningCount: 0,
    warningText: '',
    finish_reason: null,
    patternMessage: '',
    deal_price: null
  };
}
let state = newState();

/* ========================================================================== */
/* Auto-Accept-Regeln                                                        */
/* ========================================================================== */

function shouldAutoAccept(initialOffer, minPrice, prevOffer, counter){
  const c = Number(counter);
  if (!Number.isFinite(c)) return false;

  const diff = Math.abs(prevOffer - c);
  if (diff <= prevOffer * 0.05) {
    return true;
  }
  if (c >= CONFIG.ACCEPT_RANGE_MIN && c <= CONFIG.ACCEPT_RANGE_MAX) return true;

  const margin = CONFIG.ACCEPT_MARGIN;
  const threshold = Math.max(minPrice, initialOffer * (1 - margin));
  return c >= threshold;
}

/* ========================================================================== */
/* Mustererkennung                                                            */
/* ========================================================================== */

function getThresholdForAmount(prev){
  if (prev >= 2250 && prev < 3000) return 0.05;
  if (prev >= 3000 && prev < 4000) return 0.04;
  if (prev >= 4000 && prev < 5000) return 0.03;
  return null;
}

function updatePatternMessage(){
  const counters = [];
  for (let h of state.history) {
    let c = h.proband_counter;
    if (c == null || c === '') continue;
    c = Number(c);
    if (!Number.isFinite(c)) continue;
    if (c < UNACCEPTABLE_LIMIT) continue;
    counters.push(c);
  }
  if (counters.length < 3) {
    state.patternMessage = '';
    return;
  }
  let chainLen = 1;
  for (let j = 1; j < counters.length; j++) {
    const prev = counters[j - 1];
    const curr = counters[j];
    const diff = curr - prev;
    if (diff < 0) {
      chainLen = 1;
      continue;
    }
    const threshold = getThresholdForAmount(prev);
    if (threshold == null) {
      chainLen = 1;
      continue;
    }
    if (diff <= prev * threshold) {
      chainLen++;
    } else {
      chainLen = 1;
    }
  }
  if (chainLen >= 3) {
    state.patternMessage =
      'Mit solchen kleinen Erhöhungen wird das schwierig. Geh bitte ein Stück näher an deine Schmerzgrenze, dann finden wir bestimmt schneller einen fairen Deal.';
  } else {
    state.patternMessage = '';
  }
}

/* ========================================================================== */
/* Angebotslogik (8 Runden)                                                   */
/* ========================================================================== */

function computeNextOffer(prevOffer, minPrice, probandCounter, runde, lastConcession){
  const prev = Number(prevOffer);
  const m = Number(minPrice);
  const r = Number(runde);

  const applyPercentDown = () => {
    const p = randomChoice(PERCENT_STEPS);
    const raw = prev * (1 - p);
    let rounded = roundToNearest25(raw);
    return Math.max(m, Math.min(rounded, prev));
  };

  const applyEuroDown = () => {
    const step = randomChoice(EURO_STEPS);
    const raw = prev - step;
    let rounded = roundToNearest25(raw);
    return Math.max(m, Math.min(rounded, prev));
  };

  const applyPercentUp = () => {
    const p = randomChoice(PERCENT_STEPS);
    const raw = prev * (1 + p);
    let rounded = roundToNearest25(raw);
    return Math.min(state.initial_offer, Math.max(rounded, prev));
  };

  if (r <= 3) return applyPercentDown();
  if (r >= 4 && r <= 6) {
    if (state.hasUnacceptable) return applyPercentDown();
    return applyEuroDown();
  }
  if (r === 7 || r === 8) return applyPercentUp();

  return prev;
}

/* ========================================================================== */
/* Rendering-Funktionen                                                       */
/* ========================================================================== */

function viewVignette(){
  app.innerHTML = `
    <h1>Designer-Verkaufsmesse</h1>
    <p class="muted">Stelle dir folgende Situation vor:</p>
    <p>Du befindest dich auf einer <b>exklusiven Verkaufsmesse</b> …</p>
    <p class="muted"><b>Hinweis:</b> Die Verhandlung umfasst maximal ${CONFIG.MAX_RUNDEN} Runden.</p>
    <div class="grid">
      <label class="consent">
        <input id="consent" type="checkbox" />
        <span>Ich stimme zu, dass meine Eingaben anonym gespeichert werden.</span>
      </label>
      <div><button id="startBtn" disabled>Verhandlung starten</button></div>
    </div>`;

  const consent = document.getElementById('consent');
  const startBtn = document.getElementById('startBtn');
  consent.onchange = () => startBtn.disabled = !consent.checked;
  startBtn.onclick = () => { state = newState(); viewNegotiate(); };
}

function viewThink(next){
  const delay = randInt(CONFIG.THINK_DELAY_MS_MIN, CONFIG.THINK_DELAY_MS_MAX);
  app.innerHTML = `
    <h1>Die Verkäuferseite überlegt<span class="pulse">…</span></h1>
    <p class="muted">Bitte warten.</p>`;
  setTimeout(next, delay);
}

function historyTable(){
  if (!state.history.length) return '';
  const rows = state.history.map(h => `
    <tr>
      <td>${h.runde}</td>
      <td>${eur(h.algo_offer)}</td>
      <td>${h.proband_counter != null && h.proband_counter !== '' ? eur(h.proband_counter) : '-'}</td>
      <td>${h.accepted ? 'Ja' : 'Nein'}</td>
    </tr>`).join('');
  return `
    <h2>Verlauf</h2>
    <table>
      <thead><tr><th>Runde</th><th>Angebot Verkäufer</th><th>Gegenangebot</th><th>Angenommen?</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* ========================================================================== */
/* Hauptscreen der Verhandlung                                                */
/* ========================================================================== */

function viewNegotiate(errorMsg){
  app.innerHTML = `
    <h1>Verkaufsverhandlung</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="grid">
      <div class="card" style="padding:16px;border:1px dashed var(--accent);">
        <strong>Aktuelles Angebot:</strong> ${eur(state.current_offer)}
      </div>

      <label for="counter">Dein Gegenangebot (€)</label>
      <div class="row">
        <input id="counter" type="number" step="0.01" min="0" />
        <button id="sendBtn">Gegenangebot senden</button>
      </div>

      <button id="acceptBtn" class="ghost">Angebot annehmen</button>
    </div>

    ${historyTable()}
    ${state.patternMessage ? `<p class="info">${state.patternMessage}</p>` : ''}
    ${state.warningText ? `<p class="warning">${state.warningText}</p>` : ''}
    ${errorMsg ? `<p class="error">${errorMsg}</p>` : ''}
  `;

  const inputEl = document.getElementById('counter');
  const sendBtn = document.getElementById('sendBtn');
  sendBtn.onclick = () => handleSubmit(inputEl.value);
  inputEl.onkeydown = e => { if (e.key === "Enter") handleSubmit(inputEl.value); };

  document.getElementById('acceptBtn').onclick = () => {
    state.history.push({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: null,
      accepted: true
    });

    sendRow({
      participant_id: state.participant_id,
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: '',
      accepted: true,
      finished: true,
      deal_price: state.current_offer
    });

    state.accepted = true;
    state.finished = true;
    state.deal_price = state.current_offer;
    viewThink(() => viewFinish(true));
  };
}

/* ========================================================================== */
/* Handle Submit – zentrale Round-by-Round-Logik + Logging                    */
/* ========================================================================== */

function handleSubmit(raw){
  const val = raw.trim().replace(',','.');
  const num = Number(val);
  if (!Number.isFinite(num) || num < 0){
    return viewNegotiate('Bitte eine gültige Zahl ≥ 0 eingeben.');
  }

  const prevOffer = state.current_offer;

  /* ---------------------------------------------------------------------- */
  /* AUTO-ACCEPT                                                            */
  /* ---------------------------------------------------------------------- */
  if (shouldAutoAccept(state.initial_offer, state.min_price, prevOffer, num)) {

    state.history.push({
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: true
    });

    // LOGGING
    sendRow({
      participant_id: state.participant_id,
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: true,
      finished: true,
      deal_price: num
    });

    state.accepted = true;
    state.finished = true;
    state.deal_price = num;
    return viewThink(() => viewFinish(true));
  }

  /* ---------------------------------------------------------------------- */
  /* UNAKZEPTABLE ANGEBOTE (<2250)                                         */
  /* ---------------------------------------------------------------------- */
  if (num < UNACCEPTABLE_LIMIT) {

    if (!state.hasCrossedThreshold) state.hasUnacceptable = true;

    state.warningCount++;
    const second = state.warningCount >= 2;

    state.warningText =
      'Ein solches Angebot ist sehr inakzeptabel. Bei einem erneuten Angebot in der Art möchte ich nicht weiter verhandeln.';

    // LOGGING
    sendRow({
      participant_id: state.participant_id,
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: false,
      finished: second
    });

    state.history.push({
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: false
    });

    if (second) {
      state.finished = true;
      state.accepted = false;
      state.finish_reason = 'warnings';
      return viewThink(() => viewFinish(false));
    }

    if (state.runde >= CONFIG.MAX_RUNDEN) {
      state.finished = true;
      state.finish_reason = 'max_rounds';
      return viewThink(() => viewDecision());
    }

    state.runde++;
    return viewThink(() => viewNegotiate());
  }

  /* ---------------------------------------------------------------------- */
  /* AKZEPTABLE ANGEBOTE (>=2250)                                          */
  /* ---------------------------------------------------------------------- */

  state.warningText = '';
  if (!state.hasCrossedThreshold) state.hasCrossedThreshold = true;

  const next = computeNextOffer(prevOffer, state.min_price, num, state.runde, state.last_concession);
  const concession = prevOffer - next;

  // LOGGING (jede Runde)
  sendRow({
    participant_id: state.participant_id,
    runde: state.runde,
    algo_offer: prevOffer,
    proband_counter: num,
    accepted: false,
    finished: false
  });

  state.history.push({
    runde: state.runde,
    algo_offer: prevOffer,
    proband_counter: num,
    accepted: false
  });

  updatePatternMessage();

  state.current_offer = next;
  state.last_concession = concession;

  if (state.runde >= CONFIG.MAX_RUNDEN) {
    state.finished = true;
    state.finish_reason = 'max_rounds';
    return viewThink(() => viewDecision());
  }

  state.runde++;
  return viewThink(() => viewNegotiate());
}

/* ========================================================================== */
/* Entscheidung – letzte Runde                                                */
/* ========================================================================== */

function viewDecision(){
  app.innerHTML = `
    <h1>Letzte Runde</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card" style="padding:16px;border:1px dashed var(--accent);">
      <strong>Letztes Angebot:</strong> ${eur(state.current_offer)}
    </div>

    <button id="takeBtn">Annehmen</button>
    <button id="noBtn" class="ghost">Ablehnen</button>

    ${historyTable()}
  `;

  document.getElementById('takeBtn').onclick = () => {

    // History
    state.history.push({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: null,
      accepted:true
    });

    // LOGGING
    sendRow({
      participant_id: state.participant_id,
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: '',
      accepted: true,
      finished: true,
      deal_price: state.current_offer
    });

    state.accepted = true;
    state.finished = true;
    state.deal_price = state.current_offer;
    viewThink(() => viewFinish(true));
  };

  document.getElementById('noBtn').onclick = () => {

    state.history.push({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: null,
      accepted:false
    });

    // LOGGING
    sendRow({
      participant_id: state.participant_id,
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: '',
      accepted: false,
      finished: true
    });

    state.accepted = false;
    state.finished = true;
    state.finish_reason = 'max_rounds';
    viewThink(() => viewFinish(false));
  };
}

/* ========================================================================== */
/* Finish-Screen                                                              */
/* ========================================================================== */

function viewFinish(accepted){
  const dealPrice = state.deal_price ?? state.current_offer;

  let text;
  if (accepted) {
    text = `Einigung in Runde ${state.runde} bei ${eur(dealPrice)}.`;
  } else if (state.finish_reason === 'warnings') {
    text = `Verhandlung wegen mehrfach unakzeptabler Angebote beendet.`;
  } else {
    text = `Maximale Runden erreicht.`;
  }

  app.innerHTML = `
    <h1>Verhandlung abgeschlossen</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card" style="padding:16px;border:1px dashed var(--accent);">
      <strong>Ergebnis:</strong> ${text}
    </div>

    <button id="restartBtn">Neue Verhandlung</button>

    ${historyTable()}
  `;

  document.getElementById('restartBtn').onclick = () => {
    state = newState();
    viewVignette();
  };
}

/* ========================================================================== */
/* Start                                                                      */
/* ========================================================================== */

viewVignette();




