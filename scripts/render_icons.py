#!/usr/bin/env python3
"""Render assets/icon-512.png and assets/icon-256.png.

Python 3 stdlib only (zlib, struct, math) - no Pillow, no cairosvg. This
does NOT parse assets/icon.svg; it re-draws the same shapes analytically
from the same design-space coordinates (a 512x512 unit canvas), so the
two files are two independent renderers of one design that must be kept
in sync by hand if the design ever changes. Simple "chart going up" mark
(redesigned 2026-07-10 per explicit user request - spec section 9):

  - a flat dark rounded-square background (#101418, rx=112)
  - ONE bold rising green (#42a04c) polyline - a staircase-ish rise (with
    one small pull-back, like a real chart) ending in a strong final
    upswing - rendered as a "thick polyline via distance test": each
    pixel's distance to the nearest polyline segment is compared against
    a half-thickness, rather than using a stroke primitive
  - small circle markers at each vertex of that polyline, same color, so
    the corners read as deliberate data points rather than just rounded
    joins

No bitcoin glyph, no band lines, no other ornament.

Anti-aliasing is done by 4x supersampling: each output pixel is sampled
on a 4x4 subpixel grid, shape membership is tested exactly (analytic
rounded-rect / circle / distance-to-segment containment, no fuzz), and
the samples are averaged in premultiplied-alpha space before being
written out - so edges (the rounded corners, the curve, the vertex dots)
come out smooth instead of jagged, and the transparent corners outside
the rounded square don't bleed a dark fringe into the background.

Usage: python scripts/render_icons.py
Writes assets/icon-512.png and assets/icon-256.png (RGBA, non-indexed).
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = REPO_ROOT / "assets"

# ---------------------------------------------------------------------------
# Design-space geometry (a 512x512 unit canvas - matches assets/icon.svg)
# ---------------------------------------------------------------------------

CANVAS = 512.0
SUPERSAMPLE = 4

# Flat dark rounded-square background: (x0, y0, x1, y1, corner radius)
BG_RECT = (0.0, 0.0, 512.0, 512.0, 112.0)
BG_COLOR = (0x10, 0x14, 0x18)

# Rising line-chart mark: one bold ascending polyline, staircase-ish with
# a small pull-back and a strong final upswing (generally up-and-to-the-
# right, like a rising stock chart). Point list is shared verbatim with
# assets/icon.svg's <polyline> and vertex <circle> centers.
CURVE_POINTS = (
    (92.0, 390.0),
    (198.0, 344.0),
    (268.0, 372.0),
    (356.0, 288.0),
    (432.0, 104.0),
)
CURVE_HALF_THICKNESS = 14.0
CURVE_COLOR = (0x42, 0xA0, 0x4C)

# Small circle markers at each vertex, same color as the line, so the
# corners read as deliberate data points.
VERTEX_DOT_RADIUS = 22.0


# ---------------------------------------------------------------------------
# Analytic shape containment tests
# ---------------------------------------------------------------------------


def in_rounded_rect(px: float, py: float, x0: float, y0: float, x1: float, y1: float, r: float) -> bool:
    """True if (px, py) lies inside the rounded rect [x0,x1]x[y0,y1] with corner radius r."""
    if px < x0 or px > x1 or py < y0 or py > y1:
        return False
    # Clamp the point onto the "inner" rect whose corners are the rounded
    # corners' centers; the point is inside iff it's within r of that clamp.
    nx = x0 + r if px < x0 + r else (x1 - r if px > x1 - r else px)
    ny = y0 + r if py < y0 + r else (y1 - r if py > y1 - r else py)
    dx = px - nx
    dy = py - ny
    return dx * dx + dy * dy <= r * r


def in_circle(px: float, py: float, cx: float, cy: float, r: float) -> bool:
    dx = px - cx
    dy = py - cy
    return dx * dx + dy * dy <= r * r


def dist_to_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    """Euclidean distance from (px,py) to the segment a->b."""
    dx = bx - ax
    dy = by - ay
    len_sq = dx * dx + dy * dy
    if len_sq <= 0.0:
        ex, ey = px - ax, py - ay
        return (ex * ex + ey * ey) ** 0.5
    t = ((px - ax) * dx + (py - ay) * dy) / len_sq
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    cx = ax + t * dx
    cy = ay + t * dy
    ex, ey = px - cx, py - cy
    return (ex * ex + ey * ey) ** 0.5


def dist_to_polyline(px: float, py: float, points) -> float:
    best = float("inf")
    for i in range(len(points) - 1):
        ax, ay = points[i]
        bx, by = points[i + 1]
        d = dist_to_segment(px, py, ax, ay, bx, by)
        if d < best:
            best = d
    return best


def sample(dx: float, dy: float) -> tuple[float, float, float, float]:
    """Straight-alpha (r, g, b, a) of the design at one design-space point."""
    bx0, by0, bx1, by1, br = BG_RECT
    if in_rounded_rect(dx, dy, bx0, by0, bx1, by1, br):
        r, g, b = float(BG_COLOR[0]), float(BG_COLOR[1]), float(BG_COLOR[2])
        a = 1.0
    else:
        r = g = b = 0.0
        a = 0.0

    if dist_to_polyline(dx, dy, CURVE_POINTS) <= CURVE_HALF_THICKNESS:
        r, g, b, a = float(CURVE_COLOR[0]), float(CURVE_COLOR[1]), float(CURVE_COLOR[2]), 1.0

    for cx, cy in CURVE_POINTS:
        if in_circle(dx, dy, cx, cy, VERTEX_DOT_RADIUS):
            r, g, b, a = float(CURVE_COLOR[0]), float(CURVE_COLOR[1]), float(CURVE_COLOR[2]), 1.0

    return r, g, b, a


# ---------------------------------------------------------------------------
# Rasterizer
# ---------------------------------------------------------------------------


def render(size: int, ss: int = SUPERSAMPLE) -> bytearray:
    """Render an RGBA raster of `size`x`size` pixels, supersampled `ss`x per axis."""
    scale = CANVAS / size
    n = ss * ss
    offsets = [(k + 0.5) / ss for k in range(ss)]
    pixels = bytearray(size * size * 4)

    for oy in range(size):
        dys = [(oy + off) * scale for off in offsets]
        row_off = oy * size * 4
        for ox in range(size):
            dxs = [(ox + off) * scale for off in offsets]
            sr = sg = sb = sa = 0.0
            for dy in dys:
                for dx in dxs:
                    r, g, b, a = sample(dx, dy)
                    if a:
                        sr += r * a
                        sg += g * a
                        sb += b * a
                        sa += a
            a_avg = sa / n
            if a_avg > 0.0:
                r_out = sr / n / a_avg
                g_out = sg / n / a_avg
                b_out = sb / n / a_avg
            else:
                r_out = g_out = b_out = 0.0
            idx = row_off + ox * 4
            pixels[idx] = _clamp_byte(r_out)
            pixels[idx + 1] = _clamp_byte(g_out)
            pixels[idx + 2] = _clamp_byte(b_out)
            pixels[idx + 3] = _clamp_byte(a_avg * 255.0)

    return pixels


def _clamp_byte(v: float) -> int:
    iv = int(round(v))
    if iv < 0:
        return 0
    if iv > 255:
        return 255
    return iv


# ---------------------------------------------------------------------------
# Minimal PNG encoder (RGBA, 8-bit, non-interlaced, color type 6)
# ---------------------------------------------------------------------------


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path: Path, size: int, pixels: bytearray) -> None:
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter type 0 (None) per scanline
        raw.extend(pixels[y * stride : (y + 1) * stride])

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA, no interlace
    idat = zlib.compress(bytes(raw), 9)

    with open(path, "wb") as f:
        f.write(sig)
        f.write(_png_chunk(b"IHDR", ihdr))
        f.write(_png_chunk(b"IDAT", idat))
        f.write(_png_chunk(b"IEND", b""))


def main() -> None:
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    for size in (512, 256):
        pixels = render(size)
        out_path = ASSETS_DIR / f"icon-{size}.png"
        write_png(out_path, size, pixels)
        print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
