/**
 * M-13 報告（`/m/report?taskId=…`）の戻り先（人間の指示 2026-08-22 /
 * DECISIONS #259）。
 *
 * ── なぜソースを読むのか ────────────────────────────────
 * 守りたいのは「**この画面から、履歴が無くても報告元のタスクへ戻れる**」
 * こと。以前の `navigate(-1)` は、ホーム画面の PWA から起動した場合・
 * URL を直接開いた場合・再読み込みした場合に**押しても何も起きなかった。**
 * 描画そのものは成立するので、型でも lint でも落ちない種類の壊れ方。
 * ここは `settingsHub.spec.ts` / `staffScreen.spec.ts` と同じ流儀で、
 * **画面の実装だけ**（コメントを落とした本文）を走査する。
 *
 * **`navigate(-1)` を全面禁止する検査ではない**（人間の指示）。見るのは
 * この 1 画面の戻り先が履歴に依存しないこと。他の画面で履歴を戻すのが
 * 適切な場面があれば、それはその画面の判断。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { taskBackPath } from "../../lib/mobile/back.js";

/**
 * 画面のソース。**注記の中の `navigate(-1)`（経緯の説明）が引っ掛かる**ので、
 * コメントを落として実装だけを見る。
 */
const SOURCE = readFileSync(join(import.meta.dirname, "report.tsx"), "utf8")
  .replaceAll(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

describe("報告画面の戻り先は履歴に依存しない", () => {
  /** 最初に出る「戻る」（区分を選ぶ前）が、押せる URL を持つ。 */
  it("区分を選ぶ画面に、タスクへの明示リンクがある", () => {
    expect(SOURCE).toMatch(/<Link[^>]*to=\{taskBackPath\(data\.taskId\)\}/);
  });

  it("実装に履歴を戻る操作が残っていない", () => {
    expect(SOURCE).not.toMatch(/navigate\(\s*-\s*1\s*\)/);
    expect(SOURCE).not.toMatch(/history\.(back|go)\(/);
  });

  /**
   * 戻り先を**その場で組み立て直さない。** 同じ三項演算子が画面のあちこちに
   * 増えると、片方だけ直る（`lib/mobile/back.ts` に寄せてある理由）。
   */
  it("戻り先は 1 か所の関数から取る", () => {
    expect(SOURCE).toContain("taskBackPath");
    expect(SOURCE).not.toMatch(/taskId === null \? "\/m\/today"/);
  });

  /** 送信後の「タスクへ戻る」も同じ関数を使う（履歴を見ない）。 */
  it("送信後の戻り先も同じ決め方", () => {
    expect(SOURCE).toMatch(/navigate\(taskBackPath\(data\.taskId\)\)/);
  });

  /**
   * **この画面には `taskId` が必ず在る**（loader が無ければ 404）。
   * 万一 `null` で描かれても、戻り先は一覧に決まる。
   */
  it("taskId が無くても戻り先が決まる", () => {
    expect(SOURCE).toMatch(/if \(taskId === null\) throw new Response\(null, \{ status: 404 \}\)/);
    expect(taskBackPath(null)).toBe("/m/today");
  });
});
