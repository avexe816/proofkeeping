/**
 * 汎用 Webhook で受けた物理シグナルの取込（P6-04 / PK-SPEC-P6 §4.2）。
 *
 * ルール: .claude/rules/testing.md §4（冪等）
 * 仕様の受け入れ基準: §8.2「重複イベントが排除される」
 *                     「未マッピング客室がスキップとしてカウントされる」
 *                     「actorType 不明時に推測で埋めない」
 *
 * ── どこで何を押さえているか ────────────────────────────
 *   ① メッセージの検証 …… ここ
 *   ② **重複排除** …… ここ。既にある `(deviceId, type, occurredAt)` を
 *      読んでから足すので、同じメッセージを 3 回処理しても INSERT が出ない。
 *   ③ **未マッピングを例外にしない** …… ここ（`recordsSkipped` に寄る）
 *   ④ **`actorType` を推測で埋めない** …… ここ（省略は `null` のまま）
 *   ⑤ 組織条件が載ること …… `packages/db/.../repositories.spec.ts`
 */

import { generateId } from "@pk/db";
import { createFakeD1, createFakeEnv, TEST_ORG, type FakeD1 } from "@pk/db/test-support";
import { describe, expect, it } from "vitest";

import {
  isSignalIngestMessage,
  runSignalIngest,
  type SignalIngestMessage,
} from "./signalIngest.js";

const INTEGRATION_ID = generateId(TEST_ORG.orgShortId, "intg");
const PROPERTY_ID = generateId(TEST_ORG.orgShortId, "prop");
const ROOM_ID = generateId(TEST_ORG.orgShortId, "room");
const SYNC_LOG_ID = generateId(TEST_ORG.orgShortId, "slog");
const MAPPING_ID = generateId(TEST_ORG.orgShortId, "xmap");

const RECEIVED_AT = new Date("2026-09-10T02:00:00.000Z");

const EVENT = {
  deviceId: "LOCK-302",
  type: "DOOR_UNLOCK",
  occurredAt: "2026-09-09T22:14:33+09:00",
};

const MESSAGE: SignalIngestMessage = {
  kind: "SIGNAL_INGEST",
  orgShortId: TEST_ORG.orgShortId,
  integrationId: INTEGRATION_ID,
  events: [EVENT],
  receivedAtMs: RECEIVED_AT.getTime(),
};

/**
 * 取込が引く行を順に積む。
 *
 *   ① `org_directory`（組織の逆引き）
 *   ② `integration`（連携 1 件）
 *   ③ `sync_log` の INSERT（行を返さない）
 *   ④ `external_mapping`（機器 → 客室）
 *   ⑤ `room`（客室 → 施設）
 *   ⑥ `property`（日締め時刻）
 *   ⑦ `physical_signal`（既存の重複）
 */
function primeFake(
  fake: FakeD1,
  options: { mapped?: boolean; existingSignal?: boolean } = {},
): void {
  const mapped = options.mapped ?? true;
  // ① org_directory
  fake.enqueueRows([[TEST_ORG.organizationId]]);
  // ② integration（`select()` の列順は schema の宣言順）
  fake.enqueueRows([
    [
      INTEGRATION_ID,
      TEST_ORG.organizationId,
      PROPERTY_ID,
      "SMART_LOCK",
      "api-generic",
      "汎用 Webhook",
      "ACTIVE",
      "{}",
      null,
      "PULL",
      null,
      null,
      null,
      null,
      null,
      null,
      0,
      RECEIVED_AT.getTime(),
      RECEIVED_AT.getTime(),
    ],
  ]);
  // ③ sync_log の INSERT は行を返さない（`enqueueChanges` の既定 1 で足りる）。
  // ④ external_mapping（`resolveExternalIds()` は 2 列だけ選ぶ）
  fake.enqueueRows(mapped ? [[EVENT.deviceId, ROOM_ID]] : []);
  if (!mapped) return;
  // ⑤ room。`select()` は全列。**先頭 3 列だけが使われる**（id / org / property）。
  fake.enqueueRows([[ROOM_ID, TEST_ORG.organizationId, PROPERTY_ID]]);
  // ⑥ property。`findPropertyById()` も全列。timezone / dayCutoffTime を含む。
  fake.enqueueRows([[PROPERTY_ID, TEST_ORG.organizationId]]);
  // ⑦ physical_signal の既存（3 列）
  fake.enqueueRows(
    options.existingSignal === true
      ? [[EVENT.deviceId, EVENT.type, new Date(EVENT.occurredAt).getTime()]]
      : [],
  );
}

/** 発行された `physical_signal` への INSERT を探す。 */
function signalInsert(queries: readonly { sql: string; params: unknown[] }[]) {
  return queries.find(
    (query) => query.sql.includes("physical_signal") && query.sql.includes("insert"),
  );
}

/** 発行された `sync_log` への UPDATE（`finishSyncLog()`）を探す。 */
function syncLogUpdate(queries: readonly { sql: string; params: unknown[] }[]) {
  return queries.find((query) => query.sql.includes("sync_log") && query.sql.includes("update"));
}

describe("isSignalIngestMessage", () => {
  it("正しい形を受け入れる", () => {
    expect(isSignalIngestMessage(MESSAGE)).toBe(true);
  });

  it("kind が違えば拒む", () => {
    expect(isSignalIngestMessage({ ...MESSAGE, kind: "RECONCILIATION" })).toBe(false);
  });

  it("**照合のメッセージと取り違えない**（同じキューに相乗りしている）", () => {
    expect(
      isSignalIngestMessage({
        kind: "RECONCILIATION",
        organizationId: TEST_ORG.organizationId,
        orgShortId: TEST_ORG.orgShortId,
        propertyId: PROPERTY_ID,
        businessDate: "2026-09-09",
        mode: "AUTO",
        requestedById: null,
        requestedAtMs: 0,
      }),
    ).toBe(false);
  });

  it("欠けた欄があれば拒む", () => {
    const rest: Record<string, unknown> = { ...MESSAGE };
    delete rest["integrationId"];
    expect(isSignalIngestMessage(rest)).toBe(false);
  });

  it("上限を超えるイベント数を拒む", () => {
    expect(isSignalIngestMessage({ ...MESSAGE, events: new Array(501).fill(EVENT) })).toBe(false);
  });

  it("オブジェクトでなければ拒む", () => {
    expect(isSignalIngestMessage(null)).toBe(false);
    expect(isSignalIngestMessage("SIGNAL_INGEST")).toBe(false);
  });
});

describe("runSignalIngest", () => {
  it("組織が引けなければ **ack して捨てる**（再送しても直らない）", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([]); // org_directory が 0 件
    const outcome = await runSignalIngest(createFakeEnv(fake), MESSAGE);
    expect(outcome).toEqual({ kind: "DROPPED", reason: "ORGANIZATION_NOT_FOUND" });
  });

  it("連携が無ければ ack して捨てる", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([[TEST_ORG.organizationId]]);
    fake.enqueueRows([]); // integration が 0 件
    const outcome = await runSignalIngest(createFakeEnv(fake), MESSAGE);
    expect(outcome).toEqual({ kind: "DROPPED", reason: "INTEGRATION_NOT_FOUND" });
  });

  it("マッピングがあれば `physical_signal` へ書く", async () => {
    const fake = createFakeD1();
    primeFake(fake);

    const outcome = await runSignalIngest(createFakeEnv(fake), MESSAGE);

    expect(outcome.kind).toBe("OK");
    expect(outcome).toMatchObject({ received: 1, applied: 1, skipped: 0, failed: 0 });
    expect(signalInsert(fake.queries)).toBeDefined();
  });

  it("**未マッピングの機器はエラーにならず `recordsSkipped` に寄る**（§2.3 MUST）", async () => {
    const fake = createFakeD1();
    primeFake(fake, { mapped: false });

    const outcome = await runSignalIngest(createFakeEnv(fake), MESSAGE);

    expect(outcome).toMatchObject({ kind: "OK", received: 1, applied: 0, skipped: 1, failed: 0 });
    // **書き込みそのものが起きない。**
    expect(signalInsert(fake.queries)).toBeUndefined();
    // **同期ログは `PARTIAL`。** 全件が未マッピングでも `FAILED` にしない
    // （直すのは対応表であって連携ではない）。
    expect(syncLogUpdate(fake.queries)?.params).toContain("PARTIAL");
  });

  it("**重複イベントは書かれない**（§4.2 MUST の `(deviceId, type, occurredAt)`）", async () => {
    const fake = createFakeD1();
    primeFake(fake, { existingSignal: true });

    const outcome = await runSignalIngest(createFakeEnv(fake), MESSAGE);

    expect(outcome).toMatchObject({ kind: "OK", applied: 0, duplicate: 1 });
    expect(signalInsert(fake.queries)).toBeUndefined();
  });

  it("同じ受信の中の重複も 1 行しか作らない", async () => {
    const fake = createFakeD1();
    primeFake(fake);

    const outcome = await runSignalIngest(createFakeEnv(fake), {
      ...MESSAGE,
      events: [EVENT, EVENT, EVENT],
    });

    expect(outcome).toMatchObject({ kind: "OK", received: 3, applied: 1, duplicate: 2 });
  });

  it("**未知の種類は 1 件だけ落として受信は成功させる**", async () => {
    const fake = createFakeD1();
    primeFake(fake);

    const outcome = await runSignalIngest(createFakeEnv(fake), {
      ...MESSAGE,
      events: [EVENT, { ...EVENT, type: "DOOR_KNOCK" }],
    });

    expect(outcome).toMatchObject({ kind: "OK", received: 2, applied: 1, failed: 1 });
  });

  it("全件が形不正なら書き込みに行かない", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([[TEST_ORG.organizationId]]);
    fake.enqueueRows([
      [
        INTEGRATION_ID,
        TEST_ORG.organizationId,
        PROPERTY_ID,
        "SMART_LOCK",
        "api-generic",
        "汎用 Webhook",
        "ACTIVE",
        "{}",
        null,
        "PULL",
        null,
        null,
        null,
        null,
        null,
        null,
        0,
        RECEIVED_AT.getTime(),
        RECEIVED_AT.getTime(),
      ],
    ]);

    const outcome = await runSignalIngest(createFakeEnv(fake), {
      ...MESSAGE,
      events: [{ nope: true }, { deviceId: "", type: "DOOR_UNLOCK", occurredAt: "x" }],
    });

    expect(outcome).toMatchObject({ kind: "OK", received: 2, applied: 0, failed: 2 });
    // **全件が形不正のときだけ `FAILED`。**
    expect(syncLogUpdate(fake.queries)?.params).toContain("FAILED");
    // 対応表すら引かない（引く相手がいない）。
    expect(fake.queries.some((query) => query.sql.includes("external_mapping"))).toBe(false);
  });

  it("**`actorType` を推測で埋めない**（省略は `null` のまま / §4.3 MUST）", async () => {
    const fake = createFakeD1();
    primeFake(fake);

    await runSignalIngest(createFakeEnv(fake), MESSAGE);

    const insert = signalInsert(fake.queries);
    expect(insert).toBeDefined();
    // `UNKNOWN` を入れていないこと。**「返さない機種」と「不明と返した機種」を潰さない。**
    expect(insert?.params).not.toContain("UNKNOWN");
  });

  it("`actorType` が来たらそのまま入る", async () => {
    const fake = createFakeD1();
    primeFake(fake);

    await runSignalIngest(createFakeEnv(fake), {
      ...MESSAGE,
      events: [{ ...EVENT, actorType: "STAFF_KEY", actorRef: "card-8891" }],
    });

    const insert = signalInsert(fake.queries);
    expect(insert?.params).toContain("STAFF_KEY");
    expect(insert?.params).toContain("card-8891");
  });

  it("**業務日は `occurredAt` から決める**（受信時刻ではない / architecture.md §7）", async () => {
    const fake = createFakeD1();
    primeFake(fake);

    // 2026-09-09 22:14 JST は日締め 05:00 の前なので業務日は 09-09。
    // 受信は 2026-09-10 11:00 JST（`RECEIVED_AT`）で、そちらを使うと 09-10 になる。
    await runSignalIngest(createFakeEnv(fake), MESSAGE);

    const insert = signalInsert(fake.queries);
    expect(insert?.params).toContain("2026-09-09");
    expect(insert?.params).not.toContain("2026-09-10");
  });

  it("**生データを `physical_signal` へ残さない**（保持期間の掛からない場所に溜めない）", async () => {
    const fake = createFakeD1();
    primeFake(fake);

    await runSignalIngest(createFakeEnv(fake), {
      ...MESSAGE,
      events: [{ ...EVENT, actorRef: "card-8891" }],
    });

    const insert = signalInsert(fake.queries);
    // `rawPayload` は `null`。生データは `sync_log.rawSample`（7 日）だけ。
    expect(insert?.params.filter((value) => typeof value === "string" && value.includes("{"))).toEqual(
      [],
    );
  });

  it("同期ログに件数が残る", async () => {
    const fake = createFakeD1();
    primeFake(fake);

    await runSignalIngest(createFakeEnv(fake), MESSAGE);

    const update = syncLogUpdate(fake.queries);
    expect(update).toBeDefined();
    expect(update?.params).toContain("SUCCESS");
  });

  it("**3 回処理しても書き込む値が変わらない**（testing.md §4）", async () => {
    const runs: (readonly unknown[])[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fake = createFakeD1();
      primeFake(fake);
      await runSignalIngest(createFakeEnv(fake), MESSAGE);
      const insert = signalInsert(fake.queries);
      // 行 ID だけは毎回変わる（採番）。**重複排除が効くので DB には 1 行しか残らない。**
      runs.push(
        (insert?.params ?? []).filter(
          (value) => typeof value !== "string" || !value.includes("__sig_"),
        ),
      );
    }
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });

  it("越境した ID を持つメッセージは書き込む前に落ちる", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([[TEST_ORG.organizationId]]);

    const outcome = await runSignalIngest(createFakeEnv(fake), {
      ...MESSAGE,
      integrationId: generateId("z9y8x7", "intg"),
    });

    // `findIntegrationById()` が DB へ行く前に `NotFoundError`。
    // **retry ではなく ack**（再送しても直らない）。
    expect(outcome).toEqual({ kind: "DROPPED", reason: "INTEGRATION_NOT_FOUND" });
    expect(fake.queries.some((query) => query.sql.includes("integration"))).toBe(false);
  });
});

// `MAPPING_ID` は対応表の行 ID。**この spec では直接使わない**が、
// 越境テスト（tests/tenant-isolation/integration.spec.ts）と同じ形の ID を
// 置いておくことで、採番の接頭辞が変わったときにここも落ちる。
void MAPPING_ID;
void SYNC_LOG_ID;
