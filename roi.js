// Expected return on one ticket: the fixed prize tiers, the jackpot, the chance of sharing it, and tax.
//
// Every figure here is an expectation, not an amount anyone is paid, so they are plain floating-point dollars.
// Sources, checked 2026-10-09:
//   Powerball prize chart and odds: powerball.com/powerball-prize-chart
//   Mega Millions prize table, multiplier odds and $5 price: megamillions.com/How-to-Play.aspx
//   Jackpot share of sales: Powerball 32.5% of base sales (Wikipedia, "Powerball"); Mega Millions 27.63%
//   (a Mega Millions spokesperson, quoted by Lottery Geeks after the April 2025 change).
// Loaded as a classic script for the same file:// reason as prng.js.
(function (root) {
  'use strict';

  // The odds come from the same game definitions the draw uses, so the two cannot disagree.
  const { GAMES } = typeof module !== 'undefined' && module.exports ? require('./prng.js') : root.SeededLottery;

  const POWERBALL_PRIZES = { '5+0': 1000000, '4+1': 50000, '4+0': 100, '3+1': 100, '3+0': 7, '2+1': 7, '1+1': 4, '0+1': 4 };
  const NO_MULTIPLIER = () => [[1, 1]];

  /**
   * Each way to play, by key:
   *   game         the GAMES entry it draws from, which sets the odds and the jackpot
   *   price        dollars per play
   *   prizes       the fixed prizes by "white balls matched + bonus ball matched", before any multiplier.
   *                The jackpot tier (5+1) is absent on purpose: it is priced separately and never multiplied.
   *   flatPrizes   tiers the multiplier does not touch, at the amount they always pay
   *   multipliers  (advertisedJackpot) => [[multiplier, probability], ...], summing to 1
   *   jackpotShareOfSales  only on a game's base play: the fraction of its price that funds the jackpot,
   *                used to estimate ticket sales. Power Play's extra $1 funds none of it.
   */
  const PAYOUTS = {
    powerball: {
      game: 'powerball',
      price: 2,
      prizes: POWERBALL_PRIZES,
      flatPrizes: {},
      multipliers: NO_MULTIPLIER,
      jackpotShareOfSales: 0.325,
    },
    powerballPowerPlay: {
      game: 'powerball',
      price: 3,
      prizes: POWERBALL_PRIZES,
      // "The Match 5 + Power Play prize is always $2 million", whatever multiplier is drawn.
      flatPrizes: { '5+0': 2000000 },
      // 10x is only in play when the advertised jackpot is $150 million or less: 1, 2, 3, 13, 24 in 43 for
      // 10x, 5x, 4x, 3x, 2x. Above that, 2, 3, 13, 24 in 42 for 5x, 4x, 3x, 2x. Averages 119/43 and 109/42.
      multipliers: (advertisedJackpot) => (advertisedJackpot <= 150e6
        ? [[10, 1 / 43], [5, 2 / 43], [4, 3 / 43], [3, 13 / 43], [2, 24 / 43]]
        : [[5, 2 / 42], [4, 3 / 42], [3, 13 / 42], [2, 24 / 42]]),
    },
    megamillions: {
      game: 'megamillions',
      price: 5,
      prizes: { '5+0': 1000000, '4+1': 10000, '4+0': 500, '3+1': 200, '3+0': 10, '2+1': 10, '1+1': 7, '0+1': 5 },
      flatPrizes: {},
      // Every $5 ticket carries a random multiplier on every fixed prize, 5+0 included: 2x 15/32, 3x 10/32,
      // 4x 4/32, 5x 2/32, 10x 1/32 (published as 1 in 2.13, 3.2, 8, 16, 32). It averages exactly 3x.
      multipliers: () => [[2, 15 / 32], [3, 10 / 32], [4, 4 / 32], [5, 2 / 32], [10, 1 / 32]],
      jackpotShareOfSales: 0.2763,
    },
  };

  /** The average multiplier a play's fixed prizes get, at this advertised jackpot. 1 for a play without one. */
  function expectedMultiplier(play, advertisedJackpot) {
    return PAYOUTS[play].multipliers(advertisedJackpot).reduce((sum, [m, p]) => sum + m * p, 0);
  }

  function choose(n, k) {
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
    return r;
  }

  /**
   * Probability of matching exactly `white` of the white balls and, if `bonus`, the one bonus ball.
   * Assumes the game shape both games share: one white pool, one single-ball bonus pool.
   */
  function tierProbability(game, white, bonus) {
    const [whites, bonusPool] = game.pools;
    if (game.pools.length !== 2 || bonusPool.count !== 1) throw new Error('tierProbability needs one white pool and a one-ball bonus pool');
    const w = whites.count;
    const pWhite = (choose(w, white) * choose(whites.max - w, w - white)) / choose(whites.max, w);
    const pBonus = bonus ? 1 / bonusPool.max : (bonusPool.max - 1) / bonusPool.max;
    return pWhite * pBonus;
  }

  /**
   * Given that you hold a jackpot-winning ticket, the expected fraction of the jackpot you keep, when the
   * number of other winners is Poisson with mean `otherWinnersExpected`: E[1 / (1 + K)] = (1 - e^-λ) / λ.
   * 1 means you keep it all; λ = 0 is the limit, not a division by zero.
   */
  function expectedJackpotShare(otherWinnersExpected) {
    const λ = otherWinnersExpected;
    if (!(λ >= 0)) throw new Error(`expected other winners must be >= 0, got ${λ}`);
    return λ < 1e-9 ? 1 - λ / 2 : -Math.expm1(-λ) / λ;
  }

  /**
   * Plays the lottery projects for the coming draw, recovered from how much it says the jackpot's cash value
   * will grow: growth = projected sales × jackpot share. Null when that cannot be read: a missing figure, or
   * a jackpot that was just won and reset, where the cash value falls instead of growing.
   * The lotteries project conservatively. On the 5 and 7 Oct 2026 Powerball draws, winner counts put real
   * sales about 10% above this figure, which moves the expected share by under half a point.
   */
  function estimateTicketsSold(gameId, lastCash, nextCash) {
    const p = PAYOUTS[gameId];
    if (!p || p.jackpotShareOfSales == null) throw new Error(`${gameId} is not a base play: estimate sales from the base play`);
    if (!(lastCash > 0) || !(nextCash > lastCash)) return null;
    return Math.round((nextCash - lastCash) / p.jackpotShareOfSales / p.price);
  }

  /** Probability of a "white+bonus" tier key such as "4+1". */
  function tierOdds(game, tier) {
    const [white, bonus] = tier.split('+').map(Number);
    return tierProbability(game, white, bonus === 1);
  }

  /** Expected fixed-prize winnings per play, before tax, when the multiplier averages `multiplier`. */
  function fixedPrizeValue(p, game, multiplier) {
    // Linearity: the multiplier is drawn independently of the numbers, so its mean is all that matters.
    return Object.entries(p.prizes).reduce((sum, [tier, prize]) =>
      sum + tierOdds(game, tier) * (tier in p.flatPrizes ? p.flatPrizes[tier] : prize * multiplier), 0);
  }

  /**
   * Expected winnings per play and the return on its price.
   *   play               a PAYOUTS key: 'powerball', 'powerballPowerPlay' or 'megamillions'
   *   jackpot            the payout you would take: cash value, or the advertised annuity (undiscounted, so
   *                      it overstates what 30 payments over 29 years are worth today)
   *   advertisedJackpot  the headline (annuity) figure, which decides whether Power Play's 10x is in play
   *   ticketsSold        plays in the draw, or null to ignore the chance of sharing the jackpot
   *   taxRate            0..1, applied to every prize; all lottery winnings are taxable income
   * `roi` is the fraction gained or lost per dollar: -0.5 means half of every dollar lost on average.
   */
  function expectedReturn({ play, jackpot, advertisedJackpot, ticketsSold, taxRate }) {
    const p = PAYOUTS[play];
    if (!p) throw new Error(`no such play: ${play}`);
    const game = GAMES[p.game];
    if (!(jackpot >= 0)) throw new Error('jackpot must be a non-negative number of dollars');
    if (!(advertisedJackpot >= 0)) throw new Error('advertised jackpot must be a non-negative number of dollars');
    if (!(taxRate >= 0 && taxRate < 1)) throw new Error('tax rate must be from 0 up to (not including) 100%');

    const multiplier = expectedMultiplier(play, advertisedJackpot);
    const fixed = fixedPrizeValue(p, game, multiplier);

    const jackpotOdds = 1 / tierProbability(game, game.pools[0].count, true);
    const share = ticketsSold == null ? 1 : expectedJackpotShare(Math.max(0, ticketsSold - 1) / jackpotOdds);
    const jackpotPart = (jackpot * share) / jackpotOdds;
    const anyPrize = Object.keys(p.prizes).reduce((sum, tier) => sum + tierOdds(game, tier), 1 / jackpotOdds);

    const afterTax = (fixed + jackpotPart) * (1 - taxRate);
    return {
      price: p.price,
      multiplier,
      fixedPrizes: fixed * (1 - taxRate),
      jackpotPart: jackpotPart * (1 - taxRate),
      jackpotShare: share,
      expected: afterTax,
      roi: afterTax / p.price - 1,
      anyPrizeOdds: 1 / anyPrize,
      // The jackpot at which the play breaks even, at this tax rate and with the share held at today's sales.
      // Sales rise with the jackpot, so the true break-even is higher: about 14% for Powerball in Oct 2026.
      // The fixed prizes are priced at the multiplier in play at that jackpot, not today's. Power Play's 10x
      // goes above $150M and the break-even never gets that low (the least is $649M, at no tax and no sharing),
      // so pricing it at an unbounded jackpot is exact. A test holds that bound.
      breakEvenJackpot: (p.price / (1 - taxRate) - fixedPrizeValue(p, game, expectedMultiplier(play, Infinity))) * jackpotOdds / share,
    };
  }

  const api = { PAYOUTS, expectedMultiplier, tierProbability, expectedJackpotShare, estimateTicketsSold, expectedReturn };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LotteryRoi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
