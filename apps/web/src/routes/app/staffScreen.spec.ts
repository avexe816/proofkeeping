/**
 * スタッフ管理の画面が守る境界（P8-01 / P8-02）。
 *
 * task: docs/tasks/P8-01.md / docs/tasks/P8-02.md
 * 契約: docs/PK-IMPL-CONTRACT.md INV-08
 *
 * ── なぜソースを読むのか ────────────────────────────────
 * ここで確かめたいのは「**この経路が存在しないこと**」で、
 * 実行しても現れない。列を足した瞬間に落ちる形にするには、
 * 画面のソースを走査するのがいちばん確実
 * （`styles/darkMode.spec.ts` と同じ作り）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ja } from "../../locales/index.js";

const SOURCE = readFileSync(join(import.meta.dirname, "staff.tsx"), "utf8");

describe("スタッフ管理の画面", () => {
  it("在留期限を `residency.read` で絞っている（INV-08）", () => {
    // `canReadResidency` を通さずに列を出していないこと。
    expect(SOURCE).toContain("canReadResidency");
    expect(SOURCE).toContain('can(tenant, "residency.read"');
  });

  it("読めない相手には在留資格を**引かない**（loader の戻り値に残さない）", () => {
    // 引いてから画面で隠すと、loader の JSON が HTML に載ったままになる。
    expect(SOURCE).toContain("canReadResidency ? listResidencyRecords(env, tenant)");
  });

  it("件数の KPI は権限で分岐しない（仕様 §1.4 の「件数のみ」）", () => {
    // `countExpiringResidencies()` が三項演算子の中に入っていないこと。
    expect(SOURCE).toMatch(/^\s*countExpiringResidencies\(env, tenant, expiryHorizon\),$/m);
  });

  it("免責の文言が画面にある（PK-SPEC-P8 §1.4 MUST）", () => {
    expect(SOURCE).toContain("staff.residency.disclaimer");
    const text = ja["staff.residency.disclaimer"];
    // **短くしない。** 「就労可否を判定するものではありません」が核。
    expect(text).toContain("就労可否を判定するものではありません");
    expect(text).toContain("事業者様の責任");
  });

  it("個人の実績を出す列が無い（security.md §5 / CLAUDE.md §4）", () => {
    for (const forbidden of ["ranking", "fastest", "score", "completedCount", "averageMinutes"]) {
      expect(SOURCE, forbidden).not.toContain(forbidden);
    }
  });

  it("単価を引いていない（PK-SPEC-P8 §1.3 MUST / プロトタイプに列が無い）", () => {
    for (const forbidden of ["payRule", "listPayRules", "unitPrice", "hourlyRate"]) {
      expect(SOURCE, forbidden).not.toContain(forbidden);
    }
  });

  it("言語の構成に「評価には使用しません」が入っている（security.md §5）", () => {
    expect(ja["staff.languages.note"]).toContain("評価には使用しません");
  });
});
