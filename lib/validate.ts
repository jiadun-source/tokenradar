// Output validation for Token Radar.
//
// After main.ts has written the output directory, this module re-reads what
// is on disk and checks it the way the gate would: the board covers the rows
// it claims, ranks run 1..n with falling implied values, every farm plan is
// well formed, the dossier is the shape the scorer expects, and the
// dashboard never reaches for the network. Nothing here writes files; a
// non-empty problem list means main.ts should exit non-zero instead of
// reporting success.
//
// The checks are deliberately file-local: the validator trusts nothing in
// memory and re-proves the output from the bytes that were written.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The result of validating one output directory. */
export interface ValidationResult {
  /** True when every check passed. */
  ok: boolean;
  /** Every problem found, in plain words; empty when `ok` is true. */
  problems: string[];
  /** How many individual checks ran. */
  checks: number;
}

/** The dossier text cap main.ts passes to the dossier builder. */
const DOSSIER_TEXT_MAX_BYTES = 65_536;

/** Farm steps must carry this many characters, matching the gate's range. */
const STEP_MIN_CHARS = 20;
const STEP_MAX_CHARS = 600;

/** A farm plan holds between this many steps. */
const STEPS_MIN = 3;
const STEPS_MAX = 12;

/** Patterns that only appear when a page reaches outside itself. */
const EXTERNAL_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'an absolute http(s) URL', re: /https?:\/\// },
  { label: 'a protocol-relative URL in quotes', re: /["']\/\// },
  { label: 'a fetch() call', re: /\bfetch\s*\(/ },
  { label: 'an XMLHttpRequest', re: /XMLHttpRequest/ },
  { label: 'a WebSocket', re: /\bWebSocket\s*\(/ },
  { label: 'an external script or stylesheet link', re: /(?:src|href)\s*=\s*["']https?:/ },
];

/** Read and parse a JSON file, or record why it cannot be used. */
function readJson(
  path: string,
  label: string,
  problems: string[],
): Record<string, unknown> | null {
  if (!existsSync(path)) {
    problems.push(`${label} is missing`);
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      problems.push(`${label} is not a JSON object`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    problems.push(`${label} is not valid JSON`);
    return null;
  }
}

/** Check the board file: coverage, order, ranks, values and farm plans. */
function checkBoard(
  outDir: string,
  expectedRows: number,
  problems: string[],
): number {
  let checks = 0;
  const board = readJson(join(outDir, 'board.json'), 'board.json', problems);
  if (board === null) return checks;
  checks++;
  const rows = board.rows;
  if (!Array.isArray(rows)) {
    problems.push('board.json has no rows array');
    return checks;
  }
  checks++;
  if (rows.length !== expectedRows) {
    problems.push(`board.json has ${rows.length} rows, expected ${expectedRows}`);
  }
  const seen = new Set<string>();
  let previous: number | null = null;
  let ties = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, unknown>;
    checks++;
    if (row.rank !== i + 1) {
      problems.push(`board row ${i + 1} carries rank ${String(row.rank)}`);
    }
    if (typeof row.slug !== 'string' || row.slug.length === 0) {
      problems.push(`board row ${i + 1} has no slug`);
      continue;
    }
    if (seen.has(row.slug)) problems.push(`board repeats slug ${row.slug}`);
    seen.add(row.slug);
    const implied = row.implied_value_usd;
    if (typeof implied !== 'number' || !Number.isSafeInteger(implied) || implied <= 0) {
      problems.push(`${row.slug} has implied value ${String(implied)}`);
      continue;
    }
    if (previous !== null) {
      if (implied > previous) {
        problems.push(`${row.slug} outranks the row above it on implied value`);
      }
      if (implied === previous) ties++;
    }
    previous = implied;
    const steps = row.farm_steps;
    if (!Array.isArray(steps) || steps.length < STEPS_MIN || steps.length > STEPS_MAX) {
      problems.push(
        `${row.slug} has ${Array.isArray(steps) ? steps.length : 'no'} farm steps`,
      );
      continue;
    }
    for (const step of steps) {
      if (typeof step !== 'string' || step.length < STEP_MIN_CHARS || step.length > STEP_MAX_CHARS) {
        problems.push(`${row.slug} has a farm step of ${typeof step === 'string' ? step.length : 'non-text'} characters`);
        break;
      }
    }
  }
  if (rows.length >= 2 && ties === rows.length - 1) {
    problems.push(`all ${rows.length} rows share one implied value: not a ranking`);
  }
  return checks;
}

/** Check the dossier file: shape, schema, text cap and screenshot count. */
function checkDossier(outDir: string, problems: string[]): number {
  let checks = 0;
  const dossier = readJson(join(outDir, 'dossier.json'), 'dossier.json', problems);
  if (dossier === null) return checks;
  checks++;
  if (dossier.schema !== 'makefun/dossier/v1') {
    problems.push(`dossier.json schema is ${String(dossier.schema)}`);
  }
  checks++;
  const text = dossier.text;
  if (typeof text !== 'string') {
    problems.push('dossier.json has no text');
  } else if (Buffer.byteLength(text, 'utf8') > DOSSIER_TEXT_MAX_BYTES) {
    problems.push(
      `dossier text is ${Buffer.byteLength(text, 'utf8')} bytes, over the ${DOSSIER_TEXT_MAX_BYTES} cap`,
    );
  }
  checks++;
  const images = dossier.images;
  if (!Array.isArray(images) || images.length < 3 || images.length > 4) {
    problems.push(
      `dossier.json carries ${Array.isArray(images) ? images.length : 'no'} images, expected 3 or 4`,
    );
  }
  return checks;
}

/** Check the dashboard directory: present, local-only, and free of network calls. */
function checkDashboard(outDir: string, problems: string[]): number {
  let checks = 0;
  const dir = join(outDir, 'dashboard');
  if (!existsSync(dir)) {
    problems.push('dashboard/ is missing from the output');
    return checks;
  }
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile());
  } catch {
    problems.push('dashboard/ cannot be listed');
    return checks;
  }
  checks++;
  if (names.length === 0) problems.push('dashboard/ is empty');
  for (const name of names) {
    checks++;
    let text: string;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      problems.push(`dashboard/${name} cannot be read`);
      continue;
    }
    for (const { label, re } of EXTERNAL_PATTERNS) {
      if (re.test(text)) {
        problems.push(`dashboard/${name} contains ${label}`);
        break;
      }
    }
  }
  return checks;
}

/** Validate one output directory end to end. */
export function validateOutput(outDir: string, expectedRows: number): ValidationResult {
  const problems: string[] = [];
  let checks = 0;
  checks += checkBoard(outDir, expectedRows, problems);
  checks += checkDossier(outDir, problems);
  checks += checkDashboard(outDir, problems);
  checks++;
  if (!existsSync(join(outDir, 'data.js'))) {
    problems.push('data.js is missing from the output');
  }
  return { ok: problems.length === 0, problems, checks };
}

/** One line for the run log: the check count, or the first problem. */
export function summarizeValidation(result: ValidationResult): string {
  if (result.ok) return `${result.checks} checks passed`;
  return `${result.problems.length} problem(s): ${result.problems[0] ?? 'unknown'}`;
}
