# CloudForge Server — the always-on brain

This is the web service that lets your customers deploy their own sites 24/7 —
**even when your PC is off** — because it runs on your always-on VPS (Oracle free, etc.).

It reuses the proven engine modules in `../src` (SSH, monitoring, SSL, Telegram).

## Run it (locally, to test now)

```
npm install
npm run server
```

Then open:
- **Owner panel:** http://localhost:3000/ — first visit asks you to set your owner password.
- **Customer app:** http://localhost:3000/app — your customers sign in with their key.

(Windows: just double-click `Start-Server.bat`.)

## First-time flow (owner)

1. **Set your owner password** (first screen).
2. **Servers → ① Source VPS** — add your Oracle VPS once (where all source code lives).
3. **Servers → ② Client VPSs** — add a customer's server (works with any VPS, normal SSH login).
4. **Projects → New project** — name it, pick the client VPS, choose the deploy stack
   (Docker Compose / PM2 / custom — buttons, no typing), set domain + backup folder.
5. A **customer key** (`CF-XXXX-XXXX-XXXX`) is shown **once** — copy it and send it to your customer.
6. **Settings** — paste your AI developer key once (hidden from customers, you pay), set global rules + Telegram alerts.

## What the customer sees

They open `/app`, enter their key, and get **only their own project** — no switching,
no secrets, no server details. Buttons: **Deploy full website** / **Update backend**,
plus **rollback** if a backup folder is set. A safety backup runs before every deploy.

## Safety & scale (3–5 customers on Oracle free)

- **Build queue** — at most `CF_MAX_BUILDS` (default 2) heavy deploys run at once; the rest wait. Stops the VPS from being overloaded.
- **Daily deploy limit** per customer (set per project; 0 = unlimited).
- **Isolation** — each customer's key is locked server-side to one project.
- **Encrypted at rest** — SSH passwords/keys and the AI key are AES-256-GCM encrypted (`server/data/master.key`).
- **Auto-backup before deploy + 1-click rollback.**

## Environment variables

| Var | Default | Meaning |
|-----|---------|---------|
| `CF_PORT` | 3000 | Port to listen on |
| `CF_HOST` | 0.0.0.0 | Bind address |
| `CF_DATA_DIR` | `server/data` | Where db.json + master.key live |
| `CF_MAX_BUILDS` | 2 | Max simultaneous deploys |
| `CF_MASTER_KEY` | (file) | Base64 32-byte key; overrides `master.key` (use in production) |
| `CF_HTTPS` | (off) | Set when served over HTTPS so the session cookie is `secure` |

## Moving to the Oracle VPS later

Same code. Copy the folder to the VPS, `npm install`, run behind nginx with
certbot SSL on `app.yourdomain.com`, keep it running with `pm2` or a systemd service.
Back up `server/data/` (it holds everything, encrypted).

> Not built yet (next phase): the **AI developer** panel inside the customer app
> (chat + screenshot → edit code → preview → Approve → deploy). The server, keys,
> rules, isolation and deploy pipeline it needs are all already in place here.
