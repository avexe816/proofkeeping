/**
 * `lib/room/roomTypes.ts` の検査。
 *
 * task:  docs/tasks/P1-24.md
 * ルール: .claude/rules/testing.md §3（正例と負例を最低 5 件ずつ）
 */

import { describe, expect, it } from "vitest";

import { buildRoomTypeIndex, resolveRoomTypeCodes } from "./roomTypes.js";

const TYPES = [
  { id: "o7k2m9__rtyp_0001", code: "SGL" },
  { id: "o7k2m9__rtyp_0002", code: "TWN" },
  { id: "o7k2m9__rtyp_0003", code: "PANTRY" },
] as const;

describe("buildRoomTypeIndex", () => {
  it("コードを小文字の鍵で引ける", () => {
    const index = buildRoomTypeIndex(TYPES);
    expect(index.get("sgl")).toBe("o7k2m9__rtyp_0001");
    expect(index.get("twn")).toBe("o7k2m9__rtyp_0002");
    expect(index.get("pantry")).toBe("o7k2m9__rtyp_0003");
  });

  it("空のコードは載せない", () => {
    const index = buildRoomTypeIndex([{ id: "x", code: "  " }]);
    expect(index.size).toBe(0);
  });

  it("大小違いの重複は先に来たほうが勝つ", () => {
    const index = buildRoomTypeIndex([
      { id: "first", code: "TWN" },
      { id: "second", code: "twn" },
    ]);
    expect(index.get("twn")).toBe("first");
  });

  it("前後の空白を無視する", () => {
    const index = buildRoomTypeIndex([{ id: "x", code: " DBL " }]);
    expect(index.get("dbl")).toBe("x");
  });

  it("空の入力から空の表を作る", () => {
    expect(buildRoomTypeIndex([]).size).toBe(0);
  });
});

describe("resolveRoomTypeCodes", () => {
  const index = buildRoomTypeIndex(TYPES);

  // ── 正例 ──────────────────────────────────────────────
  it("一致するコードを ID へ写す", () => {
    const result = resolveRoomTypeCodes([{ roomTypeCode: "TWN" }], index);
    expect(result.rows).toEqual([{ roomTypeId: "o7k2m9__rtyp_0002" }]);
    expect(result.unknownCodes).toEqual([]);
  });

  it("小文字で書かれていても一致する", () => {
    const result = resolveRoomTypeCodes([{ roomTypeCode: "sgl" }], index);
    expect(result.rows[0]?.roomTypeId).toBe("o7k2m9__rtyp_0001");
  });

  it("前後に空白があっても一致する", () => {
    const result = resolveRoomTypeCodes([{ roomTypeCode: " TWN " }], index);
    expect(result.rows[0]?.roomTypeId).toBe("o7k2m9__rtyp_0002");
  });

  it("入力と同じ並び・同じ長さで返す", () => {
    const result = resolveRoomTypeCodes(
      [{ roomTypeCode: "SGL" }, { roomTypeCode: null }, { roomTypeCode: "PANTRY" }],
      index,
    );
    expect(result.rows.map((row) => row.roomTypeId)).toEqual([
      "o7k2m9__rtyp_0001",
      undefined,
      "o7k2m9__rtyp_0003",
    ]);
  });

  it("空の入力を受ける", () => {
    const result = resolveRoomTypeCodes([], index);
    expect(result.rows).toEqual([]);
    expect(result.unknownCodes).toEqual([]);
  });

  // ── 負例 ──────────────────────────────────────────────
  it("マスタに無いコードは未設定として取り込む", () => {
    const result = resolveRoomTypeCodes([{ roomTypeCode: "XXX" }], index);
    expect(result.rows).toEqual([{ roomTypeId: undefined }]);
    expect(result.unknownCodes).toEqual(["XXX"]);
  });

  it("未知のコードがあっても他の行は取り込まれる", () => {
    const result = resolveRoomTypeCodes(
      [{ roomTypeCode: "SGL" }, { roomTypeCode: "XXX" }, { roomTypeCode: "TWN" }],
      index,
    );
    expect(result.rows.map((row) => row.roomTypeId)).toEqual([
      "o7k2m9__rtyp_0001",
      undefined,
      "o7k2m9__rtyp_0002",
    ]);
  });

  it("同じ未知のコードは 1 回だけ返す", () => {
    const result = resolveRoomTypeCodes(
      [{ roomTypeCode: "XXX" }, { roomTypeCode: "XXX" }, { roomTypeCode: "YYY" }],
      index,
    );
    expect(result.unknownCodes).toEqual(["XXX", "YYY"]);
  });

  it("空欄は未知のコードに数えない", () => {
    const result = resolveRoomTypeCodes(
      [{ roomTypeCode: null }, { roomTypeCode: "" }, { roomTypeCode: "   " }],
      index,
    );
    expect(result.rows.map((row) => row.roomTypeId)).toEqual([undefined, undefined, undefined]);
    expect(result.unknownCodes).toEqual([]);
  });

  it("マスタが空なら全行が未設定になる", () => {
    const result = resolveRoomTypeCodes(
      [{ roomTypeCode: "SGL" }, { roomTypeCode: "TWN" }],
      buildRoomTypeIndex([]),
    );
    expect(result.rows.every((row) => row.roomTypeId === undefined)).toBe(true);
    expect(result.unknownCodes).toEqual(["SGL", "TWN"]);
  });
});
