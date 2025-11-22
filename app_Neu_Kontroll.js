// === Konfiguration (über URL-Parameter überschreibbar) =======================
const Q = new URLSearchParams(location.search);
const CONFIG = {
  INITIAL_OFFER: Number(Q.get('i')) || 5500,
  MIN_PRICE: Q.has('min') ? Number(Q.get('min')) : undefined,
  MIN_PRICE_FACTOR: Number(Q.get('mf')) || 0.70,
  ACCEPT_MARGIN: Number(Q.get('am')) || 0.12,
  // Standard jetzt 7 Runden statt 6
  MAX_RUNDEN: parseInt(Q.get('r') || '7', 10),
  THINK_DELAY_MS_MIN: parseInt(Q.get('tmin') || '1200', 10),
  THINK_DELAY_MS_MAX: parseInt(Q.get('tmax') || '2800', 10),
  ACCEPT_RANGE_MIN: Number(Q.get('armin')) || 4700,
  ACCEPT_RANGE_MAX: Number(Q.get('armax')) || 4800
};

// Abgeleitet
CONFIG.MIN_PRICE = Number.isFinite(CONFIG.MIN_PRICE)
  ? CONFIG.MIN_PRICE
  : Math.round(CONFIG.INITIAL_OFFER * CONFIG.MIN_PRICE_FACTOR);

// === Konstanten für die neue Logik ==========================================

// Grenzwert für "unakzeptable" Angebote
const UNACCEPTABLE_LIMIT = 2250;

// Prozentschritte für rundenweise Anpassung
// ERWEITERT: 2,0 % bis 3,0 % in 0,1 %-Schritten => 11 Werte
const PERCENT_STEPS = [
  0.02, 0.021, 0.022, 0.023, 0.024, 0.025,
  0.026, 0.027, 0.028, 0.029, 0.03
];

// Feste Euro-Schritte für Runden 4 & 5 (bei "normalen" Probanden)
// ERWEITERT wie gewünscht bis 420:
const EURO_STEPS = [
  250, 260, 270, 280, 290, 300, 310,
  320, 330, 340, 350, 360, 370, 380, 390, 400, 410, 420
];

// === Hilfsfunktionen =========================================================
const app = document.getElementById('app');
const sendRow = (row) => (window.sendRow ? window.sendRow(row) : console.log('[sendRow fallback]', row));
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const randInt = (a,b) => Math.floor(a + Math.random()*(b-a+1));
const eur = n => new Intl.NumberFormat('de-DE', {style:'currency', currency:'EUR'}).format(n);
const roundDownInc = (v, inc) => Math.floor(v / inc) * inc; // aktuell nicht mehr genutzt, kann aber bleiben
const randomChoice = (arr) => arr[randInt(0, arr.length - 1)];

// NEU: Rundung auf die nächste 50er-Stufe (z.B. 4.689,65 -> 4.700; 4.674,99 -> 4.650)
const roundToNearest50 = (v) => Math.round(v / 50) * 50;

// === Zustand =================================================================
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
    // True, wenn es mind. ein Angebot < 2.250 € vor dem ersten akzeptablen gab
    hasUnacceptable: false,
    // True, sobald es mind. ein Angebot >= 2.250 € gab
    hasCrossedThreshold: false,
    // Verwarnungslogik
    warningCount: 0,
    warningText: '',
    // Grund, warum die Verhandlung beendet wurde
    finish_reason: null
  };
}
let state = newState();

// === Logik ===================================================================

// Auto-Accept-Regel:
// - Neu: innerhalb von 5% des aktuellen Angebots.
// - Zusätzlich: alte Range-/Margin-Logik.
function shouldAutoAccept(initialOffer, minPrice, prevOffer, counter){
  const c = Number(counter);
  if (!Number.isFinite(c)) return false;

  // 1.5: innerhalb von maximal 5 % vom vorherigen Algorithmus-Angebot
  const diff = Math.abs(prevOffer - c);
  if (diff <= prevOffer * 0.05) {
    return true;
  }

  // Alte "Range"-Regel (z.B. 4.700–4.800 €)
  if (c >= CONFIG.ACCEPT_RANGE_MIN && c <= CONFIG.ACCEPT_RANGE_MAX) return true;

  // Alte "Margin"-Regel (z.B. 12 % unter dem Initialangebot, aber nicht unter MIN_PRICE)
  const margin = (CONFIG.ACCEPT_MARGIN > 0 && CONFIG.ACCEPT_MARGIN < 0.5) ? CONFIG.ACCEPT_MARGIN : 0.12;
  const threshold = Math.max(minPrice, initialOffer * (1 - margin));
  return c >= threshold;
}

// Neue Angebotslogik gemäß 1.2–1.4 und 2.2
function computeNextOffer(prevOffer, minPrice, probandCounter, runde, lastConcession){
  const prev = Number(prevOffer);
  const m = Number(minPrice);
  const r = Number(runde);

  // HILFSFUNKTIONEN MIT 50er-RUNDUNG
  const applyPercentDown = () => {
    const p = randomChoice(PERCENT_STEPS);
    const raw = prev * (1 - p);
    let rounded = roundToNearest50(raw);
    // nicht unter min_price und nicht über das vorherige Angebot
    const bounded = Math.max(m, Math.min(rounded, prev));
    return bounded;
  };

  const applyEuroDown = () => {
    const step = randomChoice(EURO_STEPS);
    const raw = prev - step;
    let rounded = roundToNearest50(raw);
    const bounded = Math.max(m, Math.min(rounded, prev));
    return bounded;
  };

  const applyPercentUp = () => {
    const p = randomChoice(PERCENT_STEPS);
    const raw = prev * (1 + p);
    let rounded = roundToNearest50(raw);
    // nicht unter prev und nicht über Initialangebot
    const bounded = Math.min(state.initial_offer, Math.max(rounded, prev));
    return bounded;
  };

  // Wichtig: r bezieht sich auf die aktuelle Verhandlungsrunde,
  // das Ergebnis wird als Angebot in der NÄCHSTEN Runde angezeigt.

  // Runde 2 & 3 (Angebote) -> Eingaben in Runde 1 & 2:
  // Immer prozentual nach unten.
  if (r === 1 || r === 2) {
    return applyPercentDown();
  }

  // Runde 4 & 5 (Angebote) -> Eingaben in Runde 3 & 4:
  // Normale Probanden: feste Euro-Schritte 250–420 €.
  // Lowballer (hasUnacceptable): NUR prozentuale Schritte, keine großen Sprünge.
  if (r === 3 || r === 4) {
    if (state.hasUnacceptable) {
      return applyPercentDown();
    } else {
      return applyEuroDown();
    }
  }

  // Runde 6 & 7 (Angebote) -> Eingaben in Runde 5 & 6:
  // Wieder prozentual nach oben.
  if (r === 5 || r === 6) {
    return applyPercentUp();
  }

  // In der letzten (7.) Runde wird faktisch kein neues Gegenangebot mehr berechnet.
  return prev;
}

// === Screens =================================================================
function viewVignette(){
  app.innerHTML = `
    <h1>Designer-Verkaufsmesse</h1>
    <p class="muted">Stelle dir folgende Situation vor:</p>
    <p>Du befindest dich auf einer <b>exklusiven Verkaufsmesse</b> für Designermöbel.
       Eine Besucherin bzw. ein Besucher möchte ihre/seine <b>gebrauchtes Designer-Ledersofa</b> verkaufen.
       Es handelt sich um ein hochwertiges, gepflegtes Stück mit einzigartigem Design.
       Auf der Messe siehst du viele verschiedene Designer-Couches; die Preisspanne
       liegt typischerweise zwischen <b>2.500 € und 10.000 €</b>. Du kommst ins Gespräch und ihr
       verhandelt über den Verkaufspreis.</p>
    <p>Auf der nächsten Seite beginnt die Preisverhandlung mit der <b>Verkäuferseite</b>.
       Du kannst ein <b>Gegenangebot</b> eingeben oder das Angebot annehmen. Achte darauf, dass die Messe
       gut besucht ist und die Verkäuferseite realistisch bleiben möchte, aber selbstbewusst in
       die Verhandlung geht.</p>
    <p class="muted"><b>Hinweis:</b> Die Verhandlung umfasst maximal ${CONFIG.MAX_RUNDEN} Runden.</p>
    <div class="grid">
      <label class="consent">
        <input id="consent" type="checkbox" />
        <span>Ich stimme zu, dass meine Eingaben zu <b>forschenden Zwecken</b> gespeichert und anonym ausgewertet werden dürfen.</span>
      </label>
      <div><button id="startBtn" disabled>Verhandlung starten</button></div>
    </div>`;
  const consent = document.getElementById('consent');
  const startBtn = document.getElementById('startBtn');
  const sync = () => { startBtn.disabled = !consent.checked; };
  consent.addEventListener('change', sync); sync();
  startBtn.addEventListener('click', () => {
    if (!consent.checked) return;
    state = newState();
    viewNegotiate();
  });
}

function viewThink(next){
  const delay = randInt(CONFIG.THINK_DELAY_MS_MIN, CONFIG.THINK_DELAY_MS_MAX);
  app.innerHTML = `
    <h1>Die Verkäuferseite überlegt<span class="pulse">&hellip;</span></h1>
    <p class="muted">Bitte einen Moment Geduld.</p>`;
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
      <thead><tr><th>Runde</th><th>Angebot Verkäuferseite</th><th>Gegenangebot</th><th>Angenommen?</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
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
    ${state.warningText
      ? `<p style="color:#b45309;background:#fffbeb;border:1px solid #fbbf24;padding:8px 10px;border-radius:8px;">
           <strong>Verwarnung:</strong> ${state.warningText}
         </p>`
      : ``}
    ${errorMsg
      ? `<p style="color:#b91c1c;"><strong>Fehler:</strong> ${errorMsg}</p>`
      : ``}
  `;

  const inputEl = document.getElementById('counter');
  const sendBtn = document.getElementById('sendBtn');

  function handleSubmit(){
    const val = inputEl.value.trim().replace(',','.');
    const num = Number(val);
    if (!Number.isFinite(num) || num < 0){
      viewNegotiate('Bitte eine gültige Zahl ≥ 0 eingeben.');
      return;
    }

    const prevOffer = state.current_offer;

    // Auto-Accept (inkl. 5%-Regel)
    if (shouldAutoAccept(state.initial_offer, state.min_price, prevOffer, num)) {
      state.history.push({ runde: state.runde, algo_offer: prevOffer, proband_counter: num, accepted: true });
      state.accepted = true;
      state.finished = true;
      state.finish_reason = 'accepted';
      sendRow({
        participant_id: state.participant_id,
        runde: state.runde,
        algo_offer: prevOffer,
        proband_counter: num,
        accepted: true,
        finished: true,
        deal_price: num
      });
      viewThink(() => viewFinish(true));
      return;
    }

    // 2.0 / 2.1 + Verwarnungslogik: Unakzeptable Angebote (< 2.250 €)
    if (num < UNACCEPTABLE_LIMIT) {
      // Lowballer merken, solange noch kein akzeptables Angebot kam
      if (!state.hasCrossedThreshold) {
        state.hasUnacceptable = true;
      }

      // Verwarnungszähler erhöhen
      state.warningCount = (state.warningCount || 0) + 1;
      const isSecondWarning = state.warningCount >= 2;

      // Text für die aktuelle Verwarnung setzen (dein gewünschter Text)
      state.warningText =
        'Ein solches Angebot ist sehr inakzeptabel. Bei einem erneuten Angebot in der Art, möchte die Verhandlung an der Stelle nicht mehr weiterführen.';

      // Verkäuferseite macht KEIN Zugeständnis
      const rowData = {
        participant_id: state.participant_id,
        runde: state.runde,
        algo_offer: prevOffer,
        proband_counter: num,
        accepted: false,
        finished: isSecondWarning  // bei 2. Verwarnung als beendet markieren
      };
      sendRow(rowData);

      state.history.push({
        runde: state.runde,
        algo_offer: prevOffer,
        proband_counter: num,
        accepted: false
      });
      state.current_offer = prevOffer;
      state.last_concession = 0;

      if (isSecondWarning) {
        // Verhandlung abbrechen
        state.finished = true;
        state.accepted = false;
        state.finish_reason = 'warnings';
        viewThink(() => viewFinish(false));
      } else {
        // Nach der ersten Verwarnung ganz normal in die nächste Runde / ggf. Max-Runden-Ende
        if (state.runde >= CONFIG.MAX_RUNDEN) {
          state.finished = true;
          state.finish_reason = 'max_rounds';
          viewThink(() => viewDecision());
        } else {
          state.runde += 1;
          viewThink(() => viewNegotiate());
        }
      }
      return;
    }

    // Ab hier: akzeptable Angebote (>= 2.250 €)

    if (!state.hasCrossedThreshold) {
      state.hasCrossedThreshold = true;
    }

    // vorhandene Verwarnungstexte zurücksetzen
    state.warningText = '';

    // Normale Runde mit neuer Strategie
    const prev = state.current_offer;
    const next = computeNextOffer(prev, state.min_price, num, state.runde, state.last_concession);
    const concession = prev - next;

    sendRow({
      participant_id: state.participant_id,
      runde: state.runde,
      algo_offer: prev,
      proband_counter: num,
      accepted: false,
      finished: false
    });

    state.history.push({ runde: state.runde, algo_offer: prev, proband_counter: num, accepted:false });
    state.current_offer = next;
    state.last_concession = concession;

    if (state.runde >= CONFIG.MAX_RUNDEN) {
      state.finished = true;
      state.finish_reason = 'max_rounds';
      viewThink(() => viewDecision());
    } else {
      state.runde += 1;
      viewThink(() => viewNegotiate());
    }
  }

  // Button + Enter
  sendBtn.addEventListener('click', handleSubmit);
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); } });

  // Verkäufer-Angebot annehmen
  document.getElementById('acceptBtn').addEventListener('click', () => {
    state.history.push({ runde: state.runde, algo_offer: state.current_offer, proband_counter: null, accepted:true });
    state.accepted = true; state.finished = true;
    state.finish_reason = 'accepted';
    sendRow({
      participant_id: state.participant_id,
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: '',
      accepted: true,
      finished: true,
      deal_price: state.current_offer
    });
    viewThink(() => viewFinish(true));
  });
}

function viewDecision(){
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
    state.finish_reason = 'accepted';
    sendRow({
      participant_id: state.participant_id,
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: '',
      accepted: true,
      finished: true,
      deal_price: state.current_offer
    });
    viewThink(() => viewFinish(true));
  });
  document.getElementById('noBtn').addEventListener('click', () => {
    state.history.push({ runde: state.runde, algo_offer: state.current_offer, proband_counter: null, accepted:false });
    state.accepted = false; state.finished = true;
    state.finish_reason = 'max_rounds';
    sendRow({
      participant_id: state.participant_id,
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: '',
      accepted: false,
      finished: true
    });
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
            : (state.finish_reason === 'warnings'
                ? `Verhandlung aufgrund wiederholt unakzeptabler Angebote abgebrochen. Letztes Angebot der Verkäuferseite: ${eur(state.current_offer)}.`
                : `Maximale Rundenzahl erreicht. Letztes Angebot der Verkäuferseite: ${eur(state.current_offer)}.`)}
        </div>
      </div>
      <button id="restartBtn">Neue Verhandlung starten</button>
    </div>
    ${historyTable()}
  `;
  document.getElementById('restartBtn').addEventListener('click', () => {
    state = newState();
    viewVignette();
  });
}

// === Start ===================================================================
viewVignette();
