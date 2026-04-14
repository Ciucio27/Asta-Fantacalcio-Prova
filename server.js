const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ── Stato asta ────────────────────────────────────────────────────────────────
let state = {
  players: [],
  queue: [],
  currentPlayer: null,
  bids: [],             // valori SEMPRE presenti ma visibili solo dopo reveal
  bidsRevealed: false,
  assigned: [],
  auctionActive: false,
  timer: { enabled: false, duration: 60, remaining: 0, running: false },
  coaches: {}           // coachId → { name, budget, pin }
};

// Sessioni persistenti: PIN → { coachId, name, budget }
const sessions = {};

let timerInterval = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function buildClientState(ws) {
  const isAdmin = ws.role === 'admin';
  let visibleBids;
  if (state.bidsRevealed) {
    visibleBids = state.bids;
  } else if (isAdmin) {
    // Admin: vede chi ha offerto, non il valore
    visibleBids = state.bids.map(b => ({ coachId: b.coachId, coachName: b.coachName, hidden: true }));
  } else {
    // Coach: vede solo la propria offerta
    const mine = state.bids.find(b => b.coachId === ws.coachId);
    visibleBids = mine ? [mine] : [];
  }
  return { ...state, bids: visibleBids };
}

function sendStateTo(ws) {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: 'state', state: buildClientState(ws) }));
}

function broadcastState() {
  wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) sendStateTo(ws); });
}

function getTopBid() {
  if (!state.bids.length) return null;
  return state.bids.reduce((top, b) =>
    b.amount > top.amount ? b : b.amount === top.amount && b.timestamp < top.timestamp ? b : top
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
      const winner = getTopBid();
      broadcastState();
      broadcast({ type: 'bids_revealed', winner, player: state.currentPlayer, auto: true });
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

// ── HTTP ──────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('File non trovato'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else { res.writeHead(404); res.end('Not found'); }
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  sendStateTo(ws);

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Admin ──────────────────────────────────────────────────────────────
      case 'register_admin':
        ws.role = 'admin';
        ws.send(JSON.stringify({ type: 'registered', role: 'admin' }));
        sendStateTo(ws);
        break;

      // ── Coach con PIN persistente ──────────────────────────────────────────
      case 'register_coach': {
        const pin = String(msg.pin || '').trim();
        if (!pin) { ws.send(JSON.stringify({ type: 'reg_error', error: 'PIN non valido' })); return; }
        ws.role = 'coach';
        ws.pin = pin;
        if (sessions[pin]) {
          // Ripristino sessione
          const s = sessions[pin];
          ws.coachId = s.coachId;
          ws.coachName = s.name;
          state.coaches[s.coachId] = { name: s.name, budget: s.budget, pin };
        } else {
          // Prima registrazione
          const coachId = 'c' + Date.now().toString(36);
          ws.coachId = coachId;
          ws.coachName = msg.coachName || ('Coach #' + Object.keys(sessions).length + 1);
          const budget = Number(msg.budget) || 500;
          sessions[pin] = { coachId, name: ws.coachName, budget };
          state.coaches[coachId] = { name: ws.coachName, budget, pin };
        }
        ws.send(JSON.stringify({
          type: 'registered', role: 'coach',
          coachId: ws.coachId, coachName: ws.coachName,
          budget: state.coaches[ws.coachId].budget
        }));
        broadcastState();
        break;
      }

      // ── Admin: carica giocatori ────────────────────────────────────────────
      case 'set_players':
        state.players = msg.players;
        state.queue = shuffle(msg.players);
        state.currentPlayer = null; state.bids = []; state.bidsRevealed = false;
        state.assigned = []; state.auctionActive = false;
        stopTimer(); broadcastState();
        broadcast({ type: 'players_loaded', count: msg.players.length });
        break;

      // ── Admin: configura timer ─────────────────────────────────────────────
      case 'set_timer':
        state.timer.enabled = !!msg.enabled;
        state.timer.duration = Math.max(5, parseInt(msg.duration) || 60);
        broadcastState();
        break;

      // ── Admin: prossimo giocatore ──────────────────────────────────────────
      case 'next_player':
        stopTimer();
        if (!state.queue.length) {
          state.auctionActive = false; state.currentPlayer = null;
          broadcast({ type: 'auction_ended' });
        } else {
          state.currentPlayer = state.queue.shift();
          state.bids = []; state.bidsRevealed = false; state.auctionActive = true;
          broadcastState();
          broadcast({ type: 'new_player', player: state.currentPlayer });
          if (state.timer.enabled) startTimer();
        }
        break;

      // ── Admin: chiudi offerte (senza rivelare) ─────────────────────────────
      case 'close_bidding':
        stopTimer();
        state.auctionActive = false; state.bidsRevealed = false;
        broadcastState();
        broadcast({ type: 'bidding_closed' });
        break;

      // ── Admin: scopri offerte ──────────────────────────────────────────────
      case 'reveal_bids':
        state.bidsRevealed = true;
        broadcastState();
        broadcast({ type: 'bids_revealed', winner: getTopBid(), player: state.currentPlayer });
        break;

      // ── Admin: assegna giocatore ───────────────────────────────────────────
      case 'confirm_assign': {
        const w = getTopBid();
        if (w && state.coaches[w.coachId]) {
          const nb = state.coaches[w.coachId].budget - w.amount;
          state.coaches[w.coachId].budget = nb;
          if (sessions[state.coaches[w.coachId].pin]) sessions[state.coaches[w.coachId].pin].budget = nb;
          state.assigned.push({ player: state.currentPlayer, coachId: w.coachId, coachName: w.coachName, amount: w.amount });
        }
        state.currentPlayer = null; state.bids = []; state.bidsRevealed = false; state.auctionActive = false;
        stopTimer(); broadcastState();
        break;
      }

      // ── Admin: salta giocatore ─────────────────────────────────────────────
      case 'skip_player':
        stopTimer();
        state.currentPlayer = null; state.bids = []; state.bidsRevealed = false; state.auctionActive = false;
        broadcastState();
        break;

      // ── Coach: offerta ─────────────────────────────────────────────────────
      case 'bid': {
        if (!state.auctionActive) { ws.send(JSON.stringify({ type: 'bid_error', error: 'Offerte chiuse' })); return; }
        const coach = state.coaches[msg.coachId];
        if (!coach) return;
        const amount = parseInt(msg.amount);
        if (!amount || amount < 1) { ws.send(JSON.stringify({ type: 'bid_error', error: 'Offerta non valida' })); return; }
        if (amount > coach.budget) { ws.send(JSON.stringify({ type: 'bid_error', error: 'Budget insufficiente!' })); return; }
        const ex = state.bids.find(b => b.coachId === msg.coachId);
        if (ex) { ex.amount = amount; ex.timestamp = Date.now(); }
        else state.bids.push({ coachId: msg.coachId, coachName: coach.name, amount, timestamp: Date.now() });
        broadcastState();
        // Notifica solo il nome (no valore) a tutti
        broadcast({ type: 'bid_received', coachName: coach.name });
        break;
      }
    }
  });

  // Disconnessione: non rimuoviamo il coach (sessione persistente)
  ws.on('close', () => { /* sessione rimane in state.coaches e sessions */ });
});

server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let ip = 'localhost';
  for (const name of Object.keys(nets))
    for (const net of nets[name])
      if (net.family === 'IPv4' && !net.internal) { ip = net.address; break; }
  console.log(`\n⚽  ASTA FANTACALCIO v3`);
  console.log(`🖥️  http://localhost:${PORT}  |  📱 http://${ip}:${PORT}\n`);
});
