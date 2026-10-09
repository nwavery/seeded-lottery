const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GAMES } = require('../prng.js');
const { PAYOUTS, expectedMultiplier, tierProbability, expectedJackpotShare, estimateTicketsSold, expectedReturn } = require('../roi.js');

/** Within `rel` of expected, or within `abs` when expected is zero or near it. */
const close = (actual, expected, rel, what, abs = 0) =>
  assert.ok(Math.abs(actual - expected) <= Math.max(Math.abs(expected) * rel, abs), `${what}: ${actual} not within ${rel * 100}% of ${expected}`);

const fixtureText = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const dollars = (s) => Number(s.replace(/[$,]/g, '').replace(/ Million$/, '')) * (/ Million$/.test(s) ? 1e6 : 1);

// The official Powerball chart, read from the saved page. Rows come in odds order, and each row is the
// base prize then the 2x, 3x, 4x, 5x and 10x Power Play prizes. The odds section pairs a prize with its odds.
const POWERBALL_CHART = (() => {
  const text = fixtureText('powerball-prize-chart.html');
  const table = text.slice(text.indexOf('Prize Chart Match'), text.indexOf('Powerball® Odds'));
  const cells = [...table.matchAll(/\$[\d,]+(?: Million)?/g)].map((m) => dollars(m[0]));
  const odds = [...text.slice(text.indexOf('Powerball® Odds')).matchAll(/(\$[\d,]+(?: Million)?) 1 in ([\d,.]+)/g)]
    .map((m) => ({ prize: dollars(m[1]), odds: Number(m[2].replace(/,/g, '')) }));
  assert.equal(cells.length, 8 * 6, 'chart: expected 8 fixed-prize rows of 6 columns');
  assert.equal(odds.length, 8, 'chart: expected 8 prize-and-odds pairs');
  return odds.map((o, i) => ({ ...o, byMultiplier: { 1: cells[i * 6], 2: cells[i * 6 + 1], 3: cells[i * 6 + 2], 4: cells[i * 6 + 3], 5: cells[i * 6 + 4], 10: cells[i * 6 + 5] } }));
})();

// Mega Millions' own prize matrix, from the saved endpoint response: payable prizes at each multiplier.
const MEGA_MATRIX = JSON.parse(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'megamillions-latest.json'), 'utf8')).d).PrizeMatrix.PrizeTiers;

// Published "1 in N" odds per tier, from each game's own site.
const PUBLISHED_ODDS = {
  powerball: { '5+0': 11688053.52, '4+1': 913129.18, '4+0': 36525.17, '3+1': 14494.11, '3+0': 579.76, '2+1': 701.33, '1+1': 91.98, '0+1': 38.32 },
  megamillions: { '5+0': 12629232, '4+1': 893761, '4+0': 38859, '3+1': 13965, '3+0': 607, '2+1': 665, '1+1': 86, '0+1': 35 },
};
const PUBLISHED_JACKPOT_ODDS = { powerball: 292201338, megamillions: 290472336 };

for (const id of ['powerball', 'megamillions']) {
  test(`${id}: every prize tier matches its published odds`, () => {
    assert.deepEqual(Object.keys(PAYOUTS[id].prizes).sort(), Object.keys(PUBLISHED_ODDS[id]).sort());
    // Powerball publishes two decimals, so it may be up to 0.005 out; Mega Millions rounds to whole numbers.
    for (const [tier, odds] of Object.entries(PUBLISHED_ODDS[id])) {
      const [w, b] = tier.split('+').map(Number);
      const ours = 1 / tierProbability(GAMES[id], w, b === 1);
      if (id === 'powerball') assert.ok(Math.abs(ours - odds) <= 0.005, `${id} ${tier}: ${ours} vs ${odds}`);
      else assert.ok(Math.abs(ours - odds) <= 0.5, `${id} ${tier}: ${ours} vs ${odds}`);
    }
  });
}

test('overall odds of any prize match the published tier odds', () => {
  for (const id of ['powerball', 'megamillions']) {
    const fromPublished = 1 / Object.values(PUBLISHED_ODDS[id]).concat(PUBLISHED_JACKPOT_ODDS[id]).reduce((s, o) => s + 1 / o, 0);
    const r = expectedReturn({ play: id, jackpot: 0, advertisedJackpot: 0, ticketsSold: null, taxRate: 0 });
    // Rounding in the published odds compounds across nine tiers.
    close(r.anyPrizeOdds, fromPublished, id === 'powerball' ? 1e-4 : 0.003, id);
  }
  // And the headline figures the sites print: 1 in 24.87 and 1 in 23.
  const pb = expectedReturn({ play: 'powerball', jackpot: 0, advertisedJackpot: 0, ticketsSold: null, taxRate: 0 });
  assert.equal(pb.anyPrizeOdds.toFixed(2), '24.87');
});

test('multipliers: Mega Millions averages 3x, Power Play 119/43 up to a $150M jackpot and 109/42 above it', () => {
  assert.equal(expectedMultiplier('megamillions', 1e9), 3);
  assert.equal(expectedMultiplier('powerball', 1e9), 1);
  close(expectedMultiplier('powerballPowerPlay', 150e6), 119 / 43, 1e-12, 'at the boundary, 10x is in play');
  close(expectedMultiplier('powerballPowerPlay', 150e6 + 1), 109 / 42, 1e-12, 'one dollar over, it is not');
  close(expectedMultiplier('powerballPowerPlay', 20e6), 119 / 43, 1e-12, 'starting jackpot');
  for (const play of Object.keys(PAYOUTS)) {
    for (const adv of [20e6, 150e6, 151e6, 2e9]) {
      close(PAYOUTS[play].multipliers(adv).reduce((s, [, p]) => s + p, 0), 1, 1e-12, `${play} probabilities at ${adv}`);
    }
  }
});

test('Powerball fixed prizes are worth what the official chart pays, with and without Power Play', () => {
  // Built from the chart's own rows and odds, so a wrong prize, a wrong flat $2M, or a multiplier applied to
  // the wrong tier in roi.js all show up here.
  const fromChart = (multipliers) => POWERBALL_CHART.reduce(
    (sum, row) => sum + multipliers.reduce((s, [m, p]) => s + p * row.byMultiplier[m], 0) / row.odds, 0);
  const at = (play, adv) => expectedReturn({ play, jackpot: 0, advertisedJackpot: adv, ticketsSold: null, taxRate: 0 }).fixedPrizes;
  // 1e-4 covers the chart's two-decimal odds; a wrong prize anywhere moves the total by far more.
  close(at('powerball', 5e8), fromChart([[1, 1]]), 1e-4, 'base');
  close(at('powerballPowerPlay', 1e8), fromChart([[10, 1 / 43], [5, 2 / 43], [4, 3 / 43], [3, 13 / 43], [2, 24 / 43]]), 1e-4, 'Power Play, 10x in play');
  close(at('powerballPowerPlay', 5e8), fromChart([[5, 2 / 42], [4, 3 / 42], [3, 13 / 42], [2, 24 / 42]]), 1e-4, 'Power Play, no 10x');
});

test("Mega Millions fixed prizes are worth what the site's prize matrix pays", () => {
  const dist = [[2, 15 / 32], [3, 10 / 32], [4, 4 / 32], [5, 2 / 32], [10, 1 / 32]];
  const fromMatrix = MEGA_MATRIX.filter((t) => !t.IsJackpot)
    .reduce((sum, t) => sum + dist.reduce((s, [m, p]) => s + p * t[`Mega${m}`], 0) / t.Odds, 0);
  const r = expectedReturn({ play: 'megamillions', jackpot: 0, advertisedJackpot: 0, ticketsSold: null, taxRate: 0 });
  close(r.fixedPrizes, fromMatrix, 0.006, 'Mega Millions');
});

test("Powerball prizes match the official prize chart's prize-and-odds pairs", () => {
  for (const [tier, prize] of Object.entries(PAYOUTS.powerball.prizes)) {
    const [w, b] = tier.split('+').map(Number);
    const ours = 1 / tierProbability(GAMES.powerball, w, b === 1);
    const row = POWERBALL_CHART.find((p) => Math.abs(p.odds - ours) < 0.01);
    assert.ok(row, `${tier}: no chart row with odds 1 in ${ours.toFixed(2)}`);
    assert.equal(prize, row.prize, `${tier} prize`);
  }
});

test('Power Play costs a dollar more and never touches the jackpot', () => {
  const at = (play) => expectedReturn({ play, jackpot: 5e8, advertisedJackpot: 1.2e9, ticketsSold: 2e7, taxRate: 0 });
  assert.equal(at('powerballPowerPlay').price, at('powerball').price + 1);
  assert.equal(at('powerballPowerPlay').jackpotPart, at('powerball').jackpotPart);
  assert.ok(at('powerballPowerPlay').fixedPrizes > at('powerball').fixedPrizes);
});

test('the jackpot is worth jackpot / jackpot odds when nobody else plays', () => {
  const r = expectedReturn({ play: 'powerball', jackpot: 292201338, advertisedJackpot: 7e8, ticketsSold: null, taxRate: 0 });
  close(r.jackpotPart, 1, 1e-9, 'jackpot part');
  assert.equal(r.jackpotShare, 1);
});

test('expected jackpot share is E[1/(1+K)] for Poisson K', () => {
  assert.equal(expectedJackpotShare(0), 1);
  for (const λ of [1e-12, 0.01, 0.5, 1, 3, 20]) {
    // Sum the series directly rather than trusting the closed form.
    let sum = 0, pmf = Math.exp(-λ);
    for (let k = 0; k < 200; k++) {
      sum += pmf / (1 + k);
      pmf *= λ / (k + 1);
    }
    close(expectedJackpotShare(λ), sum, 1e-9, `λ = ${λ}`);
  }
  assert.throws(() => expectedJackpotShare(-1), /must be >= 0, got -1/);
  assert.throws(() => expectedJackpotShare(NaN), /must be >= 0, got NaN/);
});

test('more tickets sold means a smaller expected share', () => {
  const at = (sold) => expectedReturn({ play: 'powerball', jackpot: 1e9, advertisedJackpot: 2e9, ticketsSold: sold, taxRate: 0 });
  const shares = [1, 1e6, 1e7, 1e8, 1e9].map((s) => at(s).jackpotShare);
  for (let i = 1; i < shares.length; i++) assert.ok(shares[i] < shares[i - 1], `share did not fall: ${shares}`);
  assert.equal(at(1).jackpotShare, 1, 'a single ticket shares with nobody');
});

test('ticket sales are estimated from cash growth over the jackpot share', () => {
  // Powerball, Oct 7 to Oct 10 2026: cash $199.7M to $211.6M; 32.5% of each $2 base play funds it.
  assert.equal(estimateTicketsSold('powerball', 199.7e6, 211.6e6), 18307692);
  // Mega Millions, Oct 6 to Oct 9 2026: cash $139.6M to $147.3M; 27.63% of each $5 play.
  assert.equal(estimateTicketsSold('megamillions', 139.6e6, 147.3e6), 5573652);
  assert.throws(() => estimateTicketsSold('powerballPowerPlay', 1e8, 2e8), /not a base play/);
});

test('no sales estimate across a reset jackpot or a missing figure', () => {
  assert.equal(estimateTicketsSold('powerball', 900e6, 9e6), null, 'jackpot won: cash fell');
  assert.equal(estimateTicketsSold('powerball', 100e6, 100e6), null, 'no growth');
  assert.equal(estimateTicketsSold('powerball', null, 100e6), null);
  assert.equal(estimateTicketsSold('powerball', 100e6, undefined), null);
});

test('tax scales every prize', () => {
  const r = (tax) => expectedReturn({ play: 'megamillions', jackpot: 5e8, advertisedJackpot: 1.2e9, ticketsSold: 1e7, taxRate: tax });
  close(r(0.4).expected, r(0).expected * 0.6, 1e-12, 'expected');
  close(r(0.4).fixedPrizes + r(0.4).jackpotPart, r(0.4).expected, 1e-12, 'parts sum');
});

test('the break-even jackpot breaks even', () => {
  for (const play of Object.keys(PAYOUTS)) {
    for (const [sold, tax] of [[null, 0], [2e7, 0.37], [5e6, 0.45]]) {
      const base = { play, advertisedJackpot: 5e8, ticketsSold: sold, taxRate: tax };
      const { breakEvenJackpot } = expectedReturn({ ...base, jackpot: 1e8 });
      // ROI is zero there, so the tolerance has to be absolute.
      close(expectedReturn({ ...base, jackpot: breakEvenJackpot }).roi, 0, 0, `${play} ${sold} ${tax}`, 1e-12);
    }
  }
});

test('the break-even jackpot breaks even at the multiplier that applies there', () => {
  // Today's jackpot can be $150M or less, where Power Play's 10x is in play, but the break-even figure is
  // always above $150M, where it is not. Recompute ROI with the break-even figure as the advertised jackpot,
  // as a reader of the page would if the jackpot reached it: annuity payout, and cash at a 0.45 cash ratio.
  for (const play of Object.keys(PAYOUTS)) {
    for (const today of [20e6, 100e6, 150e6, 151e6, 5e8]) {
      for (const [sold, tax] of [[null, 0], [1.2e7, 0.37]]) {
        const base = { play, ticketsSold: sold, taxRate: tax };
        const annuity = expectedReturn({ ...base, jackpot: today, advertisedJackpot: today }).breakEvenJackpot;
        close(expectedReturn({ ...base, jackpot: annuity, advertisedJackpot: annuity }).roi, 0, 0, `${play} annuity, today ${today}, ${sold} ${tax}`, 1e-12);
        const cash = expectedReturn({ ...base, jackpot: today * 0.45, advertisedJackpot: today }).breakEvenJackpot;
        close(expectedReturn({ ...base, jackpot: cash, advertisedJackpot: cash / 0.45 }).roi, 0, 0, `${play} cash, today ${today}, ${sold} ${tax}`, 1e-12);
      }
    }
  }
});

test('the break-even jackpot is always above the $150M where Power Play drops 10x', () => {
  // The break-even prices the fixed prizes without 10x, which holds only while this does. The lowest case
  // is no tax and nobody to share with; anything else raises it. $637M would mean 10x was priced in.
  const { breakEvenJackpot } = expectedReturn({ play: 'powerballPowerPlay', jackpot: 0, advertisedJackpot: 20e6, ticketsSold: null, taxRate: 0 });
  assert.ok(breakEvenJackpot > 150e6, `${breakEvenJackpot}`);
  close(breakEvenJackpot, 648.9e6, 0.001, 'the minimum break-even');
});

test('nonsense inputs are refused', () => {
  const base = { play: 'powerball', jackpot: 1e8, advertisedJackpot: 2.5e8, ticketsSold: null, taxRate: 0.3 };
  assert.throws(() => expectedReturn({ ...base, taxRate: 1 }), /tax rate/);
  assert.throws(() => expectedReturn({ ...base, taxRate: -0.1 }), /tax rate/);
  assert.throws(() => expectedReturn({ ...base, jackpot: -1 }), /jackpot/);
  assert.throws(() => expectedReturn({ ...base, jackpot: NaN }), /jackpot/);
  assert.throws(() => expectedReturn({ ...base, advertisedJackpot: undefined }), /advertised jackpot/);
  assert.throws(() => expectedReturn({ ...base, play: 'lotto' }), /no such play/);
});
