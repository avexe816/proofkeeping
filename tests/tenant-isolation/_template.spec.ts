/**
 * 越境テストの雛形と、カバー範囲のレジストリ。
 *
 * task:  docs/tasks/P0-13.md
 * ルール: .claude/rules/testing.md §2
 *
 * ── 表を 1 つ足すときの手順 ─────────────────────────────
 * ① `{table}.spec.ts` を作り、`describeTenantIsolation()` を 1 回呼ぶ
 *
 *     import { listTasks, findTaskById } from "@pk/db";
 *     import { describeTenantIsolation } from "./isolation-suite.js";
 *
 *     describeTenantIsolation({
 *       table: "task",
 *       list: (env, ctx) => listTasks(env, ctx, {}),
 *       findById: (env, ctx, id) => findTaskById(env, ctx, id),
 *       entityPrefix: "task",
 *       propertyColumn: "property_id",   // 施設の次元が無ければ null
 *     });
 *
 * ② 下の `UNCOVERED_TABLES` からその表の名前を消す
 *
 * **②を忘れても落ちない。**逆に、表を足したのに spec を書かないと
 * このファイルの「全テナント表がカバー済みか宣言されている」テストが落ちる。
 * 未カバーのまま進めたい場合は `UNCOVERED_TABLES` に理由付きで載せること。
 * 黙って抜ける経路を作らないのが目的で、リストに載せる行為そのものが
 * 「この表は越境テストがまだ無い」というレビュー可能な記録になる。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { shardIndexOf } from "@pk/db";
import { describe, expect, it } from "vitest";

import {
  OTHER_SHARD_ORG,
  PRODUCTION_SHARD_COUNT,
  SAME_SHARD_INDEX,
  SAME_SHARD_ORG_PAIR,
} from "../fixtures/shard-pairs.js";

/**
 * `packages/db/src/schema/index.ts` が公開するテナント表。
 *
 * 全局テーブル（`org_directory`）とメタ表（`schema_version`）は
 * テナント文脈から引けないので対象外（`getGlobalDb()` 経由のみ）。
 */
const TENANT_TABLES = [
  "audit_log",
  "building",
  "daily_property_rollup",
  "document_sequence",
  "floor",
  "membership",
  "module_entitlement",
  "organization",
  "organization_tax_profile",
  "password_history",
  "property",
  "property_assignment",
  "room",
  "room_type",
  "external_mapping",
  "subscription",
  "user",
  // P1-01。清掃タスクとその周辺（PK-SPEC-P1 §2.1）。
  "cleaning_task",
  "task_time_log",
  "task_photo",
  "standard_time",
  "daily_room_plan",
  "checklist_template",
  "checklist_item",
  "task_checklist_result",
  // P1-21。当日の施設訪問順（PK-SPEC-P1 §19.5）。
  "daily_route",
  // P2-01。検査・差戻し・証跡（PK-SPEC-P2 §2.1・§3.2〜§3.4・§3.7）。
  "property_inspection_policy",
  "inspection",
  "inspection_item_result",
  "inspection_photo",
  "rework_cycle",
  "evidence_snapshot",
  // P2-11 / P2-12。忘れ物と設備不具合（同 §3.5・§3.6）。
  "lost_item",
  "lost_item_photo",
  "lost_item_history",
  "issue_report",
  "issue_photo",
  "issue_history",
  // P2-14。日報（同 §9.4）。**発行済み帳票。**
  "daily_report",
  // P3-01。観察記録・リネン・ベースライン（PK-SPEC-P3 §2）。
  "room_observation",
  "observation_revision",
  "linen_record",
  "consumption_baseline",
  "observation_config",
  "baseline_exclusion_log",
  // P4-01。稼働照合（PK-SPEC-P4 §2）。
  "occupancy_snapshot",
  "physical_signal",
  "room_access_log",
  "reconciliation_run",
  "audit_finding",
  "detection_feedback",
  "rule_config",
  // P5-01。請求・領収（PK-SPEC-P5 §2）。**発行済み帳票は消せない**
  // （billing.md §2）。請求書が 1 通混ざれば他社の売上が自社の帳簿に載る。
  "counterparty",
  "pricing_rule",
  "invoice",
  "invoice_line",
  "invoice_tax_summary",
  "receipt",
  "document_delivery",
  "billing_period",
  // P5-12。双方合意の履歴（同 §6.2 MUST）。差戻しコメントは取引の交渉
  // そのもので、混ざれば他社の値引き交渉が自社の画面に出る。
  "billing_period_review",
  // P6-01。外部連携（PK-SPEC-P6 §2・§6）。**他組織の連携が 1 件混ざれば
  // 他社の稼働記録を自社の照合へ流し込むことになる**（§8.5 の「他組織の
  // integrationId で Webhook を投げると 404」）。
  "integration",
  "sync_log",
  "push_subscription",
  "notification_preference",
  "api_key",
  "outbound_webhook",
  // P7-08。年次アーカイブの記録（PK-SPEC-P0 §19.7）。**他組織の行が
  // 混ざると、他社の退避データを復元する経路になる。**
  "archive_manifest",
  "archive_restore",
  "archive_restore_row",
] as const;

/**
 * **越境テストがまだ無い表。** P0-13 は枠組みを作る task で、
 * 実体のあるリポジトリ関数が無い表は書けない。
 *
 * ここに載っている表は、**その表を読み書きする task が spec を足して
 * この行を消す。** 一覧が空になったら testing.md §2 の
 * 「全テーブルについて 4 パターン」が満たされる。
 */
const UNCOVERED_TABLES: Partial<Record<(typeof TENANT_TABLES)[number], string>> = {
  audit_log: "P0-11 は書き込みのみ。読み取り関数を作る task が足す",
  building: "リポジトリ関数がまだ無い（P0-22）",
  document_sequence: "採番は DocumentSequencer 経由（P0-17）。表を直接引かない",
  floor: "リポジトリ関数がまだ無い（P0-22）",
  membership: "認証ブートストラップ専用の 2 関数のみ（P0-07 の申し送り）",
  module_entitlement: "P0-12 は判定のみ。一覧を返す関数が無い",
  password_history: "認証内部でのみ使う。ID を取る一覧関数が無い（P0-08）",
  property_assignment: "認証ブートストラップ専用（P0-07 の申し送り）",
  subscription: "リポジトリ関数がまだ無い（P7-04）",
  user: "listUsers / findUserById はあるが、施設の次元を持たない。P0-14 以降で足す",
  // P2-01 は表と migration までの task。読み書きの関数はこの後の task が作る。
  // `inspection` / `inspection_item_result` / `inspection_photo` /
  // `rework_cycle` は P2-04 が関数を作り、inspection.spec.ts でカバーした。
  // `evidence_snapshot` は P2-08 が読み取り関数を足し、同じ spec でカバーした。
  //
  // P3-01 も表と migration までの task（P2-01 と同じ形）。読み書きの関数を
  // 作る task が spec を足してこの行を消す。**表だけ足して放置しないこと。**
  // `room_observation` / `observation_revision` / `linen_record` /
  // `observation_config` は P3-03〜P3-07 / P3-11 が関数を作り、
  // observation.spec.ts でカバーした。
  // `consumption_baseline` / `baseline_exclusion_log` は P3-09 / P3-10 /
  // P3-12 が関数を作り、baseline.spec.ts でカバーした。
  //
  // P4-01 も表と migration までの task（P2-01 / P3-01 と同じ形）。
  // `occupancy_snapshot` は P4-02 が取込の関数を作り、occupancy.spec.ts で
  // カバーした。`physical_signal` / `room_access_log` / `reconciliation_run` /
  // `audit_finding` / `detection_feedback` は P4-05 が照合バッチの読み取りを
  // 作り、reconciliation.spec.ts でカバーした。残る 1 表は下の task が
  // 関数を作って行を消すこと。**表だけ足して放置しないこと。**
  rule_config:
    "施設の次元が任意（`propertyId = null` が組織既定）で施設スコープの検査を" +
    "掛けられない。設定画面を作る P4-13 が形を決めて spec を足す",
  // P6-01 も表と migration までの task（P2-01 / P3-01 / P4-01 と同じ形）。
  // `integration` / `sync_log` / `external_mapping` は P6-04 が受信口の
  // 読み書きを作り、integration.spec.ts でカバーした。
  // `notification_preference` / `push_subscription` は P6-09 が配信の
  // 読み取りを作り、notification.spec.ts でカバーした（`push_subscription`
  // の**書き込み**は P6-10 だが、越境の検査は読み取りで足りる）。
  // `api_key` は P6-12 が発行・失効・認証を作り、apiKey.spec.ts でカバーした。
  // `outbound_webhook` は P6-13 が登録と配信を作り、
  // outboundWebhook.spec.ts でカバーした。**P6-01 が足した 7 表は全部埋まった。**
};

describe("同一シャードの組織ペア（fixtures/shard-pairs.ts）", () => {
  it("2 組織が同じシャードに落ちる", () => {
    // **これが崩れたら第 3 パターンは何も検査していない。**
    // 別シャードでは物理的に到達不能で、組織条件を消しても緑のままになる。
    const a = shardIndexOf(SAME_SHARD_ORG_PAIR.a.organizationId, PRODUCTION_SHARD_COUNT);
    const b = shardIndexOf(SAME_SHARD_ORG_PAIR.b.organizationId, PRODUCTION_SHARD_COUNT);
    expect(a).toBe(b);
  });

  it("落ちるシャードは注釈どおり", () => {
    expect(shardIndexOf(SAME_SHARD_ORG_PAIR.a.organizationId, PRODUCTION_SHARD_COUNT)).toBe(
      SAME_SHARD_INDEX,
    );
  });

  it("対照群は別のシャードに落ちる", () => {
    // 「同じシャード」に意味があることを言うには、そうでない例が要る。
    expect(shardIndexOf(OTHER_SHARD_ORG.organizationId, PRODUCTION_SHARD_COUNT)).not.toBe(
      SAME_SHARD_INDEX,
    );
  });

  it("2 組織は別の組織である", () => {
    expect(SAME_SHARD_ORG_PAIR.a.organizationId).not.toBe(SAME_SHARD_ORG_PAIR.b.organizationId);
    expect(SAME_SHARD_ORG_PAIR.a.orgShortId).not.toBe(SAME_SHARD_ORG_PAIR.b.orgShortId);
  });

  it("SHARD_COUNT=1 では同居が自明なので、ペアの意味は 16 本でのみ成り立つ", () => {
    // ローカル・preview は SHARD_COUNT=1（architecture.md §1）。
    // そこでは全組織が同居するため、このペアは何も追加で保証しない。
    expect(shardIndexOf(SAME_SHARD_ORG_PAIR.a.organizationId, 1)).toBe(0);
    expect(shardIndexOf(OTHER_SHARD_ORG.organizationId, 1)).toBe(0);
  });
});

describe("カバー範囲", () => {
  /**
   * spec が `describeTenantIsolation({ table: "..." })` で宣言した表。
   *
   * **ファイル名ではなく中身を見る。** 1 ファイルが複数の表を持つことがある
   * （`organization.spec.ts` は `organization` と `organization_tax_profile`）。
   */
  function coveredTables(): string[] {
    const directory = import.meta.dirname;
    const tables: string[] = [];
    for (const file of readdirSync(directory)) {
      if (!file.endsWith(".spec.ts") || file.startsWith("_")) continue;
      const code = readFileSync(join(directory, file), "utf8");
      for (const matched of code.matchAll(/^\s*table:\s*"([a-z_]+)"/gm)) {
        const table = matched[1];
        if (table !== undefined) tables.push(table);
      }
    }
    return tables;
  }

  it("全テナント表がカバー済みか、未カバーとして理由付きで宣言されている", () => {
    // 表を足したのに spec も宣言も無い、という状態を作らせない。
    const covered = new Set(coveredTables());
    const undeclared = TENANT_TABLES.filter(
      (table) => !covered.has(table) && UNCOVERED_TABLES[table] === undefined,
    );
    expect(undeclared).toEqual([]);
  });

  it("UNCOVERED_TABLES に実在しない表が残っていない", () => {
    const known = new Set<string>(TENANT_TABLES);
    expect(Object.keys(UNCOVERED_TABLES).filter((table) => !known.has(table))).toEqual([]);
  });

  it("カバー済みの表が未カバー宣言に二重登録されていない", () => {
    // spec を書いたら UNCOVERED_TABLES から消すこと。
    const covered = coveredTables();
    expect(covered.filter((table) => table in UNCOVERED_TABLES)).toEqual([]);
  });

  it("spec が宣言する表はすべて TENANT_TABLES に載っている", () => {
    // 綴り違い（`rooms` / `room`）で「カバーしたつもり」を作らせない。
    const known = new Set<string>(TENANT_TABLES);
    expect(coveredTables().filter((table) => !known.has(table))).toEqual([]);
  });
});
