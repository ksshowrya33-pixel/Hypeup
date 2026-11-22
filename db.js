// Dual Database Adapter: PostgreSQL (Supabase) when DATABASE_URL is set, otherwise SQLite
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const IS_PG = !!process.env.DATABASE_URL;
const IS_VERCEL = !!process.env.VERCEL;
const DB_PATH = process.env.DB_PATH || (IS_VERCEL ? '/tmp/hypeup.db' : path.join(__dirname, 'hypeup.db'));

const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');

function toPgSql(sql) {
  let idx = 0;
  return sql
    .replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/\?/g, () => `$${++idx}`);
}

let pool = null;
let sqlite = null;

if (IS_PG) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5
  });
} else {
  const Database = require('better-sqlite3');
  sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
}

async function queryAll(sql, params = []) {
  if (IS_PG) {
    const res = await pool.query(toPgSql(sql), params);
    return res.rows;
  }
  return sqlite.prepare(sql).all(...params);
}

async function queryGet(sql, params = []) {
  if (IS_PG) {
    const res = await pool.query(toPgSql(sql), params);
    return res.rows[0] || null;
  }
  return sqlite.prepare(sql).get(...params) || null;
}

async function execute(sql, params = []) {
  if (IS_PG) {
    const res = await pool.query(toPgSql(sql), params);
    return { changes: res.rowCount || 0 };
  }
  const info = sqlite.prepare(sql).run(...params);
  return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
}

async function insert(sql, params = []) {
  if (IS_PG) {
    const res = await pool.query(toPgSql(sql) + ' RETURNING id', params);
    return res.rows[0]?.id;
  }
  const info = sqlite.prepare(sql).run(...params);
  return info.lastInsertRowid;
}

let initPromise = null;

async function ensureReady() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (IS_PG) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id            SERIAL PRIMARY KEY,
          name          TEXT NOT NULL,
          email         TEXT NOT NULL UNIQUE,
          usn           TEXT NOT NULL DEFAULT '',
          department    TEXT NOT NULL DEFAULT 'CSE',
          role          TEXT NOT NULL CHECK (role IN ('student', 'faculty', 'admin')),
          password_hash TEXT NOT NULL,
          salt          TEXT NOT NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS events (
          id          SERIAL PRIMARY KEY,
          title       TEXT NOT NULL,
          category    TEXT NOT NULL,
          event_date  TEXT NOT NULL,
          event_time  TEXT NOT NULL DEFAULT '10:00 AM',
          venue       TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          capacity    INTEGER NOT NULL DEFAULT 100 CHECK (capacity > 0),
          image_url   TEXT NOT NULL DEFAULT '',
          status      TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected')),
          created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
          approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS registrations (
          id            SERIAL PRIMARY KEY,
          ticket_id     TEXT NOT NULL UNIQUE,
          event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
          name          TEXT NOT NULL,
          email         TEXT NOT NULL,
          usn           TEXT NOT NULL DEFAULT '',
          department    TEXT NOT NULL DEFAULT '',
          checked_in    INTEGER NOT NULL DEFAULT 0,
          checked_in_at TIMESTAMPTZ,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (event_id, email)
        );
        CREATE TABLE IF NOT EXISTS announcements (
          id              SERIAL PRIMARY KEY,
          title           TEXT NOT NULL,
          message         TEXT NOT NULL,
          created_by_name TEXT NOT NULL,
          created_by_role TEXT NOT NULL,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS audit_logs (
          id         SERIAL PRIMARY KEY,
          actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
          actor_name TEXT NOT NULL,
          actor_role TEXT NOT NULL,
          action     TEXT NOT NULL,
          target     TEXT NOT NULL,
          details    TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    } else {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          name          TEXT NOT NULL,
          email         TEXT NOT NULL UNIQUE,
          usn           TEXT NOT NULL DEFAULT '',
          department    TEXT NOT NULL DEFAULT 'CSE',
          role          TEXT NOT NULL CHECK (role IN ('student', 'faculty', 'admin')),
          password_hash TEXT NOT NULL,
          salt          TEXT NOT NULL,
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS events (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          title       TEXT NOT NULL,
          category    TEXT NOT NULL,
          event_date  TEXT NOT NULL,
          event_time  TEXT NOT NULL DEFAULT '10:00 AM',
          venue       TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          capacity    INTEGER NOT NULL DEFAULT 100 CHECK (capacity > 0),
          image_url   TEXT NOT NULL DEFAULT '',
          status      TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected')),
          created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
          approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS registrations (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          ticket_id     TEXT NOT NULL UNIQUE,
          event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
          name          TEXT NOT NULL,
          email         TEXT NOT NULL,
          usn           TEXT NOT NULL DEFAULT '',
          department    TEXT NOT NULL DEFAULT '',
          checked_in    INTEGER NOT NULL DEFAULT 0,
          checked_in_at TEXT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (event_id, email)
        );
        CREATE TABLE IF NOT EXISTS announcements (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          title           TEXT NOT NULL,
          message         TEXT NOT NULL,
          created_by_name TEXT NOT NULL,
          created_by_role TEXT NOT NULL,
          created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS audit_logs (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
          actor_name TEXT NOT NULL,
          actor_role TEXT NOT NULL,
          action     TEXT NOT NULL,
          target     TEXT NOT NULL,
          details    TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      try { sqlite.exec("ALTER TABLE events ADD COLUMN image_url TEXT NOT NULL DEFAULT ''"); } catch (_) {}
    }

    const userCount = await queryGet('SELECT COUNT(*) AS n FROM users');
    if (Number(userCount?.n || 0) === 0) {
      const addUser = async ({ name, email, usn, department, role, password }) => {
        const salt = crypto.randomBytes(16).toString('hex');
        return insert(
          'INSERT INTO users (name, email, usn, department, role, password_hash, salt) VALUES (?,?,?,?,?,?,?)',
          [name, email.toLowerCase(), usn, department, role, hashPw(password, salt), salt]
        );
      };

      const adminId = await addUser({
        name: 'Campus Admin',
        email: process.env.ADMIN_EMAIL || 'ksshowrya33@gmail.com',
        usn: 'ADM001',
        department: 'Administration',
        role: 'admin',
        password: process.env.ADMIN_PASS || 'Avengers@2027'
      });
      const facultyId = await addUser({
        name: 'Dr. Ananya Rao',
        email: 'faculty@hypeup.edu',
        usn: 'FAC101',
        department: 'CSE',
        role: 'faculty',
        password: 'faculty123'
      });
      await addUser({
        name: 'Aarav Sharma',
        email: 'student@hypeup.edu',
        usn: 'ENG25CS0001',
        department: 'CSE',
        role: 'student',
        password: 'student123'
      });

      const evCount = await queryGet('SELECT COUNT(*) AS n FROM events');
      if (Number(evCount?.n || 0) === 0) {
        const addEv = (title, cat, dt, tm, ven, desc, cap, st, cBy, aBy) =>
          execute(
            'INSERT INTO events (title, category, event_date, event_time, venue, description, capacity, status, created_by, approved_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [title, cat, dt, tm, ven, desc, cap, st, cBy, aBy]
          );
        await addEv('Tech Fest 2026', 'Technology', '2026-12-15', '09:30 AM', 'Main Auditorium', 'A full-day technology festival featuring AI hackathons, coding sprints, and robotics showcases.', 150, 'approved', facultyId, adminId);
        await addEv('Cultural Night', 'Cultural', '2026-12-20', '06:00 PM', 'College Ground', 'Music, classical and contemporary dance, band performances, and cultural showcases.', 300, 'approved', adminId, adminId);
        await addEv('Sports Day', 'Sports', '2026-12-25', '08:00 AM', 'Sports Ground', 'Inter-departmental athletics, football, cricket, and track competitions.', 200, 'approved', facultyId, adminId);
        await addEv('CASCADES 2026', 'Entertainment', '2026-12-28', '05:00 PM', 'Open Arena', 'A flagship two-day college fest featuring live DJ night, fashion ramp walk, and stand-up comedy.', 500, 'approved', adminId, adminId);
        await addEv('Cloud & DevOps Workshop', 'Workshop', '2026-12-18', '02:00 PM', 'CSE Seminar Hall 2', 'Hands-on Docker, CI/CD, and cloud deployment bootcamp led by CSE faculty.', 80, 'pending', facultyId, null);

        await execute(
          'INSERT INTO audit_logs (actor_id, actor_name, actor_role, action, target, details) VALUES (?,?,?,?,?,?)',
          [adminId, 'Campus Admin', 'admin', 'SYSTEM_INIT', 'Database Seeded', 'Initialized default Admin, Faculty, Student accounts and sample events.']
        );
      }
    }

    const annCount = await queryGet('SELECT COUNT(*) AS n FROM announcements');
    if (Number(annCount?.n || 0) === 0) {
      await execute(
        'INSERT INTO announcements (title, message, created_by_name, created_by_role) VALUES (?,?,?,?)',
        ['Registrations Open for Dec 2026 Fest!', 'Students can now log in with their USN to register for upcoming campus events and download instant QR passes.', 'Campus Admin', 'admin']
      );
    }
  })().catch(err => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

async function getStorageInfo() {
  const tableNames = ['users', 'events', 'registrations', 'announcements', 'audit_logs'];
  const tables = [];
  for (const t of tableNames) {
    const r = await queryGet(`SELECT COUNT(*) AS n FROM ${t}`);
    tables.push({ table: t, rows: Number(r?.n || 0) });
  }
  if (IS_PG) {
    const sz = await queryGet('SELECT pg_database_size(current_database()) AS bytes');
    return {
      engine: 'Supabase PostgreSQL (pg Pool, SSL)',
      file_path: 'Cloud Managed PostgreSQL (DATABASE_URL)',
      size_kb: Math.round((Number(sz?.bytes || 0) / 1024) * 10) / 10,
      tables
    };
  }
  const stats = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH) : { size: 0 };
  return {
    engine: 'SQLite 3 (better-sqlite3, WAL mode, Foreign Keys ON)',
    file_path: DB_PATH,
    size_kb: Math.round((stats.size / 1024) * 10) / 10,
    tables
  };
}

module.exports = {
  IS_PG,
  DB_PATH,
  hashPw,
  queryAll,
  queryGet,
  execute,
  insert,
  ensureReady,
  getStorageInfo
};
