// === Konfiguration (über URL-Parameter überschreibbar) =======================
// ?i=5500 (Initialangebot), ?mf=0.70 (Mindestpreis-Faktor), ?am=0.12 (Auto-Akzept-Marge),
// ?r=6 (Max Runden), ?tmin=1200 ?tmax=2800 (Denkpause in ms)
const Q = new URLSearchParams(location.search);
const CONFIG = {
  INITIAL_OFFER: Number(Q.get('i')) || 5500,
  MIN_PRICE: Q.has('min') ? Number(Q.get('min')) : undefined, // fester Mindestpreis
  MIN_PRICE_FACTOR: Number(Q.get('mf')) || 0.70,               // falls MIN_PRICE nicht gesetzt
  ACCEPT_MARGIN: Number(Q.get('am')) || 0.12,                  // 12% unterm Erstangebot
  MAX_RUNDEN: parseInt(Q.get('r') || '6', 10),
  THINK_DELAY_MS_MIN: parseInt(Q.get('tmin') || '1200', 10),
  THINK_DELAY_MS_MAX: parseInt(Q.get('tmax') || '2800', 10),
};

// Abgeleitete Werte
CONFIG.MIN_PRICE = Number.isFinite(CONFIG.MIN_PRICE)
  ? CONFIG.MIN_PRICE
  : Math.round(CONFIG.INITIAL_OFFER * CONFIG.MIN_PRICE_FACTOR);

// === Hilfsfunktionen =========================================================
const app = document.getElementById('app');
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const randInt = (a,b) => Math.floor(a + Math.random()*(b-a+1));
const eur = n => new Intl.NumberFormat('de-DE', {style:'currency', currency:'EUR'}).format(n);
const roundDownInc = (v, inc) => Math.floor(v / inc) * inc;

// === Zustand ================================================================
function newState(){
  return {
    participant_id: crypto.randomUUID?.() || ('x_'+Date.now()+Math.random().toString(36).slice(2)),
    runde: 1,
    min_price: CONFIG.MIN_PRICE,
    max_price: CONFIG.INITIAL_OFFER,
    initial_offer: CONFIG.INITIAL_OFFER,
    current_offer: CONFIG.INITIAL_OFFER,
    history: [],                // [{runde, algo_offer, proband_counter, accepted}]
    last_concession: null,
    finished: false,
    accepted: false
  };
}
let state = newState();

// === Verhandlungslogik (Port aus Python, „harte“ Boulware-ähnliche Strategie) ===
function shouldAutoAccept(initialOffer, minPrice, counter){
  const margin = (CONFIG.ACCEPT_MARGIN > 0 && CONFIG.ACCEPT_MARGIN < 0.5) ? CONFIG.ACCEPT_MARGIN : 0.12;
  const threshold = Math.max(minPrice, initialOffer * (1 - margin));
  return Number(counter) >= threshold;
}

/** Liefert nächstes Verkäufer-Angebot in Abhängigkeit von Runde & Gegenangebot. */
function computeNextOffer(prevOffer, minPrice, probandCounter, runde, lastConcession){
  const prev = Number(prevOffer);
  const m = Number(minPrice);
  const r = Math.max(1, Math.min(runde, CONFIG.MAX_RUNDEN));

  // Deadline-Druck (später stärker)
  const dp = r / CONFIG.MAX_RUNDEN;
  const deadlinePressure = Math.pow(dp, 4);

  // Falls kein Gegenangebot vorliegt (erste Anzeige in einer Runde)
  if (probandCounter == null) {
    const step = (r <= 3) ? 150 : 100;
    const tentative = Math.max(m, prev - step);
    const rounded = (r <= 3) ? roundDownInc(tentative, 50) : tentative;
    return Math.min(prev, Math.round(rounded * 100) / 100);
  }

  const counter = Number(probandCounter);
  const gap = Math.max(prev - counter, 0);
  // 12% .. 22% der Lücke je nach Runde
  const beta = 0.12 + 0.10 * deadlinePressure;
  let proposedStep = gap * beta;

  // „Nahe“ vs. „weit“ entferntes Angebot relativ zum aktuellen Preis
  const highOffer = counter >= (prev - 1800);

  // Runden-abhängige Bandbreiten & Rundung
  let minStep, maxStep, inc;
  if (r <= 3) {
    if (highOffer) {
      minStep = 180; maxStep = 260;
    } else {
      if (r === 1) { minStep = 240; maxStep = 300; }
      else         { minStep = 200; maxStep = 250; }
    }
    inc = 50;
  } else {
    if (highOffer) { minStep = 120; maxStep = 260; }
    else           { minStep = 200; maxStep = 250; }
    inc = 1;
  }

  // Schritt begrenzen + Runden-Kappung
  let step = clamp(proposedStep, minStep, maxStep);
  const cap = (r === 1) ? 300 : 250;
  step = Math.min(step, cap);

  // Angebot vorschlagen
  let tentative = Math.max(m, prev - step);
  if (inc === 50) tentative = roundDownInc(tentative, 50);

  // leichte Glättung vs. letzte Konzession (keine wilden Sprünge)
  if (lastConcession != null) {
    const diff = Math.abs(step - lastConcession);
    if (diff > 80) {
      const capFinal = (r <= 3) ? 250 : 200;
      const newCons = clamp(step, minStep, capFinal);
      const cand1 = Math.max(minStep, Math.min(capFinal, newCons - 10));
      const cand2 = Math.max(minStep, Math.min(capFinal, newCons + 10));
      const altCons = (cand1 >= minStep) ? cand1 : cand2;
      tentative = Math.max(m, prev - altCons);
      if (inc === 50) tentative = roundDownInc(tentative, 50);
      step = altCons;
    }
  }

  let nextOffer = Math.round(tentative * 100) / 100;

  // Monotonie sicherstellen
  if (nextOffer > prev) {
    const fallback = prev - (r <= 3 ? 50 : 10);
    nextOffer = Math.max(m, fallback);
  }
  return nextOffer;
}

// === Rendering der „Screens“ =================================================
function viewVignette(){
  app.innerHTML = `
    <h1>Designer-Verkaufsmesse</h1>
    <p class="muted">Stelle dir folgende Situation vor:</p>
    <p>Du bist auf einer <b>exklusiven Verkaufsmesse</b> für Designermöbel.
       Eine Person möchte ihr <b>gebrauchtes Designer-Ledersofa</b> verkaufen.
       Ihr verhandelt gleich über den Verkaufspreis.</p>
    <p>Auf der nächsten Seite beginnt die Preisverhandlung mit der Verkäuferseite.
       Du kannst jeweils ein <b>Gegenangebot</b> eingeben oder das Angebot annehmen.</p>
    <div class="grid">
      <div class="pill">max. ${CONFIG.MAX_RUNDEN} Runden</div>
      <button id="startBtn">Verhandlung starten</button>
    </div>
  `;
  document.getElementById('startBtn').addEventListener('click', () => {
    state = newState();
    logEvent('start', { probandCode: window.probandCode, playerId: window.playerId, state });
    viewNegotiate();
  });
}

function viewThink(next){
  const delay = randInt(CONFIG.THINK_DELAY_MS_MIN, CONFIG.THINK_DELAY_MS_MAX);
  app.innerHTML = `
    <h1>Die Verkäuferseite überlegt<span class="pulse">&hellip;</span></h1>
    <p class="muted">Bitte einen Moment Geduld.</p>
  `;
  setTimeout(next, delay);
}

function historyTable(){
  if (!state.history.length) return '';
  const rows = state.history.map(h => `
    <tr>
      <td>${h.runde}</td>
      <td>${eur(h.algo_offer)}</td>
      <td>${h.proband_counter != null ? eur(h.proband_counter) : '-'}</td>
      <td>${h.accepted ? 'Ja' : 'Nein'}</td>
    </tr>`).join('');
  return `
    <h2>Verlauf</h2>
    <table>
      <thead><tr><th>Runde</th><th>Angebot Verkäuferseite</th><th>Gegenangebot</th><th>Angenommen?</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function viewNegotiate(errorMsg){
  app.innerHTML = `
    <h1>Verkaufsverhandlung</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="grid">
      <div class="card" style="padding:16px;background:#fafafa;border-radius:12px;border:1px dashed var(--accent);">
        <div><strong>Aktuelles Angebot der Verkäuferseite:</strong> ${eur(state.current_offer)}</div>
      </div>

      <label for="counter">Dein Gegenangebot in €</label>
      <div class="row">
        <input id="counter" type="number" step="0.01" min="0" required />
        <button id="sendBtn">Gegenangebot senden</button>
      </div>

      <button id="acceptBtn" class="ghost">Angebot annehmen &amp; Verhandlung beenden</button>
    </div>

    ${historyTable()}

    ${errorMsg ? `<p style="color:#b91c1c;"><strong>Fehler:</strong> ${errorMsg}</p>` : ``}
  `;

  document.getElementById('sendBtn').addEventListener('click', () => {
    const val = document.getElementById('counter').value.trim().replace(',','.');
    const num = Number(val);
    if (!Number.isFinite(num) || num < 0){ viewNegotiate('Bitte eine gültige Zahl ≥ 0 eingeben.'); return; }

    // Auto-Accept?
    if (shouldAutoAccept(state.initial_offer, state.min_price, num)) {
      // Abschluss mit Einigung
      state.history.push({ runde: state.runde, algo_offer: state.current_offer, proband_counter: num, accepted: true });
      state.accepted = true; state.finished = true;
      logEvent('round', { runde: state.runde, algo_offer: state.current_offer, counter: num, accepted:true });
      viewThink(() => viewFinish(true));
      return;
    }

    // Nächstes Angebot berechnen
    const next = computeNextOffer(state.current_offer, state.min_price, num, state.runde, state.last_concession);
    const concession = state.current_offer - next;

    // Verlauf & Zustand aktualisieren
    state.history.push({ runde: state.runde, algo_offer: state.current_offer, proband_counter: num, accepted:false });
    state.current_offer = next;
    state.last_concession = concession;

    logEvent('round', { runde: state.runde, counter: num, new_offer: next, concession });

    // Rundenfortschritt / Ende?
    if (state.runde >= CONFIG.MAX_RUNDEN) {
      state.finished = true;
      viewThink(() => viewDecision());   // letzte Entscheidung
    } else {
      state.runde += 1;
      viewThink(() => viewNegotiate());
    }
  });

  document.getElementById('acceptBtn').addEventListener('click', () => {
    // Proband nimmt aktuelles Angebot an
    state.history.push({ runde: state.runde, algo_offer: state.current_offer, proband_counter: null, accepted:true });
    state.accepted = true; state.finished = true;
    logEvent('accept', { runde: state.runde, offer: state.current_offer });
    viewThink(() => viewFinish(true));
  });
}

function viewDecision(){
  // Letzte Runde erreicht – Proband kann letztes Angebot annehmen oder ohne Einigung beenden
  app.innerHTML = `
    <h1>Letzte Runde der Verhandlung erreicht.</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="grid">
      <div class="card" style="padding:16px;background:#fafafa;border-radius:12px;border:1px dashed var(--accent);">
        <div><strong>Letztes Angebot der Verkäuferseite:</strong> ${eur(state.current_offer)}</div>
      </div>
      <button id="takeBtn">Letztes Angebot annehmen</button>
      <button id="noBtn" class="ghost">Ohne Einigung beenden</button>
    </div>

    ${historyTable()}
  `;
  document.getElementById('takeBtn').addEventListener('click', () => {
    state.history.push({ runde: state.runde, algo_offer: state.current_offer, proband_counter: null, accepted:true });
    state.accepted = true; state.finished = true;
    logEvent('finish_accept', { last_round: state.runde, last_offer: state.current_offer });
    viewThink(() => viewFinish(true));
  });
  document.getElementById('noBtn').addEventListener('click', () => {
    state.history.push({ runde: state.runde, algo_offer: state.current_offer, proband_counter: null, accepted:false });
    state.accepted = false; state.finished = true;
    logEvent('finish_no', { last_round: state.runde, last_offer: state.current_offer });
    viewThink(() => viewFinish(false));
  });
}

function viewFinish(accepted){
  app.innerHTML = `
    <h1>Verhandlung abgeschlossen</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="grid">
      <div class="card" style="padding:16px;background:#fafafa;border-radius:12px;border:1px dashed var(--accent);">
        <div><strong>Ergebnis:</strong>
          ${accepted
            ? `Annahme in Runde ${state.runde}. Letztes Angebot der Verkäuferseite: ${eur(state.current_offer)}.`
            : `Maximale Rundenzahl erreicht. Letztes Angebot der Verkäuferseite: ${eur(state.current_offer)}.`}
        </div>
      </div>
      <button id="restartBtn">Neue Verhandlung starten</button>
    </div>

    ${historyTable()}
  `;
  document.getElementById('restartBtn').addEventListener('click', () => {
    state = newState();
    logEvent('restart', { });
    viewVignette();
  });
}

// === Startbildschirm =========================================================
viewVignette();
