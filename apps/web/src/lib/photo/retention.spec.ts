/**
 * 写真の保持期間（P7-10 / PK-SPEC-P7 §4.5 / security.md §4）。
 *
 * ── ここが守っているもの ────────────────────────────────
 * **写真の削除は取り返しがつかない。** 退避（§19.7）と違って写しを
 * 作らないので、境界を 1 日間違えると消えたものは戻らない。
 * だから境界・上限・下限のすべてに正例と負例を置く。
 */

import { describe, expect, it } from "vitest";

import {
  PHOTO_DELETION_BATCH_LIMIT,
  PHOTO_RETENTION_DEFAULT_MONTHS,
  PHOTO_RETENTION_MAX_MONTHS,
  PHOTO_RETENTION_NOTICE_DAYS,
  PHOTO_TABLES,
  isAcceptableRetentionMonths,
  photoDeletionCutoffMs,
  photoNoticeCutoffMs,
  photoRetentionStateOf,
  resolvePhotoRetentionMonths,
} from "./retention.js";

const NOW = new Date("2026-08-15T00:00:00.000Z");

describe("§4.5 の値", () => {
  it("既定 6 か月・上位プラン 13 か月", () => {
    expect(PHOTO_RETENTION_DEFAULT_MONTHS).toEqual({ BASE: 6, PRO: 13, ENT: 13 });
  });

  it("最大 36 か月", () => {
    expect(PHOTO_RETENTION_MAX_MONTHS).toBe(36);
  });

  it("通知は 30 日前", () => {
    expect(PHOTO_RETENTION_NOTICE_DAYS).toBe(30);
  });

  it("写真を持つ表は 4 つ", () => {
    expect([...PHOTO_TABLES]).toEqual([
      "task_photo",
      "inspection_photo",
      "issue_photo",
      "lost_item_photo",
    ]);
  });
});

describe("resolvePhotoRetentionMonths", () => {
  it("上書きが無ければ版数の既定", () => {
    expect(resolvePhotoRetentionMonths("BASE", null)).toBe(6);
    expect(resolvePhotoRetentionMonths("PRO", null)).toBe(13);
    expect(resolvePhotoRetentionMonths("ENT", null)).toBe(13);
  });

  it("延長できる", () => {
    expect(resolvePhotoRetentionMonths("BASE", 24)).toBe(24);
    expect(resolvePhotoRetentionMonths("PRO", 36)).toBe(36);
  });

  it("**短くはできない**（版数の既定が下限）", () => {
    // 短くできると「設定を触ったら過去の写真がまとめて消えた」が起こりうる。
    expect(resolvePhotoRetentionMonths("BASE", 1)).toBe(6);
    expect(resolvePhotoRetentionMonths("PRO", 6)).toBe(13);
    expect(resolvePhotoRetentionMonths("ENT", 0)).toBe(13);
  });

  it("**36 か月で頭打ち**", () => {
    expect(resolvePhotoRetentionMonths("ENT", 120)).toBe(36);
  });

  it("整数でない上書きは無かったことにする（既定へ戻す）", () => {
    expect(resolvePhotoRetentionMonths("BASE", 12.5)).toBe(6);
    expect(resolvePhotoRetentionMonths("BASE", Number.NaN)).toBe(6);
  });
});

describe("isAcceptableRetentionMonths", () => {
  it("版数の既定から 36 までを受け付ける", () => {
    expect(isAcceptableRetentionMonths(6, "BASE")).toBe(true);
    expect(isAcceptableRetentionMonths(36, "BASE")).toBe(true);
    expect(isAcceptableRetentionMonths(13, "PRO")).toBe(true);
  });

  it("**範囲外を黙って丸めない**（入力の検証はこちら）", () => {
    expect(isAcceptableRetentionMonths(5, "BASE")).toBe(false);
    expect(isAcceptableRetentionMonths(12, "PRO")).toBe(false);
    expect(isAcceptableRetentionMonths(37, "ENT")).toBe(false);
    expect(isAcceptableRetentionMonths(12.5, "BASE")).toBe(false);
  });
});

describe("photoDeletionCutoffMs", () => {
  it("6 か月前を指す", () => {
    expect(photoDeletionCutoffMs(NOW, 6)).toBe(Date.parse("2026-02-15T00:00:00.000Z"));
  });

  it("13 か月前を指す（年をまたぐ）", () => {
    expect(photoDeletionCutoffMs(NOW, 13)).toBe(Date.parse("2025-07-15T00:00:00.000Z"));
  });

  it("月末の繰り上がりを自前で書かない", () => {
    // 3/31 の 1 か月前は 2/31 → `Date` が 3/3（平年）へ送る。
    // ここで確かめたいのは**例外を投げず決定的に動く**こと。
    const march31 = new Date("2026-03-31T00:00:00.000Z");
    expect(Number.isFinite(photoDeletionCutoffMs(march31, 1))).toBe(true);
  });
});

describe("photoNoticeCutoffMs", () => {
  it("削除の境界より 30 日ぶん新しい", () => {
    const days30 = 30 * 24 * 60 * 60 * 1000;
    expect(photoNoticeCutoffMs(NOW, 6) - photoDeletionCutoffMs(NOW, 6)).toBe(days30);
  });
});

describe("photoRetentionStateOf", () => {
  const cutoff = photoDeletionCutoffMs(NOW, 6);
  const notice = photoNoticeCutoffMs(NOW, 6);

  it("境界より前は EXPIRED", () => {
    expect(photoRetentionStateOf(cutoff - 1, NOW, 6)).toBe("EXPIRED");
  });

  it("**境界ちょうどは残す**（1 日ぶん長く持つ方が安全）", () => {
    expect(photoRetentionStateOf(cutoff, NOW, 6)).toBe("EXPIRING_SOON");
  });

  it("30 日以内に期限が来るものは EXPIRING_SOON", () => {
    expect(photoRetentionStateOf(notice - 1, NOW, 6)).toBe("EXPIRING_SOON");
  });

  it("それより新しいものは RETAINED", () => {
    expect(photoRetentionStateOf(notice, NOW, 6)).toBe("RETAINED");
    expect(photoRetentionStateOf(NOW.getTime(), NOW, 6)).toBe("RETAINED");
  });

  it("**通知の対象と削除の対象が重ならない**", () => {
    // 重なると「通知した当日に消えた」が起きる。30 日の猶予が意味を失う。
    for (const offset of [-1, 0, 1, 1000]) {
      const state = photoRetentionStateOf(cutoff + offset, NOW, 6);
      expect(state === "EXPIRED" && offset >= 0, String(offset)).toBe(false);
    }
  });

  it("保持期間を延ばすと消える対象が減る", () => {
    const uploaded = Date.parse("2026-01-15T00:00:00.000Z");
    expect(photoRetentionStateOf(uploaded, NOW, 6)).toBe("EXPIRED");
    expect(photoRetentionStateOf(uploaded, NOW, 13)).toBe("RETAINED");
  });
});

describe("PHOTO_DELETION_BATCH_LIMIT", () => {
  it("1 回の上限が置いてある（CPU 予算と R2 の呼び出し回数）", () => {
    expect(PHOTO_DELETION_BATCH_LIMIT).toBe(500);
  });
});
