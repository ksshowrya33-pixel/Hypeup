// HypeUp – Smart Campus Event & Role-Based Engagement Platform (Express + SQLite)
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3002;
const CATEGORIES = ['Technology', 'Cultural', 'Sports', 'Entertainment', 'Workshop'];
const ROLES = ['student', 'faculty', 'admin'];
const IS_VERCEL = !!process.env.VERCEL;
const DB_PATH = process.env.DB_PATH || (IS_VERCEL ? '/tmp/hypeup.db' : path.join(__dirname, 'hypeup.db'));

/* ---------- Database: persistent relational storage in hypeup.db ---------- */
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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

try { db.exec("ALTER TABLE events ADD COLUMN image_url TEXT NOT NULL DEFAULT ''"); } catch (_) {}

const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');

function createUser({ name, email, usn, department, role, password }) {
  const salt = crypto.randomBytes(16).toString('hex');
  const info = db.prepare(
    'INSERT INTO users (name, email, usn, department, role, password_hash, salt) VALUES (?,?,?,?,?,?,?)'
  ).run(name, email.toLowerCase(), usn, department, role, hashPw(password, salt), salt);
  return info.lastInsertRowid;
}

function logAction(actor, action, target, details = '') {
  db.prepare(
    'INSERT INTO audit_logs (actor_id, actor_name, actor_role, action, target, details) VALUES (?,?,?,?,?,?)'
  ).run(actor?.id || null, actor?.name || 'System', actor?.role || 'system', action, target, details);
}

/* ---------- First-run seed data ---------- */
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  const adminId = createUser({
    name: 'Campus Admin',
    email: process.env.ADMIN_EMAIL || 'ksshowrya33@gmail.com',
    usn: 'ADM001',
    department: 'Administration',
    role: 'admin',
    password: process.env.ADMIN_PASS || 'Avengers@2027'
  });
  const facultyId = createUser({
    name: 'Dr. Ananya Rao',
    email: 'faculty@hypeup.edu',
    usn: 'FAC101',
    department: 'CSE',
    role: 'faculty',
    password: 'faculty123'
  });
  createUser({
    name: 'Aarav Sharma',
    email: 'student@hypeup.edu',
    usn: 'ENG25CS0001',
    department: 'CSE',
    role: 'student',
    password: 'student123'
  });

  if (db.prepare('SELECT COUNT(*) AS n FROM events').get().n === 0) {
    const ins = db.prepare(
      'INSERT INTO events (title, category, event_date, event_time, venue, description, capacity, status, created_by, approved_by) VALUES (?,?,?,?,?,?,?,?,?,?)'
    );
    ins.run('Tech Fest 2026', 'Technology', '2026-12-15', '09:30 AM', 'Main Auditorium', 'A full-day technology festival featuring AI hackathons, coding sprints, and robotics showcases.', 150, 'approved', facultyId, adminId);
    ins.run('Cultural Night', 'Cultural', '2026-12-20', '06:00 PM', 'College Ground', 'Music, classical and contemporary dance, band performances, and cultural showcases.', 300, 'approved', adminId, adminId);
    ins.run('Sports Day', 'Sports', '2026-12-25', '08:00 AM', 'Sports Ground', 'Inter-departmental athletics, football, cricket, and track competitions.', 200, 'approved', facultyId, adminId);
    ins.run('CASCADES 2026', 'Entertainment', '2026-12-28', '05:00 PM', 'Open Arena', 'A flagship two-day college fest featuring live DJ night, fashion ramp walk, and stand-up comedy.', 500, 'approved', adminId, adminId);
    ins.run('Cloud & DevOps Workshop', 'Workshop', '2026-12-18', '02:00 PM', 'CSE Seminar Hall 2', 'Hands-on Docker, CI/CD, and cloud deployment bootcamp led by CSE faculty.', 80, 'pending', facultyId, null);

    logAction({ id: adminId, name: 'Campus Admin', role: 'admin' }, 'SYSTEM_INIT', 'Database Seeded', 'Initialized default Admin, Faculty, Student accounts and sample events.');
  }
}

if (db.prepare('SELECT COUNT(*) AS n FROM announcements').get().n === 0) {
  db.prepare(
    'INSERT INTO announcements (title, message, created_by_name, created_by_role) VALUES (?,?,?,?)'
  ).run('Registrations Open for Dec 2026 Fest!', 'Students can now log in with their USN to register for upcoming campus events and download instant QR passes.', 'Campus Admin', 'admin');
}

/* ---------- Helpers ---------- */
const EVENTS_SQL = `
  SELECT e.*,
    u.name AS creator_name,
    u.role AS creator_role,
    u.department AS creator_department,
    a.name AS approver_name,
    (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id) AS registered
  FROM events e
  LEFT JOIN users u ON u.id = e.created_by
  LEFT JOIN users a ON a.id = e.approved_by`;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const newTicketId = () => 'HU-' + crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
const qrFor = (ticketId, eventId) => QRCode.toDataURL(`HYPEUP|${ticketId}|${eventId}`, { margin: 1, width: 240 });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

const UPLOADS_DIR = IS_VERCEL ? '/tmp/uploads' : path.join(__dirname, 'public', 'uploads');
function saveEventImage(imageData, fallbackUrl = '') {
  if (typeof imageData === 'string' && imageData.startsWith('data:image/')) {
    const m = imageData.match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i);
    if (!m) return { error: 'Invalid image format. Use PNG, JPG, or WEBP.' };
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 3 * 1024 * 1024) return { error: 'Image must be under 3 MB.' };
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const file = `ev-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, file), buf);
    return { url: `uploads/${file}` };
  }
  const cleanUrl = clean(fallbackUrl, 300);
  if (cleanUrl && !/^(\/?images\/|\/?uploads\/|https?:\/\/)/i.test(cleanUrl)) {
    return { error: 'Image URL must be a valid http(s) or local path.' };
  }
  return { url: cleanUrl };
}

function parseEvent(b) {
  const img = saveEventImage(b.image_data, b.image_url);
  if (img.error) return { error: img.error };
  const e = {
    title: clean(b.title, 80),
    category: clean(b.category, 30),
    event_date: clean(b.event_date, 10),
    event_time: clean(b.event_time || '10:00 AM', 20),
    venue: clean(b.venue, 80),
    description: clean(b.description, 400),
    capacity: parseInt(b.capacity, 10),
    image_url: img.url
  };
  if (!e.title || !e.venue) return { error: 'Title and venue are required.' };
  if (!CATEGORIES.includes(e.category)) return { error: 'Choose a valid category.' };
  if (!DATE_RE.test(e.event_date) || isNaN(Date.parse(e.event_date))) return { error: 'Enter a valid date (YYYY-MM-DD).' };
  if (!Number.isInteger(e.capacity) || e.capacity < 1 || e.capacity > 100000) return { error: 'Capacity must be a positive number.' };
  return { e };
}

function formatUser(u) {
  return { id: u.id, name: u.name, email: u.email, usn: u.usn, department: u.department, role: u.role, created_at: u.created_at };
}

/* ---------- Role-Based Stateless HMAC Sessions (8 hours, serverless-safe) ---------- */
const TOKEN_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update(DB_PATH + '|hypeup-2026').digest('hex');

function issueToken(user) {
  const payload = Buffer.from(JSON.stringify({
    id: user.id,
    email: user.email,
    role: user.role,
    exp: Date.now() + 8 * 3600 * 1000
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function getSessionUser(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!data || !data.id || !data.exp || data.exp < Date.now()) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(data.id);
  if (!user) return null;
  return { user, token };
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const sess = getSessionUser(req);
    if (!sess) return res.status(401).json({ error: 'Please log in to continue.' });
    if (!allowedRoles.includes(sess.user.role)) {
      return res.status(403).json({ error: `Access denied. Required role: ${allowedRoles.join(' or ')}.` });
    }
    req.user = sess.user;
    req.token = sess.token;
    next();
  };
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

/* ---------- Auth APIs (Student, Faculty, Admin) ---------- */
app.post('/api/auth/register', (req, res) => {
  const name = clean(req.body.name, 60);
  const email = clean(req.body.email, 120).toLowerCase();
  const usn = clean(req.body.usn, 30).toUpperCase();
  const department = clean(req.body.department || 'CSE', 40);
  const password = String(req.body.password ?? '');

  if (!name) return res.status(400).json({ error: 'Enter your full name.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!usn) return res.status(400).json({ error: 'Enter your USN / Student ID.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }

  const userId = createUser({ name, email, usn, department, role: 'student', password });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const token = issueToken(user);

  logAction(user, 'STUDENT_SIGNUP', `${name} (${usn})`, `Registered new student account in ${department}`);
  res.status(201).json({ token, user: formatUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const identifier = clean(req.body.email || req.body.username, 120).toLowerCase();
  const password = String(req.body.password ?? '');
  const requestedRole = clean(req.body.role, 20);

  if (!identifier || !password) return res.status(400).json({ error: 'Enter your email and password.' });

  // Support legacy 'admin' username shortcut
  const lookupEmail = identifier === 'admin' ? (process.env.ADMIN_EMAIL || 'ksshowrya33@gmail.com') : identifier;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(lookupEmail);
  const given = user ? Buffer.from(hashPw(password, user.salt), 'hex') : null;

  if (!user || !crypto.timingSafeEqual(given, Buffer.from(user.password_hash, 'hex'))) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  if (requestedRole && ROLES.includes(requestedRole) && user.role !== requestedRole) {
    return res.status(403).json({ error: `This account is registered as "${user.role}", not "${requestedRole}". Please switch to the ${user.role} login tab.` });
  }

  const token = issueToken(user);
  res.json({ token, user: formatUser(user) });
});

app.get('/api/auth/me', (req, res) => {
  const sess = getSessionUser(req);
  if (!sess) return res.status(401).json({ error: 'Not logged in.' });
  res.json({ user: formatUser(sess.user) });
});

app.post('/api/auth/logout', (req, res) => {
  res.json({ ok: true });
});

/* ---------- Public & Student APIs ---------- */
app.get('/api/events', (req, res) => {
  const category = clean(req.query.category, 30);
  const q = clean(req.query.q, 80).toLowerCase();
  let sql = EVENTS_SQL + " WHERE e.status = 'approved'";
  const params = [];
  if (category && category !== 'All') {
    sql += ' AND e.category = ?';
    params.push(category);
  }
  if (q) {
    sql += ' AND (LOWER(e.title) LIKE ? OR LOWER(e.description) LIKE ? OR LOWER(e.venue) LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY e.event_date';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(r => ({ ...r, seats_left: Math.max(r.capacity - r.registered, 0) })));
});

app.get('/api/announcements', (req, res) => {
  res.json(db.prepare('SELECT * FROM announcements ORDER BY id DESC LIMIT 5').all());
});

const registerTx = db.transaction((eventId, userId, name, email, usn, department) => {
  const ev = db.prepare(EVENTS_SQL + " WHERE e.id = ? AND e.status = 'approved'").get(eventId);
  if (!ev) return { code: 404, error: 'Event not found or not yet approved.' };
  if (db.prepare('SELECT 1 FROM registrations WHERE event_id = ? AND email = ?').get(eventId, email)) {
    return { code: 409, error: 'This email is already registered for this event.' };
  }
  if (ev.registered >= ev.capacity) return { code: 409, error: 'Sorry, this event is full.' };
  const ticketId = newTicketId();
  db.prepare(
    'INSERT INTO registrations (ticket_id, event_id, user_id, name, email, usn, department) VALUES (?,?,?,?,?,?,?)'
  ).run(ticketId, eventId, userId || null, name, email, usn, department);
  return { ticketId, ev };
});

app.post('/api/register', wrap(async (req, res) => {
  const sess = getSessionUser(req);
  const eventId = parseInt(req.body.event_id, 10);
  const name = sess ? sess.user.name : clean(req.body.name, 60);
  const email = sess ? sess.user.email : clean(req.body.email, 120).toLowerCase();
  const usn = sess ? sess.user.usn : clean(req.body.usn || '', 30).toUpperCase();
  const department = sess ? sess.user.department : clean(req.body.department || 'CSE', 40);

  if (!eventId) return res.status(400).json({ error: 'Choose an event.' });
  if (!name) return res.status(400).json({ error: 'Enter your name.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });

  const r = registerTx(eventId, sess?.user?.id, name, email, usn, department);
  if (r.error) return res.status(r.code).json({ error: r.error });

  logAction(
    sess?.user || { name, role: 'student' },
    'REGISTER',
    r.ev.title,
    `Ticket ${r.ticketId} issued to ${name} (${email})`
  );

  res.status(201).json({
    ticket_id: r.ticketId,
    name,
    email,
    usn,
    department,
    title: r.ev.title,
    event_date: r.ev.event_date,
    event_time: r.ev.event_time,
    venue: r.ev.venue,
    checked_in: 0,
    qr: await qrFor(r.ticketId, r.ev.id)
  });
}));

app.get('/api/tickets', wrap(async (req, res) => {
  const sess = getSessionUser(req);
  const email = sess ? sess.user.email : clean(req.query.email, 120).toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address or log in.' });

  const rows = db.prepare(`
    SELECT r.ticket_id, r.name, r.email, r.usn, r.department, r.checked_in, r.checked_in_at, r.event_id,
           e.title, e.category, e.event_date, e.event_time, e.venue
    FROM registrations r
    JOIN events e ON e.id = r.event_id
    WHERE r.email = ?
    ORDER BY r.id DESC
  `).all(email);

  res.json(await Promise.all(rows.map(async r => ({ ...r, qr: await qrFor(r.ticket_id, r.event_id) }))));
}));

app.delete('/api/tickets/:ticketId', requireRole('student', 'faculty', 'admin'), (req, res) => {
  const tid = clean(req.params.ticketId, 20).toUpperCase();
  const reg = db.prepare(`
    SELECT r.*, e.title FROM registrations r JOIN events e ON e.id = r.event_id WHERE r.ticket_id = ?
  `).get(tid);
  if (!reg) return res.status(404).json({ error: 'Ticket not found.' });
  if (req.user.role === 'student' && reg.email !== req.user.email) {
    return res.status(403).json({ error: 'You can only cancel your own registration.' });
  }
  if (reg.checked_in) {
    return res.status(409).json({ error: 'Cannot cancel a ticket that has already been checked in.' });
  }
  db.prepare('DELETE FROM registrations WHERE id = ?').run(reg.id);
  logAction(req.user, 'CANCEL_REGISTRATION', reg.title, `Cancelled ticket ${tid} for ${reg.email}`);
  res.json({ ok: true });
});

/* ---------- Faculty APIs ---------- */
app.get('/api/faculty/stats', requireRole('faculty', 'admin'), (req, res) => {
  const s = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM events WHERE created_by = ?) AS my_events,
      (SELECT COUNT(*) FROM events WHERE created_by = ? AND status = 'approved') AS approved_events,
      (SELECT COUNT(*) FROM events WHERE created_by = ? AND status = 'pending') AS pending_events,
      (SELECT COUNT(*) FROM registrations r JOIN events e ON e.id = r.event_id WHERE e.created_by = ?) AS my_registrations,
      (SELECT COUNT(*) FROM registrations r JOIN events e ON e.id = r.event_id WHERE e.created_by = ? AND r.checked_in = 1) AS my_checked_in
  `).get(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id);
  res.json(s);
});

app.get('/api/faculty/events', requireRole('faculty', 'admin'), (req, res) => {
  const rows = db.prepare(EVENTS_SQL + ' WHERE e.created_by = ? ORDER BY e.event_date').all(req.user.id);
  res.json(rows.map(r => ({ ...r, seats_left: Math.max(r.capacity - r.registered, 0) })));
});

app.post('/api/faculty/events', requireRole('faculty', 'admin'), (req, res) => {
  const { e, error } = parseEvent(req.body);
  if (error) return res.status(400).json({ error });
  const status = req.user.role === 'admin' ? 'approved' : 'pending';
  const approvedBy = req.user.role === 'admin' ? req.user.id : null;

  const info = db.prepare(
    'INSERT INTO events (title, category, event_date, event_time, venue, description, capacity, image_url, status, created_by, approved_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(e.title, e.category, e.event_date, e.event_time, e.venue, e.description, e.capacity, e.image_url, status, req.user.id, approvedBy);

  logAction(req.user, 'CREATE_EVENT', e.title, `Created with status "${status}" on ${e.event_date} at ${e.venue}`);
  res.status(201).json({ id: info.lastInsertRowid, status });
});

app.put('/api/faculty/events/:id', requireRole('faculty', 'admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Event not found.' });
  if (req.user.role !== 'admin' && existing.created_by !== req.user.id) {
    return res.status(403).json({ error: 'You can only edit events you created.' });
  }
  const { e, error } = parseEvent(req.body);
  if (error) return res.status(400).json({ error });

  db.prepare(
    "UPDATE events SET title=?, category=?, event_date=?, event_time=?, venue=?, description=?, capacity=?, image_url=CASE WHEN ? <> '' THEN ? ELSE image_url END, updated_at=datetime('now') WHERE id=?"
  ).run(e.title, e.category, e.event_date, e.event_time, e.venue, e.description, e.capacity, e.image_url, e.image_url, req.params.id);

  logAction(req.user, 'UPDATE_EVENT', e.title, `Updated details for event #${req.params.id}`);
  res.json({ ok: true });
});

app.delete('/api/faculty/events/:id', requireRole('faculty', 'admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Event not found.' });
  if (req.user.role !== 'admin' && existing.created_by !== req.user.id) {
    return res.status(403).json({ error: 'You can only delete events you created.' });
  }
  db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  logAction(req.user, 'DELETE_EVENT', existing.title, `Deleted event #${req.params.id}`);
  res.json({ ok: true });
});

/* ---------- Shared Faculty + Admin Event Operations ---------- */
app.get('/api/events/:id/registrations', requireRole('faculty', 'admin'), (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  if (req.user.role !== 'admin' && ev.created_by !== req.user.id) {
    return res.status(403).json({ error: 'You can only view registrations for your own events.' });
  }
  const rows = db.prepare(
    'SELECT ticket_id, name, email, usn, department, checked_in, checked_in_at, created_at FROM registrations WHERE event_id = ? ORDER BY id'
  ).all(req.params.id);
  res.json(rows);
});

app.get('/api/events/:id/export', requireRole('faculty', 'admin'), (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  if (req.user.role !== 'admin' && ev.created_by !== req.user.id) {
    return res.status(403).json({ error: 'You can only export registrations for your own events.' });
  }
  const rows = db.prepare(
    'SELECT ticket_id, name, email, usn, department, checked_in, created_at FROM registrations WHERE event_id = ? ORDER BY id'
  ).all(req.params.id);
  const cell = v => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const csv = ['Ticket ID,Name,USN,Department,Email,Checked in,Registered at']
    .concat(rows.map(r => [r.ticket_id, r.name, r.usn, r.department, r.email, r.checked_in ? 'Yes' : 'No', r.created_at].map(cell).join(','))).join('\n');
  res.type('text/csv').send(csv);
});

app.post('/api/checkin', requireRole('faculty', 'admin'), (req, res) => {
  const raw = clean(req.body.ticket_id, 60);
  const id = (raw.startsWith('HYPEUP|') ? raw.split('|')[1] : raw).trim().toUpperCase();
  const r = db.prepare('SELECT r.*, e.title FROM registrations r JOIN events e ON e.id = r.event_id WHERE r.ticket_id = ?').get(id);
  if (!r) return res.status(404).json({ error: 'No ticket found with that ID.' });
  if (r.checked_in) return res.status(409).json({ error: `${r.name} was already checked in for ${r.title}.` });

  db.prepare("UPDATE registrations SET checked_in = 1, checked_in_at = datetime('now') WHERE id = ?").run(r.id);
  logAction(req.user, 'CHECKIN', r.title, `Checked in ${r.name} (${r.ticket_id})`);
  res.json({ ok: true, name: r.name, title: r.title, ticket_id: r.ticket_id });
});

app.post('/api/announcements', requireRole('faculty', 'admin'), (req, res) => {
  const title = clean(req.body.title, 80);
  const message = clean(req.body.message, 280);
  if (!title || !message) return res.status(400).json({ error: 'Title and message are required.' });
  const info = db.prepare(
    'INSERT INTO announcements (title, message, created_by_name, created_by_role) VALUES (?,?,?,?)'
  ).run(title, message, req.user.name, req.user.role);
  logAction(req.user, 'POST_ANNOUNCEMENT', title, message);
  res.status(201).json({ id: info.lastInsertRowid });
});

app.delete('/api/announcements/:id', requireRole('admin'), (req, res) => {
  const info = db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Announcement not found.' });
  res.json({ ok: true });
});

/* ---------- Admin APIs ---------- */
app.get('/api/admin/stats', requireRole('admin'), (req, res) => {
  const s = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM events) AS events,
      (SELECT COUNT(*) FROM events WHERE status = 'pending') AS pending_events,
      (SELECT COUNT(*) FROM registrations) AS registrations,
      (SELECT COUNT(*) FROM registrations WHERE checked_in = 1) AS checked_in,
      (SELECT COUNT(*) FROM users WHERE role = 'student') AS students,
      (SELECT COUNT(*) FROM users WHERE role = 'faculty') AS faculty
  `).get();
  res.json(s);
});

app.get('/api/admin/events', requireRole('admin'), (req, res) => {
  const rows = db.prepare(EVENTS_SQL + " ORDER BY CASE e.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, e.event_date").all();
  res.json(rows.map(r => ({ ...r, seats_left: Math.max(r.capacity - r.registered, 0) })));
});

app.post('/api/admin/events', requireRole('admin'), (req, res) => {
  const { e, error } = parseEvent(req.body);
  if (error) return res.status(400).json({ error });
  const info = db.prepare(
    'INSERT INTO events (title, category, event_date, event_time, venue, description, capacity, image_url, status, created_by, approved_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(e.title, e.category, e.event_date, e.event_time, e.venue, e.description, e.capacity, e.image_url, 'approved', req.user.id, req.user.id);
  logAction(req.user, 'CREATE_EVENT', e.title, `Admin created & approved event on ${e.event_date}`);
  res.status(201).json({ id: info.lastInsertRowid });
});

app.put('/api/admin/events/:id', requireRole('admin'), (req, res) => {
  const { e, error } = parseEvent(req.body);
  if (error) return res.status(400).json({ error });
  const info = db.prepare(
    "UPDATE events SET title=?, category=?, event_date=?, event_time=?, venue=?, description=?, capacity=?, image_url=CASE WHEN ? <> '' THEN ? ELSE image_url END, updated_at=datetime('now') WHERE id=?"
  ).run(e.title, e.category, e.event_date, e.event_time, e.venue, e.description, e.capacity, e.image_url, e.image_url, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Event not found.' });
  logAction(req.user, 'UPDATE_EVENT', e.title, `Admin updated event #${req.params.id}`);
  res.json({ ok: true });
});

app.patch('/api/admin/events/:id/status', requireRole('admin'), (req, res) => {
  const status = clean(req.body.status, 20);
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  db.prepare("UPDATE events SET status = ?, approved_by = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, status === 'approved' ? req.user.id : null, req.params.id);
  logAction(req.user, status === 'approved' ? 'APPROVE_EVENT' : 'REJECT_EVENT', ev.title, `Status set to ${status}`);
  res.json({ ok: true });
});

app.delete('/api/admin/events/:id', requireRole('admin'), (req, res) => {
  const ev = db.prepare('SELECT title FROM events WHERE id = ?').get(req.params.id);
  const info = db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Event not found.' });
  logAction(req.user, 'DELETE_EVENT', ev?.title || `Event #${req.params.id}`, 'Deleted by Admin');
  res.json({ ok: true });
});

app.get('/api/admin/users', requireRole('admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.name, u.email, u.usn, u.department, u.role, u.created_at,
           (SELECT COUNT(*) FROM registrations r WHERE r.email = u.email) AS registrations_count
    FROM users u ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'faculty' THEN 1 ELSE 2 END, u.id DESC
  `).all();
  res.json(rows);
});

app.post('/api/admin/users', requireRole('admin'), (req, res) => {
  const name = clean(req.body.name, 60);
  const email = clean(req.body.email, 120).toLowerCase();
  const usn = clean(req.body.usn, 30).toUpperCase();
  const department = clean(req.body.department || 'CSE', 40);
  const role = clean(req.body.role, 20);
  const password = String(req.body.password ?? '');

  if (!name || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Valid name and email are required.' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'Email already exists.' });
  }

  const id = createUser({ name, email, usn, department, role, password });
  logAction(req.user, 'CREATE_USER', `${name} (${role})`, `Created ${role} account for ${email}`);
  res.status(201).json({ id });
});

app.get('/api/admin/audit', requireRole('admin'), (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 40').all());
});

app.get('/api/admin/storage', requireRole('admin'), (req, res) => {
  const stats = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH) : { size: 0 };
  const tables = ['users', 'events', 'registrations', 'announcements', 'audit_logs'].map(t => ({
    table: t,
    rows: db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
  }));
  res.json({
    engine: 'SQLite 3 (better-sqlite3, WAL mode, Foreign Keys ON)',
    file_path: DB_PATH,
    size_kb: Math.round((stats.size / 1024) * 10) / 10,
    tables
  });
});

/* ---------- Errors ---------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error. Please try again.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`HypeUp running at http://localhost:${PORT}`);
  });
}

module.exports = app;
