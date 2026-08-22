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

/**
 * 監査ログの INSERT を**列の名前で引ける形**にする。
 *
 * ── なぜ列に分けるのか ──────────────────────────────────
 * 以前はパラメータ全体を `JSON.stringify()` して部分文字列を探していた。
 * **その中には毎回変わる ULID（`audit_log.id`）と時刻が混ざる。**
 * 週の上限時間「28」のような短い値を探すと、**ULID にたまたま `28` が
 * 並んだ回だけ落ちる**（26 桁 Crockford base32 で実測 2.4%）。
 *
 * 列に分ければ、**見たい列だけ**を厳密に見られる。ULID も時刻も
 * 検査の対象から外れる。
 *
 * SQL の列並びから読むので、**列が増えても順番を写経し直さなくてよい。**
 */
function auditColumns(fake: FakeD1): Record<string, unknown> {
  const insert = auditInsert(fake);
  const listed = /insert into "[^"]+" \(([^)]*)\) values/.exec(insert.sql)?.[1];
  if (listed === undefined) throw new Error(`INSERT の列が読めない: ${insert.sql}`);

  const names = listed.split(",").map((name) => name.trim().replaceAll('"', ""));
  if (names.length !== insert.params.length) {
    throw new Error(`列 ${String(names.length)} と値 ${String(insert.params.length)} が合わない`);
  }
  return Object.fromEntries(names.map((name, index) => [name, insert.params[index]]));
}

/**
 * `after` を JSON として読む。**文字列比較にしない** —
 * 鍵の並びが変わっただけで落ちる検査は、payload の中身を見ていない。
 */
function auditPayload(fake: FakeD1, column: "before" | "after"): unknown {
  const raw = auditColumns(fake)[column];
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new Error(`${column} が文字列でない: ${JSON.stringify(raw)}`);
  return JSON.parse(raw) as unknown;
}

/**
 * 監査ログのうち**自由記述が入りうる列だけ**を連ねた文字列。
 *
 * **ここに ULID も時刻も入れない。** 「この値が残っていないこと」を
 * 見るための検査で、生成のたびに変わる値を混ぜると偶然で落ちる。
 */
function auditFreeText(fake: FakeD1): string {
  const columns = auditColumns(fake);
  return JSON.stringify([columns["before"], columns["after"], columns["reason"]]);
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

    const columns = auditColumns(fake);
    expect(columns["action"]).toBe("residency.deleted");
    // **`after` は件数だけ。完全一致で見る**（鍵が増えたらここで落ちる）。
    expect(auditPayload(fake, "after")).toEqual({ deleted: 0 });
    expect(auditPayload(fake, "before")).toBeNull();
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

    // ── ① payload そのものを完全一致で押さえる ────────────────
    // **これが本体。** 件数だけの形なら、値が入る余地がそもそも無い。
    expect(auditPayload(fake, "after")).toEqual({ deleted: 1 });
    expect(auditPayload(fake, "before")).toBeNull();

    // 鍵の一覧も固定する。**`deleted` 以外の鍵を足したらここで落ちる。**
    expect(Object.keys(auditPayload(fake, "after") as Record<string, unknown>)).toEqual([
      "deleted",
    ]);

    // 週の上限時間（28）は**数値として**入っていないこと。
    // 文字列の部分一致で探すと ULID の中の `28` に当たる（`auditColumns()`
    // の注記）。**値そのものを見る。**
    expect(Object.values(auditPayload(fake, "after") as Record<string, unknown>)).toEqual([1]);

    // ── ② 自由記述の列に値が写っていない ──────────────────────
    // **ULID と時刻を含まない列だけ**を見る（`auditFreeText()` の注記）。
    const freeText = auditFreeText(fake);
    for (const value of [
      "SPECIFIED_SKILLED_1", // 種別
      "特定技能1号", // 表示名
      "2024-03-31", // 在留期限
      "2023-12-01", // 更新申請日
      "更新手続きの控え", // ノート
      "2023-08-20", // 退職日
    ]) {
      expect(freeText, value).not.toContain(value);
    }

    // ── ③ 氏名は元から持っていない ────────────────────────────
    // `runResidencyRetention()` は台帳と在留資格しか受け取らず、`user` を
    // 引かない。**入りようが無いことを、渡した値の側から固定する。**
    expect(JSON.stringify(residencyRow(id))).not.toContain("displayName");
  });

  it("**検査が ULID と時刻を見ていない**（偶然で落ちる検査を残さない）", async () => {
    // この spec は以前、パラメータ全体を `JSON.stringify()` して
    // 「28」（週の上限時間）を探していた。**その中には毎回変わる
    // ULID が混ざる**ので、26 桁に `28` が並んだ回だけ落ちていた
    // （実測 2.4%）。ここで「見ている列に ULID も時刻も入らない」ことを
    // 固定し、同じ壊れ方が戻らないようにする。
    const fake = createFakeD1();
    const id = staffId("ABCDEFGH");

    await runResidencyRetention(envOf(fake), CTX, {
      ledger: [ledgerRow({ id, workStatus: "RESIGNED", resignedOn: "2023-08-20" })],
      residency: [residencyRow(id)],
      businessDate: BUSINESS_DATE,
    });

    const columns = auditColumns(fake);
    const auditId = String(columns["id"]);
    // 生成された ID であること（固定値に差し替えて逃げていない）。
    expect(auditId).toMatch(
      new RegExp(`^${TEST_ORG.orgShortId}__audit_[0-9A-HJKMNP-TV-Z]{26}$`),
    );

    const freeText = auditFreeText(fake);
    expect(freeText, "ULID を見ている").not.toContain(auditId);
    expect(freeText, "時刻を見ている").not.toContain(String(columns["at"]));
    // 見ているのは `before` / `after` / `reason` の 3 列だけ。
    expect(freeText).toBe(JSON.stringify([null, '{"deleted":1}', null]));
  });

  it("**削除済みの情報を監査ログから復元できない**（誰のものかが残らない）", async () => {
    const fake = createFakeD1();
    const id = staffId("ABCDEFGH");

    await runResidencyRetention(envOf(fake), CTX, {
      ledger: [ledgerRow({ id, workStatus: "RESIGNED", resignedOn: "2023-08-20" })],
      residency: [residencyRow(id)],
      businessDate: BUSINESS_DATE,
    });

    const columns = auditColumns(fake);
    // スタッフの ID も、在留資格の行の ID も載らない。**列で見る** —
    // `params` の要素比較は完全一致なので偶然は起きないが、どの列に
    // 入っていないのかが読めるようにしておく。
    expect(columns["target_id"]).toBeNull();
    expect(columns["property_id"]).toBeNull();
    expect(auditFreeText(fake)).not.toContain(id);
    expect(auditFreeText(fake)).not.toContain(residencyRow(id).id);
    // `after` に載るのは件数だけ。**完全一致。**
    expect(auditPayload(fake, "after")).toEqual({ deleted: 1 });
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
