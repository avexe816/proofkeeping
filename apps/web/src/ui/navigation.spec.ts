import { MODULE_CODES, type ModuleCode, type Role, type TenantContext } from "@pk/db";
import { describe, expect, it } from "vitest";

import { PERMISSION_ACTION_LIST } from "../lib/auth/permission.js";
import { ja } from "../locales/index.js";

import {
  NAV_ITEMS,
  NAV_SECTIONS,
  NAV_SECTION_LABEL,
  SETTINGS_ACTIVE_PREFIXES,
  SETTINGS_CATEGORIES,
  SETTINGS_HUB_PATH,
  SETTINGS_ITEM_KEY,
  buildNavigation,
  buildSettingsHub,
  isActivePrefix,
} from "./navigation.js";

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

/** 設定ハブに出るカードのキー（サイドバーから移した 16 画面）。 */
function settingsKeysFor(role: Role, enabledModules: readonly ModuleCode[] = ALL_MODULES): string[] {
  return buildSettingsHub(ctxFor(role), { selectedPropertyId: PROPERTY_ID, enabledModules }).flatMap(
    (category) => category.items.map((entry) => entry.item.key),
  );
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
      if (item.action === undefined) continue;
      expect(PERMISSION_ACTION_LIST, item.key).toContain(item.action);
    }
  });

  /**
   * **`action` を省略してよいのは設定ハブへの入口だけ**（`NavItemBase` の
   * 注記）。省略が増えると、権限判定を通らない項目が黙って増える。
   */
  it("action を省略している項目は設定の入口だけ", () => {
    expect(NAV_ITEMS.filter((item) => item.action === undefined).map((item) => item.key)).toEqual([
      SETTINGS_ITEM_KEY,
    ]);
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
      // 進捗モニタ（P7-19）。「日次運用」で客室ボードの直後。
      "nav.progress",
      "nav.tasks",
      // W-05（P1-04 の未達分）。
      "nav.plan",
      // ops 02 シフトと割当（P8-03）。
      "nav.shifts",
      // W-06 差異レポート一覧（P4-06）。「日次運用」の最後。
      "nav.findings",
      // W-07 差異の詳細への入口（2026-08-17）。「記録の確認」の 1 つめ。
      "nav.findingDetail",
      // W-06 証跡一覧（P2-09）。
      "nav.cleaningRecords",
      // W-09 忘れ物管理 / W-10 不具合管理（P7-22 / OQ #082 の残り半分）。
      "nav.lostItems",
      "nav.issues",
      // 検査キュー（P7-18）。「記録の確認」の不具合管理の直後。
      "nav.inspection",
      // W-22 データ品質ダッシュボード（P3-12）。「資材と分析」の 1 つめ。
      "nav.dataQuality",
      // 月次レポート（owner 09 / docs/PROTOTYPE_GAP.md 第2批 09）。
      "nav.report",
      // 請求確認（P5-19）。発注元にも出す唯一の請求系項目。
      "nav.billingPeriods",
      // 契約と請求（owner 10 / 人間の指示 2026-08-17）。
      "nav.billing",
      // §7.2 清掃会社プラン（P5-15）。
      "nav.vendorPlan",
      // 支払集計（P5-18）。「資材と分析」の最後。
      "nav.payouts",
      // `/app/settings/*` の 4 画面。客室マスタ（P0-22）と事業者税務（P0-16）は
      // ルートが実在するのに**サイドバーに出ていなかった。**
      "nav.rooms",
      // W-25 客室タイプ管理（P1-24）。客室マスタの直後。
      "nav.roomTypes",
      "nav.checklists",
      "nav.standardTimes",
      // P3-11 が足した W-20（観察項目の設定）。
      "nav.observationSettings",
      // W-18 検査ポリシー（施設ごとの検査方式）。観察項目の設定の直後。
      "nav.inspectionSettings",
      // P4-13 が足した W-25（照合ルールの設定）。
      "nav.rules",
      // P3-10 が足した W-21（ベースライン確認・上書き）。
      "nav.baseline",
      "nav.taxProfile",
      // 取引先と料金（P5-02 / P5-03）。事業者・税務設定の直後。
      "nav.counterparties",
      // 支払単価（P5-18）。取引先の直後。
      "nav.payRules",
      // 監査ログの閲覧（P7-20）。取引先の直後。
      "nav.auditLogs",
      // 施設設定（owner 11 / OPEN_QUESTIONS #103 の残り半分）。
      "nav.propertySettings",
      // P8-01。ops 07 スタッフ管理（登録と台帳を 1 画面に持つ）。
      "nav.staff",
      // P8-10。ops 08 研修と資格。
      "nav.training",
      // W-12 権限と監査の権限側（メンバー管理 / 2026-08-19）。
      "nav.permission",
      // W-13 連携設定（P6-01）。**サイドバーには元から出ていなかった。**
      // ハブができたので、ここから到達する（人間の指示 2026-08-20）。
      "nav.integrations",
      // 設定ハブへの入口（人間の指示 2026-08-20）。設定セクションで
      // **サイドバーに出る唯一の項目。**
      "nav.settings",
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

  // P7-18。**`inspection.read` が `DENY` のロールには項目ごと出さない。**
  // グレー（未契約）にしない。グレーは「契約すれば見られる」の意味になる。
  it("CLEANER に検査キューを出さない", () => {
    expect(keysFor("CLEANER")).not.toContain("nav.inspection");
  });

  it("VENDOR_ADMIN に検査キューを出さない（自社の清掃を自社が検査しない）", () => {
    expect(keysFor("VENDOR_ADMIN")).not.toContain("nav.inspection");
  });

  it("INSPECTOR に検査キューを出す", () => {
    expect(keysFor("INSPECTOR")).toContain("nav.inspection");
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
    // P8-01。スタッフ管理も `user.write` の門（登録の口が同じ画面にある）。
    expect(keys).not.toContain("nav.staff");
    // P8-03。シフトも書き込みの画面（shift.manage）。
    expect(keys).not.toContain("nav.shifts");
    // P8-10。研修と資格も記録の口を持つ（user.write）。
    expect(keys).not.toContain("nav.training");
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

  // 設定はサイドバーに並ばなくなった（人間の指示 2026-08-20 / 案 2）。
  // **境界そのものは変えていない**ので、ハブの中身で同じことを見る。
  it("PROPERTY_MANAGER に組織単位の設定 2 画面を出さない（§10.1 は ORG_ADMIN）", () => {
    const keys = settingsKeysFor("PROPERTY_MANAGER");
    expect(keys).not.toContain("nav.checklists");
    expect(keys).not.toContain("nav.standardTimes");
  });

  it("ORG_ADMIN に設定の 4 画面すべてを出す", () => {
    const keys = settingsKeysFor("ORG_ADMIN");
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

  it("OWNER にはサイドバーの全項目が出る", () => {
    // 設定はハブへ移したので、サイドバーに並ぶのは
    // `placement: "SETTINGS"` 以外（＝入口の「設定」を含む）。
    const sidebarItems = NAV_ITEMS.filter((item) => item.placement !== "SETTINGS");
    expect(keysFor("OWNER")).toHaveLength(sidebarItems.length);
  });

  it("CLIENT_VIEWER（発注元）は閲覧の 9 項目だけ（契約 §4 / P5-16 / P5-19）", () => {
    // 担当施設の記録・検査・差異・レポートの閲覧と、請求確認（承認・差戻し）。
    // 設定・請求運営・監査ログ（操作履歴 ×）・清掃会社プラン（収支）は出ない。
    expect(keysFor("CLIENT_VIEWER").sort()).toEqual(
      [
        "nav.dashboard",
        "nav.board",
        "nav.progress",
        "nav.findings",
        "nav.findingDetail",
        "nav.cleaningRecords",
        "nav.inspection",
        "nav.report",
        // P5-19。billing.read は発注元に配られている（自分の取引先に絞られる）。
        "nav.billingPeriods",
      ].sort(),
    );
  });

  it("CLIENT_VIEWER に監査ログ・契約と請求・清掃会社プランを出さない", () => {
    const keys = keysFor("CLIENT_VIEWER");
    expect(keys).not.toContain("nav.auditLogs");
    expect(keys).not.toContain("nav.billing");
    expect(keys).not.toContain("nav.vendorPlan");
    expect(keys).not.toContain("nav.counterparties");
    expect(keys).not.toContain("nav.permission");
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
    // **設定の入口だけは灰色にしない。** 入口の先はハブで、契約の話は
    // カード 1 枚ずつに付く（グレー＋案内）。入口を灰色にすると、
    // 契約に関係の無い設定（施設・権限）まで閉じているように見える。
    const gated = entries.filter((entry) => entry.item.key !== SETTINGS_ITEM_KEY);
    expect(gated.every((entry) => entry.locked)).toBe(true);
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

/**
 * 設定ハブ（人間の指示 2026-08-20 / 案 2）。
 *
 * 守るのは 3 つ。**入口が 1 つだけであること**、**開ける設定が
 * 1 つも無い相手に入口を出さないこと**、**ハブとサイドバーの
 * 見え方がずれないこと**。
 */
describe("設定ハブ", () => {
  function hubFor(role: Role, enabledModules: readonly ModuleCode[] = ALL_MODULES) {
    return buildSettingsHub(ctxFor(role), {
      selectedPropertyId: PROPERTY_ID,
      enabledModules,
    });
  }

  function hubKeys(role: Role, enabledModules: readonly ModuleCode[] = ALL_MODULES): string[] {
    return hubFor(role, enabledModules).flatMap((category) =>
      category.items.map((entry) => entry.item.key),
    );
  }

  it("設定セクションでサイドバーに出るのは「設定」1 項目だけ", () => {
    const settings = buildNavigation(ctxFor("OWNER"), {
      selectedPropertyId: PROPERTY_ID,
      enabledModules: ALL_MODULES,
    }).find((group) => group.section === "settings");

    expect(settings?.items.map((entry) => entry.item.key)).toEqual([SETTINGS_ITEM_KEY]);
    expect(settings?.items[0]?.href).toBe(SETTINGS_HUB_PATH);
  });

  it("区分の項目キーがすべて実在し、重複しない", () => {
    const known = new Set(NAV_ITEMS.map((item) => item.key));
    const listed = SETTINGS_CATEGORIES.flatMap((category) => category.items);
    for (const key of listed) expect(known, key).toContain(key);
    expect(new Set(listed).size).toBe(listed.length);
  });

  /** ハブに載せ忘れた設定画面を作らない。**片方だけ増えるのを止める。** */
  it("placement: SETTINGS の項目がすべてどこかの区分に載っている", () => {
    const listed = new Set(SETTINGS_CATEGORIES.flatMap((category) => category.items));
    for (const item of NAV_ITEMS) {
      if (item.placement !== "SETTINGS") continue;
      expect(listed, item.key).toContain(item.key);
    }
  });

  it("カードには必ず 1 行の説明が付く", () => {
    for (const item of NAV_ITEMS) {
      if (item.placement !== "SETTINGS") continue;
      expect(item.note, item.key).toBeDefined();
      expect(Object.keys(ja), item.key).toContain(item.note);
    }
  });

  it("区分の見出しが ja に存在する", () => {
    for (const category of SETTINGS_CATEGORIES) {
      expect(Object.keys(ja), category.key).toContain(category.label);
    }
  });

  it("OWNER は 17 枚すべてを開ける", () => {
    // W-18 検査ポリシーを足して 16 → 17。
    expect(hubKeys("OWNER")).toHaveLength(17);
  });

  /**
   * **権限の無いカードは出さない**（security.md §1）。ここでの非表示は
   * UX 上の措置で、各設定画面の `assertPermission()` は別に効いている。
   */
  it("CLEANER / INSPECTOR には 1 枚も出さない（入口ごと消える）", () => {
    for (const role of ["CLEANER", "INSPECTOR"] as const) {
      expect(hubFor(role), role).toEqual([]);
      const sections = buildNavigation(ctxFor(role), {
        selectedPropertyId: PROPERTY_ID,
        enabledModules: ALL_MODULES,
      });
      expect(
        sections.flatMap((group) => group.items.map((entry) => entry.item.key)),
        role,
      ).not.toContain(SETTINGS_ITEM_KEY);
    }
  });

  it("PROPERTY_MANAGER には施設まわりだけが出る（取引・権限は出ない）", () => {
    const keys = hubKeys("PROPERTY_MANAGER");
    expect(keys).toContain("nav.propertySettings");
    expect(keys).not.toContain("nav.taxProfile");
    expect(keys).not.toContain("nav.permission");
  });

  it("AUDITOR は書き込みの設定を開けない", () => {
    const keys = hubKeys("AUDITOR");
    expect(keys).not.toContain("nav.staff");
    expect(keys).not.toContain("nav.permission");
  });

  it("1 枚も無い区分は落ちる（空の見出しを出さない）", () => {
    for (const category of hubFor("PROPERTY_MANAGER")) {
      expect(category.items.length, category.key).toBeGreaterThan(0);
    }
  });

  it("未契約のカードは残るがグレーになる（402 の世界）", () => {
    const hub = hubFor("OWNER", []);
    const entries = hub.flatMap((category) => category.items);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.locked)).toBe(true);
  });

  /** 配下の設定画面を開いている間もサイドバーの「設定」を選択状態にする。 */
  it("設定の選択状態は配下の URL でも続く", () => {
    for (const pathname of [
      "/app/settings",
      "/app/settings/rooms",
      "/app/settings/integrations/int_1/mappings",
      "/app/training",
      "/app/audit/logs",
    ]) {
      expect(isActivePrefix(SETTINGS_ACTIVE_PREFIXES, pathname), pathname).toBe(true);
    }
  });

  it("設定と無関係の URL では選択状態にしない", () => {
    for (const pathname of ["/app/dashboard", "/app/audit/findings", "/app/shifts"]) {
      expect(isActivePrefix(SETTINGS_ACTIVE_PREFIXES, pathname), pathname).toBe(false);
    }
  });
});
