/**
 * テナントのスナップショット（PF-02 / DECISIONS #220 の 2）。
 *
 * 完了条件:
 *   - コンシューマを 3 回流して結果が変わらない（冪等 / testing.md §4）
 *   - 1 メッセージが 2 つ以上のテナントに触れていない
 *   - スナップショットに個人を特定できる列が無い（走査テスト）
 *   - シャード番号が列にもレスポンスにもログにも出ない
 *
 * ── 行の積み方 ──────────────────────────────────────────
 * `FakeD1` は**実行順**に積んだ行を返す。`Promise.all` の中の読み取りは
 * 配列の順に発行されるので、`prime()` の順序が読み取りの順序と一致する
 * （`residencyAlert.spec.ts` と同じ前提）。
 *
 * 列の並びは `rowFor()`（`@pk/db/test-support`）がスキーマから作る。
 * **列が増えてもズレない**（手で並べた配列にすると、増えた日に静かに壊れる）。
 */

import { organization, subscription, type Env } from "@pk/db";
import { createFakeD1, createFakeEnv, rowFor, TEST_ORG, type FakeD1 } from "@pk/db/test-support";
import { describe, expect, it } from "vitest";

import {
  handleTenantSnapshotBatch,
  isTenantSnapshotMessage,
  runTenantSnapshot,
  type TenantSnapshotMessage,
} from "./tenantSnapshot.js";

/** 2026-08-20 の 02:00 JST（= 前日 17:00 UTC）。業務日は 2026-08-19。 */
const NOW = new Date("2026-08-19T17:00:00.000Z");
const BUSINESS_DATE = "2026-08-19";

const MESSAGE: TenantSnapshotMessage = {
  kind: "TENANT_SNAPSHOT",
  orgShortId: TEST_ORG.orgShortId,
  requestedAtMs: NOW.getTime(),
};

/** 別テナントの ID。**1 通がここへ触れていないことを見る。** */
const OTHER_ORG_ID = "zzzzzz__org_01JBXQ3ZK8N4P2VYR6ZZZZZZ";

/**
 * 9 クエリぶんを積む。**呼び出し順 = 積む順。**
 *
 *   ① `lookupOrganizationId()`
 *   ②〜⑦ `findOrganization` / `findSubscription` / `listProperties` /
 *         `countRooms` / `countSellableRoomsByProperty` /
 *         `countActiveMembershipsByRole`
 *   ⑧〜⑩ `listPropertyRollups` / `summarizeObservationInput` /
 *         `countSkippedObservations`
 */
function prime(fake: FakeD1, overrides: { propertyCount?: number } = {}): void {
  fake.enqueueRows([[TEST_ORG.organizationId]]);
  fake.enqueueRows([
    rowFor(organization, {
      id: TEST_ORG.organizationId,
      organization_id: TEST_ORG.organizationId,
      org_short_id: TEST_ORG.orgShortId,
      name: "サンプル運営株式会社",
      created_at: Date.parse("2025-06-01T00:00:00.000Z"),
      updated_at: Date.parse("2025-06-01T00:00:00.000Z"),
    }),
  ]);
  fake.enqueueRows([
    rowFor(subscription, {
      id: `${TEST_ORG.orgShortId}__sub_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
      organization_id: TEST_ORG.organizationId,
      plan: "PRO",
      status: "ACTIVE",
      billing_cycle: "MONTHLY",
      created_at: Date.parse("2025-06-01T00:00:00.000Z"),
      updated_at: Date.parse("2025-06-01T00:00:00.000Z"),
    }),
  ]);
  // listProperties（`select()` の全列だが、使うのは件数だけ）。
  const properties = overrides.propertyCount ?? 2;
  fake.enqueueRows(Array.from({ length: properties }, () => [null]));
  fake.enqueueRows([[40]]); // countRooms
  fake.enqueueRows([
    ["p1", 20],
    ["p2", 16],
  ]); // countSellableRoomsByProperty
  fake.enqueueRows([
    ["CLEANER", 8],
    ["INSPECTOR", 2],
  ]); // countActiveMembershipsByRole
  // listPropertyRollups（全列）。使うのは completedTasks だけなので、
  // 列名で置いて位置に依存しない形にする。
  fake.enqueueRows([
    [
      "r1",
      TEST_ORG.organizationId,
      "p1",
      BUSINESS_DATE,
      /* totalTasks */ 30,
      /* completedTasks */ 24,
    ],
    [
      "r2",
      TEST_ORG.organizationId,
      "p2",
      BUSINESS_DATE,
      /* totalTasks */ 20,
      /* completedTasks */ 16,
    ],
  ]);
  // summarizeObservationInput（usedDefaults / inputDurationMs）。
  fake.enqueueRows([
    [1, 12_000],
    [0, 8_000],
    [1, 20_000],
  ]);
  fake.enqueueRows([[3]]); // countSkippedObservations
}

function snapshotInsert(fake: FakeD1) {
  return fake.queries.find((query) =>
    query.sql.toLowerCase().includes('insert into "platform_tenant_snapshot"'),
  );
}

describe("isTenantSnapshotMessage", () => {
  it("`kind` の無いメッセージを受け取らない（ROLLUP_UPDATE と相乗り）", () => {
    expect(isTenantSnapshotMessage(MESSAGE)).toBe(true);
    expect(
      isTenantSnapshotMessage({ kind: "ROLLUP_UPDATE", orgShortId: "abc123", requestedAtMs: 1 }),
    ).toBe(false);
    expect(isTenantSnapshotMessage({ kind: "TENANT_SNAPSHOT", orgShortId: "" })).toBe(false);
    expect(isTenantSnapshotMessage(null)).toBe(false);
  });
});

describe("runTenantSnapshot", () => {
  it("SHARD_00 へ 1 行書く", async () => {
    const fake = createFakeD1();
    prime(fake);
    const outcome = await runTenantSnapshot(createFakeEnv(fake), MESSAGE);

    expect(outcome).toEqual({ kind: "OK", businessDate: BUSINESS_DATE });
    const insert = snapshotInsert(fake);
    expect(insert).toBeDefined();
    // 組織 ID と業務日が載る。**1 テナント 1 業務日 1 行。**
    expect(insert?.params).toContain(TEST_ORG.organizationId);
    expect(insert?.params).toContain(BUSINESS_DATE);
  });

  it("完了タスク数は rollup の施設合計（タスク表を直に数えない）", async () => {
    const fake = createFakeD1();
    prime(fake);
    await runTenantSnapshot(createFakeEnv(fake), MESSAGE);

    // 24 + 16 = 40。
    expect(snapshotInsert(fake)?.params).toContain(40);
    // **`cleaning_task` から COUNT していない**（observationSkipped の
    // 1 本を除いて、タスク表への集計クエリが無い）。
    const taskAggregates = fake.queries.filter(
      (query) =>
        query.sql.includes('from "cleaning_task"') &&
        query.sql.includes("count(*)") &&
        !query.sql.includes("observation_skipped"),
    );
    expect(taskAggregates).toHaveLength(0);
  });

  it("入力所要時間の中央値を入れる（12,000ms）", async () => {
    const fake = createFakeD1();
    prime(fake);
    await runTenantSnapshot(createFakeEnv(fake), MESSAGE);
    expect(snapshotInsert(fake)?.params).toContain(12_000);
  });

  it("**3 回流しても同じ SQL とパラメータになる**（testing.md §4）", async () => {
    const runs: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fake = createFakeD1();
      prime(fake);
      await runTenantSnapshot(createFakeEnv(fake), MESSAGE);
      runs.push(JSON.stringify(snapshotInsert(fake)));
    }
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });

  it("**2 回目に別 ID の行を作ろうとしない**（`id` が組織と業務日から決まる）", async () => {
    const fake = createFakeD1();
    prime(fake);
    await runTenantSnapshot(createFakeEnv(fake), MESSAGE);
    const first = snapshotInsert(fake)?.params[0];

    const second = createFakeD1();
    prime(second);
    await runTenantSnapshot(createFakeEnv(second), MESSAGE);
    expect(snapshotInsert(second)?.params[0]).toBe(first);
    // 衝突したら**上書き**する（再計算方式）。
    expect(snapshotInsert(fake)?.sql).toContain("on conflict");
  });

  it("**1 メッセージが 2 つ以上のテナントに触れない**（完了条件）", async () => {
    const fake = createFakeD1();
    prime(fake);
    await runTenantSnapshot(createFakeEnv(fake), MESSAGE);

    for (const query of fake.queries) {
      expect(query.params).not.toContain(OTHER_ORG_ID);
    }
    // テナントの読み取りは全部この組織で絞られている。
    const tenantReads = fake.queries.filter((query) => query.sql.includes('from "organization"'));
    expect(tenantReads.length).toBeGreaterThan(0);
    for (const query of tenantReads) {
      expect(query.params).toContain(TEST_ORG.organizationId);
    }
  });

  it("組織が引けなければ落とす（再送しても直らない）", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([]); // lookupOrganizationId → null
    const outcome = await runTenantSnapshot(createFakeEnv(fake), MESSAGE);
    expect(outcome).toEqual({ kind: "DROPPED", reason: "ORGANIZATION_NOT_FOUND" });
    expect(snapshotInsert(fake)).toBeUndefined();
  });

  it("組織の行が無ければ落とす", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([[TEST_ORG.organizationId]]);
    fake.enqueueRows([]); // findOrganization → undefined
    fake.enqueueRows([]);
    fake.enqueueRows([]);
    fake.enqueueRows([[0]]);
    fake.enqueueRows([]);
    fake.enqueueRows([]);
    const outcome = await runTenantSnapshot(createFakeEnv(fake), MESSAGE);
    expect(outcome).toEqual({ kind: "DROPPED", reason: "ORGANIZATION_MISSING" });
  });

  it("D1 が落ちたら FAILED（retry させる）", async () => {
    const fake = createFakeD1();
    prime(fake);
    let prepared = 0;
    const env: Env = {
      ...createFakeEnv(fake),
      SHARD_00: new Proxy(fake.database, {
        get(target, property, receiver) {
          if (property === "prepare") {
            prepared += 1;
            if (prepared > 1) {
              return () => {
                throw new Error("D1_ERROR");
              };
            }
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      }),
    };
    const outcome = await runTenantSnapshot(env, MESSAGE);
    expect(outcome.kind).toBe("FAILED");
  });
});

describe("運営面へ個人を渡さない（INV-10 / 完了条件）", () => {
  it("スナップショットの INSERT に氏名・メール・端末の列が無い", async () => {
    const fake = createFakeD1();
    prime(fake);
    await runTenantSnapshot(createFakeEnv(fake), MESSAGE);

    const sql = snapshotInsert(fake)?.sql ?? "";
    for (const forbidden of [
      "display_name",
      "staff_number",
      "email",
      "device",
      "recorded_by",
      "user_id",
      "membership_id",
    ]) {
      expect(sql).not.toContain(forbidden);
    }
  });

  it("観察記録の読み取りが記録者を選んでいない", async () => {
    const fake = createFakeD1();
    prime(fake);
    await runTenantSnapshot(createFakeEnv(fake), MESSAGE);

    const observationReads = fake.queries.filter((query) =>
      query.sql.includes('from "room_observation"'),
    );
    expect(observationReads.length).toBeGreaterThan(0);
    for (const query of observationReads) {
      expect(query.sql).not.toContain("recorded_by_id");
    }
  });

  it("シャード番号の列が無い（architecture.md §1）", async () => {
    const fake = createFakeD1();
    prime(fake);
    await runTenantSnapshot(createFakeEnv(fake), MESSAGE);
    expect(snapshotInsert(fake)?.sql).not.toContain("shard");
  });
});

describe("handleTenantSnapshotBatch", () => {
  function messageOf(body: unknown) {
    const calls = { acked: 0, retried: 0 };
    return {
      calls,
      message: {
        body,
        ack: () => {
          calls.acked += 1;
        },
        retry: () => {
          calls.retried += 1;
        },
      },
    };
  }

  it("形の違うメッセージは ack して落とす（再送しても直らない）", async () => {
    const fake = createFakeD1();
    const entry = messageOf({ kind: "TENANT_SNAPSHOT" });
    await handleTenantSnapshotBatch(createFakeEnv(fake), {
      messages: [entry.message],
    } as unknown as MessageBatch);
    expect(entry.calls).toEqual({ acked: 1, retried: 0 });
  });

  it("成功したら ack する", async () => {
    const fake = createFakeD1();
    prime(fake);
    const entry = messageOf(MESSAGE);
    await handleTenantSnapshotBatch(createFakeEnv(fake), {
      messages: [entry.message],
    } as unknown as MessageBatch);
    expect(entry.calls).toEqual({ acked: 1, retried: 0 });
  });
});
