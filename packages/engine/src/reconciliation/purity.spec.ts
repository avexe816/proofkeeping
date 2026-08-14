/**
 * 照合エンジンが純粋であることの横断検証（P4-03 の完了条件 / PK-SPEC-P4 §9 MUST）。
 *
 * task: docs/tasks/P4-03.md
 * ルール: CLAUDE.md §5 / .claude/rules/testing.md §3
 *
 * ── なぜソースを走査するのか ────────────────────────────
 * 「DB・fetch・環境変数・`Date.now()` に依存していない」は**書いた瞬間には
 * 誰も気づかない種類の違反**。`Date.now()` を 1 か所に入れても全テストが
 * 通り、壊れるのは「同じ入力から同じ出力」（§10.1）と「3 回実行しても
 * Finding が重複しない」（§10.2）だけで、それは本番の再実行で初めて出る。
 *
 * ESLint のカスタムルールにしなかったのは、対象がこのディレクトリだけで、
 * 規約というより**この task の完了条件そのもの**だから。ルールを足す task
 * （P4-04 / P4-11 / P4-12）が `rules/` にファイルを置けば自動的に検査に入る。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** 検査するファイル（spec を除く）。**再帰的に集める**（`rules/` の下も見る）。 */
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
 * 落とさないと、**禁止事項を説明した doc コメント自体が検査に引っ掛かる**
 * （`repositories.spec.ts` と同じ扱い）。
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
 * `new Date(...)`（引数つき）は禁止していない。**引数から作る `Date` は純粋**で、
 * 業務日の計算に要る（`ownWork.ts` と同じ判断）。落とすのは
 * 引数なしの `new Date()`＝現在時刻。
 */
const FORBIDDEN: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\bDate\.now\s*\(/, why: "現在時刻は RuleContext.now で注入する（§9 MUST）" },
  { pattern: /\bnew\s+Date\s*\(\s*\)/, why: "引数なしの new Date() は現在時刻（§9 MUST）" },
  { pattern: /\bMath\.random\s*\(/, why: "決定性が崩れる（§10.1）" },
  { pattern: /\bfetch\s*\(/, why: "engine から外部へ出ない（§9 MUST）" },
  { pattern: /\bprocess\.env\b/, why: "環境変数を読まない（§9 MUST）" },
  { pattern: /\bcrypto\b/, why: "乱数・時刻に依存しうる（§10.1）" },
];

describe("packages/engine/src/reconciliation は純粋である", () => {
  it("検査対象のファイルがある（走査そのものが空振りしていない）", () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN)("どのファイルも $pattern を使っていない — $why", ({ pattern }) => {
    const offenders = FILES.filter((path) => pattern.test(code(path)));
    expect(offenders).toEqual([]);
  });

  it.each(FILES)("%s の import 先が engine の外へ出ていない", (path) => {
    // **`@pk/db` を引くと、そこから drizzle と D1 が芋づるで入る。**
    // 型だけの import でも、依存の向きが逆転していることに変わりはない。
    // 上位（`../../`）へ出ると、P1〜P3 のモジュールが持つ依存を引き込む
    // 余地ができる。**許すのは `./` と `../` の 1 段だけ。**
    const allowed = importsOf(path).filter(
      (specifier) => specifier.startsWith("./") || specifier.startsWith("../"),
    );
    expect(importsOf(path)).toEqual(allowed);

    const escaping = allowed.filter((specifier) => specifier.startsWith("../../"));
    expect(escaping).toEqual([]);
  });
});
