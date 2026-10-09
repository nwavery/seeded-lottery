// The fixtures are the real responses, saved 2026-10-09; nothing here touches the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseDollars, parsePowerballHome, parsePowerballLastDraw, combinePowerball, parseMegaMillions, megaMillionsTableDrift, checkFigures, easternWallTime, refusePastDraw } = require('../fetch-jackpots.js');
const { PAYOUTS } = require('../roi.js');
const { GAMES } = require('../prng.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('jackpot figures parse in millions and billions', () => {
  assert.equal(parseDollars('$516 Million'), 516e6);
  assert.equal(parseDollars(' $211.6 Million '), 211.6e6);
  assert.equal(parseDollars('$1.25 Billion'), 1.25e9);
  assert.equal(parseDollars('$1,040 Million'), 1.04e9);
});

test('anything that is not a jackpot figure is refused, not read as zero', () => {
  for (const bad of ['', '$516', 'TBD', 'Results Pending', '$ Million', '516 Million', '$516 Million and change']) {
    assert.throws(() => parseDollars(bad), /not a jackpot figure/, JSON.stringify(bad));
  }
});

test('powerball.com home page: the coming draw', () => {
  assert.deepEqual(parsePowerballHome(fixture('powerball-home.html')), {
    lastDrawDate: 'Wed, Oct 7, 2026',
    nextDrawDate: 'Sat, Oct 10, 2026',
    // The card's own UTC countdown target: 10:59 PM EDT on Saturday.
    nextDrawAt: '2026-10-11T02:59:00.000Z',
    annuity: 516e6,
    cash: 211.6e6,
  });
});

test('the two Powerball pages combine when they describe the same last draw', () => {
  const pb = combinePowerball(parsePowerballHome(fixture('powerball-home.html')), parsePowerballLastDraw(fixture('powerball-latest-draw.html')));
  assert.deepEqual(pb, {
    lastDrawDate: 'Wed, Oct 7, 2026',
    nextDrawDate: 'Sat, Oct 10, 2026',
    nextDrawAt: '2026-10-11T02:59:00.000Z',
    last: { annuity: 485e6, cash: 199.7e6 },
    next: { annuity: 516e6, cash: 211.6e6 },
  });
});

test('a results page one draw behind the home page is refused', () => {
  // The cash growth would then span two draws and the sales estimate would come out about double.
  const home = parsePowerballHome(fixture('powerball-home.html'));
  const behind = { ...parsePowerballLastDraw(fixture('powerball-latest-draw.html')), drawDate: 'Mon, Oct 5, 2026' };
  assert.throws(() => combinePowerball(home, behind), /disagree on the last draw/);
});

test('powerball.com home page with its figures removed fails rather than reading a later number', () => {
  // Plant the problem: drop the first two figures, so the only remaining numbers are further down the page.
  const html = fixture('powerball-home.html');
  const stripped = html.replace(/(class="game-jackpot-number[^"]*"[^>]*>)[^<]*</g, (m, open, offset) =>
    offset < html.indexOf('Cash Value') + 600 ? `${open.replace('game-jackpot-number', 'gone')}<` : m);
  assert.notEqual(stripped, html);
  // And a decoy further down, as a sidebar for another game would be: an unbounded search would read it.
  const decoy = stripped.replace('</body>', `${' '.repeat(2000)}<span class="game-jackpot-number">$999 Million</span></body>`);
  assert.notEqual(decoy, stripped);
  assert.throws(() => parsePowerballHome(decoy), /no figure after/);
  assert.throws(() => parsePowerballHome('<html></html>'), /powerball.com home: no /);
});

test('powerball.com draw result: the draw just held', () => {
  assert.deepEqual(parsePowerballLastDraw(fixture('powerball-latest-draw.html')), {
    drawDate: 'Wed, Oct 7, 2026',
    annuity: 485e6,
    cash: 199.7e6,
  });
});

test('powerball.com draw result with either figure block missing fails, naming the block', () => {
  // Each block removed alone from the draw-result page, so the other one is still there to be misread.
  const html = fixture('powerball-latest-draw.html');
  for (const cls of ['cash-value', 'estimated-jackpot']) {
    const planted = html.replace(new RegExp(cls, 'g'), 'x');
    assert.notEqual(planted, html);
    assert.throws(() => parsePowerballLastDraw(planted), new RegExp(`no "${cls}" block`), cls);
  }
});

test('megamillions.com endpoint: last and next draw', () => {
  const mm = parseMegaMillions(fixture('megamillions-latest.json'));
  assert.deepEqual(mm.last, { annuity: 345e6, cash: 139.6e6 });
  assert.deepEqual(mm.next, { annuity: 364e6, cash: 147.3e6 });
  assert.equal(mm.lastDrawDate, '2026-10-06');
  assert.equal(mm.nextDrawDate, '2026-10-09');
  // NextDrawingDate is 2026-10-09T23:00:00 with no zone: 11 PM Eastern, which is 03:00 UTC the next day.
  assert.equal(mm.nextDrawAt, '2026-10-10T03:00:00.000Z');
  assert.equal(mm.ticketPrice, 5);
  assert.equal(mm.jackpotVerified, true);
});

test('megamillions.com endpoint with a missing jackpot fails', () => {
  const body = JSON.parse(fixture('megamillions-latest.json'));
  const d = JSON.parse(body.d);
  d.Jackpot.NextCashValue = null;
  assert.throws(() => parseMegaMillions(JSON.stringify({ d: JSON.stringify(d) })), /NextCashValue/);
});

test("the site's Mega Millions prize table agrees with roi.js", () => {
  assert.deepEqual(megaMillionsTableDrift(parseMegaMillions(fixture('megamillions-latest.json')), PAYOUTS, GAMES), []);
});

test('a changed Mega Millions prize table is reported', () => {
  const mm = parseMegaMillions(fixture('megamillions-latest.json'));
  // PAYOUTS holds functions, so copy the one entry being changed by hand rather than structuredClone.
  const withMega = (change) => ({ ...PAYOUTS, megamillions: change({ ...PAYOUTS.megamillions, prizes: { ...PAYOUTS.megamillions.prizes } }) });
  const changed = withMega((m) => ({ ...m, price: 2, prizes: { ...m.prizes, '4+0': 600 } }));
  const drift = megaMillionsTableDrift(mm, changed, GAMES);
  assert.ok(drift.includes('tier "4+0" at 2x: site 1000, roi.js 1200'), drift.join('\n'));
  assert.ok(drift.includes('price: site 5, roi.js 2'), drift.join('\n'));

  const missingTier = withMega((m) => ({ ...m, prizes: { ...m.prizes, '9+9': 1 } }));
  assert.deepEqual(megaMillionsTableDrift(mm, missingTier, GAMES), ['tier "9+9": in roi.js, not on the site']);

  assert.ok(megaMillionsTableDrift({ ...mm, prizeTiers: [] }, PAYOUTS, GAMES).some((d) => /no prize tiers/.test(d)));
});

const { readPrevious, mergeGame } = require('../fetch-jackpots.js');

test('the previous jackpots.js reads back as the data it wrote', () => {
  const data = { fetchedAt: '2026-10-09T10:00:00.000Z', games: { powerball: { next: { annuity: 1, cash: 2 } } } };
  const text = `// Written by fetch-jackpots.js; rerun it to refresh.\nwindow.JACKPOTS = ${JSON.stringify(data, null, 2)};\n`;
  assert.deepEqual(readPrevious(text), data);
  assert.equal(readPrevious(null), null);
  assert.equal(readPrevious('window.JACKPOTS = {not json};'), null);
  assert.equal(readPrevious('something else entirely'), null);
});

test('a good fetch replaces the record and is stamped with the run time', () => {
  const prev = { next: { annuity: 1, cash: 1 }, fetchedAt: 'old', lastError: 'x', lastErrorAt: 'old' };
  assert.deepEqual(mergeGame(prev, { ok: true, value: { next: { annuity: 2, cash: 2 } } }, 'now'),
    { next: { annuity: 2, cash: 2 }, fetchedAt: 'now' });
});

test('a failed fetch keeps the last good figures with their own date, and says why', () => {
  const prev = { next: { annuity: 1, cash: 1 }, fetchedAt: 'monday' };
  assert.deepEqual(mergeGame(prev, { ok: false, error: 'HTTP 403' }, 'tuesday'),
    { next: { annuity: 1, cash: 1 }, fetchedAt: 'monday', lastError: 'HTTP 403', lastErrorAt: 'tuesday' });
  // A second failure replaces the error, not the figures or their date.
  const twice = mergeGame(mergeGame(prev, { ok: false, error: 'HTTP 403' }, 'tuesday'), { ok: false, error: 'timeout' }, 'wednesday');
  assert.deepEqual(twice, { next: { annuity: 1, cash: 1 }, fetchedAt: 'monday', lastError: 'timeout', lastErrorAt: 'wednesday' });
});

test('a failed fetch with nothing good to keep is just the error', () => {
  assert.deepEqual(mergeGame(undefined, { ok: false, error: 'HTTP 403' }, 'now'), { error: 'HTTP 403' });
  assert.deepEqual(mergeGame({ error: 'earlier' }, { ok: false, error: 'HTTP 403' }, 'now'), { error: 'HTTP 403' });
});

// Fixture edits. Each plants one problem in an otherwise real response.
const home = fixture('powerball-home.html');
const mmWith = (change) => {
  const d = JSON.parse(JSON.parse(fixture('megamillions-latest.json')).d);
  change(d);
  return JSON.stringify({ d: JSON.stringify(d) });
};
const thrown = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail('expected a throw');
};

test('powerball.com home page missing only its annuity figure fails rather than reading the cash value', () => {
  // The cash figure sits right below, so a search that runs past "Cash Value" reads it as the jackpot.
  const planted = home.replace('<span class="game-jackpot-number text-xxxl lh-1 text-center">$516 Million</span>', '');
  assert.notEqual(planted, home);
  assert.throws(() => parsePowerballHome(planted), /no figure after "Estimated Jackpot"/);
});

test("powerball.com home page missing only its cash figure fails rather than reading the next card's number", () => {
  // A figure just past the cash group, as another card's would be: inside a fixed window, outside the group.
  const planted = home
    .replace('<span class="game-jackpot-number text-lg lh-1 text-center">$211.6 Million</span>', '')
    .replace('<div class="col" id="winners">', '<div class="col" id="winners"><span class="game-jackpot-number">$2 Million</span>');
  assert.equal(planted.match(/game-jackpot-number/g).length, 2);
  assert.throws(() => parsePowerballHome(planted), /no figure after "Cash Value"/);
});

test('powerball.com home page with "Cash Value" only before "Estimated Jackpot" fails', () => {
  const planted = home.replace(/Cash Value/, 'Prize').replace('Next Drawing', 'Cash Value');
  assert.throws(() => parsePowerballHome(planted), /no "Cash Value" label after "Estimated Jackpot"/);
});

test('powerball.com home page: the next draw time comes only from the next-drawing card', () => {
  const missing = home.replace('data-drawdateutc="2026-10-11T02:59:00.0000000Z"', '');
  assert.throws(() => parsePowerballHome(missing), /no draw time in the "next-drawing" card/);
  // Another card's countdown further down must not stand in for it.
  const elsewhere = missing.replace('<div class="col" id="winners">', '<div class="col" id="winners"><div data-drawdateutc="2026-10-14T02:59:00Z"></div>');
  assert.throws(() => parsePowerballHome(elsewhere), /no draw time in the "next-drawing" card/);
  const local = home.replace('2026-10-11T02:59:00.0000000Z', '2026-10-10T22:59:00');
  assert.throws(() => parsePowerballHome(local), /not a UTC draw time: "2026-10-10T22:59:00"/);
});

test('Eastern wall time is read with the offset in force on that date', () => {
  assert.equal(easternWallTime('2026-10-09T23:00:00'), '2026-10-10T03:00:00.000Z', 'EDT');
  // Daylight time ends 2026-11-01. The draws either side of it are an hour apart in UTC.
  assert.equal(easternWallTime('2026-10-30T23:00:00'), '2026-10-31T03:00:00.000Z', 'Friday before, EDT');
  assert.equal(easternWallTime('2026-11-03T23:00:00'), '2026-11-04T04:00:00.000Z', 'Tuesday after, EST');
  assert.equal(easternWallTime('2027-01-15T23:00:00.000'), '2027-01-16T04:00:00.000Z', 'winter, fractional seconds');
  assert.equal(easternWallTime('2026-03-10T23:00:00'), '2026-03-11T03:00:00.000Z', 'after the March change');
  // A zone on the text means it is not wall time; 2:30 AM on 2026-03-08 does not exist in New York.
  for (const bad of ['2026-10-09T23:00:00Z', '2026-10-09T23:00:00-04:00', '2026-10-09', 'Fri, Oct 9', '2026-03-08T02:30:00', undefined]) {
    assert.throws(() => easternWallTime(bad), /not an Eastern wall time/, String(bad));
  }
});

test('a draw time that has passed is refused; one still ahead is not', () => {
  const rec = { nextDrawAt: '2026-10-10T03:00:00.000Z' };
  // 01:30 UTC on the 10th is 9:30 PM on the 9th in New York: draw night, and the draw is still ahead.
  assert.doesNotThrow(() => refusePastDraw(rec, new Date('2026-10-10T01:30:00Z')));
  assert.doesNotThrow(() => refusePastDraw(rec, new Date('2026-10-10T02:59:59.999Z')));
  assert.throws(() => refusePastDraw(rec, new Date('2026-10-10T03:00:00Z')), /next draw 2026-10-10T03:00:00.000Z has already happened/);
  assert.throws(() => refusePastDraw(rec, new Date('2026-10-12T10:23:00Z')), /already happened/);
  assert.throws(() => refusePastDraw({}, new Date('2026-10-10T01:30:00Z')), /no next draw time/);
  assert.throws(() => refusePastDraw({ nextDrawAt: 'soon' }, new Date('2026-10-10T01:30:00Z')), /no next draw time/);
});

test('Mega Millions figures must belong to the draw the site names as the last one', () => {
  const ahead = mmWith((d) => { d.Drawing.PlayDate = '2026-10-09T00:00:00'; });
  assert.throws(() => parseMegaMillions(ahead), /jackpot figures are for "2026-10-06", the last draw is "2026-10-09"/);
  const noDate = mmWith((d) => { delete d.Jackpot.PlayDate; });
  assert.throws(() => parseMegaMillions(noDate), /jackpot figures are for undefined, the last draw is "2026-10-06"/);
  // Both missing is not a match.
  const neither = mmWith((d) => { delete d.Jackpot.PlayDate; delete d.Drawing.PlayDate; });
  assert.throws(() => parseMegaMillions(neither), /jackpot figures are for undefined, the last draw is undefined/);
  // Verified is read but not enforced until live data shows when it flips.
  assert.equal(parseMegaMillions(mmWith((d) => { d.Jackpot.Verified = false; })).jackpotVerified, false);
  assert.throws(() => parseMegaMillions(mmWith((d) => { delete d.NextDrawingDate; })), /megamillions.com: NextDrawingDate: not an Eastern wall time/);
});

test("the site's Mega Millions ball ranges agree with prng.js, and a change is reported", () => {
  const mm = parseMegaMillions(fixture('megamillions-latest.json'));
  assert.deepEqual(mm.ballRanges, { white: 70, mega: 24 });
  assert.deepEqual(megaMillionsTableDrift(mm, PAYOUTS, GAMES), []);
  // The April 2025 change was the gold ball, 25 to 24. The prize table does not have to move with it.
  const mega = megaMillionsTableDrift(parseMegaMillions(mmWith((d) => { d.PrizeMatrix.MegaBallMax = 25; })), PAYOUTS, GAMES);
  assert.deepEqual(mega, ['Mega Ball range: site 1 to 25, prng.js 1 to 24']);
  const white = megaMillionsTableDrift(parseMegaMillions(mmWith((d) => { d.PrizeMatrix.WhiteBallMax = 69; })), PAYOUTS, GAMES);
  assert.deepEqual(white, ['White balls range: site 1 to 69, prng.js 1 to 70']);
  const gone = megaMillionsTableDrift(parseMegaMillions(mmWith((d) => { delete d.PrizeMatrix.WhiteBallMax; })), PAYOUTS, GAMES);
  assert.deepEqual(gone, ['White balls range: site 1 to undefined, prng.js 1 to 70']);
});

test('scraped values in error and drift messages are quoted, so a newline cannot start a log line', () => {
  const err = thrown(() => parseMegaMillions(mmWith((d) => { d.Jackpot.NextPrizePool = '0\n::warning title=planted::x'; })));
  assert.match(err.message, /NextPrizePool missing or not positive: "0\\n::warning/);
  assert.doesNotMatch(err.message, /[\r\n]/);

  // A carriage return alone, in a date captured as free text.
  const results = { ...parsePowerballLastDraw(fixture('powerball-latest-draw.html')), drawDate: 'Wed, Oct 7,\r::error::x 2026' };
  assert.doesNotMatch(thrown(() => combinePowerball(parsePowerballHome(home), results)).message, /[\r\n]/);

  const mm = parseMegaMillions(mmWith((d) => {
    d.PrizeMatrix.PrizeTiers[1].TierWhiteBall = '\n::error::x';
    d.PrizeMatrix.TicketPrice = '\n::error::y';
    d.PrizeMatrix.PrizeTiers[2].Mega2 = '\r\n::error::z';
    d.PrizeMatrix.MegaBallMax = '\n::error::w';
  }));
  const drift = megaMillionsTableDrift(mm, PAYOUTS, GAMES);
  for (const planted of ['x', 'y', 'z', 'w']) assert.ok(drift.some((line) => line.includes(`::error::${planted}`)), `${planted}: ${drift.join(' | ')}`);
  for (const line of drift) assert.doesNotMatch(line, /[\r\n]/);
});

// The plausibility gate. Records as main() builds them, from today's fixtures.
const pbRecord = () => ({
  ...combinePowerball(parsePowerballHome(home), parsePowerballLastDraw(fixture('powerball-latest-draw.html'))),
  estimatedTicketsSold: 18307692,
});
const mmRecord = () => {
  const mm = parseMegaMillions(fixture('megamillions-latest.json'));
  return { last: mm.last, next: mm.next, lastDrawJackpotWinners: mm.lastDrawJackpotWinners, estimatedTicketsSold: 5573652 };
};

test("today's figures pass the plausibility gate unchanged", () => {
  assert.deepEqual(checkFigures('powerball', pbRecord()), pbRecord());
  assert.deepEqual(checkFigures('megamillions', mmRecord()), mmRecord());
});

test('implausible figures are refused', () => {
  const planted = [
    // [what, game, change, message]
    ['Mega Millions reported in millions', 'megamillions', (r) => { r.next = { annuity: 364, cash: 147.3 }; }, /next: annuity 364 is outside 20000000 to 5000000000/],
    ['cash and annuity swapped', 'powerball', (r) => { r.next = { annuity: 211.6e6, cash: 516e6 }; }, /next: needs annuity > cash > 0, got annuity 211600000, cash 516000000/],
    ['cash equal to annuity', 'powerball', (r) => { r.last = { annuity: 485e6, cash: 485e6 }; }, /last: needs annuity > cash > 0/],
    ['a missing figure', 'megamillions', (r) => { r.next = { annuity: 364e6, cash: null }; }, /next: needs annuity > cash > 0/],
    ['no last figures at all', 'megamillions', (r) => { delete r.last; }, /last: missing/],
    ['NaN', 'powerball', (r) => { r.next.annuity = NaN; }, /next: needs annuity > cash > 0/],
    ['cash too close to the annuity', 'powerball', (r) => { r.next.cash = 0.9 * r.next.annuity; }, /next: cash is 0.9 of the annuity, outside 0.2 to 0.9/],
    ['cash too small a share', 'megamillions', (r) => { r.last.cash = 0.2 * r.last.annuity; }, /last: cash is 0.2 of the annuity/],
    ['a units slip on the cash only', 'powerball', (r) => { r.next.cash = 21.16e6; }, /next: cash is 0.041 of the annuity/],
    ['an annuity over $5 billion', 'powerball', (r) => { r.next = { annuity: 5.16e11, cash: 2.116e11 }; }, /next: annuity 516000000000 is outside/],
    ['an annuity under $20 million', 'powerball', (r) => { r.last = { annuity: 19.9e6, cash: 9e6 }; }, /last: annuity 19900000 is outside/],
    ['cash fell with no winner', 'powerball', (r) => { r.next = { annuity: 480e6, cash: 199.6e6 }; }, /next cash 199600000 is below last cash 199700000, and the jackpot was not won/],
    ['cash fell, jackpot at exactly twice the start', 'powerball', (r) => { r.next = { annuity: 40e6, cash: 18e6 }; }, /was not won/],
    ['cash fell, Mega Millions at twice its $50M start, no winners', 'megamillions', (r) => { r.next = { annuity: 100e6, cash: 45e6 }; r.lastDrawJackpotWinners = 0; }, /was not won/],
  ];
  for (const [what, game, change, message] of planted) {
    const r = game === 'powerball' ? pbRecord() : mmRecord();
    change(r);
    assert.throws(() => checkFigures(game, r), message, what);
  }
});

test('a won jackpot may reset: the cash value falls', () => {
  const reset = { ...pbRecord(), next: { annuity: 20e6, cash: 9.2e6 }, estimatedTicketsSold: null };
  assert.deepEqual(checkFigures('powerball', reset), reset);
  assert.doesNotThrow(() => checkFigures('powerball', { ...reset, next: { annuity: 39.9e6, cash: 18e6 } }));
  // Mega Millions says how many won, so a reset above twice the start still counts.
  const won = { ...mmRecord(), next: { annuity: 120e6, cash: 54e6 }, lastDrawJackpotWinners: 1, estimatedTicketsSold: null };
  assert.deepEqual(checkFigures('megamillions', won), won);
  // Its own start is $50M, not Powerball's $20M: $60M is still a reset even before Winners catches up.
  assert.doesNotThrow(() => checkFigures('megamillions', { ...won, next: { annuity: 60e6, cash: 27e6 }, lastDrawJackpotWinners: 0 }));
});

test('a sales estimate outside half a million to a billion plays is dropped, not fatal', () => {
  // A cash rise of one rounding step ($0.1M) reads as about 154,000 Powerball plays: noise, not sales.
  for (const [sold, kept] of [[153846, null], [499999, null], [5e5, 5e5], [18307692, 18307692], [1e9, 1e9], [1e9 + 1, null], [-5, null]]) {
    assert.equal(checkFigures('powerball', { ...pbRecord(), estimatedTicketsSold: sold }).estimatedTicketsSold, kept, String(sold));
  }
});
