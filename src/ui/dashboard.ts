// Self-contained single-page dashboard for the BTC Power Law Model app.
//
// One HTML document (inline CSS + vanilla JS, no build step, no external assets,
// fonts, or CDNs — the Umbrel node may be offline) served by server.ts at `/`.
// server.ts (Agent A) does:
//   import { DASHBOARD_HTML } from './ui/dashboard.js';
//   import { FAVICON_SVG }   from './ui/favicon.js';
// and serves GET / -> DASHBOARD_HTML, GET /favicon.svg -> FAVICON_SVG.
//
// This module composes the FULL page: it imports the chart engine (CHART_JS)
// and the app logic (APP_JS) and concatenates them into two inline <script>
// blocks (chart first, so window.PLChart exists before app.js runs). It also
// inlines FAVICON_SVG into the header brand mark.
//
// Template-literal safety (mirrors the template repo's src/dashboard.ts): the
// HTML/CSS shell is a String.raw literal, so backslash escapes (the CSS \2713
// glyphs) survive verbatim. There are NO backtick characters and NO dollar-brace
// runs anywhere inside the literal — the embedded markup uses plain text only,
// and all dynamic JS lives in CHART_JS / APP_JS which are concatenated in.

import { CHART_JS } from './chart.js';
import { APP_JS } from './app.js';
import { FAVICON_SVG } from './favicon.js';

// Page shell up to (and including) the opening of the header brand-icon span;
// FAVICON_SVG is concatenated right after this so the tab icon and the header
// mark are the same artwork.
const PAGE_HEAD: string = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>BTC Power Law Model</title>
<link rel="icon" href="/favicon.svg">
<style>
  :root {
    color-scheme: dark;
    --bg: #0e1420; --bg2: #0b111c;
    --card: #171f2e; --card2: #1c2536;
    --border: #2a3648; --border2: #37485f;
    --text: #e7eef7; --muted: #93a1b5; --faint: #647389;
    --input: #101a2b;
    --btc: #f7931a; --btc-dim: #f2b53d;
    --green: #42a04c; --green-soft: rgba(66,160,76,0.16);
    --red: #f44336; --red-soft: rgba(244,67,54,0.16);
    --blue: #03a9f4; --blue-soft: rgba(3,169,244,0.16);
    --trend: #ececec;
    --good: #34d399; --warn: #facc15; --bad: #f87171;
    --warn-soft: rgba(250,204,21,0.16);
    --gray-soft: rgba(148,163,184,0.16);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: linear-gradient(180deg, var(--bg) 0%, var(--bg2) 100%) fixed;
    color: var(--text); -webkit-font-smoothing: antialiased; min-height: 100vh;
  }
  a { color: var(--blue); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .grow { flex: 1 1 auto; }
  .muted { color: var(--muted); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .tnum { font-variant-numeric: tabular-nums; }

  header {
    position: sticky; top: 0; z-index: 30;
    display: flex; align-items: center; gap: 12px;
    padding: 11px 20px; flex-wrap: wrap;
    background: rgba(11,17,28,0.9); backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--border);
  }
  .brand-icon svg { width: 34px; height: 34px; display: block; border-radius: 9px; }
  .brand { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  h1 { font-size: 18px; margin: 0; font-weight: 700; letter-spacing: -0.01em; }
  .ver { color: var(--muted); font-size: 12px; }
  .conn-note { color: var(--warn); font-size: 12px; }

  .spot { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.25; }
  .spot-row { display: flex; align-items: center; gap: 8px; }
  #spotPrice { font-size: 19px; font-weight: 700; font-variant-numeric: tabular-nums; }
  #spotMeta { font-size: 11.5px; color: var(--muted); }
  .badge-stale { background: var(--warn-soft); color: var(--warn); padding: 2px 7px; border-radius: 6px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }

  .btn {
    font: inherit; font-weight: 600; font-size: 14px; padding: 8px 15px; border-radius: 9px;
    border: 1px solid var(--border2); background: var(--card2); color: var(--text);
    cursor: pointer; transition: border-color .15s, background .15s, transform .05s, opacity .15s; white-space: nowrap;
  }
  .btn:hover { border-color: var(--blue); }
  .btn:active { transform: translateY(1px); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  .btn.btc { background: var(--btc); border-color: var(--btc); color: #1a1200; }
  .btn.btc:hover { background: var(--btc-dim); border-color: var(--btc-dim); }

  .pill { padding: 5px 12px; border-radius: 999px; font-weight: 600; font-size: 12px; white-space: nowrap; border: 1px solid transparent; }
  .pill-job { background: var(--blue-soft); color: #7fd3ff; border-color: rgba(3,169,244,0.4); }

  .refit-strip { position: sticky; top: 57px; z-index: 25; display: flex; align-items: center; gap: 14px; padding: 8px 20px; background: rgba(23,31,46,0.94); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .refit-strip .strip-step { font-size: 13px; font-weight: 600; }
  .refit-strip .strip-eta { font-size: 12px; color: var(--muted); margin-left: auto; }
  .bar-track { height: 8px; background: var(--input); border-radius: 5px; overflow: hidden; flex: 1 1 160px; min-width: 120px; }
  .bar-fill { height: 100%; width: 0%; background: linear-gradient(90deg, var(--btc), var(--btc-dim)); transition: width .3s ease; }
  .strip-pct { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; min-width: 38px; text-align: right; }

  .init-overlay { position: fixed; inset: 0; z-index: 90; background: rgba(8,12,20,0.94); display: flex; align-items: center; justify-content: center; padding: 20px; }
  .init-card { width: 100%; max-width: 460px; background: var(--card); border: 1px solid var(--border2); border-radius: 16px; padding: 24px 26px; box-shadow: 0 20px 60px rgba(0,0,0,0.55); }
  .init-card h2 { margin: 0 0 6px; font-size: 17px; }
  .init-card p { margin: 0 0 16px; color: var(--muted); font-size: 13.5px; }
  .init-row { display: flex; align-items: center; gap: 12px; margin-top: 12px; }

  main { max-width: 1440px; margin: 0 auto; padding: 20px 16px 40px; width: 100%; }

  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 18px; margin-bottom: 18px; box-shadow: 0 1px 2px rgba(0,0,0,0.25); }
  .card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
  .card-head h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin: 0; font-weight: 700; }
  .card-head .hint { margin-left: auto; font-size: 12px; color: var(--faint); }

  .ro-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .ro { background: var(--card2); border: 1px solid var(--border); border-radius: 11px; padding: 12px 14px; min-width: 0; }
  .ro-l { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--faint); font-weight: 600; margin-bottom: 6px; }
  .ro-v { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; word-break: break-word; }
  .ro-v.pos { color: var(--green); } .ro-v.neg { color: var(--red); }
  .ro-sub { font-size: 11.5px; color: var(--faint); margin-top: 4px; word-break: break-word; }

  .chart-controls { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; margin-bottom: 12px; }
  .ctl-group { display: flex; align-items: center; gap: 8px; }
  .ctl-label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--faint); font-weight: 600; }
  .seg-group { display: inline-flex; border: 1px solid var(--border2); border-radius: 8px; overflow: hidden; }
  .seg { padding: 5px 11px; font: inherit; font-size: 12px; background: var(--card2); color: var(--muted); border: none; border-right: 1px solid var(--border); cursor: pointer; }
  .seg:last-child { border-right: none; }
  .seg:hover { color: var(--text); }
  .seg-on { background: var(--btc); color: #1a1200; font-weight: 700; }
  .pill-btn { padding: 5px 11px; font: inherit; font-size: 12px; border-radius: 999px; border: 1px solid var(--border2); background: var(--card2); color: var(--muted); cursor: pointer; }
  .pill-btn:hover { color: var(--text); border-color: var(--border2); }
  .pill-on { background: rgba(247,147,26,0.16); border-color: rgba(247,147,26,0.5); color: var(--btc); font-weight: 600; }

  /* Bigger chart (v0.1.2): responsive height, resized by the engine on window resize */
  #chartCard { padding: 14px; }
  #chartWrap { position: relative; width: 100%; height: clamp(460px, 62vh, 780px); }
  #chartCanvas { width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
  #chartCanvas:active { cursor: grabbing; }
  #oscWrap { position: relative; width: 100%; height: 176px; margin-top: 10px; border-top: 1px solid var(--border); padding-top: 6px; }
  #oscCanvas { width: 100%; height: 170px; display: block; }
  .osc-title { font-size: 11px; color: var(--faint); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 2px; }
  .band-note { font-size: 11.5px; color: var(--faint); margin-top: 8px; }

  .pltip { position: absolute; pointer-events: none; z-index: 6; display: none; background: rgba(11,17,28,0.95); border: 1px solid var(--border2); border-radius: 8px; padding: 8px 10px; font-size: 11.5px; min-width: 168px; box-shadow: 0 8px 22px rgba(0,0,0,0.5); }
  .pltip-row { display: flex; justify-content: space-between; gap: 16px; line-height: 1.55; }
  .pltip-k { color: var(--muted); }
  .pltip-v { font-variant-numeric: tabular-nums; font-weight: 600; }

  /* Chart legend (v0.1.2): Price/Trend indicators + per-percentile toggle chips
     plus a "More bands" expander that reveals the non-default percentile row. */
  .chart-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 7px 12px; margin-bottom: 12px; }
  .lg { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
  .lg-sw { width: 15px; height: 3px; border-radius: 2px; flex: none; }
  .lg-sw-dash { background-image: repeating-linear-gradient(90deg, currentColor 0 4px, transparent 4px 7px); }
  button.lg-band { font: inherit; font-size: 12px; color: var(--text); background: none; border: 1px solid transparent; border-radius: 8px; padding: 3px 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
  button.lg-band:hover { border-color: var(--border2); }
  button.lg-band:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  .lg-band[aria-pressed="false"] { opacity: .42; }
  .lg-band[aria-pressed="false"] .lg-sw { opacity: .5; }
  .lg-band:disabled { opacity: .3; cursor: default; }
  button.lg-more { font: inherit; font-size: 12px; font-weight: 600; color: var(--muted); background: none; border: 1px solid var(--border2); border-radius: 8px; padding: 3px 9px; cursor: pointer; }
  button.lg-more:hover { color: var(--text); border-color: var(--blue); }
  button.lg-more:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  .lg-more-chev { display: inline-block; }
  .lg-more-row { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 7px 12px; padding-top: 2px; }

  /* Info ⓘ popover system (v0.1.1) */
  .infobtn { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0; margin-left: 5px; border-radius: 50%; border: 1px solid var(--border2); background: var(--card2); color: var(--muted); font-family: Georgia, "Times New Roman", serif; font-style: italic; font-weight: 700; font-size: 10px; line-height: 1; cursor: pointer; vertical-align: middle; flex: none; }
  .infobtn:hover, .infobtn[aria-expanded="true"] { border-color: var(--blue); color: var(--blue); }
  .infobtn:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  .infopop { position: fixed; z-index: 120; max-width: 300px; display: none; background: rgba(11,17,28,0.98); border: 1px solid var(--border2); border-radius: 10px; padding: 10px 12px; font-size: 12.5px; line-height: 1.5; color: var(--text); box-shadow: 0 10px 30px rgba(0,0,0,0.55); }
  .infopop.show { display: block; }
  .infopop-line { margin: 0; }
  .infopop-line + .infopop-line { margin-top: 6px; }

  /* Collapsible "What am I looking at?" chart explainer (v0.1.1) */
  .explain-toggle { display: inline-flex; align-items: center; gap: 6px; background: none; border: none; color: var(--muted); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; padding: 0; }
  .explain-toggle:hover { color: var(--text); }
  .explain-toggle:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
  .explain-chev { display: inline-block; }
  .chart-explain { background: var(--card2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 15px; margin-bottom: 12px; }
  .chart-explain p { margin: 0 0 8px; font-size: 13px; line-height: 1.58; color: var(--muted); }
  .chart-explain p:last-child { margin-bottom: 0; }

  /* Settings label + ⓘ button row */
  .field-head { display: flex; align-items: center; gap: 5px; }
  .field-head label { flex: 0 1 auto; }

  .milestones { display: flex; flex-wrap: wrap; gap: 12px; }
  .mstile { flex: 1 1 130px; background: var(--card2); border: 1px solid var(--border); border-radius: 10px; padding: 11px 13px; text-align: center; min-width: 0; }
  .mstile .l { font-size: 11px; color: var(--faint); text-transform: uppercase; letter-spacing: .04em; }
  .mstile .v { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 4px; }
  .mstile .s { font-size: 11px; color: var(--faint); margin-top: 3px; }
  .mstile.hl { border-color: rgba(247,147,26,0.45); }

  .fchips { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .fchip { padding: 3px 9px; border-radius: 7px; font-size: 11px; font-weight: 600; }
  .fchip-ok { background: var(--green-soft); color: var(--good); }
  .fchip-bad { background: var(--red-soft); color: var(--bad); }
  .fchip-unk { background: var(--gray-soft); color: var(--muted); }

  /* Year-end model table (v0.1.2): sticky-header, scrollable body */
  .ytable-scroll { max-height: 380px; overflow: auto; border: 1px solid var(--border); border-radius: 10px; }
  table.ytable { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
  .ytable th, .ytable td { padding: 6px 12px; text-align: right; white-space: nowrap; }
  .ytable th:first-child, .ytable td:first-child { text-align: left; }
  .ytable thead th { position: sticky; top: 0; z-index: 1; background: var(--card2); color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; font-weight: 700; border-bottom: 1px solid var(--border2); }
  .ytable tbody td { border-bottom: 1px solid var(--border); }
  .ytable tbody tr:last-child td { border-bottom: none; }
  .yt-now { background: rgba(247,147,26,0.12); }
  .yt-now td { font-weight: 600; }
  .yt-prog { color: var(--btc); }
  .yt-beyond td { color: var(--faint); }
  .ytable-foot { font-size: 11.5px; color: var(--faint); margin-top: 8px; }
  /* Red/green vs actuals (v0.1.3): model cells tinted by whether the line sat at
     or above the year's actual close. */
  td.yt-hi { color: #42A04C; }
  td.yt-lo { color: #EF5350; }
  /* Year-end table value-mode toggle + holdings controls (v0.1.3) */
  .yt-modeseg { margin-left: auto; }
  .yt-holdings-ctl { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; font-size: 13px; }
  .yt-holdings-ctl label { font-weight: 600; color: var(--text); }
  .yt-holdings-ctl input { width: 160px; font: inherit; font-size: 14px; padding: 7px 10px; border-radius: 9px; background: var(--input); border: 1px solid var(--border2); color: var(--text); font-variant-numeric: tabular-nums; }
  .yt-holdings-ctl input:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 3px rgba(3,169,244,0.18); }
  .yt-btc-cell { padding: 3px 8px !important; }
  input.yt-btc-input { width: 108px; font: inherit; font-size: 12.5px; padding: 4px 7px; border-radius: 7px; background: var(--input); border: 1px solid var(--border2); color: var(--text); font-variant-numeric: tabular-nums; text-align: right; }
  input.yt-btc-input:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 2px rgba(3,169,244,0.18); }

  .srcchips { display: flex; flex-wrap: wrap; gap: 8px; }
  .srcchip { display: inline-flex; align-items: center; gap: 7px; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--card2); color: var(--text); font-size: 12px; cursor: pointer; }
  .srcchip[data-ro="1"] { cursor: default; }
  .srcchip:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  .srcdot { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: none; }
  .srcchip-ok .srcdot { background: var(--good); }
  .srcchip-warn .srcdot { background: var(--warn); }
  .srcchip-fail .srcdot { background: var(--bad); }
  .srcchip-unknown .srcdot { background: var(--faint); }
  .srcchip-off { opacity: .5; }
  .srclat { color: var(--faint); font-size: 11px; font-variant-numeric: tabular-nums; }
  .srcoff { color: var(--bad); font-size: 10px; text-transform: uppercase; font-weight: 700; }

  .log { list-style: none; margin: 0; padding: 0; }
  .log-item { display: flex; gap: 12px; padding: 10px 2px; border-bottom: 1px solid var(--border); }
  .log-item:last-child { border-bottom: none; }
  .log-main { min-width: 0; flex: 1; }
  .log-title { font-weight: 600; font-size: 13.5px; word-break: break-word; }
  .log-sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .chip { align-self: flex-start; display: inline-block; padding: 2px 9px; border-radius: 7px; font-size: 11px; font-weight: 700; letter-spacing: .02em; }
  .chip-info { background: var(--blue-soft); color: #7fd3ff; }
  .chip-ok { background: var(--green-soft); color: var(--good); }
  .chip-warn { background: var(--warn-soft); color: var(--warn); }
  .chip-error { background: var(--red-soft); color: var(--bad); }
  .empty { text-align: center; color: var(--faint); font-size: 13.5px; padding: 22px 10px; }

  .settings-toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; background: none; border: none; color: var(--muted); font: inherit; font-size: 13px; text-transform: uppercase; letter-spacing: .07em; font-weight: 700; padding: 0; }
  .settings-toggle:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
  form fieldset { border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px 16px; margin: 0 0 16px; }
  form legend { padding: 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--btc); font-weight: 700; }
  .field { margin-bottom: 12px; display: flex; flex-direction: column; gap: 5px; }
  .field-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px 14px; margin-bottom: 12px; }
  .field-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; margin-bottom: 12px; }
  .field label { font-size: 13px; font-weight: 600; color: var(--text); }
  .lbl-note { font-weight: 400; color: var(--faint); font-size: 12px; }
  input[type=number], select { font: inherit; font-size: 14px; width: 100%; padding: 8px 11px; border-radius: 9px; background: var(--input); border: 1px solid var(--border2); color: var(--text); }
  input:focus, select:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 3px rgba(3,169,244,0.18); }
  .checks { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px 14px; margin-top: 6px; }
  .check { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
  .check input { width: 16px; height: 16px; accent-color: var(--btc); }
  .field-err { font-size: 12px; color: var(--red); margin-top: 2px; min-height: 0; }
  .errbox { background: var(--red-soft); border: 1px solid rgba(244,67,54,0.5); border-radius: 10px; padding: 11px 14px; margin-bottom: 14px; color: #fecaca; font-size: 13.5px; }
  .form-foot { display: flex; justify-content: flex-end; margin-top: 4px; }
  .src-note { font-size: 12px; color: var(--faint); margin: 4px 0 8px; }

  footer { max-width: 1440px; margin: 0 auto; padding: 8px 16px 34px; color: var(--faint); font-size: 12px; text-align: center; }
  footer .disc { color: var(--muted); margin-top: 3px; }

  .toasts { position: fixed; right: 16px; bottom: 16px; z-index: 100; display: flex; flex-direction: column; gap: 8px; max-width: min(380px, calc(100vw - 32px)); }
  .toast { padding: 11px 14px; border-radius: 10px; font-size: 13.5px; font-weight: 500; background: var(--card2); border: 1px solid var(--border2); color: var(--text); box-shadow: 0 8px 24px rgba(0,0,0,0.4); opacity: 0; transform: translateY(8px); transition: opacity .22s ease, transform .22s ease; }
  .toast.show { opacity: 1; transform: translateY(0); }
  .toast-ok { border-color: rgba(52,211,153,0.6); }
  .toast-ok::before { content: "\2713  "; color: var(--good); font-weight: 700; }
  .toast-error { border-color: rgba(244,67,54,0.6); }
  .toast-error::before { content: "\26A0  "; color: var(--red); }
  .toast-info::before { content: "\2139  "; color: var(--blue); }

  @media (max-width: 640px) {
    main { padding: 16px 12px 36px; }
    .card { padding: 15px; }
    .field-2, .field-3 { grid-template-columns: 1fr; }
    #chartWrap { height: 360px; }
    .toasts { left: 12px; right: 12px; max-width: none; }
    .refit-strip { top: 96px; }
  }
</style>
</head>
<body>
<header>
  <span class="brand-icon" aria-hidden="true">`;

// Body after the inlined favicon SVG, through to the end of the toasts host.
const PAGE_BODY: string = String.raw`</span>
  <div class="brand">
    <h1>BTC Power Law Model</h1>
    <span class="ver tnum" id="appVersion"></span>
  </div>
  <span class="grow"></span>
  <span class="conn-note" id="connNote" style="display:none">reconnecting&hellip;</span>
  <span class="pill pill-job" id="jobBadge" style="display:none">Updating&hellip;</span>
  <div class="spot" aria-live="polite" title="Live price: median of the exchange sources currently responding (count shown). Refreshes every spot-poll interval.">
    <div class="spot-row"><span id="spotPrice">&mdash;</span><span class="badge-stale" id="spotStale" style="display:none">stale</span></div>
    <span id="spotMeta"><span class="muted">&hellip;</span></span>
  </div>
  <button class="btn btc" id="updateBtn" type="button" aria-label="Refit the model now from live data">Update model</button>
</header>

<div class="refit-strip" id="refitStrip" style="display:none" role="status" aria-live="polite">
  <span class="strip-step" id="refitStep">Working&hellip;</span>
  <div class="bar-track"><div class="bar-fill" id="refitBarFill"></div></div>
  <span class="strip-pct" id="refitPct">0%</span>
  <span class="strip-eta" id="refitEta"></span>
</div>

<div class="init-overlay" id="initOverlay" style="display:none" role="alertdialog" aria-labelledby="initTitle">
  <div class="init-card">
    <h2 id="initTitle">Building the model&hellip;</h2>
    <p>Downloading Bitcoin's full daily price history and fitting the power law for the first time. This runs once and usually completes in under a minute.</p>
    <div class="strip-step" id="initStep">Starting&hellip;</div>
    <div class="init-row">
      <div class="bar-track"><div class="bar-fill" id="initBarFill"></div></div>
      <span class="strip-pct" id="initPct">0%</span>
    </div>
    <div class="init-row"><span class="strip-eta" id="initEta"></span></div>
  </div>
</div>

<main>
  <section class="card" id="readoutsCard" aria-label="Model readouts">
    <div class="ro-grid">
      <div class="ro"><div class="ro-l">Fair value now <button class="infobtn" type="button" data-help="fairValue" aria-label="About: Fair value now" aria-expanded="false">i</button></div><div class="ro-v" id="ro_fairValue">&mdash;</div><div class="ro-sub">trend price today</div></div>
      <div class="ro"><div class="ro-l">Deviation <button class="infobtn" type="button" data-help="deviation" aria-label="About: Deviation" aria-expanded="false">i</button></div><div class="ro-v" id="ro_deviation">&mdash;</div><div class="ro-sub">spot vs trend</div></div>
      <div class="ro"><div class="ro-l">Current quantile <button class="infobtn" type="button" data-help="quantile" aria-label="About: Current quantile" aria-expanded="false">i</button></div><div class="ro-v" id="ro_quantile">&mdash;</div><div class="ro-sub">residual percentile</div></div>
      <div class="ro"><div class="ro-l">Exponent n <button class="infobtn" type="button" data-help="exponentN" aria-label="About: Exponent n" aria-expanded="false">i</button></div><div class="ro-v" id="ro_n">&mdash;</div><div class="ro-sub" id="ro_n_sub"></div></div>
      <div class="ro"><div class="ro-l">Coefficient A <button class="infobtn" type="button" data-help="coeffA" aria-label="About: Coefficient A" aria-expanded="false">i</button></div><div class="ro-v" id="ro_A">&mdash;</div><div class="ro-sub" id="ro_A_sub"></div></div>
      <div class="ro"><div class="ro-l">R&#178; <button class="infobtn" type="button" data-help="r2" aria-label="About: R squared" aria-expanded="false">i</button></div><div class="ro-v" id="ro_r2">&mdash;</div><div class="ro-sub">goodness of fit</div></div>
      <div class="ro"><div class="ro-l">&#963; residual <button class="infobtn" type="button" data-help="sigma" aria-label="About: sigma residual" aria-expanded="false">i</button></div><div class="ro-v" id="ro_sigma">&mdash;</div><div class="ro-sub">log10 std-dev</div></div>
      <div class="ro"><div class="ro-l">Days since genesis <button class="infobtn" type="button" data-help="days" aria-label="About: Days since genesis" aria-expanded="false">i</button></div><div class="ro-v" id="ro_days">&mdash;</div><div class="ro-sub">t, epoch 2009-01-03</div></div>
      <div class="ro"><div class="ro-l">Next auto-refit <button class="infobtn" type="button" data-help="nextRefit" aria-label="About: Next auto-refit" aria-expanded="false">i</button></div><div class="ro-v" id="ro_nextRefit">&mdash;</div><div class="ro-sub" id="ro_nextRefit_sub"></div></div>
    </div>
  </section>

  <section class="card" id="chartCard">
    <div class="card-head">
      <h2>Power law chart</h2>
      <button class="explain-toggle" id="explainToggle" type="button" aria-expanded="false" aria-controls="explainPanel"><span class="explain-chev" id="explainChevron">&#9656;</span> What am I looking at?</button>
      <span class="hint" id="bandModeNote"></span>
    </div>
    <div class="chart-explain" id="explainPanel" style="display:none">
      <p>The green line is Bitcoin's actual daily price; the ring at the end is the live price for today, which isn't final until the day closes. The white line is the power-law trend fitted to the entire history - it is refit from scratch at every update, so it can shift slightly as new data arrives.</p>
      <p>The dotted lines are percentiles of the model's own history: price has historically closed below the 97.5% line on 97.5% of all days, below the 16.5% line on only 16.5% of days, and so on. The default four (2.5/16.5/83.5/97.5) are the classic porkopolis set; open 'More bands' in the legend to add others, including the 50% median. They are descriptions of the past, not statistical guarantees about the future.</p>
      <p>Left of the 'today' line is history; right of it is the same formula extended forward. The hatched area past ~2040 is where the model's own authors say it should not be trusted. Halving lines mark Bitcoin's supply-cut events (dashed ones are estimates).</p>
      <p>The oscillator below divides price by trend (1.0x = exactly on trend) - it is the same information as the bands, flattened out. Drag to move around the chart, hold Shift and drag to select a range to zoom into, scroll to zoom at the cursor, and double-click to reset the view.</p>
    </div>
    <div class="chart-controls">
      <div class="ctl-group"><span class="ctl-label">X</span>
        <div class="seg-group" role="group" aria-label="X axis mode">
          <button class="seg" id="xMode_date" type="button">Date</button>
          <button class="seg" id="xMode_logDays" type="button">Log days</button>
        </div>
      </div>
      <div class="ctl-group"><span class="ctl-label">Y</span>
        <div class="seg-group" role="group" aria-label="Y axis mode">
          <button class="seg" id="yMode_log" type="button">Log</button>
          <button class="seg" id="yMode_linear" type="button">Linear</button>
        </div>
      </div>
      <div class="ctl-group"><span class="ctl-label">Range</span>
        <button class="pill-btn" id="rg_full" type="button">2010&rarr;2045</button>
        <button class="pill-btn" id="rg_history" type="button">History</button>
        <button class="pill-btn" id="rg_4y" type="button">4y</button>
        <button class="pill-btn" id="rg_1y" type="button">1y</button>
        <button class="pill-btn" id="rg_6m" type="button">6m</button>
      </div>
      <div class="ctl-group">
        <button class="pill-btn" id="tgBands" type="button" aria-pressed="false">Band fill</button>
        <button class="pill-btn" id="tgHalvings" type="button" aria-pressed="true">Halvings</button>
        <button class="pill-btn" id="tgOsc" type="button" aria-pressed="true">Oscillator</button>
      </div>
    </div>
    <div class="chart-legend" id="chartLegend" role="group" aria-label="Chart series legend and percentile line toggles">
      <span class="lg"><span class="lg-sw" style="background:#42a04c"></span>Price</span>
      <span class="lg"><span class="lg-sw" style="background:#ececec"></span>Trend</span>
      <button class="lg-band" type="button" id="lg_p025" data-band="p025" aria-pressed="true" aria-label="Toggle the 2.5% line"><span class="lg-sw" style="background:#f44336"></span>2.5%</button>
      <button class="lg-band" type="button" id="lg_p165" data-band="p165" aria-pressed="true" aria-label="Toggle the 16.5% line"><span class="lg-sw" style="background:#03a9f4"></span>16.5%</button>
      <button class="lg-band" type="button" id="lg_p835" data-band="p835" aria-pressed="true" aria-label="Toggle the 83.5% line"><span class="lg-sw" style="background:#03a9f4"></span>83.5%</button>
      <button class="lg-band" type="button" id="lg_p975" data-band="p975" aria-pressed="true" aria-label="Toggle the 97.5% line"><span class="lg-sw" style="background:#f44336"></span>97.5%</button>
      <button class="lg-more" type="button" id="moreBandsToggle" aria-expanded="false" aria-controls="moreBandsRow">More bands <span class="lg-more-chev" id="moreBandsChev">&#9662;</span></button>
      <span class="lg-more-row" id="moreBandsRow" style="display:none">
        <button class="lg-band" type="button" id="lg_p005" data-band="p005" aria-pressed="false" aria-label="Toggle the 0.5% line"><span class="lg-sw" style="background:#ab47bc"></span>0.5%</button>
        <button class="lg-band" type="button" id="lg_p10" data-band="p10" aria-pressed="false" aria-label="Toggle the 10% line"><span class="lg-sw" style="background:#ff9800"></span>10%</button>
        <button class="lg-band" type="button" id="lg_p25" data-band="p25" aria-pressed="false" aria-label="Toggle the 25% line"><span class="lg-sw" style="background:#26a69a"></span>25%</button>
        <button class="lg-band" type="button" id="lg_p50" data-band="p50" aria-pressed="false" aria-label="Toggle the 50% median line"><span class="lg-sw lg-sw-dash" style="background:#9e9e9e"></span>50%</button>
        <button class="lg-band" type="button" id="lg_p75" data-band="p75" aria-pressed="false" aria-label="Toggle the 75% line"><span class="lg-sw" style="background:#26a69a"></span>75%</button>
        <button class="lg-band" type="button" id="lg_p90" data-band="p90" aria-pressed="false" aria-label="Toggle the 90% line"><span class="lg-sw" style="background:#ff9800"></span>90%</button>
        <button class="lg-band" type="button" id="lg_p995" data-band="p995" aria-pressed="false" aria-label="Toggle the 99.5% line"><span class="lg-sw" style="background:#ab47bc"></span>99.5%</button>
      </span>
    </div>
    <div id="chartWrap">
      <canvas id="chartCanvas" role="img" aria-label="Bitcoin price with power-law trend and percentile bands"></canvas>
      <div class="pltip" id="chartTip"></div>
    </div>
    <div id="oscWrap">
      <div class="osc-title">Price / trend oscillator (log scale)</div>
      <canvas id="oscCanvas" role="img" aria-label="Price to trend ratio oscillator"></canvas>
    </div>
  </section>

  <section class="card" id="milestonesCard">
    <div class="card-head"><h2>Milestones</h2><span class="hint">trend value at each Jan 1, plus the $1M crossing</span></div>
    <div class="milestones">
      <div class="mstile"><div class="l">2030</div><div class="v" id="ms_2030">&mdash;</div><div class="s">Jan 1 trend</div></div>
      <div class="mstile"><div class="l">2035</div><div class="v" id="ms_2035">&mdash;</div><div class="s">Jan 1 trend</div></div>
      <div class="mstile"><div class="l">2040</div><div class="v" id="ms_2040">&mdash;</div><div class="s">Jan 1 trend</div></div>
      <div class="mstile"><div class="l">2045</div><div class="v" id="ms_2045">&mdash;</div><div class="s">Jan 1 trend</div></div>
      <div class="mstile hl"><div class="l">$1M crossing</div><div class="v" id="ms_1m">&mdash;</div><div class="s" id="ms_1m_sub"></div></div>
    </div>
    <div class="fchips" id="falsifiability"></div>
  </section>

  <section class="card" id="yearTableCard">
    <div class="card-head">
      <button class="settings-toggle" id="yearTableToggle" type="button" aria-expanded="true" aria-controls="yearTableBody">
        <span id="yearTableChevron">&#9662;</span> Year-end model table
      </button>
      <button class="infobtn" type="button" data-help="yearEndTable" aria-label="About: Year-end model table" aria-expanded="false">i</button>
      <div class="seg-group yt-modeseg" role="group" aria-label="Table value mode">
        <button class="seg seg-on" id="ytMode_price" type="button" aria-pressed="true">Price</button>
        <button class="seg" id="ytMode_holdings" type="button" aria-pressed="false">My holdings</button>
      </div>
    </div>
    <div id="yearTableBody">
      <div class="yt-holdings-ctl" id="ytHoldingsControl" style="display:none">
        <label for="ytGlobalBtc">BTC held:</label>
        <input id="ytGlobalBtc" type="number" min="0" max="21000000" step="any" inputmode="decimal" aria-label="BTC held, applies to all years">
        <span class="muted">applies to all years</span>
      </div>
      <div class="ytable-scroll">
        <table class="ytable">
          <thead>
            <tr id="ytHeadPrice">
              <th scope="col">Year</th>
              <th scope="col">Actual close</th>
              <th scope="col">2.5%</th>
              <th scope="col">16.5%</th>
              <th scope="col">Trend</th>
              <th scope="col">83.5%</th>
              <th scope="col">97.5%</th>
            </tr>
            <tr id="ytHeadHoldings" style="display:none">
              <th scope="col">Year</th>
              <th scope="col">BTC</th>
              <th scope="col">Actual value</th>
              <th scope="col">2.5%</th>
              <th scope="col">16.5%</th>
              <th scope="col">Trend</th>
              <th scope="col">83.5%</th>
              <th scope="col">97.5%</th>
            </tr>
          </thead>
          <tbody id="yearTableRows"></tbody>
        </table>
      </div>
      <div class="ytable-foot" id="yearTableFoot" style="display:none">Years beyond ~2040 exceed the model author's stated validity horizon.</div>
    </div>
  </section>

  <section class="card" id="sourcesCard">
    <div class="card-head"><h2>Data sources</h2><span class="hint">click a chip to toggle (manual mode only)</span></div>
    <div class="srcchips" id="sourceChips"></div>
  </section>

  <section class="card" id="settingsCard">
    <div class="card-head">
      <button class="settings-toggle" id="settingsToggle" type="button" aria-expanded="true" aria-controls="settingsBody">
        <span id="settingsChevron">&#9662;</span> Settings
      </button>
    </div>
    <div id="settingsBody">
      <div class="errbox" id="settingsErrors" style="display:none" role="alert"></div>
      <form id="settingsForm" novalidate>
        <fieldset>
          <legend>Model &amp; schedule</legend>
          <div class="field-3">
            <div class="field">
              <div class="field-head"><label for="cfg_refitIntervalHours">Refit interval <span class="lbl-note">(hours, 1&ndash;168)</span></label><button class="infobtn" type="button" data-help="refitInterval" aria-label="About: Refit interval" aria-expanded="false">i</button></div>
              <input id="cfg_refitIntervalHours" type="number" min="1" max="168" step="1" inputmode="numeric">
              <div class="field-err" id="err_refitIntervalHours"></div>
            </div>
            <div class="field">
              <div class="field-head"><label for="cfg_spotPollMinutes">Spot poll <span class="lbl-note">(minutes, 1&ndash;60)</span></label><button class="infobtn" type="button" data-help="spotPoll" aria-label="About: Spot poll" aria-expanded="false">i</button></div>
              <input id="cfg_spotPollMinutes" type="number" min="1" max="60" step="1" inputmode="numeric">
              <div class="field-err" id="err_spotPollMinutes"></div>
            </div>
            <div class="field">
              <div class="field-head"><label for="cfg_projectionEndYear">Projection end year <span class="lbl-note">(2030&ndash;2055)</span></label><button class="infobtn" type="button" data-help="projectionEndYear" aria-label="About: Projection end year" aria-expanded="false">i</button></div>
              <input id="cfg_projectionEndYear" type="number" min="2030" max="2055" step="1" inputmode="numeric">
              <div class="field-err" id="err_projectionEndYear"></div>
            </div>
          </div>
          <div class="field-2">
            <div class="field">
              <div class="field-head"><label for="cfg_bandMode">Band mode</label><button class="infobtn" type="button" data-help="bandMode" aria-label="About: Band mode" aria-expanded="false">i</button></div>
              <select id="cfg_bandMode">
                <option value="pointInTime">Point-in-time (porkopolis post-2025)</option>
                <option value="fullSample">Full-sample percentiles</option>
              </select>
              <div class="field-err" id="err_bandMode"></div>
            </div>
            <div class="field">
              <div class="field-head"><label for="cfg_sourceMode">Source mode</label><button class="infobtn" type="button" data-help="sourceMode" aria-label="About: Source mode" aria-expanded="false">i</button></div>
              <select id="cfg_sourceMode">
                <option value="auto">Auto (all sources)</option>
                <option value="manual">Manual (pick sources)</option>
              </select>
              <div class="field-err" id="err_sourceMode"></div>
            </div>
          </div>
        </fieldset>
        <fieldset id="sourcesFieldset">
          <legend>Enabled sources <button class="infobtn" type="button" data-help="enabledSources" aria-label="About: Enabled sources" aria-expanded="false">i</button></legend>
          <div class="src-note" id="sourceModeNote"></div>
          <div class="checks">
            <label class="check"><input id="cfg_src_blockchainInfo" type="checkbox"><span>blockchainInfo</span></label>
            <label class="check"><input id="cfg_src_bitstamp" type="checkbox"><span>bitstamp</span></label>
            <label class="check"><input id="cfg_src_binance" type="checkbox"><span>binance</span></label>
            <label class="check"><input id="cfg_src_kraken" type="checkbox"><span>kraken</span></label>
            <label class="check"><input id="cfg_src_coinbase" type="checkbox"><span>coinbase</span></label>
            <label class="check"><input id="cfg_src_mempoolSpace" type="checkbox"><span>mempoolSpace</span></label>
            <label class="check"><input id="cfg_src_coingecko" type="checkbox"><span>coingecko</span></label>
          </div>
          <div class="field-err" id="err_sources"></div>
        </fieldset>
        <div class="form-foot"><button class="btn btc" id="saveSettingsBtn" type="submit">Save settings</button></div>
      </form>
    </div>
  </section>

  <section class="card" id="eventsCard">
    <div class="card-head"><h2>Activity</h2></div>
    <ul class="log" id="eventsList"></ul>
    <div class="empty" id="eventsEmpty" style="display:none">No activity recorded yet.</div>
  </section>
</main>

<footer>
  <div id="footVersion">BTC Power Law Model</div>
  <div class="disc">Not financial advice &mdash; model, not prophecy.</div>
</footer>

<div class="toasts" id="toasts" aria-live="polite" aria-atomic="false"></div>
<div class="infopop" id="infoPop" role="tooltip"></div>
`;

const PAGE_TAIL: string = String.raw`</body>
</html>`;

// Compose the single self-contained page: shell + inlined favicon artwork, then
// the chart engine and the app logic as two inline scripts (chart first so
// window.PLChart exists before app.js runs).
export const DASHBOARD_HTML: string =
  PAGE_HEAD +
  FAVICON_SVG +
  PAGE_BODY +
  "\n<script>\n" + CHART_JS + "\n</script>\n" +
  "<script>\n" + APP_JS + "\n</script>\n" +
  PAGE_TAIL;
