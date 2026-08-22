/**
 * 上位の画面へ戻る道（人間の指摘 2026-08-22 / DECISIONS #257）。
 *
 * ── 何を固定するのか ────────────────────────────────────
 * 守りたいのは「**設定画面を足した人が戻り道を付け忘れる**と、その画面が
 * また袋小路になる」こと。`buildBreadcrumb()` は `NAV_ITEMS` を見るので
 * 足し忘れは起きない作りだが、**それが崩れたらここで落ちる**ように
 * ハブの全 URL を実際に回して確かめる（`settingsHub.spec.ts` と同じ流儀）。
 *
 * 戻り先が**実在するルート**であることも `routes.ts` を読んで見る。
 * 死んだリンクは lint も typecheck も通る種類の壊れ方。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MODULE_CODES, type ModuleCode, type TenantContext } from "@pk/db";
import { describe, expect, it } from "vitest";

import { buildBreadcrumb } from "./breadcrumb.js";
import { SETTINGS_HUB_PATH, buildSettingsHub } from "./navigation.js";

const ROUTES = readFileSync(join(import.meta.dirname, "..", "routes.ts"), "utf8");

const PROPERTY_ID = "o7k2m9__prop_01JBXQ3ZK8N4P2VYR60000";
const ALL_MODULES: readonly ModuleCode[] = MODULE_CODES;

const OWNER: TenantContext = {
  organizationId: "org_test_alpha",
  orgShortId: "o7k2m9",
  role: "OWNER",
  allowedPropertyIds: [],
  now: new Date("2026-08-22T00:00:00.000Z"),
};

/** ハブから 1 クリックで開ける URL（＝戻り道が要る画面）。 */
function hubPaths(): string[] {
  return buildSettingsHub(OWNER, {
    selectedPropertyId: PROPERTY_ID,
    enabledModules: ALL_MODULES,
  }).flatMap((category) =>
    category.items.map((entry) => entry.href).filter((href): href is string => href !== null),
  );
}

/** `routes.ts` が宣言している URL（コメント行は数えない）。 */
function declaredPaths(): string[] {
  return [...ROUTES.matchAll(/^\s*route\(\s*"([^"]+)"/gm)].map((match) => `/${match[1] ?? ""}`);
}

describe("設定のサブ画面から上位へ戻れる", () => {
  it("ハブの全 URL に戻り道が付く", () => {
    const paths = hubPaths();
    expect(paths.length).toBeGreaterThan(10);
    for (const path of paths) {
      const trail = buildBreadcrumb(path);
      expect(trail.length, path).toBeGreaterThan(0);
      // 先頭は必ずハブ。**どの設定画面からも 1 クリックで一覧へ戻れる。**
      expect(trail[0]?.href, path).toBe(SETTINGS_HUB_PATH);
    }
  });

  it("`/app/settings/*` の外にある設定 2 画面も戻れる", () => {
    for (const path of ["/app/training", "/app/audit/logs"]) {
      expect(
        buildBreadcrumb(path).map((crumb) => crumb.href),
        path,
      ).toEqual([SETTINGS_HUB_PATH]);
    }
  });

  it("2 段下の画面は途中の画面も並ぶ（連携設定 → マッピング設定）", () => {
    const trail = buildBreadcrumb(`/app/settings/integrations/${PROPERTY_ID}/mappings`);
    expect(trail.map((crumb) => crumb.href)).toEqual([
      SETTINGS_HUB_PATH,
      "/app/settings/integrations",
    ]);
    expect(trail.map((crumb) => crumb.label)).toEqual(["nav.settings", "nav.integrations"]);
  });

  it("戻り先はすべて実在するルート", () => {
    const declared = new Set(declaredPaths());
    for (const path of [...hubPaths(), `/app/settings/integrations/x/mappings`]) {
      for (const crumb of buildBreadcrumb(path)) expect(declared, crumb.href).toContain(crumb.href);
    }
  });

  /** 開いている画面自身は並べない（見出しに出ている語を繰り返さない）。 */
  it("いま開いている画面は戻り先に含まれない", () => {
    for (const path of hubPaths()) {
      expect(
        buildBreadcrumb(path).some((crumb) => crumb.href === path),
        path,
      ).toBe(false);
    }
  });
});

describe("戻り道を出さない画面", () => {
  it("ハブ自身は空（ここが上位）", () => {
    expect(buildBreadcrumb(SETTINGS_HUB_PATH)).toEqual([]);
  });

  /**
   * **設定の外に道を作らない。** 一覧 → 詳細のような親子は画面ごとに
   * 事情が違う（どの一覧へ戻すかが URL から決まらない）。推測しない。
   */
  it("設定以外の画面は空", () => {
    for (const path of [
      "/app/dashboard",
      "/app/billing",
      `/app/p/${PROPERTY_ID}/board`,
      "/app/audit/findings",
      // 監査ログと接頭辞が似ているが別の画面。
      "/app/audit/findings/next",
    ]) {
      expect(buildBreadcrumb(path), path).toEqual([]);
    }
  });
});
