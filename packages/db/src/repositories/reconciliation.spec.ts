/**
 * 照合の実行と差異（P4-05 / PK-SPEC-P4 §5.3・§10.2）。
 *
 * 組織条件の強制注入と越境 ID は `repositories.spec.ts` と
 * `tests/tenant-isolation/reconciliation.spec.ts` が見ている。
 * ここは**冪等性と「人が付けた判断を上書きしない」**ところを見る。
 *
 * ── 何を固定しているか ──────────────────────────────────
 * §10.2「3 回再実行しても Finding が重複しない」。一意索引に頼るだけでは
 * 「INSERT が 3 回走って 2 回落ちる」形でも通ってしまう。**既にある差異には
 * 書き込みを 1 文も出さない**ところまで固定する（`status` を人が動かした行が
 * 再実行で `OPEN` に戻らないのは、この 1 点で決まっている）。
 */

import { describe, expect, it } from "vitest";

import { generateId } from "../id.js";
import { createFakeD1, createFakeEnv, TEST_ORG, tenantContext } from "../test-support/fake-d1.js";

import {
  finishReconciliationRun,
  insertFindings,
  startReconciliationRun,
  type FindingInput,
} from "./reconciliation.js";

const PROPERTY = generateId(TEST_ORG.orgShortId, "prop");
const ROOM_A = generateId(TEST_ORG.orgShortId, "room");
const ROOM_B = generateId(TEST_ORG.orgShortId, "room");
const RUN = generateId(TEST_ORG.orgShortId, "run");

const PARAMS = { runId: RUN, propertyId: PROPERTY, businessDate: "2026-09-09" };

function finding(roomId: string, overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    roomId,
    ruleCode: "R001",
    ruleVersion: "1.0",
    severity: "HIGH",
    confidence: 80,
    title: "302 号室：稼働記録のない使用痕跡",
    summary: "稼働記録では空室ですが、清掃時に 4 種類の使用痕跡が記録されています。",
    evidence: { occupancy: { isOccupied: false } },
    matchedSignals: ["BEDS_USED", "TRASH_PRESENT"],
    ...overrides,
  };
}

/** 既存行の代役。**列の順は `insertFindings()` の `select()` と同じ。** */
function storedFinding(roomId: string, ruleCode: string): unknown[] {
  return [roomId, ruleCode];
}

/** 書き込み系の文だけを数える。 */
function writeQueries(fake: ReturnType<typeof createFakeD1>): string[] {
  return fake.queries
    .map((query) => query.sql)
    .filter((sql) => /^\s*(insert|update|delete)/i.test(sql));
}

describe("insertFindings — 初回", () => {
  it("既存が無ければ 1 文でまとめて挿入する", async () => {
    const fake = createFakeD1();

    const result = await insertFindings(createFakeEnv(fake), tenantContext(), PARAMS, [
      finding(ROOM_A),
      finding(ROOM_B),
    ]);

    expect(result).toEqual({ created: 2, existing: 0 });
    expect(writeQueries(fake)).toHaveLength(1);
    expect(writeQueries(fake)[0]).toMatch(/^insert/i);
  });

  it("差異が 1 件も無ければ読みにも行かない", async () => {
    const fake = createFakeD1();

    const result = await insertFindings(createFakeEnv(fake), tenantContext(), PARAMS, []);

    expect(result).toEqual({ created: 0, existing: 0 });
    expect(fake.queries).toEqual([]);
  });

  it("既存を読むときに施設と業務日で絞る", async () => {
    const fake = createFakeD1();
    await insertFindings(createFakeEnv(fake), tenantContext(), PARAMS, [finding(ROOM_A)]);

    const select = fake.queries[0];
    expect(select?.sql).toMatch(/select/i);
    expect(select?.params).toContain(TEST_ORG.organizationId);
    expect(select?.params).toContain(PROPERTY);
    expect(select?.params).toContain("2026-09-09");
  });
});

describe("insertFindings — 再実行（§5.3 MUST / §10.2）", () => {
  it("同じ差異が既にあれば書き込みを 1 文も出さない", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([storedFinding(ROOM_A, "R001")]);

    const result = await insertFindings(createFakeEnv(fake), tenantContext(), PARAMS, [
      finding(ROOM_A),
    ]);

    expect(result).toEqual({ created: 0, existing: 1 });
    expect(writeQueries(fake)).toEqual([]);
  });

  it("確信度や文言が変わっていても既存行に触らない（人の判断を守る）", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([storedFinding(ROOM_A, "R001")]);

    const result = await insertFindings(createFakeEnv(fake), tenantContext(), PARAMS, [
      finding(ROOM_A, { confidence: 95, severity: "MEDIUM", summary: "書き換えた文" }),
    ]);

    expect(result).toEqual({ created: 0, existing: 1 });
    expect(writeQueries(fake)).toEqual([]);
  });

  it("新しく出た差異だけを足す", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([storedFinding(ROOM_A, "R001")]);

    const result = await insertFindings(createFakeEnv(fake), tenantContext(), PARAMS, [
      finding(ROOM_A),
      finding(ROOM_B),
    ]);

    expect(result).toEqual({ created: 1, existing: 1 });
    expect(writeQueries(fake)).toHaveLength(1);
  });

  it("同じ客室でもルールが違えば別の差異", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([storedFinding(ROOM_A, "R001")]);

    const result = await insertFindings(createFakeEnv(fake), tenantContext(), PARAMS, [
      finding(ROOM_A, { ruleCode: "R006" }),
    ]);

    expect(result).toEqual({ created: 1, existing: 0 });
  });

  it("同じ照合の中で同じ鍵が 2 度来ても 1 行しか作らない", async () => {
    const fake = createFakeD1();

    const result = await insertFindings(createFakeEnv(fake), tenantContext(), PARAMS, [
      finding(ROOM_A),
      finding(ROOM_A),
    ]);

    expect(result).toEqual({ created: 1, existing: 1 });
  });

  it("3 回続けて実行しても増えるのは 1 回目だけ", async () => {
    const env = createFakeEnv(createFakeD1());
    const first = await insertFindings(env, tenantContext(), PARAMS, [finding(ROOM_A)]);

    // 2 回目・3 回目は既存として返る（D1 が同じ鍵を返す状態を作る）。
    const later = [];
    for (const attempt of [2, 3]) {
      void attempt;
      const fake = createFakeD1();
      fake.enqueueRows([storedFinding(ROOM_A, "R001")]);
      later.push(
        await insertFindings(createFakeEnv(fake), tenantContext(), PARAMS, [finding(ROOM_A)]),
      );
    }

    expect(first.created).toBe(1);
    expect(later.map((result) => result.created)).toEqual([0, 0]);
  });
});

describe("startReconciliationRun — 同じ版の再実行は同じ Run（§5.3 MUST）", () => {
  it("既存が無ければ作る", async () => {
    const fake = createFakeD1();

    const result = await startReconciliationRun(createFakeEnv(fake), tenantContext(), {
      propertyId: PROPERTY,
      businessDate: "2026-09-09",
      engineVersion: "1.0",
      rulesetHash: "00000000",
      availableSources: ["occupancy", "observation"],
    });

    expect(result.created).toBe(true);
    expect(writeQueries(fake)[0]).toMatch(/^insert/i);
  });

  it("同じ (施設, 業務日, 版) が既にあれば作らず開き直す", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([[RUN, "COMPLETED"]]);

    const result = await startReconciliationRun(createFakeEnv(fake), tenantContext(), {
      propertyId: PROPERTY,
      businessDate: "2026-09-09",
      engineVersion: "1.0",
      rulesetHash: "00000000",
      availableSources: ["observation"],
    });

    expect(result).toMatchObject({ id: RUN, created: false, previousStatus: "COMPLETED" });
    expect(writeQueries(fake)[0]).toMatch(/^update/i);
  });
});

describe("finishReconciliationRun — 件数は置き換える（加算しない）", () => {
  it("渡した件数だけを書く", async () => {
    const fake = createFakeD1();

    await finishReconciliationRun(createFakeEnv(fake), tenantContext(), {
      runId: RUN,
      status: "COMPLETED",
      roomsEvaluated: 12,
      findingsCreated: 3,
      findingsSuppressed: 4,
    });

    const update = writeQueries(fake)[0] ?? "";
    expect(update).toMatch(/^update/i);
    // **加算の式を書かない。** `x = x + ?` の形が入ると再実行で二重に増える。
    expect(update).not.toMatch(/\+\s*\?/);
  });
});
