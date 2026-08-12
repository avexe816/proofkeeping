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

  it("26 テーブルを定義している", () => {
    expect(tenantTables().map(([name]) => name).sort()).toEqual([
      "auditLog",
      "building",
      // P1-01。チェックリストの定義と実施結果（PK-SPEC-P1 §2.1 / §6）。
      "checklistItem",
      "checklistTemplate",
      "cleaningTask",
      // P0-21。施設サマリーの唯一の出どころ（§19.6）。
      "dailyPropertyRollup",
      // P1-01。当日の客室状況（P1 は PMS 連携が無いため施設側が入力する）。
      "dailyRoomPlan",
      // P1-21。当日の施設訪問順（§19.5）。**未登録でも一覧は動く。**
      "dailyRoute",
      "documentSequence",
      // P0-22。**定義のみ。読み書きは P6**（§24.4）。
      "externalMapping",
      "floor",
      "membership",
      "moduleEntitlement",
      "organization",
      "organizationTaxProfile",
      // P0-08。直近 3 世代の再利用禁止のためだけの表。
      "passwordHistory",
      "property",
      "propertyAssignment",
      "room",
      "roomType",
      // P1-01 / P1-02。標準時間マスタ（客室タイプ × 清掃種別）。
      "standardTime",
      "subscription",
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

  it("role が security.md §1 の 7 ロールである", () => {
    expect(ROLES).toEqual([
      "OWNER",
      "ORG_ADMIN",
      "PROPERTY_MANAGER",
      "INSPECTOR",
      "CLEANER",
      "VENDOR_ADMIN",
      "AUDITOR",
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
