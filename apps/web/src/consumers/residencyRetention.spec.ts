/**
 * 在留資格の保存期間の満了（P8-11 / PK-SPEC-P8 §1.4）。
 *
 * 完了条件（docs/tasks/P8-11.md）:
 *   - 退職から 3 年が経った記録だけを消す（境界値は lib の spec）
 *   - **3 回実行しても結果が変わらない**（testing.md §4）
 *   - 監査ログに `residency.deleted` が残る（**0 件でも残る**）
 *   - **監査ログに氏名・種別・期限・更新申請日が入らない**
 *   - **削除済みの情報を監査ログから復元できない**（`staffProfileId` も入らない）
 *   - 退職者へ更新の通知が飛ばない（`residencyAlert.spec.ts` と合わせて固定）
 */

import type { Env, ResidencyRow, StaffLedgerRow } from "@pk/db";
import { createFakeD1, createFakeEnv, TEST_ORG, type FakeD1 } from "@pk/db/test-support";
import { describe, expect, it } from "vitest";

import { runResidencyRetention } from "./residencyRetention.js";

/** 判定の基準日。2023-08-20 に退職した人がちょうど 3 年を迎える日。 */
const BUSINESS_DATE = "2026-08-20";

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
 * この文字列が監査ログのパラメータに現れないことを下で確かめる。
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

/** `residency.deleted` を書いた INSERT。 */
function auditInsert(fake: FakeD1): { sql: string; params: unknown[] } {
  const insert = fake.queries.find(
    (query) => query.sql.startsWith("insert into") && query.params.includes("residency.deleted"),
  );
  if (insert === undefined) throw new Error("residency.deleted の監査ログが書かれていない");
  return insert;
}

describe("runResidencyRetention", () => {
  it("退職から 3 年が経った記録を消す", async () => {
    const fake = createFakeD1();
    const id = staffId("ABCDEFGH");

    const result = await runResidencyRetention(envOf(fake), CTX, {
      ledger: [ledgerRow({ id, workStatus: "RESIGNED", resignedOn: "2023-08-20" })],
      residency: [residencyRow(id)],
      businessDate: BUSINESS_DATE,
    });

    expect(result.candidates).toBe(1);
    const del = fake.queries.find((query) => query.sql.startsWith("delete from"));
    expect(del?.params).toContain(id);
    // 組織条件が必ず載る（architecture.md §2 第 1 層）。
    expect(del?.params).toContain(TEST_ORG.organizationId);
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
    expect(fake.queries.some((query) => query.sql.startsWith("delete from"))).toBe(false);
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
    expect(fake.queries.some((query) => query.sql.startsWith("delete from"))).toBe(false);
  });

  it("**3 回実行しても結果が変わらない**（testing.md §4）", async () => {
    const id = staffId("ABCDEFGH");
    const ledger = [ledgerRow({ id, workStatus: "RESIGNED", resignedOn: "2023-08-20" })];
    // 表の中身。**消えた行は次の回の読み取りに出てこない。**
    let residency = [residencyRow(id)];

    const deleted: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const fake = createFakeD1();
      const result = await runResidencyRetention(envOf(fake), CTX, {
        ledger,
        residency,
        businessDate: BUSINESS_DATE,
      });
      deleted.push(result.candidates);
      const removed = new Set(
        result.candidates > 0 ? residency.map((row) => row.staffProfileId) : [],
      );
      residency = residency.filter((row) => !removed.has(row.staffProfileId));
    }

    // 1 回目で消え、2 回目・3 回目は対象が無い。**表の中身は同じ。**
    expect(deleted).toEqual([1, 0, 0]);
    expect(residency).toEqual([]);
  });

  it("**0 件でも監査ログに残す**（走ったが 0 件と、走っていないを分ける）", async () => {
    const fake = createFakeD1();

    await runResidencyRetention(envOf(fake), CTX, {
      ledger: [],
      residency: [],
      businessDate: BUSINESS_DATE,
    });

    const insert = auditInsert(fake);
    expect(insert.params).toContain("residency.deleted");
    expect(insert.params).toContain('{"deleted":0}');
  });

  it("監査ログの操作者はバッチ（**人の ID を借りない** / DECISIONS #164）", async () => {
    const fake = createFakeD1();

    await runResidencyRetention(envOf(fake), CTX, {
      ledger: [],
      residency: [],
      businessDate: BUSINESS_DATE,
    });

    expect(auditInsert(fake).params).toContain(
      `${TEST_ORG.orgShortId}__sys_00000000000000000000000000`,
    );
  });

  it("**監査ログに在留資格の値が入らない**（氏名・種別・期限・更新申請日）", async () => {
    const fake = createFakeD1();
    const id = staffId("ABCDEFGH");

    await runResidencyRetention(envOf(fake), CTX, {
      ledger: [ledgerRow({ id, workStatus: "RESIGNED", resignedOn: "2023-08-20" })],
      residency: [residencyRow(id)],
      businessDate: BUSINESS_DATE,
    });

    const serialized = JSON.stringify(auditInsert(fake).params);
    for (const value of [
      "SPECIFIED_SKILLED_1", // 種別
      "特定技能1号", // 表示名
      "2024-03-31", // 在留期限
      "2023-12-01", // 更新申請日
      "更新手続きの控え", // ノート
      "2023-08-20", // 退職日
      "28", // 週の上限時間
    ]) {
      expect(serialized, value).not.toContain(value);
    }
  });

  it("**削除済みの情報を監査ログから復元できない**（誰のものかが残らない）", async () => {
    const fake = createFakeD1();
    const id = staffId("ABCDEFGH");

    await runResidencyRetention(envOf(fake), CTX, {
      ledger: [ledgerRow({ id, workStatus: "RESIGNED", resignedOn: "2023-08-20" })],
      residency: [residencyRow(id)],
      businessDate: BUSINESS_DATE,
    });

    const insert = auditInsert(fake);
    // スタッフの ID も、在留資格の行の ID も載らない。
    expect(insert.params).not.toContain(id);
    expect(insert.params).not.toContain(residencyRow(id).id);
    // `after` に載るのは件数だけ。
    expect(insert.params).toContain('{"deleted":1}');
  });

  it("複数人ぶんをまとめて消す（**DELETE は 1 回**）", async () => {
    const fake = createFakeD1();
    const first = staffId("ABCDEFGH");
    const second = staffId("ABCDEFGJ");

    const result = await runResidencyRetention(envOf(fake), CTX, {
      ledger: [
        ledgerRow({ id: first, workStatus: "RESIGNED", resignedOn: "2023-08-20" }),
        ledgerRow({ id: second, workStatus: "RESIGNED", resignedOn: "2020-01-31" }),
      ],
      residency: [residencyRow(first), { ...residencyRow(second), staffProfileId: second }],
      businessDate: BUSINESS_DATE,
    });

    expect(result.candidates).toBe(2);
    const deletes = fake.queries.filter((query) => query.sql.startsWith("delete from"));
    expect(deletes).toHaveLength(1);
  });

  it("台帳に無い在留資格の残骸は消さない（**退職日が分からない**）", async () => {
    const fake = createFakeD1();

    const result = await runResidencyRetention(envOf(fake), CTX, {
      ledger: [],
      residency: [residencyRow(staffId("ABCDEFGH"))],
      businessDate: BUSINESS_DATE,
    });

    expect(result).toEqual({ candidates: 0, deleted: 0 });
  });
});
