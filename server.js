const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const rooms = new Map();
const publicDir = path.join(__dirname, 'public');
const colors = ['#ff6b54', '#e7b72d', '#4ac9a5', '#5e9cff', '#cf78df', '#ff8eb2'];

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function code() {
  let value;
  do value = Math.random().toString(36).slice(2, 6).toUpperCase(); while (rooms.has(value));
  return value;
}

function snapshot(room) {
  const now = Date.now();
  if (room.status === 'playing' && now >= room.endsAt) finish(room);
  return {
    code: room.code, status: room.status, hostId: room.hostId, target: room.target,
    endsAt: room.endsAt, players: [...room.players.values()].map(({ id, ...player }) => player)
  };
}

function emit(room) {
  const data = `data: ${JSON.stringify(snapshot(room))}\n\n`;
  for (const client of room.clients) client.write(data);
}

function finish(room) {
  room.status = 'finished';
  room.target = null;
  clearTimeout(room.timer);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(); } });
  });
}

function makeRoom(name) {
  const room = { code: code(), status: 'lobby', hostId: randomUUID(), target: null, endsAt: null, players: new Map(), clients: new Set(), timer: null };
  room.players.set(room.hostId, { id: room.hostId, name, score: 0, color: colors[0] });
  rooms.set(room.code, room);
  return room;
}

function serveFile(req, res) {
  const requested = req.url === '/' ? '/index.html' : req.url;
  const file = path.normalize(path.join(publicDir, requested));
  if (!file.startsWith(publicDir)) return send(res, 403, { error: 'Nope.' });
  fs.readFile(file, (error, content) => {
    if (error) return send(res, 404, { error: 'Not found.' });
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'text/html';
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && !req.url.startsWith('/api/')) return serveFile(req, res);
  const match = req.url.match(/^\/api\/rooms\/([A-Z0-9]{4})(?:\/(events|start|claim))?$/);
  try {
    if (req.method === 'POST' && req.url === '/api/rooms') {
      const { name } = await readBody(req); const room = makeRoom(cleanName(name));
      return send(res, 201, { code: room.code, playerId: room.hostId, state: snapshot(room) });
    }
    if (req.method === 'POST' && req.url === '/api/join') {
      const { code: roomCode, name } = await readBody(req); const room = rooms.get(String(roomCode).toUpperCase());
      if (!room) return send(res, 404, { error: 'That room does not exist.' });
      if (room.status !== 'lobby') return send(res, 409, { error: 'This round is already underway.' });
      if (room.players.size >= 8) return send(res, 409, { error: 'This room is full.' });
      const id = randomUUID(); room.players.set(id, { id, name: cleanName(name), score: 0, color: colors[room.players.size] }); emit(room);
      return send(res, 201, { code: room.code, playerId: id, state: snapshot(room) });
    }
    if (!match) return send(res, 404, { error: 'Not found.' });
    const room = rooms.get(match[1]); if (!room) return send(res, 404, { error: 'That room has gone missing.' });
    if (req.method === 'GET' && match[2] === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      room.clients.add(res); res.write(`data: ${JSON.stringify(snapshot(room))}\n\n`); req.on('close', () => room.clients.delete(res)); return;
    }
    const body = await readBody(req);
    if (req.method === 'POST' && match[2] === 'start') {
      if (body.playerId !== room.hostId || room.status !== 'lobby') return send(res, 403, { error: 'Only the host can start the round.' });
      room.status = 'playing'; room.target = Math.floor(Math.random() * 9); room.endsAt = Date.now() + 60000;
      room.timer = setTimeout(() => { finish(room); emit(room); }, 60050); emit(room); return send(res, 200, snapshot(room));
    }
    if (req.method === 'POST' && match[2] === 'claim') {
      if (room.status !== 'playing' || !room.players.has(body.playerId)) return send(res, 409, { error: 'The relay is not live.' });
      if (Number(body.cell) === room.target) { room.players.get(body.playerId).score++; room.target = Math.floor(Math.random() * 9); emit(room); return send(res, 200, snapshot(room)); }
      return send(res, 200, snapshot(room));
    }
    send(res, 405, { error: 'Method not allowed.' });
  } catch { send(res, 400, { error: 'Please check that and try again.' }); }
});

function cleanName(value) { return String(value || 'Player').trim().replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 16) || 'Player'; }
server.listen(process.env.PORT || 3000, () => console.log('Orbit Relay ready on http://localhost:3000'));
