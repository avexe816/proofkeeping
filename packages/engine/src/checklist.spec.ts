/**
 * チェックリストの階層解決と完了判定（PK-SPEC-P1 §6 / §5.3）。
 */

import { describe, expect, it } from "vitest";

import {
  checkCompletion,
  checklistProgress,
  resolveTemplate,
  type ChecklistResultInput,
  type TemplateCandidate,
} from "./checklist.js";

const ORG_WIDE: TemplateCandidate = {
  id: "o7k2m9__ctpl_01JBXQ3ZK8N4P2VYR60001",
  propertyId: null,
  roomTypeId: null,
  taskType: "CHECKOUT",
  isActive: true,
};

const PROPERTY_LEVEL: TemplateCandidate = {
  id: "o7k2m9__ctpl_01JBXQ3ZK8N4P2VYR60002",
  propertyId: "o7k2m9__prop_A",
  roomTypeId: null,
  taskType: "CHECKOUT",
  isActive: true,
};

const ROOM_TYPE_LEVEL: TemplateCandidate = {
  id: "o7k2m9__ctpl_01JBXQ3ZK8N4P2VYR60003",
  propertyId: "o7k2m9__prop_A",
  roomTypeId: "o7k2m9__rtyp_TWN",
  taskType: "CHECKOUT",
  isActive: true,
};

const SCOPE = {
  propertyId: "o7k2m9__prop_A",
  roomTypeId: "o7k2m9__rtyp_TWN",
  taskType: "CHECKOUT",
} as const;

describe("resolveTemplate — 3 階層の継承（§6.1）", () => {
  it("客室タイプ別が最優先", () => {
    const found = resolveTemplate([ORG_WIDE, PROPERTY_LEVEL, ROOM_TYPE_LEVEL], SCOPE);

    expect(found?.id).toBe(ROOM_TYPE_LEVEL.id);
  });

  it("客室タイプ別が無ければ施設別", () => {
    const found = resolveTemplate([ORG_WIDE, PROPERTY_LEVEL], SCOPE);

    expect(found?.id).toBe(PROPERTY_LEVEL.id);
  });

  it("施設別も無ければ組織共通", () => {
    const found = resolveTemplate([ORG_WIDE], SCOPE);

    expect(found?.id).toBe(ORG_WIDE.id);
  });

  it("客室タイプが未設定の客室でも施設別まで解決できる", () => {
    const found = resolveTemplate([ORG_WIDE, PROPERTY_LEVEL, ROOM_TYPE_LEVEL], {
      ...SCOPE,
      roomTypeId: null,
    });

    expect(found?.id).toBe(PROPERTY_LEVEL.id);
  });

  it("無効化されたテンプレートは選ばない", () => {
    const found = resolveTemplate(
      [ORG_WIDE, { ...ROOM_TYPE_LEVEL, isActive: false }],
      SCOPE,
    );

    expect(found?.id).toBe(ORG_WIDE.id);
  });

  it("同点が複数あっても落とさず id の昇順で 1 つに決める", () => {
    const duplicate: TemplateCandidate = {
      ...ORG_WIDE,
      id: "o7k2m9__ctpl_01JBXQ3ZK8N4P2VYR60000",
    };

    expect(resolveTemplate([ORG_WIDE, duplicate], SCOPE)?.id).toBe(duplicate.id);
  });
});

describe("resolveTemplate — 負例", () => {
  it("清掃種別が違うテンプレートは選ばない", () => {
    expect(resolveTemplate([{ ...ORG_WIDE, taskType: "STAYOVER" }], SCOPE)).toBeNull();
  });

  it("別の施設のテンプレートは選ばない", () => {
    expect(resolveTemplate([{ ...PROPERTY_LEVEL, propertyId: "o7k2m9__prop_B" }], SCOPE)).toBeNull();
  });

  it("別の客室タイプのテンプレートは選ばない", () => {
    expect(
      resolveTemplate([{ ...ROOM_TYPE_LEVEL, roomTypeId: "o7k2m9__rtyp_SGL" }], SCOPE),
    ).toBeNull();
  });

  it("客室タイプ付きの組織共通テンプレートは階層に無いので選ばない", () => {
    expect(
      resolveTemplate([{ ...ORG_WIDE, roomTypeId: "o7k2m9__rtyp_TWN" }], SCOPE),
    ).toBeNull();
  });

  it("候補が空なら null（チェックリストの無いタスクは成立する）", () => {
    expect(resolveTemplate([], SCOPE)).toBeNull();
  });
});

/** 実施結果の 1 行。 */
function result(overrides: Partial<ChecklistResultInput> = {}): ChecklistResultInput {
  return {
    itemId: "o7k2m9__citm_01JBXQ3ZK8N4P2VYR60001",
    isRequired: true,
    photoRequired: false,
    value: "DONE",
    photoCount: 0,
    ...overrides,
  };
}

describe("checkCompletion — §5.3 の 2 つの MUST", () => {
  it("必須項目がすべて記録済みなら通す", () => {
    expect(checkCompletion([result(), result({ itemId: "b" })]).ok).toBe(true);
  });

  it("必須項目が未記録なら CHECKLIST_INCOMPLETE の対象になる", () => {
    const check = checkCompletion([result({ value: null })]);

    expect(check.ok).toBe(false);
    expect(check.incompleteItemIds).toHaveLength(1);
  });

  it("COULD_NOT は完了を妨げない（3 値の意味 / INV-22）", () => {
    expect(checkCompletion([result({ value: "COULD_NOT" })]).ok).toBe(true);
  });

  it("任意項目は未記録でも通す", () => {
    expect(checkCompletion([result({ isRequired: false, value: null })]).ok).toBe(true);
  });

  it("写真必須の項目に写真が無ければ PHOTO_REQUIRED の対象になる", () => {
    const check = checkCompletion([result({ photoRequired: true, photoCount: 0 })]);

    expect(check.ok).toBe(false);
    expect(check.missingPhotoItemIds).toHaveLength(1);
  });

  it("写真必須の項目に写真があれば通す", () => {
    expect(checkCompletion([result({ photoRequired: true, photoCount: 1 })]).ok).toBe(true);
  });

  it("該当なしの項目には写真を求めない", () => {
    const check = checkCompletion([
      result({ photoRequired: true, photoCount: 0, value: "NOT_APPLICABLE" }),
    ]);

    expect(check.ok).toBe(true);
  });

  it("項目が 1 件も無いタスクは通す", () => {
    expect(checkCompletion([]).ok).toBe(true);
  });

  it("未記録と写真不足を同時に返す（画面が両方出せる）", () => {
    const check = checkCompletion([
      result({ itemId: "a", value: null }),
      result({ itemId: "b", photoRequired: true }),
    ]);

    expect(check.incompleteItemIds).toEqual(["a"]);
    expect(check.missingPhotoItemIds).toEqual(["b"]);
  });
});

describe("checklistProgress — 分母から NOT_APPLICABLE を除く（§2.4）", () => {
  it("該当なしを分母に数えない", () => {
    const progress = checklistProgress([
      result({ value: "DONE" }),
      result({ value: "NOT_APPLICABLE" }),
      result({ value: null }),
    ]);

    expect(progress).toEqual({ done: 1, total: 2 });
  });

  it("COULD_NOT は分母に数え、分子には数えない", () => {
    expect(checklistProgress([result({ value: "COULD_NOT" })])).toEqual({ done: 0, total: 1 });
  });

  it("空なら 0/0", () => {
    expect(checklistProgress([])).toEqual({ done: 0, total: 0 });
  });
});
