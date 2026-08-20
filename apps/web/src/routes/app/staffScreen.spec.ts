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

/**
 * 在留資格の書き込み。**画面から切り出してある**（`residency.ts` の注記）。
 * PIN を持つ `staff.tsx` に監査ログの口を置かないため。
 */
const WRITE_SOURCE = readFileSync(
  join(import.meta.dirname, "..", "..", "lib", "staff", "residency.ts"),
  "utf8",
);

/**
 * コメントを落としたソース。
 *
 * **禁止事項を説明した doc コメント自体が検査に引っ掛かる**ので、
 * 「この語が無いこと」を見るときはこちらを使う
 * （`repositories.spec.ts` の `repositorySources()` と同じ理由）。
 */
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
      expect(CODE, forbidden).not.toContain(forbidden);
    }
  });

  it("単価を引いていない（PK-SPEC-P8 §1.3 MUST / プロトタイプに列が無い）", () => {
    for (const forbidden of ["payRule", "listPayRules", "unitPrice", "hourlyRate"]) {
      expect(CODE, forbidden).not.toContain(forbidden);
    }
  });

  it("言語の構成に「評価には使用しません」が入っている（security.md §5）", () => {
    expect(ja["staff.languages.note"]).toContain("評価には使用しません");
  });
});

describe("在留資格の書き込み（P8-02）", () => {
  it("**loader の `can()` に頼らず `assertPermission()` を通す**（security.md §1）", () => {
    // 画面の出し分けは権限制御ではない。書き込みは必ず落とす。
    expect(WRITE_SOURCE).toContain('assertPermission(tenant, "residency.write"');
  });

  it("2 つのフォームを `intent` で分けている（項目の有無で推測しない）", () => {
    expect(SOURCE).toContain('fieldOf(form, "intent") === "residency"');
  });

  it("**PIN を持つ画面に監査ログの口を置いていない**（initialPin.spec.ts）", () => {
    // `staff.tsx` は初期 PIN を `action` の戻り値として運ぶ。
    // 同居させると、取り違えたときに PIN が監査ログへ入りうる。
    expect(CODE).not.toContain("recordAudit");
  });

  it("監査ログを残す（security.md §6）", () => {
    expect(WRITE_SOURCE).toContain('action: "residency.updated"');
  });

  it("**監査ログに載せるのは期限と種別だけ**（ノートを写さない）", () => {
    // `after` にノート・週上限・許可の要否を入れていないこと。
    const after = /after: \{ statusType: [^}]*\}/.exec(WRITE_SOURCE)?.[0] ?? "";
    expect(after).toContain("statusType");
    expect(after).toContain("expiresOn");
    for (const forbidden of ["note", "weeklyHourLimit", "workPermitRequired", "statusLabel"]) {
      expect(after, forbidden).not.toContain(forbidden);
    }
  });

  it("期限切れの解除ボタンを置いていない（仕様 §1.4 MUST）", () => {
    // 解除は `expiresOn` の更新だけ。**別の経路を作らない。**
    for (const forbidden of ["unblock", "clearExpiry", "解除", "強制"]) {
      expect(CODE, forbidden).not.toContain(forbidden);
    }
  });

  it("就労可否を聞くフォーム項目が無い（同 MUST）", () => {
    for (const forbidden of ["canWork", "就労可", "働けますか"]) {
      expect(CODE, forbidden).not.toContain(forbidden);
    }
  });
});
