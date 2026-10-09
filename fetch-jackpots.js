#!/usr/bin/env node
// Fetches the current Powerball and Mega Millions jackpots and writes them to jackpots.js for index.html.
//
//   node fetch-jackpots.js [output]     writes jackpots.js beside this script unless given another path
//
// Neither game publishes an API. Mega Millions' site calls a JSON endpoint of its own; Powerball's only
// carries the figures in its page HTML. Both are unofficial and can change without notice, so a figure
// that cannot be read, or reads as something no lottery would advertise, counts as a failed fetch: that
// game keeps its last good figures, never a guess.
//
// Exit status is a bit set, so the workflow can tell the two apart:
//   1  a fetch failed; that game's last good figures were kept
//   2  Mega Millions' prize table or ball ranges no longer match roi.js and prng.js; figures still published
// 0 is a clean run and 3 is both. The file is written in every case.
//
// The output is a script (window.JACKPOTS = ...) rather than JSON because a page opened from disk can load
// a script beside it but cannot fetch a file, and the browser couldn't call these sites directly anyway:
// neither sends CORS headers.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const URLS = {
  megaMillions: 'https://www.megamillions.com/cmspages/utilservice.asmx/GetLatestDrawData',
  powerballHome: 'https://www.powerball.com/',
  powerballLastDraw: 'https://www.powerball.com/draw-result?gc=powerball',
};

const EXIT = { fetchFailed: 1, drift: 2 };

/** "$516 Million" or "$1.25 Billion" as dollars. Throws on anything else, so a redesign fails loudly. */
function parseDollars(text) {
  const m = /^\s*\$\s*([\d,]+(?:\.\d+)?)\s*(Million|Billion)\s*$/i.exec(text);
  if (!m) throw new Error(`not a jackpot figure: ${JSON.stringify(text)}`);
  const scale = m[2].toLowerCase() === 'billion' ? 1e9 : 1e6;
  return Math.round(Number(m[1].replace(/,/g, '')) * scale);
}

const stripTags = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** True for the exact form Date.prototype.toISOString writes, "2026-10-11T02:59:00.000Z". */
function isIsoInstant(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?/;
const wallClock = (m) => Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);

/** A UTC timestamp such as Powerball's "2026-10-11T02:59:00.0000000Z", as an ISO instant. Throws without the Z. */
function utcInstant(text) {
  const m = typeof text === 'string' && new RegExp(`${DATE_TIME.source}Z$`).exec(text);
  const t = m && wallClock(m);
  // Read back, so 2026-13-01 is refused rather than rolled into the next year.
  if (!m || new Date(t).toISOString().slice(0, 19) !== text.slice(0, 19)) throw new Error(`not a UTC draw time: ${JSON.stringify(text)}`);
  return new Date(t).toISOString();
}

const EASTERN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});

/**
 * A New York wall time with no zone, such as Mega Millions' "2026-10-09T23:00:00", as an ISO instant.
 * Uses the offset in force on that date, so draws either side of a daylight-time change come out an hour
 * apart in UTC. Throws on text carrying a zone (it would not be wall time) and on a time the spring change
 * skips. In the repeated hour each November it picks daylight time; every draw is at 11 PM, so none is there.
 */
function easternWallTime(text) {
  const m = typeof text === 'string' && new RegExp(`${DATE_TIME.source}$`).exec(text);
  if (m) {
    const wall = wallClock(m);
    // New York is 4 hours behind UTC in daylight time and 5 in standard: keep whichever reads back as this time.
    for (const hours of [4, 5]) {
      const t = wall + hours * 3600e3;
      const p = Object.fromEntries(EASTERN.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
      if (Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) === wall) return new Date(t).toISOString();
    }
  }
  throw new Error(`not an Eastern wall time: ${JSON.stringify(text)}`);
}

/**
 * The upcoming draw's estimated jackpot, cash value and draw time from powerball.com's home page.
 * The annuity figure is read only between the "Estimated Jackpot" and "Cash Value" labels, and the cash
 * figure only inside the "Cash Value" group, so a missing figure throws rather than reading its neighbour's.
 */
function parsePowerballHome(html) {
  const jackpotAt = html.indexOf('Estimated Jackpot');
  if (jackpotAt < 0) throw new Error('powerball.com home: no "Estimated Jackpot" label');
  const cashAt = html.indexOf('Cash Value', jackpotAt);
  if (cashAt < 0) throw new Error('powerball.com home: no "Cash Value" label after "Estimated Jackpot"');
  const cashGroupEnd = html.indexOf('</div>', cashAt);
  if (cashGroupEnd < 0) throw new Error('powerball.com home: the "Cash Value" group never closes');
  const figureIn = (label, from, to) => {
    const m = /class="game-jackpot-number[^"]*"[^>]*>([^<]*)</.exec(html.slice(from, to));
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
  // The next drawing's countdown carries the exact draw time in UTC. It sits in that card above the jackpot
  // figures, so the search stops at "Estimated Jackpot" rather than reading another card's countdown.
  const cardAt = html.indexOf('id="next-drawing"');
  const drawAt = cardAt < 0 || cardAt > jackpotAt ? null : /data-drawdateutc="([^"]*)"/.exec(html.slice(cardAt, jackpotAt));
  if (!drawAt) throw new Error('powerball.com home: no draw time in the "next-drawing" card');
  return {
    lastDrawDate: dateIn('numbers'),
    nextDrawDate: dateIn('next-drawing'),
    nextDrawAt: utcInstant(drawAt[1]),
    annuity: figureIn('Estimated Jackpot', jackpotAt, cashAt),
    cash: figureIn('Cash Value', cashAt, cashGroupEnd),
  };
}

/**
 * The two Powerball pages as one record. Refuses when they describe different draws: the sales estimate
 * divides the cash growth between them, and a result page one draw behind would double it.
 */
function combinePowerball(home, last) {
  if (home.lastDrawDate !== last.drawDate) {
    throw new Error(`powerball.com pages disagree on the last draw: home says ${JSON.stringify(home.lastDrawDate)}, results say ${JSON.stringify(last.drawDate)}`);
  }
  return {
    lastDrawDate: last.drawDate,
    nextDrawDate: home.nextDrawDate,
    nextDrawAt: home.nextDrawAt,
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
 * Jackpot.Next* the coming one. Also returns the site's prize table and ball ranges so they can be checked
 * against roi.js and prng.js.
 */
function parseMegaMillions(body) {
  const d = JSON.parse(JSON.parse(body).d);
  const j = d.Jackpot || {};
  const need = (v, name) => {
    if (!(typeof v === 'number' && v > 0)) throw new Error(`megamillions.com: ${name} missing or not positive: ${JSON.stringify(v)}`);
    return v;
  };
  // Jackpot and Drawing update separately, about an hour and a half apart after a draw. In that gap the
  // figures still describe the draw before, and pairing them with the new date would misdate them and
  // spread the sales estimate across two draws.
  // Undefined unless the text starts with a date, so two empty or junk fields never count as a match.
  const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined);
  const drawPlayDate = d.Drawing && d.Drawing.PlayDate;
  const lastDrawDate = day(drawPlayDate);
  const jackpotDraw = day(j.PlayDate);
  if (lastDrawDate === undefined || jackpotDraw !== lastDrawDate) {
    const show = (v) => JSON.stringify(day(v) ?? v);
    throw new Error(`megamillions.com: jackpot figures are for ${show(j.PlayDate)}, the last draw is ${show(drawPlayDate)}`);
  }
  let nextDrawAt;
  try {
    nextDrawAt = easternWallTime(d.NextDrawingDate);
  } catch (e) {
    throw new Error(`megamillions.com: NextDrawingDate: ${e.message}`);
  }
  const pm = d.PrizeMatrix || {};
  return {
    lastDrawDate,
    nextDrawDate: day(d.NextDrawingDate),
    nextDrawAt,
    last: { annuity: need(j.CurrentPrizePool, 'CurrentPrizePool'), cash: need(j.CurrentCashValue, 'CurrentCashValue') },
    next: { annuity: need(j.NextPrizePool, 'NextPrizePool'), cash: need(j.NextCashValue, 'NextCashValue') },
    lastDrawJackpotWinners: j.Winners,
    // Logged when false, not enforced: when it flips relative to the figures is not yet known from live data.
    jackpotVerified: j.Verified === true,
    ticketPrice: pm.TicketPrice,
    ballRanges: { white: pm.WhiteBallMax, mega: pm.MegaBallMax },
    // PrizeMatrix.PrizeTiers is the prize table. The top-level PrizeTiers is a different thing: winner
    // counts for the last draw. Only the Mega2..Mega10 columns are payable amounts; PrizeAmount is not the
    // base they multiply (4+0 has PrizeAmount 599 against a 2x prize of 1,000), so it is not read.
    prizeTiers: (pm.PrizeTiers || []).map((t) => ({
      key: `${t.TierWhiteBall}+${t.TierMegaBall ? 1 : 0}`,
      isJackpot: t.IsJackpot,
      byMultiplier: { 2: t.Mega2, 3: t.Mega3, 4: t.Mega4, 5: t.Mega5, 10: t.Mega10 },
    })),
  };
}

/**
 * Names every way the site's Mega Millions game differs from ours: each tier's prize at each multiplier
 * against roi.js's base prize times that multiplier, the ticket price, and both ball ranges against
 * prng.js's GAMES. Empty when they agree. Does not check the multiplier odds, which the site does not return.
 * Site values are quoted with JSON.stringify, so text from the site cannot break a log line.
 */
function megaMillionsTableDrift(parsed, payouts, games) {
  const ours = payouts.megamillions;
  const drift = [];
  if (parsed.ticketPrice != null && parsed.ticketPrice !== ours.price) drift.push(`price: site ${JSON.stringify(parsed.ticketPrice)}, roi.js ${ours.price}`);
  const theirs = parsed.prizeTiers.filter((t) => !t.isJackpot);
  if (theirs.length === 0) drift.push('the site returned no prize tiers to compare');
  for (const t of theirs) {
    for (const [m, prize] of Object.entries(t.byMultiplier)) {
      const expected = ours.prizes[t.key] * Number(m);
      if (prize !== expected) drift.push(`tier ${JSON.stringify(t.key)} at ${m}x: site ${JSON.stringify(prize)}, roi.js ${expected}`);
    }
  }
  for (const key of Object.keys(ours.prizes)) {
    if (!theirs.some((t) => t.key === key)) drift.push(`tier ${JSON.stringify(key)}: in roi.js, not on the site`);
  }
  const [white, mega] = games.megamillions.pools;
  for (const [pool, site] of [[white, parsed.ballRanges.white], [mega, parsed.ballRanges.mega]]) {
    if (site !== pool.max) drift.push(`${pool.label} range: site 1 to ${JSON.stringify(site)}, prng.js 1 to ${pool.max}`);
  }
  return drift;
}

// The advertised jackpot each game resets to when it is won. Powerball's has been $20M since 2020; Mega
// Millions' became $50M with the April 2025 change.
const STARTING_JACKPOT = { powerball: 20e6, megamillions: 50e6 };
const GAME_IDS = Object.keys(STARTING_JACKPOT);
// Every advertised jackpot so far is inside this; the ceiling is there to catch a change of units.
const ANNUITY_RANGE = [20e6, 5e9];
// Cash over annuity tracks long-term interest rates: 0.748 for Powerball in January 2021, about 0.41 now.
const CASH_RATIO_RANGE = [0.2, 0.9];
// One $0.1M step of cash growth, the sites' rounding, reads as about 154,000 Powerball plays: below this
// floor the estimate is rounding noise. No draw has sold a billion.
const TICKETS_SOLD_RANGE = [5e5, 1e9];

/**
 * Throws when a game's figures cannot be right, so the run keeps the last good ones instead. Checks both
 * the last and next draw: annuity > cash > 0, cash between 0.2 and 0.9 of the annuity, annuity inside
 * $20M to $5B. The cash value may only fall when the jackpot was won, which is taken to mean the next
 * jackpot is under twice the game's starting jackpot, or Mega Millions reports a winner.
 * Returns the record to publish: unchanged, except an estimatedTicketsSold outside 500,000 to a billion
 * becomes null (unknown), which the page already handles, rather than failing the fetch.
 */
function checkFigures(gameId, record) {
  if (!(gameId in STARTING_JACKPOT)) throw new Error(`no such game: ${gameId}`);
  const fail = (why) => {
    throw new Error(`implausible figures: ${why}`);
  };
  for (const which of ['last', 'next']) {
    const f = record[which];
    if (!f || typeof f !== 'object') fail(`${which}: missing`);
    const { annuity, cash } = f;
    if (!(typeof annuity === 'number' && typeof cash === 'number' && annuity > cash && cash > 0)) {
      fail(`${which}: needs annuity > cash > 0, got annuity ${JSON.stringify(annuity)}, cash ${JSON.stringify(cash)}`);
    }
    const ratio = cash / annuity;
    if (!(ratio > CASH_RATIO_RANGE[0] && ratio < CASH_RATIO_RANGE[1])) {
      fail(`${which}: cash is ${Number(ratio.toFixed(3))} of the annuity, outside ${CASH_RATIO_RANGE[0]} to ${CASH_RATIO_RANGE[1]}`);
    }
    if (!(annuity >= ANNUITY_RANGE[0] && annuity <= ANNUITY_RANGE[1])) fail(`${which}: annuity ${annuity} is outside ${ANNUITY_RANGE[0]} to ${ANNUITY_RANGE[1]}`);
  }
  const won = record.next.annuity < 2 * STARTING_JACKPOT[gameId] || record.lastDrawJackpotWinners > 0;
  if (record.next.cash < record.last.cash && !won) {
    fail(`next cash ${record.next.cash} is below last cash ${record.last.cash}, and the jackpot was not won`);
  }
  // A rolled jackpot always grows, so the same pair twice means the next figures were never updated: the
  // page moved its dates on and left the jackpot block showing the draw just held. Either figure alone may
  // repeat, since each is rounded.
  if (record.next.annuity === record.last.annuity && record.next.cash === record.last.cash && !won) {
    fail("next jackpot and cash are identical to the last draw's, and the jackpot was not won");
  }
  const sold = record.estimatedTicketsSold;
  if (sold == null || (sold >= TICKETS_SOLD_RANGE[0] && sold <= TICKETS_SOLD_RANGE[1])) return record;
  return { ...record, estimatedTicketsSold: null };
}

/**
 * Throws when the record's next draw is not after `now`: the site has not moved on, so its figures belong
 * to a draw that has happened (a cached page, or an endpoint that stopped updating).
 */
function refusePastDraw(record, now) {
  if (!isIsoInstant(record.nextDrawAt)) throw new Error('no next draw time to check the figures against');
  if (!(Date.parse(record.nextDrawAt) > now.getTime())) {
    throw new Error(`next draw ${record.nextDrawAt} has already happened; the site has not moved on to the next one`);
  }
}

// Without this a slow site can hold a request for minutes, and the scheduled job is killed before it writes
// anything, so the keep-last-good fallback never runs.
const REQUEST_TIMEOUT_MS = 30000;
// Two retries. A single 403 or timeout would otherwise cost a day, since the job runs once a day. Worst case
// per page is three timeouts plus 7 s, inside the workflow's 10 minutes even for both games in turn.
const RETRY_DELAYS_MS = [2000, 5000];

/** The body of a GET or POST, after up to two retries. Throws naming the URL and the last failure. */
async function get(url, init, { fetch, sleep }) {
  for (let tries = 1; ; tries++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { 'user-agent': 'Mozilla/5.0 (seeded-lottery jackpot fetch)', ...(init && init.headers) } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (tries > RETRY_DELAYS_MS.length) throw new Error(`${url}: ${e.message} (after ${tries} tries)`);
      await sleep(RETRY_DELAYS_MS[tries - 1]);
    }
  }
}

async function fetchPowerball(deps) {
  const [home, last] = await Promise.all([get(URLS.powerballHome, {}, deps), get(URLS.powerballLastDraw, {}, deps)]);
  return combinePowerball(parsePowerballHome(home), parsePowerballLastDraw(last));
}

async function fetchMegaMillions(deps) {
  const body = await get(URLS.megaMillions, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, deps);
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
 * jackpots.js run as the page runs it, a classic script that sets window.JACKPOTS, and what it set.
 * Throws if it does not parse or sets nothing. Only for our own file: it executes the text.
 */
function loadJackpotsScript(text) {
  const window = {};
  vm.compileFunction(text, ['window'])(window);
  if (window.JACKPOTS === undefined) throw new Error('jackpots.js did not set window.JACKPOTS');
  return window.JACKPOTS;
}

// Draw weekdays, Sunday = 0: Powerball Mon/Wed/Sat, Mega Millions Tue/Fri. A draw the lotteries move, for a
// holiday, would be refused as a skipped draw: that game keeps its last good figures and the run goes red
// until this is updated, which is the safe way round.
const DRAW_DAYS = { powerball: [1, 3, 6], megamillions: [2, 5] };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A draw date as the sites write it, Mega Millions' "2026-10-06" or Powerball's "Wed, Oct 7, 2026", as
 * "YYYY-MM-DD". Throws on anything else, including a date that does not exist.
 */
function calendarDate(text) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const us = /^(?:[A-Z][a-z]{2}, )?([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(text);
  const [y, m, d] = iso ? [+iso[1], +iso[2], +iso[3]] : us ? [+us[3], MONTHS.indexOf(us[1]) + 1, +us[2]] : [];
  const t = Date.UTC(y, m - 1, d);
  const out = Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
  if (!out || m < 1 || out !== `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`) throw new Error(`not a date: ${JSON.stringify(text)}`);
  return out;
}

/** The New York calendar date of an ISO instant, as "YYYY-MM-DD". */
function easternDate(instant) {
  const p = Object.fromEntries(EASTERN.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month.padStart(2, '0')}-${p.day.padStart(2, '0')}`;
}

/** The first scheduled draw date strictly after `date` ("YYYY-MM-DD"), for this game. */
function drawAfter(gameId, date) {
  const start = Date.parse(`${date}T00:00:00Z`);
  for (let i = 1; i <= 7; i++) {
    const t = new Date(start + i * 864e5);
    if (DRAW_DAYS[gameId].includes(t.getUTCDay())) return t.toISOString().slice(0, 10);
  }
  throw new Error(`${gameId} has no draw days`);
}

/**
 * Throws, naming the field, when one game's figures could not be published: they fail checkFigures, a date or
 * stamp the page prints is missing or malformed, or the next draw is not the scheduled draw straight after the
 * last one. That last rule catches figures stuck on an old draw while the countdown has moved on, which a
 * check against the clock alone accepts. Dates are compared as New York calendar dates.
 * Returns checkFigures' record. main() runs this on every fresh record, so anything it refuses is a failed
 * fetch for that game, never a file the workflow's check then rejects whole.
 * nextDrawAt may be absent, since files written before it existed have none; the date text is still checked.
 */
function checkGameRecord(id, g) {
  const bad = (why) => {
    throw new Error(why);
  };
  const record = checkFigures(id, g);
  if (!isIsoInstant(g.fetchedAt)) bad(`fetchedAt: not an ISO instant: ${JSON.stringify(g.fetchedAt)}`);
  if (g.nextDrawAt !== undefined && !isIsoInstant(g.nextDrawAt)) bad(`nextDrawAt: not an ISO instant: ${JSON.stringify(g.nextDrawAt)}`);
  const dates = {};
  for (const k of ['lastDrawDate', 'nextDrawDate']) {
    try {
      dates[k] = calendarDate(g[k]);
    } catch (e) {
      bad(`${k}: ${e.message}`);
    }
  }
  if (g.nextDrawAt !== undefined && easternDate(g.nextDrawAt) !== dates.nextDrawDate) {
    bad(`nextDrawDate ${dates.nextDrawDate} is not the New York date of nextDrawAt ${g.nextDrawAt}, which is ${easternDate(g.nextDrawAt)}`);
  }
  const expected = drawAfter(id, dates.lastDrawDate);
  if (dates.nextDrawDate !== expected) {
    bad(`the next draw is ${dates.nextDrawDate}, but the draw after ${dates.lastDrawDate} is ${expected}: the figures are for an older draw, or the site skipped one`);
  }
  const sold = g.estimatedTicketsSold;
  if (!(sold == null || (Number.isFinite(sold) && sold > 0))) bad(`estimatedTicketsSold: not a number or null: ${JSON.stringify(sold)}`);
  if (g.lastError !== undefined && typeof g.lastError !== 'string') bad('lastError: not text');
  if (g.prizeTableDrift !== undefined && !(Array.isArray(g.prizeTableDrift) && g.prizeTableDrift.every((s) => typeof s === 'string'))) {
    bad('prizeTableDrift: not a list of text');
  }
  return record;
}

/**
 * Throws, naming the game and field, when index.html could not show this data: every game present, each
 * either an error message or a record that passes checkGameRecord.
 */
function checkJackpotsData(data) {
  if (!data || typeof data.games !== 'object' || data.games === null) throw new Error('jackpots.js: no games');
  if (!isIsoInstant(data.fetchedAt)) throw new Error(`jackpots.js: fetchedAt: not an ISO instant: ${JSON.stringify(data.fetchedAt)}`);
  for (const id of GAME_IDS) {
    const g = data.games[id];
    try {
      if (!g || typeof g !== 'object') throw new Error('missing');
      if ('error' in g) {
        if (typeof g.error !== 'string') throw new Error('error: not text');
        continue;
      }
      checkGameRecord(id, g);
    } catch (e) {
      throw new Error(`jackpots.js: ${id}: ${e.message}`);
    }
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

/**
 * The Actions runner reads any output line starting with "::" as a workflow command, and errors here can
 * carry text from the lottery sites (JSON.parse quotes the body it choked on, newlines and all). Every
 * print goes through this, so no scraped text can start a line.
 */
const oneLine = (text) => String(text).replace(/[\r\n]+/g, ' ');

/**
 * One run: fetch both games, check them, keep last good figures for any that fail, write `file`, and return
 * the exit status described at the top. Everything that reaches outside is passed in, so tests run it whole.
 *   fetch  the WHATWG fetch to call the sites with
 *   sleep  (ms) => Promise, waited on between retries
 *   file   the jackpots.js to read the previous run from and write this one to
 *   now    the run's time: stamps the figures and decides whether a draw has already happened
 *   log    (line) => void, given one line at a time with CR and LF already removed
 * A crash part way (the file cannot be written, say) is logged and returns the fetch-failed bit, plus the
 * drift bit if drift was found before it, so the workflow still reports both.
 */
async function main(options = {}) {
  const log = options.log || ((line) => console.log(line));
  const found = { drift: [] };
  try {
    return await refresh({ ...options, log }, found);
  } catch (e) {
    log(oneLine(`FAILED: ${e.message}`));
    return EXIT.fetchFailed | (found.drift.length ? EXIT.drift : 0);
  }
}

/** main() without the crash handling. Records any drift in `found.drift` as soon as it is known. */
async function refresh({
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  file = path.join(__dirname, 'jackpots.js'),
  now = new Date(),
  log,
}, found) {
  const { estimateTicketsSold, PAYOUTS } = require('./roi.js');
  const { GAMES } = require('./prng.js');
  const say = (text) => log(oneLine(text));
  const deps = { fetch, sleep };
  const previous = readPrevious(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  const stamp = now.toISOString();
  // The same check the workflow runs on the whole file, so a record it would reject fails this game alone
  // and keeps its last good figures, instead of stopping the commit and deploy for both.
  const publishable = (id, record) => {
    const { fetchedAt, ...checked } = checkGameRecord(id, { ...record, fetchedAt: stamp });
    return checked;
  };

  // Each game is fetched independently: one site breaking still updates the other.
  const outcomes = {
    powerball: await attempt(async () => {
      const pb = await fetchPowerball(deps);
      const record = { ...pb, estimatedTicketsSold: estimateTicketsSold('powerball', pb.last.cash, pb.next.cash) };
      refusePastDraw(record, now);
      return publishable('powerball', record);
    }),
    megamillions: await attempt(async () => {
      const mm = await fetchMegaMillions(deps);
      if (!mm.jackpotVerified) say('megamillions: warning: the site has not marked these jackpot figures verified; publishing them anyway');
      // Before the figure checks, so a changed table turns the run red even when the figures are refused.
      const drift = megaMillionsTableDrift(mm, PAYOUTS, GAMES);
      found.drift = drift;
      if (drift.length) {
        say('megamillions: warning: the prize table or ball ranges have changed; update roi.js and prng.js:');
        for (const line of drift) say(`megamillions:   ${line}`);
      }
      const record = {
        lastDrawDate: mm.lastDrawDate,
        nextDrawDate: mm.nextDrawDate,
        nextDrawAt: mm.nextDrawAt,
        last: mm.last,
        next: mm.next,
        // Kept so a later check of this file can still tell a won jackpot's reset from a misread.
        lastDrawJackpotWinners: mm.lastDrawJackpotWinners,
        estimatedTicketsSold: estimateTicketsSold('megamillions', mm.last.cash, mm.next.cash),
        prizeTableDrift: drift,
      };
      refusePastDraw(record, now);
      return publishable('megamillions', record);
    }),
  };

  // fetchedAt at the top is when this run happened; each game carries when its figures were fetched.
  const out = { fetchedAt: stamp, games: {} };
  for (const [id, outcome] of Object.entries(outcomes)) {
    const merged = mergeGame(previous && previous.games && previous.games[id], outcome, stamp);
    // Kept figures were checked when fetched, but perhaps under an older rule. The workflow's check of the
    // whole file applies today's, and one stale record there would stop the commit and deploy for both games.
    try {
      if (merged.lastError) checkGameRecord(id, merged);
      out.games[id] = merged;
    } catch (e) {
      out.games[id] = { error: `${outcome.error}; the last good figures no longer pass: ${e.message}` };
    }
  }

  fs.writeFileSync(file, `// Written by fetch-jackpots.js; rerun it to refresh.\nwindow.JACKPOTS = ${JSON.stringify(out, null, 2)};\n`);
  for (const [id, g] of Object.entries(out.games)) {
    if (g.error) say(`${id}: FAILED, ${g.error}`);
    else if (g.lastError) say(`${id}: FAILED, ${g.lastError}; kept figures from ${g.fetchedAt}`);
    else say(`${id}: next $${(g.next.annuity / 1e6).toFixed(1)}M (cash $${(g.next.cash / 1e6).toFixed(1)}M), ~${g.estimatedTicketsSold?.toLocaleString('en-US') ?? 'unknown'} plays, draw ${g.nextDrawAt}`);
  }
  say(`wrote ${file}`);
  const failed = Object.values(outcomes).some((o) => !o.ok);
  return (failed ? EXIT.fetchFailed : 0) | (found.drift.length ? EXIT.drift : 0);
}

module.exports = {
  URLS, parseDollars, parsePowerballHome, parsePowerballLastDraw, combinePowerball, parseMegaMillions, megaMillionsTableDrift,
  easternWallTime, checkFigures, checkGameRecord, refusePastDraw, readPrevious, loadJackpotsScript, checkJackpotsData, mergeGame, main,
};
if (require.main === module) {
  // main() handles its own crashes; this catches only what escapes it, and still exits with the failed bit.
  main({ file: process.argv[2] ? path.resolve(process.argv[2]) : undefined }).then((code) => {
    process.exitCode = code;
  }).catch((e) => {
    console.log(oneLine(`FAILED: ${e && e.message}`));
    process.exitCode = EXIT.fetchFailed;
  });
}
