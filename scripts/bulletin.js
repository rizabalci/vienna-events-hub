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
 *   DRY_RUN     'true' to print instead of sending
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');

const LANG = (process.env.LANG_MODE || 'en').toLowerCase() === 'de' ? 'de' : 'en';
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
  community:  { icon: '🌍', en: 'Community',    de: 'Community' },
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

// ── Community events (data/community.json) ────────────────────
function loadCommunity() {
  const file = path.join(ROOT, 'data', 'community.json');
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw.events || []);
    return list
      .filter(e => e && e.n && e.dt)
      .map((e, i) => Object.assign({ id: 90000 + i, c: 'community' }, e));
  } catch (err) {
    console.warn('community.json could not be read:', err.message);
    return [];
  }
}

// ── Date helpers ──────────────────────────────────────────────
function parseISO(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmtDate(date, lang) {
  const opts = { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' };
  // Only show the year when it isn't the current one, to avoid "27 Jun" meaning next year
  if (date.getUTCFullYear() !== new Date().getUTCFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString(lang === 'de' ? 'de-AT' : 'en-GB', opts);
}

// ── Telegram-safe escaping (HTML parse mode) ──────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Bucket events into time horizons ──────────────────────────
// Anything running longer than this is treated as "continuous" rather than
// an event that happens on a day, so exhibitions don't swamp the daily lists.
const LONG_RUN_DAYS = 14;

function bucket(events, today) {
  const day = 86400000;
  const weekEnd  = new Date(today.getTime() + 7 * day);
  const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  const horizon  = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 4, 0));

  const out = { today: [], week: [], month: [], later: [], ongoing: [] };

  for (const ev of events) {
    if (!ev || !ev.dt) continue;
    const s = parseISO(ev.dt);
    const e = ev.de ? parseISO(ev.de) : s;
    if (isNaN(s) || isNaN(e)) continue;
    if (e < today) continue;                 // already finished
    if (s > horizon) continue;               // beyond the 3-month horizon

    const runsFor = Math.round((e - s) / day) + 1;

    // Long runs that are already under way are "continuous"
    if (runsFor > LONG_RUN_DAYS && s <= today) { out.ongoing.push(ev); continue; }

    if (s <= today && e >= today) out.today.push(ev);
    else if (s <= weekEnd)        out.week.push(ev);
    else if (s <= monthEnd)       out.month.push(ev);
    else                          out.later.push(ev);
  }

  const byDate = (a, b) => {
    const d = parseISO(a.dt) - parseISO(b.dt);
    return d !== 0 ? d : String(a.n).localeCompare(String(b.n));
  };
  const byEnd = (a, b) => {
    const ae = a.de ? parseISO(a.de) : parseISO(a.dt);
    const be = b.de ? parseISO(b.de) : parseISO(b.dt);
    return ae - be;   // soonest to close first — the ones worth catching
  };

  for (const k of ['today', 'week', 'month', 'later']) out[k].sort(byDate);
  out.ongoing.sort(byEnd);
  return out;
}

// ── Build the message ─────────────────────────────────────────
// ── Links ─────────────────────────────────────────────────────
function infoUrl(ev) {
  if (ev.u) {
    const u = String(ev.u).trim();
    if (/^https?:\/\//i.test(u)) return u;
    return 'https://' + u.replace(/^\/+/, '');
  }
  return searchUrl(ev);
}

// Ticket search — works for any event without needing a per-event ticket URL
function searchUrl(ev) {
  const name = String(ev.n || '');
  const venue = String(ev.v || '');
  // Don't repeat the venue if the title already contains it
  const needsVenue = venue && !name.toLowerCase().includes(venue.toLowerCase());
  const q = encodeURIComponent(`${name}${needsVenue ? ' ' + venue : ''} Wien tickets`.trim());
  return `https://www.google.com/search?q=${q}`;
}

// ── Rendering ─────────────────────────────────────────────────
const CAPS = { today: 15, week: 25, month: 25, later: 20, ongoing: 12 };

function evLine(ev, lang, showDate) {
  const bits = [];
  if (showDate) {
    const d = fmtDate(parseISO(ev.dt), lang);
    const multi = ev.de && ev.de !== ev.dt ? ` → ${fmtDate(parseISO(ev.de), lang)}` : '';
    bits.push(`<b>${esc(d + multi)}</b>`);
  }
  const name = `<a href="${esc(infoUrl(ev))}">${esc(ev.n)}</a>`;
  const head = bits.length ? `  ${bits[0]}  ${name}` : `  • ${name}`;

  const sub = [];
  if (ev.v) sub.push(esc(ev.v));
  if (ev.p) sub.push(esc(ev.p));
  sub.push(`<a href="${esc(searchUrl(ev))}">🎫</a>`);
  return `${head}\n     <i>${sub.join(' · ')}</i>`;
}

function section(list, title, lang, cap, showDate = true) {
  if (!list.length) return [];
  const parts = [`${title} <b>(${list.length})</b>`];

  // Group by category so long sections stay readable
  if (list.length > 6) {
    const groups = new Map();
    for (const ev of list) {
      const k = CATS[ev.c] ? ev.c : 'other';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(ev);
    }
    let shown = 0;
    for (const k of Object.keys(CATS).filter(x => groups.has(x))) {
      if (shown >= cap) break;
      const g = groups.get(k);
      parts.push(`\n${CATS[k].icon} <i>${esc(CATS[k][lang])}</i>`);
      for (const ev of g) {
        if (shown >= cap) break;
        parts.push(evLine(ev, lang, showDate));
        shown++;
      }
    }
    if (list.length > shown) {
      const rest = list.length - shown;
      parts.push(lang === 'de' ? `  <i>… und ${rest} weitere</i>` : `  <i>… and ${rest} more</i>`);
    }
  } else {
    for (const ev of list.slice(0, cap)) parts.push(evLine(ev, lang, showDate));
  }
  parts.push('');
  return parts;
}

function ongoingLine(ev, lang) {
  const word = lang === 'de' ? 'bis' : 'until';
  const until = ev.de ? ` <i>(${word} ${fmtDate(parseISO(ev.de), lang)})</i>` : '';
  const name = `<a href="${esc(infoUrl(ev))}">${esc(ev.n)}</a>`;
  const venue = ev.v ? ` <i>· ${esc(ev.v)}</i>` : '';
  return `  • ${name}${until}${venue}`;
}

function buildMessage(b, today, lang) {
  const L = lang === 'de' ? {
    head: '🎪 <b>Wien Events</b>', today: '🔴 <b>HEUTE</b>', week: '📅 <b>DIESE WOCHE</b>',
    month: '🗓 <b>DIESEN MONAT</b>', later: '📆 <b>NÄCHSTE 3 MONATE</b>',
    ongoing: '♾ <b>LÄUFT DURCHGEHEND</b>', none: 'Keine Events gefunden.',
    tip: 'Namen antippen für Infos · 🎫 für Tickets', more: n => `  <i>… und ${n} weitere</i>`
  } : {
    head: '🎪 <b>Vienna Events</b>', today: '🔴 <b>TODAY</b>', week: '📅 <b>THIS WEEK</b>',
    month: '🗓 <b>THIS MONTH</b>', later: '📆 <b>NEXT 3 MONTHS</b>',
    ongoing: '♾ <b>RUNNING CONTINUOUSLY</b>', none: 'No events found.',
    tip: 'Tap a name for info · 🎫 for tickets', more: n => `  <i>… and ${n} more</i>`
  };

  const total = b.today.length + b.week.length + b.month.length + b.later.length + b.ongoing.length;
  const parts = [`${L.head}  <i>${esc(fmtDate(today, lang))}</i>`, `<i>${L.tip}</i>`, ''];

  if (!total) {
    parts.push(L.none, '', '🔗 https://rizabalci.github.io/vienna-events-hub/');
    return parts.join('\n');
  }

  parts.push(...section(b.today, L.today, lang, CAPS.today, false));
  parts.push(...section(b.week,  L.week,  lang, CAPS.week));
  parts.push(...section(b.month, L.month, lang, CAPS.month));
  parts.push(...section(b.later, L.later, lang, CAPS.later));

  if (b.ongoing.length) {
    parts.push(`${L.ongoing} <b>(${b.ongoing.length})</b>`);
    for (const ev of b.ongoing.slice(0, CAPS.ongoing)) parts.push(ongoingLine(ev, lang));
    if (b.ongoing.length > CAPS.ongoing) parts.push(L.more(b.ongoing.length - CAPS.ongoing));
    parts.push('');
  }

  parts.push('🔗 https://rizabalci.github.io/vienna-events-hub/');
  return parts.join('\n');
}

// ── Telegram delivery (splits over the 4096-char limit) ───────
function describe(err) {
  const bits = [err.message];
  let c = err.cause;
  let depth = 0;
  while (c && depth < 4) {
    bits.push(`cause: ${c.code || c.name || ''} ${c.message || ''}`.trim());
    c = c.cause;
    depth++;
  }
  return bits.filter(Boolean).join(' | ');
}

async function tgCall(token, method, payload, attempt = 1) {
  const MAX = 3;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000)
    });
    const body = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!body.ok) {
      throw new Error(`Telegram API rejected ${method}: ${body.description || JSON.stringify(body)}`);
    }
    return body;
  } catch (err) {
    // Retry only on transport-level failures, not on API rejections
    const transport = !/Telegram API rejected/.test(err.message);
    if (transport && attempt < MAX) {
      const wait = attempt * 2000;
      console.warn(`${method} attempt ${attempt} failed (${describe(err)}). Retrying in ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait));
      return tgCall(token, method, payload, attempt + 1);
    }
    throw err;
  }
}

async function send(text) {
  // Trim: a stray newline or space pasted into a GitHub secret breaks the URL
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chat = (process.env.TELEGRAM_CHAT_ID || '').trim();

  if (DRY_RUN) {
    console.log('--- DRY RUN ---\n');
    console.log(text);
    console.log(`\n--- length: ${text.length} chars ---`);
    return;
  }
  if (!token || !chat) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set');
  }
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('TELEGRAM_BOT_TOKEN does not look like a valid token ' +
      '(expected digits, a colon, then letters/digits). Check for extra spaces or a truncated paste.');
  }

  // Preflight: confirms both the network path and the token itself
  const me = await tgCall(token, 'getMe', {});
  console.log(`Authenticated as @${me.result.username}`);

  // Telegram's 4096 limit applies to the visible text, not the HTML markup,
  // so measure with tags stripped. Splitting only on newlines keeps every
  // tag pair intact within a chunk.
  const visibleLen = s => s.replace(/<[^>]+>/g, '').length;
  const RAW_LIMIT = 9000;      // hard ceiling on payload size
  const VIS_LIMIT = 3500;      // safety margin under Telegram's 4096

  const chunks = [];
  let buf = '';
  for (const line of text.split('\n')) {
    const next = buf ? buf + '\n' + line : line;
    if (buf && (visibleLen(next) > VIS_LIMIT || next.length > RAW_LIMIT)) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = next;
    }
  }
  if (buf) chunks.push(buf);

  for (const [idx, chunk] of chunks.entries()) {
    await tgCall(token, 'sendMessage', {
      chat_id: chat,
      text: chunk,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    console.log(`Sent chunk ${idx + 1}/${chunks.length}`);
    if (idx < chunks.length - 1) await new Promise(r => setTimeout(r, 400));
  }
}

// ── Main ──────────────────────────────────────────────────────
(async () => {
  try {
    const events = loadEvents();
    const community = loadCommunity();
    console.log(`Loaded ${events.length} events from index.html` +
      (community.length ? ` + ${community.length} community events` : ''));
    const all = events.concat(community);

    // Today at UTC midnight, or an override for testing
    let today;
    if (process.env.START_DATE) {
      today = parseISO(process.env.START_DATE);
      console.log(`Using START_DATE override: ${process.env.START_DATE}`);
    } else {
      const n = new Date();
      today = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
    }

    const b = bucket(all, today);
    console.log(`today:${b.today.length} week:${b.week.length} month:${b.month.length} ` +
      `next3mo:${b.later.length} ongoing:${b.ongoing.length}`);

    await send(buildMessage(b, today, LANG));
    console.log('Done.');
  } catch (err) {
    console.error('Failed:', describe(err));
    process.exit(1);
  }
})();
