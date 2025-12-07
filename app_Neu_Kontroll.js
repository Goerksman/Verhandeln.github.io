/* ========================================================================== */
/* Konfiguration via URL                                                     */
/* ========================================================================== */
const Q = new URLSearchParams(location.search);
const CONFIG = {
  INITIAL_OFFER: Number(Q.get('i')) || 5500,
  MIN_PRICE: Q.has('min') ? Number(Q.get('min')) : undefined,
  MIN_PRICE_FACTOR: Number(Q.get('mf')) || 0.70,
  ACCEPT_MARGIN: Number(Q.get('am')) || 0.12,
  // Zufällige Rundenzahl 8–12 (optional über rmin/rmax konfigurierbar)
  ROUNDS_MIN: parseInt(Q.get('rmin') || '8', 10),
  ROUNDS_MAX: parseInt(Q.get('rmax') || '12', 10),
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

// sendRow erweitert um player_id & proband_code
const sendRow = (row) => {
  const payload = {
    participant_id: state?.participant_id,
    player_id: window.playerId,
    proband_code: window.probandCode,
    ...row
  };
  if (window.sendRow) {
    window.sendRow(payload);
  } else {
    console.log('[sendRow fallback]', payload);
  }
};

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
    // Zufällige Rundenanzahl 8–12 (oder aus CONFIG)
    max_runden: randInt(CONFIG.ROUNDS_MIN, CONFIG.ROUNDS_MAX),

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
/* Abbruchwahrscheinlichkeit                                                 */
/* ========================================================================== */

function abortProbability(userOffer) {
  let chance = 0;

  // 1) Extrem unverschämte Angebote sofort sehr riskant
  if (userOffer < 1500) return 100;

  // 2) Angebote <2250 erhöhen Risiko stark
  if (userOffer < UNACCEPTABLE_LIMIT) {
    chance += randInt(20, 40);
  }

  // 3) Bereich 2250–3000 → kleine Schritte gefährlich
  const last = state.history[state.history.length - 1];
  if (userOffer >= UNACCEPTABLE_LIMIT && userOffer < 3000) {
    if (last && last.proband_counter != null) {
      const diff = Math.abs(userOffer - Number(last.proband_counter));
      if (diff < 100) {
        chance += randInt(10, 25);
      }
    }
  }

  // 4) Bereich 3000–3700 → leichte Zufallswahrscheinlichkeit
  if (userOffer >= 3000 && userOffer < 3700) {
    chance += randInt(1, 7);
  }

  // 5) Bereich 3700–4000 → kaum Risiko
  if (userOffer >= 3700 && userOffer < 4000) {
    chance += randInt(0, 3);
  }

  // 6) Ab 4000 → diff-Regel entfällt, Risiko nur minimal
  if (userOffer >= 4000) {
    chance += randInt(0, 2);
  }

  // 7) Pro Runde steigt Risiko leicht
  chance += state.runde * 2;

  return Math.min(chance, 75);
}

function maybeAbort(userOffer) {
  const chance = abortProbability(userOffer);
  const roll = randInt(1, 100);

  if (roll <= chance) {

    // Logging des Abbruchs
    sendRow({
      participant_id: state.participant_id,
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: userOffer,
      accepted: false,
      finished: true,
      deal_price: ''
    });

    // Letzte Aktion in den Verlauf schreiben
    state.history.push({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: userOffer,
      accepted: false
    });

    state.finished = true;
    state.accepted = false;
    state.finish_reason = 'abort';

    viewAbort(chance);
    return true;
  }
  return false;
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
/* Angebotslogik (8–12 Runden)                                               */
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
    <p class="muted"><b>Hinweis:</b> Die Verhandlung dauert zufällig ${CONFIG.ROUNDS_MIN}–${CONFIG.ROUNDS_MAX} Runden.</p>
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
/* Abbruch-Screen                                                             */
/* ========================================================================== */

function viewAbort(chance){
  app.innerHTML = `
    <h1>Verhandlung abgebrochen</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card" style="padding:16px;border:1px dashed var(--accent);">
      <strong>Die Verkäuferseite hat die Verhandlung beendet.</strong>
      <p class="muted" style="margin-top:8px;">Abbruchwahrscheinlichkeit in dieser Runde: ${chance}%</p>
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
/* Hauptscreen der Verhandlung                                                */
/* ========================================================================== */

function viewNegotiate(errorMsg){
  const abortChance = abortProbability(state.current_offer);
  let color = '#16a34a';
  if (abortChance > 50) color = '#ea580c';
  else if (abortChance > 25) color = '#eab308';

  app.innerHTML = `
    <h1>Verkaufsverhandlung</h1>
    <p class="muted">Spieler-ID: ${window.playerId ?? '-'}</p>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="grid">
      <div class="card" style="padding:16px;border:1px dashed var(--accent);">
        <strong>Aktuelles Angebot:</strong> ${eur(state.current_offer)}
      </div>

      <div style="
        background:${color}22;
        border-left:6px solid ${color};
        padding:10px;
        border-radius:8px;
        margin-bottom:10px;">
        <b style="color:${color};">Abbruchwahrscheinlichkeit:</b>
        <span style="color:${color}; font-weight:600;">${abortChance}%</span>
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
  /* EXTREM UNAKZEPTABLE ANGEBOTE (<1500) → Sofortiger Abbruch              */
  /* ---------------------------------------------------------------------- */
  if (num < 1500) {

    state.history.push({
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: false
    });

    sendRow({
      participant_id: state.participant_id,
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: false,
      finished: true,
      deal_price: ''
    });

    state.finished = true;
    state.accepted = false;
    state.finish_reason = 'abort';

    return viewAbort(100);
  }

  /* ---------------------------------------------------------------------- */
  /* UNAKZEPTABLE ANGEBOTE (1500–<2250)                                     */
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

    if (state.runde >= state.max_runden) {
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

  // Abbruchwahrscheinlichkeit prüfen (kann sofort beenden)
  if (maybeAbort(num)) {
    return;
  }

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

  if (state.runde >= state.max_runden) {
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
