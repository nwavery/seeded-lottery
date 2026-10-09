# Nathan's Seeded Lottery

Type any text and get Powerball and Mega Millions numbers, side by side, with the expected return on a
ticket at the current jackpots. The same text always gives the same numbers.

Just for fun: not affiliated with Powerball, the Multi-State Lottery Association, Mega Millions or any lottery.
Your text never leaves your browser.

Open `index.html` in a browser (double-click works, no server needed). To refresh the jackpots first:

    node fetch-jackpots.js

That writes `jackpots.js`, which the page loads. If a site can't be read, the page says so and you can type
the figures in.

## The numbers (`prng.js`)

1. The text is NFC-normalized, encoded as UTF-8, and hashed with SHA-256. You can check the hash with
   `printf '%s' 'your text' | shasum -a 256`.
2. The 32-byte hash seeds xoshiro256**, read as four little-endian 64-bit words.
3. Each ticket draws its white balls, then its bonus ball, without replacement. Each number is picked by
   rejection sampling, so there is no modulo bias. Tickets come one after another from the same stream,
   so ticket 1 stays the same however many tickets you ask for.

## The ROI (`roi.js`)

Expected winnings per ticket, after tax, over the ticket price:

- Fixed prizes: each tier's probability times its prize, times the average multiplier. Mega Millions' $5
  ticket includes one that averages exactly 3x. Powerball is priced twice: the $2 base play, and $3 with
  Power Play, which averages 119/43x while the advertised jackpot is $150M or less (10x is in play) and
  109/42x above it; Match 5 with Power Play is always $2M.
- Jackpot: the jackpot (cash or annuity) over the jackpot odds, times the share you'd expect to keep. With
  λ other expected winners, that share is (1 − e^−λ)/λ.
- Projected plays come from how much the lottery says the jackpot's cash value will grow: Powerball puts
  32.5% of base sales into it, Mega Millions 27.63%. The lotteries project low; recent Powerball draws sold
  about 10% more.
- The break-even jackpot is shown as the advertised figure and as cash, holding sales at today's level.
  Bigger jackpots sell more tickets, so the real break-even is higher.

Neither game has a public API. Mega Millions' site calls a JSON endpoint of its own; Powerball's figures are
read from its page HTML. Both can change without notice; `fetch-jackpots.js` fails loudly rather than guess,
and checks Mega Millions' published prize table against `roi.js`.

## Hosting

The page is published to GitHub Pages by `.github/workflows/pages.yml`, which runs on every push to `main`,
once a day at 10:00 UTC, and on demand from the Actions tab. The daily run fetches the jackpots and commits
`jackpots.js` if it changed, so visitors only ever load a file and never touch the lottery sites. Only
`index.html`, `prng.js`, `roi.js` and `jackpots.js` are published.

If a fetch fails, `jackpots.js` keeps that game's last good figures with the date they were fetched, the page
shows how old they are, and the run is marked failed so it shows up in the Actions tab.

## Tests

    node --test

The fixtures in `test/fixtures` are the real responses, saved 2026-10-09: the Mega Millions JSON in full, and
excerpts of the three powerball.com pages holding only the markup the parsers read.
