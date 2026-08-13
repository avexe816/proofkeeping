/**
 * 忘れ物の規則のテスト（PK-SPEC-P2 §7.2・§7.3）。
 *
 * task:  docs/tasks/P2-11.md
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * ここでの「負例」は**期限から状態を導かないこと。** §7.3 MUST の
 * 「自動廃棄はしない」は、規則の側に「廃棄すべき」を返す口が無いことで守る。
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_FOOD_RETENTION_DAYS,
  DEFAULT_PROPERTY_RETENTION_DAYS,
  LOST_ITEM_CATEGORY_VALUES,
  lostItemManagementNo,
  retentionDaysFor,
  retentionDueAtMs,
  warningLevelFor,
} from "./lostItemRules.js";

const DAY = 86_400_000;
const FOUND_AT = Date.UTC(2026, 8, 10, 4, 0, 0);

describe("retentionDaysFor（§7.3 の表）", () => {
  it("貴重品は 7 日", () => {
    expect(retentionDaysFor("VALUABLE", null)).toBe(7);
  });

  it("電子機器・書類・薬は 7 日", () => {
    expect(retentionDaysFor("ELECTRONICS", null)).toBe(7);
    expect(retentionDaysFor("DOCUMENT", null)).toBe(7);
    expect(retentionDaysFor("MEDICINE", null)).toBe(7);
  });

  it("衣類・バッグ・その他は施設設定（既定 90 日）", () => {
    expect(retentionDaysFor("CLOTHING", null)).toBe(DEFAULT_PROPERTY_RETENTION_DAYS);
    expect(retentionDaysFor("BAG", 30)).toBe(30);
    expect(retentionDaysFor("OTHER", 120)).toBe(120);
  });

  it("食品は当日", () => {
    expect(retentionDaysFor("FOOD", null)).toBe(DEFAULT_FOOD_RETENTION_DAYS);
  });

  it("食品は施設設定が長くても当日のまま", () => {
    // 施設が 90 日と設定していても、食品を 90 日置く運用は成り立たない。
    expect(retentionDaysFor("FOOD", 90)).toBe(0);
  });

  it("施設設定は貴重品には効かない（短くしても長くしても 7 日）", () => {
    expect(retentionDaysFor("VALUABLE", 1)).toBe(7);
    expect(retentionDaysFor("VALUABLE", 365)).toBe(7);
  });

  it("全区分が値を返す（区分を足したら表も足すこと）", () => {
    for (const category of LOST_ITEM_CATEGORY_VALUES) {
      expect(retentionDaysFor(category, null), category).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("retentionDueAtMs", () => {
  it("発見時刻に日数を足す", () => {
    expect(retentionDueAtMs(FOUND_AT, "VALUABLE", null)).toBe(FOUND_AT + 7 * DAY);
  });

  it("食品は発見時刻そのもの（当日）", () => {
    expect(retentionDueAtMs(FOUND_AT, "FOOD", null)).toBe(FOUND_AT);
  });

  it("業務日の境へ丸めない（深夜の発見でも 1 日ずれない）", () => {
    const lateNight = Date.UTC(2026, 8, 10, 19, 30, 0); // 04:30 JST
    expect(retentionDueAtMs(lateNight, "CLOTHING", 1)).toBe(lateNight + DAY);
  });
});

describe("warningLevelFor（§7.3 の警告欄）", () => {
  it("貴重品は発見直後から URGENT", () => {
    const due = retentionDueAtMs(FOUND_AT, "VALUABLE", null);
    expect(warningLevelFor("VALUABLE", due, FOUND_AT)).toBe("URGENT");
  });

  it("食品は即時 URGENT", () => {
    expect(warningLevelFor("FOOD", retentionDueAtMs(FOUND_AT, "FOOD", null), FOUND_AT)).toBe(
      "URGENT",
    );
  });

  it("電子機器は 7 日以内なので ATTENTION", () => {
    const due = retentionDueAtMs(FOUND_AT, "ELECTRONICS", null);
    expect(warningLevelFor("ELECTRONICS", due, FOUND_AT)).toBe("ATTENTION");
  });

  it("衣類は期限まで余裕があれば NORMAL", () => {
    const due = retentionDueAtMs(FOUND_AT, "CLOTHING", 90);
    expect(warningLevelFor("CLOTHING", due, FOUND_AT)).toBe("NORMAL");
  });

  it("衣類も期限 7 日前から ATTENTION", () => {
    const due = retentionDueAtMs(FOUND_AT, "CLOTHING", 90);
    expect(warningLevelFor("CLOTHING", due, due - 6 * DAY)).toBe("ATTENTION");
  });

  it("期限を過ぎたら URGENT", () => {
    const due = retentionDueAtMs(FOUND_AT, "CLOTHING", 90);
    expect(warningLevelFor("CLOTHING", due, due + DAY)).toBe("URGENT");
  });

  it("期限ちょうどは URGENT（過ぎている側に倒す）", () => {
    const due = retentionDueAtMs(FOUND_AT, "CLOTHING", 90);
    expect(warningLevelFor("CLOTHING", due, due)).toBe("URGENT");
  });

  it("期限を過ぎても返るのは警告の段階だけ（状態を返さない）", () => {
    // §7.3 MUST「自動廃棄はしない」。**このモジュールに状態を返す関数が無い。**
    const due = retentionDueAtMs(FOUND_AT, "CLOTHING", 1);
    const level = warningLevelFor("CLOTHING", due, due + 365 * DAY);
    expect(["NORMAL", "ATTENTION", "URGENT"]).toContain(level);
    expect(level).not.toBe("DISPOSED");
  });
});

describe("lostItemManagementNo（§7.2）", () => {
  it("§7.2 の例と同じ形になる", () => {
    expect(lostItemManagementNo("HTLA", "2026-09-10", 3)).toBe("LNF-HTLA-20260910-0003");
  });

  it("連番は 4 桁で 0 埋め", () => {
    expect(lostItemManagementNo("HTLA", "2026-09-10", 1)).toBe("LNF-HTLA-20260910-0001");
    expect(lostItemManagementNo("HTLA", "2026-09-10", 9999)).toBe("LNF-HTLA-20260910-9999");
  });

  it("9999 を超えたら 5 桁にする（切り詰めて重複させない）", () => {
    expect(lostItemManagementNo("HTLA", "2026-09-10", 10_000)).toBe("LNF-HTLA-20260910-10000");
  });

  it("同じ入力からは常に同じ番号", () => {
    const a = lostItemManagementNo("HTLA", "2026-09-10", 42);
    const b = lostItemManagementNo("HTLA", "2026-09-10", 42);
    expect(a).toBe(b);
  });

  it("業務日か連番が違えば番号も違う", () => {
    expect(lostItemManagementNo("HTLA", "2026-09-10", 1)).not.toBe(
      lostItemManagementNo("HTLA", "2026-09-11", 1),
    );
    expect(lostItemManagementNo("HTLA", "2026-09-10", 1)).not.toBe(
      lostItemManagementNo("HTLA", "2026-09-10", 2),
    );
  });
});
