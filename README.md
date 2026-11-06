# CloudForge — Admin (owner) version

Your owner console. Every customer project lives on **your Oracle cloud** (the "workshop").
From here you have **full control**: add projects, store each customer's VPS / domain /
containers, generate the access code they use in their client app, mark whether their AI
API key is connected, edit the AI rules, run commands on their VPS, and deploy.

> This is **v0.1** — the admin version. The locked-down **client version** (what the
> customer sees) comes next and will reuse the same engine.

## Run it

```
npm install
npm start
```
or double-click **Start.bat**.

## What each part does

- **Dashboard** — counts: projects, AI keys connected, access codes issued, domains set; recent projects.
- **Projects** — add / edit / open each customer project.
- **Project detail**
  - **Deploy** — two buttons:
    - 🟢 **Deploy Full Website** → runs your "full" command (frontend + backend + admin + server).
    - 🔵 **Deploy Containers** → runs your "containers" command (backend + admin + server only).
    - A **backup command** (if set) runs first. Live output shows in the console.
  - **Admin console** — run any command on the customer VPS over SSH (owner-only, full control).
  - **Customer access** — generate / copy the **access code** the customer enters in their client app; toggle whether their **AI API key** is connected.
  - **Connection** — VPS host / user / auth / source path / domain; **Test connection** button.
  - **Project rules** — the AI guide for *this* project (what the AI may / may not touch).
- **Global Rules** — rules given to **every** customer's AI (your safety net).
- **Settings** — version + data location.

## How the deploy commands work

You host the code; the deploy command runs **on the customer's VPS** and pulls/builds the
latest. Fill these per project (examples shown as placeholders in the form):

- **Full:** `cd /path && git pull && docker compose up -d --build`
- **Containers:** `cd /path && git pull && docker compose up -d --build backend admin server`
- **Backup (optional):** `cd /path && tar czf ../backup-$(date +%F-%H%M).tgz .`

Because they're configurable per project, CloudForge fits whatever pipeline each client uses.

## Data & security (v0.1)

- All data is stored locally in your user app-data folder (`cloudforge-data.json`).
- VPS passwords / keys are stored in that file **unencrypted** for now — keep this PC secure.
  Encrypting the stored credentials is the first hardening step for v0.2.

## Tests

```
npm test
```

Covers the data store (create / update / delete / persistence) and the access-code format.
