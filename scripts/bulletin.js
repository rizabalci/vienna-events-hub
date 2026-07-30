#!/usr/bin/env node
/**
 * Vienna Events Hub — Weekly Telegram Bulletin
 *
 * Parses the EV array out of index.html, selects events happening in the
 * next 7 days, and posts a formatted digest to Telegram.
 *
 * Env vars required:
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 * Optional:
 *   LANG_MODE   'en' (default) or 'de'
 *   DAYS_AHEAD  number of days to look forward (default 7)
 *   DRY_RUN     'true' to print instead of sending
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');

const LANG = (process.env.LANG_MODE || 'en').toLowerCase() === 'de' ? 'de' : 'en';
const DAYS_AHEAD = parseInt(process.env.DAYS_AHEAD || '7', 10);
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

// ── Category labels & icons ───────────────────────────────────
const CATS = {
  concert:    { icon: '🎵', en: 'Concerts',     de: 'Konzerte' },
  classical:  { icon: '🎻', en: 'Classical',    de: 'Klassik' },
  jazz:       { icon: '🎷', en: 'Jazz',         de: 'Jazz' },
  opera:      { icon: '🎭', en: 'Opera',        de: 'Oper' },
  musical:    { icon: '🎤', en: 'Musicals',     de: 'Musicals' },
  theater:    { icon: '🎬', en: 'Theater',      de: 'Theater' },
  kabarett:   { icon: '😂', en: 'Kabarett',     de: 'Kabarett' },
  exhibition: { icon: '🖼', en: 'Exhibitions',  de: 'Ausstellungen' },
  ball:       { icon: '💃', en: 'Balls',        de: 'Bälle' },
  special:    { icon: '✨', en: 'Special',      de: 'Specials' },
  sport:      { icon: '⚽️', en: 'Sport',        de: 'Sport' },
  market:     { icon: '🛍', en: 'Markets',      de: 'Märkte' },
  film:       { icon: '🎞', en: 'Film',         de: 'Film' },
  food:       { icon: '🍽', en: 'Food & Drink', de: 'Essen & Trinken' },
  other:      { icon: '📌', en: 'Other',        de: 'Sonstiges' }
};

// ── Extract the EV array from index.html ──────────────────────
function loadEvents() {
  const src = fs.readFileSync(HTML, 'utf8');

  const start = src.indexOf('var EV=[');
  if (start === -1) throw new Error('Could not find "var EV=[" in index.html');

  // Walk forward from the opening bracket, tracking depth and skipping
  // over string literals so brackets inside descriptions do not confuse us.
  const open = src.indexOf('[', start);
  let depth = 0, i = open, quote = null, end = -1;

  for (; i < src.length; i++) {
    const ch = src[i];
    const prev = src[i - 1];

    if (quote) {
      if (ch === quote && prev !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error('Unbalanced EV array in index.html');

  const literal = src.slice(open, end + 1);
  // The array is plain JS object-literal syntax, so evaluate it directly.
  const events = new Function('return ' + literal + ';')();
  if (!Array.isArray(events)) throw new Error('EV did not evaluate to an array');
  return events;
}

// ── Date helpers ──────────────────────────────────────────────
function parseISO(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmtDate(date, lang) {
  return date.toLocaleDateString(lang === 'de' ? 'de-AT' : 'en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'
  });
}

// ── Telegram-safe escaping (HTML parse mode) ──────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Select events in the window ───────────────────────────────
function selectWindow(events, from, days) {
  const to = new Date(from.getTime() + days * 86400000);
  const byDate = (a, b) => {
    const d = parseISO(a.dt) - parseISO(b.dt);
    return d !== 0 ? d : String(a.n).localeCompare(String(b.n));
  };

  const starting = [];  // kicks off during the window — the real news
  const ongoing = [];   // already running, still catchable

  for (const ev of events) {
    if (!ev || !ev.dt) continue;
    const startD = parseISO(ev.dt);
    const endD = ev.de ? parseISO(ev.de) : startD;
    if (isNaN(startD) || isNaN(endD)) continue;
    if (endD < from || startD >= to) continue;   // outside the window

    if (startD >= from) starting.push(ev);
    else ongoing.push(ev);
  }

  return { starting: starting.sort(byDate), ongoing: ongoing.sort(byDate) };
}

// ── Build the message ─────────────────────────────────────────
const PER_CAT = 6;   // max events listed per category before collapsing

function line(ev, lang) {
  const d = fmtDate(parseISO(ev.dt), lang);
  const multi = ev.de && ev.de !== ev.dt ? ` → ${fmtDate(parseISO(ev.de), lang)}` : '';
  const bits = [];
  if (ev.v) bits.push(esc(ev.v));
  if (ev.p) bits.push(esc(ev.p));
  const sub = bits.length ? `\n     <i>${bits.join(' · ')}</i>` : '';
  return `  <b>${esc(d + multi)}</b>  ${esc(ev.n)}${sub}`;
}

function groupByCat(list) {
  const groups = new Map();
  for (const ev of list) {
    const key = CATS[ev.c] ? ev.c : 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }
  return groups;
}

function buildMessage({ starting, ongoing }, from, days, lang) {
  const to = new Date(from.getTime() + (days - 1) * 86400000);
  const range = `${fmtDate(from, lang)} – ${fmtDate(to, lang)}`;

  const head = lang === 'de'
    ? `<b>🎪 Wien Events — Woche im Überblick</b>\n<i>${esc(range)}</i>`
    : `<b>🎪 Vienna Events — Week Ahead</b>\n<i>${esc(range)}</i>`;

  if (!starting.length && !ongoing.length) {
    const none = lang === 'de'
      ? 'Keine Events in diesem Zeitraum. Zeit, den Kalender aufzufüllen.'
      : 'No events in this window. Time to top up the calendar.';
    return `${head}\n\n${none}\n\n🔗 https://rizabalci.github.io/vienna-events-hub/`;
  }

  const parts = [head, ''];
  const groups = groupByCat(starting);

  parts.push(lang === 'de'
    ? `<b>${starting.length}</b> neue Events in <b>${groups.size}</b> Kategorien\n`
    : `<b>${starting.length}</b> events starting across <b>${groups.size}</b> categories\n`);

  for (const key of Object.keys(CATS).filter(k => groups.has(k))) {
    const meta = CATS[key];
    const list = groups.get(key);
    parts.push(`${meta.icon} <b>${esc(meta[lang])}</b> (${list.length})`);
    for (const ev of list.slice(0, PER_CAT)) parts.push(line(ev, lang));
    if (list.length > PER_CAT) {
      const rest = list.length - PER_CAT;
      parts.push(lang === 'de' ? `  <i>… und ${rest} weitere</i>` : `  <i>… and ${rest} more</i>`);
    }
    parts.push('');
  }

  // Ongoing: compact one-liners, no venue/price clutter
  if (ongoing.length) {
    parts.push(lang === 'de' ? '<b>▪️ Läuft bereits</b>' : '<b>▪️ Already running</b>');
    for (const ev of ongoing.slice(0, 10)) {
      const word = lang === 'de' ? 'bis' : 'until';
      const until = ev.de ? ` <i>(${word} ${fmtDate(parseISO(ev.de), lang)})</i>` : '';
      parts.push(`  • ${esc(ev.n)}${until}`);
    }
    if (ongoing.length > 10) {
      const rest = ongoing.length - 10;
      parts.push(lang === 'de' ? `  <i>… und ${rest} weitere</i>` : `  <i>… and ${rest} more</i>`);
    }
    parts.push('');
  }

  parts.push('🔗 https://rizabalci.github.io/vienna-events-hub/');
  return parts.join('\n');
}

// ── Telegram delivery (splits over the 4096-char limit) ───────
async function send(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;

  if (DRY_RUN) {
    console.log('--- DRY RUN ---\n');
    console.log(text);
    console.log(`\n--- length: ${text.length} chars ---`);
    return;
  }
  if (!token || !chat) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set');
  }

  const chunks = [];
  const LIMIT = 3800;
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > LIMIT) { chunks.push(buf); buf = ''; }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) chunks.push(buf);

  for (const [idx, chunk] of chunks.entries()) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text: chunk,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    const body = await res.json();
    if (!body.ok) throw new Error(`Telegram error: ${JSON.stringify(body)}`);
    console.log(`Sent chunk ${idx + 1}/${chunks.length}`);
    if (idx < chunks.length - 1) await new Promise(r => setTimeout(r, 400));
  }
}

// ── Main ──────────────────────────────────────────────────────
(async () => {
  try {
    const events = loadEvents();
    console.log(`Loaded ${events.length} events from index.html`);

    // Today at UTC midnight, or an override for testing
    let today;
    if (process.env.START_DATE) {
      today = parseISO(process.env.START_DATE);
      console.log(`Using START_DATE override: ${process.env.START_DATE}`);
    } else {
      const n = new Date();
      today = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
    }

    const picked = selectWindow(events, today, DAYS_AHEAD);
    console.log(`${picked.starting.length} starting, ${picked.ongoing.length} ongoing over the next ${DAYS_AHEAD} days`);

    await send(buildMessage(picked, today, DAYS_AHEAD, LANG));
    console.log('Done.');
  } catch (err) {
    console.error('Failed:', err.message);
    process.exit(1);
  }
})();
