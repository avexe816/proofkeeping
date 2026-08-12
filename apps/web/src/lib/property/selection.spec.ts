import { describe, expect, it } from "vitest";

import { resolveSelectedProperty, sortProperties, type SelectableProperty } from "./selection.js";

/**
 * 表示中の施設の解決（PK-SPEC-P0 §23.4 / P0-14）。
 *
 * ここは純粋関数だけを見る。DB を伴う `switchProperty()` の越境・担当外は
 * `findPropertyById()`（第 1 層・第 2 層）が落とすので、
 * `tests/tenant-isolation/property.spec.ts` の担当。
 */

function property(id: string, sortOrder: number, code = id.toUpperCase()): SelectableProperty {
  return { id, code, name: `property-${id}`, sortOrder };
}

const TOKYO = property("o7k2m9__prop_tokyo", 1, "HTLA");
const OSAKA = property("o7k2m9__prop_osaka", 2, "INOS");
const KYOTO = property("o7k2m9__prop_kyoto", 3, "RYKY");

describe("sortProperties", () => {
  it("sortOrder の昇順に並ぶ", () => {
    expect(sortProperties([KYOTO, TOKYO, OSAKA]).map((p) => p.id)).toEqual([
      TOKYO.id,
      OSAKA.id,
      KYOTO.id,
    ]);
  });

  it("sortOrder が同じなら code の昇順に並ぶ", () => {
    const a = property("o7k2m9__prop_a", 5, "AAA");
    const b = property("o7k2m9__prop_b", 5, "BBB");

    expect(sortProperties([b, a]).map((p) => p.code)).toEqual(["AAA", "BBB"]);
  });

  it("入力の配列を書き換えない", () => {
    const input = [KYOTO, TOKYO];
    sortProperties(input);

    expect(input.map((p) => p.id)).toEqual([KYOTO.id, TOKYO.id]);
  });
});

describe("resolveSelectedProperty", () => {
  const properties = [TOKYO, OSAKA, KYOTO];

  it("セッションの施設が一覧にあればそれを返す", () => {
    expect(resolveSelectedProperty(OSAKA.id, properties)?.id).toBe(OSAKA.id);
  });

  it("未選択なら既定施設（並べた先頭）を返す", () => {
    expect(resolveSelectedProperty(undefined, properties)?.id).toBe(TOKYO.id);
  });

  it("権限から外れた施設が残っていたら既定施設へ戻す", () => {
    // 施設割当を解除された（§23.4 MUST）。一覧は第 1 層で絞られているので、
    // セッションに残った ID がここに無い＝もう見てはいけない施設。
    expect(resolveSelectedProperty("o7k2m9__prop_removed", properties)?.id).toBe(TOKYO.id);
  });

  it("無効化された施設が残っていたら既定施設へ戻す", () => {
    // `listSelectableProperties()` は isActive のみを返す。同じ経路で落ちる。
    expect(resolveSelectedProperty(KYOTO.id, [TOKYO, OSAKA])?.id).toBe(TOKYO.id);
  });

  it("別組織の ID が残っていても、その施設を返さない", () => {
    expect(resolveSelectedProperty("zz9zz9__prop_other", properties)?.id).toBe(TOKYO.id);
  });

  it("表示できる施設が無ければ null", () => {
    expect(resolveSelectedProperty(TOKYO.id, [])).toBeNull();
  });

  it("並び順が入れ替わっていても既定は sortOrder の先頭", () => {
    expect(resolveSelectedProperty(undefined, [KYOTO, OSAKA, TOKYO])?.id).toBe(TOKYO.id);
  });
});
