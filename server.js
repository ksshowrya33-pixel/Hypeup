// HypeUp – Smart Campus Event & Role-Based Engagement Platform (Express + Supabase PostgreSQL / SQLite)
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const db = require('./db');

const PORT = process.env.PORT || 3002;
const CATEGORIES = ['Technology', 'Cultural', 'Sports', 'Entertainment', 'Workshop'];
const ROLES = ['student', 'faculty', 'admin'];
const IS_VERCEL = !!process.env.VERCEL;

const createUser = async ({ name, email, usn, department, role, password }) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return db.insert(
    'INSERT INTO users (name, email, usn, department, role, password_hash, salt) VALUES (?,?,?,?,?,?,?)',
    [name, email.toLowerCase(), usn, department, role, db.hashPw(password, salt), salt]
  );
};

const logAction = (actor, action, target, details = '') =>
  db.execute(
    'INSERT INTO audit_logs (actor_id, actor_name, actor_role, action, target, details) VALUES (?,?,?,?,?,?)',
    [actor?.id || null, actor?.name || 'System', actor?.role || 'system', action, target, details]
  );

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
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const UPLOADS_DIR = IS_VERCEL ? '/tmp/uploads' : path.join(__dirname, 'public', 'uploads');
function saveEventImage(imageData, fallbackUrl = '') {
  if (typeof imageData === 'string' && imageData.startsWith('data:image/')) {
    const m = imageData.match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i);
    if (!m) return { error: 'Invalid image format. Use PNG, JPG, or WEBP.' };
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 3 * 1024 * 1024) return { error: 'Image must be under 3 MB.' };
    if (IS_VERCEL) {
      // On serverless, store small data URLs directly or write to /tmp/uploads
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    } else {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
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

const formatUser = (u) => ({
  id: u.id, name: u.name, email: u.email, usn: u.usn, department: u.department, role: u.role, created_at: u.created_at
});

/* ---------- Role-Based Stateless HMAC Sessions (8 hours, serverless-safe) ---------- */
const TOKEN_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update((process.env.DATABASE_URL || db.DB_PATH) + '|hypeup-2026').digest('hex');

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

async function getSessionUser(req) {
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
  const user = await db.queryGet('SELECT * FROM users WHERE id = ?', [data.id]);
  if (!user) return null;
  return { user, token };
}

function requireRole(...allowedRoles) {
  return wrap(async (req, res, next) => {
    const sess = await getSessionUser(req);
    if (!sess) return res.status(401).json({ error: 'Please log in to continue.' });
    if (!allowedRoles.includes(sess.user.role)) {
      return res.status(403).json({ error: `Access denied. Required role: ${allowedRoles.join(' or ')}.` });
    }
    req.user = sess.user;
    req.token = sess.token;
    next();
  });
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Health check (reports DB engine & connection status without exposing secrets)
app.get('/api/health', async (req, res) => {
  try {
    await db.ensureReady();
    res.json({ ok: true, engine: db.IS_PG ? 'postgres' : 'sqlite' });
  } catch (err) {
    res.status(500).json({ ok: false, engine: db.IS_PG ? 'postgres' : 'sqlite', code: err.code, message: err.message });
  }
});

// Ensure DB schema + seed data are ready before handling any /api request
app.use('/api', wrap(async (req, res, next) => {
  await db.ensureReady();
  next();
}));

/* ---------- Auth APIs (Student, Faculty, Admin) ---------- */
app.post('/api/auth/register', wrap(async (req, res) => {
  const name = clean(req.body.name, 60);
  const email = clean(req.body.email, 120).toLowerCase();
  const usn = clean(req.body.usn, 30).toUpperCase();
  const department = clean(req.body.department || 'CSE', 40);
  const password = String(req.body.password ?? '');

  if (!name) return res.status(400).json({ error: 'Enter your full name.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!usn) return res.status(400).json({ error: 'Enter your USN / Student ID.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (await db.queryGet('SELECT 1 AS ok FROM users WHERE email = ?', [email])) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }

  const userId = await createUser({ name, email, usn, department, role: 'student', password });
  const user = await db.queryGet('SELECT * FROM users WHERE id = ?', [userId]);
  const token = issueToken(user);

  await logAction(user, 'STUDENT_SIGNUP', `${name} (${usn})`, `Registered new student account in ${department}`);
  res.status(201).json({ token, user: formatUser(user) });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const identifier = clean(req.body.email || req.body.username, 120).toLowerCase();
  const password = String(req.body.password ?? '');
  const requestedRole = clean(req.body.role, 20);

  if (!identifier || !password) return res.status(400).json({ error: 'Enter your email and password.' });

  const lookupEmail = identifier === 'admin' ? (process.env.ADMIN_EMAIL || 'ksshowrya33@gmail.com') : identifier;
  const user = await db.queryGet('SELECT * FROM users WHERE email = ?', [lookupEmail]);
  const given = user ? Buffer.from(db.hashPw(password, user.salt), 'hex') : null;

  if (!user || !crypto.timingSafeEqual(given, Buffer.from(user.password_hash, 'hex'))) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  if (requestedRole && ROLES.includes(requestedRole) && user.role !== requestedRole) {
    return res.status(403).json({ error: `This account is registered as "${user.role}", not "${requestedRole}". Please switch to the ${user.role} login tab.` });
  }

  const token = issueToken(user);
  res.json({ token, user: formatUser(user) });
}));

app.get('/api/auth/me', wrap(async (req, res) => {
  const sess = await getSessionUser(req);
  if (!sess) return res.status(401).json({ error: 'Not logged in.' });
  res.json({ user: formatUser(sess.user) });
}));

app.post('/api/auth/logout', (req, res) => res.json({ ok: true }));

/* ---------- Public & Student APIs ---------- */
app.get('/api/events', wrap(async (req, res) => {
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
  const rows = await db.queryAll(sql, params);
  res.json(rows.map(r => {
    const reg = Number(r.registered || 0);
    return { ...r, registered: reg, seats_left: Math.max(r.capacity - reg, 0) };
  }));
}));

app.get('/api/announcements', wrap(async (req, res) => {
  res.json(await db.queryAll('SELECT * FROM announcements ORDER BY id DESC LIMIT 5'));
}));

app.post('/api/register', wrap(async (req, res) => {
  const sess = await getSessionUser(req);
  const eventId = parseInt(req.body.event_id, 10);
  const name = sess ? sess.user.name : clean(req.body.name, 60);
  const email = sess ? sess.user.email : clean(req.body.email, 120).toLowerCase();
  const usn = sess ? sess.user.usn : clean(req.body.usn || '', 30).toUpperCase();
  const department = sess ? sess.user.department : clean(req.body.department || 'CSE', 40);

  if (!eventId) return res.status(400).json({ error: 'Choose an event.' });
  if (!name) return res.status(400).json({ error: 'Enter your name.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });

  const ev = await db.queryGet(EVENTS_SQL + " WHERE e.id = ? AND e.status = 'approved'", [eventId]);
  if (!ev) return res.status(404).json({ error: 'Event not found or not yet approved.' });
  if (await db.queryGet('SELECT 1 AS ok FROM registrations WHERE event_id = ? AND email = ?', [eventId, email])) {
    return res.status(409).json({ error: 'This email is already registered for this event.' });
  }
  if (Number(ev.registered || 0) >= ev.capacity) {
    return res.status(409).json({ error: 'Sorry, this event is full.' });
  }

  const ticketId = newTicketId();
  await db.execute(
    'INSERT INTO registrations (ticket_id, event_id, user_id, name, email, usn, department) VALUES (?,?,?,?,?,?,?)',
    [ticketId, eventId, sess?.user?.id || null, name, email, usn, department]
  );

  await logAction(
    sess?.user || { name, role: 'student' },
    'REGISTER',
    ev.title,
    `Ticket ${ticketId} issued to ${name} (${email})`
  );

  res.status(201).json({
    ticket_id: ticketId,
    name,
    email,
    usn,
    department,
    title: ev.title,
    event_date: ev.event_date,
    event_time: ev.event_time,
    venue: ev.venue,
    checked_in: 0,
    qr: await qrFor(ticketId, ev.id)
  });
}));

app.get('/api/tickets', wrap(async (req, res) => {
  const sess = await getSessionUser(req);
  const email = sess ? sess.user.email : clean(req.query.email, 120).toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address or log in.' });

  const rows = await db.queryAll(`
    SELECT r.ticket_id, r.name, r.email, r.usn, r.department, r.checked_in, r.checked_in_at, r.event_id,
           e.title, e.category, e.event_date, e.event_time, e.venue
    FROM registrations r
    JOIN events e ON e.id = r.event_id
    WHERE r.email = ?
    ORDER BY r.id DESC
  `, [email]);

  res.json(await Promise.all(rows.map(async r => ({ ...r, qr: await qrFor(r.ticket_id, r.event_id) }))));
}));

app.delete('/api/tickets/:ticketId', requireRole('student', 'faculty', 'admin'), wrap(async (req, res) => {
  const tid = clean(req.params.ticketId, 20).toUpperCase();
  const reg = await db.queryGet(
    'SELECT r.*, e.title FROM registrations r JOIN events e ON e.id = r.event_id WHERE r.ticket_id = ?',
    [tid]
  );
  if (!reg) return res.status(404).json({ error: 'Ticket not found.' });
  if (req.user.role === 'student' && reg.email !== req.user.email) {
    return res.status(403).json({ error: 'You can only cancel your own registration.' });
  }
  if (reg.checked_in) {
    return res.status(409).json({ error: 'Cannot cancel a ticket that has already been checked in.' });
  }
  await db.execute('DELETE FROM registrations WHERE id = ?', [reg.id]);
  await logAction(req.user, 'CANCEL_REGISTRATION', reg.title, `Cancelled ticket ${tid} for ${reg.email}`);
  res.json({ ok: true });
}));

/* ---------- Faculty APIs ---------- */
app.get('/api/faculty/stats', requireRole('faculty', 'admin'), wrap(async (req, res) => {
  const s = await db.queryGet(`
    SELECT
      (SELECT COUNT(*) FROM events WHERE created_by = ?) AS my_events,
      (SELECT COUNT(*) FROM events WHERE created_by = ? AND status = 'approved') AS approved_events,
      (SELECT COUNT(*) FROM events WHERE created_by = ? AND status = 'pending') AS pending_events,
      (SELECT COUNT(*) FROM registrations r JOIN events e ON e.id = r.event_id WHERE e.created_by = ?) AS my_registrations,
      (SELECT COUNT(*) FROM registrations r JOIN events e ON e.id = r.event_id WHERE e.created_by = ? AND r.checked_in = 1) AS my_checked_in
  `, [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id]);
  res.json(s);
}));

app.get('/api/faculty/events', requireRole('faculty', 'admin'), wrap(async (req, res) => {
  const rows = await db.queryAll(EVENTS_SQL + ' WHERE e.created_by = ? ORDER BY e.event_date', [req.user.id]);
  res.json(rows.map(r => {
    const reg = Number(r.registered || 0);
    return { ...r, registered: reg, seats_left: Math.max(r.capacity - reg, 0) };
  }));
}));

app.post('/api/faculty/events', requireRole('faculty', 'admin'), wrap(async (req, res) => {
  const { e, error } = parseEvent(req.body);
  if (error) return res.status(400).json({ error });
  const status = req.user.role === 'admin' ? 'approved' : 'pending';
  const approvedBy = req.user.role === 'admin' ? req.user.id : null;

  const id = await db.insert(
    'INSERT INTO events (title, category, event_date, event_time, venue, description, capacity, image_url, status, created_by, approved_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [e.title, e.category, e.event_date, e.event_time, e.venue, e.description, e.capacity, e.image_url, status, req.user.id, approvedBy]
  );

  await logAction(req.user, 'CREATE_EVENT', e.title, `Created with status "${status}" on ${e.event_date} at ${e.venue}`);
  res.status(201).json({ id, status });
}));

app.put('/api/faculty/events/:id', requireRole('faculty', 'admin'), wrap(async (req, res) => {
  const existing = await db.queryGet('SELECT * FROM events WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Event not found.' });
  if (req.user.role !== 'admin' && existing.created_by !== req.user.id) {
    return res.status(403).json({ error: 'You can only edit events you created.' });
  }
  const { e, error } = parseEvent(req.body);
  if (error) return res.status(400).json({ error });

  await db.execute(
    "UPDATE events SET title=?, category=?, event_date=?, event_time=?, venue=?, description=?, capacity=?, image_url=CASE WHEN ? <> '' THEN ? ELSE image_url END, updated_at=datetime('now') WHERE id=?",
    [e.title, e.category, e.event_date, e.event_time, e.venue, e.description, e.capacity, e.image_url, e.image_url, req.params.id]
  );

  await logAction(req.user, 'UPDATE_EVENT', e.title, `Updated details for event #${req.params.id}`);
  res.json({ ok: true });
}));

app.delete('/api/faculty/events/:id', requireRole('faculty', 'admin'), wrap(async (req, res) => {
  const existing = await db.queryGet('SELECT * FROM events WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Event not found.' });
  if (req.user.role !== 'admin' && existing.created_by !== req.user.id) {
    return res.status(403).json({ error: 'You can only delete events you created.' });
  }
  await db.execute('DELETE FROM events WHERE id = ?', [req.params.id]);
  await logAction(req.user, 'DELETE_EVENT', existing.title, `Deleted event #${req.params.id}`);
  res.json({ ok: true });
}));

/* ---------- Shared Faculty + Admin Event Operations ---------- */
app.get('/api/events/:id/registrations', requireRole('faculty', 'admin'), wrap(async (req, res) => {
  const ev = await db.queryGet('SELECT * FROM events WHERE id = ?', [req.params.id]);
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  if (req.user.role !== 'admin' && ev.created_by !== req.user.id) {
    return res.status(403).json({ error: 'You can only view registrations for your own events.' });
  }
  const rows = await db.queryAll(
    'SELECT ticket_id, name, email, usn, department, checked_in, checked_in_at, created_at FROM registrations WHERE event_id = ? ORDER BY id',
    [req.params.id]
  );
  res.json(rows);
}));

app.get('/api/events/:id/export', requireRole('faculty', 'admin'), wrap(async (req, res) => {
  const ev = await db.queryGet('SELECT * FROM events WHERE id = ?', [req.params.id]);
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  if (req.user.role !== 'admin' && ev.created_by !== req.user.id) {
    return res.status(403).json({ error: 'You can only export registrations for your own events.' });
  }
  const rows = await db.queryAll(
    'SELECT ticket_id, name, email, usn, department, checked_in, created_at FROM registrations WHERE event_id = ? ORDER BY id',
    [req.params.id]
  );
  const cell = v => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const csv = ['Ticket ID,Name,USN,Department,Email,Checked in,Registered at']
    .concat(rows.map(r => [r.ticket_id, r.name, r.usn, r.department, r.email, r.checked_in ? 'Yes' : 'No', r.created_at].map(cell).join(','))).join('\n');
  res.type('text/csv').send(csv);
}));

app.post('/api/checkin', requireRole('faculty', 'admin'), wrap(async (req, res) => {
  const raw = clean(req.body.ticket_id, 60);
  const id = (raw.startsWith('HYPEUP|') ? raw.split('|')[1] : raw).trim().toUpperCase();
  const r = await db.queryGet('SELECT r.*, e.title FROM registrations r JOIN events e ON e.id = r.event_id WHERE r.ticket_id = ?', [id]);
  if (!r) return res.status(404).json({ error: 'No ticket found with that ID.' });
  if (r.checked_in) return res.status(409).json({ error: `${r.name} was already checked in for ${r.title}.` });

  await db.execute("UPDATE registrations SET checked_in = 1, checked_in_at = datetime('now') WHERE id = ?", [r.id]);
  await logAction(req.user, 'CHECKIN', r.title, `Checked in ${r.name} (${r.ticket_id})`);
  res.json({ ok: true, name: r.name, title: r.title, ticket_id: r.ticket_id });
}));

app.post('/api/announcements', requireRole('faculty', 'admin'), wrap(async (req, res) => {
  const title = clean(req.body.title, 80);
  const message = clean(req.body.message, 280);
  if (!title || !message) return res.status(400).json({ error: 'Title and message are required.' });
  const id = await db.insert(
    'INSERT INTO announcements (title, message, created_by_name, created_by_role) VALUES (?,?,?,?)',
    [title, message, req.user.name, req.user.role]
  );
  await logAction(req.user, 'POST_ANNOUNCEMENT', title, message);
  res.status(201).json({ id });
}));

app.delete('/api/announcements/:id', requireRole('admin'), wrap(async (req, res) => {
  const info = await db.execute('DELETE FROM announcements WHERE id = ?', [req.params.id]);
  if (!info.changes) return res.status(404).json({ error: 'Announcement not found.' });
  res.json({ ok: true });
}));

/* ---------- Admin APIs ---------- */
app.get('/api/admin/stats', requireRole('admin'), wrap(async (req, res) => {
  const s = await db.queryGet(`
    SELECT
      (SELECT COUNT(*) FROM events) AS events,
      (SELECT COUNT(*) FROM events WHERE status = 'pending') AS pending_events,
      (SELECT COUNT(*) FROM registrations) AS registrations,
      (SELECT COUNT(*) FROM registrations WHERE checked_in = 1) AS checked_in,
      (SELECT COUNT(*) FROM users WHERE role = 'student') AS students,
      (SELECT COUNT(*) FROM users WHERE role = 'faculty') AS faculty
  `);
  res.json(s);
}));

app.get('/api/admin/events', requireRole('admin'), wrap(async (req, res) => {
  const rows = await db.queryAll(EVENTS_SQL + " ORDER BY CASE e.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, e.event_date");
  res.json(rows.map(r => {
    const reg = Number(r.registered || 0);
    return { ...r, registered: reg, seats_left: Math.max(r.capacity - reg, 0) };
  }));
}));

app.post('/api/admin/events', requireRole('admin'), wrap(async (req, res) => {
  const { e, error } = parseEvent(req.body);
  if (error) return res.status(400).json({ error });
  const id = await db.insert(
    'INSERT INTO events (title, category, event_date, event_time, venue, description, capacity, image_url, status, created_by, approved_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [e.title, e.category, e.event_date, e.event_time, e.venue, e.description, e.capacity, e.image_url, 'approved', req.user.id, req.user.id]
  );
  await logAction(req.user, 'CREATE_EVENT', e.title, `Admin created & approved event on ${e.event_date}`);
  res.status(201).json({ id });
}));

app.put('/api/admin/events/:id', requireRole('admin'), wrap(async (req, res) => {
  const { e, error } = parseEvent(req.body);
  if (error) return res.status(400).json({ error });
  const info = await db.execute(
    "UPDATE events SET title=?, category=?, event_date=?, event_time=?, venue=?, description=?, capacity=?, image_url=CASE WHEN ? <> '' THEN ? ELSE image_url END, updated_at=datetime('now') WHERE id=?",
    [e.title, e.category, e.event_date, e.event_time, e.venue, e.description, e.capacity, e.image_url, e.image_url, req.params.id]
  );
  if (!info.changes) return res.status(404).json({ error: 'Event not found.' });
  await logAction(req.user, 'UPDATE_EVENT', e.title, `Admin updated event #${req.params.id}`);
  res.json({ ok: true });
}));

app.patch('/api/admin/events/:id/status', requireRole('admin'), wrap(async (req, res) => {
  const status = clean(req.body.status, 20);
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  const ev = await db.queryGet('SELECT * FROM events WHERE id = ?', [req.params.id]);
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  await db.execute("UPDATE events SET status = ?, approved_by = ?, updated_at = datetime('now') WHERE id = ?", [
    status, status === 'approved' ? req.user.id : null, req.params.id
  ]);
  await logAction(req.user, status === 'approved' ? 'APPROVE_EVENT' : 'REJECT_EVENT', ev.title, `Status set to ${status}`);
  res.json({ ok: true });
}));

app.delete('/api/admin/events/:id', requireRole('admin'), wrap(async (req, res) => {
  const ev = await db.queryGet('SELECT title FROM events WHERE id = ?', [req.params.id]);
  const info = await db.execute('DELETE FROM events WHERE id = ?', [req.params.id]);
  if (!info.changes) return res.status(404).json({ error: 'Event not found.' });
  await logAction(req.user, 'DELETE_EVENT', ev?.title || `Event #${req.params.id}`, 'Deleted by Admin');
  res.json({ ok: true });
}));

app.get('/api/admin/users', requireRole('admin'), wrap(async (req, res) => {
  const rows = await db.queryAll(`
    SELECT u.id, u.name, u.email, u.usn, u.department, u.role, u.created_at,
           (SELECT COUNT(*) FROM registrations r WHERE r.email = u.email) AS registrations_count
    FROM users u ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'faculty' THEN 1 ELSE 2 END, u.id DESC
  `);
  res.json(rows);
}));

app.post('/api/admin/users', requireRole('admin'), wrap(async (req, res) => {
  const name = clean(req.body.name, 60);
  const email = clean(req.body.email, 120).toLowerCase();
  const usn = clean(req.body.usn, 30).toUpperCase();
  const department = clean(req.body.department || 'CSE', 40);
  const role = clean(req.body.role, 20);
  const password = String(req.body.password ?? '');

  if (!name || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Valid name and email are required.' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (await db.queryGet('SELECT 1 AS ok FROM users WHERE email = ?', [email])) {
    return res.status(409).json({ error: 'Email already exists.' });
  }

  const id = await createUser({ name, email, usn, department, role, password });
  await logAction(req.user, 'CREATE_USER', `${name} (${role})`, `Created ${role} account for ${email}`);
  res.status(201).json({ id });
}));

app.get('/api/admin/audit', requireRole('admin'), wrap(async (req, res) => {
  res.json(await db.queryAll('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 40'));
}));

app.get('/api/admin/storage', requireRole('admin'), wrap(async (req, res) => {
  res.json(await db.getStorageInfo());
}));

/* ---------- Errors ---------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error. Please try again.' });
});

if (require.main === module) {
  db.ensureReady().then(() => {
    app.listen(PORT, () => {
      console.log(`HypeUp running at http://localhost:${PORT} (${db.IS_PG ? 'PostgreSQL' : 'SQLite'})`);
    });
  }).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
}

module.exports = app;
