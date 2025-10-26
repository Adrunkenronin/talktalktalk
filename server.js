const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const sanitizeHtml = require('sanitize-html');
const ChessCtor = require('chess.js').Chess;

// Config (mirrors config.py defaults)
const HOST = '0.0.0.0';
const PORT = process.env.PORT || 12000;
const ADMINNAME = 'admin';
const ADMINHIDDENNAME = 'adminxyz';

// Persistence
const DATA_DIR = path.join(__dirname, 'data');
const MSG_FILE = path.join(DATA_DIR, 'messages.jsonl');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

let idx = 0; // next message id
let messages = []; // array of message objects {type:'message', message, username, id, datetime}
let knownUsers = new Set(); // all-time seen users (current canonical usernames)

function loadMessages() {
  if (!fs.existsSync(MSG_FILE)) return;
  const lines = fs.readFileSync(MSG_FILE, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.id === 'number') {
        messages.push(obj);
        idx = Math.max(idx, obj.id + 1);
      }
    } catch (_) {}
  }
}

function appendMessage(obj) {
  fs.appendFile(MSG_FILE, JSON.stringify(obj) + '\n', () => {});
}

function loadKnownUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      if (Array.isArray(arr)) arr.forEach((u) => { if (typeof u === 'string' && u) knownUsers.add(u); });
    }
  } catch (_) {}
}

function persistKnownUsers() {
  try { fs.writeFile(USERS_FILE, JSON.stringify(Array.from(knownUsers)), () => {}); } catch(_) {}
}

loadMessages();
loadKnownUsers();

// Server
const app = express();
app.use(express.static(path.join(__dirname)));
app.use(express.json());
// Allow CORS for API endpoints so clients opened from file:// or other origins can call /api
app.use(function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'talktalktalk.html'));
});

app.get('/popsound.mp3', (req, res) => {
  res.sendFile(path.join(__dirname, 'popsound.mp3'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Use Lichess Cloud Eval API for real Stockfish moves
const LICHESS_EVAL_URL = 'https://lichess.org/api/cloud-eval';

function eloToDepth(elo) {
  // Map ELO to multipv for Lichess API
  // multipv: how many top moves to consider (1-5)
  const rating = Number(elo) || 600;

  // Higher ELO = more analysis depth (multipv considers more variations)
  if (rating <= 750) return { multiPv: 1, maxDepth: 20 };
  if (rating <= 1050) return { multiPv: 1, maxDepth: 25 };
  if (rating <= 1350) return { multiPv: 1, maxDepth: 30 };
  if (rating <= 1650) return { multiPv: 2, maxDepth: 35 };
  if (rating <= 1950) return { multiPv: 2, maxDepth: 40 };
  return { multiPv: 3, maxDepth: 45 };
}

async function getBestMoveFromLichess(fen, elo) {
  try {
    const params = new URLSearchParams({
      fen: fen,
      variant: 'standard'
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const response = await fetch(`${LICHESS_EVAL_URL}?${params}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[lichess] HTTP ${response.status}, falling back to local algorithm`);
      return null;
    }

    const data = await response.json();

    // Extract best move from Lichess response
    if (data.pvs && data.pvs.length > 0 && data.pvs[0].moves) {
      const moves = data.pvs[0].moves.split(' ');
      if (moves.length > 0) {
        console.log('[lichess] best move:', moves[0], 'depth:', data.depth);
        return moves[0];
      }
    }

    return null;
  } catch (err) {
    console.warn('[lichess] error:', err.message, '- falling back to local algorithm');
    return null;
  }
}

function evaluateBoardMaterial(chess) {
  const values = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  const board = chess.board();
  let score = 0;
  for (const row of board) {
    for (const piece of row) {
      if (!piece) continue;
      const v = values[piece.type] || 0;
      score += (piece.color === 'w') ? v : -v;
    }
  }
  return score;
}

function bestMoveFallback(fen, depth) {
  const chess = new ChessCtor();
  try { chess.load(fen); } catch (_) { return null; }
  const maxDepth = Math.max(1, Number(depth) || 5);
  const player = chess.turn();
  const startTime = Date.now();
  // Time limit: 200ms base + 150ms per depth, capped at 3s
  // This ensures responses stay under 4s (with network overhead)
  const maxTime = Math.min(3000, 200 + depth * 150);
  let nodeCount = 0;
  // Reduce max nodes for deeper searches to maintain responsiveness
  const maxNodes = depth > 14 ? 30000 : 50000;

  function negamax(d, alpha, beta) {
    nodeCount++;
    // Check time and node limits periodically (every 256 nodes for performance)
    if ((nodeCount & 255) === 0) {
      if (Date.now() - startTime > maxTime || nodeCount > maxNodes) {
        // Time budget exceeded, return quick evaluation
        const evalScore = evaluateBoardMaterial(chess);
        return player === 'w' ? evalScore : -evalScore;
      }
    }

    if (d === 0 || chess.game_over()) {
      const evalScore = evaluateBoardMaterial(chess);
      return player === 'w' ? evalScore : -evalScore;
    }
    let best = -Infinity;
    const moves = chess.moves({ verbose: true });
    for (const m of moves) {
      chess.move(m);
      const score = -negamax(d - 1, -beta, -alpha);
      chess.undo();
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  }
  let bestMove = null;
  let bestScore = -Infinity;
  const moves = chess.moves({ verbose: true });
  for (const m of moves) {
    chess.move(m);
    const score = -negamax(maxDepth - 1, -Infinity, Infinity);
    chess.undo();
    if (score > bestScore) { bestScore = score; bestMove = m; }
  }
  if (!bestMove) return null;
  const promo = bestMove.promotion ? bestMove.promotion : '';
  return bestMove.from + bestMove.to + (promo || '');
}

app.post('/api/stockfish/move', async (req, res) => {
  const fen = String(req.body && req.body.fen || '').trim();
  const elo = Number(req.body && (req.body.elo ?? 600));
  if (!fen) return res.status(400).json({ error: 'fen required' });

  // Diagnostic logging to help debug Network/engine issues
  try {
    console.log('[engine] request', {
      time: new Date().toISOString(),
      ip: req.ip,
      elo: elo
    });
  } catch (_) {}

  try {
    // Try Lichess API first for real Stockfish moves
    let best = await getBestMoveFromLichess(fen, elo);

    // If Lichess fails (rate limited, offline, etc), fall back to local algorithm
    if (!best) {
      console.log('[engine] Lichess unavailable, using local fallback algorithm');
      const depthConfig = eloToDepth(elo);
      best = bestMoveFallback(fen, depthConfig.maxDepth);
    }

    if (!best) {
      console.warn('[engine] no_move for fen', fen);
      return res.status(422).json({ error: 'no_move' });
    }
    return res.json({ bestmove: best });
  } catch (e) {
    console.error('[engine] error', e && e.stack ? e.stack : e);
    return res.status(500).json({ error: 'engine_error' });
  }
});

// State
const users = new Map(); // ws -> username
const pings = new Map(); // ws -> timestamp
const usernameToWs = new Map(); // username -> ws
const invites = new Map(); // key `${inviter}\u0000${target}` -> timestamp
const games = new Map(); // gid -> {board: Chess, white, black, over}
let nextGameId = 1;
const userMessageTimes = new Map(); // ws -> Array<number> timestamps

function now() { return Date.now() / 1000; }

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }
}

function broadcast(payload) {
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) send(ws, payload);
  }
}

function connectedUsernames() {
  return Array.from(users.values());
}

function sendUserList() {
  const connected = connectedUsernames();
  const offline = Array.from(knownUsers).filter((u) => !connected.includes(u));
  const payload = { type: 'userlist', connected, offline };
  for (const [ws] of users) send(ws, payload);
}

function getWsByUsername(name) {
  const ws = usernameToWs.get(name);
  if (ws && users.get(ws) === name) return ws;
  for (const [w, n] of users.entries()) if (n === name) return w;
  return null;
}

function sendToUsername(name, payload) {
  const ws = getWsByUsername(name);
  if (ws && ws.readyState === WebSocket.OPEN) { send(ws, payload); return true; }
  return false;
}

function cleanUsername(usr, ws) {
  let username = sanitizeHtml(String(usr || ''), { allowedTags: [], allowedAttributes: {} });
  username = username.replace(/\W+/g, '').slice(0, 16);
  if (username.toLowerCase() === ADMINHIDDENNAME) {
    username = ADMINNAME;
    send(ws, { type: 'displayeduser', username });
  } else if (username.toLowerCase() === ADMINNAME || username === '') {
    username = 'user' + Math.floor(Math.random() * 1001);
    send(ws, { type: 'usernameunavailable', username });
  }
  return username;
}

function messagesRange(startId, endIdExclusive) {
  const out = [];
  for (let i = Math.max(0, startId); i < Math.min(idx, endIdExclusive); i++) {
    const msg = messages[i];
    if (msg) out.push(JSON.stringify(msg));
  }
  return out;
}

function renameUserEverywhere(oldName, newName) {
  if (!oldName || oldName === newName) return;
  if (usernameToWs.has(oldName)) {
    const ws = usernameToWs.get(oldName);
    usernameToWs.delete(oldName);
    if (ws) usernameToWs.set(newName, ws);
  }
  if (knownUsers.has(oldName)) {
    knownUsers.delete(oldName);
    knownUsers.add(newName);
    persistKnownUsers();
  }
  // Rename in invites keys
  const entries = Array.from(invites.entries());
  for (const [key, ts] of entries) {
    const parts = key.split('\u0000');
    if (parts.length !== 2) continue;
    const inviter = parts[0];
    const target = parts[1];
    let changed = false;
    let ni = inviter, nt = target;
    if (inviter === oldName) { ni = newName; changed = true; }
    if (target === oldName) { nt = newName; changed = true; }
    if (changed) {
      invites.delete(key);
      invites.set(ni + '\u0000' + nt, ts);
    }
  }
  // Update current games labels (non-critical to functionality but keeps UX sensible)
  for (const g of games.values()) {
    if (g.white === oldName) g.white = newName;
    if (g.black === oldName) g.black = newName;
  }
}

function deliverQueuedInvites(username) {
  for (const key of invites.keys()) {
    const parts = key.split('\u0000');
    if (parts.length !== 2) continue;
    const inviter = parts[0];
    const target = parts[1];
    if (target === username) {
      sendToUsername(username, { type: 'chess_invite', from: inviter, offline: true });
    }
  }
}

// Cleanup stale users
setInterval(() => {
  const t = now();
  let changed = false;
  for (const [ws, lastPing] of pings.entries()) {
    if (t - lastPing > 30) {
      const uname = users.get(ws);
      users.delete(ws);
      pings.delete(ws);
      userMessageTimes.delete(ws);
      if (usernameToWs.get(uname) === ws) usernameToWs.delete(uname);
      changed = true;
    }
  }
  if (changed) sendUserList();
}, 10000);

wss.on('connection', (ws, req) => {
  if (req.url && !req.url.startsWith('/ws')) {
    ws.close();
    return;
  }
  userMessageTimes.set(ws, []);

  ws.on('message', (data) => {
    let msgStr = data.toString();
    if (msgStr.length > 4096) { send(ws, { type: 'flood' }); try { ws.close(); } catch(_){} return; }

    pings.set(ws, now());

    if (msgStr === 'ping') {
      send(ws, 'id' + String(Math.max(0, idx - 1)));
      if (!users.has(ws)) send(ws, { type: 'username' });
      return;
    }

    // Flood control (track non-ping messages)
    const arr = userMessageTimes.get(ws) || [];
    arr.push(Date.now());
    while (arr.length > 10) arr.shift();
    userMessageTimes.set(ws, arr);
    if (arr.length === 10 && (arr[arr.length - 1] - arr[0]) < 5000) {
      send(ws, { type: 'flood' });
      try { ws.close(); } catch(_){ }
      return;
    }

    let msg;
    try { msg = JSON.parse(msgStr); } catch (_) { return; }

    if (msg.type === 'message') {
      let message = String(msg.message || '').trim();
      let username = users.get(ws);
      if (!username) {
        const prev = null;
        username = cleanUsername(msg.username, ws);
        users.set(ws, username);
        usernameToWs.set(username, ws);
        knownUsers.add(username);
        persistKnownUsers();
        sendUserList();
        deliverQueuedInvites(username);
      }
      if (message) {
        if (message.length > 1000) message = message.slice(0, 1000) + '...';
        const safeMessage = sanitizeHtml(message, { allowedTags: [], allowedAttributes: {} }).trim();
        const obj = { type: 'message', message: safeMessage, username, id: idx, datetime: Math.floor(now()) };
        messages[idx] = obj;
        appendMessage(obj);
        idx += 1;
        const s = JSON.stringify(obj);
        for (const [u] of users) send(u, s);
      }
    }
    else if (msg.type === 'messagesbefore') {
      const idbefore = Number(msg.id) || 0;
      send(ws, { type: 'messages', before: 1, messages: messagesRange(Math.max(0, idbefore - 100), idbefore) });
    }
    else if (msg.type === 'messagesafter') {
      const idafter = Number(msg.id) || 0;
      send(ws, { type: 'messages', before: 0, messages: messagesRange(idafter, idx) });
    }
    else if (msg.type === 'username') {
      const oldName = users.get(ws) || null;
      const username = cleanUsername(msg.username, ws);
      const isNew = !users.has(ws);
      users.set(ws, username);
      usernameToWs.set(username, ws);
      if (oldName && oldName !== username) {
        renameUserEverywhere(oldName, username);
      }
      knownUsers.add(username);
      persistKnownUsers();
      if (isNew) {
        send(ws, { type: 'messages', before: 0, messages: messagesRange(Math.max(0, idx - 100), idx) });
      }
      sendUserList();
      deliverQueuedInvites(username);
    }
    else if (msg.type === 'forget_me') {
      const uname = users.get(ws);
      if (uname && knownUsers.has(uname)) {
        knownUsers.delete(uname);
        persistKnownUsers();
        sendUserList();
      }
    }
    else if (msg.type === 'chess_invite') {
      const inviter = users.get(ws);
      const target = String(msg.to || '');
      if (!inviter || !target || inviter === target) {
        send(ws, { type: 'chess_error', message: 'Invalid invite' });
      } else {
        const key = inviter + '\u0000' + target;
        invites.set(key, Date.now());
        const ok = sendToUsername(target, { type: 'chess_invite', from: inviter });
        if (!ok) {
          // queued for offline delivery; optional ack
          // send(ws, { type: 'chess_info', message: 'Invite queued for delivery when user is online' });
        }
      }
    }
    else if (msg.type === 'chess_invite_accept') {
      const target = users.get(ws); // acceptor
      const inviter = String(msg.from || '');
      const key = inviter + '\u0000' + target;
      if (!inviter || !target || !invites.has(key)) {
        send(ws, { type: 'chess_error', message: 'Invite not found' });
      } else {
        const gid = nextGameId++;
        const board = new ChessCtor();
        let white, black;
        if (Math.random() < 0.5) { white = inviter; black = target; } else { white = target; black = inviter; }
        games.set(gid, { board, white, black, over: false });
        const payload = { type: 'chess_start', game_id: gid, white, black, fen: board.fen(), turn: 'white' };
        sendToUsername(white, payload); sendToUsername(black, payload);
        invites.delete(key);
      }
    }
    else if (msg.type === 'chess_move') {
      const gid = msg.game_id;
      const src = String(msg.from || '');
      const dst = String(msg.to || '');
      const promo = (msg.promotion || '').toLowerCase();
      const player = users.get(ws);
      if (!games.has(gid)) { send(ws, { type: 'chess_error', message: 'Game not found' }); return; }
      const g = games.get(gid);
      const board = g.board;
      if (g.over) { send(ws, { type: 'chess_error', message: 'Game over' }); return; }
      const expected = board.turn() === 'w' ? g.white : g.black;
      if (player !== expected) { send(ws, { type: 'chess_error', message: 'Not your turn' }); return; }
      const moveSpec = { from: src, to: dst };
      if (promo && ['q','r','b','n'].includes(promo)) moveSpec.promotion = promo;
      const move = board.move(moveSpec);
      if (move) {
        const payload = { type: 'chess_move', game_id: gid, from: src, to: dst, promotion: move.promotion || null, san: move.san, fen: board.fen(), turn: board.turn() === 'w' ? 'white' : 'black', check: board.in_check() };
        sendToUsername(g.white, payload); sendToUsername(g.black, payload);
        if (board.game_over()) {
          g.over = true;
          let result;
          if (board.in_checkmate()) result = board.turn() === 'w' ? '0-1' : '1-0';
          else if (board.in_stalemate() || board.in_draw()) result = '1/2-1/2';
          else result = '1/2-1/2';
          const reason = board.in_checkmate() ? 'checkmate' : (board.in_stalemate() ? 'stalemate' : 'draw');
          const over = { type: 'chess_over', game_id: gid, result, reason, fen: board.fen() };
          sendToUsername(g.white, over); sendToUsername(g.black, over);
        }
      } else {
        send(ws, { type: 'chess_illegal', reason: 'illegal' });
      }
    }
    else if (msg.type === 'chess_resign') {
      const gid = msg.game_id;
      const player = users.get(ws);
      if (games.has(gid)) {
        const g = games.get(gid);
        if (!g.over) {
          g.over = true;
          const winner = player === g.white ? g.black : g.white;
          const result = winner === g.white ? '1-0' : '0-1';
          const over = { type: 'chess_over', game_id: gid, result, reason: 'resign', fen: g.board.fen() };
          sendToUsername(g.white, over); sendToUsername(g.black, over);
        }
      }
    }
  });

  ws.on('close', () => {
    const uname = users.get(ws);
    users.delete(ws);
    pings.delete(ws);
    userMessageTimes.delete(ws);
    if (usernameToWs.get(uname) === ws) usernameToWs.delete(uname);
    sendUserList();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
