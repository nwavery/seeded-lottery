// Run with: node --test
const test = require('node:test');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { GAMES, jackpotOdds, sha256, sha256Bytes, toHex, Xoshiro256, validateGame, drawTicket, generate } = require('../prng.js');

test('sha256 matches the FIPS 180-2 "abc" vector', () => {
  assert.equal(toHex(sha256('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256 agrees with node:crypto at every padding boundary up to three blocks', () => {
  // 55/56 and 119/120 bytes are where the length no longer fits in the final block; 0 is the empty input.
  for (let len = 0; len <= 200; len++) {
    const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 131 + len) & 0xff);
    assert.equal(toHex(sha256Bytes(bytes)), createHash('sha256').update(bytes).digest('hex'), `length ${len}`);
  }
});

test('sha256 of text agrees with node:crypto on multi-byte UTF-8', () => {
  for (const s of ['', 'café', '日付 2026-10-09', '🎲🎲🎲', 'a'.repeat(1000)]) {
    assert.equal(toHex(sha256(s)), createHash('sha256').update(s, 'utf8').digest('hex'), JSON.stringify(s));
  }
});

test('composed and decomposed accents seed the same draw', () => {
  assert.equal(toHex(sha256('café')), toHex(sha256('café')));
});

test('whitespace and case are part of the seed', () => {
  const a = generate('hello', GAMES.powerball);
  assert.notEqual(a.hashHex, (generate('hello ', GAMES.powerball)).hashHex);
  assert.notEqual(a.hashHex, (generate('Hello', GAMES.powerball)).hashHex);
});

test('xoshiro256** matches the reference outputs for state {1, 2, 3, 4}', () => {
  const rng = new Xoshiro256(1n, 2n, 3n, 4n);
  assert.deepEqual([rng.next64(), rng.next64(), rng.next64(), rng.next64()], [11520n, 0n, 1509978240n, 1215971899390074240n]);
});

test('below() rejects the biased tail instead of taking it modulo n', () => {
  // For n = 3, 2^64 mod 3 = 1, so 2^64 - 1 is the one value that must be redrawn. Taken modulo 3 it would give 0.
  const outputs = [(1n << 64n) - 1n, 5n];
  const fake = { next64: () => outputs.shift() };
  assert.equal(Xoshiro256.prototype.below.call(fake, 3), 2);
  assert.equal(outputs.length, 0);
});

test('below() is close to uniform over a fixed seed', () => {
  // Fixed seed, so this is deterministic rather than a test that fails at random.
  const rng = Xoshiro256.fromHash(sha256('uniformity'));
  const n = 7, draws = 70000, counts = new Array(n).fill(0);
  for (let i = 0; i < draws; i++) counts[rng.below(n)]++;
  const expected = draws / n;
  const chi2 = counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
  assert.ok(chi2 < 22.46, `chi-square ${chi2.toFixed(2)} exceeds the p = 0.001 critical value for 6 degrees of freedom`);
});

test('every combination of a small game is equally likely', () => {
  // 2 of 1-5 has 10 combinations. A pin only records what the code produced; this checks what it should
  // produce. An off-by-one in the shuffle makes a combination impossible and scores in the thousands.
  const game = { pools: [{ label: 'Small', count: 2, max: 5 }] };
  const rng = Xoshiro256.fromHash(sha256('combination uniformity'));
  const draws = 50000, counts = new Map();
  for (let i = 0; i < draws; i++) {
    const key = drawTicket(rng, game)[0].numbers.join(',');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  assert.equal(counts.size, 10, `saw ${counts.size} of 10 combinations`);
  const expected = draws / 10;
  const chi2 = [...counts.values()].reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
  // Fixed seed, so deterministic. 27.88 is the p = 0.001 critical value for 9 degrees of freedom.
  assert.ok(chi2 < 27.88, `chi-square ${chi2.toFixed(2)}`);
});

test('the same string always gives the same tickets', () => {
  for (const game of Object.values(GAMES)) {
    assert.deepEqual(generate('2026-10-09', game, 5), generate('2026-10-09', game, 5));
  }
});

test('ticket k does not depend on how many tickets were asked for', () => {
  const three = generate('prefix', GAMES.megamillions, 3);
  const ten = generate('prefix', GAMES.megamillions, 10);
  assert.deepEqual(ten.tickets.slice(0, 3), three.tickets);
});

test('every pool holds distinct, sorted numbers in range', () => {
  for (const game of Object.values(GAMES)) {
    const { tickets } = generate('range check', game, 100);
    for (const ticket of tickets) {
      ticket.forEach((drawn, i) => {
        const pool = game.pools[i];
        assert.equal(drawn.numbers.length, pool.count);
        assert.equal(new Set(drawn.numbers).size, pool.count, 'duplicate number');
        assert.deepEqual(drawn.numbers, [...drawn.numbers].sort((a, b) => a - b));
        for (const x of drawn.numbers) assert.ok(x >= 1 && x <= pool.max, `${x} outside 1..${pool.max}`);
      });
    }
  }
});

test('a pool that takes every number gets all of them', () => {
  const game = { pools: [{ label: 'All', count: 10, max: 10 }] };
  const { tickets } = generate('full', game);
  assert.deepEqual(tickets[0][0].numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('both games match their published jackpot odds', () => {
  // From powerball.com and megamillions.com. A wrong range in GAMES moves these.
  assert.equal(jackpotOdds(GAMES.powerball), 292201338);
  assert.equal(jackpotOdds(GAMES.megamillions), 290472336);
});

test('impossible games are refused', () => {
  assert.throws(() => validateGame({ pools: [{ label: 'Main', count: 7, max: 6 }] }), /can't pick 7/);
  assert.throws(() => validateGame({ pools: [{ label: 'Main', count: 0, max: 6 }] }));
  assert.throws(() => validateGame({ pools: [{ label: 'Main', count: 1.5, max: 6 }] }), /whole numbers/);
  assert.throws(() => validateGame({ pools: [] }));
});

test('the draw for a pinned input has not changed', () => {
  // Regression pin: if this fails, every ticket anyone has generated is different now.
  // Only update it on a deliberate change to the contract described at the top of prng.js.
  const { hashHex, tickets } = generate('2026-10-09', GAMES.powerball);
  assert.equal(hashHex, PINNED.hashHex);
  assert.deepEqual(tickets[0], PINNED.ticket);
});

const PINNED = {
  // Same as `printf '%s' '2026-10-09' | shasum -a 256`.
  hashHex: 'c894114fbc6a6bec76419aa2d9ebfdb7d19ddc9212c0d59b25aadf488b032a1c',
  ticket: [{ label: 'White balls', numbers: [2, 22, 38, 60, 65] }, { label: 'Powerball', numbers: [11] }],
};
