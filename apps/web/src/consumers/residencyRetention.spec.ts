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

/**
 * 監査ログの INSERT を**列ごとの枠**に割る（DECISIONS #272）。
 *
 * ── なぜ列に割るのか ────────────────────────────────────
 * 以前はパラメータ全体を `JSON.stringify()` して部分文字列を探していた。
 * **その中には毎回変わる ULID（`audit_log.id`）と時刻が混ざる。**
 * 週の上限時間「28」のような短い値を探すと、**ULID にたまたま `28` が
 * 並んだ回だけ落ちる**（26 桁 Crockford base32 で実測 2.4%）。
 * 列に割れば、**見たい列だけ**を見られる。
 *
 * ── `?` とは限らない ────────────────────────────────────
 * 消す回の `after` は束縛値ではなく **`json_object(...)` の式**
 * （DELETE と同じ batch で数える / #271）。枠には SQL の断片と、
 * その中で束縛された値の両方を入れる。
 */
interface AuditSlot {
  /** その列に置かれた SQL（束縛なら `"?"`）。 */
  sql: string;
  /** その枠の中で束縛された値。 */
  params: unknown[];
}

function auditSlots(fake: FakeD1): Record<string, AuditSlot> {
  const insert = auditInserts(fake)[0];
  if (insert === undefined) throw new Error("residency.deleted の監査ログが書かれていない");

  const columns = /insert into "[^"]+" \(([^)]*)\) values \(/.exec(insert.sql);
  if (columns === null) throw new Error(`INSERT の列が読めない: ${insert.sql}`);
  const names = (columns[1] ?? "").split(",").map((name) => name.trim().replaceAll('"', ""));

  // `values (` の直後から末尾の `)` の手前まで。**括弧の深さを数えて割る** —
  // `json_object('deleted', (select ...))` の中のカンマで切らないため。
  const body = insert.sql.slice(columns.index + columns[0].length, -1);
  const slots: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      slots.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  slots.push(current.trim());

  if (slots.length !== names.length) {
    throw new Error(`列 ${String(names.length)} と枠 ${String(slots.length)} が合わない`);
  }

  let cursor = 0;
  return Object.fromEntries(
    names.map((name, index) => {
      const sql = slots[index] ?? "";
      const bound = (sql.match(/\?/g) ?? []).length;
      const params = insert.params.slice(cursor, cursor + bound);
      cursor += bound;
      return [name, { sql, params }];
    }),
  );
}

/**
 * 監査ログのうち**自由記述が入りうる列だけ**を連ねた文字列。
 *
 * **ここに `id`（ULID）も `at`（時刻）も入れない。** 「この値が残って
 * いないこと」を見るための材料で、生成のたびに変わる値を混ぜると
 * 偶然で落ちる。
 *
 * **`after` の束縛値は入れない。** 消す回の `after` は
 * `json_object('deleted', (select count(*) ... where staff_profile_id in (?)))`
 * で、**数えるための条件として `staffProfileId` が束縛される。**
 * 保存されるのは件数だけで、それは `residencyRetention.db.spec.ts` が
 * 実物の行で確かめる。ここが見るのは SQL の形。
 */
function auditFreeText(fake: FakeD1): string {
  const slots = auditSlots(fake);
  const pick = (name: string): unknown[] => [slots[name]?.sql, ...(slots[name]?.params ?? [])];
  return JSON.stringify([
    ...pick("before"),
    ...pick("reason"),
    ...pick("target_id"),
    ...pick("target_type"),
    // `after` は**形だけ**（束縛値は上の注記のとおり除く）。
    slots["after"]?.sql,
  ]);
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

    const slots = auditSlots(fake);
    expect(slots["action"]?.params).toEqual(["residency.deleted"]);
    // 束ねる DELETE がいないので、こちらは値を束縛する経路
    // （`recordEmptyResidencyRetentionRun()`）。**payload を完全一致で見る。**
    const after = JSON.parse(String(slots["after"]?.params[0])) as Record<string, unknown>;
    expect(after).toEqual({ deleted: 0 });
    expect(Object.keys(after)).toEqual(["deleted"]);
    expect(slots["before"]?.params).toEqual([null]);
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

    // ── ① `after` は件数だけを作る形 ──────────────────────────
    // 消す回は `json_object('deleted', …)`。**鍵は `deleted` 1 つだけ。**
    const slots = auditSlots(fake);
    expect(slots["after"]?.sql).toContain("json_object('deleted'");
    expect((slots["after"]?.sql.match(/'[a-z]+'/g) ?? []).length, "鍵が 1 つでない").toBe(1);
    expect(slots["before"]?.params).toEqual([null]);
    expect(slots["target_id"]?.params).toEqual([null]);

    // ── ② 値が写っていないことは**列を絞って**見る ──────────────
    // **`params` 全体を見ない。** ULID と時刻が混ざり、短い値を部分一致で
    // 探すと偶然で落ちる（`auditSlots()` の注記 / DECISIONS #272）。
    const freeText = auditFreeText(fake);
    for (const value of [
      "SPECIFIED_SKILLED_1", // 種別
      "特定技能1号", // 表示名
      "2024-03-31", // 在留期限
      "2023-12-01", // 更新申請日
      "更新手続きの控え", // ノート
      RESIGNED_LONG_AGO, // 退職日
      `${TEST_ORG.orgShortId}__resd_01JBXQ3ZK8N4P2VYR6ABCDEFGH`, // 在留資格の行 ID
      "28", // 週の上限時間。**ULID を見ていないので短い値も置ける。**
    ]) {
      expect(freeText, value).not.toContain(value);
    }

    // ── ③ 見ている枠に ULID も時刻も入っていない（②の前提）────────
    const auditId = String(auditInserts(fake)[0]?.params[0]);
    expect(auditId).toMatch(
      new RegExp(`^${TEST_ORG.orgShortId}__audit_[0-9A-HJKMNP-TV-Z]{26}$`),
    );
    expect(freeText, "ULID を見ている").not.toContain(auditId);
    expect(freeText, "時刻を見ている").not.toContain(String(slots["at"]?.params[0]));

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
