const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { initDB, prepare, saveDB } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 200e6 });

const PORT = process.env.PORT || 3000;

// Ensure upload directories
const uploadsDir = path.join(__dirname, 'data', 'uploads');
const screenshotsDir = path.join(__dirname, 'data', 'screenshots');
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(screenshotsDir, { recursive: true });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));
app.use('/screenshots', express.static(screenshotsDir));

const upload = multer({ dest: uploadsDir });

// ============================================
// REST API (initialized after DB is ready)
// ============================================
function setupRoutes() {
  const { authMiddleware, login, verifyToken } = require('./auth');

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const result = login(username, password);
    if (!result) return res.status(401).json({ error: 'Credenciales inválidas' });
    res.json(result);
  });

  app.get('/api/devices', authMiddleware, (req, res) => {
    const devices = prepare('SELECT * FROM devices ORDER BY is_online DESC, last_seen DESC').all();
    res.json(devices);
  });

  app.get('/api/devices/:id', authMiddleware, (req, res) => {
    const device = prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
    if (!device) return res.status(404).json({ error: 'Dispositivo no encontrado' });
    res.json(device);
  });

  app.get('/api/logs/:deviceId', authMiddleware, (req, res) => {
    const logs = prepare('SELECT * FROM command_logs WHERE device_id = ? ORDER BY created_at DESC LIMIT 100').all(req.params.deviceId);
    res.json(logs);
  });

  // ============================================
  // SOCKET.IO
  // ============================================
  const agentSockets = new Map();
  const panelSockets = new Map();
  const screenStreams = new Map();

  function getAgentSocket(deviceId) {
    const s = agentSockets.get(deviceId);
    return s && s.connected ? s : null;
  }

  function broadcastDeviceList() {
    const devices = prepare('SELECT * FROM devices ORDER BY is_online DESC, last_seen DESC').all();
    for (const [, info] of panelSockets) {
      info.socket.emit('devices-update', devices);
    }
  }

  // Auth middleware for Socket.IO
  io.use((socket, next) => {
    const { type, token } = socket.handshake.auth;
    if (type === 'agent') {
      socket.agentType = true;
      return next();
    }
    if (type === 'panel') {
      const decoded = verifyToken(token);
      if (!decoded) return next(new Error('Token inválido'));
      socket.panelUser = decoded;
      return next();
    }
    next(new Error('Tipo de conexión desconocido'));
  });

  io.on('connection', (socket) => {
    if (socket.agentType) handleAgentConnection(socket, agentSockets, panelSockets, screenStreams, broadcastDeviceList);
    else if (socket.panelUser) handlePanelConnection(socket, agentSockets, panelSockets, screenStreams, broadcastDeviceList);
  });
}

// ============================================
// AGENT handler
// ============================================
function handleAgentConnection(socket, agentSockets, panelSockets, screenStreams, broadcastDeviceList) {
  let deviceId = null;
  console.log(`[AGENT] 🔌 Agente conectado: ${socket.id}`);

  socket.on('register', (info) => {
    deviceId = info.deviceId || uuidv4().substring(0, 12);
    const existing = prepare('SELECT id FROM devices WHERE id = ?').get(deviceId);

    if (existing) {
      prepare(`UPDATE devices SET session_id=?, pc_name=?, username=?, os=?, os_version=?,
        cpu=?, ram=?, public_ip=?, local_ip=?, location=?,
        is_online=1, last_seen=datetime('now'), socket_id=? WHERE id=?`).run(
        info.sessionId, info.pcName, info.username, info.os, info.osVersion || '',
        info.cpu || '', info.ram || '', info.publicIp || '', info.localIp || '',
        info.location || '', socket.id, deviceId
      );
    } else {
      prepare(`INSERT INTO devices (id, session_id, pc_name, username, os, os_version,
        cpu, ram, public_ip, local_ip, location, is_online, last_seen, socket_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,1,datetime('now'),?)`).run(
        deviceId, info.sessionId, info.pcName, info.username, info.os, info.osVersion || '',
        info.cpu || '', info.ram || '', info.publicIp || '', info.localIp || '',
        info.location || '', socket.id
      );
    }

    agentSockets.set(deviceId, socket);
    socket.deviceId = deviceId;
    console.log(`[AGENT] ✅ Registrado: ${info.pcName} (${deviceId})`);
    broadcastDeviceList();

    for (const [, p] of panelSockets) {
      p.socket.emit('device-connected', { deviceId, ...info });
    }
  });

  socket.on('heartbeat', () => {
    if (deviceId) {
      prepare("UPDATE devices SET last_seen=datetime('now'), is_online=1 WHERE id=?").run(deviceId);
    }
  });

  socket.on('command-result', (data) => {
    prepare('INSERT INTO command_logs (device_id, command, result, status) VALUES (?,?,?,?)').run(
      deviceId, data.command, (data.result || '').substring(0, 5000), 'completed'
    );
    for (const [, p] of panelSockets) {
      p.socket.emit('command-result', { deviceId, ...data });
    }
  });

  socket.on('screenshot-result', (data) => {
    const filename = `screenshot_${deviceId}_${Date.now()}.jpg`;
    const filepath = path.join(screenshotsDir, filename);
    fs.writeFileSync(filepath, Buffer.from(data.image, 'base64'));
    for (const [, p] of panelSockets) {
      p.socket.emit('screenshot-result', { deviceId, image: data.image, filename, timestamp: new Date().toISOString() });
    }
  });

  socket.on('screen-frame', (data) => {
    const watchers = screenStreams.get(deviceId);
    if (watchers && watchers.size > 0) {
      for (const panelSocketId of watchers) {
        const panelInfo = panelSockets.get(panelSocketId);
        if (panelInfo) {
          panelInfo.socket.emit('screen-frame', { deviceId, frame: data.frame, timestamp: Date.now() });
        }
      }
    }
  });

  socket.on('file-data', (data) => {
    for (const [, p] of panelSockets) p.socket.emit('file-data', { deviceId, ...data });
  });

  socket.on('file-chunk', (data) => {
    for (const [, p] of panelSockets) p.socket.emit('file-chunk', { deviceId, ...data });
  });

  socket.on('processes-result', (data) => {
    for (const [, p] of panelSockets) p.socket.emit('processes-result', { deviceId, ...data });
  });

  socket.on('ls-result', (data) => {
    for (const [, p] of panelSockets) p.socket.emit('ls-result', { deviceId, ...data });
  });

  socket.on('disconnect', () => {
    if (deviceId) {
      prepare("UPDATE devices SET is_online=0, last_seen=datetime('now') WHERE id=?").run(deviceId);
      agentSockets.delete(deviceId);
      screenStreams.delete(deviceId);
      console.log(`[AGENT] ❌ Desconectado: ${deviceId}`);
      broadcastDeviceList();
      for (const [, p] of panelSockets) p.socket.emit('device-disconnected', { deviceId });
    }
  });
}

// ============================================
// PANEL handler
// ============================================
function handlePanelConnection(socket, agentSockets, panelSockets, screenStreams, broadcastDeviceList) {
  console.log(`[PANEL] 🌐 Panel conectado: ${socket.panelUser.username}`);
  panelSockets.set(socket.id, { socket, userId: socket.panelUser.id });

  const devices = prepare('SELECT * FROM devices ORDER BY is_online DESC, last_seen DESC').all();
  socket.emit('devices-update', devices);

  function getAgent(deviceId) {
    const s = agentSockets.get(deviceId);
    return s && s.connected ? s : null;
  }

  socket.on('send-command', (data) => {
    const agent = getAgent(data.deviceId);
    if (!agent) return socket.emit('command-result', { deviceId: data.deviceId, command: data.command, result: '❌ Dispositivo offline', error: true });
    console.log(`[CMD] ${socket.panelUser.username} → ${data.deviceId}: ${data.command} ${data.args || ''}`);
    agent.emit('execute-command', { command: data.command, args: data.args, requestId: uuidv4().substring(0, 8) });
  });

  socket.on('request-screenshot', (data) => { const a = getAgent(data.deviceId); if (a) a.emit('take-screenshot'); });

  socket.on('start-screen-stream', (data) => {
    const { deviceId } = data;
    if (!screenStreams.has(deviceId)) screenStreams.set(deviceId, new Set());
    screenStreams.get(deviceId).add(socket.id);
    const a = getAgent(deviceId);
    if (a) a.emit('start-screen-stream', { fps: data.fps || 2, quality: data.quality || 40 });
  });

  socket.on('stop-screen-stream', (data) => {
    const { deviceId } = data;
    const watchers = screenStreams.get(deviceId);
    if (watchers) {
      watchers.delete(socket.id);
      if (watchers.size === 0) {
        const a = getAgent(deviceId);
        if (a) a.emit('stop-screen-stream');
        screenStreams.delete(deviceId);
      }
    }
  });

  socket.on('request-download', (data) => { const a = getAgent(data.deviceId); if (a) a.emit('download-file', { filepath: data.filepath }); });
  socket.on('upload-file', (data) => { const a = getAgent(data.deviceId); if (a) a.emit('upload-file', { filename: data.filename, data: data.data, destPath: data.destPath }); });
  socket.on('request-ls', (data) => { const a = getAgent(data.deviceId); if (a) a.emit('list-directory', { path: data.path }); });
  socket.on('request-processes', (data) => { const a = getAgent(data.deviceId); if (a) a.emit('get-processes'); });
  socket.on('remote-input', (data) => { const a = getAgent(data.deviceId); if (a) a.emit('remote-input', data); });

  socket.on('disconnect', () => {
    for (const [deviceId, watchers] of screenStreams) {
      watchers.delete(socket.id);
      if (watchers.size === 0) {
        const a = getAgent(deviceId);
        if (a) a.emit('stop-screen-stream');
        screenStreams.delete(deviceId);
      }
    }
    panelSockets.delete(socket.id);
    console.log(`[PANEL] 🔌 Panel desconectado: ${socket.panelUser?.username}`);
  });
}

// ============================================
// START
// ============================================
async function start() {
  await initDB();
  setupRoutes();

  server.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   🛡️  DEFENDER Panel Web v2.0                ║');
    console.log('║   Administración Remota                      ║');
    console.log(`║   🌐 http://localhost:${PORT}                    ║`);
    console.log('║   👤 Login: admin / admin                    ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
  });
}

start().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
