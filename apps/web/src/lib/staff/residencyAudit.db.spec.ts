/**
 * 在留資格の閲覧の記録を**実際に動かして**確かめる（DECISIONS #261）。
 *
 * ── なぜ実 DB で見るのか ────────────────────────────────
 * `residencyAudit.spec.ts` はソースの走査で「値を載せていないこと」を
 * 固定するが、**畳めているかは走査では分からない。**
 * 実際に 2 回呼んで 1 行になることを見る必要がある
 * （2026-08-22 に、境目が未来を指して**毎回 1 行増える**不具合を出した）。
 *
 * ── 代役ではなく `node:sqlite` を使う ───────────────────
 * `@pk/db/test-support` の `createFakeD1()` は**発行された SQL を記録する**
 * 代役で、行を貯めない。ここで確かめたいのは「前に書いた行が次の判定で
 * 見つかるか」なので、**本当に貯まる入れ物**が要る。
 * 表の定義は**移行 SQL からそのまま読む**（手で写すと本物と離れる）。
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { generateId, type Env, type TenantContext } from "@pk/db";
import { beforeEach, describe, expect, it } from "vitest";

import { recordResidencyView, startOfJstDay } from "./residencyAudit.js";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");

/** 2 組織。**同じ入れ物に同居させる**（越境の判定を実物で見るため）。 */
const ORG_A = { organizationId: "org_test_alpha", orgShortId: "a1b2c3" } as const;
const ORG_B = { organizationId: "org_test_beta", orgShortId: "z9y8x7" } as const;

// **自己記述 ID**（`{orgShortId}__mem_{ulid}`）。`assertIdBelongsToTenant()` が
// 組織を突き合わせるので、手で書式を作らず採番の口を通す。
const ACTOR_A1 = generateId(ORG_A.orgShortId, "mem");
const ACTOR_A2 = generateId(ORG_A.orgShortId, "mem");
const ACTOR_B1 = generateId(ORG_B.orgShortId, "mem");

/**
 * `audit_log` だけを持つ入れ物を作る。
 *
 * **移行 SQL の最初の 1 文（`CREATE TABLE audit_log`）と索引を流す。**
 * 列が増えたらここも自然に追随する。
 */
function createDatabase(): DatabaseSync {
  const sql = readFileSync(join(ROOT, "packages", "db", "migrations", "0000_p0_initial.sql"), "utf8");
  const statements = sql.split("--> statement-breakpoint").map((part) => part.trim());
  const database = new DatabaseSync(":memory:");
  for (const statement of statements) {
    if (/^CREATE (TABLE `audit_log`|INDEX `idx_audit_log)/.test(statement)) {
      database.exec(statement);
    }
  }
  return database;
}

/**
 * `node:sqlite` を D1 に見せる。**drizzle の d1 driver が呼ぶ形だけ**を作る
 * （`prepare().bind().all() / .run() / .raw() / .first()`）。
 */
function d1Of(database: DatabaseSync): D1Database {
  const prepare = (sql: string) => {
    const statement = {
      bound: [] as unknown[],
      bind(...params: unknown[]) {
        statement.bound = params;
        return statement;
      },
      all() {
        const rows: unknown[] = database.prepare(sql).all(...(statement.bound as never[]));
        return Promise.resolve({ results: rows, success: true, meta: {} });
      },
      raw() {
        const rows: unknown[] = database.prepare(sql).all(...(statement.bound as never[]));
        const values: unknown[][] = rows.map((row) => Object.values(row as Record<string, unknown>));
        return Promise.resolve(values);
      },
      first() {
        const row = database.prepare(sql).get(...(statement.bound as never[]));
        return Promise.resolve(row ?? null);
      },
      run() {
        const result = database.prepare(sql).run(...(statement.bound as never[]));
        return Promise.resolve({
          success: true,
          meta: { changes: Number(result.changes) },
        });
      },
    };
    return statement;
  };
  return { prepare } as unknown as D1Database;
}

function envOf(database: DatabaseSync): Env {
  return {
    SHARD_00: d1Of(database),
    SHARD_COUNT: "1",
    ENVIRONMENT: "local",
    SHARD_MAP: { get: () => Promise.resolve(null) },
  } as unknown as Env;
}

function contextFor(
  org: { organizationId: string; orgShortId: string },
  now: Date,
): TenantContext {
  return {
    organizationId: org.organizationId,
    orgShortId: org.orgShortId,
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now,
  };
}

let database: DatabaseSync;
let env: Env;

function countRows(organizationId?: string): number {
  const sql =
    organizationId === undefined
      ? "select count(*) as n from audit_log"
      : "select count(*) as n from audit_log where organization_id = ?";
  const row = (
    organizationId === undefined
      ? database.prepare(sql).get()
      : database.prepare(sql).get(organizationId)
  ) as { n: number };
  return row.n;
}

beforeEach(() => {
  database = createDatabase();
  env = envOf(database);
});

describe("startOfJstDay", () => {
  it.each([
    // JST の 0 時ちょうど → その瞬間そのもの
    ["2026-08-21T15:00:00.000Z", "2026-08-21T15:00:00.000Z"],
    // JST の 8:59（**旧実装が壊れていた時間帯**）
    ["2026-08-21T23:59:00.000Z", "2026-08-21T15:00:00.000Z"],
    // JST の 9:00（UTC の日付が変わる瞬間）
    ["2026-08-22T00:00:00.000Z", "2026-08-21T15:00:00.000Z"],
    // JST の 23:59
    ["2026-08-22T14:59:00.000Z", "2026-08-21T15:00:00.000Z"],
    // 翌 JST 日の 0 時
    ["2026-08-22T15:00:00.000Z", "2026-08-22T15:00:00.000Z"],
  ])("%s → %s", (now, expected) => {
    expect(startOfJstDay(new Date(now)).toISOString()).toBe(expected);
  });

  it("**常に現在時刻以前**（未来を指すと畳みが効かない）", () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const now = new Date(Date.UTC(2026, 7, 22, hour, 30, 0));
      expect(startOfJstDay(now).getTime(), `${String(hour)}時 UTC`).toBeLessThanOrEqual(
        now.getTime(),
      );
    }
  });
});

describe("在留資格の閲覧の記録（実動）", () => {
  it("① 同じ人が同じ日に 2 回見ても 1 件", async () => {
    const morning = new Date("2026-08-21T23:10:00.000Z"); // 8/22 08:10 JST
    const evening = new Date("2026-08-22T09:30:00.000Z"); // 8/22 18:30 JST

    expect(await recordResidencyView(env, contextFor(ORG_A, morning), { actorId: ACTOR_A1 })).toBe(
      true,
    );
    expect(await recordResidencyView(env, contextFor(ORG_A, evening), { actorId: ACTOR_A1 })).toBe(
      false,
    );
    expect(countRows()).toBe(1);
  });

  it("② 別の人なら同じ日でも別の 1 件", async () => {
    const now = new Date("2026-08-22T09:30:00.000Z");
    await recordResidencyView(env, contextFor(ORG_A, now), { actorId: ACTOR_A1 });
    expect(await recordResidencyView(env, contextFor(ORG_A, now), { actorId: ACTOR_A2 })).toBe(true);
    expect(countRows()).toBe(2);
  });

  it("③ 翌日なら新しく 1 件", async () => {
    const day1 = new Date("2026-08-22T09:30:00.000Z"); // 8/22 18:30 JST
    const day2 = new Date("2026-08-23T01:00:00.000Z"); // 8/23 10:00 JST
    await recordResidencyView(env, contextFor(ORG_A, day1), { actorId: ACTOR_A1 });
    expect(await recordResidencyView(env, contextFor(ORG_A, day2), { actorId: ACTOR_A1 })).toBe(
      true,
    );
    expect(countRows()).toBe(2);
  });

  it("④ **JST の 0 時をまたぐ前後で意図せず重ならない**", async () => {
    // 8/21 23:50 JST → 8/22 00:10 JST。**暦日が変わるので 2 件。**
    const before = new Date("2026-08-21T14:50:00.000Z");
    const after = new Date("2026-08-21T15:10:00.000Z");
    await recordResidencyView(env, contextFor(ORG_A, before), { actorId: ACTOR_A1 });
    expect(await recordResidencyView(env, contextFor(ORG_A, after), { actorId: ACTOR_A1 })).toBe(
      true,
    );
    expect(countRows()).toBe(2);
  });

  it("④' **JST 05:00〜08:59 でも畳む**（旧実装が毎回増やしていた時間帯）", async () => {
    // 8/22 06:00 JST と 8/22 08:30 JST。UTC ではどちらも 8/21。
    const first = new Date("2026-08-21T21:00:00.000Z");
    const second = new Date("2026-08-21T23:30:00.000Z");
    expect(await recordResidencyView(env, contextFor(ORG_A, first), { actorId: ACTOR_A1 })).toBe(
      true,
    );
    expect(await recordResidencyView(env, contextFor(ORG_A, second), { actorId: ACTOR_A1 })).toBe(
      false,
    );
    expect(countRows()).toBe(1);
  });

  it("⑤ **別テナントの行を重複の判定に使わない**", async () => {
    const now = new Date("2026-08-22T09:30:00.000Z");
    await recordResidencyView(env, contextFor(ORG_B, now), { actorId: ACTOR_B1 });
    // 組織 A から見れば「その日はまだ無い」。**組織 B の行に引きずられない。**
    expect(await recordResidencyView(env, contextFor(ORG_A, now), { actorId: ACTOR_A1 })).toBe(
      true,
    );
    expect(countRows(ORG_A.organizationId)).toBe(1);
    expect(countRows(ORG_B.organizationId)).toBe(1);
  });

  it("**書いた行に在留資格の値が入っていない**", async () => {
    const now = new Date("2026-08-22T09:30:00.000Z");
    await recordResidencyView(env, contextFor(ORG_A, now), { actorId: ACTOR_A1 });
    const row = database.prepare("select * from audit_log").get() as Record<string, unknown>;
    expect(row["action"]).toBe("residency.viewed");
    expect(row["target_type"]).toBe("residencyList");
    expect(row["target_id"]).toBeNull();
    expect(row["before"]).toBeNull();
    expect(row["after"]).toBeNull();
  });
});
