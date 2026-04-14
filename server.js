const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ── Stato asta in memoria ──────────────────────────────────────────────────
let state = {
  players: [],          // lista completa importata
  queue: [],            // coda randomizzata ancora da chiamare
  currentPlayer: null,  // giocatore attualmente in asta
  bids: [],             // offerte sul giocatore corrente
  assigned: [],         // assegnazioni completate
  auctionActive: false, // offerte aperte/chiuse
  coaches: {}           // { coachId: { name, budget } }
};

// ── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('File non trovato'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

// ── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function broadcastState() {
  broadcast({ type: 'state', state });
}

function getTopBid() {
  if (!state.bids.length) return null;
  return state.bids.reduce((top, bid) =>
    bid.amount > top.amount ? bid :
    bid.amount === top.amount && bid.timestamp < top.timestamp ? bid : top
  );
}

wss.on('connection', (ws, req) => {
  // Manda lo stato corrente al nuovo client
  ws.send(JSON.stringify({ type: 'state', state }));

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Admin si registra ────────────────────────────────────────────────
      case 'register_admin':
        ws.role = 'admin';
        ws.send(JSON.stringify({ type: 'registered', role: 'admin' }));
        break;

      // ── Allenatore si registra ───────────────────────────────────────────
      case 'register_coach':
        ws.role = 'coach';
        ws.coachId = msg.coachId;
        ws.coachName = msg.coachName;
        state.coaches[msg.coachId] = { name: msg.coachName, budget: msg.budget || 500 };
        broadcastState();
        break;

      // ── Admin importa lista giocatori (CSV già parsato dal client) ────────
      case 'set_players': {
        state.players = msg.players;
        // Shuffle Fisher-Yates lato server per coerenza
        const arr = [...msg.players];
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        state.queue = arr;
        state.currentPlayer = null;
        state.bids = [];
        state.assigned = [];
        state.auctionActive = false;
        broadcastState();
        broadcast({ type: 'players_loaded', count: msg.players.length });
        break;
      }

      // ── Admin chiama il prossimo giocatore random ────────────────────────
      case 'next_player':
        if (state.queue.length === 0) {
          state.auctionActive = false;
          state.currentPlayer = null;
          broadcast({ type: 'auction_ended' });
        } else {
          state.currentPlayer = state.queue.shift();
          state.bids = [];
          state.auctionActive = true;
          broadcastState();
          broadcast({ type: 'new_player', player: state.currentPlayer });
        }
        break;

      // ── Admin chiude le offerte ──────────────────────────────────────────
      case 'close_bidding':
        state.auctionActive = false;
        broadcastState();
        broadcast({ type: 'bidding_closed', winner: getTopBid(), player: state.currentPlayer });
        break;

      // ── Admin conferma assegnazione ──────────────────────────────────────
      case 'confirm_assign': {
        const winner = getTopBid();
        if (winner && state.coaches[winner.coachId]) {
          state.coaches[winner.coachId].budget -= winner.amount;
          state.assigned.push({
            player: state.currentPlayer,
            coachId: winner.coachId,
            coachName: winner.coachName,
            amount: winner.amount
          });
        }
        state.currentPlayer = null;
        state.bids = [];
        state.auctionActive = false;
        broadcastState();
        break;
      }

      // ── Admin salta il giocatore senza assegnare ─────────────────────────
      case 'skip_player':
        state.currentPlayer = null;
        state.bids = [];
        state.auctionActive = false;
        broadcastState();
        break;

      // ── Allenatore piazza un'offerta ─────────────────────────────────────
      case 'bid': {
        if (!state.auctionActive) {
          ws.send(JSON.stringify({ type: 'bid_error', error: 'Offerte chiuse' }));
          return;
        }
        const coach = state.coaches[msg.coachId];
        if (!coach) return;
        if (msg.amount > coach.budget) {
          ws.send(JSON.stringify({ type: 'bid_error', error: 'Budget insufficiente!' }));
          return;
        }
        if (msg.amount < 1) {
          ws.send(JSON.stringify({ type: 'bid_error', error: 'Offerta minima: 1 credito' }));
          return;
        }
        // Aggiorna o inserisce l'offerta (timestamp lato server = invariabile)
        const existing = state.bids.find(b => b.coachId === msg.coachId);
        if (existing) {
          existing.amount = msg.amount;
          existing.timestamp = Date.now(); // aggiorna timestamp solo se si rilancia
        } else {
          state.bids.push({ coachId: msg.coachId, coachName: coach.name, amount: msg.amount, timestamp: Date.now() });
        }
        broadcastState();
        broadcast({ type: 'new_bid', bid: { coachName: coach.name, amount: msg.amount } });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.role === 'coach' && ws.coachId) {
      delete state.coaches[ws.coachId];
      broadcastState();
    }
  });
});

// ── Avvio ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
    }
  }
  console.log('\n⚽  ASTA FANTACALCIO — SERVER AVVIATO');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🖥️  Admin locale:       http://localhost:${PORT}`);
  console.log(`📱  LAN (stesso WiFi):  http://${localIP}:${PORT}`);
  console.log(`🌐  Remoto (Railway):   usa l'URL del tuo deployment`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
