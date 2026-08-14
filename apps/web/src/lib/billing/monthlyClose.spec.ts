/**
 * 月次締めの起票（P5-05 / PK-SPEC-P5 §6.1）。
 *
 * ── 見ているもの ────────────────────────────────────────
 * cron 式（`0 19 28-31 * *`）は **UTC の月末を撃つだけ**で、
 * 「JST の 1 日か」を判定できない。撃ち分けはハンドラの
 * `isMonthlyCloseMoment()` が持つので、そこを固定する。
 *
 * ここを間違えると**締めが 1 日早く走る**（前日ぶんの作業が
 * 期間から落ちる）。月末が 30 日の月・31 日の月・2 月・閏年を並べる。
 */

import { describe, expect, it } from "vitest";

import { MONTHLY_CLOSE_CRON, isMonthlyCloseMoment } from "./monthlyClose.js";

/** JST の 1 日 04:00 に当たる UTC の瞬間（前日 19:00）。 */
function utcOfJstFirstAt04(previousDayUtc: string): Date {
  return new Date(`${previousDayUtc}T19:00:00.000Z`);
}

describe("isMonthlyCloseMoment", () => {
  // ── 正例: cron が撃つ 4 通りの月末すべてで真になる ──────
  it.each([
    ["31 日ある月の末日", "2026-08-31", "2026-09-01"],
    ["30 日ある月の末日", "2026-09-30", "2026-10-01"],
    ["2 月（平年）の末日", "2026-02-28", "2026-03-01"],
    ["2 月（閏年）の末日", "2028-02-29", "2028-03-01"],
    ["年をまたぐ", "2026-12-31", "2027-01-01"],
  ])("%s の 19:00 UTC は JST の %s → 締める日", (_label, previousDayUtc) => {
    expect(isMonthlyCloseMoment(utcOfJstFirstAt04(previousDayUtc))).toBe(true);
  });

  // ── 負例: cron は撃つが JST の 1 日ではない ─────────────
  it.each([
    // 31 日ある月では 30 日の回も発火する。**ここで止めないと 1 日早い。**
    ["2026-08-30"],
    // 2 月がある年は 28・29・30・31 のうち複数が空振りする。
    ["2026-02-27"],
    ["2026-01-29"],
    ["2026-01-30"],
  ])("%s の 19:00 UTC は JST の 1 日ではない → 締めない", (previousDayUtc) => {
    expect(isMonthlyCloseMoment(new Date(`${previousDayUtc}T19:00:00.000Z`))).toBe(false);
  });

  it("同じ日でも 19:00 UTC より前は前月のまま（JST の 1 日になっていない）", () => {
    // 2026-08-31T18:59Z = JST 2026-09-01 03:59 … ではなく 2026-09-01 の
    // 3:59。JST では既に 1 日なので真。**04:00 という時刻は見ていない。**
    expect(isMonthlyCloseMoment(new Date("2026-08-31T18:59:00.000Z"))).toBe(true);
    // 一方 14:59Z は JST 23:59（8/31）。まだ 1 日ではない。
    expect(isMonthlyCloseMoment(new Date("2026-08-31T14:59:00.000Z"))).toBe(false);
  });

  it("月の途中は常に偽", () => {
    for (const day of ["05", "12", "20", "25"]) {
      expect(isMonthlyCloseMoment(new Date(`2026-09-${day}T19:00:00.000Z`))).toBe(false);
    }
  });
});

describe("MONTHLY_CLOSE_CRON", () => {
  it("wrangler.toml の [triggers] と同じ式であること", () => {
    // **一字でもずれると `scheduled()` の分岐が一致せず、締めの回で
    // タスク生成が走る。** 式そのものをここに固定しておく。
    expect(MONTHLY_CLOSE_CRON).toBe("0 19 28-31 * *");
  });

  it("UTC の月末になりうる日だけを撃つ", () => {
    // 28〜31 以外を含めない。毎日撃つと 1 か月に 30 回空振りする。
    expect(MONTHLY_CLOSE_CRON.split(" ")[2]).toBe("28-31");
  });
});
