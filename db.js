const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const DB_PATH = path.join(dataDir, 'panel.db');

let db = null;

async function initDB() {
  const SQL = await initSqlJs();

  // Load existing database or create new one
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'admin',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      pc_name TEXT,
      username TEXT,
      os TEXT,
      os_version TEXT,
      cpu TEXT,
      ram TEXT,
      public_ip TEXT,
      local_ip TEXT,
      location TEXT,
      is_online INTEGER DEFAULT 0,
      last_seen DATETIME,
      first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      socket_id TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS command_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT,
      command TEXT,
      result TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create default admin user
  const result = db.exec("SELECT id FROM users WHERE username = 'admin'");
  if (result.length === 0) {
    const hashedPassword = bcrypt.hashSync('admin', 10);
    db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", ['admin', hashedPassword, 'admin']);
    console.log('[DB] ✅ Usuario admin creado (usuario: admin / contraseña: admin)');
  }

  saveDB();
  
  // Auto-save every 30 seconds
  setInterval(saveDB, 30000);
  
  return db;
}

function saveDB() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

function getDB() { return db; }

// Helper methods to match better-sqlite3 API style
function sanitize(params) {
  return params.map(p => p === undefined ? null : p);
}

function prepare(sql) {
  return {
    get(...params) {
      const stmt = db.prepare(sql);
      stmt.bind(sanitize(params));
      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
      }
      stmt.free();
      return undefined;
    },
    all(...params) {
      const results = [];
      const stmt = db.prepare(sql);
      stmt.bind(sanitize(params));
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      stmt.free();
      return results;
    },
    run(...params) {
      db.run(sql, sanitize(params));
      saveDB();
    }
  };
}

module.exports = { initDB, getDB, prepare, saveDB };
