/**
 * サービス稼働（PF-03）が守る境界。
 *
 * task: docs/tasks/PF-03.md
 *
 * 完了条件:
 *   - 出す元のある指標だけが並んでいる（無い指標は**列ごと無い**）
 *   - シャード番号・内部ホスト名が出ない
 *   - 事象履歴が時系列で、**書き込みの口が無い**
 *
 * ── なぜソースを読むのか ────────────────────────────────
 * 確かめたいのは「**この列が存在しないこと**」で、実行しても現れない
 * （`styles/darkMode.spec.ts` / `routes/app/staffScreen.spec.ts` と同じ作り）。
 * 誰かが「とりあえず 0 を出しておく」と足した日に落ちる形にする。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ja } from "../../locales/index.js";

const SOURCE = readFileSync(join(import.meta.dirname, "status.tsx"), "utf8");

/** コメントを落としたソース。**禁止事項を説明した注記が検査に引っ掛かる**ため。 */
const CODE = SOURCE.split("\n")
  .filter((line) => {
    const trimmed = line.trimStart();
    return (
      !trimmed.startsWith("*") &&
      !trimmed.startsWith("//") &&
      !trimmed.startsWith("/*") &&
      !trimmed.startsWith("{/*")
    );
  })
  .join("\n");

describe("出す元の無い指標を置かない（OPEN_QUESTIONS #114）", () => {
  it("KPI 5 つの文言が 1 つも無い", () => {
    // 稼働率 / p95 / 同期キュー / 同期の失敗 / 写真ストレージ。
    for (const key of Object.keys(ja)) {
      if (!key.startsWith("plat.status.")) continue;
      const value = ja[key as keyof typeof ja];
      // 「実測を集める仕組みができてから」の注記だけは語を含んでよい。
      if (key === "plat.status.metrics.pending") continue;
      for (const forbidden of ["稼働率", "p95", "エラー率", "同期キュー", "ストレージ"]) {
        expect(value, `${key} に「${forbidden}」`).not.toContain(forbidden);
      }
    }
  });

  it("**0 で埋めていない**（数値の既定値をハードコードしない）", () => {
    // 「99.97」「184」といったプロトタイプの数字が紛れ込んでいないこと。
    expect(CODE).not.toMatch(/\b99\.9\d\b/);
    expect(CODE).not.toMatch(/\b184\b/);
    // `?? 0` で無い値を 0 に落としていない。
    expect(CODE).not.toMatch(/\?\?\s*0\b/);
  });

  it("計測が無いことを画面に書いている（空欄で察させない）", () => {
    expect(CODE).toContain("plat.status.metrics.pending");
    expect(ja["plat.status.metrics.pending"]).toContain("仮の数字は置きません");
  });
});

describe("シャード番号・内部ホスト名を出さない（完了条件 / architecture.md §1）", () => {
  it("シャードの binding 名に触れていない", () => {
    expect(CODE).not.toMatch(/SHARD_\d/);
    expect(CODE).not.toContain("env.SHARD");
  });

  it("`checkHealth()` の件数だけを使う（番号を持つ値に触れない）", () => {
    // ShardHealth は expected / declared / reachable しか持たない。
    expect(CODE).toContain("health.shards.reachable");
    expect(CODE).toContain("health.shards.expected");
  });

  it("文言に内部ホスト名・シャードの語が無い", () => {
    for (const key of Object.keys(ja)) {
      if (!key.startsWith("plat.status.")) continue;
      const value = ja[key as keyof typeof ja];
      for (const forbidden of ["シャード", "shard", ".workers.dev", "d1-", "proofkeeping-"]) {
        expect(value, `${key} に「${forbidden}」`).not.toContain(forbidden);
      }
    }
  });
});

describe("事象履歴に書き込みの口を作らない（完了条件）", () => {
  it("action を持たない（読むだけの画面）", () => {
    expect(CODE).not.toContain("export async function action");
    expect(CODE).not.toContain("<Form");
  });
});

describe("逐語の注記（PF-03「逐語で置く注記」）", () => {
  it("競合の注記が逐語", () => {
    expect(ja["plat.status.note.conflict"]).toBe(
      "競合が起きても清掃員の記録は削除しません。採用されなかった記録も conflictLog に保持しています。",
    );
  });

  it("メンテナンスの注記が逐語（OPEN_QUESTIONS #115 で PF-14 の既定と 1 時間ずれている）", () => {
    expect(ja["plat.status.note.maintenance"]).toBe(
      "清掃業務は早朝から午前中に集中します。深夜帯のメンテナンスウィンドウは 02:00〜04:00 を基本とします。",
    );
  });
});
