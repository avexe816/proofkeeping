/**
 * `packages/billing` が純粋であることの横断検証（P5-04 の完了条件）。
 *
 * task:  docs/tasks/P5-04.md
 * ルール: CLAUDE.md §5 / .claude/rules/billing.md §4 / testing.md §3
 *
 * ── なぜソースを走査するのか ────────────────────────────
 * 「DB・fetch・環境変数・`Date.now()` に依存していない」は**書いた瞬間には
 * 誰も気づかない種類の違反。** 1 か所入れても全テストが通り、壊れるのは
 * 「同じ入力から同じ請求書」（§4.3 の冪等性）だけで、それは本番の
 * 再発行で初めて出る。`packages/engine` の `purity.spec.ts` と同じ方針。
 *
 * ── 浮動小数点の検査も兼ねる ────────────────────────────
 * billing.md §4 MUST「浮動小数点を使わない。すべて整数（円）」。
 * **`parseFloat` / `toFixed` を禁じる。** 割り算そのものは禁じられない
 * （税額の `× rate / 100` は避けられない）ので、**除算を書いた行の近くで
 * 丸めているか**は人が読む。ここで固定するのは分かりやすい入口だけ。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** 検査するファイル（spec を除く）。 */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".spec.ts")) continue;
    found.push(path);
  }
  return found;
}

/**
 * コメントと文字列リテラルを落とした本文。
 *
 * 落とさないと、**禁止事項を説明した doc コメント自体が検査に引っ掛かる。**
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/.*$/gm, "")
    .replaceAll(/"(?:[^"\\]|\\.)*"/g, '""')
    .replaceAll(/'(?:[^'\\]|\\.)*'/g, "''")
    .replaceAll(/`(?:[^`\\]|\\.)*`/g, "``");
}

/** そのファイルの import 先。**コメントを落としてから拾う。** */
function importsOf(path: string): string[] {
  const body = readFileSync(path, "utf8")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/.*$/gm, "");
  return [...body.matchAll(/\bfrom\s+"([^"]+)"/g)].map((matched) => matched[1] ?? "");
}

const FILES = sourceFiles(import.meta.dirname);

/**
 * 禁止する書き方。
 *
 * `new Date(...)`（引数つき）は禁止していない。**引数から作る `Date` は純粋。**
 * 落とすのは引数なしの `new Date()`＝現在時刻。
 */
const FORBIDDEN: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\bDate\.now\s*\(/, why: "現在時刻は引数で受け取る（CLAUDE.md §5）" },
  { pattern: /\bnew\s+Date\s*\(\s*\)/, why: "引数なしの new Date() は現在時刻" },
  { pattern: /\bMath\.random\s*\(/, why: "同じ入力から同じ請求書にならない（§4.3）" },
  { pattern: /\bfetch\s*\(/, why: "billing から外部へ出ない" },
  { pattern: /\bprocess\.env\b/, why: "環境変数を読まない" },
  { pattern: /\bparseFloat\s*\(/, why: "金額に浮動小数点を使わない（billing.md §4 MUST）" },
  { pattern: /\.toFixed\s*\(/, why: "金額に浮動小数点を使わない（同上）" },
];

describe("packages/billing は純粋である（P5-04 の完了条件）", () => {
  it("検査対象のファイルがある（走査そのものが空振りしていない）", () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN)("どのファイルも $pattern を使っていない — $why", ({ pattern }) => {
    const offenders = FILES.filter((path) => pattern.test(code(path)));
    expect(offenders).toEqual([]);
  });

  it.each(FILES)("%s の import 先が billing の外へ出ていない", (path) => {
    // **`@pk/db` を引くと、そこから drizzle と D1 が芋づるで入る。**
    // 型だけの import でも、依存の向きが逆転していることに変わりはない。
    const allowed = importsOf(path).filter(
      (specifier) => specifier.startsWith("./") || specifier.startsWith("../"),
    );
    expect(importsOf(path)).toEqual(allowed);

    const escaping = allowed.filter((specifier) => specifier.startsWith("../../"));
    expect(escaping).toEqual([]);
  });
});
