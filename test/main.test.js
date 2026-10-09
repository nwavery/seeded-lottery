// The unattended run end to end: main() against stubbed sites, writing to a temporary file. Nothing here
// touches the network or the committed jackpots.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main, loadJackpotsScript, checkJackpotsData, readPrevious, URLS } = require('../fetch-jackpots.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const mmWith = (change) => {
  const d = JSON.parse(JSON.parse(fixture('megamillions-latest.json')).d);
  change(d);
  return JSON.stringify({ d: JSON.stringify(d) });
};

// When the fixtures were saved: both games' next draws are still ahead.
const SAVED = new Date('2026-10-09T22:18:18.301Z');
const LATER = new Date('2026-10-10T01:30:00Z');

/**
 * Runs main() once against stubbed sites. `sites` overrides a URL's response: a body string, an Error to
 * throw, a Response, or a function of the call count (1, 2, 3) returning any of those.
 */
async function run({ sites = {}, previous = null, now = SAVED } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seeded-lottery-main-'));
  const file = path.join(dir, 'jackpots.js');
  if (previous != null) fs.writeFileSync(file, previous);
  const bodies = {
    [URLS.powerballHome]: fixture('powerball-home.html'),
    [URLS.powerballLastDraw]: fixture('powerball-latest-draw.html'),
    [URLS.megaMillions]: fixture('megamillions-latest.json'),
    ...sites,
  };
  const calls = [];
  const sleeps = [];
  const lines = [];
  const fetch = async (url) => {
    calls.push(url);
    let r = bodies[url];
    if (typeof r === 'function') r = r(calls.filter((u) => u === url).length);
    if (r instanceof Error) throw r;
    return r instanceof Response ? r : new Response(r, { status: 200 });
  };
  const exitBefore = process.exitCode;
  const code = await main({ fetch, sleep: async (ms) => { sleeps.push(ms); }, file, now, log: (line) => lines.push(line) });
  assert.equal(process.exitCode, exitBefore, 'main() returns its exit code; only the command-line wrapper sets it');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  fs.rmSync(dir, { recursive: true });
  return { code, text, data: text == null ? null : loadJackpotsScript(text), calls, sleeps, lines };
}

const forbidden = (status) => new Response('Forbidden', { status });

test('first run, both sites good: exit 0 and a file the page can read', async () => {
  const { code, text, data, sleeps, lines } = await run();
  assert.equal(code, 0, lines.join('\n'));
  assert.deepEqual(sleeps, []);
  assert.equal(data.fetchedAt, SAVED.toISOString());
  const pb = data.games.powerball;
  assert.deepEqual([pb.next, pb.last], [{ annuity: 516e6, cash: 211.6e6 }, { annuity: 485e6, cash: 199.7e6 }]);
  assert.equal(pb.nextDrawAt, '2026-10-11T02:59:00.000Z');
  assert.equal(pb.estimatedTicketsSold, 18307692);
  assert.equal(pb.fetchedAt, SAVED.toISOString());
  const mm = data.games.megamillions;
  assert.deepEqual([mm.next, mm.last], [{ annuity: 364e6, cash: 147.3e6 }, { annuity: 345e6, cash: 139.6e6 }]);
  assert.equal(mm.nextDrawAt, '2026-10-10T03:00:00.000Z');
  assert.deepEqual(mm.prizeTableDrift, []);
  // Read back the page's way and the next run's way, and they agree.
  assert.doesNotThrow(() => checkJackpotsData(data));
  assert.deepEqual(readPrevious(text), data);
  assert.ok(lines.some((l) => l.startsWith('powerball: next $516.0M')), lines.join('\n'));
});

test('one site failing keeps its last good figures and exits 1; the other still updates', async () => {
  const first = await run();
  const { code, data, sleeps, calls } = await run({ previous: first.text, now: LATER, sites: { [URLS.powerballHome]: forbidden(403) } });
  assert.equal(code, 1);
  const pb = data.games.powerball;
  assert.deepEqual(pb.next, { annuity: 516e6, cash: 211.6e6 });
  assert.equal(pb.fetchedAt, SAVED.toISOString(), 'kept figures keep their own date');
  assert.match(pb.lastError, /powerball\.com\/: HTTP 403 \(after 3 tries\)/);
  assert.equal(pb.lastErrorAt, LATER.toISOString());
  assert.equal(data.games.megamillions.fetchedAt, LATER.toISOString());
  assert.equal(data.games.megamillions.lastError, undefined);
  // Two retries for the failing page, 2 s then 5 s; none for the pages that answered.
  assert.deepEqual(sleeps, [2000, 5000]);
  assert.equal(calls.filter((u) => u === URLS.powerballHome).length, 3);
  assert.equal(calls.filter((u) => u === URLS.megaMillions).length, 1);
  assert.doesNotThrow(() => checkJackpotsData(data));
});

test('both sites failing exits 1, keeping both games when there is something to keep', async () => {
  const first = await run();
  const down = { [URLS.powerballLastDraw]: new TypeError('fetch failed'), [URLS.megaMillions]: forbidden(503) };
  const kept = await run({ previous: first.text, now: LATER, sites: down });
  assert.equal(kept.code, 1);
  for (const id of ['powerball', 'megamillions']) {
    assert.equal(kept.data.games[id].fetchedAt, SAVED.toISOString(), id);
    assert.ok(kept.data.games[id].lastError, id);
  }
  assert.match(kept.data.games.powerball.lastError, /fetch failed \(after 3 tries\)/);
  assert.doesNotThrow(() => checkJackpotsData(kept.data));

  // With no earlier file, each game is just its error, and the page asks for the figures by hand.
  const fresh = await run({ sites: down });
  assert.equal(fresh.code, 1);
  assert.deepEqual(Object.keys(fresh.data.games.powerball), ['error']);
  assert.deepEqual(Object.keys(fresh.data.games.megamillions), ['error']);
  assert.doesNotThrow(() => checkJackpotsData(fresh.data));
});

test('a reset jackpot is published, with no sales estimate', async () => {
  const reset = fixture('powerball-home.html').replace('$516 Million', '$20 Million').replace('$211.6 Million', '$9.2 Million');
  const { code, data } = await run({ sites: { [URLS.powerballHome]: reset } });
  assert.equal(code, 0);
  assert.deepEqual(data.games.powerball.next, { annuity: 20e6, cash: 9.2e6 });
  assert.equal(data.games.powerball.estimatedTicketsSold, null);
});

test('implausible figures count as a failed fetch: the last good ones stay', async () => {
  const first = await run();
  const inMillions = mmWith((d) => { d.Jackpot.NextPrizePool = 364; d.Jackpot.NextCashValue = 147.3; });
  const { code, data } = await run({ previous: first.text, now: LATER, sites: { [URLS.megaMillions]: inMillions } });
  assert.equal(code, 1);
  assert.deepEqual(data.games.megamillions.next, { annuity: 364e6, cash: 147.3e6 });
  assert.match(data.games.megamillions.lastError, /implausible figures: next: annuity 364 is outside/);
  assert.equal(data.games.powerball.lastError, undefined);
});

test('prize table drift alone exits 2, still publishing; with a failed fetch, 3', async () => {
  const drifted = mmWith((d) => { d.PrizeMatrix.WhiteBallMax = 69; });
  const alone = await run({ sites: { [URLS.megaMillions]: drifted } });
  assert.equal(alone.code, 2);
  assert.deepEqual(alone.data.games.megamillions.prizeTableDrift, ['White balls range: site 1 to 69, prng.js 1 to 70']);
  assert.equal(alone.data.games.megamillions.fetchedAt, SAVED.toISOString());
  assert.ok(alone.lines.some((l) => l.includes('White balls range: site 1 to 69')), alone.lines.join('\n'));

  const both = await run({ sites: { [URLS.megaMillions]: drifted, [URLS.powerballHome]: forbidden(403) } });
  assert.equal(both.code, 3);
  // Drift found while the figures themselves are refused still turns the run red for drift.
  const refused = await run({ sites: { [URLS.megaMillions]: mmWith((d) => { d.PrizeMatrix.MegaBallMax = 25; d.Jackpot.NextCashValue = 1; }) } });
  assert.equal(refused.code, 3);
});

test('figures for a draw that has already happened are refused', async () => {
  // Draw night in New York, 9:30 PM: both draws are still ahead.
  assert.equal((await run({ now: LATER })).code, 0);
  // 11 PM Eastern on the 9th: the Mega Millions draw has started, so its site has not moved on.
  const { code, data } = await run({ now: new Date('2026-10-10T03:00:00Z') });
  assert.equal(code, 1);
  assert.match(data.games.megamillions.error, /next draw 2026-10-10T03:00:00.000Z has already happened/);
  assert.equal(data.games.powerball.error, undefined);
});

test('a run across the end of daylight time reads the Mega Millions draw at the right hour', async () => {
  // Tuesday 2026-11-03, 11 PM EST, is 04:00 UTC. Read with October's offset it would be 03:00 and refused here.
  const after = mmWith((d) => { d.NextDrawingDate = '2026-11-03T23:00:00'; });
  const tuesday = await run({ now: new Date('2026-11-04T03:30:00Z'), sites: { [URLS.megaMillions]: after } });
  assert.equal(tuesday.data.games.megamillions.error, undefined, tuesday.data.games.megamillions.error);
  assert.equal(tuesday.data.games.megamillions.nextDrawAt, '2026-11-04T04:00:00.000Z');
  const late = await run({ now: new Date('2026-11-04T04:00:00Z'), sites: { [URLS.megaMillions]: after } });
  assert.match(late.data.games.megamillions.error, /already happened/);
  // Friday 2026-10-30, 11 PM EDT, is 03:00 UTC. Read with November's offset it would still look ahead.
  const before = mmWith((d) => { d.NextDrawingDate = '2026-10-30T23:00:00'; });
  const friday = await run({ now: new Date('2026-10-31T03:30:00Z'), sites: { [URLS.megaMillions]: before } });
  assert.match(friday.data.games.megamillions.error, /next draw 2026-10-31T03:00:00.000Z has already happened/);
});

test('a site that fails twice and then answers is a good fetch', async () => {
  const flaky = (n) => (n < 3 ? forbidden(503) : fixture('megamillions-latest.json'));
  const { code, sleeps, calls } = await run({ sites: { [URLS.megaMillions]: flaky } });
  assert.equal(code, 0);
  assert.deepEqual(sleeps, [2000, 5000]);
  assert.equal(calls.filter((u) => u === URLS.megaMillions).length, 3);
});

test('scraped text cannot start a workflow command in the log', async () => {
  // The JSON.parse error quotes the body raw, newline and all.
  const planted = {
    [URLS.megaMillions]: '\n::error::x',
    [URLS.powerballLastDraw]: fixture('powerball-latest-draw.html').replace('Wed, Oct 7, 2026', 'Wed, Oct 7,\r::warning::y 2026'),
  };
  const { code, lines } = await run({ sites: planted });
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.includes('::error::x')), `the planted text should be printed, harmlessly: ${lines.join(' | ')}`);
  assert.ok(lines.some((l) => l.includes('::warning::y')), lines.join(' | '));
  // A bare carriage return also ends a line for the runner.
  const cr = await run({ sites: { [URLS.megaMillions]: '\r::error::v' } });
  assert.ok(cr.lines.some((l) => l.includes('::error::v')), cr.lines.join(' | '));
  for (const line of [...lines, ...cr.lines]) {
    assert.doesNotMatch(line, /[\r\n]/, JSON.stringify(line));
    assert.ok(!line.trimStart().startsWith('::'), JSON.stringify(line));
  }
});

test('an unverified Mega Millions jackpot is published with a warning', async () => {
  const { code, lines } = await run({ sites: { [URLS.megaMillions]: mmWith((d) => { d.Jackpot.Verified = false; }) } });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => /megamillions: warning: the site has not marked these jackpot figures verified/.test(l)), lines.join('\n'));
});
