# 🌿 MyEasyPlant

Personal watering dashboard for plants bought from [easyplant.com](https://easyplant.com).
Shows every plant you own with its photo, last/next watering date, and the full
care instructions — **saved locally at add-time**, so records survive even after
easyplant removes a product page.

- **Hosted free on GitHub Pages** — works from desktop and phone, no home server.
- **Data lives in this repo** (`data/plants.json` + `data/images/`) — every change
  is a commit, so git history is the backup.
- **Email reminders** while any plant is overdue, at a configurable cadence
  (default: at most one email every 3 days), until you mark the plant watered.

## How it works

| Piece | Role |
| --- | --- |
| `index.html` / `app.js` / `style.css` | Static dashboard, served by GitHub Pages from the repo root. Reads `data/plants.json` through the GitHub API (always fresh, no Pages-rebuild lag) and writes through it too (mark watered, settings, remove plant). |
| `data/plants.json` | All plant records + settings (`reminderEveryDays`, `lastReminderSent`). |
| `data/images/` | The product photo of each plant in the exact pot/color bought. |
| `scripts/scrape.js` | Fetches an easyplant product URL and extracts name, size, pot, color, price, watering period, light/care/humidity/toxicity/FAQ details and the photo. |
| `.github/workflows/add-plant.yml` | Triggered from the dashboard's "＋ Add plant" (workflow_dispatch): runs the scraper and commits the result. |
| `.github/workflows/reminders.yml` | Daily cron. `scripts/check-reminders.js` decides whether to email: only when ≥1 plant is overdue **and** the cadence has elapsed since the last reminder. Sends via Gmail SMTP. |

Watering math: `nextWater = lastWatered + waterEveryMonths` (day-clamped).
A plant counts as overdue from its due date until you mark it watered.

## One-time setup

1. **Create the GitHub repo** (public — required for free Pages + unlimited
   Actions minutes) and push this folder to `main`.
2. **Enable Pages**: repo → Settings → Pages → Deploy from branch → `main` / `/ (root)`.
   The dashboard will be at `https://<user>.github.io/MyEasyPlant/`.
3. **Fine-grained PAT** (once per device you use the dashboard from):
   GitHub → Settings → Developer settings → Fine-grained tokens → Generate:
   - Repository access: only this repo.
   - Permissions: **Contents: Read & write**, **Actions: Read & write**.
   Paste it in the dashboard's ⚙️ Settings. It is stored only in that browser's
   localStorage.
4. **Gmail app password** for reminder emails (repo → Settings → Secrets and
   variables → Actions → New repository secret):
   - `GMAIL_USERNAME` — your Gmail address.
   - `GMAIL_APP_PASSWORD` — create at <https://myaccount.google.com/apppasswords>
     (requires 2-step verification on the Google account).
5. Optional sanity check: Actions tab → "Watering reminders" → Run workflow.

## Daily use

- **Add a plant**: on easyplant.com open the product, select the pot & color you
  bought, copy the URL, paste it into "＋ Add plant". ~1 minute later the card
  appears with everything saved.
  - CLI alternative (also the fallback if easyplant ever blocks GitHub's
    servers): `node scripts/scrape.js "<url>" --last-watered 2026-08-01`,
    then commit & push.
- **Water a plant**: tap "💧 Watered today" (or "on a date…"). The next-water
  date recomputes and reminders stop.
- **Settings ⚙️**: reminder cadence (days between emails while overdue) and the
  device's GitHub token.

## Local development

Serve the repo root with any static server, e.g. `python -m http.server 8021`,
then open <http://localhost:8021>. Locally the app reads `data/plants.json`
directly; writes require the GitHub token and go to the repo (the deployed
data), so for pure local testing edit the JSON by hand.
