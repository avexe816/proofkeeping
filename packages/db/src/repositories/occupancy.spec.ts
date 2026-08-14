/**
 * 稼働記録の取込（P4-02 / PK-SPEC-P4 §8.1・§10.2）。
 *
 * 組織条件の強制注入と越境 ID は `repositories.spec.ts` と
 * `tests/tenant-isolation/occupancy.spec.ts` が見ている。
 * ここは**冪等性と差分**を見る。
 *
 * ── 何を固定しているか ──────────────────────────────────
 * §10.2「CSV を 3 回取込んでも OccupancySnapshot が重複しない」。
 * 一意索引に頼るだけでは「INSERT が 3 回走って 2 回落ちる」形でも
 * 通ってしまう。**内容が同じなら書き込みを 1 度も出さない**ところまで
 * 固定する（`importedAt` が動くと、いつ入った記録なのかが読めなくなる）。
 */

import { describe, expect, it } from "vitest";

import { generateId } from "../id.js";
import { createFakeD1, createFakeEnv, TEST_ORG, tenantContext } from "../test-support/fake-d1.js";

import {
  MAX_AUDIT_CHANGES,
  upsertOccupancySnapshots,
  type OccupancySnapshotInput,
  type UpsertOccupancyParams,
} from "./occupancy.js";

const PROPERTY = generateId(TEST_ORG.orgShortId, "prop");
const ROOM_A = generateId(TEST_ORG.orgShortId, "room");
const ROOM_B = generateId(TEST_ORG.orgShortId, "room");
const MEMBER = generateId(TEST_ORG.orgShortId, "mem");

const PARAMS: UpsertOccupancyParams = {
  propertyId: PROPERTY,
  businessDate: "2026-09-09",
  source: "CSV_IMPORT",
  importedById: MEMBER,
};

/** 稼働あり 1 室ぶんの入力。 */
function occupied(roomId: string, overrides: Partial<OccupancySnapshotInput> = {}): OccupancySnapshotInput {
  return {
    roomId,
    isOccupied: true,
    guestCount: 2,
    adultCount: 0,
    childCount: 0,
    reservationRef: "RSV-8891",
    channelCode: null,
    checkInAt: Date.parse("2026-09-09T15:20:00+09:00"),
    checkOutAt: null,
    isStayover: false,
    nightsTotal: 3,
    nightIndex: 1,
    ratePlanCode: null,
    isComplimentary: false,
    isHouseUse: false,
    rawPayload: null,
    ...overrides,
  };
}

/**
 * 既存行の代役。**列の順は `upsertOccupancySnapshots()` の `select()` と同じ。**
 * `select({...})` は `raw()` を通るので配列で積む。
 */
function storedRow(roomId: string, input: OccupancySnapshotInput): unknown[] {
  return [
    generateId(TEST_ORG.orgShortId, "occ"),
    roomId,
    input.isOccupied ? 1 : 0,
    input.guestCount,
    input.adultCount,
    input.childCount,
    input.reservationRef,
    input.channelCode,
    input.checkInAt,
    input.checkOutAt,
    input.isStayover ? 1 : 0,
    input.nightsTotal,
    input.nightIndex,
    input.ratePlanCode,
    input.isComplimentary ? 1 : 0,
    input.isHouseUse ? 1 : 0,
  ];
}

/** 書き込み系の文だけを数える。 */
function writeQueries(fake: ReturnType<typeof createFakeD1>): string[] {
  return fake.queries
    .map((query) => query.sql)
    .filter((sql) => /^\s*(insert|update|delete)/i.test(sql));
}

describe("upsertOccupancySnapshots — 初回の取込", () => {
  it("既存行が無ければ挿入する", async () => {
    const fake = createFakeD1();
    const result = await upsertOccupancySnapshots(createFakeEnv(fake), tenantContext(), PARAMS, [
      occupied(ROOM_A),
      occupied(ROOM_B, { isOccupied: false, guestCount: 0 }),
    ]);

    expect(result).toMatchObject({ inserted: 2, updated: 0, unchanged: 0 });
    expect(writeQueries(fake)).toHaveLength(2);
    expect(writeQueries(fake).every((sql) => /^insert/i.test(sql))).toBe(true);
  });

  it("空の並びでは 1 文も書かない", async () => {
    const fake = createFakeD1();
    const result = await upsertOccupancySnapshots(
      createFakeEnv(fake),
      tenantContext(),
      PARAMS,
      [],
    );

    expect(result).toMatchObject({ inserted: 0, updated: 0, unchanged: 0 });
    expect(writeQueries(fake)).toEqual([]);
  });

  it("既存行を読むときに取込元で絞る（取込元をまたいで潰さない / DECISIONS #106）", async () => {
    const fake = createFakeD1();
    await upsertOccupancySnapshots(createFakeEnv(fake), tenantContext(), PARAMS, [
      occupied(ROOM_A),
    ]);

    const select = fake.queries[0];
    expect(select?.sql).toMatch(/select/i);
    expect(select?.params).toContain("CSV_IMPORT");
    expect(select?.params).toContain(TEST_ORG.organizationId);
    expect(select?.params).toContain("2026-09-09");
  });
});

describe("upsertOccupancySnapshots — 再取込（§10.2）", () => {
  it("内容が同じなら書き込みを 1 文も出さない", async () => {
    const fake = createFakeD1();
    const input = occupied(ROOM_A);
    fake.enqueueRows([storedRow(ROOM_A, input)]);

    const result = await upsertOccupancySnapshots(createFakeEnv(fake), tenantContext(), PARAMS, [
      input,
    ]);

    expect(result).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect(result.changes).toEqual([]);
    expect(writeQueries(fake)).toEqual([]);
  });

  it("3 回取込んでも行が増えない", async () => {
    const input = occupied(ROOM_A);

    // 1 回目。既存行なし → 挿入 1。
    const first = createFakeD1();
    const firstResult = await upsertOccupancySnapshots(
      createFakeEnv(first),
      tenantContext(),
      PARAMS,
      [input],
    );
    expect(firstResult).toMatchObject({ inserted: 1, unchanged: 0 });

    // 2 回目・3 回目。1 回目が入れた行が返る → 書き込みゼロ。
    for (const attempt of [2, 3]) {
      const fake = createFakeD1();
      fake.enqueueRows([storedRow(ROOM_A, input)]);
      const result = await upsertOccupancySnapshots(
        createFakeEnv(fake),
        tenantContext(),
        PARAMS,
        [input],
      );
      expect(result, `${String(attempt)} 回目`).toMatchObject({
        inserted: 0,
        updated: 0,
        unchanged: 1,
      });
      expect(writeQueries(fake), `${String(attempt)} 回目`).toEqual([]);
    }
  });

  it("値が変わった行だけを更新する", async () => {
    const fake = createFakeD1();
    const stored = occupied(ROOM_A);
    const other = occupied(ROOM_B);
    fake.enqueueRows([storedRow(ROOM_A, stored), storedRow(ROOM_B, other)]);

    const result = await upsertOccupancySnapshots(createFakeEnv(fake), tenantContext(), PARAMS, [
      { ...stored, guestCount: 3 },
      other,
    ]);

    expect(result).toMatchObject({ inserted: 0, updated: 1, unchanged: 1 });
    expect(writeQueries(fake)).toHaveLength(1);
    expect(writeQueries(fake)[0]).toMatch(/^update/i);
  });

  it("既存と新規が混ざっても取り違えない", async () => {
    const fake = createFakeD1();
    const stored = occupied(ROOM_A);
    fake.enqueueRows([storedRow(ROOM_A, stored)]);

    const result = await upsertOccupancySnapshots(createFakeEnv(fake), tenantContext(), PARAMS, [
      stored,
      occupied(ROOM_B),
    ]);

    expect(result).toMatchObject({ inserted: 1, updated: 0, unchanged: 1 });
  });
});

describe("upsertOccupancySnapshots — 差分の記録（§8.1 MUST）", () => {
  it("変わった項目を before / after で返す", async () => {
    const fake = createFakeD1();
    const stored = occupied(ROOM_A);
    fake.enqueueRows([storedRow(ROOM_A, stored)]);

    const result = await upsertOccupancySnapshots(createFakeEnv(fake), tenantContext(), PARAMS, [
      { ...stored, isOccupied: false, guestCount: 0 },
    ]);

    expect(result.changes).toEqual([
      { roomId: ROOM_A, field: "isOccupied", before: true, after: false },
      { roomId: ROOM_A, field: "guestCount", before: 2, after: 0 },
    ]);
    expect(result.changesTruncated).toBe(false);
  });

  it("時刻の変化を epoch で比べる（Date と number を取り違えない）", async () => {
    const fake = createFakeD1();
    const stored = occupied(ROOM_A);
    fake.enqueueRows([storedRow(ROOM_A, stored)]);

    // 同じ時刻を渡したら「変わっていない」。
    const result = await upsertOccupancySnapshots(createFakeEnv(fake), tenantContext(), PARAMS, [
      stored,
    ]);
    expect(result.unchanged).toBe(1);
  });

  it("null への変化を拾う", async () => {
    const fake = createFakeD1();
    const stored = occupied(ROOM_A);
    fake.enqueueRows([storedRow(ROOM_A, stored)]);

    const result = await upsertOccupancySnapshots(createFakeEnv(fake), tenantContext(), PARAMS, [
      { ...stored, reservationRef: null },
    ]);

    expect(result.changes).toEqual([
      { roomId: ROOM_A, field: "reservationRef", before: "RSV-8891", after: null },
    ]);
  });

  it("差分が上限を超えたら切り、切ったことを示す", async () => {
    const fake = createFakeD1();
    // 1 室あたり 2 項目ずつ変える → 上限の 2 倍を超える室数を用意する。
    const rooms = Array.from({ length: MAX_AUDIT_CHANGES }, () =>
      generateId(TEST_ORG.orgShortId, "room"),
    );
    fake.enqueueRows(rooms.map((roomId) => storedRow(roomId, occupied(roomId))));

    const result = await upsertOccupancySnapshots(
      createFakeEnv(fake),
      tenantContext(),
      PARAMS,
      rooms.map((roomId) => occupied(roomId, { guestCount: 4, nightIndex: 2 })),
    );

    expect(result.updated).toBe(MAX_AUDIT_CHANGES);
    expect(result.changes).toHaveLength(MAX_AUDIT_CHANGES);
    expect(result.changesTruncated).toBe(true);
  });
});

describe("upsertOccupancySnapshots — 越境", () => {
  it("別組織の施設 ID を渡すと落ちる", async () => {
    const fake = createFakeD1();
    await expect(
      upsertOccupancySnapshots(
        createFakeEnv(fake),
        tenantContext(),
        { ...PARAMS, propertyId: "zzzzzz__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH" },
        [occupied(ROOM_A)],
      ),
    ).rejects.toThrow();
    expect(fake.queries).toEqual([]);
  });

  it("別組織の客室 ID を渡すと、1 文も出さずに落ちる", async () => {
    const fake = createFakeD1();
    await expect(
      upsertOccupancySnapshots(createFakeEnv(fake), tenantContext(), PARAMS, [
        occupied(ROOM_A),
        occupied("zzzzzz__room_01JBXQ3ZK8N4P2VYR6ABCDEFGH"),
      ]),
    ).rejects.toThrow();
    // **並びの途中で落ちても、先頭だけが入った状態を作らない。**
    expect(fake.queries).toEqual([]);
  });
});
