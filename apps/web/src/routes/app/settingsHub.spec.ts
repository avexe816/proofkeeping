/**
 * 設定ハブ（人間の指示 2026-08-20 / 案 2）。
 *
 *   /app/settings
 *
 * ── なぜ routes.ts を読むのか ───────────────────────────
 * 守りたいのは「**設定画面を作った人がハブに載せ忘れる**と、その画面へ
 * 行く手段が消える」こと。サイドバーから外した以上、ハブが唯一の入口に
 * なる。ルート定義を実際に読んで、`/app/settings/*` の全 URL がハブに
 * 在ることを固定する（`staffScreen.spec.ts` と同じ流儀）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MODULE_CODES, type ModuleCode, type TenantContext } from "@pk/db";
import { describe, expect, it } from "vitest";

import {
  NAV_ITEMS,
  SETTINGS_ACTIVE_PREFIXES,
  SETTINGS_HUB_PATH,
  buildSettingsHub,
} from "../../ui/navigation.js";

const ROUTES = readFileSync(join(import.meta.dirname, "..", "..", "routes.ts"), "utf8");
/**
 * コメントを落とした画面のソース。**注記の中の「403」自体が検査に
 * 引っ掛かる**ので、実装だけを見る（`staffScreen.spec.ts` と同じ）。
 */
const SOURCE = readFileSync(join(import.meta.dirname, "settingsHub.tsx"), "utf8")
  .replaceAll(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

const PROPERTY_ID = "o7k2m9__prop_01JBXQ3ZK8N4P2VYR60000";
const ALL_MODULES: readonly ModuleCode[] = MODULE_CODES;

const OWNER: TenantContext = {
  organizationId: "org_test_alpha",
  orgShortId: "o7k2m9",
  role: "OWNER",
  allowedPropertyIds: [],
  now: new Date("2026-08-20T00:00:00.000Z"),
};

/** `routes.ts` が宣言している URL（コメント行は数えない）。 */
function declaredPaths(): string[] {
  return [...ROUTES.matchAll(/^\s*route\(\s*"([^"]+)"/gm)].map((match) => `/${match[1] ?? ""}`);
}

/** ハブから 1 クリックで開ける URL。 */
function hubPaths(): string[] {
  return buildSettingsHub(OWNER, {
    selectedPropertyId: PROPERTY_ID,
    enabledModules: ALL_MODULES,
  }).flatMap((category) =>
    category.items.map((entry) => entry.href).filter((href): href is string => href !== null),
  );
}

describe("設定ハブから到達できる", () => {
  it("ハブ自身がルートとして宣言されている", () => {
    expect(declaredPaths()).toContain(SETTINGS_HUB_PATH);
  });

  /**
   * **`/app/settings/*` に置いた画面はハブに載せる。** 子ページ
   * （`:integrationId/mappings` のような可変部分を持つ URL）は親の画面から
   * 開くので、ここでは数えない。
   */
  it("`/app/settings/*` の全 URL がハブに在る", () => {
    const settingsRoutes = declaredPaths().filter(
      (path) =>
        path.startsWith(`${SETTINGS_HUB_PATH}/`) && !path.includes(":") && path !== SETTINGS_HUB_PATH,
    );

    expect(settingsRoutes.length).toBeGreaterThan(10);
    const reachable = new Set(hubPaths());
    for (const path of settingsRoutes) expect(reachable, path).toContain(path);
  });

  /** `/app/settings/*` の外に置いた設定 2 画面（研修・監査ログ）。 */
  it("設定セクションに居た画面がすべてハブに在る", () => {
    const reachable = new Set(hubPaths());
    for (const path of ["/app/training", "/app/audit/logs"]) {
      expect(reachable, path).toContain(path);
    }
  });

  /** 選択状態の接頭辞は、ハブに載る URL をすべて覆う。 */
  it("ハブの全 URL が「設定」の選択状態に入る", () => {
    for (const path of hubPaths()) {
      expect(
        SETTINGS_ACTIVE_PREFIXES.some(
          (prefix) => path === prefix || path.startsWith(`${prefix}/`),
        ),
        path,
      ).toBe(true);
    }
  });

  it("ハブに並ぶ URL がすべて実在するルート", () => {
    const declared = new Set(declaredPaths());
    for (const path of hubPaths()) expect(declared, path).toContain(path);
  });

  /** W-18（検査ポリシー）を足して 16 → **17**。件数は登録簿から導く。 */
  it("ハブは設定画面ぶんのカードを持つ（現在 17 枚）", () => {
    expect(hubPaths()).toHaveLength(
      NAV_ITEMS.filter((item) => item.placement === "SETTINGS").length,
    );
  });
});

describe("ハブは門を代行しない", () => {
  /**
   * ハブは入口を並べるだけ。**ここに `assertPermission()` を置いて
   * 各画面から外す、という置き換えをしない**（security.md §1）。
   */
  it("設定を書き込む口を持たない（action を持たない画面）", () => {
    expect(SOURCE).not.toMatch(/export async function action/);
  });

  it("1 枚も開けない相手には 404（403 にしない）", () => {
    expect(SOURCE).toMatch(/NotFoundError/);
    expect(SOURCE).not.toMatch(/403/);
  });
});
