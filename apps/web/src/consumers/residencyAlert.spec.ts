/**
 * 在留資格の期限アラート（P8-02 / PK-SPEC-P8 §1.4）。
 *
 * 完了条件:
 *   - 90 日前・30 日前で段階的に通知が出る（境界値は lib の spec）
 *   - 0 件なら送らない
 *   - 本文に個人名が無い（人数だけ）
 *   - 1 日 1 通に畳まれる（`dedupeKey`）
 *   - **退職者へ更新の通知が飛ばない**（P8-11 の完了条件）
 *   - 保存期間を満了した在留資格を、同じバッチが消す（P8-11）
 */

import type { Env } from "@pk/db";
import { createFakeD1, createFakeEnv, TEST_ORG, type FakeD1 } from "@pk/db/test-support";
import { describe, expect, it } from "vitest";

import {
  handleResidencyAlertBatch,
  isResidencyAlertMessage,
  runResidencyAlert,
  type ResidencyAlertMessage,
} from "./residencyAlert.js";

/** 2026-08-20 の 07:00 JST（= 前日 22:00 UTC）。業務日は 2026-08-20。 */
const NOW = new Date("2026-08-19T22:00:00.000Z");

const MESSAGE: ResidencyAlertMessage = {
  kind: "RESIDENCY_ALERT",
  orgShortId: TEST_ORG.orgShortId,
  requestedAtMs: NOW.getTime(),
};

const STAFF_ID = `${TEST_ORG.orgShortId}__sppf_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const MEMBER_ID = `${TEST_ORG.orgShortId}__mem_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

interface Recorder {
  readonly notifications: Record<string, unknown>[];
}

function envWith(fake: FakeD1, recorder: Recorder): Env {
  return {
    ...createFakeEnv(fake),
    QUEUE_NOTIFICATION: {
      send: (message: Record<string, unknown>) => {
        recorder.notifications.push(message);
        return Promise.resolve();
      },
    },
  } as unknown as Env;
}

/**
 * 3 クエリぶんを積む。**呼び出し順 = 積む順。**
 *
 *   ① `lookupOrganizationId()`（org_directory）
 *   ② `listStaffLedger()`（id / membership / hired / resigned / status / lang / skills / note）
 *   ③ `listResidencyRecords()`（id / staff / type / label / expires / renewal / permit / limit / note）
 */
function prime(fake: FakeD1, input: { expiresOn: string | null; renewalAppliedOn?: string | null; workStatus?: string; resignedOn?: string | null }): void {
  fake.enqueueRows([[TEST_ORG.organizationId]]);
  fake.enqueueRows([
    [
      STAFF_ID,
      MEMBER_ID,
      null,
      input.resignedOn ?? null,
      input.workStatus ?? "ACTIVE",
      "[]",
      "[]",
      null,
    ],
  ]);
  fake.enqueueRows([
    [
      `${TEST_ORG.orgShortId}__resd_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
      STAFF_ID,
      "SPECIFIED_SKILLED_1",
      null,
      input.expiresOn,
      input.renewalAppliedOn ?? null,
      0,
      null,
      null,
    ],
  ]);
}

describe("isResidencyAlertMessage", () => {
  it("正しい形を受け入れる", () => {
    expect(isResidencyAlertMessage(MESSAGE)).toBe(true);
  });

  it("**NOTIFY と取り違えない**（同じキューに相乗りしている）", () => {
    expect(
      isResidencyAlertMessage({
        kind: "NOTIFY",
        orgShortId: TEST_ORG.orgShortId,
        eventCode: "finding.high",
        requestedAtMs: 0,
      }),
    ).toBe(false);
  });

  it("オブジェクトでなければ拒む", () => {
    expect(isResidencyAlertMessage(null)).toBe(false);
    expect(isResidencyAlertMessage("RESIDENCY_ALERT")).toBe(false);
  });
});

describe("runResidencyAlert", () => {
  it("組織が引けなければ **ack して捨てる**", async () => {
    const fake = createFakeD1();
    const rec: Recorder = { notifications: [] };
    fake.enqueueRows([]); // org_directory が 0 件

    const outcome = await runResidencyAlert(envWith(fake, rec), MESSAGE);

    expect(outcome).toEqual({ kind: "DROPPED", reason: "ORGANIZATION_NOT_FOUND" });
    expect(rec.notifications).toHaveLength(0);
  });

  it("期限まで 30 日以内なら通知を投げる", async () => {
    const fake = createFakeD1();
    const rec: Recorder = { notifications: [] };
    prime(fake, { expiresOn: "2026-09-01" });

    const outcome = await runResidencyAlert(envWith(fake, rec), MESSAGE);

    expect(outcome).toEqual({ kind: "OK", total: 1, notified: true });
    expect(rec.notifications).toHaveLength(1);
    const sent = rec.notifications[0] as Record<string, string>;
    expect(sent["eventCode"]).toBe("residency.expiry_due");
    expect(sent["linkPath"]).toBe("/app/settings/staff");
  });

  it("**本文に個人名が無い**（人数だけ / ui-writing.md §6）", async () => {
    const fake = createFakeD1();
    const rec: Recorder = { notifications: [] };
    prime(fake, { expiresOn: "2026-09-01" });

    await runResidencyAlert(envWith(fake, rec), MESSAGE);

    const sent = rec.notifications[0] as Record<string, string>;
    // 名前もスタッフ番号も期日も本文に無い。人数と誘導だけ。
    expect(sent["summary"]).toBe("期限の確認が必要なスタッフが 1 名います");
    expect(sent["subject"]).not.toContain(STAFF_ID);
    expect(sent["summary"]).not.toContain("2026-09-01");
  });

  it("**1 日 1 通**（`dedupeKey` が組織 × 業務日）", async () => {
    const fake = createFakeD1();
    const rec: Recorder = { notifications: [] };
    prime(fake, { expiresOn: "2026-09-01" });

    await runResidencyAlert(envWith(fake, rec), MESSAGE);

    const sent = rec.notifications[0] as Record<string, string>;
    expect(sent["dedupeKey"]).toBe(`residency-expiry:${TEST_ORG.orgShortId}:2026-08-20`);
  });

  it("0 件なら送らない", async () => {
    const fake = createFakeD1();
    const rec: Recorder = { notifications: [] };
    prime(fake, { expiresOn: "2027-08-01" }); // 1 年先

    const outcome = await runResidencyAlert(envWith(fake, rec), MESSAGE);

    expect(outcome).toEqual({ kind: "OK", total: 0, notified: false });
    expect(rec.notifications).toHaveLength(0);
  });

  it("更新手続きが出ていれば送らない", async () => {
    const fake = createFakeD1();
    const rec: Recorder = { notifications: [] };
    prime(fake, { expiresOn: "2026-09-01", renewalAppliedOn: "2026-08-15" });

    const outcome = await runResidencyAlert(envWith(fake, rec), MESSAGE);

    expect(outcome).toEqual({ kind: "OK", total: 0, notified: false });
  });

  it("退職者だけなら送らない", async () => {
    const fake = createFakeD1();
    const rec: Recorder = { notifications: [] };
    prime(fake, { expiresOn: "2026-09-01", workStatus: "RESIGNED" });

    const outcome = await runResidencyAlert(envWith(fake, rec), MESSAGE);

    expect(outcome).toEqual({ kind: "OK", total: 0, notified: false });
  });

  it("保存期間の満了日を過ぎた在留資格を、同じバッチが消す（P8-11）", async () => {
    const fake = createFakeD1();
    const rec: Recorder = { notifications: [] };
    // 2023-08-19 退職 → 満了は 2026-08-19。業務日 2026-08-20 は**その翌日**。
    prime(fake, { expiresOn: "2024-03-31", workStatus: "RESIGNED", resignedOn: "2023-08-19" });

    const outcome = await runResidencyAlert(envWith(fake, rec), MESSAGE);

    expect(outcome).toEqual({ kind: "OK", total: 0, notified: false });
    // **退職者へ更新の通知は飛ばない。** 消えるだけ。
    expect(rec.notifications).toHaveLength(0);
    const del = fake.queries.find((query) => query.sql.startsWith("delete from"));
    expect(del?.params).toContain(STAFF_ID);
  });

  it("**満了日当日は消さない**（P8-11 / 境界は満了の翌日）", async () => {
    const fake = createFakeD1();
    const rec: Recorder = { notifications: [] };
    // 2023-08-20 退職 → 満了は 2026-08-20 = 業務日。
    prime(fake, { expiresOn: "2024-03-31", workStatus: "RESIGNED", resignedOn: "2023-08-20" });

    await runResidencyAlert(envWith(fake, rec), MESSAGE);

    expect(fake.queries.some((query) => query.sql.startsWith("delete from"))).toBe(false);
  });

  it("在職中は在留期限が切れていても消さない（P8-11）", async () => {
    const fake = createFakeD1();
    const rec: Recorder = { notifications: [] };
    prime(fake, { expiresOn: "2020-03-31" });

    await runResidencyAlert(envWith(fake, rec), MESSAGE);

    expect(fake.queries.some((query) => query.sql.startsWith("delete from"))).toBe(false);
  });
});

describe("handleResidencyAlertBatch", () => {
  it("形の違うメッセージは ack して落とす（**retry しない**）", async () => {
    const fake = createFakeD1();
    const rec: Recorder = { notifications: [] };
    let acked = 0;
    let retried = 0;

    await handleResidencyAlertBatch(envWith(fake, rec), {
      queue: "pk-notification-local",
      messages: [
        {
          body: { kind: "SOMETHING_ELSE" },
          ack: () => {
            acked += 1;
          },
          retry: () => {
            retried += 1;
          },
        },
      ],
    } as unknown as MessageBatch);

    expect(acked).toBe(1);
    expect(retried).toBe(0);
  });

  it("D1 が落ちたら retry する", async () => {
    const fake = createFakeD1();
    const rec: Recorder = { notifications: [] };
    fake.enqueueRows([[TEST_ORG.organizationId]]);
    // **2 回目の prepare（テナント側の読み取り）で落とす。**
    // 逆引き（1 回目）は成功させ、FAILED → retry の経路だけを見る。
    let prepares = 0;
    const database = new Proxy(fake.database, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            prepares += 1;
            if (prepares > 1) throw new Error("D1_ERROR");
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });
    const env: Env = {
      ...envWith(fake, rec),
      SHARD_00: database,
    };
    let acked = 0;
    let retried = 0;

    await handleResidencyAlertBatch(env, {
      queue: "pk-notification-local",
      messages: [
        {
          body: MESSAGE,
          ack: () => {
            acked += 1;
          },
          retry: () => {
            retried += 1;
          },
        },
      ],
    } as unknown as MessageBatch);

    expect(retried).toBe(1);
    expect(acked).toBe(0);
    expect(rec.notifications).toHaveLength(0);
  });
});
