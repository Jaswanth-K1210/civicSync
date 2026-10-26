import express from 'express';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { CATEGORIES, OPEN, ACTIONS, CITIZEN_REPLY_HOURS, checkAction, distanceM, pickAuditSample, escalationLevel, findRepeats } from './rules.js';

const PORT = process.env.PORT || 5050;
const SECRET = process.env.SECRET || 'civicsync-dev-secret';
await mongoose.connect(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/civicsync');

// ---------- models ----------
const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, unique: true }, name: String, role: String, dept: String,
  phone: String, email: String, passHash: String,
}));
const Notification = mongoose.model('Notification', new mongoose.Schema({
  user: mongoose.Types.ObjectId, cid: String, text: String, at: { type: Date, default: Date.now },
}));
const Complaint = mongoose.model('Complaint', new mongoose.Schema({
  cid: { type: String, unique: true },
  citizen: mongoose.Types.ObjectId, citizenName: String, citizenPhone: String, citizenEmail: String,
  category: String, dept: String, description: String,
  location: { lat: Number, lng: Number, address: String },
  photo: String,                                  // ponytail: base64 in Mongo, move to object storage for real volume
  status: { type: String, default: 'REGISTERED' },
  assignedTo: mongoose.Types.ObjectId, assignedName: String,
  slaDueAt: Date, closedAt: Date,
  escalationLevel: { type: Number, default: 0 },
  reopenCount: { type: Number, default: 0 },
  isRepeat: Boolean, repeatOf: [String], recurredAfterClosure: Boolean,
  citizenSilent: Boolean,
  proof: [{ photo: String, lat: Number, lng: Number, source: String, distanceM: Number, note: String, by: String, at: Date }],
  feedback: [{ response: String, comment: String, at: Date }],
  audit: { sampled: Boolean, reasons: [String], result: String, note: String, by: String, at: Date },
  history: [{ status: String, action: String, by: String, role: String, note: String, at: { type: Date, default: Date.now } }],
}, { timestamps: true }));

// ---------- helpers ----------
const hash = (p) => crypto.scryptSync(p, 'civicsync', 32).toString('hex');
const sign = (o) => { const b = Buffer.from(JSON.stringify(o)).toString('base64url'); return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); };
const verifyToken = (t = '') => {
  const [b, s] = t.split('.');
  if (!b || !s) return null;
  const good = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  return JSON.parse(Buffer.from(b, 'base64url').toString());
};
const mask = (s = '') => (s.length > 4 ? s.slice(0, 2) + '*'.repeat(s.length - 4) + s.slice(-2) : '****');

const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null;

async function notify(userId, cid, text) {
  if (!userId) return;
  await Notification.create({ user: userId, cid, text });
  const u = await User.findById(userId);
  if (mailer && u?.email) mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: u.email, subject: `CivicSync ${cid}`, text }).catch((e) => console.error('mail', e.message));
  else console.log(`[notify ${u?.username}] ${cid}: ${text}`);
}
async function notifyRole(role, dept, cid, text) {
  for (const u of await User.find(dept ? { role, dept } : { role })) await notify(u._id, cid, text);
}

// Privacy: field staff and officers never see citizen contact details.
function view(c, user) {
  const o = c.toObject ? c.toObject() : c;
  if (['field', 'officer'].includes(user.role)) { o.citizenPhone = mask(o.citizenPhone); o.citizenEmail = mask(o.citizenEmail); }
  o.overdue = OPEN.includes(o.status) && new Date() > new Date(o.slaDueAt);
  return o;
}
function scope(user) {
  if (user.role === 'citizen') return { citizen: user.id };
  if (user.role === 'field') return { assignedTo: user.id };
  if (user.role === 'officer') return { dept: user.dept };
  return {};
}
const log = (c, action, user, note) => c.history.push({ status: c.status, action, by: user.name, role: user.role, note });

// Ageing sweep: escalate overdue complaints, send silent "awaiting citizen" to inspection.
async function sweep() {
  const sys = { name: 'System', role: 'system' };
  for (const c of await Complaint.find({ status: { $in: [...OPEN, 'AWAITING_CITIZEN'] } }).select('-photo -proof.photo')) {
    let changed = false;
    if (c.status === 'AWAITING_CITIZEN') {
      const since = c.history.findLast((h) => h.status === 'AWAITING_CITIZEN')?.at || c.updatedAt;
      if (Date.now() - since > CITIZEN_REPLY_HOURS * 36e5) {
        c.status = 'AWAITING_INSPECTION'; c.citizenSilent = true;
        log(c, 'noReply', sys, `No citizen reply in ${CITIZEN_REPLY_HOURS}h — field inspection required before closure`);
        await notifyRole('supervisor', null, c.cid, 'Citizen did not reply — please inspect before closing');
        changed = true;
      }
    } else {
      const lvl = escalationLevel(c);
      if (lvl > c.escalationLevel) {
        c.escalationLevel = lvl;
        log(c, 'escalate', sys, lvl === 1 ? 'SLA breached — escalated to department officer' : 'Over 2x SLA — escalated to supervisor');
        await (lvl === 1 ? notifyRole('officer', c.dept, c.cid, 'SLA breached') : notifyRole('supervisor', null, c.cid, 'Complaint over 2x SLA'));
        changed = true;
      }
    }
    if (changed) await c.save();
  }
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '5mb' }));
// CORS for the Vercel frontend. Bearer tokens, no cookies, so a plain origin allow-list is enough.
const ORIGINS = (process.env.CORS_ORIGIN || '*').split(',').map((o) => o.trim());
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (ORIGINS.includes('*') || ORIGINS.includes(o)) res.set('Access-Control-Allow-Origin', ORIGINS.includes('*') ? '*' : o);
  res.set('Access-Control-Allow-Headers', 'content-type, authorization');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  req.method === 'OPTIONS' ? res.sendStatus(204) : next();
});
app.get('/health', (req, res) => res.json({ ok: true }));
const api = express.Router();
app.use('/api', api);

api.post('/login', async (req, res) => {
  const u = await User.findOne({ username: req.body.username });
  if (!u || u.passHash !== hash(req.body.password || '')) return res.status(401).json({ error: 'Invalid username or password' });
  const user = { id: u._id, name: u.name, role: u.role, dept: u.dept, username: u.username };
  res.json({ token: sign(user), user });
});
api.post('/register', async (req, res) => {
  const { username, password, name, phone, email } = req.body;
  if (!username || !password || !name || !phone) return res.status(400).json({ error: 'Name, phone, username and password are required' });
  if (await User.exists({ username })) return res.status(400).json({ error: 'Username taken' });
  const u = await User.create({ username, name, phone, email, role: 'citizen', passHash: hash(password) });
  const user = { id: u._id, name: u.name, role: u.role, username };
  res.json({ token: sign(user), user });
});
api.get('/categories', (req, res) => res.json(CATEGORIES));

// Public tracking by complaint ID — no personal data.
api.get('/track/:cid', async (req, res) => {
  const c = await Complaint.findOne({ cid: req.params.cid.trim().toUpperCase() }).select('cid category status createdAt slaDueAt history.status history.action history.at history.note');
  if (!c) return res.status(404).json({ error: 'No complaint with that ID' });
  res.json(c);
});

api.use((req, res, next) => {
  req.user = verifyToken(req.headers.authorization?.replace('Bearer ', ''));
  if (!req.user) return res.status(401).json({ error: 'Please log in' });
  next();
});
const only = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not allowed for your role' });

api.get('/notifications', async (req, res) => res.json(await Notification.find({ user: req.user.id }).sort({ at: -1 }).limit(50)));
api.get('/staff', only('grievance', 'officer', 'supervisor'), async (req, res) =>
  res.json(await User.find({ role: 'field', ...(req.query.dept && { dept: req.query.dept }) }).select('name dept')));

api.post('/complaints', only('citizen'), async (req, res) => {
  const { category, description, lat, lng, address, photo } = req.body;
  if (!CATEGORIES[category]) return res.status(400).json({ error: 'Pick a valid category' });
  if (!description?.trim() || typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'Description and location are required' });
  const me = await User.findById(req.user.id);
  const n = await Complaint.countDocuments();
  const { dept, slaHours } = CATEGORIES[category];
  const c = new Complaint({
    cid: `GHMC-${new Date().getFullYear()}-${String(n + 1).padStart(5, '0')}`,
    citizen: me._id, citizenName: me.name, citizenPhone: me.phone, citizenEmail: me.email,
    category, dept, description: description.trim(), location: { lat, lng, address }, photo,
    slaDueAt: new Date(Date.now() + slaHours * 36e5),
  });
  log(c, 'register', req.user, `Routed to ${dept} department (SLA ${slaHours}h)`);
  // ponytail: in-JS radius scan over recent same-category complaints; use a 2dsphere index at city scale
  const recent = await Complaint.find({ category, createdAt: { $gte: new Date(Date.now() - 60 * 864e5) } }).select('-photo -proof.photo');
  const repeats = findRepeats(c, recent);
  if (repeats.length) {
    c.isRepeat = true; c.repeatOf = repeats.map((r) => r.cid);
    log(c, 'repeat', { name: 'System', role: 'system' }, `Repeat of ${c.repeatOf.join(', ')}`);
    for (const r of repeats.filter((r) => r.status === 'CLOSED')) {
      r.recurredAfterClosure = true;
      r.audit = { ...r.audit, sampled: true, reasons: [...(r.audit?.reasons || []), 'Issue recurred after closure'] };
      log(r, 'flagAudit', { name: 'System', role: 'system' }, `Same issue reported again as ${c.cid} — flagged for audit`);
      await r.save();
    }
    await notifyRole('supervisor', null, c.cid, `Repeat complaint (${c.repeatOf.join(', ')})`);
  }
  await c.save();
  await notify(me._id, c.cid, `Complaint registered. Track it with ID ${c.cid}.`);
  await notifyRole('grievance', null, c.cid, `New ${category} complaint — needs assignment`);
  res.json(view(c, req.user));
});

api.get('/complaints', async (req, res) => {
  const q = { ...scope(req.user) };
  if (req.query.status) q.status = req.query.status;
  res.json((await Complaint.find(q).select('-photo -proof.photo').sort({ updatedAt: -1 })).map((c) => view(c, req.user)));
});
api.get('/complaints/:id', async (req, res) => {
  const c = await Complaint.findOne({ _id: req.params.id, ...scope(req.user) });
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(view(c, req.user));
});

// Single endpoint for every workflow step — rules.js decides what is allowed.
api.post('/complaints/:id/:action', async (req, res) => {
  const { action } = req.params, { note = '', staffId, photo, lat, lng, source } = req.body;
  const c = await Complaint.findOne({ _id: req.params.id, ...scope(req.user) });
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (action === 'proof') {
    if (!photo || typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'Completion photo and location are required' });
    c.proof.push({ photo, lat, lng, source, note, by: req.user.name, at: new Date(), distanceM: distanceM(c.location, { lat, lng }) });
  }
  const err = checkAction(c, action, req.user.role);
  if (err) { if (action === 'proof') c.proof.pop(); return res.status(400).json({ error: err }); }
  if (['needsAction', 'dispute', 'auditFail'].includes(action) && !note.trim()) return res.status(400).json({ error: 'Please give a reason' });

  let to = ACTIONS[action].to;
  if (action === 'inspectPass' && c.citizenSilent) to = 'CLOSED'; // supervisor saw the fix on the ground
  if (action === 'assign') {
    const s = await User.findOne({ _id: staffId, role: 'field' });
    if (!s) return res.status(400).json({ error: 'Pick a field staff member' });
    c.assignedTo = s._id; c.assignedName = s.name;
  }
  if (['dispute', 'auditFail'].includes(action)) { c.reopenCount++; c.escalationLevel = Math.max(c.escalationLevel, 1); c.closedAt = undefined; }
  if (action === 'confirm' || action === 'dispute') c.feedback.push({ response: action === 'confirm' ? 'confirmed' : 'disputed', comment: note, at: new Date() });
  if (action.startsWith('audit')) c.audit = { ...c.audit, result: action === 'auditPass' ? 'pass' : 'fail', note, by: req.user.name, at: new Date() };
  c.status = to;
  if (to === 'CLOSED' && !c.closedAt) c.closedAt = new Date();
  log(c, action, req.user, action === 'assign' ? `Assigned to ${c.assignedName}. ${note}` :
    action === 'proof' ? `Proof uploaded ${c.proof.at(-1).distanceM} m from site (${source || 'gps'}). ${note}` : note);
  await c.save();

  // who hears about it
  const msg = { assign: 'Your complaint has been assigned to field staff.', verify: 'Work verified by officer. Please confirm if the issue is fixed, or dispute it.',
    inspectPass: c.status === 'CLOSED' ? 'Closed after field inspection confirmed the fix.' : 'Inspection confirmed the fix. Please confirm or dispute.',
    needsAction: 'Further work is needed on your complaint.', dispute: 'Your dispute was recorded — the complaint has gone back for more work.',
    auditFail: 'An audit found the issue unresolved. It has been reopened.', confirm: 'Thank you. Your complaint is closed.' }[action];
  if (msg) await notify(c.citizen, c.cid, msg);
  if (action === 'assign') await notify(c.assignedTo, c.cid, `New work assigned: ${c.category}`);
  if (['needsAction', 'dispute', 'auditFail'].includes(action)) await notify(c.assignedTo, c.cid, `Reopened: ${note}`);
  if (action === 'proof') await notifyRole('officer', c.dept, c.cid, 'Work done — please review the proof');
  if (action === 'inspect') await notifyRole('supervisor', null, c.cid, 'Inspection requested');
  if (action === 'dispute') { await notifyRole('grievance', null, c.cid, `Citizen disputed closure: ${note}`); if (c.reopenCount >= 2) await notifyRole('supervisor', null, c.cid, 'Disputed twice — needs supervisor attention'); }
  res.json(view(c, req.user));
});

// ---------- monitoring ----------
api.get('/stats', only('grievance', 'officer', 'supervisor'), async (req, res) => {
  const all = await Complaint.find(scope(req.user)).select('-photo -proof.photo');
  const count = (f) => all.filter(f).length;
  const by = (k) => all.reduce((m, c) => ((m[c[k]] = (m[c[k]] || 0) + 1), m), {});
  const actions = all.flatMap((c) => c.history.map((h) => h.action)).reduce((m, a) => ((m[a] = (m[a] || 0) + 1), m), {});
  const now = new Date();
  const ageDays = (c) => Math.floor((now - c.createdAt) / 864e5);
  const ageing = all.filter((c) => OPEN.includes(c.status)).map((c) => view(c, req.user)).filter((c) => c.overdue)
    .sort((a, b) => a.slaDueAt - b.slaDueAt).map((c) => ({ ...c, ageDays: ageDays(c) }));
  const buckets = { '0-1 days': 0, '2-7 days': 0, '8-30 days': 0, '30+ days': 0 };
  for (const c of all.filter((c) => OPEN.includes(c.status))) { const d = ageDays(c); buckets[d <= 1 ? '0-1 days' : d <= 7 ? '2-7 days' : d <= 30 ? '8-30 days' : '30+ days']++; }
  res.json({
    total: all.length, closed: count((c) => c.status === 'CLOSED'), open: count((c) => OPEN.includes(c.status) || c.status === 'AWAITING_CITIZEN'),
    overdue: ageing.length, repeats: count((c) => c.isRepeat), disputed: count((c) => c.feedback.some((f) => f.response === 'disputed')),
    confirmedByCitizen: count((c) => c.feedback.some((f) => f.response === 'confirmed')),
    byStatus: by('status'), byCategory: by('category'), buckets,
    verification: { Verified: actions.verify || 0, 'Needs further action': actions.needsAction || 0, 'Sent to inspection': actions.inspect || 0, 'Inspection passed': actions.inspectPass || 0, Disputed: actions.dispute || 0 },
    audit: { sampled: count((c) => c.audit?.sampled), pending: count((c) => c.audit?.sampled && !c.audit.result), pass: count((c) => c.audit?.result === 'pass'), fail: count((c) => c.audit?.result === 'fail') },
    ageing, repeatList: all.filter((c) => c.isRepeat).map((c) => view(c, req.user)),
    points: all.map((c) => ({ _id: c._id, cid: c.cid, category: c.category, status: c.status, ...c.location.toObject(), overdue: OPEN.includes(c.status) && now > c.slaDueAt })),
  });
});

api.post('/audit/sample', only('supervisor'), async (req, res) => {
  const closed = await Complaint.find({ status: 'CLOSED', 'audit.result': { $exists: false } }).select('-photo -proof.photo');
  const picked = pickAuditSample(closed);
  for (const { c, reasons } of picked) {
    c.audit = { ...c.audit, sampled: true, reasons: [...new Set([...(c.audit?.reasons || []), ...reasons])] };
    log(c, 'auditSampled', req.user, `Selected for audit: ${c.audit.reasons.join(', ')}`);
    await c.save();
  }
  res.json({ picked: picked.length });
});
api.get('/audit', only('supervisor', 'grievance'), async (req, res) =>
  res.json(await Complaint.find({ 'audit.sampled': true }).select('-photo -proof.photo').sort({ 'audit.at': -1, updatedAt: -1 })));

api.get('/audit-log', only('supervisor', 'grievance'), async (req, res) => {
  const all = await Complaint.find().select('cid history');
  res.json(all.flatMap((c) => c.history.map((h) => ({ cid: c.cid, ...h.toObject() }))).sort((a, b) => b.at - a.at).slice(0, 300));
});

// serve the built React app
const dist = fileURLToPath(new URL('../client/dist', import.meta.url));
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|health).*/, (req, res) => res.sendFile(dist + '/index.html'));
}

// ---------- seed demo data ----------
const DEMO_PHOTO = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="100%" height="100%" fill="#cfe8d5"/><text x="50%" y="50%" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#2d5a3a">Completion photo (demo)</text></svg>');
async function seed() {
  if (await User.exists({})) return;
  const P = hash('civic123');
  const mk = (username, name, role, dept, phone, email) => ({ username, name, role, dept, phone, email, passHash: P });
  const [ravi, lakshmi, , , , , fSan, fEng, fEle] = await User.insertMany([
    mk('ravi', 'Ravi Kumar', 'citizen', null, '9876543210', 'ravi@example.com'),
    mk('lakshmi', 'Lakshmi Devi', 'citizen', null, '9123456780', 'lakshmi@example.com'),
    mk('grievance', 'Anitha (Grievance Cell)', 'grievance'),
    mk('officer_san', 'S. Rao (AMOH Sanitation)', 'officer', 'Sanitation'),
    mk('officer_eng', 'K. Reddy (AE Engineering)', 'officer', 'Engineering'),
    mk('officer_ele', 'M. Khan (AE Electrical)', 'officer', 'Electrical'),
    mk('field_san', 'Venkat (Sanitation SFA)', 'field', 'Sanitation'),
    mk('field_eng', 'Suresh (Work Inspector)', 'field', 'Engineering'),
    mk('field_ele', 'Imran (Electrical Lineman)', 'field', 'Electrical'),
    mk('supervisor', 'Dr. Priya (Zonal Commissioner)', 'supervisor'),
  ]);
  const field = { Sanitation: fSan, Engineering: fEng, Electrical: fEle };
  const H = 36e5, now = Date.now();
  const rows = [
    // [citizen, category, description, lat, lng, address, ageHours, status, extras]
    [ravi, 'Garbage / Solid Waste', 'Garbage not collected for 4 days near bus stop', 17.4375, 78.4483, 'Ameerpet Metro, Hyderabad', 120, 'ASSIGNED'],
    [lakshmi, 'Streetlight Not Working', 'Three streetlights off on main road', 17.4239, 78.4738, 'Khairatabad Main Rd', 400, 'IN_PROGRESS'],
    [ravi, 'Pothole / Road Damage', 'Large pothole causing accidents', 17.4401, 78.3489, 'Gachibowli Flyover', 30, 'REGISTERED'],
    [lakshmi, 'Drainage / Sewer Overflow', 'Manhole overflowing on street', 17.3616, 78.4747, 'Charminar Rd', 50, 'WORK_DONE', { proofDist: 40 }],
    [ravi, 'Water Logging', 'Water logging after rain, road blocked', 17.4126, 78.4071, 'Banjara Hills Rd No. 12', 60, 'WORK_DONE', { proofDist: 850 }],
    [lakshmi, 'Garbage / Solid Waste', 'Dumping yard near school', 17.4948, 78.3996, 'Kukatpally Housing Board', 100, 'AWAITING_CITIZEN', { proofDist: 20 }],
    [ravi, 'Garbage / Solid Waste', 'Overflowing bin in colony', 17.4062, 78.5500, 'Uppal X Roads', 300, 'CLOSED', { proofDist: 25, closedAfter: 1 }],
    [lakshmi, 'Streetlight Not Working', 'Light pole flickering', 17.4504, 78.3810, 'Madhapur, Hitech City', 500, 'CLOSED', { proofDist: 30, closedAfter: 40, reopen: 1 }],
    [ravi, 'Pothole / Road Damage', 'Road dug up and not restored', 17.3850, 78.4867, 'Abids, Nampally', 900, 'REOPENED', { proofDist: 15, reopen: 1 }],
    [lakshmi, 'Drainage / Sewer Overflow', 'Open drain without cover', 17.4434, 78.4983, 'Secunderabad Station Rd', 200, 'CLOSED', { proofDist: 10, closedAfter: 30 }],
    [ravi, 'Water Logging', 'Underpass flooded', 17.4290, 78.4500, 'Panjagutta', 20, 'NEEDS_ACTION', { proofDist: 60 }],
    [lakshmi, 'Garbage / Solid Waste', 'Garbage near the same bus stop again', 17.4377, 78.4485, 'Ameerpet Metro, Hyderabad', 5, 'REGISTERED', { repeatOf: 0 }],
  ];
  const docs = [];
  for (const [i, [cit, category, description, lat, lng, address, age, status, x = {}]] of rows.entries()) {
    const { dept, slaHours } = CATEGORIES[category];
    const created = new Date(now - age * H), f = field[dept];
    const at = (h) => new Date(+created + h * H);
    const sys = (s, action, by, role, note, h) => ({ status: s, action, by, role, note, at: at(h) });
    const hist = [sys('REGISTERED', 'register', cit.name, 'citizen', `Routed to ${dept} department (SLA ${slaHours}h)`, 0)];
    if (status !== 'REGISTERED') hist.push(sys('ASSIGNED', 'assign', 'Anitha (Grievance Cell)', 'grievance', `Assigned to ${f.name}.`, 0.5));
    if (status !== 'REGISTERED' && status !== 'ASSIGNED') hist.push(sys('IN_PROGRESS', 'start', f.name, 'field', '', 1));
    const proof = x.proofDist != null ? [{ photo: DEMO_PHOTO, lat: lat + x.proofDist / 111000, lng, source: 'gps', distanceM: x.proofDist, note: 'Work completed', by: f.name, at: at(Math.min(age - 1, 6)) }] : [];
    if (proof.length) hist.push(sys('WORK_DONE', 'proof', f.name, 'field', `Proof uploaded ${x.proofDist} m from site (gps).`, Math.min(age - 1, 6)));
    if (['AWAITING_CITIZEN', 'CLOSED', 'REOPENED'].includes(status)) hist.push(sys('AWAITING_CITIZEN', 'verify', 'Officer', 'officer', 'Proof checked', Math.min(age - 0.5, 7)));
    if (status === 'NEEDS_ACTION') hist.push(sys('NEEDS_ACTION', 'needsAction', 'Officer', 'officer', 'Water still standing in photo', 8));
    const feedback = [];
    if (status === 'REOPENED') { feedback.push({ response: 'disputed', comment: 'Road still not restored', at: at(10) }); hist.push(sys('REOPENED', 'dispute', cit.name, 'citizen', 'Road still not restored', 10)); }
    if (status === 'CLOSED') { feedback.push({ response: 'confirmed', comment: '', at: at(x.closedAfter) }); hist.push(sys('CLOSED', 'confirm', cit.name, 'citizen', '', x.closedAfter)); }
    const c = {
      cid: `GHMC-2026-${String(i + 1).padStart(5, '0')}`, citizen: cit._id, citizenName: cit.name, citizenPhone: cit.phone, citizenEmail: cit.email,
      category, dept, description, location: { lat, lng, address }, status, slaDueAt: new Date(+created + slaHours * H),
      assignedTo: status === 'REGISTERED' ? undefined : f._id, assignedName: status === 'REGISTERED' ? undefined : f.name,
      closedAt: status === 'CLOSED' ? at(x.closedAfter) : undefined, reopenCount: x.reopen || 0, proof, feedback, history: hist,
      createdAt: created, updatedAt: hist.at(-1).at,
    };
    if (x.repeatOf != null) { c.isRepeat = true; c.repeatOf = [docs[x.repeatOf].cid]; hist.push(sys('REGISTERED', 'repeat', 'System', 'system', `Repeat of ${c.repeatOf[0]}`, 0)); }
    docs.push(c);
  }
  await Complaint.collection.insertMany(docs);
  console.log('Seeded demo users (password: civic123) and complaints');
}

await seed();
await sweep();
setInterval(() => sweep().catch(console.error), 60_000);
app.listen(PORT, () => console.log(`CivicSync API on http://localhost:${PORT}`));
