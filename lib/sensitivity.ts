// Sensitivity analysis for the Token Radar board.
//
// The board's ranking rests on one judgement call: the market multiple each
// category pays, read off the live-token protocols in the same snapshot. If
// that multiple is a little wrong, or a few extreme comparables drag it, does
// the ranking fall apart? This module answers that by re-scoring the board
// under three counterfactual calibrations and measuring how far the ranking
// moves. It is read-only: it never touches board.json, dossier.json or any
// file, and it only reuses the model's public scoring functions.
//
// The three scenarios:
//   - the multiple every category pays is 20% higher than calibrated;
//   - the multiple every category pays is 20% lower than calibrated;
//   - the calibration is rebuilt after dropping the live protocols whose
//     market-cap-to-TVL ratio sits in the outer 10% on either side, so the
//     most extreme comparables cannot set the multiple.
//
// A sturdy board keeps most of its top 40 under all three, moves no row very
// far, and stays monotone: the original order should still read as falling
// implied values when the perturbed scores are laid over it.

import {
  MODEL,
  calibrate,
  impliedValue,
  isPreToken,
  type BoardRow,
  type Calibration,
  type Snapshot,
  type SnapshotProtocol,
} from './model.ts';

/** How many rows count as "the top" when retention is measured. */
const TOP_N = 40;

/** What share of live ratios is trimmed from each tail in the rebuild. */
const TRIM_FRACTION = 0.1;

/** One scenario's verdict on the board. */
export interface ScenarioOutcome {
  /** What was changed about the calibration, in plain words. */
  name: string;
  /** Top-40 slugs that survive the perturbation. */
  top40Retained: number;
  /** The largest rank move any row suffers, in places. */
  maxRankShift: number;
  /** Adjacent pairs in the original order whose perturbed scores rise. */
  adjacentInversions: number;
  /** True when the original order still reads as falling scores. */
  monotoneKept: boolean;
  /** The highest and lowest perturbed implied values on the board. */
  topImplied: number;
  bottomImplied: number;
}

/** The whole analysis: one outcome per scenario plus the worst case. */
export interface SensitivityReport {
  boardSize: number;
  scenarios: ScenarioOutcome[];
  /** The smallest top-40 retention across the scenarios. */
  worstTop40Retained: number;
  /** The largest rank move across the scenarios. */
  worstMaxRankShift: number;
  /** True when every scenario keeps the board monotone. */
  allMonotone: boolean;
}

/** A calibration with every multiple multiplied by `factor`, kept in bounds. */
function scaledCalibration(cal: Calibration, factor: number): Calibration {
  const clamp = (v: number): number =>
    Math.min(MODEL.ratio_cap, Math.max(MODEL.ratio_floor, v));
  const byCategory = new Map<string, number>();
  for (const [category, ratio] of cal.byCategory) {
    byCategory.set(category, clamp(ratio * factor));
  }
  return {
    byCategory,
    overall: clamp(cal.overall * factor),
    table: cal.table.map((t) => ({
      category: t.category,
      ratio: Math.round(clamp(t.ratio * factor) * 1000) / 1000,
      comps: t.comps,
    })),
  };
}

/** Whether a protocol is one of the live comparables the calibration reads. */
function isLiveComparable(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX';
}

/** The snapshot with the extreme live comparables removed from both tails. */
function trimmedSnapshot(snapshot: Snapshot): Snapshot {
  const live = snapshot.protocols.filter(isLiveComparable);
  const ratios = live.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  if (ratios.length < 10) return snapshot;
  const low = ratios[Math.floor(TRIM_FRACTION * (ratios.length - 1))]!;
  const high = ratios[Math.ceil((1 - TRIM_FRACTION) * (ratios.length - 1))]!;
  const kept = new Set(
    live.filter((p) => {
      const r = p.mcap_usd! / p.tvl_usd;
      return r >= low && r <= high;
    }).map((p) => p.slug),
  );
  return {
    ...snapshot,
    protocols: snapshot.protocols.filter(
      (p) => !isLiveComparable(p) || kept.has(p.slug),
    ),
  };
}

/** One row re-scored under a different calibration, with its new rank. */
interface RescoredRow {
  slug: string;
  oldRank: number;
  implied: number;
  newRank: number;
}

/** Re-score every board row under `cal` and rank the results the usual way. */
function rescore(snapshot: Snapshot, board: BoardRow[], cal: Calibration): RescoredRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const scored: RescoredRow[] = board.map((row) => {
    const protocol = index.get(row.slug);
    const implied =
      protocol === undefined
        ? row.implied_value_usd
        : impliedValue(protocol, snapshot.as_of, cal, MODEL).implied;
    return { slug: row.slug, oldRank: row.rank, implied, newRank: 0 };
  });
  scored.sort(
    (a, b) => b.implied - a.implied || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
  scored.forEach((s, i) => {
    s.newRank = i + 1;
  });
  return scored;
}

/** Compare a re-scored board against the board that was published. */
function compare(name: string, board: BoardRow[], rescored: RescoredRow[]): ScenarioOutcome {
  const oldTop = new Set(board.slice(0, TOP_N).map((r) => r.slug));
  const retained = rescored
    .slice(0, TOP_N)
    .filter((s) => oldTop.has(s.slug)).length;
  let maxRankShift = 0;
  for (const s of rescored) {
    maxRankShift = Math.max(maxRankShift, Math.abs(s.newRank - s.oldRank));
  }
  const bySlug = new Map(rescored.map((s) => [s.slug, s]));
  let adjacentInversions = 0;
  for (let i = 1; i < board.length; i++) {
    const prev = bySlug.get(board[i - 1]!.slug)!;
    const cur = bySlug.get(board[i]!.slug)!;
    if (cur.implied > prev.implied) adjacentInversions++;
  }
  return {
    name,
    top40Retained: retained,
    maxRankShift,
    adjacentInversions,
    monotoneKept: adjacentInversions === 0,
    topImplied: rescored[0]?.implied ?? 0,
    bottomImplied: rescored[rescored.length - 1]?.implied ?? 0,
  };
}

/** Run all three scenarios against the board and summarise the worst case. */
export function analyseSensitivity(snapshot: Snapshot, board: BoardRow[]): SensitivityReport {
  const base = calibrate(snapshot, MODEL);
  const scenarios: ScenarioOutcome[] = [
    compare('multiple +20%', board, rescore(snapshot, board, scaledCalibration(base, 1.2))),
    compare('multiple -20%', board, rescore(snapshot, board, scaledCalibration(base, 0.8))),
    compare(
      'trimmed recalibration (outer 10% of live ratios dropped)',
      board,
      rescore(snapshot, board, calibrate(trimmedSnapshot(snapshot), MODEL)),
    ),
  ];
  return {
    boardSize: board.length,
    scenarios,
    worstTop40Retained: Math.min(...scenarios.map((s) => s.top40Retained)),
    worstMaxRankShift: Math.max(...scenarios.map((s) => s.maxRankShift)),
    allMonotone: scenarios.every((s) => s.monotoneKept),
  };
}

/** One line for the run log: the worst retention, the worst move, monotonicity. */
export function summarizeSensitivity(report: SensitivityReport): string {
  const worst = report.scenarios.reduce((a, b) =>
    b.top40Retained < a.top40Retained ? b : a,
  );
  return (
    `${report.scenarios.length} scenarios on ${report.boardSize} rows: ` +
    `worst top-40 retention ${report.worstTop40Retained}/${TOP_N} ` +
    `(${worst.name}), worst rank move ${report.worstMaxRankShift} places, ` +
    `monotone under perturbation: ${report.allMonotone ? 'yes' : 'no'}`
  );
}

/** The pre-token rows, for callers that need the trimmed set without re-deriving it. */
export function preTokenProtocols(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(isPreToken);
}
