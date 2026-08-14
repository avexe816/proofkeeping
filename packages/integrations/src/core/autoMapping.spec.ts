/**
 * 客室の自動マッピング（P6-05 / PK-SPEC-P6 §2.3・§7.2）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 */

import { describe, expect, it } from "vitest";

import { autoMapRooms, normalizeRoomKey, type AutoMapCandidate } from "./autoMapping.js";

const ORG = "o7k2m9";

/** ProofKeeping 側の客室。 */
function room(number: string, suffix = number): AutoMapCandidate {
  return { id: `${ORG}__room_${suffix}`, number, label: "ツイン" };
}

/** 外部システム側の客室。 */
function external(number: string, label?: string): AutoMapCandidate {
  return { id: number, number, ...(label === undefined ? {} : { label }) };
}

describe("normalizeRoomKey", () => {
  it("前後の空白を落とす", () => {
    expect(normalizeRoomKey("  302 ")).toBe("302");
  });

  it("全角数字を半角にする", () => {
    expect(normalizeRoomKey("３０２")).toBe("302");
  });

  it("英字は大文字に揃える", () => {
    expect(normalizeRoomKey("a101")).toBe("A101");
  });

  it("**前ゼロを落とさない**（§7.2 は `0305` を手動設定と描いている）", () => {
    expect(normalizeRoomKey("0305")).toBe("0305");
    expect(normalizeRoomKey("0305")).not.toBe(normalizeRoomKey("305"));
  });

  it("中の空白は残す（別の番号を作らない）", () => {
    expect(normalizeRoomKey("3 02")).toBe("3 02");
  });
});

describe("autoMapRooms — 正例（結べる）", () => {
  it("部屋番号が一致すれば結ぶ", () => {
    const result = autoMapRooms({
      internal: [room("302"), room("303")],
      external: [external("302"), external("303")],
    });
    expect(result.pairs).toHaveLength(2);
    expect(result.pairs[0]).toMatchObject({ internalId: room("302").id, externalId: "302" });
  });

  it("外部側の表示名を持ち帰る", () => {
    const result = autoMapRooms({
      internal: [room("302")],
      external: [external("302", "302 Twin")],
    });
    expect(result.pairs[0]?.externalLabel).toBe("302 Twin");
  });

  it("表示名が無ければ null", () => {
    const result = autoMapRooms({ internal: [room("302")], external: [external("302")] });
    expect(result.pairs[0]?.externalLabel).toBeNull();
  });

  it("全角と半角が混ざっていても結ぶ", () => {
    const result = autoMapRooms({
      internal: [room("３０２", "a")],
      external: [external("302")],
    });
    expect(result.pairs).toHaveLength(1);
  });

  it("並びは入力順のまま（同じ入力から同じ結果）", () => {
    const input = {
      internal: [room("601"), room("302"), room("303")],
      external: [external("303"), external("302"), external("601")],
    };
    const first = autoMapRooms(input);
    expect(first.pairs.map((pair) => pair.matchedOn)).toEqual(["601", "302", "303"]);
    expect(autoMapRooms(input)).toEqual(first);
  });
});

describe("autoMapRooms — 負例（結ばない）", () => {
  it("**`305` と `0305` を結ばない**（表記ゆれは手動設定）", () => {
    const result = autoMapRooms({
      internal: [room("305")],
      external: [external("0305")],
    });
    expect(result.pairs).toHaveLength(0);
    expect(result.unmatchedInternal.map((row) => row.number)).toEqual(["305"]);
    expect(result.unmatchedExternal.map((row) => row.number)).toEqual(["0305"]);
  });

  it("相手のいない外部 ID は未マッピングとして返す（エラーにしない）", () => {
    const result = autoMapRooms({ internal: [], external: [external("9001")] });
    expect(result.unmatchedExternal.map((row) => row.number)).toEqual(["9001"]);
  });

  it("相手のいない客室も未マッピングとして返す", () => {
    const result = autoMapRooms({ internal: [room("601")], external: [] });
    expect(result.unmatchedInternal.map((row) => row.number)).toEqual(["601"]);
  });

  it("番号が空の客室は突き合わせない", () => {
    const result = autoMapRooms({ internal: [room("", "blank")], external: [external("")] });
    expect(result.pairs).toHaveLength(0);
  });

  it("両側とも空なら何も起きない", () => {
    expect(autoMapRooms({ internal: [], external: [] })).toEqual({
      pairs: [],
      unmatchedInternal: [],
      unmatchedExternal: [],
      ambiguous: [],
    });
  });
});

describe("autoMapRooms — 曖昧なものを結ばない", () => {
  it("外部側に同じ番号が 2 つあれば結ばない", () => {
    const result = autoMapRooms({
      internal: [room("302")],
      external: [
        { id: "EXT-A", number: "302" },
        { id: "EXT-B", number: "302" },
      ],
    });
    expect(result.pairs).toHaveLength(0);
    expect(result.ambiguous).toEqual(["302"]);
  });

  it("内側に同じ番号が 2 つあれば結ばない", () => {
    const result = autoMapRooms({
      internal: [room("302", "a"), room("302", "b")],
      external: [external("302")],
    });
    expect(result.pairs).toHaveLength(0);
    expect(result.ambiguous).toEqual(["302"]);
  });

  it("曖昧なものは両側とも未マッピングに残る", () => {
    const result = autoMapRooms({
      internal: [room("302")],
      external: [
        { id: "EXT-A", number: "302" },
        { id: "EXT-B", number: "302" },
      ],
    });
    expect(result.unmatchedInternal).toHaveLength(1);
    expect(result.unmatchedExternal).toHaveLength(2);
  });

  it("曖昧な番号があっても他の組は結ぶ", () => {
    const result = autoMapRooms({
      internal: [room("302"), room("303")],
      external: [
        { id: "EXT-A", number: "302" },
        { id: "EXT-B", number: "302" },
        external("303"),
      ],
    });
    expect(result.pairs.map((pair) => pair.matchedOn)).toEqual(["303"]);
  });
});

describe("autoMapRooms — 既にある対応を壊さない", () => {
  it("対応済みの客室は候補から外れる", () => {
    const result = autoMapRooms({
      internal: [room("302"), room("303")],
      external: [external("302"), external("303")],
      alreadyMappedInternalIds: new Set([room("302").id]),
    });
    expect(result.pairs.map((pair) => pair.matchedOn)).toEqual(["303"]);
    expect(result.unmatchedInternal).toHaveLength(0);
  });

  it("対応済みの外部 ID は候補から外れる", () => {
    const result = autoMapRooms({
      internal: [room("305")],
      external: [external("0305")],
      alreadyMappedExternalIds: new Set(["0305"]),
    });
    expect(result.pairs).toHaveLength(0);
    // 手で `305 ←→ 0305` を作ってあるので、外部側は候補に現れない。
    expect(result.unmatchedExternal).toHaveLength(0);
    // 内側は「この実行では結べなかった」として残る。
    expect(result.unmatchedInternal).toHaveLength(1);
  });

  it("再実行しても同じ組を 2 度返さない", () => {
    const first = autoMapRooms({
      internal: [room("302")],
      external: [external("302")],
    });
    const second = autoMapRooms({
      internal: [room("302")],
      external: [external("302")],
      alreadyMappedInternalIds: new Set(first.pairs.map((pair) => pair.internalId)),
      alreadyMappedExternalIds: new Set(first.pairs.map((pair) => pair.externalId)),
    });
    expect(second.pairs).toHaveLength(0);
  });
});
