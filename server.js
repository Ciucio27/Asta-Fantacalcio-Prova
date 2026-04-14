const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

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
        state.timer.remaining = 0;
        state.timer.running = false;
        broadcastState();
        break;

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

      // ── Coach: offerta ──────────────────────────────────────────────────────
      case 'bid': {
        if (!state.auctionActive) {
          sendTo(ws, { type: 'bid_error', error: 'Offerte chiuse' }); return;
        }
        const coach = state.coaches[msg.coachId];
        if (!coach) { sendTo(ws, { type: 'bid_error', error: 'Profilo non trovato' }); return; }
        const amount = parseInt(msg.amount);
        if (!amount || amount < 1) { sendTo(ws, { type: 'bid_error', error: 'Offerta non valida' }); return; }
        if (amount > coach.budget) { sendTo(ws, { type: 'bid_error', error: 'Budget insufficiente!' }); return; }

        const ex = state.bids.find(b => b.coachId === msg.coachId);
        if (ex) { ex.amount = amount; ex.timestamp = Date.now(); }
        else state.bids.push({ coachId: msg.coachId, coachName: coach.name, amount, timestamp: Date.now() });

        broadcastState();
        // Solo il nome arriva come notifica — niente valore
        broadcast({ type: 'bid_notification', coachName: coach.name, coachId: msg.coachId });
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
