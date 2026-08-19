import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { ENTITY_PREFIXES } from "../id.js";
import { orgDirectory } from "./global.js";
import * as tenantSchema from "./index.js";
import { schemaVersion } from "./meta.js";
import { ROOM_SOURCE_TYPES, room } from "./property.js";
import { ROLES } from "./user.js";

/**
 * P0-06 のスキーマが不変条件を満たすことを機械的に押さえる。
 *
 * 越境そのもののテストは tests/tenant-isolation/（P0-13）が
 * リポジトリ層（P0-07）の上で行う。ここは列の形だけを見る。
 */

/** `getTableConfig()` に渡せる Drizzle のテーブルだけを拾う。 */
function tenantTables(): Array<[string, ReturnType<typeof getTableConfig>]> {
  return Object.entries(tenantSchema)
    .filter(([, value]) => typeof value === "object" && !Array.isArray(value))
    .map(([name, table]) => [
      name,
      getTableConfig(table as Parameters<typeof getTableConfig>[0]),
    ]);
}

describe("P0-06 スキーマ", () => {
  it("テナントスコープの全テーブルに organization_id がある", () => {
    // PK-SPEC-P0 §19.5: 物理的にシャード分離されていても省略しない。
    // 将来の再シャーディングと移行の唯一の手がかりになる。
    for (const [name, config] of tenantTables()) {
      const column = config.columns.find((c) => c.name === "organization_id");

      expect(column, name).toBeDefined();
      expect(column?.notNull, name).toBe(true);
    }
  });

  it("テナントスコープの全テーブルの主キーが text の id 単独である", () => {
    // ID は `{orgShortId}__{entityPrefix}_{ulid}`（§19.4 第2層）。
    // 複合主キーにすると assertIdBelongsToTenant() が使えなくなる。
    for (const [name, config] of tenantTables()) {
      const primaryKeys = config.columns.filter((c) => c.primary);

      expect(primaryKeys.map((c) => c.name), name).toEqual(["id"]);
      expect(primaryKeys[0]?.getSQLType(), name).toBe("text");
    }
  });

  it("テナントスコープの全 index が organization_id から始まる", () => {
    // 先頭が organization_id でない index は、他組織の行を跨いで走査する
    // クエリを引き寄せる。テナント分離は index の設計にも現れる。
    //
    // 唯一の例外が組織の orgShortId。**組織を跨いで一意でなければならない**
    // 値なので、organization_id で絞れてはいけない（DECISIONS #014）。
    const CROSS_TENANT_BY_DESIGN = ["uq_organization_short_id"];

    for (const [name, config] of tenantTables()) {
      for (const index of config.indexes) {
        if (CROSS_TENANT_BY_DESIGN.includes(index.config.name)) continue;
        // 式で作った index は名前を持たない。P0-06 では 1 つも使っていない。
        const columns = index.config.columns.map((c) => ("name" in c ? c.name : "<expression>"));

        expect(columns[0], `${name}.${index.config.name}`).toBe("organization_id");
      }
    }
  });

  it("75 テーブルを定義している", () => {
    expect(tenantTables().map(([name]) => name).sort()).toEqual([
      // P6-01。公開 API のキー（PK-SPEC-P6 §6.1）。**平文のキーを保存しない。**
      "apiKey",
      // P7-08。年次アーカイブの記録（PK-SPEC-P0 §19.7）。
      // **「削除」ではなく「退避」。** R2 に写しがあることを記録する表。
      "archiveManifest",
      // P7-09。退避データの復元（PK-SPEC-P7 §9）。**退避そのものは触らない。**
      // 期限で消えるのは復元した写しで、R2 と `archiveManifest` は残る。
      "archiveRestore",
      "archiveRestoreRow",
      // P4-01。差異（PK-SPEC-P4 §2.5）。**不正の認定ではない**（同 §1.1）。
      "auditFinding",
      "auditLog",
      // P3-01。ベースライン集計から除外した観察の記録（PK-SPEC-P3 §5.3）。
      "baselineExclusionLog",
      // P5-01。月次締め（PK-SPEC-P5 §2.8）。**同意していなくても請求はできる**（同 §6.1）。
      "billingPeriod",
      // P5-12。双方合意の履歴（同 §6.2 MUST）。**追記だけ**（docs/DECISIONS.md #127）。
      "billingPeriodReview",
      "building",
      // P1-01。チェックリストの定義と実施結果（PK-SPEC-P1 §2.1 / §6）。
      "checklistItem",
      "checklistTemplate",
      "cleaningTask",
      // P3-01。消耗ベースライン（同 §2.4）。**sampleSize < 20 は isReliable = false。**
      "consumptionBaseline",
      // P5-01。取引先（同 §2.1）。**物理削除しない**（過去の請求書が参照する）。
      "counterparty",
      // P0-21。施設サマリーの唯一の出どころ（§19.6）。
      "dailyPropertyRollup",
      // P2-14。日報（PK-SPEC-P2 §9.4）。**発行済み帳票。UPDATE / DELETE しない。**
      "dailyReport",
      // P1-01。当日の客室状況（P1 は PMS 連携が無いため施設側が入力する）。
      "dailyRoomPlan",
      // P1-21。当日の施設訪問順（§19.5）。**未登録でも一覧は動く。**
      "dailyRoute",
      // P4-01。誤検知の学習（PK-SPEC-P4 §2.6）。**追記のみ。**
      "detectionFeedback",
      // P5-01。送付ログ（同 §2.7）。**追記のみ。** 誰にいつ送ったかは電子取引の記録。
      "documentDelivery",
      "documentSequence",
      // P2-01。証跡スナップショット（PK-SPEC-P2 §3.7）。**INSERT のみ。**
      "evidenceSnapshot",
      // P0-22 が定義し、P6-01 が P6 の語彙に揃えた（PK-SPEC-P6 §2.3）。
      "externalMapping",
      "floor",
      // P2-01。検査 1 回ぶんと、その項目別結果・写真（同 §3.2・§3.3）。
      "inspection",
      "inspectionItemResult",
      "inspectionPhoto",
      // P6-01。外部連携 1 接続ぶんの設定（PK-SPEC-P6 §2.1）。
      // **`config` に資格情報を入れない**（security.md §7）。
      "integration",
      // P5-01。請求書と明細（同 §2.3〜§2.5）。**発行したら消せない**（billing.md §2）。
      // 訂正は赤伝＋再発行。税額は税率ごとに 1 回だけ端数処理する（§2.5 MUST）。
      "invoice",
      "invoiceLine",
      "invoiceTaxSummary",
      // P2-12。設備不具合とその写真・状態履歴（同 §3.6）。
      "issueHistory",
      "issuePhoto",
      "issueReport",
      // P3-01。リネンの枚数（同 §2.3）。**枚数であって金額ではない。**
      "linenRecord",
      // P2-11。忘れ物とその写真・状態履歴（同 §3.5）。
      "lostItem",
      "lostItemHistory",
      "lostItemPhoto",
      "membership",
      "moduleEntitlement",
      // P6-01。利用者ごとの通知設定（PK-SPEC-P6 §2.5）。**行が無い = 既定のまま。**
      "notificationPreference",
      // P3-01。施設ごとの観察設定と、観察記録の事後修正履歴（同 §2.6 / §2.2）。
      "observationConfig",
      "observationRevision",
      // P4-01。稼働記録（PK-SPEC-P4 §2.1）。**宿泊者の氏名・連絡先を持たない。**
      "occupancySnapshot",
      "organization",
      "organizationTaxProfile",
      // P6-01。送信 Webhook の宛先（PK-SPEC-P6 §6.4）。署名鍵は KV（`secretRef`）。
      "outboundWebhook",
      // P0-08。直近 3 世代の再利用禁止のためだけの表。
      "passwordHistory",
      // P5-18。支払単価（docs/PK-SPEC-PAY.md §1.2）。**請求単価と混ぜない。**
      "payRule",
      // P5-18。支払明細と支払期間（同 §1.3・§1.4）。CONFIRMED は動かない。
      "payoutLine",
      "payoutPeriod",
      // P4-01。物理の痕跡（PK-SPEC-P4 §2.2）。**外部機器からの受信のみ。**
      "physicalSignal",
      // P5-01。料金設定（同 §2.2）。**値上げは行の追加**（既存行を書き換えない）。
      "pricingRule",
      "property",
      "propertyAssignment",
      // P2-01。施設ごとの検査方式（同 §2.1）。
      "propertyInspectionPolicy",
      // P6-01。Web Push の購読（PK-SPEC-P6 §2.4）。**空でも業務は成立する。**
      "pushSubscription",
      // P5-01。領収書（同 §2.6）。**印紙貼付欄を持たない**（billing.md §3）。
      "receipt",
      // P4-01。照合の実行記録（PK-SPEC-P4 §2.4）。
      "reconciliationRun",
      // P2-01。差戻しサイクル（同 §3.4）。
      "reworkCycle",
      "room",
      // P4-01。正当な入室の記録（PK-SPEC-P4 §2.3）。**誤検知を減らすための表。**
      "roomAccessLog",
      // P3-01。入室時の観察記録（同 §2.1）。**1 タスク 1 行。**
      "roomObservation",
      "roomType",
      // P4-01。ルールの施設別設定（PK-SPEC-P4 §2.7）。
      "ruleConfig",
      // P5-18。スタッフの支払属性（同 §1.1）。**個人情報の列は無い。**
      "staffPayProfile",
      // P1-01 / P1-02。標準時間マスタ（客室タイプ × 清掃種別）。
      "standardTime",
      "subscription",
      // P6-01。1 回ぶんの同期の記録（PK-SPEC-P6 §2.2）。**失敗も 1 行として残す。**
      "syncLog",
      // P1-01。実施結果・写真・作業時間ログ。
      "taskChecklistResult",
      "taskPhoto",
      "taskTimeLog",
      "user",
    ]);
  });

  it("全テーブルの entityPrefix が ENTITY_PREFIXES に登録されている", () => {
    // ID は永続データなので、接頭辞の登録漏れは後から直せない。
    const required = [
      "org",
      "tax",
      "seq",
      "usr",
      "mem",
      "asgn",
      "prop",
      "bldg",
      "flr",
      "rtyp",
      "room",
      "sub",
      "ent",
      "audit",
      // P0-08
      "pwh",
      // P1-01（docs/DECISIONS.md #032）。`task` は P0-05 で登録済み。
      "tlog",
      "ctpl",
      "citm",
      "cres",
      "photo",
      "stdt",
      "plan",
      // P2-01（docs/DECISIONS.md #059）。`insp` / `evd` は P0-05 で登録済み。
      "ipol",
      "ires",
      "ipho",
      "rwk",
    ];

    for (const prefix of required) {
      expect(ENTITY_PREFIXES, prefix).toContain(prefix);
    }
  });

  it("room が PK-SPEC-P0 §24.3 の 3 カラムを持つ", () => {
    const config = getTableConfig(room);
    const byName = new Map(config.columns.map((c) => [c.name, c]));

    // 清掃専用の部屋（パントリー等）。既定は true。
    expect(byName.get("is_sellable")?.notNull).toBe(true);
    expect(byName.get("is_sellable")?.default).toBe(true);
    // PMS からの取得で既存を自動上書きしないため、登録経路を持つ。
    expect(byName.get("source_type")?.default).toBe("MANUAL");
    expect(ROOM_SOURCE_TYPES).toEqual(["MANUAL", "PMS_SYNC", "CSV"]);
    // 方式B（P6）用。P0 では書き込まない。
    expect(byName.get("external_room_id")?.notNull).toBe(false);
  });

  it("role が security.md §1 の 7 ロール＋発注元（P5-16）である", () => {
    expect(ROLES).toEqual([
      "OWNER",
      "ORG_ADMIN",
      "PROPERTY_MANAGER",
      "INSPECTOR",
      "CLEANER",
      "VENDOR_ADMIN",
      "AUDITOR",
      // 発注元閲覧（契約 §2.10.1 の写像表 / OPEN_QUESTIONS #011 の決着）。
      "CLIENT_VIEWER",
    ]);
  });

  it("全局テーブルとメタテーブルがテナントスキーマに含まれない", () => {
    // ここに載せた表は getTenantDb() 経由で引ける。テナント文脈から
    // 全局テーブルを引けると、テナント横断のクエリが型の上で自然に書けてしまう。
    const names = tenantTables().map(([name]) => name);

    expect(names).not.toContain("orgDirectory");
    expect(names).not.toContain("schemaVersion");
  });

  it("org_directory が業務データを持たない", () => {
    // 採番済みの 6 桁と、それが指す組織 ID だけ。ここに業務データを足すと
    // 「テナント横断の集計を書かない」（architecture.md §3）が崩れる。
    const config = getTableConfig(orgDirectory);

    expect(config.columns.map((c) => c.name).sort()).toEqual([
      "created_at",
      "org_short_id",
      "organization_id",
    ]);
    expect(config.columns.find((c) => c.name === "org_short_id")?.primary).toBe(true);
  });

  it("schema_version が migrate.ts の DDL と同じ列を持つ", () => {
    const config = getTableConfig(schemaVersion);

    expect(config.columns.map((c) => c.name)).toEqual(["tag", "checksum", "applied_at"]);
  });
});
