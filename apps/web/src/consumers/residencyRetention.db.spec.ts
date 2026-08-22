/**
 * 削除と監査ログの**原子性**を、実際に動かして確かめる（P8-11 hotfix / 2026-08-22）。
 *
 * ── なぜ実 DB で見るのか ────────────────────────────────
 * `residencyRetention.spec.ts` は代役で「どんな文を束ねたか」を固定するが、
 * **代役は行を貯めないので巻き戻りを再現できない。** ここで確かめたいのは
 *
 *   - 監査ログの INSERT が落ちたとき、**在留資格の行が残っている**か
 *   - 監査ログに残る件数が、**候補の数ではなく実在した行数**か
 *   - 保存された監査ログの行に、**個人を指す値が 1 つも無い**か
 *
 * のいずれも「本当に貯まる入れ物」でしか見られない。
 * `lib/staff/residencyAudit.db.spec.ts` と同じ `node:sqlite` の形を使う。
 *
 * 表の定義は**移行 SQL からそのまま読む**（手で写すと本物と離れる）。
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Env, ResidencyRow, StaffLedgerRow, TenantContext } from "@pk/db";
import { generateId } from "@pk/db";
import { beforeEach, describe, expect, it } from "vitest";

import { runResidencyRetention } from "./residencyRetention.js";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

const ORG_A = { organizationId: "org_test_alpha", orgShortId: "a1b2c3" } as const;
const ORG_B = { organizationId: "org_test_beta", orgShortId: "z9y8x7" } as const;

/** 基準日。2023-08-19 退職なら満了（2026-08-19）を過ぎている。 */
const BUSINESS_DATE = "2026-08-20";
const RESIGNED_LONG_AGO = "2023-08-19";
const NOW = new Date("2026-08-19T22:00:00.000Z");

/** 移行 SQL から `audit_log` と `residency_record` を作る。 */
function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  const files: [string, RegExp][] = [
    ["0000_p0_initial.sql", /^CREATE (TABLE `audit_log`|INDEX `idx_audit_log)/],
    ["0029_safe_exiles.sql", /^CREATE (TABLE `residency_record`|UNIQUE INDEX `uq_residency_staff`|INDEX `idx_residency_expires`)/],
  ];
  for (const [file, pattern] of files) {
    const sql = readFileSync(join(ROOT, "packages", "db", "migrations", file), "utf8");
    for (const part of sql.split("--> statement-breakpoint")) {
      const statement = part.trim();
      if (pattern.test(statement)) database.exec(statement);
    }
  }
  return database;
}

/**
 * `node:sqlite` を D1 に見せる。**`batch()` を本物と同じ意味にする** —
 * 1 つのトランザクションで走り、途中で落ちれば全体が巻き戻る
 * （Cloudflare D1 の `batch()` の定め）。
 */
function d1Of(database: DatabaseSync, hooks: { failOn?: RegExp } = {}): D1Database {
  interface Bound {
    sql: string;
    bound: unknown[];
  }

  const execute = (statement: Bound): { results: unknown[]; success: true; meta: { changes: number } } => {
    if (hooks.failOn?.test(statement.sql) === true) throw new Error("D1_ERROR");
    if (/^\s*select/i.test(statement.sql)) {
      const rows: unknown[] = database.prepare(statement.sql).all(...(statement.bound as never[]));
      return { results: rows, success: true, meta: { changes: 0 } };
    }
    const result = database.prepare(statement.sql).run(...(statement.bound as never[]));
    return { results: [], success: true, meta: { changes: Number(result.changes) } };
  };

  const prepare = (sql: string) => {
    const statement = {
      sql,
      bound: [] as unknown[],
      bind(...params: unknown[]) {
        statement.bound = params;
        return statement;
      },
      all: () => Promise.resolve(execute(statement)),
      raw: () => {
        const rows: unknown[] = database.prepare(sql).all(...(statement.bound as never[]));
        return Promise.resolve(rows.map((row) => Object.values(row as Record<string, unknown>)));
      },
      first: () => Promise.resolve(database.prepare(sql).get(...(statement.bound as never[])) ?? null),
      run: () => Promise.resolve(execute(statement)),
    };
    return statement;
  };

  const batch = (statements: readonly Bound[]) => {
    database.exec("BEGIN");
    try {
      const results = statements.map((statement) => execute(statement));
      database.exec("COMMIT");
      return Promise.resolve(results);
    } catch (error) {
      // **本物と同じ向き。** 途中で落ちたら全体を無かったことにする。
      database.exec("ROLLBACK");
      return Promise.reject(error instanceof Error ? error : new Error("D1_ERROR"));
    }
  };

  return { prepare, batch } as unknown as D1Database;
}

function envOf(database: DatabaseSync, hooks: { failOn?: RegExp } = {}): Env {
  return {
    SHARD_00: d1Of(database, hooks),
    SHARD_COUNT: "1",
    ENVIRONMENT: "local",
    SHARD_MAP: { get: () => Promise.resolve(null) },
  } as unknown as Env;
}

function contextFor(org: { organizationId: string; orgShortId: string }): TenantContext {
  return {
    organizationId: org.organizationId,
    orgShortId: org.orgShortId,
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now: NOW,
  };
}

let database: DatabaseSync;

beforeEach(() => {
  database = createDatabase();
});

/** 在留資格を 1 行入れる。**消してはいけない値をわざと入れてある。** */
function seedResidency(org: { organizationId: string; orgShortId: string }, staffProfileId: string): void {
  database
    .prepare(
      "insert into residency_record (id, organization_id, staff_profile_id, status_type, status_label," +
        " expires_on, renewal_applied_on, work_permit_required, weekly_hour_limit, note," +
        " updated_by_id, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      generateId(org.orgShortId, "resd"),
      org.organizationId,
      staffProfileId,
      "SPECIFIED_SKILLED_1",
      "特定技能1号",
      "2024-03-31",
      "2023-12-01",
      1,
      28,
      "更新手続きの控え",
      generateId(org.orgShortId, "mem"),
      NOW.getTime(),
      NOW.getTime(),
    );
}

function residencyCount(organizationId?: string): number {
  const sql =
    organizationId === undefined
      ? "select count(*) as n from residency_record"
      : "select count(*) as n from residency_record where organization_id = ?";
  const row = (
    organizationId === undefined
      ? database.prepare(sql).get()
      : database.prepare(sql).get(organizationId)
  ) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** 監査ログの `residency.deleted` の行。 */
function deletionAudits(): Record<string, unknown>[] {
  return database
    .prepare("select * from audit_log where action = 'residency.deleted' order by id")
    .all();
}

function deletedCounts(): number[] {
  return deletionAudits().map((row) => {
    const after = JSON.parse(String(row["after"])) as { deleted: number };
    return after.deleted;
  });
}

function ledgerRow(id: string, resignedOn: string | null): StaffLedgerRow {
  return {
    id,
    membershipId: generateId(ORG_A.orgShortId, "mem"),
    hiredOn: "2019-04-01",
    resignedOn,
    workStatus: "RESIGNED",
    languages: [],
    skills: [],
    note: null,
  };
}

function residencyRowFor(staffProfileId: string): ResidencyRow {
  return {
    id: generateId(ORG_A.orgShortId, "resd"),
    staffProfileId,
    statusType: "SPECIFIED_SKILLED_1",
    statusLabel: "特定技能1号",
    expiresOn: "2024-03-31",
    renewalAppliedOn: "2023-12-01",
    workPermitRequired: true,
    weeklyHourLimit: 28,
    note: "更新手続きの控え",
  };
}

describe("削除と監査ログの原子性", () => {
  it("成功すれば **行が消え、監査ログが 1 行残る**", async () => {
    const id = generateId(ORG_A.orgShortId, "sppf");
    seedResidency(ORG_A, id);

    const result = await runResidencyRetention(envOf(database), contextFor(ORG_A), {
      ledger: [ledgerRow(id, RESIGNED_LONG_AGO)],
      residency: [residencyRowFor(id)],
      businessDate: BUSINESS_DATE,
    });

    expect(result).toEqual({ candidates: 1, deleted: 1 });
    expect(residencyCount()).toBe(0);
    expect(deletedCounts()).toEqual([1]);
  });

  it("**監査ログの INSERT が落ちたら、削除も巻き戻る**", async () => {
    const id = generateId(ORG_A.orgShortId, "sppf");
    seedResidency(ORG_A, id);

    await expect(
      runResidencyRetention(envOf(database, { failOn: /insert into "audit_log"/ }), contextFor(ORG_A), {
        ledger: [ledgerRow(id, RESIGNED_LONG_AGO)],
        residency: [residencyRowFor(id)],
        businessDate: BUSINESS_DATE,
      }),
    ).rejects.toThrow("D1_ERROR");

    // **消えていない。** ここが hotfix の要点。
    expect(residencyCount()).toBe(1);
    expect(deletionAudits()).toHaveLength(0);
  });

  it("**DELETE が落ちたら、監査ログも残らない**", async () => {
    const id = generateId(ORG_A.orgShortId, "sppf");
    seedResidency(ORG_A, id);

    await expect(
      runResidencyRetention(envOf(database, { failOn: /^delete from/ }), contextFor(ORG_A), {
        ledger: [ledgerRow(id, RESIGNED_LONG_AGO)],
        residency: [residencyRowFor(id)],
        businessDate: BUSINESS_DATE,
      }),
    ).rejects.toThrow("D1_ERROR");

    expect(residencyCount()).toBe(1);
    // 監査ログの INSERT は先に走っているが、**巻き戻って残らない。**
    expect(deletionAudits()).toHaveLength(0);
  });

  it("落ちたあとに再実行すれば、**消えて記録も残る**（retry で失われない）", async () => {
    const id = generateId(ORG_A.orgShortId, "sppf");
    seedResidency(ORG_A, id);
    const input = {
      ledger: [ledgerRow(id, RESIGNED_LONG_AGO)],
      residency: [residencyRowFor(id)],
      businessDate: BUSINESS_DATE,
    };

    await expect(
      runResidencyRetention(envOf(database, { failOn: /insert into "audit_log"/ }), contextFor(ORG_A), input),
    ).rejects.toThrow("D1_ERROR");
    const result = await runResidencyRetention(envOf(database), contextFor(ORG_A), input);

    expect(result).toEqual({ candidates: 1, deleted: 1 });
    expect(residencyCount()).toBe(0);
    // **虚偽の件数が残っていない。** 1 回ぶんだけ。
    expect(deletedCounts()).toEqual([1]);
  });
});

describe("監査ログの件数", () => {
  it("**候補ではなく実在行数**（既に消えている候補が混ざっても増えない）", async () => {
    const present = generateId(ORG_A.orgShortId, "sppf");
    const stale = generateId(ORG_A.orgShortId, "sppf");
    // `stale` の在留資格は入れない（選定後に別経路で消えた状態）。
    seedResidency(ORG_A, present);

    const result = await runResidencyRetention(envOf(database), contextFor(ORG_A), {
      ledger: [ledgerRow(present, RESIGNED_LONG_AGO), ledgerRow(stale, RESIGNED_LONG_AGO)],
      residency: [residencyRowFor(present), residencyRowFor(stale)],
      businessDate: BUSINESS_DATE,
    });

    // 候補は 2 件。**実際に在ったのは 1 件。**
    expect(result.candidates).toBe(2);
    expect(result.deleted).toBe(1);
    expect(deletedCounts()).toEqual([1]);
  });

  it("**塊が分かれても、件数の合計が削除総数**", async () => {
    // D1 の束縛変数の上限（100）から予約 16 を引いた 84 件で塊が分かれる。
    const ids = Array.from({ length: 90 }, () => generateId(ORG_A.orgShortId, "sppf"));
    for (const id of ids) seedResidency(ORG_A, id);

    const result = await runResidencyRetention(envOf(database), contextFor(ORG_A), {
      ledger: ids.map((id) => ledgerRow(id, RESIGNED_LONG_AGO)),
      residency: ids.map((id) => residencyRowFor(id)),
      businessDate: BUSINESS_DATE,
    });

    expect(result.deleted).toBe(90);
    expect(residencyCount()).toBe(0);
    const counts = deletedCounts();
    // 塊ごとに 1 行。**合計が実際の削除総数。**
    expect(counts.length).toBeGreaterThan(1);
    expect(counts.reduce((sum, value) => sum + value, 0)).toBe(90);
  });

  it("0 件の回は `deleted: 0` が 1 行残る", async () => {
    const result = await runResidencyRetention(envOf(database), contextFor(ORG_A), {
      ledger: [],
      residency: [],
      businessDate: BUSINESS_DATE,
    });

    expect(result).toEqual({ candidates: 0, deleted: 0 });
    expect(deletedCounts()).toEqual([0]);
  });

  it("**3 回実行しても表は同じ**（2 回目以降は `deleted: 0`）", async () => {
    const id = generateId(ORG_A.orgShortId, "sppf");
    seedResidency(ORG_A, id);
    const ledger = [ledgerRow(id, RESIGNED_LONG_AGO)];

    for (let round = 0; round < 3; round += 1) {
      // 2 回目以降は表から消えているので、候補にも挙がらない。
      const remaining = residencyCount() > 0 ? [residencyRowFor(id)] : [];
      await runResidencyRetention(envOf(database), contextFor(ORG_A), {
        ledger,
        residency: remaining,
        businessDate: BUSINESS_DATE,
      });
    }

    expect(residencyCount()).toBe(0);
    expect(deletedCounts()).toEqual([1, 0, 0]);
  });
});

describe("監査ログに残る値", () => {
  it("**個人を特定できる値が 1 つも入らない**", async () => {
    const id = generateId(ORG_A.orgShortId, "sppf");
    seedResidency(ORG_A, id);

    await runResidencyRetention(envOf(database), contextFor(ORG_A), {
      ledger: [ledgerRow(id, RESIGNED_LONG_AGO)],
      residency: [residencyRowFor(id)],
      businessDate: BUSINESS_DATE,
    });

    const [row] = deletionAudits();
    expect(row).toBeDefined();
    const serialized = JSON.stringify(row);
    for (const value of [
      id, // スタッフの ID
      "SPECIFIED_SKILLED_1",
      "特定技能1号",
      "2024-03-31",
      "2023-12-01",
      "更新手続きの控え",
      RESIGNED_LONG_AGO,
    ]) {
      expect(serialized, value).not.toContain(value);
    }
    expect(row?.["after"]).toBe('{"deleted":1}');
    expect(row?.["before"]).toBeNull();
    expect(row?.["target_id"]).toBeNull();
    expect(row?.["target_type"]).toBe("residencyRetention");
  });

  it("操作者はバッチ（**人の ID を借りない**）", async () => {
    const id = generateId(ORG_A.orgShortId, "sppf");
    seedResidency(ORG_A, id);

    await runResidencyRetention(envOf(database), contextFor(ORG_A), {
      ledger: [ledgerRow(id, RESIGNED_LONG_AGO)],
      residency: [residencyRowFor(id)],
      businessDate: BUSINESS_DATE,
    });

    expect(deletionAudits()[0]?.["actor_id"]).toBe(
      `${ORG_A.orgShortId}__sys_00000000000000000000000000`,
    );
  });
});

describe("テナント分離", () => {
  it("**同居する別組織の行を消さない**", async () => {
    const mine = generateId(ORG_A.orgShortId, "sppf");
    const theirs = generateId(ORG_B.orgShortId, "sppf");
    seedResidency(ORG_A, mine);
    seedResidency(ORG_B, theirs);

    const result = await runResidencyRetention(envOf(database), contextFor(ORG_A), {
      ledger: [ledgerRow(mine, RESIGNED_LONG_AGO)],
      residency: [residencyRowFor(mine)],
      businessDate: BUSINESS_DATE,
    });

    expect(result.deleted).toBe(1);
    expect(residencyCount(ORG_A.organizationId)).toBe(0);
    expect(residencyCount(ORG_B.organizationId)).toBe(1);
  });
});
