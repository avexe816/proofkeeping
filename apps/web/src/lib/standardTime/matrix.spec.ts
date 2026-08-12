import { DEFAULT_STANDARD_MINUTES } from "@pk/engine";
import { describe, expect, it } from "vitest";

import {
  EDITABLE_TASK_TYPES,
  MINUTES_MAX,
  MINUTES_MIN,
  buildMatrix,
  fieldName,
  toInputs,
  type MatrixRow,
} from "./matrix.js";

const SINGLE = { id: "o7k2m9__rtyp_A", code: "SGL", name: "シングル" };
const TWIN = { id: "o7k2m9__rtyp_B", code: "TWN", name: "ツイン" };
const ROOM_TYPES = [SINGLE, TWIN];

/** フォームの薄い代役。 */
function reader(values: Record<string, string>): (name: string) => string | null {
  return (name) => values[name] ?? null;
}

describe("buildMatrix", () => {
  it("客室タイプ × 清掃種別の表になる", () => {
    const rows = buildMatrix({ roomTypes: ROOM_TYPES, saved: [] });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.cells.map((cell) => cell.taskType)).toEqual([...EDITABLE_TASK_TYPES]);
    }
  });

  it("行の順序は入力の順序（呼び出し側が sortOrder で並べる）", () => {
    const rows = buildMatrix({ roomTypes: [...ROOM_TYPES].reverse(), saved: [] });
    expect(rows.map((row) => row.code)).toEqual(["TWN", "SGL"]);
  });

  it("設定が無いセルは既定分数を表示し isDefault が立つ", () => {
    const rows = buildMatrix({ roomTypes: ROOM_TYPES, saved: [] });
    const checkout = rows[0]?.cells.find((cell) => cell.taskType === "CHECKOUT");
    expect(checkout).toEqual({
      taskType: "CHECKOUT",
      minutes: DEFAULT_STANDARD_MINUTES.CHECKOUT,
      isDefault: true,
    });
  });

  it("設定がある セルは保存値を出し isDefault が下がる", () => {
    const rows = buildMatrix({
      roomTypes: ROOM_TYPES,
      saved: [{ roomTypeId: TWIN.id, taskType: "STAYOVER", minutes: 25 }],
    });
    const stayover = rows[1]?.cells.find((cell) => cell.taskType === "STAYOVER");
    expect(stayover).toEqual({ taskType: "STAYOVER", minutes: 25, isDefault: false });
  });

  it("表に出さない清掃種別の保存値は無視する（生成経路が P2 以降）", () => {
    const rows = buildMatrix({
      roomTypes: ROOM_TYPES,
      saved: [{ roomTypeId: SINGLE.id, taskType: "DEEP", minutes: 90 }],
    });
    expect(rows[0]?.cells.map((cell) => cell.minutes)).toEqual([
      DEFAULT_STANDARD_MINUTES.CHECKOUT,
      DEFAULT_STANDARD_MINUTES.STAYOVER,
    ]);
  });

  it("別の客室タイプの保存値が混ざらない", () => {
    const rows = buildMatrix({
      roomTypes: ROOM_TYPES,
      saved: [{ roomTypeId: SINGLE.id, taskType: "CHECKOUT", minutes: 55 }],
    });
    expect(rows[0]?.cells[0]?.minutes).toBe(55);
    expect(rows[1]?.cells[0]?.isDefault).toBe(true);
  });

  it("客室タイプが 0 件なら空の表", () => {
    expect(buildMatrix({ roomTypes: [], saved: [] })).toEqual([]);
  });
});

describe("toInputs", () => {
  const rows: readonly MatrixRow[] = buildMatrix({ roomTypes: ROOM_TYPES, saved: [] });
  const checkoutA = fieldName(SINGLE.id, "CHECKOUT");
  const stayoverB = fieldName(TWIN.id, "STAYOVER");

  it("変更されたセルだけを返す", () => {
    const result = toInputs(rows, reader({ [checkoutA]: "45" }));
    expect(result.entries).toEqual([
      { roomTypeId: SINGLE.id, taskType: "CHECKOUT", minutes: 45 },
    ]);
    expect(result.rejected).toEqual([]);
  });

  it("複数セルをまとめて返す", () => {
    const result = toInputs(rows, reader({ [checkoutA]: "45", [stayoverB]: "18" }));
    expect(result.entries).toHaveLength(2);
  });

  it("既定分数のまま触っていないセルは送らない", () => {
    const result = toInputs(
      rows,
      reader({ [checkoutA]: String(DEFAULT_STANDARD_MINUTES.CHECKOUT) }),
    );
    expect(result.entries).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("保存済みのセルは既定分数と同じ値でも送る（明示的な設定なので）", () => {
    const saved = buildMatrix({
      roomTypes: ROOM_TYPES,
      saved: [{ roomTypeId: SINGLE.id, taskType: "CHECKOUT", minutes: 30 }],
    });
    const result = toInputs(
      saved,
      reader({ [checkoutA]: String(DEFAULT_STANDARD_MINUTES.CHECKOUT) }),
    );
    expect(result.entries).toEqual([
      {
        roomTypeId: SINGLE.id,
        taskType: "CHECKOUT",
        minutes: DEFAULT_STANDARD_MINUTES.CHECKOUT,
      },
    ]);
  });

  it("送られてこなかったセルは触らない", () => {
    expect(toInputs(rows, reader({})).entries).toEqual([]);
  });

  it("空文字は「触っていない」として扱う", () => {
    expect(toInputs(rows, reader({ [checkoutA]: "   " })).entries).toEqual([]);
  });

  it("0 分を拒否する", () => {
    const result = toInputs(rows, reader({ [checkoutA]: "0" }));
    expect(result.entries).toEqual([]);
    expect(result.rejected).toEqual([checkoutA]);
  });

  it("上限を超える値を拒否する", () => {
    const result = toInputs(rows, reader({ [checkoutA]: String(MINUTES_MAX + 1) }));
    expect(result.rejected).toEqual([checkoutA]);
  });

  it("負値を拒否する", () => {
    expect(toInputs(rows, reader({ [checkoutA]: "-30" })).rejected).toEqual([checkoutA]);
  });

  it("非数を拒否する", () => {
    expect(toInputs(rows, reader({ [checkoutA]: "しばらく" })).rejected).toEqual([checkoutA]);
  });

  it("拒否したセルがあっても読めたセルは返す", () => {
    const result = toInputs(rows, reader({ [checkoutA]: "0", [stayoverB]: "18" }));
    expect(result.entries).toHaveLength(1);
    expect(result.rejected).toEqual([checkoutA]);
  });

  it("境界値（下限・上限）は通る", () => {
    const result = toInputs(
      rows,
      reader({ [checkoutA]: String(MINUTES_MIN), [stayoverB]: String(MINUTES_MAX) }),
    );
    expect(result.entries.map((entry) => entry.minutes)).toEqual([MINUTES_MIN, MINUTES_MAX]);
    expect(result.rejected).toEqual([]);
  });
});

describe("fieldName", () => {
  it("客室タイプ ID の `__` と衝突しない区切りを使う", () => {
    // ID 自体が `{orgShortId}__{prefix}_{ulid}`。`__` で割ると壊れる。
    const name = fieldName("o7k2m9__rtyp_A", "CHECKOUT");
    expect(name.split("--")).toEqual(["minutes", "o7k2m9__rtyp_A", "CHECKOUT"]);
  });
});
