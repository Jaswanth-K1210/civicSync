import assert from 'node:assert/strict';
import { checkAction, distanceM, pickAuditSample, escalationLevel, findRepeats } from './rules.js';

const loc = { lat: 17.385, lng: 78.4867 };
const now = new Date();

// verify needs a nearby proof photo
assert.match(checkAction({ status: 'WORK_DONE', proof: [] }, 'verify', 'officer'), /No completion photo/);
assert.match(checkAction({ status: 'WORK_DONE', proof: [{ photo: 'x', distanceM: 900 }] }, 'verify', 'officer'), /inspection/);
assert.equal(checkAction({ status: 'WORK_DONE', proof: [{ photo: 'x', distanceM: 50 }] }, 'verify', 'officer'), null);
// roles + statuses enforced
assert.match(checkAction({ status: 'WORK_DONE' }, 'verify', 'field'), /cannot/);
assert.match(checkAction({ status: 'REGISTERED' }, 'confirm', 'citizen'), /Cannot confirm/);
// dispute window
assert.equal(checkAction({ status: 'CLOSED', closedAt: now }, 'dispute', 'citizen'), null);
assert.match(checkAction({ status: 'CLOSED', closedAt: new Date(now - 10 * 864e5) }, 'dispute', 'citizen'), /window/);
// distance
assert.ok(Math.abs(distanceM(loc, { lat: 17.386, lng: 78.4867 }) - 111) < 2);
// audit sample: risky always in, plus >=1 random
const closed = [{ reopenCount: 1 }, ...Array.from({ length: 20 }, () => ({ reopenCount: 0 }))];
const s = pickAuditSample(closed);
assert.equal(s.length, 3);
assert.equal(s[0].reasons[0], 'Reopened before');
// escalation
const c = { status: 'ASSIGNED', category: 'Garbage / Solid Waste' };
assert.equal(escalationLevel({ ...c, slaDueAt: new Date(+now + 1e6) }), 0);
assert.equal(escalationLevel({ ...c, slaDueAt: new Date(+now - 1e6) }), 1);
assert.equal(escalationLevel({ ...c, slaDueAt: new Date(+now - 30 * 36e5) }), 2);
// repeats
const r = findRepeats({ category: 'Water Logging', location: loc },
  [{ category: 'Water Logging', location: { lat: 17.3855, lng: 78.4867 }, createdAt: now },
   { category: 'Water Logging', location: { lat: 17.40, lng: 78.4867 }, createdAt: now },
   { category: 'Pothole / Road Damage', location: loc, createdAt: now }]);
assert.equal(r.length, 1);
console.log('all rule checks passed');
