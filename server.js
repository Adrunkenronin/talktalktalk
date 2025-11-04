const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const sanitizeHtml = require('sanitize-html');
const ChessCtor = require('chess.js').Chess;
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

// Config (mirrors config.py defaults)
const HOST = '0.0.0.0';
const PORT = process.env.PORT || 12000;
const ADMINNAME = 'admin';
const ADMINHIDDENNAME = 'adminxyz';

// Persistence
const DATA_DIR = path.join(__dirname, 'data');
const MSG_FILE = path.join(DATA_DIR, 'messages.jsonl');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'user-settings.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

let idx = 0; // next message id
let messages = []; // array of message objects {type:'message', message, username, id, datetime}
let knownUsers = new Set(); // all-time seen users (current canonical usernames)
let userSettings = {}; // username -> {confirmMoves, premoveEnabled, selectedBoard, selectedPieces}

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
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/popsound.mp3', (req, res) => {
  res.sendFile(path.join(__dirname, 'popsound.mp3'));
});

// Serve board images with CDN fallback
app.get('/boards/:boardName/:size.png', (req, res) => {
  const { boardName, size } = req.params;
  const localPath = path.join(__dirname, 'boards', boardName, `${size}.png`);

  if (fs.existsSync(localPath)) {
    res.sendFile(localPath);
  } else {
    const cdnUrl = `https://images.chesscomfiles.com/chess-themes/boards/${boardName}/${size}.png`;
    res.redirect(cdnUrl);
  }
});

// Serve piece images with CDN fallback
app.get('/pieces/:pieceName/:color/:type.png', (req, res) => {
  const { pieceName, color, type } = req.params;
  const localPath = path.join(__dirname, 'pieces', pieceName, color, `${type}.png`);

  if (fs.existsSync(localPath)) {
    res.sendFile(localPath);
  } else {
    const cdnUrl = `https://images.chesscomfiles.com/chess-themes/pieces/${pieceName}/${color}/${type}.png`;
    res.redirect(cdnUrl);
  }
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

class StockfishEngine extends EventEmitter {
  constructor(enginePath) {
    super();
    this.enginePath = enginePath;
    this.process = null;
    this.ready = false;
    this.queue = [];
    this.currentSearch = null;
  }

  async start() {
    return new Promise((resolve, reject) => {
      try {
        console.log('[stockfish] Starting engine:', this.enginePath);
        this.process = spawn(this.enginePath, [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30000
        });

        let initialized = false;

        this.process.stdout.on('data', (data) => {
          const lines = data.toString().split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            console.log('[stockfish-out]', trimmed);

            if (trimmed === 'uciok') {
              this.ready = true;
              if (!initialized) {
                initialized = true;
                resolve(this);
              }
            } else if (trimmed.startsWith('bestmove')) {
              const parts = trimmed.split(' ');
              const move = parts[1];
              if (this.currentSearch) {
                clearTimeout(this.currentSearch.timeout);
                this.currentSearch.resolve(move);
                this.currentSearch = null;
              }
            }
          }
        });

        this.process.stderr.on('data', (data) => {
          console.warn('[stockfish-err]', data.toString());
        });

        this.process.on('error', (err) => {
          console.error('[stockfish] Process error:', err);
          if (!initialized) reject(err);
        });

        // Send initialization command
        this.process.stdin.write('uci\n');

        // Timeout for initialization
        setTimeout(() => {
          if (!initialized) {
            reject(new Error('Stockfish initialization timeout'));
          }
        }, 5000);

      } catch (err) {
        reject(err);
      }
    });
  }

  send(command) {
    if (this.process && this.process.stdin) {
      console.log('[stockfish-in]', command);
      this.process.stdin.write(command + '\n');
    }
  }

  async go(options) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(null);
      }, 30000);

      this.currentSearch = { resolve, timeout };

      let goCommand = 'go';
      if (options.depth) {
        goCommand += ' depth ' + options.depth;
      } else if (options.movetime) {
        goCommand += ' movetime ' + options.movetime;
      } else {
        goCommand += ' depth 15';
      }

      this.send(goCommand);
    });
  }

  async setoption(name, value) {
    this.send(`setoption name ${name} value ${value}`);
  }

  async position(fen) {
    this.send(`position fen ${fen}`);
  }

  async newgame() {
    this.send('ucinewgame');
  }

  stop() {
    if (this.process) {
      this.process.kill();
    }
  }
}

let stockfishEngine = null;
let stockfishInitPromise = null;

async function initStockfish() {
  if (stockfishEngine) {
    console.log('[stockfish] Engine already initialized');
    return stockfishEngine;
  }

  if (stockfishInitPromise) {
    console.log('[stockfish] Waiting for initialization in progress');
    return stockfishInitPromise;
  }

  stockfishInitPromise = (async () => {
    try {
      console.log('[stockfish] Initializing UCI engine...');

      // Try common stockfish binary locations
      const possiblePaths = [
        'stockfish',                          // System PATH
        '/usr/games/stockfish',              // Linux
        '/usr/bin/stockfish',                // Linux alternative
        '/usr/local/bin/stockfish',          // macOS homebrew
        '/opt/homebrew/bin/stockfish',       // M1 macOS
        'C:\\stockfish\\stockfish.exe',      // Windows
        './stockfish',                        // Current directory
      ];

      let lastError = null;

      for (const enginePath of possiblePaths) {
        try {
          console.log(`[stockfish] Trying: ${enginePath}`);
          const engine = new StockfishEngine(enginePath);
          await engine.start();
          stockfishEngine = engine;
          console.log('[stockfish] Engine initialized and ready');
          return stockfishEngine;
        } catch (err) {
          lastError = err;
          console.log(`[stockfish] Failed: ${err.message}`);
        }
      }

      throw new Error(`Could not find stockfish binary. Last error: ${lastError ? lastError.message : 'unknown'}`);

    } catch (err) {
      console.error('[stockfish] Initialization error:', err.message);
      stockfishInitPromise = null;
      throw err;
    }
  })();

  return stockfishInitPromise;
}

async function bestMoveWithStockfish(fen, depth, elo) {
  try {
    if (!stockfishEngine) {
      try {
        await initStockfish();
      } catch (err) {
        console.warn('[stockfish] Binary not available, using fallback algorithm');
        return bestMoveFallback(fen, depth);
      }
    }

    if (!stockfishEngine) {
      console.warn('[stockfish] Engine unavailable, using fallback algorithm');
      return bestMoveFallback(fen, depth);
    }

    await stockfishEngine.newgame();

    // Set skill level based on ELO
    if (elo && !isNaN(elo)) {
      const skillLevel = eloToSkillLevel(elo);
      console.log('[stockfish] Setting skill level to', skillLevel, 'for ELO', elo);
      await stockfishEngine.setoption('Skill Level', skillLevel);
    }

    // Prepare position
    await stockfishEngine.position(fen);

    // Search with depth
    const depthToUse = Math.max(1, Math.min(30, Number(depth) || 15));
    console.log('[stockfish] Searching with depth', depthToUse);

    const bestMove = await stockfishEngine.go({ depth: depthToUse });

    if (bestMove) {
      console.log('[stockfish] Best move:', bestMove);
      return bestMove;
    }

    console.warn('[stockfish] No best move returned, using fallback');
    return bestMoveFallback(fen, depth);

  } catch (err) {
    console.error('[stockfish] Error during search:', err);
    console.log('[stockfish] Falling back to simple algorithm');
    return bestMoveFallback(fen, depth);
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

  // Limit depth for fallback algorithm to avoid timeouts
  // Fallback is much slower than real Stockfish
  const requestedDepth = Number(depth) || 5;
  const maxDepth = Math.max(1, Math.min(5, requestedDepth));

  const player = chess.turn();
  const startTime = Date.now();
  const timeLimit = 8000; // 8 seconds max to stay under 10s browser timeout
  let nodeCount = 0;
  const maxNodes = 500000; // Limit nodes to prevent timeout

  function negamax(d, alpha, beta) {
    nodeCount++;

    // Timeout check every 1000 nodes
    if (nodeCount % 1000 === 0) {
      if (Date.now() - startTime > timeLimit) {
        return 0; // Return neutral eval if timeout
      }
      if (nodeCount > maxNodes) {
        return 0;
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

  // If no moves, return null
  if (moves.length === 0) return null;

  // Try iterative deepening - search shallow first, then deeper if time allows
  for (let searchDepth = 1; searchDepth <= maxDepth; searchDepth++) {
    if (Date.now() - startTime > timeLimit) break;

    bestMove = null;
    bestScore = -Infinity;

    for (const m of moves) {
      if (Date.now() - startTime > timeLimit) break;

      chess.move(m);
      const score = -negamax(searchDepth - 1, -Infinity, Infinity);
      chess.undo();

      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
      }
    }

    if (!bestMove) break;
  }

  if (!bestMove) return null;
  const promo = bestMove.promotion ? bestMove.promotion : '';
  return bestMove.from + bestMove.to + (promo || '');
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
  if (!depth) depth = 12;

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
    // Wrap with timeout to ensure we respond before browser timeout (10s)
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Engine search timeout')), 9000)
    );

    const searchPromise = bestMoveWithStockfish(fen, depth, elo);

    const best = await Promise.race([searchPromise, timeoutPromise]);

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
    else if (msg.type === 'clear_history') {
      const username = users.get(ws);
      const uname = String(username || '').toLowerCase();
      // allow admin constant OR anyone named 'zahir' (case-insensitive)
      if (!username || (uname !== 'zahir' && uname !== ADMINNAME)) {
        send(ws, { type: 'chess_error', message: 'permission_denied' });
      } else {
        // clear in-memory messages and reset index
        messages = [];
        idx = 0;
        try { fs.writeFileSync(MSG_FILE, ''); } catch (_) {}
        // notify all connected clients to clear their UI
        for (const w of wss.clients) {
          if (w.readyState === WebSocket.OPEN) send(w, { type: 'cleared', by: username });
        }
      }
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
