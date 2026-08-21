/**
 * プラットフォーム運営の分離を機械的に押さえる（PF-01 / DECISIONS #220）。
 *
 * ここが見るのは**集合が交わっていないこと**だけ。
 *
 *   1. 運営面のリポジトリが `getTenantDb()` を呼んでいない
 *   2. テナント面のリポジトリが `platform_*` を読んでいない
 *   3. `platform_audit_log` に UPDATE / DELETE が無い（INV-30 と同じ扱い）
 *
 * **どれか 1 つでも破れると #220 の前提が崩れる。** 運営画面はテナント横断で、
 * 交わりを許した瞬間に architecture.md §3（横断の集計を書かない）か
 * security.md §2（全シャード走査の禁止）のどちらかを破る経路ができる。
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { platformOperationSetting, platformTenantSnapshot } from "../schema/platform.js";
import { createFakeD1, createFakeEnv } from "../test-support/fake-d1.js";

import {
  PLATFORM_OPERATION_DEFAULTS,
  readPlatformOperationSettings,
  upsertTenantSnapshot,
} from "./platform.js";

/** コメントを落とした `platform.ts`（走査の誤検出を避ける）。 */
const SOURCE = (() => {
  const directory = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(directory, "platform.ts"), "utf8")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
    })
    .join("\n");
})();

/** コメントを落としたリポジトリの実装（走査の誤検出を避ける）。 */
function repositorySources(): { file: string; code: string }[] {
  const directory = dirname(fileURLToPath(import.meta.url));
  return readdirSync(directory)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
    .map((file) => ({
      file,
      code: readFileSync(join(directory, file), "utf8")
        .split("\n")
        .filter((line) => {
          const trimmed = line.trimStart();
          return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
        })
        .join("\n"),
    }));
}

describe("運営面とテナント面を交わらせない（DECISIONS #220）", () => {
  it("運営面のリポジトリが getTenantDb() を呼ばない", () => {
    const platform = repositorySources().filter(({ file }) => file === "platform.ts");
    expect(platform).toHaveLength(1);
    expect(platform.filter(({ code }) => /getTenantDb\s*\(/.test(code))).toEqual([]);
  });

  it("運営面のリポジトリが TenantContext を受け取らない", () => {
    // テナントの文脈を受け取ると、そこから組織 ID が入り込む。
    // 運営担当者はどの組織にも属さない（#220 の 3）。
    const platform = repositorySources().filter(({ file }) => file === "platform.ts");
    expect(platform.filter(({ code }) => /TenantContext/.test(code))).toEqual([]);
  });

  it("テナント面のリポジトリが platform_* を読まない", () => {
    const offenders = repositorySources().filter(
      ({ file, code }) =>
        file !== "platform.ts" &&
        (/platformOperator\b/.test(code) ||
          /platformAuditLog\b/.test(code) ||
          /getPlatformDb\s*\(/.test(code)),
    );
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });
});

describe("運営の操作記録は足すだけ（INV-30 と同じ扱い）", () => {
  it("platform_audit_log を UPDATE / DELETE するリポジトリ関数が無い", () => {
    const offenders = repositorySources().filter(
      ({ code }) =>
        /\.update\(\s*platformAuditLog/.test(code) || /\.delete\(\s*platformAuditLog/.test(code),
    );
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  it("platform_audit_log を対象にした SQL の update / delete が無い", () => {
    const offenders = repositorySources().filter(({ code }) =>
      /(update|delete\s+from)\s+["`']?platform_audit_log/i.test(code),
    );
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });
});

describe("テナントのスナップショット（PF-02）", () => {
  it("**個人を特定できる列を持たない**（INV-10 / 完了条件）", () => {
    const config = getTableConfig(platformTenantSnapshot);
    const names = config.columns.map((column) => column.name);
    for (const forbidden of [
      "display_name",
      "staff_number",
      "email",
      "phone",
      "device_id",
      "recorded_by_id",
      "user_id",
      "membership_id",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("シャード番号の列が無い（architecture.md §1 / 完了条件）", () => {
    for (const column of getTableConfig(platformTenantSnapshot).columns) {
      expect(column.name).not.toContain("shard");
    }
  });

  it("**`orgShortId` を持たない**（表示に使わない）", () => {
    const names = getTableConfig(platformTenantSnapshot).columns.map((column) => column.name);
    expect(names).not.toContain("org_short_id");
  });

  it("組織 × 業務日で一意（1 テナント 1 業務日 1 行）", () => {
    const config = getTableConfig(platformTenantSnapshot);
    const unique = config.indexes.filter((index) => index.config.unique);
    expect(unique.map((index) => index.config.name)).toContain("uq_platform_snapshot");
  });

  it("**割合の列を持たない**（件数から都度出す）", () => {
    const names = getTableConfig(platformTenantSnapshot).columns.map((column) => column.name);
    for (const derived of ["completeness_percent", "default_rate_percent", "needs_support"]) {
      expect(names).not.toContain(derived);
    }
  });

  it("再計算方式の UPSERT（同じ鍵に上書きする）", async () => {
    const fake = createFakeD1();
    const env = createFakeEnv(fake);
    await upsertTenantSnapshot(env, {
      organizationId: "abc123__org_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
      businessDate: "2026-08-19",
      name: "サンプル",
      plan: "PRO",
      subscriptionStatus: "ACTIVE",
      contractedOn: "2025-06-01",
      trialEndsOn: null,
      propertyCount: 2,
      roomCount: 40,
      billableRoomCount: 36,
      staffCount: 10,
      completedTasks: 40,
      observationsRecorded: 38,
      observationsSkipped: 2,
      observationsUsedDefaults: 10,
      inputDurationMedianMs: 12_000,
      findingsHigh: 3,
      photoCount: 240,
      localeCounts: { ja: 4, vi: 20 },
      now: new Date("2026-08-20T00:00:00.000Z"),
    });
    const insert = fake.queries.find((query) => query.sql.startsWith("insert into"));
    expect(insert?.sql).toContain('"platform_tenant_snapshot"');
    expect(insert?.sql).toContain("on conflict");
  });
});

describe("運用設定（PF-14 の「運用（変更可）」/ PF-02 が読む）", () => {
  it("**書き込みの関数が無い**（変更は申請と承認 2 名を通る）", () => {
    expect(SOURCE).not.toMatch(/\.update\(\s*platformOperationSetting/);
    expect(SOURCE).not.toMatch(/\.insert\(\s*platformOperationSetting/);
    expect(SOURCE).not.toMatch(/\.delete\(\s*platformOperationSetting/);
  });

  it("既定値は PF-14 の表どおり（10 秒 / 70% / 90 日 / 16 室 / 03:00〜04:00）", () => {
    expect(PLATFORM_OPERATION_DEFAULTS).toEqual({
      inputDurationFloorSeconds: 10,
      defaultRateThresholdPercent: 70,
      photoRetentionDays: 90,
      roomsPerStaffLimit: 16,
      maintenanceStartJst: "03:00",
      maintenanceEndJst: "04:00",
    });
  });

  it("行が無ければ既定値を返す（読み手が「未設定」を意識しない）", async () => {
    const fake = createFakeD1();
    const settings = await readPlatformOperationSettings(createFakeEnv(fake));
    expect(settings).toEqual(PLATFORM_OPERATION_DEFAULTS);
  });

  it("**PF-14 の 5 項目より多い列を持たない**（設定を勝手に増やさない）", () => {
    const names = getTableConfig(platformOperationSetting).columns.map((column) => column.name);
    // id / 5 項目（メンテナンス時間帯は開始と終了の 2 列）/ updated_at。
    expect(names).toEqual([
      "id",
      "input_duration_floor_seconds",
      "default_rate_threshold_percent",
      "photo_retention_days",
      "rooms_per_staff_limit",
      "maintenance_start_jst",
      "maintenance_end_jst",
      "updated_at",
    ]);
  });
});
