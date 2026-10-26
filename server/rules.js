// CivicSync business rules — pure functions so they can be tested without a DB.

export const CATEGORIES = {
  'Garbage / Solid Waste': { dept: 'Sanitation', slaHours: 24 },
  'Drainage / Sewer Overflow': { dept: 'Sanitation', slaHours: 48 },
  'Pothole / Road Damage': { dept: 'Engineering', slaHours: 72 },
  'Water Logging': { dept: 'Engineering', slaHours: 48 },
  'Streetlight Not Working': { dept: 'Electrical', slaHours: 48 },
};

export const OPEN = ['REGISTERED', 'ASSIGNED', 'IN_PROGRESS', 'WORK_DONE', 'NEEDS_ACTION', 'AWAITING_INSPECTION', 'REOPENED'];
export const MAX_PROOF_DISTANCE_M = 200;   // proof photo must be taken this close to the complaint
export const REPEAT_RADIUS_M = 100;        // same category within this radius ...
export const REPEAT_WINDOW_DAYS = 60;      // ... within this many days = repeat complaint
export const CITIZEN_REPLY_HOURS = 72;     // no reply after verification -> field inspection
export const DISPUTE_WINDOW_DAYS = 7;      // citizen can dispute a closure this long after it

// action -> who may do it, from which statuses, to which status
export const ACTIONS = {
  assign:      { roles: ['grievance', 'officer'], from: ['REGISTERED', 'REOPENED', 'NEEDS_ACTION'], to: 'ASSIGNED' },
  start:       { roles: ['field'], from: ['ASSIGNED', 'NEEDS_ACTION', 'REOPENED'], to: 'IN_PROGRESS' },
  proof:       { roles: ['field'], from: ['IN_PROGRESS'], to: 'WORK_DONE' },
  verify:      { roles: ['officer'], from: ['WORK_DONE'], to: 'AWAITING_CITIZEN' },
  needsAction: { roles: ['officer', 'supervisor'], from: ['WORK_DONE', 'AWAITING_INSPECTION'], to: 'NEEDS_ACTION' },
  inspect:     { roles: ['officer'], from: ['WORK_DONE'], to: 'AWAITING_INSPECTION' },
  inspectPass: { roles: ['supervisor'], from: ['AWAITING_INSPECTION'], to: 'AWAITING_CITIZEN' },
  confirm:     { roles: ['citizen'], from: ['AWAITING_CITIZEN'], to: 'CLOSED' },
  dispute:     { roles: ['citizen'], from: ['AWAITING_CITIZEN', 'CLOSED'], to: 'REOPENED' },
  auditPass:   { roles: ['supervisor'], from: ['CLOSED'], to: 'CLOSED' },
  auditFail:   { roles: ['supervisor'], from: ['CLOSED'], to: 'REOPENED' },
};

export function distanceM(a, b) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

// Returns an error string if the action is not allowed, else null.
export function checkAction(c, action, role, now = new Date()) {
  const a = ACTIONS[action];
  if (!a) return 'Unknown action';
  if (!a.roles.includes(role)) return `Role "${role}" cannot ${action}`;
  if (!a.from.includes(c.status)) return `Cannot ${action} while status is ${c.status}`;
  if (action === 'verify') {
    const p = c.proof?.at(-1);
    if (!p?.photo) return 'No completion photo — cannot verify';
    if (p.distanceM > MAX_PROOF_DISTANCE_M) return `Proof taken ${p.distanceM} m away — send for inspection instead`;
  }
  if (action === 'dispute' && c.status === 'CLOSED' &&
      now - new Date(c.closedAt) > DISPUTE_WINDOW_DAYS * 864e5) return 'Dispute window has passed — file a new complaint';
  if (action.startsWith('audit') && !c.audit?.sampled) return 'Complaint is not in the audit sample';
  return null;
}

// Risk reasons used to pick closed complaints for audit.
export function riskReasons(c) {
  const r = [];
  if (c.reopenCount > 0) r.push('Reopened before');
  if (c.recurredAfterClosure) r.push('Issue recurred after closure');
  if (c.proof?.at(-1)?.distanceM > 100) r.push('Proof location far from complaint');
  if (c.closedAt && new Date(c.closedAt) - new Date(c.createdAt) < 2 * 36e5) r.push('Closed suspiciously fast (<2h)');
  if (c.citizenSilent) r.push('Closed without citizen reply');
  return r;
}

// All risky closed complaints + ~10% random of the rest (at least 1).
export function pickAuditSample(closed, rand = Math.random) {
  const risky = [], rest = [];
  for (const c of closed) (riskReasons(c).length ? risky : rest).push(c);
  const n = rest.length ? Math.max(1, Math.ceil(rest.length * 0.1)) : 0;
  const shuffled = rest.map((c) => [rand(), c]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  return [...risky.map((c) => ({ c, reasons: riskReasons(c) })), ...shuffled.slice(0, n).map((c) => ({ c, reasons: ['Random sample'] }))];
}

// Escalation level from SLA ageing: 0 on time, 1 overdue (officer), 2 >2x SLA (supervisor).
export function escalationLevel(c, now = new Date()) {
  if (!OPEN.includes(c.status)) return c.escalationLevel || 0;
  const over = now - new Date(c.slaDueAt), sla = CATEGORIES[c.category].slaHours * 36e5;
  const lvl = over > sla ? 2 : over > 0 ? 1 : 0;
  return Math.max(lvl, c.escalationLevel || 0);
}

export function findRepeats(newC, candidates) {
  const since = Date.now() - REPEAT_WINDOW_DAYS * 864e5;
  return candidates.filter((c) => c.category === newC.category && new Date(c.createdAt) >= since &&
    distanceM(c.location, newC.location) <= REPEAT_RADIUS_M);
}
