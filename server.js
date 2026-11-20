'use strict';
// Sheep Royale 14.9: dependency-free HTTP and WebSocket server for private friend rooms.
const http = require('node:http');
const fs = require('node:fs');
const PUBLIC = __dirname;
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.resolve(__dirname, 'public');
const MAX_PLAYERS = 8;
const MAX_MESSAGE = 16 * 1024;
const ROOMS = new Map();
const ACTIVE_CONNECTIONS = new Set();
const RESPAWN_RADIUS = 15;
const BOUNDARY = 90;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const now = () => Date.now();
const finite = (v, min, max, d = 0) => Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : d;
const broadcast = (room, message) => { for (const p of room.players) p.ws?.sendJson(message); };
const publicPlayer = p => ({ id: p.id, name: p.name, color: p.color, alive: p.alive, host: !!p.host });
const sendRoom = room => broadcast(room, { type: 'roster', room: room.code, phase: room.phase, players: room.players.map(publicPlayer) });
const validCode = s => typeof s === 'string' && /^[A-HJ-NP-Z2-9]{5}$/.test(s.toUpperCase());
const cleanName = s => (typeof s === 'string' ? s.replace(/[<>\x00-\x1F\x7F]/g, '').trim().slice(0, 18) : '') || 'Sheep';
const cleanColor = color => Array.isArray(color) && color.length === 3 ? color.map(v => finite(v, 0.06, 1.3, .9)) : [1, 1, 1];
const createCode = () => { for (let n = 0; n < 50; n++) { let code = ''; for (let k = 0; k < 5; k++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; if (!ROOMS.has(code)) return code; } throw Error('Too many rooms'); };
const roomOf = ws => ws.player?.room;

function leave(ws) {
  const p = ws.player;
  if (!p) return;
  const room = p.room;
  ws.player = null;
  const idx = room.players.indexOf(p);
  if (idx >= 0) room.players.splice(idx, 1);
  if (!room.players.length) { ROOMS.delete(room.code); return; }
  if (p.host) { room.players[0].host = true; }
  broadcast(room, { type: 'departed', id: p.id, name: p.name });
  if (room.phase === 'playing') maybeFinish(room);
  sendRoom(room);
}
function join(ws, room, name, color) {
  if (ws.player) leave(ws);
  if (room.phase === 'playing') return ws.sendJson({ type: 'error', message: 'That match has already started. Try again after it ends.' });
  if (room.players.length >= MAX_PLAYERS) return ws.sendJson({ type: 'error', message: 'This room is full (8 sheep).' });
  const p = { id: crypto.randomBytes(8).toString('hex'), name: cleanName(name), color: cleanColor(color), ws, room, alive: true, host: !room.players.length, state: null, lastUpdate: 0, lastAttacker: null, lastHit: 0, lastRam: 0 };
  room.players.push(p);
  ws.player = p;
  ws.sendJson({ type: 'joined', id: p.id, room: room.code, phase: room.phase });
  sendRoom(room);
}
function maybeFinish(room) {
  if (room.phase !== 'playing') return;
  const living = room.players.filter(p => p.alive);
  if (living.length > 1) return;
  room.phase = 'lobby';
  const winner = living[0] || null;
  broadcast(room, { type: 'match_end', winnerId: winner?.id || null, winnerName: winner?.name || 'Nobody' });
  sendRoom(room);
}
function eliminate(room, p, reason) {
  if (room.phase !== 'playing' || !p.alive) return;
  p.alive = false;
  const attacker = now() - p.lastHit < 5000 ? p.lastAttacker : null;
  broadcast(room, { type: 'eliminated', id: p.id, reason: reason === 'border' ? 'border' : 'tip', by: attacker });
  maybeFinish(room);
}
function launchHits(room, attacker) {
  if (room.phase !== 'playing' || !attacker.alive || !attacker.state || attacker.state.ram <= 0) return;
  const a = attacker.state;
  for (const victim of room.players) {
    if (!victim.alive || victim === attacker || !victim.state) continue;
    const b = victim.state;
    const dx = b.x - a.x, dz = b.z - a.z, dist = Math.hypot(dx, dz);
    if (dist > 3.8 || dist < .01 || Math.cos(a.heading) * dz / dist + Math.sin(a.heading) * dx / dist < .10) continue;
    const key = attacker.id + '/' + victim.id;
    if (now() - (room.contactTimes.get(key) || 0) < 750) continue;
    room.contactTimes.set(key, now());
    victim.lastAttacker = attacker.id;
    victim.lastHit = now();
    const force = 27;
    victim.ws?.sendJson({ type: 'hit', by: attacker.id, x: dx / dist * force, z: dz / dist * force, y: 4.5, kick: 4.0 });
    broadcast(room, { type: 'impact', by: attacker.id, target: victim.id, x: b.x, z: b.z });
  }
}
function handle(ws, msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return;
  let room = roomOf(ws), p = ws.player;
  switch (msg.type) {
    case 'create': {
      if (ROOMS.size >= 300) return ws.sendJson({ type: 'error', message: 'The room server is busy.' });
      if (ws.player) leave(ws);
      room = { code: createCode(), phase: 'lobby', players: [], contactTimes: new Map(), startAt: 0 };
      ROOMS.set(room.code, room);
      join(ws, room, msg.name, msg.color);
      break;
    }
    case 'join': {
      const code = String(msg.room || '').trim().toUpperCase();
      if (!validCode(code) || !ROOMS.has(code)) return ws.sendJson({ type: 'error', message: 'Room not found. Check the 5-letter code.' });
      join(ws, ROOMS.get(code), msg.name, msg.color);
      break;
    }
    case 'leave': leave(ws); break;
    case 'start': {
      if (!p || !p.host || room.phase !== 'lobby') return;
      if (room.players.length < 2) return ws.sendJson({ type: 'error', message: 'Invite at least one friend before starting.' });
      room.phase = 'playing';
      room.startAt = now() + 900;
      room.contactTimes.clear();
      const n = room.players.length;
      for (let i = 0; i < n; i++) {
        const other = room.players[i], angle = (i / n) * Math.PI * 2;
        other.alive = true; other.state = null; other.lastAttacker = null; other.lastHit = 0; other.lastUpdate = 0;
        other.spawn = { x: Math.sin(angle) * RESPAWN_RADIUS, z: Math.cos(angle) * RESPAWN_RADIUS, heading: angle + Math.PI };
      }
      broadcast(room, { type: 'match_start', startAt: room.startAt, radius: BOUNDARY,
        spawns: room.players.map(other => ({ id: other.id, ...other.spawn, name: other.name, color: other.color })) });
      sendRoom(room);
      break;
    }
    case 'state': {
      if (!p || room.phase !== 'playing' || !p.alive || now() < room.startAt || !msg.state) return;
      if (now() - p.lastUpdate < 27) return;
      p.lastUpdate = now();
      const s = msg.state;
      p.state = { x: finite(s.x, -95, 95), z: finite(s.z, -95, 95), heading: finite(s.heading, -7, 7),
        tilt: finite(s.tilt, -1.75, 1.75), bank: finite(s.bank, -1.75, 1.75), air: finite(s.air, 0, 30),
        vx: finite(s.vx, -150, 150), vz: finite(s.vz, -150, 150), ram: finite(s.ram, 0, 2) };
      if (Math.hypot(p.state.x, p.state.z) >= BOUNDARY - .8) { eliminate(room, p, 'border'); return; }
      launchHits(room, p);
      break;
    }
    case 'dead': if (p && room.phase === 'playing' && now() >= room.startAt) eliminate(room, p, msg.reason); break;
    case 'ping': ws.sendJson({ type: 'pong' }); break;
  }
}

// Tiny RFC 6455 implementation: enough for browsers, with masking, controls, and bounds checks.
class WebSocketPeer {
  constructor(socket) { this.socket = socket; this.buffer = Buffer.alloc(0); this.player = null; this.closed = false; this.lastMessage = now(); }
  sendFrame(op, data = Buffer.alloc(0)) {
    if (this.closed || !this.socket.writable || this.socket.writableLength > 512 * 1024) return;
    const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const n = body.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : Buffer.from([0x80 | op, 126, (n >>> 8) & 255, n & 255]);
    try { this.socket.write(Buffer.concat([head, body])); } catch (_) { this.close(); }
  }
  sendJson(value) { this.sendFrame(1, JSON.stringify(value)); }
  close() { if (this.closed) return; this.closed = true; ACTIVE_CONNECTIONS.delete(this); leave(this); this.socket.destroy(); }
  ingest(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_MESSAGE * 2) return this.close();
    while (this.buffer.length >= 2) {
      const a = this.buffer[0], b = this.buffer[1], op = a & 0x0f, masked = !!(b & 0x80);
      if (!(a & 0x80) || !masked || (a & 0x70)) return this.close();
      let len = b & 127, offset = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); offset = 4; }
      if (len === 127 || len > MAX_MESSAGE) return this.close();
      if (this.buffer.length < offset + 4 + len) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4];
      this.buffer = this.buffer.subarray(offset + 4 + len);
      this.lastMessage = now();
      if (op === 8) return this.close();
      if (op === 9) { this.sendFrame(10, payload); continue; }
      if (op === 10) continue;
      if (op !== 1) return this.close();
      try { handle(this, JSON.parse(payload.toString('utf8'))); } catch (_) { this.sendJson({ type: 'error', message: 'Invalid message' }); }
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/healthz') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ ok: true, rooms: ROOMS.size })); }
  if (pathname !== '/' && pathname !== '/index.html') { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(PUBLIC, 'index.html'), (err, bytes) => {
    if (err) { res.writeHead(500); return res.end('Game not installed'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "frame-ancestors 'self' https://itch.io https://*.itch.io" });
    if (req.method === 'HEAD') return res.end();
    res.end(bytes);
  });
});
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  const host = req.headers.host;
  try {
    if (new URL(req.url, 'http://localhost').pathname !== '/ws' || req.headers.upgrade?.toLowerCase() !== 'websocket') throw Error('Not supported');
    if (origin && new URL(origin).host !== host) throw Error('Wrong origin');
    const key = req.headers['sec-websocket-key'];
    if (req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) throw Error('Bad key');
    if (ACTIVE_CONNECTIONS.size > 2500) throw Error('Server busy');
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const peer = new WebSocketPeer(socket);
    ACTIVE_CONNECTIONS.add(peer);
    socket.on('data', buf => peer.ingest(buf));
    socket.on('error', () => peer.close());
    socket.on('close', () => peer.close());
    peer.sendJson({ type: 'connected', version: '14.9', maxPlayers: MAX_PLAYERS });
    if (head?.length) peer.ingest(head);
  } catch (_) { socket.destroy(); }
});
setInterval(() => {
  for (const room of ROOMS.values()) {
    if (room.phase !== 'playing') continue;
    const snapshot = { type: 'snapshot', time: now(), players: room.players.map(p => ({ id: p.id, alive: p.alive, name: p.name, color: p.color, ...p.state })) };
    broadcast(room, snapshot);
  }
}, 66);
setInterval(() => {
  for (const peer of ACTIVE_CONNECTIONS) {
    if (now() - peer.lastMessage > 90000) peer.close();
    else peer.sendFrame(9, Buffer.from('alive'));
  }
}, 20000);
server.listen(PORT, HOST, () => console.log(`Sheep Royale 14.9 online at http://${HOST}:${PORT}`));
module.exports = { server, ROOMS };
