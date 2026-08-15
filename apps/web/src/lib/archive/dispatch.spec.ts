/**
 * 年次アーカイブの投入（P7-08 / PK-SPEC-P0 §19.7）。
 *
 * ── 見ているもの ────────────────────────────────────────
 * 月次締めと **同じ cron に相乗りしている**（DECISIONS #160）ので、
 * 「年次アーカイブの回か」を決めているのは cron 式ではなく
 * `isArchiveDispatchMoment()`。ここを間違えると
 * **毎月 1 日に全組織ぶんの退避が走る。**
 *
 * 対象年も固定する。1 年ずれると**まだ 13 か月経っていない年**を
 * 投げることになり、コンシューマ側で全件 `WITHIN_RETENTION` に落ちる。
 */

import { createFakeD1, createFakeEnv, TEST_ORG, OTHER_ORG, type FakeD1 } from "@pk/db/test-support";
import type { Env } from "@pk/db";
import { describe, expect, it } from "vitest";

import {
  ARCHIVE_ORGANIZATION_LIMIT,
  archiveTargetYear,
  dispatchArchiveExport,
  isArchiveDispatchMoment,
} from "./dispatch.js";

/** JST の 2 月 1 日 04:00 に当たる UTC の瞬間（前日 19:00）。 */
const FEB_FIRST_JST = new Date("2027-01-31T19:00:00.000Z");

describe("isArchiveDispatchMoment", () => {
  it("JST の 2 月 1 日なら真", () => {
    expect(isArchiveDispatchMoment(FEB_FIRST_JST)).toBe(true);
    expect(isArchiveDispatchMoment(new Date("2027-02-01T00:00:00.000Z"))).toBe(true);
  });

  it("**他の月の 1 日では走らない**（月次締めと同じ cron に相乗りしている）", () => {
    for (const previousDayUtc of [
      "2026-12-31", // JST 1/1
      "2027-02-28", // JST 3/1
      "2027-03-31", // JST 4/1
      "2027-08-31", // JST 9/1
      "2027-11-30", // JST 12/1
    ]) {
      expect(
        isArchiveDispatchMoment(new Date(`${previousDayUtc}T19:00:00.000Z`)),
        previousDayUtc,
      ).toBe(false);
    }
  });

  it("2 月でも 1 日でなければ偽", () => {
    for (const day of ["02", "10", "28"]) {
      expect(isArchiveDispatchMoment(new Date(`2027-02-${day}T19:00:00.000Z`))).toBe(false);
    }
  });

  it("JST の日付で見る（14:59Z はまだ前日）", () => {
    // 2027-01-31T14:59Z = JST 2027-01-31 23:59。まだ 2 月ではない。
    expect(isArchiveDispatchMoment(new Date("2027-01-31T14:59:00.000Z"))).toBe(false);
  });
});

describe("archiveTargetYear", () => {
  it("**実行する年の 2 年前**（1 年前はまだ 13 か月に届かない月がある）", () => {
    expect(archiveTargetYear(FEB_FIRST_JST)).toBe(2025);
    expect(archiveTargetYear(new Date("2028-01-31T19:00:00.000Z"))).toBe(2026);
  });

  it("JST の年で見る（12/31 の 19:00 UTC は翌年）", () => {
    expect(archiveTargetYear(new Date("2026-12-31T19:00:00.000Z"))).toBe(2025);
  });
});

interface SentMessage {
  kind: string;
  orgShortId: string;
  year: number;
  requestedAtMs: number;
}

function envWithQueue(
  fake: FakeD1,
  sent: SentMessage[],
  options: { fail?: boolean } = {},
): Env {
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

describe("dispatchArchiveExport", () => {
  it("組織ごとに 1 通ずつ投げる", async () => {
    const fake = createFakeD1();
    // `org_directory` の列順は `orgShortId` → `organizationId`。
    fake.enqueueRows([
      [TEST_ORG.orgShortId, TEST_ORG.organizationId],
      [OTHER_ORG.orgShortId, OTHER_ORG.organizationId],
    ]);
    const sent: SentMessage[] = [];

    const result = await dispatchArchiveExport(envWithQueue(fake, sent), FEB_FIRST_JST);

    expect(result).toEqual({
      organizations: 2,
      year: 2025,
      queued: 2,
      failedOrganizations: 0,
      truncated: false,
    });
    expect(sent.map((message) => message.orgShortId)).toEqual([
      TEST_ORG.orgShortId,
      OTHER_ORG.orgShortId,
    ]);
    for (const message of sent) {
      expect(message.kind).toBe("ARCHIVE_EXPORT");
      expect(message.year).toBe(2025);
      // **メッセージが時刻を持つ**（再送で payload が変わらない）。
      expect(message.requestedAtMs).toBe(FEB_FIRST_JST.getTime());
    }
  });

  it("1 組織で落ちても残りを止めない", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([[TEST_ORG.orgShortId, TEST_ORG.organizationId]]);
    const sent: SentMessage[] = [];

    const result = await dispatchArchiveExport(
      envWithQueue(fake, sent, { fail: true }),
      FEB_FIRST_JST,
    );

    expect(result).toMatchObject({ organizations: 1, queued: 0, failedOrganizations: 1 });
  });

  it("組織が 0 件なら何も投げない", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([]);
    const sent: SentMessage[] = [];

    const result = await dispatchArchiveExport(envWithQueue(fake, sent), FEB_FIRST_JST);

    expect(result).toMatchObject({ organizations: 0, queued: 0, truncated: false });
    expect(sent).toHaveLength(0);
  });

  it("上限は月次締めと同じ 200（Cron の CPU 予算に対する歯止め）", () => {
    expect(ARCHIVE_ORGANIZATION_LIMIT).toBe(200);
  });
});
