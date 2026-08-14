import { MODULE_CODES, type ModuleCode, type Role, type TenantContext } from "@pk/db";
import { describe, expect, it } from "vitest";

import { PERMISSION_ACTION_LIST } from "../lib/auth/permission.js";
import { ja } from "../locales/index.js";

import { NAV_ITEMS, NAV_SECTIONS, NAV_SECTION_LABEL, buildNavigation } from "./navigation.js";

/**
 * ナビゲーションの出し分け（P0-14）。
 *
 * **ここで守っているのは security.md §1 の「絶対に守る境界」の見え方。**
 * 実際の到達可否は `assertPermission()`（P0-10）が別に判定する。
 * 画面の非表示は権限制御ではないが、**存在を示唆しない**ことは画面側の責任。
 */

const PROPERTY_ID = "o7k2m9__prop_01JBXQ3ZK8N4P2VYR60000";

const ALL_MODULES: readonly ModuleCode[] = MODULE_CODES;

function ctxFor(role: Role, allowedPropertyIds: readonly string[] = [PROPERTY_ID]): TenantContext {
  return {
    organizationId: "org_test_alpha",
    orgShortId: "o7k2m9",
    role,
    // 組織全体ロールは空配列（`tenant.ts` と同じ形）。
    allowedPropertyIds:
      role === "OWNER" || role === "ORG_ADMIN" || role === "AUDITOR" ? [] : allowedPropertyIds,
    now: new Date("2026-08-12T00:00:00.000Z"),
  };
}

function keysFor(role: Role, enabledModules: readonly ModuleCode[] = ALL_MODULES): string[] {
  return buildNavigation(ctxFor(role), {
    selectedPropertyId: PROPERTY_ID,
    enabledModules,
  }).flatMap((group) => group.items.map((entry) => entry.item.key));
}

describe("登録簿の不変条件", () => {
  it("全項目の action が PERMISSION_ACTIONS にある", () => {
    // 存在しない操作を書くと権限判定が黙って通る（`can()` が引けない）。
    for (const item of NAV_ITEMS) {
      expect(PERMISSION_ACTION_LIST, item.key).toContain(item.action);
    }
  });

  it("全項目の文言キーが ja に存在する", () => {
    for (const item of NAV_ITEMS) {
      expect(Object.keys(ja), item.key).toContain(item.key);
    }
    for (const section of NAV_SECTIONS) {
      expect(Object.keys(ja)).toContain(NAV_SECTION_LABEL[section]);
    }
  });

  it("READY の項目だけが href を持つ", () => {
    for (const item of NAV_ITEMS) {
      if (item.status === "READY") expect(item.href, item.key).toMatch(/^\/app\//);
      else expect(item).not.toHaveProperty("href");
    }
  });

  it("実在する画面だけが READY になっている", () => {
    // 到達先の無いリンクを作らない。**画面を作る task が READY に変え、
    // ここへ 1 行足す。** P0-14 はダッシュボードだけ、P1-14 / P1-15 が
    // タスク管理と客室ボードを足した。
    expect(NAV_ITEMS.filter((item) => item.status === "READY").map((item) => item.key)).toEqual([
      "nav.dashboard",
      "nav.board",
      "nav.tasks",
      // W-05（P1-04 の未達分）。
      "nav.plan",
      // W-06 差異レポート一覧（P4-06）。「日次運用」の最後。
      "nav.findings",
      // W-06 証跡一覧（P2-09）。「記録の確認」の 1 つめ。
      "nav.cleaningRecords",
      // W-22 データ品質ダッシュボード（P3-12）。「資材と分析」の 1 つめ。
      "nav.dataQuality",
      // §7.2 清掃会社プラン（P5-15）。「資材と分析」の最後。
      "nav.vendorPlan",
      // `/app/settings/*` の 4 画面。客室マスタ（P0-22）と事業者税務（P0-16）は
      // ルートが実在するのに**サイドバーに出ていなかった。**
      "nav.rooms",
      // W-25 客室タイプ管理（P1-24）。客室マスタの直後。
      "nav.roomTypes",
      "nav.checklists",
      "nav.standardTimes",
      // P3-11 が足した W-20（観察項目の設定）。
      "nav.observationSettings",
      // P4-13 が足した W-25（照合ルールの設定）。
      "nav.rules",
      // P3-10 が足した W-21（ベースライン確認・上書き）。
      "nav.baseline",
      "nav.taxProfile",
      // 取引先と料金（P5-02 / P5-03）。事業者・税務設定の直後。
      "nav.counterparties",
    ]);
  });

  it("施設が選ばれていなければ施設 ID を含む項目を出さない", () => {
    // `{propertyId}` を空文字で埋めたリンクを作らない（404 へ誘導しない）。
    const keys = buildNavigation(ctxFor("OWNER"), {
      selectedPropertyId: null,
      enabledModules: ALL_MODULES,
    }).flatMap((group) => group.items.map((entry) => entry.item.key));
    expect(keys).not.toContain("nav.board");
    expect(keys).not.toContain("nav.tasks");
    expect(keys).not.toContain("nav.plan");
  });

  it("READY の項目は解決済みの href を持つ", () => {
    const entries = buildNavigation(ctxFor("PROPERTY_MANAGER"), {
      selectedPropertyId: PROPERTY_ID,
      enabledModules: ALL_MODULES,
    }).flatMap((group) => group.items);
    const board = entries.find((entry) => entry.item.key === "nav.board");
    expect(board?.href).toBe(`/app/p/${PROPERTY_ID}/board`);
  });

  it("CLEANER にタスク管理を出さない（配分は施設責任者の判断）", () => {
    expect(keysFor("CLEANER")).not.toContain("nav.tasks");
  });

  it("INSPECTOR にタスク管理を出さない", () => {
    expect(keysFor("INSPECTOR")).not.toContain("nav.tasks");
  });

  it("項目のキーが重複しない", () => {
    const keys = NAV_ITEMS.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("権限による非表示（security.md §1 の絶対境界）", () => {
  it("CLEANER に差異レポートの項目を出さない", () => {
    // 404 を返す境界。**グレー表示にもしない**（「契約すれば見られる」と読める）。
    const keys = keysFor("CLEANER");
    expect(keys).not.toContain("nav.findings");
    expect(keys).not.toContain("nav.findingDetail");
  });

  it("INSPECTOR に差異レポートの項目を出さない", () => {
    const keys = keysFor("INSPECTOR");
    expect(keys).not.toContain("nav.findings");
    expect(keys).not.toContain("nav.findingDetail");
  });

  it("INSPECTOR に請求の項目を出さない", () => {
    expect(keysFor("INSPECTOR")).not.toContain("nav.billing");
  });

  it("CLEANER に請求の項目を出さない", () => {
    expect(keysFor("CLEANER")).not.toContain("nav.billing");
  });

  it("AUDITOR に書き込みの項目を出さない", () => {
    const keys = keysFor("AUDITOR");
    expect(keys).not.toContain("nav.propertySettings");
    expect(keys).not.toContain("nav.permission");
    // 読取専用。設定の 4 画面はいずれも書き込みの操作を action に持つ。
    expect(keys).not.toContain("nav.rooms");
    expect(keys).not.toContain("nav.checklists");
    expect(keys).not.toContain("nav.standardTimes");
    expect(keys).not.toContain("nav.taxProfile");
    expect(keys).not.toContain("nav.plan");
  });

  it("CLEANER / INSPECTOR に当日の客室状況を出さない（§10.1 は P_MANAGER 以上）", () => {
    expect(keysFor("CLEANER")).not.toContain("nav.plan");
    expect(keysFor("INSPECTOR")).not.toContain("nav.plan");
  });

  it("PROPERTY_MANAGER に当日の客室状況を出す", () => {
    expect(keysFor("PROPERTY_MANAGER")).toContain("nav.plan");
  });

  it("PROPERTY_MANAGER に組織単位の設定 2 画面を出さない（§10.1 は ORG_ADMIN）", () => {
    const keys = keysFor("PROPERTY_MANAGER");
    expect(keys).not.toContain("nav.checklists");
    expect(keys).not.toContain("nav.standardTimes");
  });

  it("ORG_ADMIN に設定の 4 画面すべてを出す", () => {
    const keys = keysFor("ORG_ADMIN");
    expect(keys).toContain("nav.rooms");
    expect(keys).toContain("nav.checklists");
    expect(keys).toContain("nav.standardTimes");
    expect(keys).toContain("nav.taxProfile");
  });

  it("VENDOR_ADMIN は担当外の施設が選ばれていると施設の項目が出ない", () => {
    const ctx = ctxFor("VENDOR_ADMIN", ["o7k2m9__prop_other"]);
    const keys = buildNavigation(ctx, {
      selectedPropertyId: PROPERTY_ID,
      enabledModules: ALL_MODULES,
    }).flatMap((group) => group.items.map((entry) => entry.item.key));

    expect(keys).not.toContain("nav.dashboard");
  });

  it("表示できる施設が無ければ施設スコープの項目が出ない", () => {
    const keys = buildNavigation(ctxFor("PROPERTY_MANAGER"), {
      selectedPropertyId: null,
      enabledModules: ALL_MODULES,
    }).flatMap((group) => group.items.map((entry) => entry.item.key));

    expect(keys).not.toContain("nav.dashboard");
  });

  it("OWNER には全項目が出る", () => {
    expect(keysFor("OWNER")).toHaveLength(NAV_ITEMS.length);
  });
});

describe("契約によるグレー表示", () => {
  it("契約していないモジュールの項目は locked になる（消えない）", () => {
    const groups = buildNavigation(ctxFor("OWNER"), {
      selectedPropertyId: PROPERTY_ID,
      // AUDIT を外す。差異レポートは「買えば使える」ので存在は見せる。
      enabledModules: MODULE_CODES.filter((code) => code !== "AUDIT"),
    });
    const entries = groups.flatMap((group) => group.items);

    const findings = entries.find((entry) => entry.item.key === "nav.findings");
    expect(findings).toBeDefined();
    expect(findings?.locked).toBe(true);

    const dashboard = entries.find((entry) => entry.item.key === "nav.dashboard");
    expect(dashboard?.locked).toBe(false);
  });

  it("契約が 1 つも無ければ全項目が locked", () => {
    const entries = buildNavigation(ctxFor("OWNER"), {
      selectedPropertyId: PROPERTY_ID,
      enabledModules: [],
    }).flatMap((group) => group.items);

    expect(entries).not.toHaveLength(0);
    expect(entries.every((entry) => entry.locked)).toBe(true);
  });

  it("権限が無い項目は、契約があっても現れない", () => {
    // 判定の順序（権限 → 契約）。逆にすると 402 が資源の存在を示唆する。
    const entries = buildNavigation(ctxFor("CLEANER"), {
      selectedPropertyId: PROPERTY_ID,
      enabledModules: ALL_MODULES,
    }).flatMap((group) => group.items);

    expect(entries.map((entry) => entry.item.key)).not.toContain("nav.findings");
  });
});

describe("セクション", () => {
  it("プロトタイプの順序（日次運用 → 記録の確認 → 資材と分析 → 設定）を保つ", () => {
    const sections = buildNavigation(ctxFor("OWNER"), {
      selectedPropertyId: PROPERTY_ID,
      enabledModules: ALL_MODULES,
    }).map((group) => group.section);

    expect(sections).toEqual([...NAV_SECTIONS]);
  });

  it("項目が 1 つも残らないセクションは出さない", () => {
    // CLEANER からは「記録の確認」の差異 2 件が消えるが、清掃記録・検査は残る。
    // 設定は全件消えるのでセクションごと消える（書き込みの操作しか無い）。
    const sections = buildNavigation(ctxFor("CLEANER"), {
      selectedPropertyId: PROPERTY_ID,
      enabledModules: ALL_MODULES,
    }).map((group) => group.section);

    expect(sections).not.toContain("settings");
  });
});
