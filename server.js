const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const Game = require('./public/game.js');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// ---------- static files ----------

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const file = path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------- rooms ----------

const rooms = new Map();

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = Game.newRoom({ code: newCode(), lastActive: Date.now() });
  rooms.set(room.code, room);
  return room;
}

function ensureHost(room) {
  const host = Game.getPlayer(room, room.hostId);
  if (host && host.connected) return;
  const next = room.players.find((p) => p.connected);
  if (next) room.hostId = next.id;
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players) send(p.ws, { t: 'state', s: Game.view(room, p.id) });
}

const fail = (ws, msg, fatal = false) => send(ws, { t: 'error', msg, fatal });

// ---------- connections ----------

function attach(ws, room, pid, name) {
  let player = Game.getPlayer(room, pid);
  if (player) {
    if (player.ws && player.ws !== ws) {
      player.ws.room = null;
      player.ws.close();
    }
    player.name = name;
  } else {
    if (room.players.length >= Game.MAX_PLAYERS) return fail(ws, 'That room is full.', true);
    player = { id: pid, name, score: 0, ws: null, connected: false };
    room.players.push(player);
  }
  player.ws = ws;
  player.connected = true;
  ws.room = room;
  ws.pid = pid;
  ensureHost(room);
  broadcast(room);
}

function detach(ws) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  const player = Game.getPlayer(room, ws.pid);
  if (!player || player.ws !== ws) return;
  player.ws = null;
  player.connected = false;
  if (room.phase === 'lobby') room.players = room.players.filter((p) => p !== player);
  if (!room.players.length) {
    rooms.delete(room.code);
    return;
  }
  ensureHost(room);
  Game.maybeAdvance(room);
  broadcast(room);
}

function handle(ws, m) {
  if (m.t === 'create' || m.t === 'join') {
    const name = Game.cleanName(m.name);
    if (!name) return fail(ws, 'Enter your name first.', true);
    if (typeof m.pid !== 'string' || !/^[\w-]{8,64}$/.test(m.pid)) return fail(ws, 'Bad player id.', true);
    if (ws.room) detach(ws);
    if (m.t === 'create') {
      const room = createRoom();
      room.hostId = m.pid;
      return attach(ws, room, m.pid, name);
    }
    const room = rooms.get(String(m.code || '').trim().toUpperCase());
    if (!room) return fail(ws, 'No game found with that code.', true);
    return attach(ws, room, m.pid, name);
  }

  const room = ws.room;
  if (!room) return;
  const result = Game.act(room, ws.pid, m);
  if (!result) return;
  if (result.error) return fail(ws, result.error);
  broadcast(room);
}

const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    try {
      handle(ws, m);
    } catch (err) {
      console.error(err);
    }
  });
  ws.on('close', () => detach(ws));
  ws.on('error', () => {});
});

// Hosting proxies close idle connections, and phones vanish without saying goodbye:
// ping regularly to keep sockets open and to notice the dead ones.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 30 * 1000).unref();

// Drop rooms that everyone has abandoned.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.lastActive < cutoff && !room.players.some((p) => p.connected)) rooms.delete(code);
  }
}, 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Hues & Cues running:\n  on this computer:   http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  on the same Wi-Fi:  http://${a.address}:${PORT}`);
    }
  }
});
