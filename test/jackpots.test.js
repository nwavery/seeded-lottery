// The jackpots.js beside index.html, loaded the way the page loads it. The scheduled workflow runs this file
// on its own straight after a fetch, before anything is committed, so a file the page cannot use stops there.
// It reads no clock: kept figures for a past draw are still a valid file, and the page marks them stale.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadJackpotsScript, checkJackpotsData } = require('../fetch-jackpots.js');

test('jackpots.js loads as a script and holds figures the page can show', () => {
  const data = loadJackpotsScript(fs.readFileSync(path.join(__dirname, '..', 'jackpots.js'), 'utf8'));
  assert.doesNotThrow(() => checkJackpotsData(data));
});

// A good file as the fetcher writes it, to plant problems in.
const good = () => ({
  fetchedAt: '2026-10-09T22:18:18.301Z',
  games: {
    powerball: {
      lastDrawDate: 'Wed, Oct 7, 2026',
      nextDrawDate: 'Sat, Oct 10, 2026',
      nextDrawAt: '2026-10-11T02:59:00.000Z',
      last: { annuity: 485e6, cash: 199.7e6 },
      next: { annuity: 516e6, cash: 211.6e6 },
      estimatedTicketsSold: 18307692,
      fetchedAt: '2026-10-09T22:18:18.301Z',
    },
    megamillions: { error: 'megamillions.com: HTTP 403 (after 3 tries)' },
  },
});

test('the loader runs the file as the browser would, and refuses one that sets nothing', () => {
  const text = `// Written by fetch-jackpots.js; rerun it to refresh.\nwindow.JACKPOTS = ${JSON.stringify(good(), null, 2)};\n`;
  assert.deepEqual(loadJackpotsScript(text), good());
  assert.throws(() => loadJackpotsScript('window.JACKPOT = {};'), /jackpots\.js did not set window\.JACKPOTS/);
  assert.throws(() => loadJackpotsScript('window.JACKPOTS = {'), SyntaxError);
});

test('a jackpots.js the page could not use is refused', () => {
  assert.doesNotThrow(() => checkJackpotsData(good()));
  const planted = [
    // [what, change, message]
    ['no games', (d) => { delete d.games; }, /no games/],
    ['a game missing', (d) => { delete d.games.megamillions; }, /megamillions: missing/],
    ['no run time', (d) => { delete d.fetchedAt; }, /fetchedAt: not an ISO instant/],
    ['figures with no date', (d) => { delete d.games.powerball.fetchedAt; }, /powerball: fetchedAt: not an ISO instant/],
    ['a local time where an instant belongs', (d) => { d.games.powerball.nextDrawAt = '2026-10-10T22:59:00'; }, /powerball: nextDrawAt: not an ISO instant/],
    ['a figure as text', (d) => { d.games.powerball.next.annuity = '516000000'; }, /powerball: implausible figures: next: needs annuity > cash > 0/],
    ['no last draw', (d) => { delete d.games.powerball.last; }, /powerball: implausible figures: last: missing/],
    ['implausible kept figures', (d) => { d.games.powerball.next = { annuity: 211.6e6, cash: 516e6 }; }, /powerball: implausible figures/],
    ['no draw date to print', (d) => { d.games.powerball.nextDrawDate = ''; }, /powerball: nextDrawDate: not a date/],
    ['a sales estimate as text', (d) => { d.games.powerball.estimatedTicketsSold = '18M'; }, /powerball: estimatedTicketsSold: not a number or null/],
    ['an error that is not text', (d) => { d.games.megamillions.error = { code: 403 }; }, /megamillions: error: not text/],
    ['drift that is not a list', (d) => { d.games.powerball.prizeTableDrift = 'changed'; }, /powerball: prizeTableDrift: not a list of text/],
  ];
  for (const [what, change, message] of planted) {
    const d = good();
    change(d);
    assert.throws(() => checkJackpotsData(d), message, what);
  }
  // Files written before nextDrawAt existed have none; the page reads that as an unknown draw time.
  const older = good();
  delete older.games.powerball.nextDrawAt;
  assert.doesNotThrow(() => checkJackpotsData(older));
});
