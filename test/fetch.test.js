// The fixtures are the real responses, saved 2026-10-09; nothing here touches the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseDollars, parsePowerballHome, parsePowerballLastDraw, combinePowerball, parseMegaMillions, megaMillionsTableDrift } = require('../fetch-jackpots.js');
const { PAYOUTS } = require('../roi.js');

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
    annuity: 516e6,
    cash: 211.6e6,
  });
});

test('the two Powerball pages combine when they describe the same last draw', () => {
  const pb = combinePowerball(parsePowerballHome(fixture('powerball-home.html')), parsePowerballLastDraw(fixture('powerball-latest-draw.html')));
  assert.deepEqual(pb, {
    lastDrawDate: 'Wed, Oct 7, 2026',
    nextDrawDate: 'Sat, Oct 10, 2026',
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
  assert.equal(mm.ticketPrice, 5);
});

test('megamillions.com endpoint with a missing jackpot fails', () => {
  const body = JSON.parse(fixture('megamillions-latest.json'));
  const d = JSON.parse(body.d);
  d.Jackpot.NextCashValue = null;
  assert.throws(() => parseMegaMillions(JSON.stringify({ d: JSON.stringify(d) })), /NextCashValue/);
});

test("the site's Mega Millions prize table agrees with roi.js", () => {
  assert.deepEqual(megaMillionsTableDrift(parseMegaMillions(fixture('megamillions-latest.json')), PAYOUTS), []);
});

test('a changed Mega Millions prize table is reported', () => {
  const mm = parseMegaMillions(fixture('megamillions-latest.json'));
  // PAYOUTS holds functions, so copy the one entry being changed by hand rather than structuredClone.
  const withMega = (change) => ({ ...PAYOUTS, megamillions: change({ ...PAYOUTS.megamillions, prizes: { ...PAYOUTS.megamillions.prizes } }) });
  const changed = withMega((m) => ({ ...m, price: 2, prizes: { ...m.prizes, '4+0': 600 } }));
  const drift = megaMillionsTableDrift(mm, changed);
  assert.ok(drift.some((d) => d.startsWith('4+0 at 2x')), drift.join('\n'));
  assert.ok(drift.some((d) => d.startsWith('price')), drift.join('\n'));

  const missingTier = withMega((m) => ({ ...m, prizes: { ...m.prizes, '9+9': 1 } }));
  assert.ok(megaMillionsTableDrift(mm, missingTier).some((d) => d.startsWith('9+9')));

  assert.ok(megaMillionsTableDrift({ ...mm, prizeTiers: [] }, PAYOUTS).some((d) => /no prize tiers/.test(d)));
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
