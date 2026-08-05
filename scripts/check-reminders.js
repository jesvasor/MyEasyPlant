#!/usr/bin/env node
/**
 * Reminder check — run daily by .github/workflows/reminders.yml.
 *
 * Sends (via workflow outputs) at most one email every `settings.reminderEveryDays`
 * days while at least one plant is overdue. Plants stay "overdue" until marked
 * watered on the dashboard, so reminders repeat until you actually water them.
 *
 * Outputs (GITHUB_OUTPUT): send=true|false, subject=...
 * Side effects: writes email.html, and updates settings.lastReminderSent in
 * data/plants.json when send=true (the workflow commits it).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'plants.json');

// Keep in sync with app.js (browser side).
function addMonthsClamped(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, lastDay));
  return t.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const today = new Date().toISOString().slice(0, 10);

function out(k, v) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
  console.log(`output: ${k}=${v}`);
}

const store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const settings = store.settings || {};
const cadence = Number(settings.reminderEveryDays) || 3;

const overdue = store.plants
  .map((p) => {
    if (!p.lastWatered || !p.waterEveryMonths) return null;
    const next = addMonthsClamped(p.lastWatered, p.waterEveryMonths);
    const daysOver = daysBetween(next, today);
    return daysOver >= 0 ? { p, next, daysOver } : null;
  })
  .filter(Boolean)
  .sort((a, b) => b.daysOver - a.daysOver);

console.log(`${store.plants.length} plants, ${overdue.length} overdue (cadence: every ${cadence} days)`);

if (overdue.length === 0) {
  out('send', 'false');
  process.exit(0);
}

const sinceLast = settings.lastReminderSent ? daysBetween(settings.lastReminderSent, today) : Infinity;
if (sinceLast < cadence) {
  console.log(`last reminder ${settings.lastReminderSent} (${sinceLast}d ago) — waiting for cadence`);
  out('send', 'false');
  process.exit(0);
}

// Dashboard URL from the repo this runs in: owner/repo -> https://owner.github.io/repo/
const [owner, repo] = (process.env.GITHUB_REPOSITORY || 'user/MyEasyPlant').split('/');
const dashUrl = `https://${owner}.github.io/${repo}/`;

const fmt = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

const rows = overdue
  .map(
    ({ p, next, daysOver }) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e4e8e2;">
        <strong>${p.name}</strong>${p.size ? ' (' + p.size + ')' : ''}<br/>
        <span style="color:#66756c;font-size:13px;">water every ${p.waterEveryMonths} month${p.waterEveryMonths > 1 ? 's' : ''} · last watered ${fmt(p.lastWatered)}</span>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #e4e8e2;text-align:right;white-space:nowrap;">
        <span style="color:#b3362b;font-weight:bold;">${daysOver === 0 ? 'due today' : daysOver + 'd overdue'}</span><br/>
        <span style="color:#66756c;font-size:13px;">was due ${fmt(next)}</span>
      </td>
    </tr>`
  )
  .join('');

const html = `<!doctype html>
<meta charset="utf-8" />
<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#24312a;">
  <h2 style="color:#2e7d4f;">🌿 ${overdue.length} plant${overdue.length > 1 ? 's need' : ' needs'} water</h2>
  <table style="border-collapse:collapse;width:100%;background:#fff;border:1px solid #e4e8e2;border-radius:8px;">
    ${rows}
  </table>
  <p style="margin:20px 0;">
    <a href="${dashUrl}" style="background:#2e7d4f;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;">Open the dashboard</a>
  </p>
  <p style="color:#66756c;font-size:13px;">Mark them watered on the dashboard and the reminders stop.
  You get at most one of these every ${cadence} day${cadence > 1 ? 's' : ''} (change it in the dashboard settings).</p>
</div>`;

fs.writeFileSync(path.join(ROOT, 'email.html'), html);

// Stamp lastReminderSent so the cadence holds; the workflow commits this.
settings.lastReminderSent = today;
store.settings = settings;
fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2) + '\n');

const names = overdue.map((o) => o.p.name).join(', ');
out('send', 'true');
out('subject', `🌿 Time to water: ${names.length > 60 ? overdue.length + ' plants' : names}`);
