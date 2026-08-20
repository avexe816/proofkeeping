/**
 * サイドバーのセクション開閉（PK-SPEC-UI-A01 第2版 §4.4 / P7-21）。
 */

import { describe, expect, it } from "vitest";

import {
  CLOSED_SECTIONS_STORAGE_KEY,
  OPEN_GROUPS_STORAGE_KEY,
  readClosedSections,
  readOpenGroups,
  toggleSection,
  writeClosedSections,
  writeOpenGroups,
} from "./sidebarSections.js";

const SECTIONS = ["daily", "records", "analysis", "settings"];

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    dump: () => Object.fromEntries(map),
  };
}

describe("readClosedSections", () => {
  it("保存された値を読む", () => {
    const storage = fakeStorage({
      [CLOSED_SECTIONS_STORAGE_KEY]: JSON.stringify(["records", "settings"]),
    });
    expect(readClosedSections(storage, SECTIONS)).toEqual(["records", "settings"]);
  });

  it("storage が無い環境では全展開", () => {
    expect(readClosedSections(null, SECTIONS)).toEqual([]);
  });

  it("読めない環境（プライベートブラウズ）で例外を投げない", () => {
    const storage = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(readClosedSections(storage, SECTIONS)).toEqual([]);
  });

  it("壊れた JSON・配列でない値は全展開に倒す", () => {
    expect(
      readClosedSections(fakeStorage({ [CLOSED_SECTIONS_STORAGE_KEY]: "{oops" }), SECTIONS),
    ).toEqual([]);
    expect(
      readClosedSections(fakeStorage({ [CLOSED_SECTIONS_STORAGE_KEY]: '{"a":1}' }), SECTIONS),
    ).toEqual([]);
  });

  it("現在描画していないセクションは捨てる（古い保存値）", () => {
    const storage = fakeStorage({
      [CLOSED_SECTIONS_STORAGE_KEY]: JSON.stringify(["records", "gone", 3]),
    });
    expect(readClosedSections(storage, SECTIONS)).toEqual(["records"]);
  });
});

describe("writeClosedSections", () => {
  it("JSON で保存する", () => {
    const storage = fakeStorage();
    writeClosedSections(storage, ["daily"]);
    expect(storage.dump()[CLOSED_SECTIONS_STORAGE_KEY]).toBe(JSON.stringify(["daily"]));
  });

  it("書けない環境で例外を投げない", () => {
    const storage = {
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => {
      writeClosedSections(storage, ["daily"]);
    }).not.toThrow();
  });
});

describe("toggleSection", () => {
  it("閉じていなければ閉じる", () => {
    expect(toggleSection([], "records")).toEqual(["records"]);
  });

  it("閉じていれば開く", () => {
    expect(toggleSection(["records", "daily"], "records")).toEqual(["daily"]);
  });
});

/**
 * 親（束）は**閉じた形が既定**なので、残すのは「開いたもの」。
 * セクションと逆であることを固定する（`sidebarSections.ts` の表）。
 */
describe("開いている親（束）", () => {
  const GROUPS = ["board", "tasks", "rules"];

  it("保存が無ければ全部閉じる", () => {
    expect(readOpenGroups(fakeStorage(), GROUPS)).toEqual([]);
    expect(readOpenGroups(null, GROUPS)).toEqual([]);
  });

  it("セクションとは別のキーに残す（互いに上書きしない）", () => {
    const storage = fakeStorage();
    writeClosedSections(storage, ["records"]);
    writeOpenGroups(storage, ["rules"]);
    expect(storage.dump()[CLOSED_SECTIONS_STORAGE_KEY]).toBe(JSON.stringify(["records"]));
    expect(storage.dump()[OPEN_GROUPS_STORAGE_KEY]).toBe(JSON.stringify(["rules"]));
    expect(readOpenGroups(storage, GROUPS)).toEqual(["rules"]);
    expect(readClosedSections(storage, ["daily", "records"])).toEqual(["records"]);
  });

  it("いま描画していない親は捨てる（権限・契約で消えた束）", () => {
    const storage = fakeStorage({
      [OPEN_GROUPS_STORAGE_KEY]: JSON.stringify(["rules", "gone"]),
    });
    expect(readOpenGroups(storage, GROUPS)).toEqual(["rules"]);
  });

  it("書けない環境で例外を投げない", () => {
    expect(() => {
      writeOpenGroups(
        {
          setItem: () => {
            throw new Error("denied");
          },
        },
        ["rules"],
      );
    }).not.toThrow();
  });

  it("反転は足す・外すだけ（セクションと同じ関数）", () => {
    expect(toggleSection([], "rules")).toEqual(["rules"]);
    expect(toggleSection(["rules"], "rules")).toEqual([]);
  });
});
