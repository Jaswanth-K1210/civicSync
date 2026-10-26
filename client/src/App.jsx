import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import Chart from 'chart.js/auto';

const HYD = { lat: 17.385, lng: 78.4867 };
const LABEL = {
  REGISTERED: 'Registered', ASSIGNED: 'Assigned', IN_PROGRESS: 'In progress', WORK_DONE: 'Work done – awaiting review',
  AWAITING_CITIZEN: 'Verified – awaiting citizen', AWAITING_INSPECTION: 'Awaiting inspection', NEEDS_ACTION: 'Needs further action',
  REOPENED: 'Reopened (disputed)', CLOSED: 'Closed – verified',
};
const ROLE = { citizen: 'Citizen', grievance: 'Grievance Staff', officer: 'Department Officer', field: 'Field Staff / Inspector', supervisor: 'Supervisor' };
const fmt = (d) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

// Same-origin /api locally (Vite proxy); set VITE_API_URL to the Render URL on Vercel.
const API = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '') + '/api';
let token = localStorage.getItem('cs_token');
async function api(path, body) {
  const r = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) },
    body: body && JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// Shrink photos to ~800px JPEG before upload.
function readPhoto(file) {
  return new Promise((ok) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 800 / Math.max(img.width, img.height)), cv = document.createElement('canvas');
      cv.width = img.width * s; cv.height = img.height * s;
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      ok(cv.toDataURL('image/jpeg', 0.7));
    };
    img.src = URL.createObjectURL(file);
  });
}
const gps = () => new Promise((ok, no) => navigator.geolocation
  ? navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude }), () => no(new Error('Location permission denied')), { enableHighAccuracy: true, timeout: 10000 })
  : no(new Error('GPS not available')));

const Badge = ({ s }) => <span className={'badge s-' + s}>{LABEL[s] || s}</span>;

// ---------- maps (OpenStreetMap via Leaflet) ----------
function MapView({ points = [], pick, onPick, big }) {
  const el = useRef(), map = useRef(), layer = useRef();
  useEffect(() => {
    map.current = L.map(el.current).setView([HYD.lat, HYD.lng], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 19 }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => map.current.remove();
  }, []);
  useEffect(() => {
    map.current.off('click');
    if (onPick) map.current.on('click', (e) => onPick({ lat: e.latlng.lat, lng: e.latlng.lng }));
  }, [onPick]);
  useEffect(() => {
    layer.current.clearLayers();
    const all = pick ? [...points, { ...pick, color: '#b3261e', label: 'Selected location' }] : points;
    for (const p of all) {
      const m = L.circleMarker([p.lat, p.lng], { radius: 8, color: p.color || '#0b5d73', fillOpacity: 0.7, weight: 2 }).addTo(layer.current);
      if (p.label) m.bindTooltip(p.label);
      if (p.onClick) m.on('click', p.onClick);
    }
    if (pick) map.current.setView([pick.lat, pick.lng], Math.max(map.current.getZoom(), 15));
    else if (points.length === 1) map.current.setView([points[0].lat, points[0].lng], 15);
  }, [points, pick]);
  return <div ref={el} className={'map' + (big ? ' big' : '')} />;
}

function ChartBox({ title, type, labels, values, colors }) {
  const el = useRef();
  useEffect(() => {
    const c = new Chart(el.current, {
      type, data: { labels, datasets: [{ data: values, backgroundColor: colors || '#0b5d73', label: title }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: type === 'doughnut', position: 'right' } }, ...(type === 'bar' && { scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }) },
    });
    return () => c.destroy();
  }, [JSON.stringify(values)]);
  return <div className="card"><h3>{title}</h3><div style={{ height: 240 }}><canvas ref={el} /></div></div>;
}

// ---------- login / public tracking ----------
function Login({ onLogin }) {
  const [f, setF] = useState({ username: '', password: '' }), [reg, setReg] = useState(false), [err, setErr] = useState('');
  const [tid, setTid] = useState(''), [track, setTrack] = useState(null);
  const go = async (body) => {
    setErr('');
    try { const r = await api(reg ? '/register' : '/login', body); onLogin(r); } catch (e) { setErr(e.message); }
  };
  const demo = [['ravi', 'Citizen – Ravi'], ['lakshmi', 'Citizen – Lakshmi'], ['grievance', 'Grievance Staff'], ['officer_san', 'Officer – Sanitation'],
    ['officer_eng', 'Officer – Engineering'], ['officer_ele', 'Officer – Electrical'], ['field_san', 'Field – Sanitation'], ['field_eng', 'Field – Engineering'],
    ['field_ele', 'Field – Electrical'], ['supervisor', 'Supervisor']];
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="login">
      <div className="hero">
        <h1>CivicSync</h1>
        <p>Verified Closure & Ageing-Case Review for GHMC civic complaints.</p>
        <p><b>A complaint is closed only when the problem on the ground is actually fixed.</b></p>
        <ol>
          <li>Citizen reports the issue (category, GPS location, photo)</li>
          <li>Complaint is registered & routed to the right department</li>
          <li>Field staff do the work and upload geo-tagged proof</li>
          <li>Officer verifies the outcome (or sends for inspection)</li>
          <li>Citizen confirms — or disputes and it goes back for more work</li>
          <li>Ageing, repeat and sampled-audit cases are monitored</li>
        </ol>
        <div className="card" style={{ color: 'var(--ink)', marginTop: 16 }}>
          <h3>Track a complaint</h3>
          <div className="row"><input style={{ flex: 1 }} placeholder="e.g. GHMC-2026-00001" value={tid} onChange={(e) => setTid(e.target.value)} />
            <button onClick={() => api('/track/' + tid).then(setTrack).catch((e) => setTrack({ error: e.message }))}>Track</button></div>
          {track?.error && <div className="err">{track.error}</div>}
          {track?.cid && <div style={{ marginTop: 10 }}><b>{track.cid}</b> · {track.category} · <Badge s={track.status} />
            <div className="timeline" style={{ marginTop: 8 }}>{track.history.map((h, i) => <div key={i}><Badge s={h.status} /> <span className="muted">{fmt(h.at)}</span></div>)}</div></div>}
        </div>
      </div>
      <div className="card">
        <h2>{reg ? 'Register as citizen' : 'Log in'}</h2>
        {reg && <><label>Full name</label><input value={f.name || ''} onChange={set('name')} />
          <label>Mobile</label><input value={f.phone || ''} onChange={set('phone')} />
          <label>Email (for updates)</label><input value={f.email || ''} onChange={set('email')} /></>}
        <label>Username</label><input value={f.username} onChange={set('username')} />
        <label>Password</label><input type="password" value={f.password} onChange={set('password')} onKeyDown={(e) => e.key === 'Enter' && go(f)} />
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={() => go(f)}>{reg ? 'Register' : 'Log in'}</button>
          <button className="ghost" onClick={() => setReg(!reg)}>{reg ? 'I have an account' : 'New citizen? Register'}</button>
        </div>
        {!reg && <><h3 style={{ marginTop: 20 }}>Demo accounts (password civic123)</h3>
          <div className="quick">{demo.map(([u, l]) => <button key={u} className="ghost" onClick={() => go({ username: u, password: 'civic123' })}>{l}</button>)}</div></>}
      </div>
    </div>
  );
}

// ---------- citizen: report ----------
function Report({ onDone }) {
  const [cats, setCats] = useState({}), [f, setF] = useState({ category: '', description: '', address: '' });
  const [loc, setLoc] = useState(null), [photo, setPhoto] = useState(null), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { api('/categories').then(setCats); }, []);
  const submit = async () => {
    setErr('');
    if (!f.category || !f.description.trim() || !loc) return setErr('Category, description and location are required');
    setBusy(true);
    try { const c = await api('/complaints', { ...f, ...loc, photo }); onDone(c); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <div className="grid2">
      <div className="card">
        <h2>Report a civic issue</h2>
        <label>Category</label>
        <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          <option value="">Select…</option>
          {Object.entries(cats).map(([k, v]) => <option key={k} value={k}>{k} — {v.dept}, fix within {v.slaHours}h</option>)}
        </select>
        <label>Describe the problem</label>
        <textarea rows="3" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <label>Landmark / address</label>
        <input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
        <label>Photo (optional)</label>
        <input type="file" accept="image/*" capture="environment" onChange={async (e) => e.target.files[0] && setPhoto(await readPhoto(e.target.files[0]))} />
        {photo && <img className="photo" src={photo} style={{ marginTop: 8 }} />}
        <label>Location</label>
        <div className="row"><button className="ghost" onClick={() => gps().then(setLoc).catch((e) => setErr(e.message))}>📍 Use my GPS</button>
          <span className="muted">{loc ? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` : 'or click on the map'}</span></div>
        {err && <div className="err">{err}</div>}
        <button style={{ marginTop: 14, width: '100%' }} disabled={busy} onClick={submit}>Submit complaint</button>
      </div>
      <div className="card"><h3>Pick the exact spot</h3><MapView pick={loc} onPick={setLoc} big /></div>
    </div>
  );
}

// ---------- complaint detail + role actions ----------
function Detail({ id, user, onChange }) {
  const [c, setC] = useState(null), [note, setNote] = useState(''), [err, setErr] = useState(''), [staff, setStaff] = useState([]), [staffId, setStaffId] = useState('');
  const [proof, setProof] = useState({ photo: null, loc: null, source: '' });
  const load = () => api('/complaints/' + id).then(setC).catch((e) => setErr(e.message));
  useEffect(() => { setC(null); setErr(''); setNote(''); setProof({ photo: null, loc: null }); load(); }, [id]);
  useEffect(() => { if (c && ['grievance', 'officer'].includes(user.role)) api('/staff?dept=' + c.dept).then(setStaff); }, [c?.dept]);
  if (!c) return <div className="card">{err || 'Loading…'}</div>;

  const act = async (action, extra = {}) => {
    setErr('');
    try { setC(await api(`/complaints/${c._id}/${action}`, { note, ...extra })); setNote(''); onChange?.(); } catch (e) { setErr(e.message); }
  };
  const s = c.status, r = user.role, last = c.proof?.at(-1);
  const can = (roles, statuses) => roles.includes(r) && statuses.includes(s);
  const disputeOk = s === 'AWAITING_CITIZEN' || (s === 'CLOSED' && Date.now() - new Date(c.closedAt) < 7 * 864e5);
  const pts = [{ ...c.location, label: 'Complaint location' }, ...(last ? [{ lat: last.lat, lng: last.lng, color: last.distanceM > 200 ? '#b3261e' : '#1f7a4a', label: `Proof (${last.distanceM} m away)` }] : [])];

  return (
    <div className="card">
      <div className="row"><h2 style={{ margin: 0 }}>{c.cid}</h2><Badge s={s} />
        {c.overdue && <span className="badge flag">Overdue SLA</span>}
        {c.escalationLevel > 0 && <span className="badge flag">Escalated L{c.escalationLevel}</span>}
        {c.isRepeat && <span className="badge flag">Repeat of {c.repeatOf.join(', ')}</span>}
        {c.reopenCount > 0 && <span className="badge flag">Reopened ×{c.reopenCount}</span>}
        {c.audit?.sampled && <span className="badge">Audit: {c.audit.result || 'pending'}</span>}</div>
      <p><b>{c.category}</b> · {c.dept} dept · {c.description}</p>
      <div className="muted">📍 {c.location.address || `${c.location.lat.toFixed(5)}, ${c.location.lng.toFixed(5)}`} · Filed {fmt(c.createdAt)} · Fix due {fmt(c.slaDueAt)}</div>
      {r !== 'citizen' && <div className="muted">Citizen: {c.citizenName} · {c.citizenPhone} · {c.citizenEmail} {['field', 'officer'].includes(r) && '(masked for privacy)'}</div>}
      <div className="muted">Assigned to: {c.assignedName || '—'}</div>

      <div className="grid2" style={{ marginTop: 12 }}>
        <div>
          {c.photo && <><h3>Citizen photo</h3><img className="photo" src={c.photo} /></>}
          {last && <><h3 style={{ marginTop: 10 }}>Completion proof</h3>
            {last.photo && <img className="photo" src={last.photo} />}
            <div className={last.distanceM > 200 ? 'err' : 'okmsg'}>Location check: {last.distanceM} m from complaint {last.distanceM > 200 ? '✗ too far — needs inspection' : '✓ matches'} ({last.source || 'gps'})</div>
            <div className="muted">{last.by} · {fmt(last.at)} · {last.note}</div></>}
        </div>
        <MapView points={pts} />
      </div>

      {/* actions available to this role at this status */}
      <div className="actions">
        {can(['grievance', 'officer'], ['REGISTERED', 'REOPENED', 'NEEDS_ACTION']) && <>
          <h3>Assign to field staff ({c.dept})</h3>
          <div className="row"><select style={{ flex: 1 }} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">Select staff…</option>{staff.map((x) => <option key={x._id} value={x._id}>{x.name}</option>)}</select>
            <button onClick={() => act('assign', { staffId })}>Assign</button></div></>}

        {can(['field'], ['ASSIGNED', 'NEEDS_ACTION', 'REOPENED']) && <button onClick={() => act('start')}>Start work</button>}

        {can(['field'], ['IN_PROGRESS']) && <>
          <h3>Upload completion proof</h3>
          <label>After-work photo (required)</label>
          <input type="file" accept="image/*" capture="environment" onChange={async (e) => e.target.files[0] && setProof({ ...proof, photo: await readPhoto(e.target.files[0]) })} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="ghost" onClick={() => gps().then((loc) => setProof({ ...proof, loc, source: 'gps' })).catch((e) => setErr(e.message))}>📍 Capture GPS</button>
            <button className="ghost" onClick={() => setProof({ ...proof, loc: c.location, source: 'manual (demo)' })}>Use site location (demo)</button>
            <span className="muted">{proof.loc ? `${proof.loc.lat.toFixed(5)}, ${proof.loc.lng.toFixed(5)} (${proof.source})` : 'location not captured'}</span></div>
          <label>Work note</label><input value={note} onChange={(e) => setNote(e.target.value)} />
          <button style={{ marginTop: 8 }} disabled={!proof.photo || !proof.loc} onClick={() => act('proof', { photo: proof.photo, ...proof.loc, source: proof.source })}>Submit proof</button></>}

        {can(['officer'], ['WORK_DONE']) && <>
          <h3>Review decision</h3>
          <label>Note</label><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Required for 'needs further action'" />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="okb" onClick={() => act('verify')}>✓ Verified resolved</button>
            <button className="danger" onClick={() => act('needsAction')}>Needs further action</button>
            <button className="ghost" onClick={() => act('inspect')}>Send for field inspection</button></div></>}

        {can(['supervisor', 'officer'], ['AWAITING_INSPECTION']) && <>
          <h3>Field inspection result {c.citizenSilent && <span className="badge">citizen did not reply</span>}</h3>
          <label>Inspection note</label><input value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            {r === 'supervisor' && <button className="okb" onClick={() => act('inspectPass')}>Fix confirmed on ground</button>}
            <button className="danger" onClick={() => act('needsAction')}>Not fixed — send back</button></div></>}

        {r === 'citizen' && (s === 'AWAITING_CITIZEN' || disputeOk) && <>
          <h3>{s === 'AWAITING_CITIZEN' ? 'Is the problem actually fixed?' : 'Problem came back? You can dispute within 7 days of closure.'}</h3>
          <label>Comment</label><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Required if disputing" />
          <div className="row" style={{ marginTop: 8 }}>
            {s === 'AWAITING_CITIZEN' && <button className="okb" onClick={() => act('confirm')}>Yes, it is fixed — close it</button>}
            <button className="danger" onClick={() => act('dispute')}>No, still not fixed</button></div></>}

        {r === 'supervisor' && s === 'CLOSED' && c.audit?.sampled && !c.audit.result && <>
          <h3>Sample audit — {c.audit.reasons.join(', ')}</h3>
          <label>Audit finding</label><input value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="okb" onClick={() => act('auditPass')}>Audit pass</button>
            <button className="danger" onClick={() => act('auditFail')}>Audit fail — reopen</button></div></>}
        {err && <div className="err">{err}</div>}
        <div className="muted" style={{ marginTop: 6 }}>Rule: a complaint closes only after verified proof + citizen confirmation (or supervisor inspection if the citizen does not reply in 72h).</div>
      </div>

      <h3 style={{ marginTop: 14 }}>Status history & action log</h3>
      <div className="timeline">{c.history.slice().reverse().map((h, i) => (
        <div key={i}><Badge s={h.status} /> <b>{h.action}</b> by {h.by} <span className="muted">({ROLE[h.role] || h.role}) · {fmt(h.at)}</span>{h.note && <div className="muted">{h.note}</div>}</div>))}</div>
    </div>
  );
}

function Queue({ user, initial }) {
  const [list, setList] = useState([]), [sel, setSel] = useState(initial), [filter, setFilter] = useState('');
  const load = () => api('/complaints').then(setList);
  useEffect(() => { load(); }, []);
  const shown = list.filter((c) => !filter || (filter === 'OVERDUE' ? c.overdue : c.status === filter));
  return (
    <div className="grid2">
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{user.role === 'citizen' ? 'My complaints' : user.role === 'field' ? 'My work' : 'Complaints'} ({shown.length})</h2>
          <select style={{ width: 200 }} value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All statuses</option><option value="OVERDUE">Overdue only</option>
            {Object.entries(LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="list" style={{ marginTop: 10 }}>
          {shown.map((c) => (
            <div key={c._id} className={'item' + (sel === c._id ? ' sel' : '')} onClick={() => setSel(c._id)}>
              <div className="row"><b>{c.cid}</b><Badge s={c.status} />{c.overdue && <span className="badge flag">Overdue</span>}{c.isRepeat && <span className="badge flag">Repeat</span>}</div>
              <div>{c.category} — {c.description}</div>
              <div className="muted">{c.location.address} · {fmt(c.createdAt)}</div>
            </div>))}
          {!shown.length && <div className="muted">Nothing here.</div>}
        </div>
      </div>
      {sel ? <Detail id={sel} user={user} onChange={load} /> : <div className="card muted">Select a complaint to see details and actions.</div>}
    </div>
  );
}

// ---------- monitoring ----------
function Dashboard({ open }) {
  const [d, setD] = useState(null);
  useEffect(() => { api('/stats').then(setD); }, []);
  if (!d) return <div className="card">Loading…</div>;
  const kpi = [['Total complaints', d.total], ['Closed (verified)', d.closed], ['Open', d.open], ['Overdue SLA', d.overdue],
    ['Citizen-confirmed', d.confirmedByCitizen], ['Disputed closures', d.disputed], ['Repeat complaints', d.repeats], ['Audit fails', d.audit.fail]];
  const palette = ['#0b5d73', '#3a8fa6', '#7cc0d1', '#1f7a4a', '#b76b00', '#b3261e', '#6a4c93', '#999', '#e0a458'];
  const pts = d.points.map((p) => ({ ...p, color: p.status === 'CLOSED' ? '#1f7a4a' : p.overdue ? '#b3261e' : '#b76b00', label: `${p.cid} · ${p.category} · ${LABEL[p.status]}`, onClick: () => open(p._id) }));
  return (
    <>
      <div className="kpis">{kpi.map(([l, n]) => <div className="kpi" key={l}><div className="n">{n}</div><div className="l">{l}</div></div>)}</div>
      <div className="charts">
        <ChartBox title="Complaints by status" type="doughnut" labels={Object.keys(d.byStatus).map((k) => LABEL[k])} values={Object.values(d.byStatus)} colors={palette} />
        <ChartBox title="Verification results" type="bar" labels={Object.keys(d.verification)} values={Object.values(d.verification)} colors={['#1f7a4a', '#b3261e', '#b76b00', '#3a8fa6', '#6a4c93']} />
        <ChartBox title="Open complaints by age" type="bar" labels={Object.keys(d.buckets)} values={Object.values(d.buckets)} colors={['#7cc0d1', '#3a8fa6', '#b76b00', '#b3261e']} />
        <ChartBox title="Complaints by category" type="bar" labels={Object.keys(d.byCategory)} values={Object.values(d.byCategory)} />
      </div>
      <div className="card"><h3>Complaint map — red: overdue, amber: open, green: closed (click to open)</h3><MapView points={pts} big /></div>
      <div className="card"><h3>Ageing cases (past SLA)</h3>
        <table><thead><tr><th>ID</th><th>Category</th><th>Status</th><th>Age</th><th>Due</th><th>Escalation</th><th>Assigned</th></tr></thead>
          <tbody>{d.ageing.map((c) => <tr key={c._id} onClick={() => open(c._id)} style={{ cursor: 'pointer' }}><td><b>{c.cid}</b></td><td>{c.category}</td><td><Badge s={c.status} /></td><td>{c.ageDays} d</td><td>{fmt(c.slaDueAt)}</td><td>{c.escalationLevel ? `L${c.escalationLevel} — ${c.escalationLevel === 1 ? 'Officer' : 'Supervisor'}` : '—'}</td><td>{c.assignedName || 'Unassigned'}</td></tr>)}</tbody></table></div>
      <div className="card"><h3>Repeat complaints</h3>
        <table><thead><tr><th>ID</th><th>Category</th><th>Location</th><th>Repeat of</th><th>Status</th></tr></thead>
          <tbody>{d.repeatList.map((c) => <tr key={c._id} onClick={() => open(c._id)} style={{ cursor: 'pointer' }}><td><b>{c.cid}</b></td><td>{c.category}</td><td>{c.location.address}</td><td>{c.repeatOf.join(', ')}</td><td><Badge s={c.status} /></td></tr>)}</tbody></table></div>
    </>
  );
}

function Audits({ user, open }) {
  const [list, setList] = useState([]), [msg, setMsg] = useState('');
  const load = () => api('/audit').then(setList);
  useEffect(() => { load(); }, []);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>Sample audits of closed complaints</h2>
        {user.role === 'supervisor' && <button onClick={() => api('/audit/sample', {}).then((r) => { setMsg(`${r.picked} complaints added to the audit sample`); load(); })}>Generate audit sample</button>}</div>
      <p className="muted">Picks every risky closure (reopened, recurred, far-away proof, closed in &lt;2h, citizen silent) plus 10% random. A failed audit reopens the complaint.</p>
      {msg && <div className="okmsg">{msg}</div>}
      <table><thead><tr><th>ID</th><th>Category</th><th>Why sampled</th><th>Result</th><th>Finding</th></tr></thead>
        <tbody>{list.map((c) => <tr key={c._id} onClick={() => open(c._id)} style={{ cursor: 'pointer' }}><td><b>{c.cid}</b></td><td>{c.category}</td><td>{c.audit.reasons?.join(', ')}</td>
          <td>{c.audit.result ? <span className={'badge ' + (c.audit.result === 'pass' ? 's-CLOSED' : 'flag')}>{c.audit.result}</span> : <span className="badge">pending — open to audit</span>}</td><td>{c.audit.note}</td></tr>)}</tbody></table>
    </div>
  );
}

function AuditLog() {
  const [rows, setRows] = useState([]);
  useEffect(() => { api('/audit-log').then(setRows); }, []);
  return (
    <div className="card"><h2>Audit log — every status change</h2>
      <table><thead><tr><th>Time</th><th>Complaint</th><th>Action</th><th>New status</th><th>By</th><th>Note</th></tr></thead>
        <tbody>{rows.map((h, i) => <tr key={i}><td>{fmt(h.at)}</td><td>{h.cid}</td><td>{h.action}</td><td><Badge s={h.status} /></td><td>{h.by} <span className="muted">({ROLE[h.role] || h.role})</span></td><td>{h.note}</td></tr>)}</tbody></table></div>
  );
}

function Notifications() {
  const [rows, setRows] = useState([]);
  useEffect(() => { api('/notifications').then(setRows); }, []);
  return (
    <div className="card"><h2>Updates</h2>
      <div className="list">{rows.map((n) => <div key={n._id} className="item"><b>{n.cid}</b> — {n.text}<div className="muted">{fmt(n.at)}</div></div>)}
        {!rows.length && <div className="muted">No updates yet.</div>}</div></div>
  );
}

export default function App() {
  const [user, setUser] = useState(() => JSON.parse(localStorage.getItem('cs_user') || 'null'));
  const [tab, setTab] = useState(''), [openId, setOpenId] = useState(null), [flash, setFlash] = useState('');
  const login = ({ token: t, user: u }) => { token = t; localStorage.setItem('cs_token', t); localStorage.setItem('cs_user', JSON.stringify(u)); setUser(u); setTab(''); };
  const logout = () => { token = null; localStorage.clear(); setUser(null); };
  if (!user) return <Login onLogin={login} />;

  const tabs = {
    citizen: [['report', 'Report issue'], ['queue', 'My complaints'], ['notes', 'Updates']],
    field: [['queue', 'My work'], ['notes', 'Updates']],
    officer: [['queue', 'Department queue'], ['dash', 'Monitoring'], ['notes', 'Updates']],
    grievance: [['queue', 'All complaints'], ['dash', 'Monitoring'], ['audit', 'Audits'], ['log', 'Audit log'], ['notes', 'Updates']],
    supervisor: [['dash', 'Monitoring'], ['queue', 'All complaints'], ['audit', 'Audits'], ['log', 'Audit log'], ['notes', 'Updates']],
  }[user.role];
  const cur = tab || tabs[0][0];
  const open = (id) => { setOpenId(id); setTab('queue'); };

  return (
    <>
      <div className="top"><div><b>CivicSync</b><div className="sub">GHMC · Verified Resolution of Civic Complaints</div></div>
        <div className="right"><span>{user.name} · {ROLE[user.role]}{user.dept ? ` (${user.dept})` : ''}</span><button onClick={logout}>Log out</button></div></div>
      <div className="tabs">{tabs.map(([k, l]) => <button key={k} className={cur === k ? 'on' : ''} onClick={() => { setTab(k); setOpenId(null); setFlash(''); }}>{l}</button>)}</div>
      <main>
        {flash && <div className="card okmsg">{flash}</div>}
        {cur === 'report' && <Report onDone={(c) => { setFlash(`Complaint registered. Your ID is ${c.cid} — routed to ${c.dept}, fix due ${fmt(c.slaDueAt)}.${c.isRepeat ? ' Flagged as repeat of ' + c.repeatOf.join(', ') + '.' : ''}`); open(c._id); }} />}
        {cur === 'queue' && <Queue key={openId} user={user} initial={openId} />}
        {cur === 'dash' && <Dashboard open={open} />}
        {cur === 'audit' && <Audits user={user} open={open} />}
        {cur === 'log' && <AuditLog />}
        {cur === 'notes' && <Notifications />}
      </main>
    </>
  );
}
