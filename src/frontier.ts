/**
 * The geometry tier ranking is derived from: the Pareto frontier over
 * (cost, capability), its marginal slopes, its knee, and the wasteful tail.
 *
 * No imports, like `effort.ts`, so `catalog.ts` can use it without a cycle and
 * so every property below is provable without a catalog, a config or a TTY.
 *
 * One axis note that shapes all of it: **capability is an index and cost is a
 * ratio scale.** AA's indices are bounded scores where *differences* are
 * meaningful and ratios are not — 21 to 46 is not "2.2x smarter" — while
 * dollars genuinely multiply. So marginal value is measured as `ΔI / Δlog C`,
 * points per cost decade, which matches the nature of each axis. `I / C` does
 * not, and using it is what buried the knee: on a real catalog the knee of the
 * frontier ranked 12th of 129 by `I / C`, because that ratio is maximised
 * exactly where cheapness stops paying for itself.
 */

export interface Point {
  /** Whatever this tier measures capability with. Higher is better. */
  capability: number;
  /** Cost per task in dollars. Must be > 0 to take part. */
  cost: number;
}

/**
 * Indices of the Pareto-optimal points, ordered by ascending cost.
 *
 * A point is on the frontier when nothing else is at least as capable for no
 * more money. Dominance is **scale-free** — it survives any monotone transform
 * of either axis — so frontier membership owes nothing to how a chart happens
 * to be drawn, which is what makes it safe to build a ranking on.
 *
 * Ties are resolved by keeping the first: two points at the same cost and
 * capability are interchangeable, and admitting both would put a duplicate on
 * the frontier and distort the knee's chord.
 */
export function frontierIndices(points: readonly Point[]): number[] {
  const live = points
    .map((point, index) => ({ point, index }))
    .filter((entry) => entry.point.cost > 0 && Number.isFinite(entry.point.capability));
  const kept: Array<{ point: Point; index: number }> = [];
  for (const a of live) {
    const beaten = live.some((b) => b.index !== a.index
      && b.point.capability >= a.point.capability
      && b.point.cost <= a.point.cost
      && (b.point.capability > a.point.capability
        || b.point.cost < a.point.cost
        // A genuine duplicate: keep the earlier index, drop the later one.
        || b.index < a.index));
    if (!beaten) kept.push(a);
  }
  return kept.sort((a, b) => a.point.cost - b.point.cost).map((entry) => entry.index);
}

/**
 * Marginal capability per cost decade between consecutive frontier points.
 *
 * `slopes[i]` is what the step from `frontier[i]` to `frontier[i + 1]` buys.
 * Length is one less than the frontier.
 */
export function slopes(frontier: readonly Point[]): number[] {
  return frontier.slice(1).map((point, i) => {
    const decades = Math.log10(point.cost / frontier[i]!.cost);
    // Two points at one price have no decade between them, so the step buys
    // its capability for nothing — unbounded return rather than a division by
    // zero, and it can never be cut as wasteful, which is correct.
    if (decades === 0) return Number.POSITIVE_INFINITY;
    return (point.capability - frontier[i]!.capability) / decades;
  });
}

/**
 * How many leading frontier points survive the wasteful-tail gate.
 *
 * Walks down from the most expensive end, cutting while a rung returns less
 * than `frac` of the frontier's median slope, and stops at the first rung that
 * pays. Measured on a real catalog this removes exactly the rungs that buy
 * almost nothing for a lot — one of them bought +0.3 index points for 41% more
 * money, and the same rung was independently rejected on a second metric where
 * it bought +0.1 for 12.9x more.
 *
 * **Trailing only, never the middle.** A poor rung between two good ones is the
 * frontier crossing a capability gap — there is simply nothing available at
 * that level for less — rather than waste. Cutting there would sever the
 * frontier at its knee and collapse the strong tier onto the value tier's lead.
 *
 * The bar is a fraction of the median rather than a fixed number of points,
 * because the whole premise is that the frontier moves: a constant would
 * silently become wrong the first time the index rescaled.
 *
 * At least two points always survive, so a frontier can never be gated away
 * entirely.
 */
export function keptAfterGate(frontier: readonly Point[], frac = 1 / 3): number {
  const marginal = slopes(frontier);
  if (marginal.length === 0) return frontier.length;
  const finite = marginal.filter((slope) => Number.isFinite(slope)).sort((a, b) => a - b);
  if (finite.length === 0) return frontier.length;
  const bar = finite[Math.floor(finite.length / 2)]! * frac;
  let end = frontier.length;
  while (end > 2 && marginal[end - 2]! < bar) end--;
  return end;
}

/**
 * The knee: the frontier point furthest above the chord joining its endpoints,
 * measured on (log₁₀ cost, capability) normalised to the unit square.
 *
 * This is Kneedle, and it reproduces Artificial Analysis's own published
 * frontier exactly — 12 points, same knee — which is the check that validated
 * the whole computation rather than merely making it plausible.
 *
 * **Compute this on the FULL frontier, before `keptAfterGate`.** Kneedle
 * measures against a chord between the endpoints and the gate removes the far
 * endpoint, so gating first moves the knee — and the knee would then inherit
 * the gate's tuned fraction, destroying the one property that makes it worth
 * trusting. Measured: cutting a single near-worthless rung off one real
 * frontier moved the knee from $0.2533 to $0.0156, sixteen times apart, on the
 * model that leads the default tier.
 *
 * Fewer than three points has no interior, and a flat or vertical frontier has
 * no chord to measure against. Those answer `undefined` — **no knee** — never
 * 0. Returning the cheapest point as a stand-in let the caller treat it as a
 * real knee: `normal` promoted the cheapest candidate to its head, overriding
 * the value order it should have kept, and `complex` gained a boundary that
 * nothing measured.
 */
export function kneeIndex(frontier: readonly Point[]): number | undefined {
  if (frontier.length < 3) return undefined;
  const xs = frontier.map((point) => Math.log10(point.cost));
  const ys = frontier.map((point) => point.capability);
  const dx = xs[xs.length - 1]! - xs[0]!;
  const dy = ys[ys.length - 1]! - ys[0]!;
  if (dx === 0 || dy === 0) return undefined;
  let best = Number.NEGATIVE_INFINITY;
  let at = 0;
  frontier.forEach((_, i) => {
    const lift = (ys[i]! - ys[0]!) / dy - (xs[i]! - xs[0]!) / dx;
    if (lift > best) { best = lift; at = i; }
  });
  return at;
}
