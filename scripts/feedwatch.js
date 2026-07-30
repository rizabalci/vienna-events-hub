#!/usr/bin/env node
/**
 * Feed Watch — weekly discovery of new Vienna events from structured sources.
 *
 * What it does:
 *   1. Fetches configured sources (currently Songkick's Vienna metro pages,
 *      the richest reliable structured source; the architecture also supports
 *      iCal feeds for when venues publish usable ones).
 *   2. Dedupes findings against the main database (index.html), community.json,
 *      pending.json and everything previously offered (feed-seen.json).
 *   3. Appends genuinely new events to data/pending.json — an inbox for review.
 *      NOTHING enters the live database automatically.
 *   4. Sends a Telegram summary so review can happen from the phone.
 *
 * Review flow: open data/pending.json on GitHub (pencil icon), copy entries
 * you want into data/community.json, delete the rest. Entries are already in
 * community.json format.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID  for the notification (optional)
 *   DRY_RUN='true'   print instead of writing files or sending Telegram
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DRY = process.env.DRY_RUN === 'true';
const TODAY = new Date().toISOString().slice(0, 10);

// ── Sources ───────────────────────────────────────────────────
function monthSlug(offset) {
  const d = new Date();
  d.setMonth(d.getMonth() + offset);
  const names = ['january','february','march','april','may','june',
    'july','august','september','october','november','december'];
  return `${names[d.getMonth()]}-${d.getFullYear()}`;
}

const SOURCES = [
  { type: 'songkick', name: 'Songkick Vienna (upcoming)',
    url: 'https://www.songkick.com/metro-areas/26771-austria-vienna' },
  { type: 'songkick', name: 'Songkick Vienna (+1 month)',
    url: `https://www.songkick.com/metro-areas/26771-austria-vienna/${monthSlug(1)}` },
  { type: 'songkick', name: 'Songkick Vienna (+2 months)',
    url: `https://www.songkick.com/metro-areas/26771-austria-vienna/${monthSlug(2)}` },

  // ── Meetup groups ────────────────────────────────────────────
  // Every Meetup group has an iCal feed: meetup.com/GROUP-SLUG/events/ical/
  // The slug is the part of the group's URL after meetup.com/.
  // Add one line per group you follow; cat:'community' routes finds to the
  // 🌍 Community section. Verified working example:
  { type: 'ical', name: 'Meetup: Vienna Hiking Group', cat: 'community',
    url: 'https://www.meetup.com/vienna-hiking-group/events/ical/' }
  // { type: 'ical', name: 'Meetup: YOUR GROUP', cat: 'community',
  //   url: 'https://www.meetup.com/YOUR-GROUP-SLUG/events/ical/' },
];

// ── Fetch with retry ──────────────────────────────────────────
async function fetchText(url) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        signal: AbortSignal.timeout(25000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ── Parsers ───────────────────────────────────────────────────
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();
}

function parseSongkick(html) {
  const out = [];
  const blocks = html.split('event-listings-element').slice(1);
  for (const block of blocks) {
    const chunk = block.slice(0, 3000);
    const dt = (chunk.match(/datetime="(\d{4}-\d{2}-\d{2})/) || [])[1];
    const link = (chunk.match(/href="(\/(?:concerts|festivals)\/[^"]+)"/) || [])[1];
    const name = (chunk.match(/<strong>([^<]+)<\/strong>/) || [])[1];
    const venue = (chunk.match(/href="\/venues\/\d+[^"]*"[^>]*>([^<]+)</) || [])[1];
    if (!dt || !link || !name) continue;
    out.push({
      n: decodeEntities(name),
      dt,
      v: venue ? decodeEntities(venue) : '',
      c: 'concert',
      p: '',
      u: 'songkick.com',
      eu: 'https://www.songkick.com' + link.split('"')[0],
      desc: { en: '', de: '' },
      t: ['feed', 'songkick']
    });
  }
  return out;
}

function parseICalSource(text) {
  // Minimal VEVENT extraction, future events only
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const out = [];
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0];
    const get = p => (body.match(new RegExp('^' + p + '(?:;[^:\\n]*)?:(.*)$', 'mi')) || [])[1];
    const raw = get('DTSTART');
    const sum = get('SUMMARY');
    const m = raw && String(raw).match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m || !sum) continue;
    const dt = `${m[1]}-${m[2]}-${m[3]}`;
    if (dt < TODAY) continue;
    const url = get('URL');
    out.push({
      n: decodeEntities(sum.replace(/\\,/g, ',')), dt,
      v: decodeEntities((get('LOCATION') || '').replace(/\\,/g, ',')),
      c: 'concert', p: '', u: '',
      eu: url && /^https?:/.test(url) ? url.trim() : undefined,
      desc: { en: '', de: '' }, t: ['feed', 'ical']
    });
  }
  return out;
}

// ── Existing data ─────────────────────────────────────────────
function parseEV() {
  const s = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const o = s.indexOf('[', s.indexOf('var EV=['));
  let depth = 0, quote = null, end = -1;
  for (let i = o; i < s.length; i++) {
    const c = s[i], p = s[i - 1];
    if (quote) { if (c === quote && p !== '\\') quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (!depth) { end = i; break; } }
  }
  return new Function('return ' + s.slice(o, end + 1))();
}

function readJSON(rel, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
  catch (e) { return fallback; }
}

const normName = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
const keyOf = ev => normName(ev.n) + '|' + ev.dt;
const skId = ev => {
  if (!ev) return null;
  const m = String(ev.eu || '').match(/\/(?:concerts|id)\/(\d+)/);
  return m ? 'sk' + m[1] : null;
};

// ── Telegram ──────────────────────────────────────────────────
async function notify(lines) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chat = (process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chat) { console.log('(no Telegram secrets — skipping notification)'); return; }
  const text = lines.join('\n');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(20000)
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.error('Telegram send failed:', JSON.stringify(data).slice(0, 200));
  else console.log('Telegram notification sent.');
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Main ──────────────────────────────────────────────────────
(async () => {
  // 1. Gather candidates from all sources, tolerating individual failures
  let candidates = [];
  for (const src of SOURCES) {
    try {
      const text = await fetchText(src.url);
      const items = src.type === 'songkick' ? parseSongkick(text) : parseICalSource(text);
      console.log(`${src.name}: ${items.length} events`);
      candidates = candidates.concat(items.map(x =>
        Object.assign({ src: src.name }, x, src.cat ? { c: src.cat } : {})));
    } catch (err) {
      console.warn(`${src.name}: FAILED (${err.message}) — continuing`);
    }
  }
  // future events only, dedup within the batch (metro + month pages overlap)
  candidates = candidates.filter(x => x.dt >= TODAY);
  const inBatch = new Set();
  candidates = candidates.filter(x => {
    const k = skId(x) || keyOf(x);
    if (inBatch.has(k)) return false;
    inBatch.add(k); return true;
  });
  console.log(`Candidates after batch dedup: ${candidates.length}`);

  // Recurring series (church concerts etc. with many dates) collapse into one
  // entry spanning first to last date, so they can't flood the inbox weekly.
  const byName = {};
  for (const x of candidates) (byName[normName(x.n)] = byName[normName(x.n)] || []).push(x);
  candidates = Object.values(byName).map(group => {
    if (group.length < 3) return group;
    group.sort((a, b) => a.dt.localeCompare(b.dt));
    const rep = Object.assign({}, group[0], {
      de: group[group.length - 1].dt,
      t: group[0].t.concat('series'),
      _series: true
    });
    return [rep];
  }).flat();
  console.log(`After series collapse: ${candidates.length}`);

  // 2. Build the known-set from every existing store
  const known = new Set();
  for (const ev of parseEV()) {
    if (!ev || !ev.n) continue;
    if (ev.dt) known.add(keyOf(ev));
    const id = skId(ev); if (id) known.add(id);
    // artist-level guard: same artist within the DB regardless of exact date
    // (Songkick dates occasionally shift by a day vs ticket sites)
    known.add('artist|' + normName(ev.n.split('—')[0]));
  }
  const commRaw = readJSON('data/community.json', []);
  const commList = Array.isArray(commRaw) ? commRaw : (commRaw.events || []);
  for (const ev of commList) {
    if (ev && ev.n && ev.dt) known.add(keyOf(ev));
  }
  const pending = readJSON('data/pending.json', []);
  for (const ev of pending) {
    if (ev && ev.n && ev.dt) known.add(keyOf(ev));
    const id = skId(ev); if (id) known.add(id);
  }
  const seen = readJSON('data/feed-seen.json', []);
  const seenSet = new Set(seen);

  // 3. Filter to the genuinely new
  const fresh = candidates.filter(x => {
    const id = skId(x), k = keyOf(x), sk = 'series|' + normName(x.n);
    if (id && (known.has(id) || seenSet.has(id))) return false;
    if (known.has(k) || seenSet.has(k)) return false;
    if (seenSet.has(sk)) return false;
    if (known.has('artist|' + normName(x.n))) return false;
    return true;
  });
  console.log(`New events found: ${fresh.length}`);
  fresh.forEach(x => console.log(`  · ${x.dt}  ${x.n}  (${x.v || '?'})`));

  if (DRY) { console.log('\nDRY RUN — nothing written, nothing sent.'); return; }

  if (fresh.length) {
    // 4. Write pending inbox + remember fingerprints
    const nextPending = pending.concat(fresh.map(x => ({
      n: x.n, dt: x.dt, v: x.v, c: x.c, p: x.p, u: x.u, eu: x.eu,
      desc: x.desc, t: x.t, _src: x.src, _found: TODAY
    })));
    fs.writeFileSync(path.join(ROOT, 'data/pending.json'),
      JSON.stringify(nextPending, null, 1) + '\n');
    for (const x of fresh) {
      seenSet.add(skId(x) || keyOf(x));
      if (x._series) seenSet.add('series|' + normName(x.n));
    }
    fs.writeFileSync(path.join(ROOT, 'data/feed-seen.json'),
      JSON.stringify([...seenSet], null, 0) + '\n');
    console.log(`pending.json now holds ${nextPending.length} entries.`);
  }

  // 5. Notify
  const fmt = d => { const [y, m, dd] = d.split('-'); return `${dd}.${m}.`; };
  if (fresh.length) {
    const lines = [`🔎 <b>Feed Watch</b> — ${fresh.length} new event${fresh.length > 1 ? 's' : ''} found`, ''];
    for (const x of fresh.slice(0, 25)) {
      lines.push(`• ${fmt(x.dt)} <a href="${esc(x.eu)}">${esc(x.n)}</a>${x.v ? ' · ' + esc(x.v) : ''}`);
    }
    if (fresh.length > 25) lines.push(`… and ${fresh.length - 25} more in pending.json`);
    lines.push('', '📥 Review: <a href="https://github.com/rizabalci/vienna-events-hub/edit/main/data/pending.json">pending.json</a> → copy keepers into community.json, delete the rest.');
    await notify(lines);
  } else {
    console.log('Nothing new — no notification sent.');
  }
})().catch(err => { console.error('Feed watch failed:', err); process.exit(1); });
