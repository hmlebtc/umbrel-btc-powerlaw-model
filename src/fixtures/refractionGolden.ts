/**
 * Golden expected values for the Refraction engine tests (src/refraction.test.ts).
 *
 * SOURCE   : refraction_golden.json (sha256 16ef77cec506ec57a2713d2fae92039d88c1b1cfdaa71ba6d8525a62347fbed5),
 *            produced by the Phase 1 Python reference (scripts/reference/refraction_reference.py, numpy/scipy).
 * GENERATED: by scripts/gen_refraction_golden_ts.py. Do not edit by hand.
 * pinnedQ4b: the minimax reconstruction with the published 3-decimal coefficients pinned
 *            (numeric cross-check of the published tables, section Q4b).
 *
 * TEST DATA ONLY. Published numbers (b1 ~ 5.72, c ~ 0.197, the table cells) may appear here and in
 * the tests, never in src/refraction.ts. The 5,806-row fixture-era INPUT is not copied here: the test
 * rebuilds it from HISTORY_FIXTURE + blockCountsFromSnapshot() and checks `input` below first.
 * Floats are Python repr (shortest round-trip): each literal is the reference's exact double.
 */

/** [pct, value] pairs, ascending pct. */
export type PctTable = ReadonlyArray<readonly [number, number]>;
/** [pct, cells] rows: one cell per height (null = blank cell in the published table). */
export type PctRows = ReadonlyArray<readonly [number, ReadonlyArray<number | null>]>;

/** Fixture-era fit: the app's blockchain.info fixture joined with Coin Metrics heights. */
export const FIXTURE_ERA = {
  /** Height basis: h(D) = running sum of daily block counts through D, plus this offset. */
  hOffset: -5,
  input: {
    count: 5806,
    firstDate: "2010-08-18",
    lastDate: "2026-07-10",
    firstH: 75049.0,
    lastH: 957491.0,
    sumLog10Price: 19003.85664849763,
    sumLog10H: 32829.639798563774,
  },
  fit: {
    b0: -29.623088072598332,
    b1: 5.752927724269494,
    c: 0.20867234999999998,
    alpha: 1.25,
    anchorLoss: 114.16610293240247,
    decayLoss: 4.353180990433936,
    closesBelowAnchor: 291,
    cSearchEvaluations: 345,
  },
  /** Grid offsets: d_q (q < 5), 0 (q = 5), z_q (q > 5). */
  zd: [[0.1, -0.08539261835965051], [0.25, -0.08197631566686316], [0.5, -0.07607612663765953], [1, -0.05357176767631414], [2, -0.019359487232485463], [3, -0.013548116144752858], [4, -0.006933551372320146], [5, 0.0], [7.5, 0.03669447536100347], [10, 0.07964811679319114], [15, 0.13218626034266423], [20, 0.1840038103971706], [25, 0.23592286409906918], [30, 0.29381904606742687], [40, 0.4200759409374995], [50, 0.5792319859401025], [60, 0.7640763950884272], [70, 0.9316471098373887], [75, 1.026940145284055], [80, 1.1391560224933488], [85, 1.2342110263884793], [90, 1.3280241412381129], [95, 1.5086005328340921], [97.5, 1.6799881261167076], [99, 1.7826087564453328], [99.5, 1.8208923633365692], [99.9, 1.8667745139177379]] as PctTable,
  /** Line probes: price of line q at height h. */
  lines: [
    { q: 0.1, h: 75000.0, usd: 0.02174675234627653 },
    { q: 1, h: 200000.0, usd: 6.603627827463863 },
    { q: 5, h: 420000.0, usd: 533.4069507380148 },
    { q: 15, h: 630000.0, usd: 6395.458104118729 },
    { q: 25, h: 840000.0, usd: 34872.221304171355 },
    { q: 50, h: 957491.0, usd: 89816.66349684197 },
    { q: 75, h: 1010051.0, usd: 154757.7573045615 },
    { q: 95, h: 1115315.0, usd: 312295.48501534096 },
    { q: 99.9, h: 1220435.0, usd: 530684.7903646919 },
    { q: 99, h: 2000000.0, usd: 4938664.041417278 },
  ],
  /** Percentile probes: exact type-8 inverse (`pct`) and the plain coverage share (`shareBelowPct`). */
  percentiles: [
    { h: 75000.0, usd: 0.07, pct: 41.803769754201355, shareBelowPct: 41.8015845676886 },
    { h: 210000.0, usd: 13.0, pct: 15.591961979042699, shareBelowPct: 15.587323458491218 },
    { h: 420000.0, usd: 650.0, pct: 14.629772345170377, shareBelowPct: 14.622803995866345 },
    { h: 630000.0, usd: 8800.0, pct: 39.008402448211335, shareBelowPct: 39.0113675508095 },
    { h: 840000.0, usd: 64000.0, pct: 72.34424181611158, shareBelowPct: 72.33895969686532 },
    { h: 957491.0, usd: 57000.0, pct: 1.3057745629000628, shareBelowPct: 1.3089906992766105 },
    { h: 957491.0, usd: 108000.0, pct: 66.03568281966396, shareBelowPct: 66.03513606613848 },
    { h: 957491.0, usd: 200000.0, pct: 98.98922723183736, shareBelowPct: 98.98380985187737 },
    { h: 957491.0, usd: 1000000.0, pct: 99.98851828463174, shareBelowPct: 100.0 },
    { h: 1220435.0, usd: 150000.0, pct: 0.011481715368276023, shareBelowPct: 0.0 },
  ],
  tolerances: {
    b0b1Abs: 1e-09,
    cAbs: 1e-07,
    zdAbs: 1e-07,
    lossRel: 1e-09,
    lineRel: 1e-07,
    pctAbs: 1e-06,
  },
} as const;

/** Published rounded coefficients + back-solved z/d (golden `published_evaluator`). */
export const PUBLISHED_EVALUATOR = {
  b0: -29.445,
  b1: 5.722,
  c: 0.1968,
  alpha: 1.25,
  zd: [[0.1, -0.0883], [1, -0.0567], [5, 0.0], [15, 0.1141], [25, 0.2137], [50, 0.5308], [75, 0.967], [95, 1.4421], [99.9, 1.7835]] as PctTable,
  heights: [977620, 1030180, 1135444, 1240564] as ReadonlyArray<number>,
  /** Reference model outputs per (pct, height). */
  lines: [[0.1, [55265.38307561258, 74574.24057633996, 130124.25265194899, 215967.75547535202]], [1, [59436.4941468226, 80202.67239358567, 139945.27768903016, 232267.75098348293]], [5, [67725.65044028635, 91387.92980432147, 159462.38238956995, 264660.36965102144]], [15, [73427.51571525267, 98412.73792282821, 169643.4640980931, 278645.02591239946]], [25, [78795.82484770492, 104984.8261906172, 179060.67071940642, 291455.21465959295]], [50, [98643.11123585746, 128976.50069145918, 212667.15340598006, 336294.71314148814]], [75, [134361.34396754726, 171185.3201822775, 269437.08926127874, 409459.1460691165]], [95, [188126.70609901636, 233016.98032296816, 348640.7358759478, 507370.365091022]], [99.9, [239602.0310424085, 290818.0131707797, 419568.3940668645, 591882.973607939]]] as PctRows,
  /** The author's published table (whole dollars). */
  published: [[0.1, [55231, 74528, 130044, 215835]], [5, [67686, 91334, 159369, 264507]], [25, [78750, 104924, 178958, 291289]], [50, [98583, 128899, 212540, 336096]], [75, [134284, 171087, 269282, 409224]], [95, [188008, 232871, 348424, 507059]], [99.9, [239458, 290643, 419317, 591529]]] as PctRows,
} as const;

/** Own fit on Coin Metrics, 5,975 closes to 2026-11-25 (golden `replica_25nov`). */
export const REPLICA_25NOV = {
  b0: -29.444769530261393,
  b1: 5.721929179683318,
  c: 0.19680658999999998,
  alpha: 1.25,
  zd: [[0.1, -0.08831577637732002], [1, -0.056676487952070406], [5, 0.0], [15, 0.11401924029762343], [25, 0.21372227773373925], [50, 0.5307870926051439], [75, 0.9670363742364673], [95, 1.442062736796058], [99.9, 1.7835088083978317]] as PctTable,
  heights: [977595, 1030155, 1135419, 1240539] as ReadonlyArray<number>,
  /** Reference model outputs per (pct, height). */
  lines: [[0.1, [55230.64362629865, 74527.64370180361, 130043.72406418169, 215835.0525990424]], [5, [67685.53728114883, 91334.14487048709, 159369.48685375083, 264507.35570126533]], [25, [78750.24545806047, 104924.32402250277, 178958.0536719354, 291288.81514542014]], [50, [98583.31083282108, 128898.80549245153, 212540.39774330278, 336095.96884533577]], [75, [134284.0480354175, 171086.89824726575, 269282.2611478804, 409223.90517274785]], [95, [188007.86300341, 232870.7333046352, 348424.4563251416, 507058.8395653584]], [99.9, [239457.7454961009, 290643.15253113944, 419316.84528766293, 591529.1872899912]]] as PctRows,
  /** The author's published table (whole dollars). */
  published: [[0.1, [55231, 74528, 130044, 215835]], [5, [67686, 91334, 159369, 264507]], [25, [78750, 104924, 178958, 291289]], [50, [98583, 128899, 212540, 336096]], [75, [134284, 171087, 269282, 409224]], [95, [188008, 232871, 348424, 507059]], [99.9, [239458, 290643, 419317, 591529]]] as PctRows,
} as const;

/** Own fit on Coin Metrics, 5,974 closes to 2026-11-24 (golden `replica_24nov`). */
export const REPLICA_24NOV = {
  b0: -29.44542637264385,
  b1: 5.7220464611428445,
  c: 0.19682128999999998,
  alpha: 1.25,
  zd: [[0.1, -0.08831349152377226], [1, -0.05668716644217178], [5, 0.0], [15, 0.11406727641320916], [50, 0.5308519559383249], [75, 0.9671428715626028], [95, 1.4421471020128152], [99.9, 1.783584176229717]] as PctTable,
  heights: [977435, 1240379] as ReadonlyArray<number>,
  /** Reference model outputs per (pct, height). */
  lines: [[0.1, [55185.03558645298, 215705.66655448187]], [1, [59353.68015270898, 231999.94353078786]], [15, [73322.11700863743, 278312.6991376819]], [50, [98511.2356610103, 335912.14961451857]], [75, [134195.7905163804, 409017.3764047272]], [95, [187890.43646738856, 506810.82623682386]], [99.9, [239314.97804115975, 591248.318997152]]] as PctRows,
  /** The author's published table (whole dollars). */
  published: [[0.1, [55185, 215706]], [1, [59354, null]], [15, [73322, 278313]], [50, [98511, 335912]], [75, [134196, 409017]], [95, [187890, 506811]], [99.9, [239315, 591248]]] as PctRows,
} as const;

/** Published coefficients pinned, z/d and h_today re-solved (numeric-check.md Q4b; reported worst cell 0.00769%). */
export const PINNED_Q4B = {
  b0: -29.445,
  b1: 5.722,
  c: 0.1968,
  alpha: 1.25,
  zd: [[0.1, -0.088311], [5, 0.0], [25, 0.213687], [50, 0.530684], [75, 0.966844], [95, 1.441771], [99.9, 1.783144]] as PctTable,
  heights: [977506.81, 1030066.81, 1135330.81, 1240450.81] as ReadonlyArray<number>,
  /** The author's published table (whole dollars). */
  published: [[0.1, [55231, 74528, 130044, 215835]], [5, [67686, 91334, 159369, 264507]], [25, [78750, 104924, 178958, 291289]], [50, [98583, 128899, 212540, 336096]], [75, [134284, 171087, 269282, 409224]], [95, [188008, 232871, 348424, 507059]], [99.9, [239458, 290643, 419317, 591529]]] as PctRows,
  /** Worst relative error numeric-check.md reports for this reconstruction. */
  reportedWorstRel: 7.69e-5,
} as const;
