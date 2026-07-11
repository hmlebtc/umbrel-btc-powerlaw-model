// Favicon for the BTC Power Law Model app.
//
// Served verbatim by server.ts at GET /favicon.svg and also inlined into the
// dashboard header (dashboard.ts imports FAVICON_SVG and concatenates it into
// the page shell). Self-contained: no external fonts, no CDN, no <text> that
// could tofu on a machine without the glyph — every mark is an analytic shape
// (rounded-rect, thick polyline) so it reads at 16px in a browser tab and
// mirrors the app icon that scripts/render_icons.py rasterizes.
//
// Design (spec section 9, icon redesigned 2026-07-10 per explicit user
// request): simple "chart going up" mark — a dark rounded-square (#101418)
// plate and ONE bold green (#42A04C) ascending polyline (3 segments,
// staircase-ish rise with a strong final upswing). No bitcoin glyph, no band
// lines, no other ornament — same design as assets/icon.svg, simplified to
// fewer segments and a thicker relative stroke so it stays legible at the
// 16-32px sizes browsers actually render favicons at.
//
// This is a plain string (NOT a String.raw literal) so it can be concatenated
// into the dashboard page; it contains no backticks and no dollar-brace runs.

export const FAVICON_SVG: string =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="BTC Power Law Model">' +
  // dark rounded plate
  '<rect width="512" height="512" rx="112" fill="#101418"/>' +
  // rising line-chart mark: one bold ascending polyline, staircase-ish
  // with a strong final upswing — thick relative stroke and few points so
  // it stays legible when shrunk to a browser tab icon
  '<polyline points="72,416 208,320 296,368 440,88" fill="none" stroke="#42A04C" ' +
  'stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';
