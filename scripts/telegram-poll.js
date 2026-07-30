#!/usr/bin/env node
/**
 * Telegram command poller — lets the bot respond to "check".
 *
 * Runs every 10 minutes via GitHub Actions. Reads new messages in the chat
 * (getUpdates with a persisted offset), and when one says "check" (also
 * /check, "scan", "new"), acknowledges and runs feedwatch.js, which replies
 * with the sectioned list of new finds — or a "nothing new" note.
 *
 * Only messages from TELEGRAM_CHAT_ID are honored.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OFFSET_FILE = path.join(ROOT, 'data/tg-offset.json');

const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const chat = (process.env.TELEGRAM_CHAT_ID || '').trim();
if (!token || !chat) {
  console.log('No Telegram secrets — nothing to poll.');
  process.exit(0);
}

const readOffset = () => {
  try { return JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8')).offset || 0; }
  catch (e) { return 0; }
};

async function api(method, params) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
    signal: AbortSignal.timeout(20000)
  });
  return res.json();
}

(async () => {
  const offset = readOffset();
  const upd = await api('getUpdates', {
    offset: offset + 1, timeout: 0, allowed_updates: ['message']
  });
  if (!upd.ok) { console.error('getUpdates failed:', JSON.stringify(upd).slice(0, 200)); process.exit(0); }

  const updates = upd.result || [];
  console.log(`Updates since offset ${offset}: ${updates.length}`);
  if (!updates.length) return;

  let maxId = offset;
  let commandSeen = false;
  for (const u of updates) {
    maxId = Math.max(maxId, u.update_id);
    const m = u.message;
    if (!m || String(m.chat && m.chat.id) !== chat) continue;
    const text = (m.text || '').trim();
    if (/^\/?(check|scan|new)\b/i.test(text)) {
      commandSeen = true;
      console.log(`Command received: "${text}"`);
    }
  }

  // Persist offset first so a crash never replays old commands
  fs.writeFileSync(OFFSET_FILE, JSON.stringify({ offset: maxId }) + '\n');

  if (!commandSeen) return;

  await api('sendMessage', {
    chat_id: chat, text: '🔎 Checking for new events…', disable_notification: true
  });

  execSync('node ' + path.join(__dirname, 'feedwatch.js'), {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { FEEDWATCH_NOTIFY_EMPTY: 'true' })
  });
})().catch(err => { console.error('Poller failed:', err.message); process.exit(0); });
