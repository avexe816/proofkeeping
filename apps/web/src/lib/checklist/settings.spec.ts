import { describe, expect, it } from "vitest";

import {
  buildTemplateViews,
  formatItems,
  mergeTranslations,
  parseItems,
  resolveEffective,
  tierOf,
  type TemplateViewInput,
} from "./settings.js";

const PROPERTY = "o7k2m9__prop_A";
const TYPE_TWIN = "o7k2m9__rtyp_TWN";

const ORG_TEMPLATE = {
  id: "o7k2m9__ctpl_001",
  name: "組織共通（アウト清掃）",
  taskType: "CHECKOUT",
  version: 1,
  propertyId: null,
  roomTypeId: null,
  isActive: true,
};

const PROPERTY_TEMPLATE = {
  id: "o7k2m9__ctpl_002",
  name: "施設別（アウト清掃）",
  taskType: "CHECKOUT",
  version: 3,
  propertyId: PROPERTY,
  roomTypeId: null,
  isActive: true,
};

const ROOM_TYPE_TEMPLATE = {
  id: "o7k2m9__ctpl_003",
  name: "ツイン専用（アウト清掃）",
  taskType: "CHECKOUT",
  version: 1,
  propertyId: PROPERTY,
  roomTypeId: TYPE_TWIN,
  isActive: true,
};

const ITEMS: TemplateViewInput["items"] = [
  {
    templateId: ORG_TEMPLATE.id,
    section: "ベッドまわり",
    labels: { ja: "シーツ・カバー類を交換した", en: "Changed sheets" },
    isRequired: true,
    photoRequired: false,
    sortOrder: 0,
  },
  {
    templateId: ORG_TEMPLATE.id,
    section: "浴室",
    labels: { ja: "浴室の水滴を拭き上げた" },
    isRequired: true,
    photoRequired: true,
    sortOrder: 1,
  },
];

describe("tierOf", () => {
  it("propertyId が null なら組織共通", () => {
    expect(tierOf({ propertyId: null, roomTypeId: null })).toBe("ORGANIZATION");
  });

  it("施設ありで客室タイプ無しなら施設別", () => {
    expect(tierOf({ propertyId: PROPERTY, roomTypeId: null })).toBe("PROPERTY");
  });

  it("施設と客室タイプの両方があれば客室タイプ別", () => {
    expect(tierOf({ propertyId: PROPERTY, roomTypeId: TYPE_TWIN })).toBe("ROOM_TYPE");
  });
});

describe("buildTemplateViews", () => {
  const input: TemplateViewInput = {
    templates: [ROOM_TYPE_TEMPLATE, ORG_TEMPLATE, PROPERTY_TEMPLATE],
    items: ITEMS,
    roomTypes: [{ id: TYPE_TWIN, name: "ツイン" }],
  };

  it("階層の浅い順に並ぶ", () => {
    expect(buildTemplateViews(input).map((view) => view.tier)).toEqual([
      "ORGANIZATION",
      "PROPERTY",
      "ROOM_TYPE",
    ]);
  });

  it("項目数を数える", () => {
    const views = buildTemplateViews(input);
    expect(views[0]?.itemCount).toBe(2);
    expect(views[1]?.itemCount).toBe(0);
  });

  it("未翻訳の件数を数える（§12.2 の「日本語のみ」）", () => {
    expect(buildTemplateViews(input)[0]?.untranslatedCount).toBe(1);
  });

  it("客室タイプ名を解決する", () => {
    expect(buildTemplateViews(input)[2]?.roomTypeName).toBe("ツイン");
  });

  it("マスタに無い客室タイプ ID でも落ちない", () => {
    const views = buildTemplateViews({ ...input, roomTypes: [] });
    expect(views[2]?.roomTypeName).toBeNull();
  });

  it("無効化済みも返す（消えたのではないことが読めるように）", () => {
    const views = buildTemplateViews({
      ...input,
      templates: [{ ...ORG_TEMPLATE, isActive: false }],
    });
    expect(views).toHaveLength(1);
    expect(views[0]?.isActive).toBe(false);
  });

  it("項目を sortOrder の昇順でテキストにする", () => {
    const views = buildTemplateViews({
      ...input,
      items: [...ITEMS].reverse(),
    });
    expect(views[0]?.itemsText.split("\n")[0]).toContain("シーツ・カバー類を交換した");
  });

  it("版を載せる（保存すると上がることを画面が示せる）", () => {
    expect(buildTemplateViews(input)[1]?.version).toBe(3);
  });
});

describe("resolveEffective", () => {
  const candidates = [ORG_TEMPLATE, PROPERTY_TEMPLATE, ROOM_TYPE_TEMPLATE];

  it("客室タイプ別が施設別より優先される", () => {
    const effective = resolveEffective(candidates, PROPERTY, [TYPE_TWIN], ["CHECKOUT"]);
    expect([...effective]).toEqual([ROOM_TYPE_TEMPLATE.id]);
  });

  it("客室タイプの設定が無い部屋は施設別が効く", () => {
    const effective = resolveEffective(candidates, PROPERTY, [null], ["CHECKOUT"]);
    expect([...effective]).toEqual([PROPERTY_TEMPLATE.id]);
  });

  it("施設別が無ければ組織共通が効く", () => {
    const effective = resolveEffective([ORG_TEMPLATE], PROPERTY, [null], ["CHECKOUT"]);
    expect([...effective]).toEqual([ORG_TEMPLATE.id]);
  });

  it("客室タイプが複数あれば効くものが複数になる", () => {
    const effective = resolveEffective(candidates, PROPERTY, [TYPE_TWIN, null], ["CHECKOUT"]);
    expect(effective.size).toBe(2);
  });

  it("該当が無い清掃種別は含めない（チェックリスト無しは成立する）", () => {
    const effective = resolveEffective(candidates, PROPERTY, [null], ["STAYOVER"]);
    expect(effective.size).toBe(0);
  });

  it("無効化済みは効かない", () => {
    const effective = resolveEffective(
      [{ ...ROOM_TYPE_TEMPLATE, isActive: false }, PROPERTY_TEMPLATE],
      PROPERTY,
      [TYPE_TWIN],
      ["CHECKOUT"],
    );
    expect([...effective]).toEqual([PROPERTY_TEMPLATE.id]);
  });

  it("別の施設のテンプレートは効かない", () => {
    const effective = resolveEffective(
      [{ ...PROPERTY_TEMPLATE, propertyId: "o7k2m9__prop_B" }],
      PROPERTY,
      [null],
      ["CHECKOUT"],
    );
    expect(effective.size).toBe(0);
  });
});

describe("parseItems / formatItems", () => {
  it("1 行 1 項目を読む", () => {
    const parsed = parseItems("ベッドまわり / シーツを交換した / 必須 / -");
    expect(parsed.items).toEqual([
      {
        section: "ベッドまわり",
        labels: { ja: "シーツを交換した" },
        isRequired: true,
        photoRequired: false,
      },
    ]);
    expect(parsed.skippedLines).toEqual([]);
  });

  it("写真必須を読む", () => {
    const parsed = parseItems("浴室 / 水滴を拭き上げた / 必須 / 写真");
    expect(parsed.items[0]).toMatchObject({ isRequired: true, photoRequired: true });
  });

  it("任意項目を読む", () => {
    const parsed = parseItems("客室 / 窓・鏡を清掃した / 任意 / -");
    expect(parsed.items[0]?.isRequired).toBe(false);
  });

  it("空行は飛ばす（読めなかった行に数えない）", () => {
    const parsed = parseItems("A / a / 必須 / -\n\n  \nB / b / 任意 / -");
    expect(parsed.items).toHaveLength(2);
    expect(parsed.skippedLines).toEqual([]);
  });

  it("ラベルが空の行を読めなかった行として返す", () => {
    const parsed = parseItems("A / a / 必須 / -\nB /  / 必須 / -");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.skippedLines).toEqual([2]);
  });

  it("セクションが空の行を読めなかった行として返す", () => {
    const parsed = parseItems(" / a / 必須 / -");
    expect(parsed.items).toEqual([]);
    expect(parsed.skippedLines).toEqual([1]);
  });

  it("フラグ列が無ければ任意・写真なし", () => {
    const parsed = parseItems("A / a");
    expect(parsed.items[0]).toMatchObject({ isRequired: false, photoRequired: false });
  });

  it("`//` でラベルに `/` を書ける", () => {
    const parsed = parseItems("A / 上//下を拭いた / 必須 / -");
    expect(parsed.items[0]?.labels["ja"]).toBe("上/下を拭いた");
  });

  it("formatItems → parseItems が元に戻る", () => {
    const items = [
      { section: "A", labels: { ja: "上/下を拭いた" }, isRequired: true, photoRequired: true },
      { section: "B", labels: { ja: "床を清掃した" }, isRequired: false, photoRequired: false },
    ];
    expect(parseItems(formatItems(items)).items).toEqual([
      { section: "A", labels: { ja: "上/下を拭いた" }, isRequired: true, photoRequired: true },
      { section: "B", labels: { ja: "床を清掃した" }, isRequired: false, photoRequired: false },
    ]);
  });

  it("往復を 3 回繰り返しても変わらない", () => {
    const first = formatItems(parseItems("A / a / 必須 / 写真").items);
    const second = formatItems(parseItems(first).items);
    const third = formatItems(parseItems(second).items);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("空のテキストは 0 項目", () => {
    expect(parseItems("")).toEqual({ items: [], skippedLines: [] });
  });
});

describe("mergeTranslations", () => {
  it("同じ日本語ラベルの訳文を引き継ぐ", () => {
    const merged = mergeTranslations(
      [{ section: "A", labels: { ja: "床を清掃した" }, isRequired: true, photoRequired: false }],
      [{ labels: { ja: "床を清掃した", en: "Cleaned the floor" } }],
    );
    expect(merged[0]?.labels).toEqual({ ja: "床を清掃した", en: "Cleaned the floor" });
  });

  it("行を挿入しても訳がずれない（並び順で対応づけない）", () => {
    const merged = mergeTranslations(
      [
        { section: "A", labels: { ja: "新しい項目" }, isRequired: true, photoRequired: false },
        { section: "A", labels: { ja: "床を清掃した" }, isRequired: true, photoRequired: false },
      ],
      [{ labels: { ja: "床を清掃した", en: "Cleaned the floor" } }],
    );
    expect(merged[0]?.labels["en"]).toBeUndefined();
    expect(merged[1]?.labels["en"]).toBe("Cleaned the floor");
  });

  it("日本語は新しい方を正とする", () => {
    const merged = mergeTranslations(
      [{ section: "A", labels: { ja: "床を清掃した" }, isRequired: true, photoRequired: false }],
      [{ labels: { ja: "床を清掃した", en: "Cleaned the floor" } }],
    );
    expect(merged[0]?.labels["ja"]).toBe("床を清掃した");
  });

  it("既存に無い項目はそのまま", () => {
    const items = [
      { section: "A", labels: { ja: "新しい項目" }, isRequired: false, photoRequired: false },
    ];
    expect(mergeTranslations(items, [])).toEqual(items);
  });

  it("既存の日本語が空の項目は対応づけの元にしない", () => {
    const merged = mergeTranslations(
      [{ section: "A", labels: { ja: "" }, isRequired: false, photoRequired: false }],
      [{ labels: { ja: "", en: "Something" } }],
    );
    expect(merged[0]?.labels["en"]).toBeUndefined();
  });
});
