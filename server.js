const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROSTER_SIZE = 28; // Numero massimo di giocatori per rosa

// ─── Sessioni persistenti PIN → profilo (sopravvivono ai restart se vuoi salvarle su file)
// pin (string) → { coachId, name, budgetInitial, budgetCurrent }
const sessions = {};

// ─── Stato asta
let state = {
  players: [],
  queue: [],
  currentPlayer: null,
  bids: [],          // { coachId, coachName, amount, timestamp }
  bidsRevealed: false,
  assigned: [],
  auctionActive: false,
  timer: { enabled: false, duration: 60, remaining: 0, running: false },
  coaches: {}        // coachId → { name, budget, pin, online }
};

let timerInterval = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// Costruisce lo stato visibile per un client specifico
function buildView(ws) {
  const isAdmin = ws.role === 'admin';
  let visibleBids;
  if (state.bidsRevealed) {
    visibleBids = state.bids; // tutti vedono tutto
  } else if (isAdmin) {
    // Admin: solo il nome di chi ha offerto, nessun valore
    visibleBids = state.bids.map(b => ({
      coachId: b.coachId, coachName: b.coachName, hidden: true
    }));
  } else {
    // Coach: solo la propria offerta
    const mine = state.bids.find(b => b.coachId === ws.coachId);
    visibleBids = mine ? [{ ...mine }] : [];
  }
  return { ...state, bids: visibleBids };
}

function sendTo(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sendState(ws) {
  sendTo(ws, { type: 'state', state: buildView(ws) });
}

function broadcastState() {
  wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) sendState(ws); });
}

function getTopBid() {
  if (!state.bids.length) return null;
  return state.bids.reduce((top, b) =>
    b.amount > top.amount ? b :
    b.amount === top.amount && b.timestamp < top.timestamp ? b : top
  );
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  state.timer.running = false;
}

function startTimer() {
  stopTimer();
  state.timer.running = true;
  state.timer.remaining = state.timer.duration;
  broadcastState();
  timerInterval = setInterval(() => {
    state.timer.remaining = Math.max(0, state.timer.remaining - 1);
    broadcastState();
    if (state.timer.remaining <= 0) {
      stopTimer();
      state.auctionActive = false;
      state.bidsRevealed = true;
      broadcastState();
      broadcast({ type: 'bids_revealed', winner: getTopBid(), player: state.currentPlayer, auto: true });
    }
  }, 1000);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Aggiorna il budget nella sessione e nello state
function updateBudget(coachId, newBudget) {
  if (state.coaches[coachId]) state.coaches[coachId].budget = newBudget;
  const pin = state.coaches[coachId]?.pin;
  if (pin && sessions[pin]) sessions[pin].budgetCurrent = newBudget;
}

// ─── HTTP ──────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Non trovato'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else { res.writeHead(404); res.end(); }
});

// ─── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  sendState(ws); // manda stato iniziale

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Admin ───────────────────────────────────────────────────────────────
      case 'register_admin':
        ws.role = 'admin';
        sendTo(ws, { type: 'registered', role: 'admin' });
        sendState(ws);
        break;

      // ── Coach: registra/ripristina via PIN ──────────────────────────────────
      case 'register_coach': {
        const pin = String(msg.pin || '').trim();
        if (!pin) { sendTo(ws, { type: 'reg_error', error: 'PIN mancante' }); return; }

        ws.role = 'coach';
        ws.pin = pin;

        if (sessions[pin]) {
          // ── Ripristino sessione esistente ──────────────────────────────────
          const sess = sessions[pin];
          ws.coachId = sess.coachId;
          ws.coachName = sess.name;

          // Assicura che il coach sia nello state (potrebbe esserci già)
          if (!state.coaches[sess.coachId]) {
            state.coaches[sess.coachId] = {
              name: sess.name,
              budget: sess.budgetCurrent,
              pin,
              online: true
            };
          } else {
            state.coaches[sess.coachId].online = true;
          }

          sendTo(ws, {
            type: 'registered', role: 'coach',
            coachId: ws.coachId,
            coachName: ws.coachName,
            budget: state.coaches[ws.coachId].budget,
            restored: true
          });

        } else {
          // ── Nuova sessione ─────────────────────────────────────────────────
          const coachId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
          const name = (msg.coachName || '').trim() || 'Coach';
          const budget = Math.max(1, parseInt(msg.budget) || 500);

          ws.coachId = coachId;
          ws.coachName = name;

          sessions[pin] = { coachId, name, budgetInitial: budget, budgetCurrent: budget };
          state.coaches[coachId] = { name, budget, pin, online: true };

          sendTo(ws, {
            type: 'registered', role: 'coach',
            coachId, coachName: name, budget, restored: false
          });
        }

        broadcastState();
        break;
      }

      // ── Admin: imposta giocatori ────────────────────────────────────────────
      case 'set_players':
        state.players = msg.players || [];
        state.queue = shuffle(state.players);
        state.currentPlayer = null;
        state.bids = []; state.bidsRevealed = false;
        state.assigned = []; state.auctionActive = false;
        stopTimer();
        broadcastState();
        broadcast({ type: 'players_loaded', count: state.players.length });
        break;

      // ── Admin: configura timer ──────────────────────────────────────────────
      case 'set_timer':
        state.timer.enabled = !!msg.enabled;
        state.timer.duration = Math.max(5, parseInt(msg.duration) || 60);
        if (state.timer.enabled && state.auctionActive) {
          startTimer(); // parte subito se c'è un'asta aperta
        } else if (!state.timer.enabled) {
          stopTimer();
          state.timer.remaining = 0;
        }
        broadcastState();
        break;

      // ── Admin: sceglie giocatore dalla lista (ricerca manuale) ─────────────
      case 'pick_player': {
        const idx = state.queue.findIndex(p => p.name === msg.playerName);
        if (idx < 0) { sendTo(ws, { type: 'pick_error', error: 'Giocatore non trovato nella coda' }); return; }
        stopTimer();
        state.currentPlayer = state.queue.splice(idx, 1)[0];
        state.bids = []; state.bidsRevealed = false; state.auctionActive = true;
        broadcastState();
        broadcast({ type: 'new_player', player: state.currentPlayer });
        if (state.timer.enabled) startTimer();
        break;
      }

      // ── Admin: prossimo giocatore ───────────────────────────────────────────
      case 'next_player':
        stopTimer();
        if (!state.queue.length) {
          state.auctionActive = false; state.currentPlayer = null;
          broadcast({ type: 'auction_ended' });
          broadcastState();
        } else {
          state.currentPlayer = state.queue.shift();
          state.bids = []; state.bidsRevealed = false; state.auctionActive = true;
          broadcastState();
          broadcast({ type: 'new_player', player: state.currentPlayer });
          if (state.timer.enabled) startTimer();
        }
        break;

      // ── Admin: chiudi offerte (senza rivelare) ──────────────────────────────
      case 'close_bidding':
        stopTimer();
        state.auctionActive = false;
        state.bidsRevealed = false;
        broadcastState();
        broadcast({ type: 'bidding_closed' });
        break;

      // ── Admin: scopri offerte ───────────────────────────────────────────────
      case 'reveal_bids':
        state.bidsRevealed = true;
        broadcastState();
        broadcast({ type: 'bids_revealed', winner: getTopBid(), player: state.currentPlayer });
        break;

      // ── Admin: assegna giocatore ────────────────────────────────────────────
      case 'confirm_assign': {
        const w = getTopBid();
        if (w && state.coaches[w.coachId]) {
          const nb = state.coaches[w.coachId].budget - w.amount;
          updateBudget(w.coachId, nb);
          state.assigned.push({
            player: state.currentPlayer,
            coachId: w.coachId, coachName: w.coachName, amount: w.amount
          });
        }
        state.currentPlayer = null; state.bids = []; state.bidsRevealed = false;
        state.auctionActive = false; stopTimer();
        broadcastState();
        break;
      }

      // ── Admin: salta giocatore ──────────────────────────────────────────────
      case 'skip_player':
        stopTimer();
        state.currentPlayer = null; state.bids = []; state.bidsRevealed = false;
        state.auctionActive = false;
        broadcastState();
        break;

      // ── Coach: offerta (accetta sia coachId che PIN come identificatore) ────
      case 'bid': {
        if (!state.auctionActive) {
          sendTo(ws, { type: 'bid_error', error: 'Offerte chiuse' }); return;
        }

        const resolvedCoachId = ws.coachId || msg.coachId || null;
        const coach = resolvedCoachId ? state.coaches[resolvedCoachId] : null;

        if (!coach) {
          sendTo(ws, { type: 'bid_error', error: 'Profilo non trovato — attendi la registrazione' });
          return;
        }

        const amount = parseInt(msg.amount);

        // Validazione 1: offerta >= 1
        if (!amount || amount < 1) {
          sendTo(ws, { type: 'bid_error', error: 'Offerta minima: 1 credito' }); return;
        }

        // Calcola giocatori già acquistati da questo allenatore
        const bought = state.assigned.filter(a => a.coachId === resolvedCoachId).length;
        const remaining = ROSTER_SIZE - bought; // posti liberi in rosa

        // Validazione 2: rosa già completa
        if (remaining <= 0) {
          sendTo(ws, { type: 'bid_error', error: `Rosa completa (${ROSTER_SIZE}/${ROSTER_SIZE} giocatori)` }); return;
        }

        // Validazione 3: budget sufficiente
        if (amount > coach.budget) {
          sendTo(ws, { type: 'bid_error', error: 'Budget insufficiente!' }); return;
        }

        // Validazione 4: offerta max calcolata
        // Deve rimanere almeno 1 credito per ognuno dei posti rimanenti dopo questo acquisto
        const slotsAfter = remaining - 1; // posti rimasti SE prende questo giocatore
        const maxBid = coach.budget - slotsAfter; // budget - riserva minima per gli altri slot
        if (amount > maxBid) {
          sendTo(ws, { type: 'bid_error', error: `Offerta troppo alta! Max consentito: ${maxBid} cr (devi tenere almeno 1 cr per i ${slotsAfter} slot rimasti)` }); return;
        }

        const ex = state.bids.find(b => b.coachId === resolvedCoachId);
        if (ex) { ex.amount = amount; ex.timestamp = Date.now(); }
        else state.bids.push({ coachId: resolvedCoachId, coachName: coach.name, amount, timestamp: Date.now() });

        broadcastState();
        broadcast({ type: 'bid_notification', coachName: coach.name, coachId: resolvedCoachId });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.role === 'coach' && ws.coachId && state.coaches[ws.coachId]) {
      state.coaches[ws.coachId].online = false;
      broadcastState();
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  let ip = 'localhost';
  for (const n of Object.keys(nets))
    for (const net of nets[n])
      if (net.family === 'IPv4' && !net.internal) { ip = net.address; break; }
  console.log(`\n⚽  Asta Fantacalcio v4`);
  console.log(`   http://localhost:${PORT}   |   http://${ip}:${PORT}\n`);
});

// ─── Backup automatico ogni 15 minuti ─────────────────────────────────────────
const os = require('os');
const BACKUP_DIR = path.join(os.homedir(), 'Desktop', 'Asta Fantacalcio');

function saveBackup() {
  // Salta se non ci sono ancora dati
  if (!state.players.length && !state.assigned.length) return;
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}`;

    // Giocatori assegnati
    let csvA = 'Nome;Ruolo;Squadra;Allenatore;Crediti\n';
    (state.assigned || []).forEach(a => {
      csvA += `${a.player.name};${a.player.role};${a.player.team};${a.coachName};${a.amount}\n`;
    });
    fs.writeFileSync(path.join(BACKUP_DIR, `assegnati_${ts}.csv`), '\uFEFF' + csvA, 'utf8');

    // Giocatori rimanenti
    let csvQ = 'Nome;Ruolo;Squadra;CreditiBase\n';
    if (state.currentPlayer) csvQ += `${state.currentPlayer.name};${state.currentPlayer.role};${state.currentPlayer.team};${state.currentPlayer.base} [IN ASTA]\n`;
    (state.queue || []).forEach(p => { csvQ += `${p.name};${p.role};${p.team};${p.base}\n`; });
    fs.writeFileSync(path.join(BACKUP_DIR, `rimanenti_${ts}.csv`), '\uFEFF' + csvQ, 'utf8');

    console.log(`💾 Backup ${ts} — ${state.assigned.length} assegnati, ${state.queue.length} rimasti`);
  } catch (e) {
    console.error('⚠️  Backup fallito:', e.message);
  }
}

setInterval(saveBackup, 15 * 60 * 1000);
