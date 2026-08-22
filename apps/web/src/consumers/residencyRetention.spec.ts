/**
 * 在留資格の保存期間の満了（P8-11 / PK-SPEC-P8 §1.4）。**発行される SQL の形。**
 *
 * ここで見るのは「どんな文を、どんな束ね方で送るか」まで。
 * **本当に巻き戻るか・件数が合うかは `residencyRetention.db.spec.ts`**
 * （`node:sqlite` の実 DB）で見る。代役は行を貯めないので、
 * ここで「消えていないこと」は確かめられない。
 *
 * 完了条件（docs/tasks/P8-11.md）:
 *   - 満了日の**翌日**から消す（境界値は lib の spec）
 *   - **DELETE と監査ログを 1 つの `batch()` で送る**
 *   - 監査ログの件数は**候補の数ではなく DB が数えた実在行数**
 *   - `batch()` が落ちたら例外が呼び出し側へ伝わる
 *   - 0 件の回は `deleted: 0` の記録が 1 行残る
 *   - 監査ログに個人を特定できる値を保存しない
 */

import type { Env, ResidencyRow, StaffLedgerRow } from "@pk/db";
import { createFakeD1, createFakeEnv, TEST_ORG, type FakeD1 } from "@pk/db/test-support";
import { describe, expect, it } from "vitest";

import { runResidencyRetention } from "./residencyRetention.js";

/** 判定の基準日。2023-08-19 に退職した人は満了（2026-08-19）を過ぎている。 */
const BUSINESS_DATE = "2026-08-20";

/** 満了を過ぎている退職日。 */
const RESIGNED_LONG_AGO = "2023-08-19";

const CTX = {
  organizationId: TEST_ORG.organizationId,
  orgShortId: TEST_ORG.orgShortId,
  role: "ORG_ADMIN",
  allowedPropertyIds: [],
  now: new Date("2026-08-19T22:00:00.000Z"),
} as const;

function staffId(suffix: string): string {
  return `${TEST_ORG.orgShortId}__sppf_01JBXQ3ZK8N4P2VYR6${suffix}`;
}

function ledgerRow(overrides: Partial<StaffLedgerRow> & { id: string }): StaffLedgerRow {
  return {
    membershipId: `${TEST_ORG.orgShortId}__mem_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
    hiredOn: "2019-04-01",
    resignedOn: null,
    workStatus: "ACTIVE",
    languages: [],
    skills: [],
    note: null,
    ...overrides,
  };
}

/**
 * 在留資格 1 件。**監査ログに写ってはいけない値をわざと入れてある** —
 * この文字列が保存される値に現れないことを下で確かめる。
 */
function residencyRow(staffProfileId: string): ResidencyRow {
  return {
    id: `${TEST_ORG.orgShortId}__resd_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
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

function envOf(fake: FakeD1): Env {
  return createFakeEnv(fake);
}

function auditInserts(fake: FakeD1): { sql: string; params: unknown[] }[] {
  return fake.queries.filter(
    (query) => query.sql.startsWith("insert into") && query.params.includes("residency.deleted"),
  );
}

function deletes(fake: FakeD1): { sql: string; params: unknown[] }[] {
  return fake.queries.filter((query) => query.sql.startsWith("delete from"));
}

describe("runResidencyRetention", () => {
  it("満了日を過ぎた記録を消す", async () => {
    const fake = createFakeD1();
    const id = staffId("ABCDEFGH");

    const result = await runResidencyRetention(envOf(fake), CTX, {
      ledger: [ledgerRow({ id, workStatus: "RESIGNED", resignedOn: RESIGNED_LONG_AGO })],
      residency: [residencyRow(id)],
      businessDate: BUSINESS_DATE,
    });

    expect(result.candidates).toBe(1);
    const del = deletes(fake);
    expect(del).toHaveLength(1);
    expect(del[0]?.params).toContain(id);
    // 組織条件が必ず載る（architecture.md §2 第 1 層）。
    expect(del[0]?.params).toContain(TEST_ORG.organizationId);
  });

  it("**監査ログと DELETE を 1 つの `batch()` で送る**（別々に `await` しない）", async () => {
    const fake = createFakeD1();
    const id = staffId("ABCDEFGH");

    await runResidencyRetention(envOf(fake), CTX, {
      ledger: [ledgerRow({ id, workStatus: "RESIGNED", resignedOn: RESIGNED_LONG_AGO })],
      residency: [residencyRow(id)],
      businessDate: BUSINESS_DATE,
    });

    // 束ねた 2 文だけが出ている。**3 文目（後から書く監査ログ）が無い。**
    expect(fake.queries).toHaveLength(2);
    expect(auditInserts(fake)).toHaveLength(1);
    expect(deletes(fake)).toHaveLength(1);
    // 監査ログが先（同じトランザクションなので、数える瞬間に行がまだある）。
    expect(fake.queries[0]?.sql.startsWith("insert into")).toBe(true);
    expect(fake.queries[1]?.sql.startsWith("delete from")).toBe(true);
  });

  it("**件数は DB が数える**（`chunk.length` を埋め込まない）", async () => {
    const fake = createFakeD1();
    const id = staffId("ABCDEFGH");

    await runResidencyRetention(envOf(fake), CTX, {
      ledger: [ledgerRow({ id, workStatus: "RESIGNED", resignedOn: RESIGNED_LONG_AGO })],
      residency: [residencyRow(id)],
      businessDate: BUSINESS_DATE,
    });

    const insert = auditInserts(fake)[0];
    // `after` は副問い合わせを含む式。**リテラルの JSON を束縛していない。**
    expect(insert?.sql).toContain("json_object('deleted'");
    expect(insert?.sql).toContain("select count(*)");
    expect(insert?.params).not.toContain('{"deleted":1}');
  });

  it("**`batch()` が落ちたら例外が伝わる**（握り潰さない）", async () => {
    const fake = createFakeD1();
    const id = staffId("ABCDEFGH");
    fake.failNextBatch(new Error("D1_ERROR"));

    await expect(
      runResidencyRetention(envOf(fake), CTX, {
        ledger: [ledgerRow({ id, workStatus: "RESIGNED", resignedOn: RESIGNED_LONG_AGO })],
        residency: [residencyRow(id)],
        businessDate: BUSINESS_DATE,
      }),
    ).rejects.toThrow("D1_ERROR");

    // **後追いの監査ログを書かない。** 落ちた回に「消した」記録が残らない。
    expect(fake.queries.filter((query) => query.params.includes("residency.deleted"))).toHaveLength(
      1,
    );
  });

  it("満了日**当日**は消さない（**DELETE も監査ログも出ない**）", async () => {
    const fake = createFakeD1();
    const id = staffId("ABCDEFGH");

    // 2023-08-20 退職 → 満了 2026-08-20 = 基準日。
    const result = await runResidencyRetention(envOf(fake), CTX, {
      ledger: [ledgerRow({ id, workStatus: "RESIGNED", resignedOn: "2023-08-20" })],
      residency: [residencyRow(id)],
      businessDate: BUSINESS_DATE,
    });

    expect(result).toEqual({ candidates: 0, deleted: 0 });
    expect(deletes(fake)).toHaveLength(0);
  });

  it("在職中は在留期限が切れていても消さない（**DELETE を発行しない**）", async () => {
    const fake = createFakeD1();
    const id = staffId("ABCDEFGH");

    const result = await runResidencyRetention(envOf(fake), CTX, {
      ledger: [ledgerRow({ id, workStatus: "ACTIVE", resignedOn: null })],
      residency: [residencyRow(id)],
      businessDate: BUSINESS_DATE,
    });

    expect(result).toEqual({ candidates: 0, deleted: 0 });
    expect(deletes(fake)).toHaveLength(0);
  });

  it("退職日が分からなければ消さない", async () => {
    const fake = createFakeD1();
    const id = staffId("ABCDEFGH");

    const result = await runResidencyRetention(envOf(fake), CTX, {
      ledger: [ledgerRow({ id, workStatus: "RESIGNED", resignedOn: null })],
      residency: [residencyRow(id)],
      businessDate: BUSINESS_DATE,
    });

    expect(result).toEqual({ candidates: 0, deleted: 0 });
    expect(deletes(fake)).toHaveLength(0);
  });

  it.each([
    "2023-02-29",
    "2023-02-30",
    "2023-02-31",
    "2023-04-31",
    "2023-00-15",
    "2023-13-01",
    "2023-01-00",
    "2023-01-32",
  ])("**暦に無い退職日では DELETE を 1 文も発行しない**（%s）", async (resignedOn) => {
    const fake = createFakeD1();
    const id = staffId("ABCDEFGH");

    const result = await runResidencyRetention(envOf(fake), CTX, {
      ledger: [ledgerRow({ id, workStatus: "RESIGNED", resignedOn })],
      residency: [residencyRow(id)],
      businessDate: BUSINESS_DATE,
    });

    expect(result).toEqual({ candidates: 0, deleted: 0 });
    expect(deletes(fake)).toHaveLength(0);
  });

  it("**0 件の回も記録を残す**（走ったが 0 件と、走っていないを分ける）", async () => {
    const fake = createFakeD1();

    await runResidencyRetention(envOf(fake), CTX, {
      ledger: [],
      residency: [],
      businessDate: BUSINESS_DATE,
    });

    const insert = auditInserts(fake)[0];
    expect(insert?.params).toContain("residency.deleted");
    // 束ねる DELETE がいないので、こちらは値を束縛する経路
    // （`recordEmptyResidencyRetentionRun()`。**件数は 0 に固定**）。
    expect(insert?.params).toContain('{"deleted":0}');
  });

  it("**消す回は 0 件用の口を通らない**（`{\"deleted\":0}` を書かない）", async () => {
    const fake = createFakeD1();
    const id = staffId("ABCDEFGH");

    await runResidencyRetention(envOf(fake), CTX, {
      ledger: [ledgerRow({ id, workStatus: "RESIGNED", resignedOn: RESIGNED_LONG_AGO })],
      residency: [residencyRow(id)],
      businessDate: BUSINESS_DATE,
    });

    // 0 件用の口は `after` にリテラルを束縛する。**その痕跡が無い。**
    expect(JSON.stringify(fake.queries)).not.toContain('{\\"deleted\\":0}');
    for (const query of fake.queries) {
      expect(query.params).not.toContain('{"deleted":0}');
    }
  });

  it("監査ログの操作者はバッチ（**人の ID を借りない** / DECISIONS #164）", async () => {
    const fake = createFakeD1();

    await runResidencyRetention(envOf(fake), CTX, {
      ledger: [],
      residency: [],
      businessDate: BUSINESS_DATE,
    });

    expect(auditInserts(fake)[0]?.params).toContain(
      `${TEST_ORG.orgShortId}__sys_00000000000000000000000000`,
    );
  });

  it("**監査ログに在留資格の値が入らない**（氏名・種別・期限・更新申請日）", async () => {
    const fake = createFakeD1();
    const id = staffId("ABCDEFGH");

    await runResidencyRetention(envOf(fake), CTX, {
      ledger: [ledgerRow({ id, workStatus: "RESIGNED", resignedOn: RESIGNED_LONG_AGO })],
      residency: [residencyRow(id)],
      businessDate: BUSINESS_DATE,
    });

    const serialized = JSON.stringify(auditInserts(fake)[0]?.params);
    for (const value of [
      "SPECIFIED_SKILLED_1", // 種別
      "特定技能1号", // 表示名
      "2024-03-31", // 在留期限
      "2023-12-01", // 更新申請日
      "更新手続きの控え", // ノート
      RESIGNED_LONG_AGO, // 退職日
      `${TEST_ORG.orgShortId}__resd_01JBXQ3ZK8N4P2VYR6ABCDEFGH`, // 在留資格の行 ID
    ]) {
      expect(serialized, value).not.toContain(value);
    }
    // **`staffProfileId` は DELETE 条件の束縛値としては現れる**（副問い合わせが
    // 同じ条件で数えるため）。**保存されるのは `{"deleted": N}` だけ**で、
    // 行に ID が入らないことは `residencyRetention.db.spec.ts` が実物で見る。
  });

  it("複数人ぶんをまとめて消す（**DELETE は 1 回**）", async () => {
    const fake = createFakeD1();
    const first = staffId("ABCDEFGH");
    const second = staffId("ABCDEFGJ");

    const result = await runResidencyRetention(envOf(fake), CTX, {
      ledger: [
        ledgerRow({ id: first, workStatus: "RESIGNED", resignedOn: RESIGNED_LONG_AGO }),
        ledgerRow({ id: second, workStatus: "RESIGNED", resignedOn: "2020-01-31" }),
      ],
      residency: [residencyRow(first), { ...residencyRow(second), staffProfileId: second }],
      businessDate: BUSINESS_DATE,
    });

    expect(result.candidates).toBe(2);
    expect(deletes(fake)).toHaveLength(1);
    expect(auditInserts(fake)).toHaveLength(1);
  });

  it("台帳に無い在留資格の残骸は消さない（**退職日が分からない**）", async () => {
    const fake = createFakeD1();

    const result = await runResidencyRetention(envOf(fake), CTX, {
      ledger: [],
      residency: [residencyRow(staffId("ABCDEFGH"))],
      businessDate: BUSINESS_DATE,
    });

    expect(result).toEqual({ candidates: 0, deleted: 0 });
    expect(deletes(fake)).toHaveLength(0);
  });
});
