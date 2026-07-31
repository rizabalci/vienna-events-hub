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
 *   MAX_PER_SECTION  cap events listed per section (default: no cap)
 *   CALENDAR_ICS_URL  private Google Calendar iCal address (optional)
 *   CALENDAR_ICS_FILE local .ics file path, for testing (optional)
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
  exhibition: { icon: '🖼', en: 'Museums & Exhibitions', de: 'Museen & Ausstellungen' },
  activity:   { icon: '🎳', en: 'Activities',   de: 'Aktivitäten' },
  tour:       { icon: '🚶', en: 'Tours',        de: 'Touren' },
  club:       { icon: '🤝', en: 'Clubs & Groups', de: 'Vereine & Gruppen' },
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

// ── Google Calendar iCal feed (RSVP'd events) ─────────────────
// Reads the private iCal URL from CALENDAR_ICS_URL (GitHub secret).
// Anything on that calendar — InterNations RSVPs, dance socials — appears
// in the bulletin under Community. Skipped silently when not configured.

function unfoldICS(text) {
  // Continuation lines start with a space or tab (RFC 5545 folding)
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeICS(v) {
  return String(v || '')
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function parseICSDate(raw) {
  // Forms: 20260813 | 20260813T180000 | 20260813T160000Z
  const m = String(raw).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
  if (!m) return null;
  return {
    date: `${m[1]}-${m[2]}-${m[3]}`,
    time: m[4] ? `${m[4]}:${m[5]}` : null,
    utc: /Z$/.test(raw)
  };
}

function parseICS(text) {
  const events = [];
  const blocks = unfoldICS(text).split('BEGIN:VEVENT').slice(1);

  for (const block of blocks) {
    const body = block.split('END:VEVENT')[0];
    const get = (prop) => {
      const m = body.match(new RegExp('^' + prop + '(?:;[^:\\n]*)?:(.*)$', 'mi'));
      return m ? m[1].trim() : null;
    };

    const summary = unescapeICS(get('SUMMARY'));
    const dtstartRaw = get('DTSTART');
    if (!summary || !dtstartRaw) continue;
    const start = parseICSDate(dtstartRaw);
    if (!start) continue;

    // DTEND for all-day events is exclusive per RFC — subtract one day.
    // Timed events ending early next morning (a party past midnight) are
    // one evening, not a two-day span.
    let endDate = null;
    const dtendRaw = get('DTEND');
    if (dtendRaw) {
      const end = parseICSDate(dtendRaw);
      if (end) {
        if (!end.time) {
          const d = parseISO(end.date);
          d.setUTCDate(d.getUTCDate() - 1);
          endDate = d.toISOString().slice(0, 10);
        } else {
          const overnight = end.date !== start.date && parseInt(end.time, 10) <= 6;
          endDate = overnight ? start.date : end.date;
        }
      }
    }
    if (endDate === start.date) endDate = null;

    // Google's UTC times shift the local hour; show date-only for those,
    // exact time only when the feed carries a floating/local time.
    const timeLabel = (start.time && !start.utc) ? start.time : null;

    const location = unescapeICS(get('LOCATION'));
    const url = get('URL');

    events.push({
      n: summary,
      dt: start.date,
      de: endDate || undefined,
      c: 'community',
      v: timeLabel ? (location ? `${timeLabel} · ${location}` : timeLabel) : (location || ''),
      p: '',
      u: url || '',
      eu: url && /^https?:\/\//i.test(url) ? url.trim() : undefined,
      desc: { en: '', de: '' },
      t: ['calendar', 'rsvp']
    });
  }
  return events;
}

async function loadCalendar() {
  const file = process.env.CALENDAR_ICS_FILE;          // local testing
  const url = (process.env.CALENDAR_ICS_URL || '').trim();

  let text = null;
  try {
    if (file && fs.existsSync(file)) {
      text = fs.readFileSync(file, 'utf8');
    } else if (url) {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    }
  } catch (err) {
    // Calendar problems must never kill the bulletin
    console.warn('Calendar feed could not be read:', err.message);
    return [];
  }
  if (!text || !/BEGIN:VCALENDAR/i.test(text)) return [];

  const parsed = parseICS(text).map((e, i) => Object.assign({ id: 95000 + i }, e));
  return parsed;
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
// Priority: a real per-event page, then a targeted search that lands on one.
// A bare venue homepage is deliberately NOT used as the primary link — it
// doesn't tell you anything about the specific event.
function infoUrl(ev) {
  if (ev.eu) return String(ev.eu).trim();          // direct event page
  return searchUrl(ev);
}

function hasDirect(ev) { return Boolean(ev.eu); }

// Verified section pages, better than a bare domain for the 🏛 link.
// Only entries confirmed during research — no guessed paths.
const VENUE_PAGES = {
  'albertina.at': 'https://www.albertina.at/en/exhibitions/',
  'belvedere.at': 'https://www.belvedere.at/en/current-exhibitions'
};

function venueUrl(ev) {
  if (!ev.u) return null;
  const u = String(ev.u).trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '');
  if (VENUE_PAGES[u]) return VENUE_PAGES[u];
  const raw = String(ev.u).trim();
  return /^https?:\/\//i.test(raw) ? raw : 'https://' + raw.replace(/^\/+/, '');
}

// Google Maps route to the venue. Origin comes from the HOME_ADDRESS secret
// (private repo config, never in code); without it Google asks for/uses your
// own location, so the link still works.
function mapsUrl(ev) {
  let v = String(ev.v || '').replace(/^\d{1,2}:\d{2}\s*·\s*/, '');
  if (!v || /various|across vienna|wandering|parks and|tba|check your|and squares/i.test(v)) return null;
  if (!/wien|vienna/i.test(v)) v += ', Wien';
  const home = (process.env.HOME_ADDRESS || '').trim();
  const origin = home ? `origin=${encodeURIComponent(home)}&` : '';
  return `https://www.google.com/maps/dir/?api=1&${origin}destination=${encodeURIComponent(v)}&travelmode=transit`;
}

// WhatsApp share — prefilled message with name, date, link
function waUrl(ev, lang) {
  const when = ev.de && ev.de !== ev.dt ? `${ev.dt} → ${ev.de}` : ev.dt;
  const parts = ['🎪 ' + ev.n + ' — ' + when,
    hasDirect(ev) ? ev.eu : 'https://rizabalci.github.io/vienna-events-hub/'];
  return 'https://wa.me/?text=' + encodeURIComponent(parts.join('\n'));
}

// Spotify search for the artist/work — music categories only
const MUSIC_CATS = new Set(['concert', 'jazz', 'classical', 'opera', 'musical']);
function musicUrl(ev) {
  if (!MUSIC_CATS.has(ev.c)) return null;
  const artist = String(ev.n || '').split('—')[0].trim();
  if (!artist) return null;
  return 'https://open.spotify.com/search/' + encodeURIComponent(artist);
}

// Targeted search — reliably lands on the event's own page in one click
function searchUrl(ev) {
  const name = String(ev.n || '');
  const fromCalendar = (ev.t || []).includes('calendar');

  // Calendar entries: search the name only. The v field carries "21:00 · venue"
  // noise, and these are RSVPs, not things to buy tickets for.
  if (fromCalendar) {
    return `https://duckduckgo.com/?q=${encodeURIComponent(name + ' Wien')}`;
  }

  const venue = String(ev.v || '');
  const needsVenue = venue && !name.toLowerCase().includes(venue.toLowerCase());

  // Exhibitions and long runs: no ticket wording, no start month (it's stale).
  // Dated events: include the month to disambiguate recurring shows.
  const longRun = ev.de && ev.de !== ev.dt;
  const isShow = ev.c === 'exhibition';
  const suffix = isShow ? 'exhibition' : 'tickets';
  const when = (!isShow && !longRun && ev.dt) ? ' ' + String(ev.dt).slice(0, 7) : '';

  const q = encodeURIComponent(
    `${name}${needsVenue ? ' ' + venue : ''} Wien${when} ${suffix}`.trim()
  );
  return `https://duckduckgo.com/?q=${q}`;
}

// ── Rendering ─────────────────────────────────────────────────
// No limit by default — set MAX_PER_SECTION to trim long sections if wanted.
const MAX_PER_SECTION = parseInt(process.env.MAX_PER_SECTION || '0', 10) || Infinity;
const CAPS = {
  today: MAX_PER_SECTION, week: MAX_PER_SECTION, month: MAX_PER_SECTION,
  later: MAX_PER_SECTION, ongoing: MAX_PER_SECTION
};

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

  // 🎟 = link goes straight to the event page. 🔍 = search that finds it.
  sub.push(`<a href="${esc(infoUrl(ev))}">${hasDirect(ev) ? '🎟' : '🔍'}</a>`);
  const vu = venueUrl(ev);
  if (vu && vu !== infoUrl(ev)) sub.push(`<a href="${esc(vu)}">🏛</a>`);
  const mu = mapsUrl(ev);
  if (mu) sub.push(`<a href="${esc(mu)}">🗺</a>`);
  const sp = musicUrl(ev);
  if (sp) sub.push(`<a href="${esc(sp)}">🎵</a>`);
  sub.push(`<a href="${esc(waUrl(ev, lang))}">📲</a>`);

  return `${head}\n     <i>${sub.join(' · ')}</i>`;
}

function section(list, title, lang, cap, showDate = true) {
  if (!list.length) return [];
  const parts = [`${title} <b>(${list.length})</b>`, ''];

  // Always group by type, so each section reads as labelled blocks
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
    parts.push(`${CATS[k].icon} <b>${esc(CATS[k][lang])}</b> <i>(${g.length})</i>`, '');
    for (const ev of g) {
      if (shown >= cap) break;
      parts.push(evLine(ev, lang, showDate), '');   // blank line after each event
      shown++;
    }
  }

  if (list.length > shown) {
    const rest = list.length - shown;
    parts.push(lang === 'de' ? `  <i>… und ${rest} weitere</i>` : `  <i>… and ${rest} more</i>`, '');
  }
  return parts;
}

function ongoingLine(ev, lang) {
  const word = lang === 'de' ? 'bis' : 'until';
  const until = ev.de ? ` <i>(${word} ${fmtDate(parseISO(ev.de), lang)})</i>` : '';
  const name = `<a href="${esc(infoUrl(ev))}">${esc(ev.n)}</a>`;
  const bits = [];
  if (ev.v) bits.push(esc(ev.v));
  const vu = venueUrl(ev);
  if (vu && vu !== infoUrl(ev)) bits.push(`<a href="${esc(vu)}">🏛</a>`);
  const mu = mapsUrl(ev);
  if (mu) bits.push(`<a href="${esc(mu)}">🗺</a>`);
  const sp = musicUrl(ev);
  if (sp) bits.push(`<a href="${esc(sp)}">🎵</a>`);
  bits.push(`<a href="${esc(waUrl(ev, lang))}">📲</a>`);
  const tail = bits.length ? ` <i>· ${bits.join(' · ')}</i>` : '';
  return `  • ${name}${until}${tail}`;
}

function buildMessage(b, today, lang) {
  const L = lang === 'de' ? {
    head: '🎪 <b>Wien Events</b>', today: '🔴 <b>HEUTE</b>', week: '📅 <b>DIESE WOCHE</b>',
    month: '🗓 <b>DIESEN MONAT</b>', later: '📆 <b>NÄCHSTE 3 MONATE</b>',
    ongoing: '♾ <b>GANZJÄHRIG</b>', none: 'Keine Events gefunden.',
    tip: '🎟 Direkte Event-Seite · 🔍 Suche · 🏛 Venue · 🗺 Route · 🎵 Anhören · 📲 Teilen',
    site: '🌐 <b><a href="https://rizabalci.github.io/vienna-events-hub/">Alle Events ansehen — Vienna Events Hub</a></b>\n<i>Suche, Filter nach Kategorie und Datum, Merkliste</i>',
    more: n => `  <i>… und ${n} weitere</i>`
  } : {
    head: '🎪 <b>Vienna Events</b>', today: '🔴 <b>TODAY</b>', week: '📅 <b>THIS WEEK</b>',
    month: '🗓 <b>THIS MONTH</b>', later: '📆 <b>NEXT 3 MONTHS</b>',
    ongoing: '♾ <b>ALL YEAR LONG</b>', none: 'No events found.',
    tip: '🎟 direct event page · 🔍 search · 🏛 venue · 🗺 route · 🎵 listen · 📲 share',
    site: '🌐 <b><a href="https://rizabalci.github.io/vienna-events-hub/">See all events — Vienna Events Hub</a></b>\n<i>Search, filter by category and date, save favourites</i>',
    more: n => `  <i>… and ${n} more</i>`
  };

  const total = b.today.length + b.week.length + b.month.length + b.later.length + b.ongoing.length;
  const parts = [`${L.head}  <i>${esc(fmtDate(today, lang))}</i>`, `<i>${L.tip}</i>`, ''];

  if (!total) {
    parts.push(L.none, '', L.site);
    return parts.join('\n');
  }

  // TODAY always opens the bulletin. With no one-off events dated today,
  // it points honestly at the continuous programs instead of vanishing.
  if (b.today.length) {
    parts.push(...section(b.today, L.today, lang, CAPS.today, false));
  } else {
    parts.push(`${L.today} <b>(0)</b>`, '');
    const n = b.ongoing.length;
    parts.push(lang === 'de'
      ? `  <i>Keine Einzeltermine heute — aber ${n} Programme laufen, siehe ♾ GANZJÄHRIG unten.</i>`
      : `  <i>No one-off events today — but ${n} programs are running, see ♾ ALL YEAR LONG below.</i>`, '');
  }
  parts.push(...section(b.week,  L.week,  lang, CAPS.week));
  parts.push(...section(b.month, L.month, lang, CAPS.month));
  parts.push(...section(b.later, L.later, lang, CAPS.later));

  if (b.ongoing.length) {
    parts.push(`${L.ongoing} <b>(${b.ongoing.length})</b>`, '');
    const groups = new Map();
    for (const ev of b.ongoing) {
      const k = CATS[ev.c] ? ev.c : 'other';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(ev);
    }
    let shown = 0;
    for (const k of Object.keys(CATS).filter(x => groups.has(x))) {
      if (shown >= CAPS.ongoing) break;
      const g = groups.get(k);
      parts.push(`${CATS[k].icon} <b>${esc(CATS[k][lang])}</b> <i>(${g.length})</i>`, '');
      for (const ev of g) {
        if (shown >= CAPS.ongoing) break;
        parts.push(ongoingLine(ev, lang), '');
        shown++;
      }
    }
    if (b.ongoing.length > shown) parts.push(L.more(b.ongoing.length - shown), '');
  }

  parts.push(L.site);
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
  const isHeader = s => /^(🔴|📅|🗓|📆|♾)/.test(s);
  const contWord = LANG === 'de' ? 'Fortsetzung' : 'continued';

  const chunks = [];
  let buf = '';
  let header = '';          // most recent section header
  let carried = false;      // has the current chunk already been labelled

  for (const line of text.split('\n')) {
    if (isHeader(line)) { header = line; carried = true; }
    const next = buf ? buf + '\n' + line : line;

    if (buf && (visibleLen(next) > VIS_LIMIT || next.length > RAW_LIMIT)) {
      chunks.push(buf);
      // If we're splitting mid-section, repeat the header so the next
      // message isn't an orphaned list of names.
      buf = (header && !carried) ? `${header} <i>(${contWord})</i>\n${line}` : line;
      carried = isHeader(line);
    } else {
      buf = next;
      if (!isHeader(line)) carried = false;
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
    const calendar = await loadCalendar();

    // Dedup: if a calendar event matches a community.json entry by name+date,
    // keep the calendar one (it carries the RSVP link and exact time).
    const calKeys = new Set(calendar.map(e =>
      e.n.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24) + '|' + e.dt));
    const communityKept = community.filter(e =>
      !calKeys.has(e.n.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24) + '|' + e.dt));

    console.log(`Loaded ${events.length} events from index.html` +
      (communityKept.length ? ` + ${communityKept.length} community` : '') +
      (calendar.length ? ` + ${calendar.length} from calendar` : ''));
    const all = events.concat(communityKept, calendar);

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
