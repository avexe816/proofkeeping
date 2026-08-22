/**
 * 設定サイドバー（人間の指示 2026-08-22 / DECISIONS #258）。
 *
 * ── 何を固定するのか ────────────────────────────────────
 * 設定内ナビは**分類・並び・現在地・到達先・権限**の 5 つで出来ている。
 * どれも壊れても画面は描かれてしまう（lint も typecheck も通る）ので、
 * ここで機械的に押さえる。
 *
 *   1. 分類  … 17 画面がちょうど 1 群に属する。群は 6 つ
 *   2. 並び  … `settingsOrder` の昇順。群の中で番号が重複しない
 *   3. 現在地 … 自分の URL と配下（マッピング）で親が選択状態
 *   4. 到達先 … 並ぶ URL が `routes.ts` に実在する
 *   5. 権限  … 全体ナビと同じ門（`resolveNavItem()`）を通る
 *
 * **分類漏れは型でも落ちる**（`SettingsPlacement` の union）。ここは
 * その型を迂回した場合と、値の側（順番・重複）を見る。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MODULE_CODES, type ModuleCode, type Role, type TenantContext } from "@pk/db";
import { describe, expect, it } from "vitest";

import {
  NAV_ITEMS,
  SETTINGS_GROUPS,
  SETTINGS_HUB_PATH,
  buildSettingsHub,
  type SettingsGroupKey,
} from "./navigation.js";
import { isSettingsArea, isSettingsItemActive, isSettingsSubScreen } from "./settingsNav.js";

const ROUTES = readFileSync(join(import.meta.dirname, "..", "routes.ts"), "utf8");

const PROPERTY_ID = "o7k2m9__prop_01JBXQ3ZK8N4P2VYR60000";
const ALL_MODULES: readonly ModuleCode[] = MODULE_CODES;

function ctxFor(role: Role): TenantContext {
  return {
    organizationId: "org_test_alpha",
    orgShortId: "o7k2m9",
    role,
    allowedPropertyIds: [PROPERTY_ID],
    now: new Date("2026-08-22T00:00:00.000Z"),
  };
}

function navFor(role: Role, enabledModules: readonly ModuleCode[] = ALL_MODULES) {
  return buildSettingsHub(ctxFor(role), { selectedPropertyId: PROPERTY_ID, enabledModules });
}

/** 設定サイドバーに並ぶ URL（その役の目に映るぶんだけ）。 */
function hrefsFor(role: Role): string[] {
  return navFor(role).flatMap((group) =>
    group.items.map((entry) => entry.href).filter((href): href is string => href !== null),
  );
}

/** `routes.ts` が宣言している URL（コメント行は数えない）。 */
function declaredPaths(): string[] {
  return [...ROUTES.matchAll(/^\s*route\(\s*"([^"]+)"/gm)].map((match) => `/${match[1] ?? ""}`);
}

const SETTINGS_ITEMS = NAV_ITEMS.filter((item) => item.placement === "SETTINGS");

describe("分類（唯一の登録簿は NAV_ITEMS）", () => {
  it("設定は 17 画面ある", () => {
    expect(SETTINGS_ITEMS).toHaveLength(17);
  });

  it("群は 6 つで、キーが重複しない", () => {
    expect(SETTINGS_GROUPS).toHaveLength(6);
    const keys = SETTINGS_GROUPS.map((group) => group.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * **ちょうど 1 群。** 群を持たない項目は型が許さないので、ここで
   * 見るのは「知らない群のキーを書いていないか」。
   */
  it("すべての設定画面が既知の群にちょうど 1 つ属する", () => {
    const known = new Set<string>(SETTINGS_GROUPS.map((group) => group.key));
    for (const item of SETTINGS_ITEMS) {
      expect(item.settingsGroup, item.key).toBeDefined();
      expect(known, item.key).toContain(item.settingsGroup);
    }
    // 全部足すと 17。**どこかの群で二重に数えていない。**
    const counted = SETTINGS_GROUPS.reduce(
      (total, group) =>
        total + SETTINGS_ITEMS.filter((item) => item.settingsGroup === group.key).length,
      0,
    );
    expect(counted).toBe(SETTINGS_ITEMS.length);
  });

  it("空の群を作らない", () => {
    for (const group of SETTINGS_GROUPS) {
      expect(
        SETTINGS_ITEMS.some((item) => item.settingsGroup === group.key),
        group.key,
      ).toBe(true);
    }
  });

  it("群の中で並び順が重複しない", () => {
    for (const group of SETTINGS_GROUPS) {
      const orders = SETTINGS_ITEMS.filter((item) => item.settingsGroup === group.key).map(
        (item) => item.settingsOrder,
      );
      expect(new Set(orders).size, group.key).toBe(orders.length);
      for (const order of orders) expect(order, group.key).toBeGreaterThan(0);
    }
  });
});

describe("並び", () => {
  it("群の並びは SETTINGS_GROUPS の順", () => {
    expect(navFor("OWNER").map((group) => group.key)).toEqual(
      SETTINGS_GROUPS.map((group) => group.key).filter((key) =>
        SETTINGS_ITEMS.some((item) => item.settingsGroup === key),
      ),
    );
  });

  it("群の中は settingsOrder の昇順", () => {
    const orderOf = new Map(SETTINGS_ITEMS.map((item) => [item.key, item.settingsOrder]));
    for (const group of navFor("OWNER")) {
      const orders = group.items.map((entry) => orderOf.get(entry.item.key) ?? 0);
      expect(orders, group.key).toEqual([...orders].sort((a, b) => a - b));
    }
  });

  /** 承認された分類（人間の確認 2026-08-22）。**黙って並べ替えない。** */
  it("施設と客室の並びが仕様どおり", () => {
    const property = navFor("OWNER").find((group) => group.key === "property");
    expect(property?.items.map((entry) => entry.item.key)).toEqual([
      "nav.propertySettings",
      "nav.rooms",
      "nav.roomTypes",
    ]);
  });
});

describe("出す場所", () => {
  it("ハブ自身には出さない（判断 A）", () => {
    expect(isSettingsArea(SETTINGS_HUB_PATH)).toBe(true);
    expect(isSettingsSubScreen(SETTINGS_HUB_PATH)).toBe(false);
  });

  it("設定のサブ画面すべてに出る", () => {
    for (const href of hrefsFor("OWNER")) {
      if (href === SETTINGS_HUB_PATH) continue;
      expect(isSettingsSubScreen(href), href).toBe(true);
    }
  });

  it("URL が離れている 2 画面にも出る（判断 B）", () => {
    for (const path of ["/app/training", "/app/audit/logs"]) {
      expect(isSettingsSubScreen(path), path).toBe(true);
    }
  });

  it("設定の外には出さない", () => {
    for (const path of [
      "/app/dashboard",
      "/app/billing",
      `/app/p/${PROPERTY_ID}/board`,
      "/app/audit/findings",
      "/app/audit/findings/next",
    ]) {
      expect(isSettingsSubScreen(path), path).toBe(false);
    }
  });
});

describe("現在地", () => {
  it("開いている画面だけが選択状態になる", () => {
    const hrefs = hrefsFor("OWNER");
    for (const path of hrefs) {
      const active = hrefs.filter((href) => isSettingsItemActive(href, path));
      expect(active, path).toEqual([path]);
    }
  });

  it("マッピング子画面では親（連携設定）が選択状態（判断 D）", () => {
    const child = `/app/settings/integrations/${PROPERTY_ID}/mappings`;
    const active = hrefsFor("OWNER").filter((href) => isSettingsItemActive(href, child));
    expect(active).toEqual(["/app/settings/integrations"]);
  });

  /** `/app/settings/rooms` が `/app/settings/room-types` に反応しない。 */
  it("接頭辞が似た URL を取り違えない", () => {
    expect(isSettingsItemActive("/app/settings/rooms", "/app/settings/room-types")).toBe(false);
  });

  it("ハブでは誰も選択状態にならない", () => {
    for (const href of hrefsFor("OWNER")) {
      expect(isSettingsItemActive(href, SETTINGS_HUB_PATH), href).toBe(false);
    }
  });

  it("リンクを持たない項目は選択状態にならない", () => {
    expect(isSettingsItemActive(null, "/app/settings/rooms")).toBe(false);
  });
});

describe("到達先", () => {
  it("並ぶ URL がすべて実在するルート", () => {
    const declared = new Set(declaredPaths());
    for (const href of hrefsFor("OWNER")) expect(declared, href).toContain(href);
  });

  /** 設定画面を足して分類し忘れたら、ここで落ちる。 */
  it("`/app/settings/*` の全ルートが設定サイドバーに並ぶ", () => {
    const listed = new Set(hrefsFor("OWNER"));
    const routes = declaredPaths().filter(
      (path) =>
        path.startsWith(`${SETTINGS_HUB_PATH}/`) &&
        !path.includes(":") &&
        path !== SETTINGS_HUB_PATH,
    );
    expect(routes.length).toBeGreaterThan(10);
    for (const path of routes) expect(listed, path).toContain(path);
  });
});

describe("権限と契約（全体ナビと同じ門）", () => {
  it("CLEANER には 1 群も出ない（設定そのものへ到達しない）", () => {
    expect(navFor("CLEANER")).toEqual([]);
  });

  /** `INSPECTOR` は請求を見られない（security.md §1）。 */
  it("INSPECTOR に取引と料金が出ない", () => {
    expect(navFor("INSPECTOR").map((group) => group.key)).not.toContain("money");
  });

  /** `AUDITOR` は読取専用。**書き込みの設定は出さない。** */
  it("AUDITOR に客室マスタが出ない", () => {
    expect(hrefsFor("AUDITOR")).not.toContain("/app/settings/rooms");
  });

  it("OWNER には 17 画面すべてが出る", () => {
    expect(hrefsFor("OWNER")).toHaveLength(17);
  });

  /**
   * **未契約は消さずグレーにする**（402 の世界）。権限が無いものだけを
   * 消す（404 の世界）。この 2 つを混ぜない。
   */
  it("契約が無いモジュールの項目はグレーで残る", () => {
    const withoutBilling = MODULE_CODES.filter((code) => code !== "BILLING");
    const money = navFor("OWNER", withoutBilling).find((group) => group.key === "money");
    const locked = money?.items.filter((entry) => entry.locked).map((entry) => entry.item.key);
    expect(locked).toContain("nav.counterparties");
  });
});

describe("群のキーは型で縛られている", () => {
  it("既知のキーだけが SettingsGroupKey に入る", () => {
    const keys: readonly SettingsGroupKey[] = SETTINGS_GROUPS.map((group) => group.key);
    expect(keys).toContain("property");
  });
});
