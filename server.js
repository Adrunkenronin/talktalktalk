const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const sanitizeHtml = require('sanitize-html');
const ChessCtor = require('chess.js').Chess;
const Stockfish = require('stockfish');

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

// Stockfish WASM module is unreliable on server-side, using fallback algorithm instead
let StockfishFactory = null;

function eloToDepth(elo) {
  const rating = Number(elo) || 600;

  const eloDepthMap = [
    { elo: 600, depth: 6 },
    { elo: 750, depth: 7 },
    { elo: 900, depth: 8 },
    { elo: 1050, depth: 9 },
    { elo: 1200, depth: 10 },
    { elo: 1350, depth: 11 },
    { elo: 1500, depth: 12 },
    { elo: 1650, depth: 13 },
    { elo: 1800, depth: 14 },
    { elo: 1950, depth: 15 },
    { elo: 2100, depth: 16 },
    { elo: 2250, depth: 17 },
    { elo: 2400, depth: 18 }
  ];

  if (rating <= eloDepthMap[0].elo) return eloDepthMap[0].depth;
  if (rating >= eloDepthMap[eloDepthMap.length - 1].elo) return eloDepthMap[eloDepthMap.length - 1].depth;

  for (let i = 0; i < eloDepthMap.length - 1; i++) {
    if (rating >= eloDepthMap[i].elo && rating <= eloDepthMap[i + 1].elo) {
      const lower = eloDepthMap[i];
      const upper = eloDepthMap[i + 1];
      const ratio = (rating - lower.elo) / (upper.elo - lower.elo);
      return Math.round(lower.depth + (upper.depth - lower.depth) * ratio);
    }
  }

  return 8;
}

let stockfishEngine = null;
let stockfishReady = false;
let stockfishInitError = null;
let stockfishInitPromise = null;
const pendingSearches = new Map(); // searchId -> {resolve, timeout}

async function initStockfish() {
  if (stockfishEngine && stockfishReady) {
    console.log('[stockfish] Engine already initialized');
    return stockfishEngine;
  }

  if (stockfishInitPromise) {
    console.log('[stockfish] Waiting for initialization in progress');
    return stockfishInitPromise;
  }

  stockfishInitPromise = new Promise((resolve, reject) => {
    try {
      console.log('[stockfish] Initializing engine...');

      // Stockfish is a function that returns an object with postMessage/onmessage
      if (typeof Stockfish === 'function') {
        console.log('[stockfish] Using Stockfish as function');
        stockfishEngine = Stockfish();
      } else {
        console.log('[stockfish] Using Stockfish as constructor');
        stockfishEngine = new Stockfish();
      }

      if (!stockfishEngine) {
        throw new Error('Stockfish initialization returned null');
      }

      console.log('[stockfish] Engine created, setting up message handler');

      stockfishEngine.onmessage = function(event) {
        const line = typeof event === 'string' ? event : (event && event.data);
        if (!line) return;

        console.log('[stockfish-out]', line);

        if (line === 'uciok') {
          stockfishReady = true;
          console.log('[stockfish] Engine initialized and ready');
          resolve(stockfishEngine);
        } else if (line === 'readyok') {
          console.log('[stockfish] Engine confirmed ready');
        } else if (line.startsWith('bestmove')) {
          const parts = line.split(' ');
          const move = parts[1];
          const searchId = 'search_default';

          console.log('[stockfish] Received bestmove:', move);

          if (pendingSearches.has(searchId)) {
            const pending = pendingSearches.get(searchId);
            clearTimeout(pending.timeout);
            pending.resolve(move);
            pendingSearches.delete(searchId);
          }
        }
      };

      if (!stockfishEngine.postMessage) {
        throw new Error('Stockfish engine does not have postMessage method');
      }

      console.log('[stockfish] Sending UCI command');
      stockfishEngine.postMessage('uci');

      // Set a timeout in case the engine doesn't respond
      const initTimeout = setTimeout(() => {
        if (!stockfishReady) {
          stockfishInitError = 'Stockfish initialization timeout';
          reject(new Error(stockfishInitError));
        }
      }, 5000);

    } catch (err) {
      console.error('[stockfish] Initialization error:', err);
      stockfishInitError = err.message;
      reject(err);
    }
  });

  try {
    await stockfishInitPromise;
    return stockfishEngine;
  } catch (err) {
    stockfishInitPromise = null;
    throw err;
  }
}

async function bestMoveWithStockfish(fen, depth, elo) {
  if (!stockfishEngine) {
    try {
      await initStockfish();
    } catch (err) {
      console.error('[stockfish] Failed to initialize engine:', err);
      return null;
    }
  }

  return new Promise((resolve) => {
    try {
      const searchId = 'search_default';
      const timeout = setTimeout(() => {
        if (pendingSearches.has(searchId)) {
          pendingSearches.delete(searchId);
        }
        resolve(null);
      }, 30000); // 30 second timeout

      pendingSearches.set(searchId, { resolve, timeout });

      // Send position and search command
      stockfishEngine.postMessage(`position fen ${fen}`);

      // If ELO is specified, set the skill level
      if (elo && !isNaN(elo)) {
        const skillLevel = eloToSkillLevel(elo);
        stockfishEngine.postMessage(`setoption name Skill Level value ${skillLevel}`);
      }

      // Send go command with depth
      const depthToUse = Math.max(1, Math.min(30, Number(depth) || 15));
      stockfishEngine.postMessage(`go depth ${depthToUse}`);

    } catch (err) {
      console.error('[stockfish] Error during search:', err);
      resolve(null);
    }
  });
}

function eloToSkillLevel(elo) {
  // Map ELO ratings to Stockfish skill levels (0-20)
  const rating = Number(elo) || 1200;
  if (rating <= 600) return 0;
  if (rating >= 2400) return 20;

  // Linear interpolation: 600->0, 2400->20
  const skillLevel = Math.round(((rating - 600) / (2400 - 600)) * 20);
  return Math.max(0, Math.min(20, skillLevel));
}

app.post('/api/stockfish/move', async (req, res) => {
  const fen = String(req.body && req.body.fen || '').trim();
  let depth = Number(req.body && (req.body.depth ?? 0));
  const elo = Number(req.body && (req.body.elo ?? 0));

  if (!fen) return res.status(400).json({ error: 'fen required' });
  if (!depth && elo) depth = eloToDepth(elo);
  if (!depth) depth = 15;

  try {
    console.log('[stockfish] request', {
      time: new Date().toISOString(),
      ip: req.ip,
      fen: fen,
      depth: depth,
      elo: elo
    });
  } catch (_) {}

  try {
    const best = await bestMoveWithStockfish(fen, depth, elo);
    if (!best) {
      console.warn('[stockfish] no_move for fen', fen);
      return res.status(422).json({ error: 'no_move' });
    }
    console.log('[stockfish] bestmove:', best);
    return res.json({ bestmove: best });
  } catch (e) {
    console.error('[stockfish] engine error', e && e.stack ? e.stack : e);
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
