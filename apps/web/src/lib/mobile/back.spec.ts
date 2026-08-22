/**
 * 現場画面の戻り先（人間の指示 2026-08-22 / DECISIONS #259）。
 *
 * ── 何を固定するのか ────────────────────────────────────
 * **「どう来たか」を見ずに戻り先が決まること。** 履歴に頼る戻り方
 * （`navigate(-1)`）は、ホーム画面の PWA から起動した場合・URL を直接
 * 開いた場合・再読み込みした場合に**押しても動かない。** 現場では
 * どれも普通に起きる。
 *
 * ここは純粋関数の側を見る。画面が実際にこれを使っていることは
 * `routes/m/report.spec.ts` が見る。
 */

import { describe, expect, it } from "vitest";

import { MOBILE_HOME, taskBackPath } from "./back.js";

const TASK_ID = "o7k2m9__task_01JBXQ3ZK8N4P2VYR6";

describe("タスクに属する画面の戻り先", () => {
  it("タスクが分かれば、その詳細へ戻る", () => {
    expect(taskBackPath(TASK_ID)).toBe(`/m/task/${TASK_ID}`);
  });

  it("タスクが分からなければ、一覧へ戻る", () => {
    expect(taskBackPath(null)).toBe(MOBILE_HOME);
  });

  /**
   * **どちらの場合も具体的な URL が決まる。** 空文字や `#` を返すと、
   * 押しても動かない戻るボタンが出来る（履歴に頼るのと同じ壊れ方）。
   */
  it("いつでも `/m/` で始まる具体的な URL を返す", () => {
    for (const taskId of [TASK_ID, null]) {
      const path = taskBackPath(taskId);
      expect(path.startsWith("/m/"), String(taskId)).toBe(true);
      expect(path.length, String(taskId)).toBeGreaterThan("/m/".length);
    }
  });

  /** 呼ぶ順や回数で変わらない（履歴のような状態を持たない）。 */
  it("同じ入力なら何度呼んでも同じ", () => {
    expect(taskBackPath(TASK_ID)).toBe(taskBackPath(TASK_ID));
    expect(taskBackPath(null)).toBe(taskBackPath(null));
  });
});
