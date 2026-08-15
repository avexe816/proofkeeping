/**
 * 写真の保持期間管理の投入（P7-10 / PK-SPEC-P7 §4.5）。
 *
 * ── ここが守っているもの ────────────────────────────────
 * **版数が引けない組織へは投げない。** 「引けないから既定の 6 か月」に
 * すると、上位プラン（13 か月）の組織の写真を 7 か月早く消しうる。
 * 消すのは取り返しがつかないので、疑わしいときは何もしない。
 */

import { createFakeD1, createFakeEnv, OTHER_ORG, TEST_ORG, type FakeD1 } from "@pk/db/test-support";
import type { Env } from "@pk/db";
import { describe, expect, it } from "vitest";

import {
  PHOTO_RETENTION_ORGANIZATION_LIMIT,
  dispatchPhotoRetention,
} from "./retentionDispatch.js";

const NOW = new Date("2026-08-15T00:00:00.000Z");

interface SentMessage {
  kind: string;
  orgShortId: string;
  plan: string;
  requestedAtMs: number;
}

function envWithQueue(fake: FakeD1, sent: SentMessage[], options: { fail?: boolean } = {}): Env {
  return {
    ...createFakeEnv(fake),
    QUEUE_ARCHIVE_RESTORE: {
      send: (message: SentMessage) => {
        if (options.fail === true) return Promise.reject(new Error("queue-unavailable"));
        sent.push(message);
        return Promise.resolve();
      },
    },
  } as unknown as Env;
}

/** `subscription` の 1 行。`select()` は全列なので列順に並べる。 */
function subscriptionRow(plan: string): unknown[] {
  return [
    "sub1", // id
    TEST_ORG.organizationId, // organization_id
    plan,
    "ACTIVE", // status
    "MONTHLY", // billing_cycle
    null, // trial_ends_at
    null, // current_period_start
    null, // current_period_end
    0, // unit_price_yen
    0, // minimum_charge_yen
    null, // external_ref
    null, // canceled_at
    NOW.getTime(),
    NOW.getTime(),
  ];
}

describe("dispatchPhotoRetention", () => {
  it("組織ごとに 1 通ずつ投げる。**版数をメッセージに載せる**", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([
      [TEST_ORG.orgShortId, TEST_ORG.organizationId],
      [OTHER_ORG.orgShortId, OTHER_ORG.organizationId],
    ]);
    fake.enqueueRows([subscriptionRow("BASE")]);
    fake.enqueueRows([subscriptionRow("PRO")]);
    const sent: SentMessage[] = [];

    const result = await dispatchPhotoRetention(envWithQueue(fake, sent), NOW);

    expect(result).toEqual({
      organizations: 2,
      queued: 2,
      skippedNoPlan: 0,
      failedOrganizations: 0,
      truncated: false,
    });
    expect(sent.map((message) => message.plan)).toEqual(["BASE", "PRO"]);
    for (const message of sent) {
      expect(message.kind).toBe("PHOTO_RETENTION");
      // **メッセージが時刻を持つ**（再送で payload が変わらない）。
      expect(message.requestedAtMs).toBe(NOW.getTime());
    }
  });

  it("**版数が引けない組織へは投げない**（消さない側へ倒す）", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([[TEST_ORG.orgShortId, TEST_ORG.organizationId]]);
    fake.enqueueRows([]); // subscription が 0 件
    const sent: SentMessage[] = [];

    const result = await dispatchPhotoRetention(envWithQueue(fake, sent), NOW);

    expect(result).toMatchObject({ organizations: 1, queued: 0, skippedNoPlan: 1 });
    expect(sent).toHaveLength(0);
  });

  it("1 組織で落ちても残りを止めない", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([[TEST_ORG.orgShortId, TEST_ORG.organizationId]]);
    fake.enqueueRows([subscriptionRow("BASE")]);
    const sent: SentMessage[] = [];

    const result = await dispatchPhotoRetention(envWithQueue(fake, sent, { fail: true }), NOW);

    expect(result).toMatchObject({ organizations: 1, queued: 0, failedOrganizations: 1 });
  });

  it("組織が 0 件なら何も投げない", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([]);
    const sent: SentMessage[] = [];

    const result = await dispatchPhotoRetention(envWithQueue(fake, sent), NOW);

    expect(result).toMatchObject({ organizations: 0, queued: 0, truncated: false });
  });

  it("上限は月次締めと同じ 200（Cron の CPU 予算に対する歯止め）", () => {
    expect(PHOTO_RETENTION_ORGANIZATION_LIMIT).toBe(200);
  });
});
