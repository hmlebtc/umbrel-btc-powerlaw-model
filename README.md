<img src="assets/icon-512.png" alt="BTC Power Law Model icon" width="96" height="96">

# BTC Power Law Model

An [Umbrel](https://umbrel.com/) app that keeps a Bitcoin power-law model - `price = A * t^n`, where `t`
is days since the genesis block (2009-01-03 UTC) - continuously refit against the freshest data it can
find, and charts it the way [porkopolis.io/thechart](https://porkopolis.io/thechart) does: a power
regression plus individually toggleable residual-percentile lines, projected out to 2045. Nothing about the fitted curve
is hard-coded anywhere in this repo - every coefficient, band, and milestone the dashboard shows is
recomputed from data each time the model refits. The published values you may have seen elsewhere
(exponent `n` around 5.7, `R²` around 0.95) only ever appear here as test-tolerance corridors and in this
README's prose, never as defaults the app falls back to. Every readout tile, chart, and settings field also
carries a built-in explainer (small (i) buttons and a collapsible "What am I looking at?" chart panel) that
spells out in plain English what the number means and where it comes from, without leaving the dashboard.

## The model

On every fit, the app takes every stored daily USD closing price (plus, optionally, a live spot price
standing in for today - see [How updating works](#how-updating-works)) and runs an ordinary-least-squares
regression of `log10(price)` on `log10(t)`. The slope is the exponent `n`, the intercept is `log10(A)`,
and `R²` and the residual standard deviation `sigma` fall out of the same fit. Everything the dashboard
shows - fair value, deviation percent, current quantile, the milestone dates, the projection - is derived
from those few numbers at fit time.

**The epoch anchor (2009-01-03, the genesis block) is fixed in the code and is never configurable.** This
isn't an oversight: the fitted `(A, n)` pair is only meaningful relative to the epoch it was fit against,
because `n` is *origin-sensitive* - shift the zero point of `t` by even a few hundred days and the
best-fit exponent moves meaningfully, since you're now fitting a different curve through the same points.
Letting the epoch be a setting would silently invalidate every fit history entry and every published
`n ≈ 5.7`-style comparison the moment someone nudged it. Anchoring it to the one date that actually means
something for Bitcoin (the chain's own start) is the only anchor that doesn't need a disclaimer of its
own.

Bands are drawn as eleven individually toggleable percentile **lines** rather than fixed pairs, colored
cool-to-hot as they move away from the median. Four are on by default - 2.5% and 97.5% (red `#F44336`) and
16.5% and 83.5% (blue `#03A9F4`) - and a "More bands" legend expander reveals seven more, all off by
default: 0.5% and 99.5% (purple `#AB47BC`, the near-never-breached envelope), 10% and 90% (orange
`#FF9800`), 25% and 75% (teal `#26A69A`), and the 50% median (grey `#9E9E9E`, dashed). Clicking any legend
chip shows or hides that single line - on the chart, in the tooltip, and in the oscillator's guide lines.

Two ways of computing those percentiles are supported, both against the same slope/intercept fit. Both
modes draw the same kind of line - "price has historically closed below this line X% of the time" - they
differ only in how history is scored:

- **`fullSample`** - every day in history is compared against *today's* trend line. Simple, but it judges,
  say, 2011's prices against a curve fitted on everything through today - hindsight. Because the early
  years sit far from today's line, the extreme percentiles stretch wider: higher tops, lower floors.
- **`pointInTime`** (the default) - mirrors the point-in-time methodology porkopolis.io switched its chart
  to in January 2025: each day is compared only against the trend as it was fitted using data available up
  to that day (once at least 730 prior days exist, via an O(1)-updatable expanding-window regression) -
  what the model would actually have said at the time, with no hindsight. The extreme percentiles,
  especially the upper ones, come out tighter.

Practical effect on the projections: `fullSample` paints a **wider** funnel around the trend (more
optimistic ceilings, more pessimistic floors); `pointInTime` paints a **narrower, more conservative**
funnel. Neither is a prediction - the bands describe how far price has historically wandered from trend,
nothing more.

On the chart itself, a left-drag now **pans** the visible time window (the cursor turns into a grab hand)
instead of selecting a zoom range - hold **Shift** while dragging for the old range-select-to-zoom behavior,
still with a visible selection rectangle. Scrolling zooms in and out centered on the cursor, and a
double-click resets to the default view; a single-finger drag on touch devices pans the same way
(pinch-to-zoom isn't implemented yet). A drag shorter than about 4 pixels is treated as a click rather than
a pan, so double-clicking still works reliably and panning never eats an accidental small movement.

Alongside the chart, a collapsible **year-end model table** lists every calendar year from 2010 through the
configured projection end year: the actual stored closing price where one exists (the current year is
marked as still in progress), next to the current fit's trend and default four percentile lines at that
year's December 31st - computed client-side from the same `(a, n, bandOffsets)` the chart uses, so the
whole table shifts in step with every refit. Years past ~2040 are muted in the table for the same
validity-horizon reason the chart hatches them. The main chart itself is bigger by default (a
viewport-responsive height and a wider page container on large screens) to give the fuller band fan room to
breathe.

The table has two view modes, switched with a **Price | My holdings** toggle in its header. Price mode shows
the raw USD figures described above; **My holdings** mode instead multiplies every value - the actual close
and every visible model line - by a BTC amount you enter, so the table reads in the currency of *your* stack
rather than dollars-per-coin. Enter one **BTC held** amount that applies to every year, or override
individual years in the per-row **BTC** column if you plan to keep accumulating over time (a blank row falls
back to the global amount). **Holdings amounts are stored only in this app's own `settings.json`, on your
own Umbrel, behind its login - they are never sent anywhere else.** Unlike every other setting in the
[configuration reference](#configuration-reference) below, holdings deliberately has **no** `BPL_*`
environment-variable seed, because it's personal data you type into the dashboard, not deployment
configuration. This is a what-if illustration of relative outcomes, not financial advice.

In both view modes, only the **actual close** cell (the **actual value** cell in holdings mode) is tinted:
**green** (`#42A04C`) when that year finished at or above the trend line, and **red** (`#EF5350`) when it
finished below - the same above-or-below-trend read as the Deviation tile, year by year. The model and band
columns are plain, untinted text. The comparison is date-fair: a past year compares its December 31st close
to the trend at December 31st, while the year still in progress compares its latest close to the trend at
*that same date* rather than year-end, so a mid-year tint is never skewed. Holdings mode compares the same
underlying prices (scaling both sides by the same BTC amount doesn't change which side is bigger), so the
tinting is identical between the two views. Future years are never tinted.

An **Export CSV** button in the table header downloads the whole table as an Excel-ready CSV, generated
entirely in your browser (no server round-trip): UTF-8 with a byte-order mark and CRLF line endings, named
`btc-powerlaw-year-end_<fit date>.csv`. The export is a *superset* of the on-screen columns - it includes
**every** percentile line present in the current fit (0.5% through 99.5%), not just the default four, with
`Trend` as the last column. Values are raw numbers with no currency symbols or thousand separators (prices to
two decimals, BTC amounts to up to eight), so they drop straight into a spreadsheet; in **My holdings** mode
it exports your per-year BTC amounts and their values instead of prices.

## Data sources

| Source | Kinds | Notes |
|---|---|---|
| blockchain.info | history | Primary full history (`charts/market-price?timespan=all&sampled=false`) - `sampled=false` is load-bearing: without it the endpoint silently returns a coarse 4-day-sampled grid instead of true daily data. Refetched and reconciled into the store on every refit |
| Bitstamp | history, spot | OHLC history back to 2011-08-18, paginated; ticker for spot |
| Binance (`data-api.binance.vision`) | history, spot | Klines back to 2017, paginated; ticker for spot |
| Kraken | history, spot | OHLC (interval=1440, ~720 candles / roughly 2 years); ticker for spot |
| Coinbase | spot | Spot only |
| mempool.space | history, spot | Full historical-price series (coarser resolution); spot price |
| CoinGecko | spot | Spot only, last resort - only queried when the other spot sources return fewer than 2 answers |

**Amalgamation strategy:** the canonical store never contains today's date - blockchain.info's own "today"
row is a partial, still-updating average, and every exchange's "today" candle is still in progress, so
committing either would just mean silently revising a stored value later. Instead, the full blockchain.info
history is refetched and reconciled into the store on every refit with `sampled=false` (true daily
resolution, verified at roughly 6,400 raw daily rows spanning the 2009-01-03 genesis block to today - of
which about 5,800+ carry an actual priced day once Bitcoin's earliest exchanges existed; the earlier
zero-price rows are dropped), skipping any date on or after the current UTC day. The handful of most recent
days blockchain.info's edge cache hasn't caught up on yet are filled by querying Kraken, Bitstamp, and
Binance's OHLC endpoints **in parallel** (not a first-responder chain) and taking a per-day quorum: at
least two sources agreeing within 1% of each other publish unflagged, a lone responder is accepted but
flagged `unconfirmed`. Separately, at initial sync and then weekly, the app checks Bitstamp's, Binance's,
and mempool.space's own full history against the store: any date **missing** from the store (and before
today) that one of those covers gets added (flagged `secondary` when only one source has it), while any
overlapping *existing* date that disagrees with the stored value by more than 5% is **flagged `divergent`
and logged, never silently dropped or overwritten** - the stored value wins, but the disagreement stays
visible in the events feed and in `prices.json`. The live spot price is a median of whichever of coinbase /
kraken / bitstamp / binance / mempool.space respond within a 4-second window (CoinGecko joins only if fewer
than two of those answer); publishing a new spot value requires quorum (at least 2 agreeing sources), and
any single source more than 2.5% off the median of the others is rejected outright. Below quorum, the
dashboard keeps showing the last known-good spot value, marked `stale`.

## How updating works

The model refits automatically every **12 hours** by default (`refitIntervalHours`, configurable 1-168h in
the settings drawer), anchored to the last successful fit rather than a naive interval timer, so a restart
doesn't reset the clock. You can also trigger a refit immediately from the **Update Model** button on the
dashboard, which shows a live progress bar (fetch history → fetch spot → reconcile → fit → persist), a
percentage, and an ETA countdown derived from the last five run durations. Only one refit can run at a
time - a second request while one is in flight gets a `409` and the dashboard shows "already running"
instead of queueing a pile-up.

Every refit re-derives the model from the full stored history **plus a provisional point for today, built
from the current spot median** - so the chart and readouts always reflect the latest price action, not
yesterday's close. The canonical store never contains today's date at all (see
[Data sources](#data-sources)), so this provisional point isn't a fallback for an occasional gap - it's how
*every* day is represented until it's over: it only exists transiently in memory for the duration of the
fit, is never written to `prices.json`, and is flagged `includesProvisionalSpot` in the API response so the
dashboard can show it distinctly. It drops out cleanly the next day, once that date has rolled into
"yesterday" and its finalized close has been appended to the store. Independently of the refit
schedule, the app also polls spot prices on their own faster cadence (`spotPollMinutes`, default 5) so the
header ticker and the "updated Xs ago" readout stay current between refits, and appends the previous UTC
day's finalized close to the canonical store shortly after 00:20 UTC each day.

## Install on Umbrel

1. On your Umbrel, go to **Settings → App Store → Add a community app store**.
2. Enter this repo's URL: `https://github.com/hmlebtc/umbrel-btc-powerlaw-model`.
3. Open the new "BTC Power Law Model App Store" and install **BTC Power Law Model**.

> **Note for anyone running their own fork/build:** GHCR packages default to **private**. If you publish
> your own image via the [release process](#release-process) below, go to the package's settings on
> GitHub (`https://github.com/users/<you>/packages/container/umbrel-btc-powerlaw-model/settings`) and set
> visibility to **Public** - Umbrel pulls the image anonymously, with no registry login, so a private
> package will fail to pull with a generic "manifest unknown" / permission error.

The app needs no login or credentials of its own - the first thing it does on boot is an initial sync
(fetching full history from every enabled source, which can take up to about a minute), shown as a
full-page progress banner, after which the dashboard, readouts, and chart populate automatically. There is
nothing further to configure to get a working chart; the settings drawer only exists for tuning cadence,
band mode, projection horizon, and which sources are used.

## Configuration reference

Everything below is editable live from the dashboard's **Settings** drawer (`PUT /api/settings`); the
`BPL_*` env vars in `docker-compose.yml` only *seed* `settings.json` the first time the app boots (when no
`settings.json` exists yet) - after that, whatever's saved in the dashboard wins, and an app update or
container recreation never clobbers a live configuration change. Invalid values submitted via the API are
rejected field-by-field: each invalid field reverts to its default and is listed in the response so the
dashboard can flag exactly what didn't take.

| Setting (UI) | settings.json path | Env var (first-boot seed) | Default |
|---|---|---|---|
| Refit interval (hours) | `refitIntervalHours` | `BPL_REFIT_INTERVAL_HOURS` | `12` (range 1-168) |
| Spot poll interval (minutes) | `spotPollMinutes` | `BPL_SPOT_POLL_MINUTES` | `5` (range 1-60) |
| Projection end year | `projectionEndYear` | `BPL_PROJECTION_END_YEAR` | `2045` (range 2030-2055) |
| Band mode | `bandMode` | `BPL_BAND_MODE` | `pointInTime` (or `fullSample`) |
| Source mode | `sourceMode` | `BPL_SOURCE_MODE` | `auto` (or `manual`) |
| Enabled sources (manual mode only) | `enabledSources.<name>` | - | all `true` |
| My holdings mode (year-end table) | `holdings.enabled` | - (dashboard only, see note) | `false` |
| BTC held - global (year-end table) | `holdings.globalBtc` | - (dashboard only, see note) | `0` |
| BTC held - per year (year-end table) | `holdings.perYear.<YYYY>` | - (dashboard only, see note) | `{}` (unset) |

Unlike everything else in the table above, **`holdings` has no `BPL_*` environment-variable seed at all.**
It's personal data - how much BTC you hold or plan to hold - typed directly into the year-end table's "My
holdings" mode, not deployment configuration a container should ship with. It lives only in this app's own
`settings.json` on your Umbrel's `/data` volume, behind Umbrel's login, and is never transmitted anywhere
else; see [the year-end table's holdings mode above](#the-model) for details.

`BPL_HTTP_PORT` (default `3013`) and `BPL_DATA_DIR` (default `/data`) are process-level env vars, read at
startup only - they're not part of `settings.json` and aren't editable from the dashboard.

In `sourceMode: manual`, at least one of blockchain.info alone, or both Bitstamp and Binance together,
must remain enabled for history (otherwise there's no way to build the canonical series), and at least two
spot sources must remain enabled (otherwise spot quorum can never be reached); the API rejects a `PUT`
that would leave either requirement unmet.

## Limitations & honest caveats

A power-law fit against a multi-order-of-magnitude price series is easy to make look impressive on a
chart. It is worth being specific about why that isn't the same thing as the model being *right*, and
this app tries to surface these caveats rather than bury them:

- **The exponent is origin-sensitive.** As noted above, `n` is fit relative to a chosen epoch (here, the
  genesis block). A different, equally defensible epoch choice (first exchange trade, first non-trivial
  price, a different rounding of "day zero") would produce a measurably different `n` from the *same*
  price history. Comparisons between this app's fitted `n` and any other source's should account for
  whether they share the same epoch convention - most do use genesis, but not all.
- **A high R² here is comparatively cheap evidence.** Regressing `log(price)` on `log(time)` over a series
  that has risen several orders of magnitude will tend to produce a high R² almost by construction -
  monotonically trending series with any tendency toward polynomial-in-log growth look good in this
  specific regression, whether or not a power law is the "true" generative process. A high R² here is
  much weaker evidence for the model than the same R² would be in, say, a controlled experiment with
  independent replicates.
- **The residuals are autocorrelated, not i.i.d.** Ordinary least squares assumes independent, identically
  distributed errors; daily Bitcoin price deviations from *any* smooth trend are highly autocorrelated -
  the price spends months to years above or below trend in the same direction (bull/bear cycles), not
  bouncing independently day to day. That means the reported `R²` and any implied confidence intervals are
  optimistic versions of what a model with genuinely independent errors would give you, even though the
  empirical percentile bands themselves remain a reasonable historical description of "how far off trend
  has price actually gotten, how often."
- **Don't extrapolate past roughly 2040.** The power-law framing's own popularizers (porkopolis included)
  have been explicit that the fit is not expected to remain meaningful indefinitely - a power law implies
  ever-slowing percentage growth, but says nothing about *why* that deceleration should hold once Bitcoin's
  monetary base, adoption curve, and market structure look nothing like they did during the fitted period.
  The dashboard visually dims/hatches the chart past 2040 for this reason; treat anything projected beyond
  that as a mechanical extrapolation of a curve-fit, not a forecast.
- **Competing functional forms fit at least as well, depending on how you score them.** Bounded sigmoid /
  logistic curves (which assume Bitcoin is approaching some ceiling of adoption or value rather than
  growing as an unbounded power law) tend to win on in-sample goodness-of-fit, because they have more
  free parameters to bend toward the realized data. The power law's case rests more on out-of-sample
  behavior - research comparing rolling 12-24 month-ahead forecasts has found the simple power law holding
  up better than fitted sigmoids over those horizons - but "won some historical out-of-sample horizons" is
  a much weaker claim than "is the correct model of Bitcoin's price," and different lookback windows or
  scoring rules can favor either family.
- **This is not financial advice.** This app computes a curve fit against historical data and shows you
  where the current price sits relative to it. It does not know anything about the future. Deviation
  above or below trend has, historically, mean-reverted over some horizons and not others; past behavior
  of this or any statistical relationship is not a guarantee of anything going forward.

## Development

Requires Node 22+.

```bash
npm install
npm run build     # tsc -> dist/
npm test          # build, then node --test against dist/
npm run dev        # build, then run node dist/main.js
```

Local run, no Docker, entirely offline:

```bash
MOCK=1 BPL_HTTP_PORT=3013 node dist/main.js
```

With `MOCK=1`, every price source is replaced by a fixture-backed fake (a real blockchain.info history
snapshot taken while building this app, plus a synthetic series, plus a random-walk spot generator) - the
real network is never touched, so the whole initial-sync / refit / dashboard / job-progress flow can be
exercised without waiting on live APIs or burning through their rate limits. `MOCK=1` must never be set in
`docker-compose.yml`.

Then open `http://localhost:3013`. Runtime npm dependencies are intentionally zero - the app is built on
`node:http`, `node:fs`, `node:test`, and the global `fetch`; `typescript` and `@types/node` are dev-only.

## Release process

1. Bump the version in three places, kept in lockstep: `package.json` (`version`),
   `hmlebtc-powerlaw-model/umbrel-app.yml` (`version`), and the image tag pinned in
   `hmlebtc-powerlaw-model/docker-compose.yml`.
2. Add a `releaseNotes` entry to `umbrel-app.yml` for the new version.
3. Commit, then tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. `.github/workflows/docker-publish.yml` builds `linux/amd64` + `linux/arm64`, runs `npm test`, and pushes
   `ghcr.io/hmlebtc/umbrel-btc-powerlaw-model` tagged `X.Y.Z`, `X.Y`, `X`, the `v`-prefixed mirrors of each,
   and `latest`. A manual `workflow_dispatch` with a `version` input works too, for when pushing a tag
   isn't an option.
5. **First publish only:** GHCR packages default to **private**. Immediately after the workflow's first
   successful push, go to
   `https://github.com/users/hmlebtc/packages/container/umbrel-btc-powerlaw-model/settings` and flip
   visibility to **Public** - Umbrel pulls images anonymously with no registry credentials, so a private
   package fails every install with a generic "manifest unknown" error. This is a one-time step per
   package; subsequent version pushes to the same package name stay public.

## License

[MIT](LICENSE)
