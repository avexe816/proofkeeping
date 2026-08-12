/**
 * 範囲一括登録と CSV 取込の検査。
 *
 * task:  docs/tasks/P0-22.md
 * ルール: .claude/rules/testing.md §3
 */

import { describe, expect, it } from "vitest";

import { MAX_BULK_ROOMS, expandRoomRange, parseExcludedNumbers, parseRoomCsv } from "./bulk.js";

describe("expandRoomRange", () => {
  it("301-320 から 304 と 314 を除くと 18 室（§24.2 の例）", () => {
    const result = expandRoomRange({ from: 301, to: 320, exclude: [304, 314] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roomNumbers).toHaveLength(18);
    expect(result.excluded).toBe(2);
    expect(result.roomNumbers).not.toContain("304");
    expect(result.roomNumbers).not.toContain("314");
    expect(result.roomNumbers[0]).toBe("301");
  });

  it.each([
    [301, 320, 20],
    [1, 1, 1],
    [101, 200, 100],
    [1000, 1004, 5],
    [0, 2, 3],
  ])("%i-%i は %i 室", (from, to, expected) => {
    const result = expandRoomRange({ from, to });
    expect(result.ok && result.roomNumbers.length).toBe(expected);
  });

  it("範囲外の除外番号は無視する", () => {
    const result = expandRoomRange({ from: 301, to: 305, exclude: [999] });
    expect(result.ok && result.roomNumbers.length).toBe(5);
    expect(result.ok && result.excluded).toBe(0);
  });

  it("4 を含む番号を自動では飛ばさない", () => {
    // 除外は利用者が明示したものだけ（施設によって慣習が違う）。
    const result = expandRoomRange({ from: 401, to: 404 });
    expect(result.ok && result.roomNumbers).toContain("404");
  });

  it.each([
    ["終了が開始より小さい", 320, 301],
    ["負の開始", -1, 5],
    ["小数の開始", 1.5, 5],
    ["小数の終了", 1, 5.5],
    ["NaN", Number.NaN, 5],
  ])("%s は INVALID_RANGE", (_label, from, to) => {
    const result = expandRoomRange({ from, to });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe("INVALID_RANGE");
  });

  it("上限を超えると TOO_MANY", () => {
    const result = expandRoomRange({ from: 1, to: MAX_BULK_ROOMS + 1 });
    expect(!result.ok && result.error).toBe("TOO_MANY");
  });

  it("100 室が上限内に収まる（§24.2 の受け入れ基準）", () => {
    expect(expandRoomRange({ from: 101, to: 200 }).ok).toBe(true);
  });
});

describe("parseExcludedNumbers", () => {
  it.each([
    ["304, 314", [304, 314]],
    ["304 314", [304, 314]],
    ["304、314", [304, 314]],
    ["304,314,", [304, 314]],
    ["", []],
  ])("%s → %j", (raw, expected) => {
    expect(parseExcludedNumbers(raw)).toEqual(expected);
  });

  it("解釈できない断片は捨てる", () => {
    expect(parseExcludedNumbers("304, abc, 314")).toEqual([304, 314]);
  });
});

describe("parseRoomCsv", () => {
  const csv = [
    "room_number,room_type_code,floor_name,building_name,bed_count,capacity,note",
    "301,SGL,3F,本館,1,1,",
    "302,TWN,3F,本館,2,2,",
    "B01,PANTRY,B1,本館,,,清掃用パントリー",
  ].join("\n");

  it("§24.2 の例を読める", () => {
    const result = parseRoomCsv(csv);
    expect(result.rows).toHaveLength(3);
    expect(result.rejected).toHaveLength(0);
    expect(result.rows[0]).toEqual({
      roomNumber: "301",
      roomTypeCode: "SGL",
      floorName: "3F",
      buildingName: "本館",
      bedCount: 1,
      capacity: 1,
      note: null,
    });
  });

  it("清掃専用の場所は PANTRY という客室タイプで表される", () => {
    const result = parseRoomCsv(csv);
    expect(result.rows[2]?.roomTypeCode).toBe("PANTRY");
    expect(result.rows[2]?.bedCount).toBeNull();
    expect(result.rows[2]?.note).toBe("清掃用パントリー");
  });

  it("ヘッダが無くても読める", () => {
    const result = parseRoomCsv("301,SGL,3F,本館,1,1,");
    expect(result.rows).toHaveLength(1);
  });

  it("空行を飛ばす", () => {
    const result = parseRoomCsv("301,SGL\n\n302,TWN\n");
    expect(result.rows).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
  });

  it("壊れた行だけを落とし、他は取り込む", () => {
    const result = parseRoomCsv("301,SGL\n301だけ\n,SGL\n303,TWN");
    expect(result.rows.map((row) => row.roomNumber)).toEqual(["301", "303"]);
    expect(result.rejected).toEqual([
      { line: 2, reason: "TOO_FEW_COLUMNS" },
      { line: 3, reason: "MISSING_ROOM_NUMBER" },
    ]);
  });

  it("CRLF を読める", () => {
    expect(parseRoomCsv("301,SGL\r\n302,TWN").rows).toHaveLength(2);
  });

  it("数値でない bed_count は null にする（登録は止めない）", () => {
    expect(parseRoomCsv("301,SGL,3F,本館,いくつか,1,").rows[0]?.bedCount).toBeNull();
  });
});
