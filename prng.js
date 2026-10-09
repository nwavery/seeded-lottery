// Seeded lottery numbers: SHA-256 of the input string seeds xoshiro256**, which draws the numbers.
//
// The whole pipeline is deterministic: the same string and the same game always give the same tickets,
// on any machine, in any browser. Changing any of the pieces below (the normalization, the byte order the
// seed is read in, the order pools and tickets consume the stream) changes every ticket ever generated,
// so treat them as a fixed contract.
//
// Loaded as a classic script so index.html works from file:// (module scripts are blocked there),
// and exported through module.exports so the Node tests exercise this exact file.
(function (root) {
  'use strict';

  const MASK64 = (1n << 64n) - 1n;
  const TWO64 = 1n << 64n;

  /**
   * The games on offer. Each pool is drawn without replacement; numbers run 1..max inclusive.
   * Mega Millions' gold ball shrank from 1-25 to 1-24 in April 2025; 1-24 checked on megamillions.com, 2026-10-09.
   * The jackpot-odds test pins both games to their published odds, so a wrong range here fails it.
   */
  const GAMES = {
    powerball: { name: 'Powerball', pools: [{ label: 'White balls', count: 5, max: 69 }, { label: 'Powerball', count: 1, max: 26 }] },
    megamillions: { name: 'Mega Millions', pools: [{ label: 'White balls', count: 5, max: 70 }, { label: 'Mega Ball', count: 1, max: 24 }] },
  };

  function choose(n, k) {
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
    return Math.round(r);
  }

  /** The jackpot is 1 in this many: every pool matched in full. */
  function jackpotOdds(game) {
    return game.pools.reduce((odds, p) => odds * choose(p.max, p.count), 1);
  }

  /**
   * SHA-256 of the string's UTF-8 bytes, after NFC normalization.
   * NFC so that an accented letter typed as one code point or as letter-plus-accent seeds the same draw;
   * for plain text the bytes are unchanged, so the hash matches `printf '%s' 'text' | shasum -a 256`.
   * No trimming or case folding: "Hello" and "hello " are different seeds, on purpose.
   */
  function sha256(text) {
    return sha256Bytes(new TextEncoder().encode(text.normalize('NFC')));
  }

  // FIPS 180-4 round constants: the first 32 bits of the fractional parts of the cube roots of the first 64 primes.
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  /**
   * SHA-256 (FIPS 180-4) of a byte array, as 32 bytes.
   * Written out here rather than taken from Web Crypto, which browsers only expose in a "secure context";
   * whether a double-clicked file counts as one varies by browser, and this page has to work offline from disk.
   */
  function sha256Bytes(msg) {
    // Pad: a 1 bit, zeros to 56 mod 64 bytes, then the bit length as a 64-bit big-endian integer.
    const padded = new Uint8Array(Math.ceil((msg.length + 9) / 64) * 64);
    padded.set(msg);
    padded[msg.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(msg.length / 0x20000000));
    view.setUint32(padded.length - 4, (msg.length * 8) >>> 0);

    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = W[i - 16] + s0 + W[i - 7] + s1;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    H.forEach((word, i) => outView.setUint32(i * 4, word));
    return out;
  }

  function toHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const rotl = (x, k) => ((x << k) | (x >> (64n - k))) & MASK64;

  /**
   * xoshiro256** (Blackman and Vigna, 2018), 64-bit output, with BigInt arithmetic.
   * The state is four 64-bit words; an all-zero state would output zeros forever, which a SHA-256 seed
   * hits with probability 2^-256, so it is not guarded.
   */
  class Xoshiro256 {
    constructor(s0, s1, s2, s3) {
      this.s = [s0, s1, s2, s3].map((w) => BigInt.asUintN(64, w));
    }

    /** Seeds from all 32 bytes of a hash, read as four little-endian 64-bit words. */
    static fromHash(hash) {
      if (hash.length !== 32) throw new Error(`seed must be 32 bytes, got ${hash.length}`);
      const view = new DataView(hash.buffer, hash.byteOffset, 32);
      return new Xoshiro256(...[0, 8, 16, 24].map((i) => view.getBigUint64(i, true)));
    }

    /** The next 64-bit output, as a BigInt in [0, 2^64). */
    next64() {
      const s = this.s;
      const result = (rotl((s[1] * 5n) & MASK64, 7n) * 9n) & MASK64;
      const t = (s[1] << 17n) & MASK64;
      s[2] ^= s[0];
      s[3] ^= s[1];
      s[1] ^= s[2];
      s[0] ^= s[3];
      s[2] ^= t;
      s[3] = rotl(s[3], 45n);
      return result;
    }

    /**
     * A uniform integer in [0, n). Rejection sampling rather than a bare modulo, which would favour the
     * low numbers slightly whenever n does not divide 2^64.
     */
    below(n) {
      if (!Number.isInteger(n) || n < 1) throw new Error(`below() needs a positive integer, got ${n}`);
      const bn = BigInt(n);
      const limit = TWO64 - (TWO64 % bn);
      for (;;) {
        const x = this.next64();
        if (x < limit) return Number(x % bn);
      }
    }
  }

  /** Rejects a game a draw cannot satisfy, with a message fit to show the user. Returns the game unchanged. */
  function validateGame(game) {
    if (!game || !Array.isArray(game.pools) || game.pools.length === 0) throw new Error('A game needs at least one pool.');
    for (const p of game.pools) {
      if (!Number.isInteger(p.count) || !Number.isInteger(p.max)) throw new Error(`${p.label}: counts and ranges must be whole numbers.`);
      if (p.max < 1 || p.max > 10000) throw new Error(`${p.label}: the range must be 1 to 10,000.`);
      if (p.count < 1 || p.count > p.max) throw new Error(`${p.label}: can't pick ${p.count} distinct numbers from 1–${p.max}.`);
    }
    return game;
  }

  /**
   * One ticket: for each pool in order, `count` distinct numbers from 1..max, sorted ascending.
   * Drawn by a partial Fisher-Yates shuffle, so every combination is equally likely.
   * Consumes the generator: pools in the order listed, numbers in draw order.
   */
  function drawTicket(rng, game) {
    return game.pools.map((pool) => {
      const deck = Array.from({ length: pool.max }, (_, i) => i + 1);
      for (let i = 0; i < pool.count; i++) {
        const j = i + rng.below(pool.max - i);
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      return { label: pool.label, numbers: deck.slice(0, pool.count).sort((a, b) => a - b) };
    });
  }

  /**
   * `tickets` tickets for `text`, drawn one after another from a single stream.
   * Ticket k does not depend on how many tickets were asked for: asking for 5 then 10 gives the same
   * first five.
   */
  function generate(text, game, tickets = 1) {
    validateGame(game);
    if (!Number.isInteger(tickets) || tickets < 1 || tickets > 100) throw new Error('Tickets must be 1 to 100.');
    const hash = sha256(text);
    const rng = Xoshiro256.fromHash(hash);
    const out = [];
    for (let i = 0; i < tickets; i++) out.push(drawTicket(rng, game));
    return { hashHex: toHex(hash), tickets: out };
  }

  const api = { GAMES, jackpotOdds, sha256, sha256Bytes, toHex, Xoshiro256, validateGame, drawTicket, generate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SeededLottery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
