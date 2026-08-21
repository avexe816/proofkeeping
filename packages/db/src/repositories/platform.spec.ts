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

import {
  platformOperationSetting,
  platformRecoveryCode,
  platformTenantSnapshot,
} from "../schema/platform.js";
import { createFakeD1, createFakeEnv } from "../test-support/fake-d1.js";

import {
  confirmPlatformTwoFactor,
  consumePlatformRecoveryCode,
  consumePlatformTotpStep,
  recordPlatformTwoFactorAttempt,
  replacePlatformRecoveryCodes,
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
          /platformRecoveryCode\b/.test(code) ||
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

describe("復旧コード（PF-17）", () => {
  const NOW = new Date("2026-08-21T09:00:00.000Z");

  it("**平文の列が無い**（ハッシュだけ / 完了条件の走査）", () => {
    const names = getTableConfig(platformRecoveryCode).columns.map((column) => column.name);
    expect(names).toEqual([
      "id",
      "operator_id",
      "code_hash",
      "created_at",
      "used_at",
      "revoked_at",
    ]);
    // 「code」そのものを持つ列名が紛れ込んでいないこと。
    expect(names).not.toContain("code");
    expect(names).not.toContain("code_plain");
  });

  it("消費は `used_at is null` を条件に含む UPDATE（1 本 1 回）", async () => {
    const fake = createFakeD1();
    const consumed = await consumePlatformRecoveryCode(createFakeEnv(fake), {
      id: "plat_rc_x",
      operatorId: "plat_op_x",
      now: NOW,
    });
    expect(consumed).toBe(true);
    const update = fake.queries.find((query) => query.sql.startsWith("update"));
    expect(update?.sql).toContain('"platform_recovery_code"');
    expect(update?.sql).toContain('"used_at" is null');
    expect(update?.sql).toContain('"revoked_at" is null');
  });

  it("既に使われていた（changes = 0）なら false（同時消費は片方だけ通る）", async () => {
    const fake = createFakeD1();
    fake.enqueueChanges(0);
    const consumed = await consumePlatformRecoveryCode(createFakeEnv(fake), {
      id: "plat_rc_x",
      operatorId: "plat_op_x",
      now: NOW,
    });
    expect(consumed).toBe(false);
  });

  it("入れ替えは**失効（revoked_at）で行い、行を消さない**", async () => {
    const fake = createFakeD1();
    await replacePlatformRecoveryCodes(createFakeEnv(fake), {
      operatorId: "plat_op_x",
      codes: [{ id: "plat_rc_a", codeHash: "a".repeat(64) }],
      now: NOW,
    });
    expect(fake.queries.some((query) => query.sql.startsWith("delete"))).toBe(false);
    const revoke = fake.queries.find((query) => query.sql.startsWith("update"));
    expect(revoke?.sql).toContain('"revoked_at"');
  });

  it("platform_recovery_code を DELETE するリポジトリ関数が無い（走査）", () => {
    expect(SOURCE).not.toMatch(/\.delete\(\s*platformRecoveryCode/);
  });
});

describe("第 2 要素の試行記録（PF-17）", () => {
  const NOW = new Date("2026-08-21T09:00:00.000Z");

  it("失敗の加算は SQL 側で行う（同時試行を取りこぼさない）", async () => {
    const fake = createFakeD1();
    await recordPlatformTwoFactorAttempt(createFakeEnv(fake), {
      operatorId: "plat_op_x",
      success: false,
      now: NOW,
      maxAttempts: 5,
      lockMs: 15 * 60 * 1000,
    });
    const update = fake.queries.find((query) => query.sql.startsWith("update"));
    expect(update?.sql).toContain('"two_factor_failed_attempts" + 1');
    // 上限に達した試行でだけロックする（CASE 式）。
    expect(update?.sql).toContain("CASE WHEN");
  });

  it("成功は失敗回数とロックを消す（ステップはここでは書かない）", async () => {
    const fake = createFakeD1();
    await recordPlatformTwoFactorAttempt(createFakeEnv(fake), {
      operatorId: "plat_op_x",
      success: true,
      now: NOW,
      maxAttempts: 5,
      lockMs: 15 * 60 * 1000,
    });
    const update = fake.queries.find((query) => query.sql.startsWith("update"));
    expect(update?.sql).toContain('"two_factor_failed_attempts"');
    // タイムステップの消費は consumePlatformTotpStep() / confirm の担当。
    expect(update?.sql).not.toContain('"two_factor_last_step"');
  });
});

describe("TOTP ステップの原子的な消費（PF-17 / 再利用の拒否）", () => {
  const NOW = new Date("2026-08-21T09:00:00.000Z");

  it("**条件付き UPDATE で消費する**（IS NULL / 未満のときだけ書ける）", async () => {
    const fake = createFakeD1();
    const consumed = await consumePlatformTotpStep(createFakeEnv(fake), {
      operatorId: "plat_op_x",
      matchedStep: 59_576_760,
      now: NOW,
    });
    expect(consumed).toBe(true);
    const update = fake.queries.find((query) => query.sql.startsWith("update"));
    expect(update?.sql).toContain('"platform_operator"');
    // 受理は WHERE で守る。**アプリ側の読んで比べる方式に戻さないこと**
    // （読みが交差した並行リクエストが両方通る）。
    expect(update?.sql).toMatch(
      /\("platform_operator"\."two_factor_last_step" is null or "platform_operator"\."two_factor_last_step" < \?\)/,
    );
    expect(update?.params).toContain(59_576_760);
    // 成功は第 2 要素の成功でもある。失敗回数とロックを同時に消す。
    expect(update?.sql).toContain('"two_factor_failed_attempts"');
    expect(update?.sql).toContain('"two_factor_locked_until"');
  });

  it("**同じコードの並行 2 リクエストは片方だけ成功する**（changes の契約）", async () => {
    // 本物の D1 では同じステップの 2 本のうち後勝ちの UPDATE が
    // WHERE（last_step < ?）に弾かれて changes = 0 になる。代役は SQL を
    // 評価しないので、**D1 が返す changes の並び（1 → 0）をそのまま
    // 再現**し、戻り値の契約（true / false）を固定する。
    const fake = createFakeD1();
    fake.enqueueChanges(1);
    fake.enqueueChanges(0);
    const env = createFakeEnv(fake);
    const step = 59_576_760;
    const [first, second] = await Promise.all([
      consumePlatformTotpStep(env, { operatorId: "plat_op_x", matchedStep: step, now: NOW }),
      consumePlatformTotpStep(env, { operatorId: "plat_op_x", matchedStep: step, now: NOW }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    // 2 本とも**同じ条件付き UPDATE** を発行している（片方だけ素通り、が無い）。
    const updates = fake.queries.filter((query) => query.sql.startsWith("update"));
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      expect(update.sql).toContain('"two_factor_last_step" is null or');
    }
  });

  it("過去ステップの再利用（changes = 0）は false", async () => {
    const fake = createFakeD1();
    fake.enqueueChanges(0);
    const consumed = await consumePlatformTotpStep(createFakeEnv(fake), {
      operatorId: "plat_op_x",
      matchedStep: 100,
      now: NOW,
    });
    expect(consumed).toBe(false);
  });

  it("登録の確認も条件付き UPDATE（confirmed_at IS NULL の 1 本だけ通る）", async () => {
    const fake = createFakeD1();
    const confirmed = await confirmPlatformTwoFactor(createFakeEnv(fake), {
      operatorId: "plat_op_x",
      lastStep: 100,
      now: NOW,
    });
    expect(confirmed).toBe(true);
    const update = fake.queries.find((query) => query.sql.startsWith("update"));
    expect(update?.sql).toContain('"two_factor_confirmed_at" is null');
  });

  it("登録の確認の負け側（changes = 0）は false", async () => {
    const fake = createFakeD1();
    fake.enqueueChanges(0);
    const confirmed = await confirmPlatformTwoFactor(createFakeEnv(fake), {
      operatorId: "plat_op_x",
      lastStep: 100,
      now: NOW,
    });
    expect(confirmed).toBe(false);
  });
});
