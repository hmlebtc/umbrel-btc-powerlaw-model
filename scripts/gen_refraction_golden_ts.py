"""Generate src/fixtures/refractionGolden.ts from the reference implementation's golden JSON.

Usage: python3 -I scripts/gen_refraction_golden_ts.py <refraction_golden.json> <out.ts>
       e.g. ... refraction_golden.json src/fixtures/refractionGolden.ts

INPUT: the golden JSON written by the Python reference (scripts/reference/refraction_reference.py,
numpy/scipy) when it was run on the fixture-era data and on the 24/25 Nov 2026 Coin Metrics
replicas. Required top-level keys: procedure (with h_offset), fixture_era (inputs, fit,
tolerances, zd, ...), published_evaluator, replica_25nov, replica_24nov. The JSON is not stored
in the repo; its sha256 is recorded in the generated header.
Writes only the EXPECTED values the tests need (not the 5,806-row input arrays: the test rebuilds
the input from the app's own fixtures and checks the golden's checksum first).

Floats are emitted with Python repr (shortest round-trip), so every number in the TS file parses to
the identical IEEE double that the Python reference produced.

The `pinnedQ4b` block is not in the golden JSON: it is the minimax reconstruction with the published
3-decimal coefficients pinned, from the numeric cross-check of the published tables (section Q4b)
(h_today = 977506.81, increments 144 * calendar days = 52560 / 157824 / 262944).
"""
import hashlib
import json
import sys



def js(v):
    return json.dumps(v, allow_nan=False)


def keyed(d):
    """{ '0.1': x, ... } -> TS array of [pct, value] pairs in ascending pct (keys as numbers)."""
    items = sorted(((float(k), v) for k, v in d.items()), key=lambda kv: kv[0])
    return "[" + ", ".join("[%s, %s]" % (js(k if k != int(k) else int(k)), js(v)) for k, v in items) + "]"


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    golden_path, out_path = sys.argv[1], sys.argv[2]
    raw = open(golden_path, "rb").read()
    sha = hashlib.sha256(raw).hexdigest()
    G = json.loads(raw)
    fe = G["fixture_era"]
    inp = fe["inputs"]
    fit = fe["fit"]
    tol = fe["tolerances"]
    pe = G["published_evaluator"]
    r25 = G["replica_25nov"]
    r24 = G["replica_24nov"]
    assert G["procedure"]["h_offset"] == -5
    assert len(fe["zd"]) == 27

    def rows(table):
        return "[" + ", ".join("[%s, %s]" % (js(float(k) if float(k) != int(float(k)) else int(float(k))), js(v))
                               for k, v in sorted(table.items(), key=lambda kv: float(kv[0]))) + "]"

    out = []
    w = out.append
    w("/**")
    w(" * Golden expected values for the Refraction engine tests (src/refraction.test.ts).")
    w(" *")
    w(" * SOURCE   : refraction_golden.json (sha256 %s)," % sha)
    w(" *            produced by the Phase 1 Python reference (scripts/reference/refraction_reference.py, numpy/scipy).")
    w(" * GENERATED: by scripts/gen_refraction_golden_ts.py. Do not edit by hand.")
    w(" * pinnedQ4b: the minimax reconstruction with the published 3-decimal coefficients pinned")
    w(" *            (numeric cross-check of the published tables, section Q4b).")
    w(" *")
    w(" * TEST DATA ONLY. Published numbers (b1 ~ 5.72, c ~ 0.197, the table cells) may appear here and in")
    w(" * the tests, never in src/refraction.ts. The 5,806-row fixture-era INPUT is not copied here: the test")
    w(" * rebuilds it from HISTORY_FIXTURE + blockCountsFromSnapshot() and checks `input` below first.")
    w(" * Floats are Python repr (shortest round-trip): each literal is the reference's exact double.")
    w(" */")
    w("")
    w("/** [pct, value] pairs, ascending pct. */")
    w("export type PctTable = ReadonlyArray<readonly [number, number]>;")
    w("/** [pct, cells] rows: one cell per height (null = blank cell in the published table). */")
    w("export type PctRows = ReadonlyArray<readonly [number, ReadonlyArray<number | null>]>;")
    w("")
    w("/** Fixture-era fit: the app's blockchain.info fixture joined with Coin Metrics heights. */")
    w("export const FIXTURE_ERA = {")
    w("  /** Height basis: h(D) = running sum of daily block counts through D, plus this offset. */")
    w("  hOffset: %s," % js(G["procedure"]["h_offset"]))
    w("  input: {")
    for k_ts, k in [("count", "count"), ("firstDate", "first_date"), ("lastDate", "last_date"),
                    ("firstH", "first_h"), ("lastH", "last_h"), ("sumLog10Price", "sum_log10_price"),
                    ("sumLog10H", "sum_log10_h")]:
        w("    %s: %s," % (k_ts, js(inp[k])))
    w("  },")
    w("  fit: {")
    w("    b0: %s," % js(fit["b0"]))
    w("    b1: %s," % js(fit["b1"]))
    w("    c: %s," % js(fit["c"]))
    w("    alpha: %s," % js(fit["alpha"]))
    w("    anchorLoss: %s," % js(fit["anchor_pinball_loss"]))
    w("    decayLoss: %s," % js(fit["decay_objective"]))
    w("    closesBelowAnchor: %s," % js(fit["closes_below_anchor"]))
    w("    cSearchEvaluations: %s," % js(fit["c_search_evaluations"]))
    w("  },")
    w("  /** Grid offsets: d_q (q < 5), 0 (q = 5), z_q (q > 5). */")
    w("  zd: %s as PctTable," % keyed(fe["zd"]))
    w("  /** Line probes: price of line q at height h. */")
    w("  lines: [")
    for L in fe["lines"]:
        w("    { q: %s, h: %s, usd: %s }," % (js(L["q"]), js(L["h"]), js(L["usd"])))
    w("  ],")
    w("  /** Percentile probes: exact type-8 inverse (`pct`) and the plain coverage share (`shareBelowPct`). */")
    w("  percentiles: [")
    for P in fe["percentiles"]:
        w("    { h: %s, usd: %s, pct: %s, shareBelowPct: %s }," % (js(P["h"]), js(P["usd"]), js(P["pct"]),
                                                                js(P["share_below_pct"])))
    w("  ],")
    w("  tolerances: {")
    for k_ts, k in [("b0b1Abs", "b0_b1_abs"), ("cAbs", "c_abs"), ("zdAbs", "zd_abs"), ("lossRel", "loss_rel"),
                    ("lineRel", "line_rel"), ("pctAbs", "pct_abs")]:
        w("    %s: %s," % (k_ts, js(tol[k])))
    w("  },")
    w("} as const;")
    w("")

    def evaluator(name, doc, E, table_key, extra=""):
        w("/** %s */" % doc)
        w("export const %s = {" % name)
        w("  b0: %s," % js(E["b0"]))
        w("  b1: %s," % js(E["b1"]))
        w("  c: %s," % js(E["c"]))
        w("  alpha: %s," % js(E.get("alpha", G["constants"]["alpha"])))
        w("  zd: %s as PctTable," % keyed(E["zd"]))
        w("  heights: %s as ReadonlyArray<number>," % js(E["heights"]))
        if "lines" in E:
            w("  /** Reference model outputs per (pct, height). */")
            w("  lines: %s as PctRows," % rows(E["lines"]))
        w("  /** The author's published table (whole dollars). */")
        w("  published: %s as PctRows," % rows(E[table_key]))
        if extra:
            w(extra)
        w("} as const;")
        w("")

    evaluator("PUBLISHED_EVALUATOR", "Published rounded coefficients + back-solved z/d (golden `published_evaluator`).",
              pe, "published_table_25nov")
    evaluator("REPLICA_25NOV", "Own fit on Coin Metrics, 5,975 closes to 2026-11-25 (golden `replica_25nov`).",
              r25, "published_table_25nov")
    evaluator("REPLICA_24NOV", "Own fit on Coin Metrics, 5,974 closes to 2026-11-24 (golden `replica_24nov`).",
              r24, "published_table_24nov")

    q4b = {"b0": -29.445, "b1": 5.722, "c": 0.1968, "alpha": 1.25,
           "zd": {"0.1": -0.088311, "5": 0.0, "25": 0.213687, "50": 0.530684, "75": 0.966844, "95": 1.441771,
                  "99.9": 1.783144},
           "heights": [977506.81, 977506.81 + 52560, 977506.81 + 157824, 977506.81 + 262944],
           "published": pe["published_table_25nov"]}
    evaluator("PINNED_Q4B", "Published coefficients pinned, z/d and h_today re-solved (numeric-check.md Q4b; "
              "reported worst cell 0.00769%).", q4b, "published",
              "  /** Worst relative error numeric-check.md reports for this reconstruction. */\n"
              "  reportedWorstRel: 7.69e-5,")

    open(out_path, "w").write("\n".join(out))
    print("wrote", out_path)


if __name__ == "__main__":
    main()
