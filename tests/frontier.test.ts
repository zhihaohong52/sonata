import { describe, it, expect } from 'vitest';
import { frontierIndices, slopes, keptAfterGate, kneeIndex, type Point } from '../src/frontier.js';

const p = (capability: number, cost: number): Point => ({ capability, cost });

/** The real 2026-09-22 intelligence frontier, which reproduces AA's chart. */
const AA_FRONTIER: Point[] = [
  p(9.1, 0.0060),   // granite-4.2-3b
  p(21.0, 0.0098),  // luna@low
  p(25.0, 0.0156),  // luna@medium
  p(32.1, 0.0440),  // luna@high
  p(34.6, 0.0853),  // luna@xhigh
  p(46.3, 0.1332),  // mimo-v2.6-pro    <- the knee
  p(49.6, 1.5406),  // astra@medium
  p(50.9, 1.7253),  // astra@high
  p(52.4, 2.3088),  // astra@xhigh
  p(52.7, 3.2575),  // astra@max        <- gated
  p(53.2, 5.9783),  // fable-5.1@xhigh  <- gated
  p(53.4, 7.6297),  // fable-5.1@max    <- gated
];

/**
 * The real agentic frontier from the same config. Its last rung buys +0.1
 * capability for 12.9x the cost, and cutting it moves the knee.
 */
const AGENTIC_FRONTIER: Point[] = [
  p(16.1, 0.0098),  // luna@low
  p(23.9, 0.0156),  // luna@medium
  p(34.6, 0.0440),  // luna@high
  p(38.7, 0.0853),  // luna@xhigh
  p(46.3, 0.1332),  // mimo-v2.6-pro
  p(50.9, 0.2533),  // glm-5.3-flash   <- the knee, before gating
  p(51.0, 3.2575),  // astra@max       <- gated
];

describe('frontierIndices', () => {
  it('drops a point beaten on both axes', () => {
    // luna@none vs luna@low on the real catalog: dearer AND weaker.
    expect(frontierIndices([p(21.0, 0.0098), p(15.5, 0.0101)])).toEqual([0]);
  });

  it('keeps a dearer point that is more capable', () => {
    expect(frontierIndices([p(21, 0.01), p(46, 0.13)])).toEqual([0, 1]);
  });

  it('drops a point at equal capability and higher cost', () => {
    expect(frontierIndices([p(30, 0.10), p(30, 0.20)])).toEqual([0]);
  });

  it('keeps only one of two identical points', () => {
    // Admitting both would put a duplicate on the frontier and distort the
    // chord the knee is measured against.
    expect(frontierIndices([p(30, 0.10), p(30, 0.10)])).toEqual([0]);
  });

  it('orders by ascending cost, not by input order', () => {
    const order = frontierIndices([p(46, 0.13), p(21, 0.01), p(32, 0.04)]);
    expect(order).toEqual([1, 2, 0]);
  });

  it('excludes zero and negative costs', () => {
    // Six models in the real catalog report a zero cost per task, which makes
    // value infinite. Missing data is likelier than free inference.
    expect(frontierIndices([p(4, 0), p(21, 0.01)])).toEqual([1]);
  });

  it('excludes a non-finite capability', () => {
    expect(frontierIndices([p(Number.NaN, 0.01), p(21, 0.02)])).toEqual([1]);
  });

  it('is empty for no points', () => {
    expect(frontierIndices([])).toEqual([]);
  });
});

describe('slopes', () => {
  it('measures capability per cost decade', () => {
    // Exactly one decade apart, ten points gained.
    expect(slopes([p(10, 0.1), p(20, 1)])).toEqual([10]);
  });

  it('reports the real frontier the way the design records it', () => {
    const measured = slopes(AA_FRONTIER).map((s) => Number(s.toFixed(1)));
    expect(measured.slice(-3)).toEqual([2.0, 1.9, 1.9]);
    // The knee crossing: 11.6x the money for 3.3 points.
    expect(measured[5]).toBeCloseTo(3.1, 1);
  });

  it('returns unbounded return for two points at one price', () => {
    // No decades between them, so the capability was bought for nothing. It
    // must never read as wasteful.
    expect(slopes([p(10, 0.5), p(20, 0.5)])).toEqual([Number.POSITIVE_INFINITY]);
  });

  it('is empty for a single point', () => {
    expect(slopes([p(10, 0.1)])).toEqual([]);
  });
});

describe('keptAfterGate', () => {
  it('cuts the trailing run of near-worthless rungs', () => {
    // The three fable/astra top rungs, each under 2 points per decade against
    // a median of 11.9.
    expect(keptAfterGate(AA_FRONTIER)).toBe(AA_FRONTIER.length - 3);
  });

  it('never cuts a poor rung with a good one above it', () => {
    // `mimo -> astra@medium` is 3.1/decade and below the bar, but it is the
    // frontier crossing a capability gap rather than waste. Cutting there
    // would sever the frontier at its knee.
    const kept = keptAfterGate(AA_FRONTIER);
    expect(kept).toBeGreaterThan(6);
  });

  it('keeps everything when no rung is wasteful', () => {
    expect(keptAfterGate([p(10, 0.1), p(20, 1), p(30, 10)])).toBe(3);
  });

  it('never gates a frontier below two points', () => {
    expect(keptAfterGate([p(10, 0.1), p(10.01, 100)])).toBe(2);
  });

  it('is stable across a wide band of fractions', () => {
    // The design's sensitivity claim, asserted rather than assumed. It holds
    // because this frontier has a gap in its slopes from 2.0 to 11.9 — a
    // property of the data, which is why the spec says to re-measure.
    for (const frac of [0.25, 1 / 3, 0.5, 0.75, 1]) {
      expect(keptAfterGate(AA_FRONTIER, frac)).toBe(AA_FRONTIER.length - 3);
    }
  });

  it('handles a frontier of one', () => {
    expect(keptAfterGate([p(10, 0.1)])).toBe(1);
  });
});

describe('kneeIndex', () => {
  it('finds the knee AA publishes', () => {
    expect(kneeIndex(AA_FRONTIER)).toBe(5);  // mimo-v2.6-pro
  });

  it('moves when the far endpoint is removed, which is why order matters', () => {
    // The constraint the implementation exists to honour: compute the knee on
    // the FULL frontier, gate afterwards. Kneedle measures against a chord
    // between endpoints, so removing the far end moves the answer — and the
    // knee would then inherit the gate's tuned fraction.
    //
    // Measured on the real AGENTIC frontier, where the last rung buys +0.1
    // for 12.9x the money: the knee moves from glm-5.3-flash ($0.2533) to
    // luna@medium ($0.0156), sixteen times apart, on the model that leads the
    // default tier.
    const gated = AGENTIC_FRONTIER.slice(0, keptAfterGate(AGENTIC_FRONTIER));
    expect(kneeIndex(AGENTIC_FRONTIER)).toBe(5);   // glm-5.3-flash
    expect(kneeIndex(gated)).toBe(1);              // luna@medium
  });

  it('does not always move, which is why the hazard is easy to miss', () => {
    // On the intelligence frontier the gate happens NOT to move the knee. A
    // single fixture would therefore have "proved" the order does not matter.
    const gated = AA_FRONTIER.slice(0, keptAfterGate(AA_FRONTIER));
    expect(kneeIndex(gated)).toBe(kneeIndex(AA_FRONTIER));
  });

  // "No knee" is `undefined`, never 0. Answering the cheapest point as a
  // stand-in let `proposeTiers` treat it as a real knee: `normal` promoted
  // the cheapest candidate over its own value order, and `complex` gained a
  // boundary nothing measured.
  it('reports no knee when there is no interior', () => {
    expect(kneeIndex([p(10, 0.1), p(20, 1)])).toBeUndefined();
    expect(kneeIndex([p(10, 0.1)])).toBeUndefined();
    expect(kneeIndex([])).toBeUndefined();
  });

  it('reports no knee on a flat frontier', () => {
    // No capability gained across the range: there is no tradeoff to find.
    expect(kneeIndex([p(10, 0.1), p(10, 1), p(10, 10)])).toBeUndefined();
  });

  it('reports no knee when every point shares a cost', () => {
    expect(kneeIndex([p(10, 0.5), p(20, 0.5), p(30, 0.5)])).toBeUndefined();
  });
});
