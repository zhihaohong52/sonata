import { readFileSync, writeFileSync } from 'node:fs';
import { replaceBlock } from '../../init/toml.js';
import { parseConfig } from '../../config.js';

/** `[budget]` in either spelling; the table has no sub-tables. */
const isBudgetHeader = (line: string): boolean =>
  /^\s*\[\s*(?:budget|"budget"|'budget')\s*\]/.test(line);

/**
 * The config text with `[budget] daily_usd` set, replaced, or removed.
 *
 * Pure, so the property that matters — that nothing outside the table moves —
 * is testable without a filesystem.
 *
 * It goes through `replaceBlock` rather than `nativeTomlFor` because that
 * writer rebuilds the file from a parsed model and deletes what the model
 * cannot represent: measured, one rewrite flipped a gateway from priced to
 * unpriced between two requests 64 seconds apart. Here preservation is the
 * default rather than a list of fields kept in step with the parser.
 *
 * `undefined` removes the table rather than writing a zero. `costOf` charges
 * an absent dimension at 0, so a zero would turn "no cap" into a cap of $0 and
 * refuse every request.
 */
export function budgetToml(toml: string, dailyUsd: number | undefined): string {
  const block = dailyUsd === undefined ? [] : ['[budget]', `daily_usd = ${dailyUsd}`, ''];
  return replaceBlock(toml, isBudgetHeader, block);
}

/**
 * Write the edited config back.
 *
 * The result is parsed **before** it is written: a rewrite that will not load
 * leaves no working config at all, and would surface later from an unrelated
 * command with nothing to connect it to this edit. Same discipline as
 * `sonata agents`, the other targeted writer.
 */
export function writeBudget(path: string, dailyUsd: number | undefined): void {
  const next = budgetToml(readFileSync(path, 'utf8'), dailyUsd);
  parseConfig(next);
  writeFileSync(path, next);
}
