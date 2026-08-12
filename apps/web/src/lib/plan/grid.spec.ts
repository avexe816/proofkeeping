import { describe, expect, it } from "vitest";

import {
  GUEST_COUNT_MAX,
  buildPlanGrid,
  planFieldName,
  toPlanInputs,
  type PlanGridInput,
  type PlanRow,
} from "./grid.js";

const TYPE_TWIN = "o7k2m9__rtyp_TWN";

const ROOMS: PlanGridInput["rooms"] = [
  { id: "o7k2m9__room_302", roomNumber: "302", roomTypeId: TYPE_TWIN, isSellable: true },
  { id: "o7k2m9__room_303", roomNumber: "303", roomTypeId: null, isSellable: true },
  { id: "o7k2m9__room_P1", roomNumber: "3F-PANTRY", roomTypeId: null, isSellable: false },
];

const ROOM_TYPES = [{ id: TYPE_TWIN, name: "ツイン" }];

function reader(values: Record<string, string>): (name: string) => string | null {
  return (name) => values[name] ?? null;
}

describe("buildPlanGrid", () => {
  it("入力の無い客室も 1 行出す（入力できる場所が要る）", () => {
    const grid = buildPlanGrid({ rooms: ROOMS, roomTypes: ROOM_TYPES, plans: [] });
    expect(grid.rooms.map((row) => row.roomNumber)).toEqual(["302", "303"]);
    expect(grid.unfilled).toBe(2);
  });

  it("清掃専用の場所を客室と混ぜない", () => {
    const grid = buildPlanGrid({ rooms: ROOMS, roomTypes: ROOM_TYPES, plans: [] });
    expect(grid.nonSellable).toEqual([{ roomId: "o7k2m9__room_P1", roomNumber: "3F-PANTRY" }]);
    expect(grid.rooms.some((row) => row.roomNumber === "3F-PANTRY")).toBe(false);
  });

  it("清掃専用の場所を未入力件数に数えない", () => {
    const grid = buildPlanGrid({
      rooms: ROOMS,
      roomTypes: ROOM_TYPES,
      plans: [
        {
          roomId: "o7k2m9__room_302",
          hasCheckout: true,
          hasCheckin: true,
          isStayover: false,
          guestCount: 2,
          declineClean: false,
          source: "CSV",
        },
      ],
    });
    expect(grid.unfilled).toBe(1);
  });

  it("入力済みの値と入力元を行に載せる", () => {
    const grid = buildPlanGrid({
      rooms: ROOMS,
      roomTypes: ROOM_TYPES,
      plans: [
        {
          roomId: "o7k2m9__room_302",
          hasCheckout: true,
          hasCheckin: true,
          isStayover: false,
          guestCount: 2,
          declineClean: false,
          source: "CSV",
        },
      ],
    });
    expect(grid.rooms[0]).toEqual({
      roomId: "o7k2m9__room_302",
      roomNumber: "302",
      roomTypeName: "ツイン",
      hasCheckout: true,
      hasCheckin: true,
      isStayover: false,
      guestCount: 2,
      declineClean: false,
      source: "CSV",
    });
  });

  it("未入力の行は source が null（既定値と区別できる）", () => {
    const grid = buildPlanGrid({ rooms: ROOMS, roomTypes: ROOM_TYPES, plans: [] });
    expect(grid.rooms[0]?.source).toBeNull();
    expect(grid.rooms[0]?.hasCheckout).toBe(false);
  });

  it("客室タイプが未設定なら null（コードを推測しない）", () => {
    const grid = buildPlanGrid({ rooms: ROOMS, roomTypes: ROOM_TYPES, plans: [] });
    expect(grid.rooms[1]?.roomTypeName).toBeNull();
  });

  it("マスタに無い客室タイプ ID でも落ちない", () => {
    const grid = buildPlanGrid({ rooms: ROOMS, roomTypes: [], plans: [] });
    expect(grid.rooms[0]?.roomTypeName).toBeNull();
  });

  it("別の客室の計画が混ざらない", () => {
    const grid = buildPlanGrid({
      rooms: ROOMS,
      roomTypes: ROOM_TYPES,
      plans: [
        {
          roomId: "o7k2m9__room_303",
          hasCheckout: false,
          hasCheckin: false,
          isStayover: true,
          guestCount: 1,
          declineClean: false,
          source: "MANUAL",
        },
      ],
    });
    expect(grid.rooms[0]?.isStayover).toBe(false);
    expect(grid.rooms[1]?.isStayover).toBe(true);
  });

  it("客室が 0 件なら空の表", () => {
    expect(buildPlanGrid({ rooms: [], roomTypes: [], plans: [] })).toEqual({
      rooms: [],
      nonSellable: [],
      unfilled: 0,
    });
  });
});

describe("toPlanInputs", () => {
  const rows: readonly PlanRow[] = buildPlanGrid({
    rooms: ROOMS,
    roomTypes: ROOM_TYPES,
    plans: [],
  }).rooms;
  const room302 = "o7k2m9__room_302";

  it("チェックが無い行も送る（外したチェックが戻らないように）", () => {
    const result = toPlanInputs(rows, reader({}));
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual({
      roomId: room302,
      hasCheckout: false,
      hasCheckin: false,
      isStayover: false,
      guestCount: 0,
      declineClean: false,
    });
  });

  it("チェックボックスは値の有無で読む", () => {
    const result = toPlanInputs(
      rows,
      reader({
        [planFieldName(room302, "checkout")]: "on",
        [planFieldName(room302, "checkin")]: "on",
        [planFieldName(room302, "guests")]: "2",
      }),
    );
    expect(result.entries[0]).toMatchObject({
      hasCheckout: true,
      hasCheckin: true,
      guestCount: 2,
    });
  });

  it("清掃辞退を読む", () => {
    const result = toPlanInputs(rows, reader({ [planFieldName(room302, "decline")]: "on" }));
    expect(result.entries[0]?.declineClean).toBe(true);
  });

  it("空欄の人数は 0 名", () => {
    const result = toPlanInputs(rows, reader({ [planFieldName(room302, "guests")]: "" }));
    expect(result.entries[0]?.guestCount).toBe(0);
  });

  it("上限の人数は通る", () => {
    const result = toPlanInputs(
      rows,
      reader({ [planFieldName(room302, "guests")]: String(GUEST_COUNT_MAX) }),
    );
    expect(result.entries[0]?.guestCount).toBe(GUEST_COUNT_MAX);
  });

  it("範囲外の人数を 0 へ丸めず拒否する（CSV と扱いを分ける）", () => {
    const result = toPlanInputs(
      rows,
      reader({ [planFieldName(room302, "guests")]: String(GUEST_COUNT_MAX + 1) }),
    );
    expect(result.rejectedRoomNumbers).toEqual(["302"]);
    expect(result.entries.map((entry) => entry.roomId)).toEqual(["o7k2m9__room_303"]);
  });

  it("負値を拒否する", () => {
    const result = toPlanInputs(rows, reader({ [planFieldName(room302, "guests")]: "-1" }));
    expect(result.rejectedRoomNumbers).toEqual(["302"]);
  });

  it("非数を拒否する", () => {
    const result = toPlanInputs(rows, reader({ [planFieldName(room302, "guests")]: "ふたり" }));
    expect(result.rejectedRoomNumbers).toEqual(["302"]);
  });

  it("清掃専用の場所は送らない", () => {
    const result = toPlanInputs(rows, reader({}));
    expect(result.entries.map((entry) => entry.roomId)).not.toContain("o7k2m9__room_P1");
  });
});

describe("planFieldName", () => {
  it("客室 ID の `__` と衝突しない区切りを使う", () => {
    expect(planFieldName("o7k2m9__room_302", "guests").split("--")).toEqual([
      "plan",
      "o7k2m9__room_302",
      "guests",
    ]);
  });
});
