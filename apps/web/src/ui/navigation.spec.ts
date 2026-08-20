import { MODULE_CODES, type ModuleCode, type Role, type TenantContext } from "@pk/db";
import { describe, expect, it } from "vitest";

import { PERMISSION_ACTION_LIST } from "../lib/auth/permission.js";
import { ja } from "../locales/index.js";

import {
  NAV_GROUPS,
  NAV_ITEMS,
  NAV_SECTIONS,
  NAV_SECTION_LABEL,
  buildNavigation,
  groupNavItems,
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

const ALL_ROLES: readonly Role[] = [
  "OWNER",
  "ORG_ADMIN",
  "PROPERTY_MANAGER",
  "INSPECTOR",
  "CLEANER",
  "VENDOR_ADMIN",
  "AUDITOR",
];

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
      // ── 日次運用 ──
      "nav.dashboard",
      "nav.board",
      // W-05（P1-04 の未達分）。客室ボードの子（2026-08-20 の 2 段化）。
      "nav.plan",
      // 進捗モニタ（P7-19）。同じく客室ボードの子。
      "nav.progress",
      "nav.tasks",
      // ops 02 シフトと割当（P8-03）。「タスクとシフト」の子。
      "nav.shifts",
      // ── 記録の確認 ──
      // W-06 証跡一覧（P2-09）。
      "nav.cleaningRecords",
      // W-22 データ品質ダッシュボード（P3-12）。清掃記録の子へ移した
      // （2026-08-20。それまでは「資材と分析」の 1 つめ）。
      "nav.dataQuality",
      // 検査キュー（P7-18）。
      "nav.inspection",
      // W-09 忘れ物管理 / W-10 不具合管理（P7-22 / OQ #082 の残り半分）。
      "nav.lostItems",
      "nav.issues",
      // W-06 差異レポート一覧（P4-06）。差異の詳細と束ねるため
      // 「日次運用」から移した（2026-08-20）。
      "nav.findings",
      // W-07 差異の詳細への入口（2026-08-17）。稼働の差異の子。
      "nav.findingDetail",
      // ── 請求と分析 ──
      // 月次レポート（owner 09 / docs/PROTOTYPE_GAP.md 第2批 09）。
      "nav.report",
      // 「請求」の子 3 つ。請求確認（P5-19）は発注元にも出す。
      "nav.billingPeriods",
      // 契約と請求（owner 10 / 人間の指示 2026-08-17）。
      "nav.billing",
      // §7.2 清掃会社プラン（P5-15）。
      "nav.vendorPlan",
      // 支払集計（P5-18）。
      "nav.payouts",
      // ── 設定 ──
      // 「施設と客室」の子 3 つ。施設設定（owner 11 / OQ #103 の残り半分）、
      // 客室マスタ（P0-22）、W-25 客室タイプ管理（P1-24）。
      "nav.propertySettings",
      "nav.rooms",
      "nav.roomTypes",
      // 「業務ルール」の子 5 つ。
      "nav.checklists",
      "nav.standardTimes",
      // P3-11 が足した W-20（観察項目の設定）。
      "nav.observationSettings",
      // P4-13 が足した W-25（照合ルールの設定）。
      "nav.rules",
      // P3-10 が足した W-21（ベースライン確認・上書き）。
      "nav.baseline",
      // 「取引と料金」の子 3 つ。事業者税務（P0-16）、取引先（P5-02 /
      // P5-03）、支払単価（P5-18）。
      "nav.taxProfile",
      "nav.counterparties",
      "nav.payRules",
      // P8-01。ops 07 スタッフ管理（登録と台帳を 1 画面に持つ）。
      "nav.staff",
      // P8-10。ops 08 研修と資格。スタッフ管理の子。
      "nav.training",
      // W-12 権限と監査の権限側（メンバー管理 / 2026-08-19）。
      "nav.permission",
      // 監査ログの閲覧（P7-20）。権限と監査の子。
      "nav.auditLogs",
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
  it("プロトタイプの順序（日次運用 → 記録の確認 → 請求と分析 → 設定）を保つ", () => {
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
 * 2 段のナビ（人間の指示 2026-08-20「メニューが長い・多い。纏められないか」）。
 *
 * **束ねただけで、画面は 1 つも消していない。** ここで固定するのは
 * 「消えていないこと」と「束が痩せたら平らに戻ること」の 2 つ。
 */
describe("束（親 → 子）", () => {
  function groupsFor(role: Role, enabledModules: readonly ModuleCode[] = ALL_MODULES) {
    return buildNavigation(ctxFor(role), {
      selectedPropertyId: PROPERTY_ID,
      enabledModules,
    }).map((section) => ({ section: section.section, groups: groupNavItems(section.items) }));
  }

  it("束の構成員がすべて実在する項目キー", () => {
    const keys = new Set(NAV_ITEMS.map((item) => item.key));
    for (const def of NAV_GROUPS) {
      if (def.lead !== undefined) expect(keys, def.key).toContain(def.lead);
      for (const child of def.children) expect(keys, def.key).toContain(child);
    }
  });

  it("1 つの項目が 2 つの束に属さない", () => {
    const members = NAV_GROUPS.flatMap((def) => [
      ...(def.lead === undefined ? [] : [def.lead]),
      ...def.children,
    ]);
    expect(new Set(members).size).toBe(members.length);
  });

  it("束の構成員が同じセクションに属する", () => {
    const sectionOf = new Map(NAV_ITEMS.map((item) => [item.key, item.section]));
    for (const def of NAV_GROUPS) {
      const sections = new Set(
        [...(def.lead === undefined ? [] : [def.lead]), ...def.children].map((key) =>
          sectionOf.get(key),
        ),
      );
      expect(sections.size, def.key).toBe(1);
    }
  });

  it("見出しだけの親は文言とアイコンを持ち、ja に文言がある", () => {
    for (const def of NAV_GROUPS) {
      if (def.lead !== undefined) continue;
      expect(def.label, def.key).toBeDefined();
      expect(def.icon, def.key).toBeTruthy();
      expect(Object.keys(ja), def.key).toContain(def.label);
    }
  });

  /** 33 項目 37 行 → 16 親 20 行。**これが指示の中身。** */
  it("OWNER の常時表示が 4 見出し + 16 親になる", () => {
    const groups = groupsFor("OWNER");
    expect(groups.map((entry) => entry.groups.length)).toEqual([3, 5, 3, 5]);
  });

  it("親を開けば全項目へ到達できる（束ねて消えた画面が無い）", () => {
    for (const role of ["OWNER", "PROPERTY_MANAGER", "INSPECTOR", "CLEANER"] as const) {
      const flat = buildNavigation(ctxFor(role), {
        selectedPropertyId: PROPERTY_ID,
        enabledModules: ALL_MODULES,
      }).flatMap((section) => section.items.map((entry) => entry.item.key));
      const grouped = groupsFor(role).flatMap((section) =>
        section.groups.flatMap((group) => [
          ...(group.lead === null ? [] : [group.lead.item.key]),
          ...group.children.map((child) => child.item.key),
        ]),
      );
      expect([...grouped].sort(), role).toEqual([...flat].sort());
    }
  });

  /**
   * 権限・契約で構成員が減ると束ねる意味が無くなる。**▸ を押しても
   * 1 行しか出ない親を作らない。** 検査担当は記録の状況を持たないので、
   * 「清掃記録」は束ではなく平らな 1 行になる。
   */
  it("構成員が 1 つになった束は平らな 1 行に戻る", () => {
    const records = groupsFor("INSPECTOR").find((entry) => entry.section === "records");
    const evidence = records?.groups.find((group) => group.key === "nav.cleaningRecords");
    expect(evidence?.children).toEqual([]);
    expect(evidence?.lead?.item.key).toBe("nav.cleaningRecords");
  });

  it("子を持たない親は必ず到達先を持つ（押せない行を作らない）", () => {
    for (const role of ALL_ROLES) {
      for (const section of groupsFor(role)) {
        for (const group of section.groups) {
          if (group.children.length === 0) expect(group.lead, `${role}/${group.key}`).not.toBeNull();
        }
      }
    }
  });
});
