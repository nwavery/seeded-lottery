#!/usr/bin/env node
// Fetches the current Powerball and Mega Millions jackpots and writes them to jackpots.js for index.html.
//
//   node fetch-jackpots.js
//
// Neither game publishes an API. Mega Millions' site calls a JSON endpoint of its own; Powerball's only
// carries the figures in its page HTML. Both are unofficial and can change without notice, so a figure
// that cannot be read is written as null with the reason, never guessed; the page then asks for it by hand.
//
// The output is a script (window.JACKPOTS = ...) rather than JSON because a page opened from disk can load
// a script beside it but cannot fetch a file, and the browser couldn't call these sites directly anyway:
// neither sends CORS headers.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MM_URL = 'https://www.megamillions.com/cmspages/utilservice.asmx/GetLatestDrawData';
const PB_HOME_URL = 'https://www.powerball.com/';
const PB_LAST_DRAW_URL = 'https://www.powerball.com/draw-result?gc=powerball';

/** "$516 Million" or "$1.25 Billion" as dollars. Throws on anything else, so a redesign fails loudly. */
function parseDollars(text) {
  const m = /^\s*\$\s*([\d,]+(?:\.\d+)?)\s*(Million|Billion)\s*$/i.exec(text);
  if (!m) throw new Error(`not a jackpot figure: ${JSON.stringify(text)}`);
  const scale = m[2].toLowerCase() === 'billion' ? 1e9 : 1e6;
  return Math.round(Number(m[1].replace(/,/g, '')) * scale);
}

const stripTags = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The upcoming draw's estimated jackpot and cash value from powerball.com's home page.
 * Each label is followed by a `game-jackpot-number` span holding the figure; the search is bounded to the
 * markup right after the label, so a missing span throws rather than reading some later number.
 */
function parsePowerballHome(html) {
  const figureAfter = (label) => {
    const at = html.indexOf(label);
    if (at < 0) throw new Error(`powerball.com home: no "${label}" label`);
    const m = /class="game-jackpot-number[^"]*"[^>]*>([^<]*)</.exec(html.slice(at, at + 600));
    if (!m) throw new Error(`powerball.com home: no figure after "${label}"`);
    return parseDollars(m[1]);
  };
  // The draw dates sit in cards with fixed ids: the last draw's numbers, and the next drawing.
  const dateIn = (cardId) => {
    const at = html.indexOf(`id="${cardId}"`);
    if (at < 0) throw new Error(`powerball.com home: no "${cardId}" card`);
    const m = /class="[^"]*title-date[^"]*"[^>]*>([^<]+)</.exec(html.slice(at, at + 1500));
    if (!m) throw new Error(`powerball.com home: no date in the "${cardId}" card`);
    return m[1].trim();
  };
  return {
    lastDrawDate: dateIn('numbers'),
    nextDrawDate: dateIn('next-drawing'),
    annuity: figureAfter('Estimated Jackpot'),
    cash: figureAfter('Cash Value'),
  };
}

/**
 * The two Powerball pages as one record. Refuses when they describe different draws: the sales estimate
 * divides the cash growth between them, and a result page one draw behind would double it.
 */
function combinePowerball(home, last) {
  if (home.lastDrawDate !== last.drawDate) {
    throw new Error(`powerball.com pages disagree on the last draw: home says ${home.lastDrawDate}, results say ${last.drawDate}`);
  }
  return {
    lastDrawDate: last.drawDate,
    nextDrawDate: home.nextDrawDate,
    last: { annuity: last.annuity, cash: last.cash },
    next: { annuity: home.annuity, cash: home.cash },
  };
}

/** The most recent draw's date, jackpot and cash value from powerball.com's draw-result page. */
function parsePowerballLastDraw(html) {
  const block = (cls) => {
    const m = new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</div>`).exec(html);
    if (!m) throw new Error(`powerball.com draw result: no "${cls}" block`);
    const text = stripTags(m[1]);
    const colon = text.indexOf(':');
    if (colon < 0) throw new Error(`powerball.com draw result: "${cls}" block has no label: ${JSON.stringify(text)}`);
    return parseDollars(text.slice(colon + 1));
  };
  const date = /class="[^"]*title-date[^"]*"[^>]*>([^<]+)</.exec(html);
  if (!date) throw new Error('powerball.com draw result: no draw date');
  return { drawDate: date[1].trim(), annuity: block('estimated-jackpot'), cash: block('cash-value') };
}

/**
 * Mega Millions' own endpoint: { d: "<JSON string>" }. Jackpot.Current* is the draw just held,
 * Jackpot.Next* the coming one. Also returns the site's prize table so it can be checked against roi.js.
 */
function parseMegaMillions(body) {
  const d = JSON.parse(JSON.parse(body).d);
  const j = d.Jackpot;
  const need = (v, name) => {
    if (!(typeof v === 'number' && v > 0)) throw new Error(`megamillions.com: ${name} missing or not positive: ${v}`);
    return v;
  };
  return {
    lastDrawDate: d.Drawing && d.Drawing.PlayDate ? d.Drawing.PlayDate.slice(0, 10) : null,
    nextDrawDate: d.NextDrawingDate ? String(d.NextDrawingDate).slice(0, 10) : null,
    last: { annuity: need(j.CurrentPrizePool, 'CurrentPrizePool'), cash: need(j.CurrentCashValue, 'CurrentCashValue') },
    next: { annuity: need(j.NextPrizePool, 'NextPrizePool'), cash: need(j.NextCashValue, 'NextCashValue') },
    lastDrawJackpotWinners: j.Winners,
    ticketPrice: d.PrizeMatrix && d.PrizeMatrix.TicketPrice,
    // PrizeMatrix.PrizeTiers is the prize table. The top-level PrizeTiers is a different thing: winner
    // counts for the last draw. Only the Mega2..Mega10 columns are payable amounts; PrizeAmount is not the
    // base they multiply (4+0 has PrizeAmount 599 against a 2x prize of 1,000), so it is not read.
    prizeTiers: (d.PrizeMatrix?.PrizeTiers || []).map((t) => ({
      key: `${t.TierWhiteBall}+${t.TierMegaBall ? 1 : 0}`,
      isJackpot: t.IsJackpot,
      byMultiplier: { 2: t.Mega2, 3: t.Mega3, 4: t.Mega4, 5: t.Mega5, 10: t.Mega10 },
    })),
  };
}

/**
 * Names every way the site's Mega Millions table differs from the one roi.js prices with: each tier's prize
 * at each multiplier against roi.js's base prize times that multiplier. Empty when they agree.
 * Does not check the multiplier odds, which the site does not return.
 */
function megaMillionsTableDrift(parsed, payouts) {
  const ours = payouts.megamillions;
  const drift = [];
  if (parsed.ticketPrice != null && parsed.ticketPrice !== ours.price) drift.push(`price: site $${parsed.ticketPrice}, roi.js $${ours.price}`);
  const theirs = parsed.prizeTiers.filter((t) => !t.isJackpot);
  if (theirs.length === 0) drift.push('the site returned no prize tiers to compare');
  for (const t of theirs) {
    for (const [m, prize] of Object.entries(t.byMultiplier)) {
      const expected = ours.prizes[t.key] * Number(m);
      if (prize !== expected) drift.push(`${t.key} at ${m}x: site $${prize}, roi.js $${expected}`);
    }
  }
  for (const key of Object.keys(ours.prizes)) {
    if (!theirs.some((t) => t.key === key)) drift.push(`${key}: in roi.js, not on the site`);
  }
  return drift;
}

// Without this a slow site can hold a request for minutes, and the scheduled job is killed before it writes
// anything, so the keep-last-good fallback never runs.
const REQUEST_TIMEOUT_MS = 30000;

async function get(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { 'user-agent': 'Mozilla/5.0 (seeded-lottery jackpot fetch)', ...(init && init.headers) } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

async function fetchPowerball() {
  const [home, last] = await Promise.all([get(PB_HOME_URL), get(PB_LAST_DRAW_URL)]);
  return combinePowerball(parsePowerballHome(home), parsePowerballLastDraw(last));
}

async function fetchMegaMillions() {
  const body = await get(MM_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return parseMegaMillions(body);
}

/**
 * The previous run's data, from the jackpots.js it wrote. Null when there is no file or it can't be read;
 * a run then starts from nothing rather than refusing, since a missing file is how every checkout starts.
 */
function readPrevious(text) {
  if (text == null) return null;
  const m = /window\.JACKPOTS = ([\s\S]*);\s*$/.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * One game's record after a run. A good fetch replaces it, stamped with `now`. A failed fetch keeps the last
 * good figures, still stamped with when they were fetched, and adds the error, so a hosted page goes stale
 * visibly instead of going blank. With no good figures to keep, the record is just the error.
 */
function mergeGame(previous, outcome, now) {
  if (outcome.ok) return { ...outcome.value, fetchedAt: now };
  const kept = previous && !previous.error && previous.next ? previous : null;
  if (!kept) return { error: outcome.error };
  const { lastError, lastErrorAt, ...good } = kept;
  return { ...good, lastError: outcome.error, lastErrorAt: now };
}

async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function main() {
  const { estimateTicketsSold, PAYOUTS } = require('./roi.js');
  const file = path.join(__dirname, 'jackpots.js');
  const previous = readPrevious(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  const now = new Date().toISOString();

  // Each game is fetched independently: one site breaking still updates the other.
  const outcomes = {
    powerball: await attempt(async () => {
      const pb = await fetchPowerball();
      return { ...pb, estimatedTicketsSold: estimateTicketsSold('powerball', pb.last.cash, pb.next.cash) };
    }),
    megamillions: await attempt(async () => {
      const mm = await fetchMegaMillions();
      const drift = megaMillionsTableDrift(mm, PAYOUTS);
      if (drift.length) console.warn(`warning: Mega Millions prize table has changed; update roi.js:\n  ${drift.join('\n  ')}`);
      return {
        lastDrawDate: mm.lastDrawDate,
        nextDrawDate: mm.nextDrawDate,
        last: mm.last,
        next: mm.next,
        estimatedTicketsSold: estimateTicketsSold('megamillions', mm.last.cash, mm.next.cash),
        prizeTableDrift: drift,
      };
    }),
  };

  // fetchedAt at the top is when this run happened; each game carries when its figures were fetched.
  const out = { fetchedAt: now, games: {} };
  for (const [id, outcome] of Object.entries(outcomes)) {
    out.games[id] = mergeGame(previous && previous.games && previous.games[id], outcome, now);
  }

  fs.writeFileSync(file, `// Written by fetch-jackpots.js; rerun it to refresh.\nwindow.JACKPOTS = ${JSON.stringify(out, null, 2)};\n`);
  for (const [id, g] of Object.entries(out.games)) {
    if (g.error) console.log(`${id}: FAILED, ${g.error}`);
    else if (g.lastError) console.log(`${id}: FAILED, ${g.lastError}; kept figures from ${g.fetchedAt}`);
    else console.log(`${id}: next $${(g.next.annuity / 1e6).toFixed(1)}M (cash $${(g.next.cash / 1e6).toFixed(1)}M), ~${g.estimatedTicketsSold?.toLocaleString('en-US') ?? 'unknown'} plays`);
  }
  console.log(`wrote ${file}`);
  // Nonzero when any game failed, so a scheduled run shows red; the file is still written either way.
  process.exitCode = Object.values(outcomes).some((o) => !o.ok) ? 1 : 0;
}

module.exports = { parseDollars, parsePowerballHome, parsePowerballLastDraw, combinePowerball, parseMegaMillions, megaMillionsTableDrift, readPrevious, mergeGame };
if (require.main === module) main();
