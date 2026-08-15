/**
 * 年次アーカイブの対象と除外（P7-08 / PK-SPEC-P0 §19.7）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * 完了条件（`docs/tasks/P7-08.md`）のうち、ここが押さえるもの:
 *   - **除外対象（証跡ハッシュ・監査ログ・帳票・マスタ）が守られる**
 *
 * ── いちばん大事な検査 ──────────────────────────────────
 * 「**知らない表は退避されない**」。表が増えたときに書き忘れても、
 * 法定保存期間のある帳票が R2 へ出て D1 から消えることが無い、
 * という向きを固定する。
 */

import { describe, expect, it } from "vitest";

import {
  ARCHIVABLE_TABLES,
  ARCHIVE_RETENTION_MONTHS,
  DIRECTLY_ARCHIVABLE_TABLES,
  EXCLUSION_REASONS,
  EXPLICIT_EXCLUSIONS,
  archiveCutoffBusinessDate,
  archiveObjectKey,
  exclusionReasonOf,
  isArchivable,
  isDirectlyArchivable,
  toJsonl,
  archiveRestoreExpiresAt,
  isRestoreViewable,
  parseJsonl,
  restoreYearsOf,
  validateRestoreRange,
} from "./archivePolicy.js";

const ORG_ID = "a1b2c3__org_01JBXQ3ZK8N4P2VYR6ABCDEFGH";

describe("isArchivable — 正例（退避する）", () => {
  it.each([
    "cleaning_task",
    "task_time_log",
    "task_checklist_result",
    "inspection",
    "inspection_item_result",
    "room_observation",
    "linen_record",
    "occupancy_snapshot",
    "physical_signal",
  ])("§19.7 が名指しした `%s` は退避する", (table) => {
    expect(isArchivable(table)).toBe(true);
    expect(exclusionReasonOf(table)).toBeNull();
  });

  it("§19.7 の対象は 9 表", () => {
    expect(ARCHIVABLE_TABLES).toHaveLength(9);
  });
});

describe("isArchivable — 負例（退避しない）", () => {
  it("**証跡のハッシュ行**は退避しない", () => {
    expect(isArchivable("evidence_snapshot")).toBe(false);
    expect(exclusionReasonOf("evidence_snapshot")).toBe("EVIDENCE_HASH");
  });

  it("**監査ログ**は退避しない（別途 5 年保持）", () => {
    expect(exclusionReasonOf("audit_log")).toBe("AUDIT_LOG");
  });

  it.each(["invoice", "invoice_line", "invoice_tax_summary", "receipt", "daily_report"])(
    "**発行済み帳票 `%s`** は退避しない（法定保存期間）",
    (table) => {
      expect(isArchivable(table)).toBe(false);
      expect(exclusionReasonOf(table)).toBe("LEGAL_RETENTION");
    },
  );

  it.each(["organization", "property", "room", "room_type", "user"])(
    "**マスタ `%s`** は退避しない",
    (table) => {
      expect(exclusionReasonOf(table)).toBe("MASTER_DATA");
    },
  );

  it("**知らない表は退避しない**（既定が安全側）", () => {
    expect(isArchivable("some_table_added_next_year")).toBe(false);
    expect(exclusionReasonOf("some_table_added_next_year")).toBe("UNLISTED");
  });

  it("空文字も退避しない", () => {
    expect(isArchivable("")).toBe(false);
  });
});

describe("除外の理由が説明できる", () => {
  it("名指しの除外はすべて理由を持つ", () => {
    for (const [table, reason] of Object.entries(EXPLICIT_EXCLUSIONS)) {
      expect(EXCLUSION_REASONS[reason], table).toBeTypeOf("string");
    }
  });

  it("**対象と除外が重ならない**（同じ表が両方に無い）", () => {
    for (const table of ARCHIVABLE_TABLES) {
      expect(EXPLICIT_EXCLUSIONS[table], table).toBeUndefined();
    }
  });

  it("`UNLISTED` が既定として用意されている", () => {
    expect(EXCLUSION_REASONS.UNLISTED).toBeTypeOf("string");
  });
});

describe("archiveCutoffBusinessDate（§19.7 の 13 か月）", () => {
  it("13 か月前を返す", () => {
    expect(archiveCutoffBusinessDate(new Date("2026-09-10T00:00:00Z"))).toBe("2025-08-10");
  });

  it("年をまたぐ", () => {
    expect(archiveCutoffBusinessDate(new Date("2026-01-15T00:00:00Z"))).toBe("2024-12-15");
  });

  it("保持期間は 13 か月", () => {
    expect(ARCHIVE_RETENTION_MONTHS).toBe(13);
  });

  it("**同じ入力から同じ結果**（`Date.now()` を呼んでいない）", () => {
    const now = new Date("2026-09-10T00:00:00Z");
    expect(archiveCutoffBusinessDate(now)).toBe(archiveCutoffBusinessDate(now));
  });

  it("境界は退避の対象に含めない（「13 か月以上前」）", () => {
    // 返るのはちょうど 13 か月前の日付。**この日より前**が対象。
    const cutoff = archiveCutoffBusinessDate(new Date("2026-09-10T00:00:00Z"));
    expect("2025-08-09" < cutoff).toBe(true);
    expect("2025-08-10" < cutoff).toBe(false);
  });
});

describe("archiveObjectKey（§19.7 の R2 キー）", () => {
  it("`archive/{orgId}/{year}/{table}.jsonl.gz`", () => {
    expect(archiveObjectKey({ organizationId: ORG_ID, year: 2025, table: "cleaning_task" })).toBe(
      `archive/${ORG_ID}/2025/cleaning_task.jsonl.gz`,
    );
  });

  it("**シャード番号を含まない**（CLAUDE.md §4）", () => {
    const key = archiveObjectKey({ organizationId: ORG_ID, year: 2025, table: "inspection" });
    expect(key).not.toMatch(/shard/i);
    expect(key).not.toMatch(/SHARD_\d/);
  });

  it("年が変われば別のキー", () => {
    const a = archiveObjectKey({ organizationId: ORG_ID, year: 2024, table: "inspection" });
    const b = archiveObjectKey({ organizationId: ORG_ID, year: 2025, table: "inspection" });
    expect(a).not.toBe(b);
  });
});

describe("toJsonl", () => {
  it("1 行 1 レコードで末尾に改行", () => {
    expect(toJsonl([{ a: 1 }, { a: 2 }])).toBe('{"a":1}\n{"a":2}\n');
  });

  it("**空なら空文字**（改行だけの行を作らない）", () => {
    expect(toJsonl([])).toBe("");
  });

  it("1 件でも末尾に改行が付く", () => {
    expect(toJsonl([{ a: 1 }])).toBe('{"a":1}\n');
  });

  it("行数が数えられる（改行の数と一致）", () => {
    const jsonl = toJsonl([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(jsonl.split("\n").filter((line) => line !== "")).toHaveLength(3);
  });
});

describe("「削除」と表現しない（P7 固有の絶対ルール）", () => {
  it("公開している名前に `delete` / `purge` が無い", () => {
    const names = [
      "ARCHIVABLE_TABLES",
      "ARCHIVE_RETENTION_MONTHS",
      "EXCLUSION_REASONS",
      "EXPLICIT_EXCLUSIONS",
      "archiveCutoffBusinessDate",
      "archiveObjectKey",
      "exclusionReasonOf",
      "isArchivable",
      "toJsonl",
    ];
    for (const name of names) {
      expect(name.toLowerCase(), name).not.toContain("delete");
      expect(name.toLowerCase(), name).not.toContain("purge");
    }
  });
});

describe("DIRECTLY_ARCHIVABLE_TABLES — いま実際に退避できる表", () => {
  it("**5 表だけ**（§19.7 の 9 表のうち `businessDate` を持つもの）", () => {
    expect(DIRECTLY_ARCHIVABLE_TABLES).toHaveLength(5);
  });

  it("すべて §19.7 の対象に含まれる（勝手に足していない）", () => {
    for (const table of DIRECTLY_ARCHIVABLE_TABLES) {
      expect(isArchivable(table), table).toBe(true);
    }
  });

  it.each(["task_time_log", "task_checklist_result", "inspection", "inspection_item_result"])(
    "**`%s` はいま退避できない**（親を辿らないと業務日が決まらない）",
    (table) => {
      // §19.7 の対象ではあるが、`businessDate` 列を持たない。
      expect(isArchivable(table)).toBe(true);
      expect(isDirectlyArchivable(table)).toBe(false);
    },
  );

  it("**退避する表を減らす方向は安全側**（残った行は D1 に残るだけ）", () => {
    expect(DIRECTLY_ARCHIVABLE_TABLES.length).toBeLessThan(ARCHIVABLE_TABLES.length);
  });

  it("除外された表は当然ここにも無い", () => {
    expect(isDirectlyArchivable("invoice")).toBe(false);
    expect(isDirectlyArchivable("audit_log")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// 復元（P7-09 / PK-SPEC-P7 §9）
// ────────────────────────────────────────────────────────────

describe("validateRestoreRange（§9.2「1 回の復元: 最大 3 か月分」）", () => {
  it("同じ日を許す（1 日ぶんの復元）", () => {
    expect(validateRestoreRange("2025-03-01", "2025-03-01")).toBe("OK");
  });

  it("ちょうど 3 か月を許す", () => {
    expect(validateRestoreRange("2025-01-15", "2025-04-15")).toBe("OK");
  });

  it("**3 か月を 1 日でも超えたら拒む**", () => {
    expect(validateRestoreRange("2025-01-15", "2025-04-16")).toBe("RANGE_TOO_WIDE");
  });

  it("向きが逆なら拒む", () => {
    expect(validateRestoreRange("2025-04-01", "2025-01-01")).toBe("RANGE_INVERTED");
  });

  it("年をまたいでも数えられる", () => {
    expect(validateRestoreRange("2025-11-01", "2026-02-01")).toBe("OK");
    expect(validateRestoreRange("2025-11-01", "2026-02-02")).toBe("RANGE_TOO_WIDE");
  });

  it("月末の繰り上がりで例外にならない", () => {
    expect(["OK", "RANGE_TOO_WIDE"]).toContain(validateRestoreRange("2025-11-30", "2026-03-01"));
  });
});

describe("archiveRestoreExpiresAt / isRestoreViewable（§9.2「保持: 7 日」）", () => {
  const readyAt = new Date("2026-08-15T00:00:00.000Z");

  it("7 日後", () => {
    expect(archiveRestoreExpiresAt(readyAt).toISOString()).toBe("2026-08-22T00:00:00.000Z");
  });

  it("期限より前なら読める", () => {
    const expires = archiveRestoreExpiresAt(readyAt);
    expect(isRestoreViewable(expires, new Date(expires.getTime() - 1))).toBe(true);
  });

  it("**期限ちょうどは読めない**", () => {
    const expires = archiveRestoreExpiresAt(readyAt);
    expect(isRestoreViewable(expires, expires)).toBe(false);
  });

  it("`null` は読めない（まだ READY になっていない）", () => {
    expect(isRestoreViewable(null, readyAt)).toBe(false);
  });
});

describe("restoreYearsOf", () => {
  it("同じ年なら 1 つ", () => {
    expect(restoreYearsOf("2025-01-01", "2025-03-01")).toEqual([2025]);
  });

  it("年をまたぐと両方", () => {
    expect(restoreYearsOf("2025-11-01", "2026-01-01")).toEqual([2025, 2026]);
  });

  it("向きが逆なら空", () => {
    expect(restoreYearsOf("2026-01-01", "2025-01-01")).toEqual([]);
  });
});

describe("parseJsonl", () => {
  it("`toJsonl()` の逆", () => {
    const rows = [{ id: "1" }, { id: "2" }];
    expect(parseJsonl(toJsonl(rows))).toEqual(rows);
  });

  it("空文字は 0 件", () => {
    expect(parseJsonl("")).toEqual([]);
  });

  it("**1 行でも壊れていたら `null`**（部分的に読めた写しを返さない）", () => {
    expect(parseJsonl('{"id":"1"}\nnot-json\n')).toBeNull();
  });

  it("オブジェクトでない行を拒む", () => {
    expect(parseJsonl("[1,2,3]\n")).toBeNull();
    expect(parseJsonl("42\n")).toBeNull();
  });
});
