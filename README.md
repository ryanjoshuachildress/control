# Control

A private, self-hosted app for Dominants to guide, understand, and grow their submissives.

Stack: **Express + PostgreSQL** API, **React (Vite)** SPA served by the same process.
Sessions are cookie-based (30 days); everything is same-origin.
Designed for one Dominant with multiple submissives — each submissive has exactly one Dominant.

## Features

- **Registration with titles** — Dominants and submissives each pick a title at signup
  (Sir, Master, Daddy, Madam, Mistress… / baby girl, pet, toy, slave, slut,…) or set a custom one.
- **Pairing** — a Dominant gets an invite code; each submissive uses it to pair (one Dom per sub, many subs per Dom).
- **Daily check-in** — mood (1–10), rate-your-day (1–10), best part, worst part, and a private space for
  sexual thoughts or activities of the day.
- **Task / habit tracker** — the Dominant assigns tasks; the submissive checks them off during the day.
- **Evidence completion** — the Dominant chooses per task whether completion needs a checkbox or a
  photo/video upload. Photos and videos are stored privately; only that sub and their Dom can view them.
- **Deadlines** — daily tasks close at **midnight the submissive's local time**, weekly at **midnight Sunday**,
  monthly at **midnight the last day of the month**.
- **SMTP notifications** — the Dom is emailed when a sub completes a task, and when a task is
  **not completed before its deadline**. Submissives get a notice for new tasks and missed deadlines
  (each person can turn emails off in Settings).
- **Journals** — the Dom creates **daily and weekly prompts** per sub; the sub answers them.
  The Dom sees every sub entry, and chooses per entry whether the sub sees *their* entry.
- **Punishments** — the Dom assigns punishments (completed by checkbox or photo/video evidence, due
  within 24 hours). Each task can carry an **auto-punishment**: if a deadline passes unmet, the
  punishment is assigned automatically. The Dom is notified if a punishment sits uncompleted 24 hours.
- **Stats** — mood and day-rating line charts, check-in streak, completion-rate bars for daily tasks,
  and summary tiles (7d/30d/60d range picker). Subs see their own; Doms see each sub's.
- **About the submissive** — the Dom keeps a profile page per sub with basic physical and demographic
  info (name, date of birth, hair color, eye color) plus any custom fields they add. Fields can be
  single-line text, multi-line text, or **photos** (shown as a clickable thumbnail, full image opens
  in a new tab). Adding a field automatically adds it to **every** submissive's profile. The Dom fills
  in and edits the values; each submissive can **read** — never edit — only the individual fields
  the Dom has chosen to show them.
- **Comments** — two-way comment threads between the Dom and the submissive on journal entries,
  tasks, punishments, and daily check-ins, with email notifications. Only the Dom and the
  submissive(s) who can already see the item can take part in its thread.
- **Password reset** — "Forgot password" emails a one-hour, single-use reset link (and invalidates
  all signed-in sessions for that account). With SMTP disabled the link is printed to the container
  log so self-hosted reset still works.

## Quick start

```bash
cp .env.example .env
# edit .env: POSTGRES_PASSWORD, SESSION_SECRET (random string), BASE_URL, SMTP settings

docker compose up -d --build
```

The app listens on `127.0.0.1:3070` on the host — put your reverse proxy in front of it.

### First run

1. Register your **Dominant** account — pick your title. Your **invite code** appears on the dashboard.
2. Your submissive registers with the role *submissive* and enters that invite code
   (or pairs later via Settings → My Dominant).
3. Assign tasks and prompts from the sub's page; the check-in form appears on their "Today" screen.

## Reverse proxy

Point any proxy at `http://127.0.0.1:3070`. When the public URL is HTTPS:

- set `COOKIE_SECURE=1` in `.env`
- pass `X-Forwarded-Proto` (Nginx Proxy Manager, Traefik, and Caddy do this by default)

Uploads are up to 100 MB each, so raise the proxy's body limit if needed, e.g. for nginx:

```nginx
client_max_body_size 150m;
proxy_set_header X-Forwarded-Proto $scheme;
```

### Caddy

```
control.example.com {
    reverse_proxy 127.0.0.1:3070
    request_body { max_size 150MB }
}
```

## SMTP

Any SMTP server works (mail server on your homelab, or a provider). All settings live in `.env`:

| Var | Meaning |
|---|---|
| `SMTP_HOST` | Server hostname — **leave empty to disable email** (emails are logged, not sent) |
| `SMTP_PORT` | 587 (STARTTLS) or 465 (implicit TLS) |
| `SMTP_USER` / `SMTP_PASS` | Login (optional for open relays) |
| `SMTP_FROM` | From address, e.g. `Control <control@example.com>` |
| `BASE_URL` | Shown in email buttons — use your public URL |

## SMS (OpenSMS gateway)

Text notifications go through a self-hosted [OpenSMS](https://opensms.dev/)
gateway (a `POST` endpoint taking `{"number", "text"}` with a bearer token).
The Dominant configures it household-wide in **Settings → Text-message
gateway**: the full endpoint URL (e.g. `http://192.168.9.130:9292/sms/`) and
its bearer token. The token is stored in the database and never sent to
browsers. Optionally seed a fresh install via env — used only until the Dom
saves their own config:

| Var | Meaning |
|---|---|
| `OSMS_URL` | Fallback gateway endpoint URL (empty = no gateway) |
| `OSMS_TOKEN` | Fallback gateway bearer token |

Users opt in per person in Settings ("Text me notifications" + their mobile
number in `+` country-code form); SMS is logged to the container log instead
of sent when no gateway is configured.

## Data & schema

Data lives in PostgreSQL (`DATABASE_URL`, provided by the `db` service in
docker-compose). The schema is versioned under `migrations/` and applied
automatically at boot (`schema_migrations` tracks applied files). The legacy
SQLite database (`data/control.db`) is only a backup after migration; uploads
continue to live on disk under `data/uploads`.

One-shot legacy import:

```sh
SQLITE_PATH=/data/control.db \
DATABASE_URL=postgres://... node scripts/migrate-sqlite-to-pg.js
# or, on the compose host:
docker compose run --rm migrator node scripts/migrate-sqlite-to-pg.js
```

## Environment

- `DATABASE_URL` — required. `postgres://user:password@host:5432/db`
- `SESSION_SECRET` — cookie signing key
- `BASE_URL`, `COOKIE_SECURE` — for links/cookies behind your reverse proxy
- `SMTP_*` — mail; unset = mail logged to the container log (a Dom can also
  switch email off household-wide in Settings)
- `OSMS_URL`, `OSMS_TOKEN` — optional SMS-gateway seed; the Dom's in-app
  gateway config takes precedence
- `MAX_UPLOAD_MB` — per-file upload cap (evidence, feed, moment media)
- `IMMICH_URL`, `IMMICH_KEY` — optional Immich integration

Copy `.env.example` (which includes `POSTGRES_PASSWORD`) to `.env`.

## Development

- Backend: `DATABASE_URL=... npm start` (port 3000; migrations run on boot)
- Frontend: `cd web && npm run dev` (Vite dev server on :5173, proxying `/api`
  and `/uploads` to :3000)
- Build: `cd web && npm run build` → `web/dist`, served by express
- Tests: `TEST_PG_URL=postgres://... node scripts/run-tests.js` (or `npm test`)
  — spins up one throwaway database per script

## Deploy

1. Build on the host: `docker compose build`
2. One-time legacy import (see above) with the old container stopped
3. `docker compose up -d`

Port stays `3070` on the host; the reverse proxy config is unchanged.

Everything (SQLite database + uploaded photo/video evidence) lives in `./data/` on the host.
Back that directory up. No outside service ever receives your data — email is the only outbound traffic.

## Notes on deadlines

Deadlines are computed from **each submissive's timezone** (Settings → Timezone, defaults to their
browser's timezone at registration). The scheduler checks deadlines every minute; if a task period
ends without completion, the Dom is notified once for that period.

## Local development (no Docker)

```bash
npm install
TEST_PG_URL=postgres://... npm test   # against any dev PostgreSQL
DATABASE_URL=postgres://... npm start
# http://localhost:3000
```

## Tech

Node 20 · Express · PostgreSQL (pg) · cookie sessions · bcrypt · multer · nodemailer · React 18 + Vite frontend