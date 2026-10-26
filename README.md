# CivicSync — Verified Resolution of GHMC Civic Complaints (MERN prototype)

**Rule:** a complaint is closed only when the problem on the ground is actually fixed.

## Run
Needs Node 18+ and MongoDB on `mongodb://127.0.0.1:27017`.
```
npm run setup     # install + build React app
npm start         # http://localhost:5050  (demo data auto-seeds)
npm run reset     # wipe DB -> fresh demo data on next start
npm test          # rule checks
```
Demo password for every account: `civic123` (one-click buttons on the login page).

## How the PPT maps to the prototype
| PPT module | Where |
|---|---|
| 1. Citizen interface — category, GPS/map location, optional photo, complaint ID, track status | *Report issue*, public *Track a complaint* on login |
| 2. Complaint management — record, assigned party, timestamped status history, action log | Complaint detail → history |
| 3. Evidence & verification — completion photo, GPS location check (≤200 m), citizen feedback | Field staff *Upload proof*; officer review |
| 4. Review decision — Verified resolved / Needs further action / Waiting for inspection | Officer review buttons |
| 5. Follow-up & escalation — disputes go back to the responsible party; SLA ageing escalates to officer (L1) then supervisor (L2) | Citizen *dispute*, auto sweep every 60 s |
| 6. Monitoring — ageing cases, repeat complaints, verification results, sample-audit findings, Chart.js + OSM map | *Monitoring*, *Audits* |
| 7. Feedback loop — repeat complaint within 100 m/60 days flags the earlier closure for audit; failed audit reopens | automatic |
| Safeguards — role-based access, citizen contact masked for field/officer, audit log of every status change | *Audit log* tab |
| Email (PHPMailer in PPT) | Nodemailer; set `SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS` to send real email, otherwise in-app *Updates* + console |

## Workflow
REGISTERED → ASSIGNED → IN_PROGRESS → WORK_DONE (geo-tagged proof) → officer:
- **Verified** → AWAITING_CITIZEN → citizen **confirms** → CLOSED, or **disputes** → REOPENED (back to field staff)
- **Needs further action** → back to field staff
- **Inspection** (forced if proof is >200 m away) → supervisor inspects
- Citizen silent 72 h → AWAITING_INSPECTION; closes only after supervisor confirms on ground
- CLOSED can be disputed for 7 days, and can be pulled into a risk-based sample audit

Rules live in `server/rules.js`; API in `server/index.js`; UI in `client/src/App.jsx`.

## Deploy

### 1. Database — MongoDB Atlas (free)
Create a free M0 cluster → Database Access: add a user → Network Access: allow `0.0.0.0/0` → copy the connection string, e.g.
`mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/civicsync`

### 2. Backend — Render
New → **Blueprint** → pick this repo (uses `render.yaml`), or New → Web Service with:
- Root directory `server`, build `npm install`, start `npm start`, health check `/health`
- Env vars: `MONGO_URL` (Atlas string), `SECRET` (any long random string), `CORS_ORIGIN` (your Vercel URL, or `*` at first)

Demo data seeds itself on the first start. Check `https://<render-app>.onrender.com/health`.

### 3. Frontend — Vercel
New Project → import this repo → **Root Directory `client`** (framework: Vite, auto-detected).
- Env var: `VITE_API_URL=https://<render-app>.onrender.com`
- Deploy, then put the Vercel URL into Render's `CORS_ORIGIN` and redeploy Render.

Note: Render's free tier sleeps after 15 min idle — the first request can take ~50 s.
