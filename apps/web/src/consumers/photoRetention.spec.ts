/**
 * 写真の保持期間の管理（P7-10 / PK-SPEC-P7 §4.5 / security.md §4）。
 *
 * 完了条件:
 *   - 既定 6 か月で削除される
 *   - 削除 30 日前に管理者へ通知される
 *   - 削除が監査ログに記録される
 *
 * ── ここが守っているもの ────────────────────────────────
 * **写真の削除は取り返しがつかない。** 退避（§19.7）と違って写しを
 * 作らないので、消しすぎは戻せない。だから
 *   ① 消す順序（D1 の行 → R2 の実体）
 *   ② 版数が引けないときに消さないこと
 *   ③ 通知の対象を消してしまわないこと
 * を固定する。
 */

import { createFakeD1, createFakeEnv, TEST_ORG, type FakeD1 } from "@pk/db/test-support";
import type { Env } from "@pk/db";
import { describe, expect, it } from "vitest";

import {
  handlePhotoRetentionBatch,
  isPhotoRetentionMessage,
  runPhotoRetention,
  type PhotoRetentionMessage,
} from "./photoRetention.js";

/** 2026-08-15。6 か月前は 2026-02-15、その 30 日後は 2026-03-17。 */
const NOW = new Date("2026-08-15T00:00:00.000Z");

const MESSAGE: PhotoRetentionMessage = {
  kind: "PHOTO_RETENTION",
  orgShortId: TEST_ORG.orgShortId,
  plan: "BASE",
  requestedAtMs: NOW.getTime(),
};

interface Recorder {
  readonly deletedKeys: string[];
  readonly notifications: Record<string, unknown>[];
}

function envWith(fake: FakeD1, recorder: Recorder, options: { r2Fails?: boolean } = {}): Env {
  return {
    ...createFakeEnv(fake),
    PHOTOS: {
      delete: (key: string) => {
        if (options.r2Fails === true) return Promise.reject(new TypeError("r2-unavailable"));
        recorder.deletedKeys.push(key);
        return Promise.resolve();
      },
    },
    QUEUE_NOTIFICATION: {
      send: (message: Record<string, unknown>) => {
        recorder.notifications.push(message);
        return Promise.resolve();
      },
    },
  } as unknown as Env;
}

function recorder(): Recorder {
  return { deletedKeys: [], notifications: [] };
}

/** ミリ秒。`NOW` から n 日前。 */
function daysAgo(days: number): number {
  return NOW.getTime() - days * 24 * 60 * 60 * 1000;
}

/**
 * 組織の逆引きと `organization` の 1 行を積む。
 *
 * `findOrganization()` は `select()` 全列なので、列順に並べる必要がある。
 * **使われるのは `photoRetentionMonths` だけ**なので、その位置まで埋める。
 */
function primeOrganization(fake: FakeD1, retentionOverride: number | null = null): void {
  fake.enqueueRows([[TEST_ORG.organizationId]]);
  fake.enqueueRows([
    [
      TEST_ORG.organizationId, // id
      TEST_ORG.organizationId, // organization_id
      TEST_ORG.orgShortId,
      "テスト組織",
      "Asia/Tokyo",
      "ja",
      4, // property_selection_threshold
      retentionOverride, // photo_retention_months
      1, // is_active
      NOW.getTime(),
      NOW.getTime(),
    ],
  ]);
}

/** 4 表ぶんの `select` に、指定した写真を積む（1 表目だけに入れる）。 */
function primePhotos(fake: FakeD1, rows: [string, string, number][]): void {
  fake.enqueueRows(rows.map(([id, key, uploadedAt]) => [id, key, uploadedAt]));
  // 残り 3 表は 0 件（積まなければ既定で空）。
}

describe("isPhotoRetentionMessage", () => {
  it("正しい形を受け入れる", () => {
    expect(isPhotoRetentionMessage(MESSAGE)).toBe(true);
  });

  it("**アーカイブのメッセージと取り違えない**（同じキューに相乗りしている）", () => {
    expect(
      isPhotoRetentionMessage({
        kind: "ARCHIVE_EXPORT",
        orgShortId: TEST_ORG.orgShortId,
        year: 2024,
        requestedAtMs: 0,
      }),
    ).toBe(false);
  });

  it("知らない版数を拒む", () => {
    expect(isPhotoRetentionMessage({ ...MESSAGE, plan: "FREE" })).toBe(false);
  });

  it("オブジェクトでなければ拒む", () => {
    expect(isPhotoRetentionMessage(null)).toBe(false);
    expect(isPhotoRetentionMessage("PHOTO_RETENTION")).toBe(false);
  });
});

describe("runPhotoRetention", () => {
  it("組織が引けなければ **ack して捨てる**", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    fake.enqueueRows([]); // org_directory が 0 件

    const outcome = await runPhotoRetention(envWith(fake, rec), MESSAGE);

    expect(outcome).toEqual({ kind: "DROPPED", reason: "ORGANIZATION_NOT_FOUND" });
    expect(rec.deletedKeys).toHaveLength(0);
  });

  it("**既定は 6 か月**（BASE）", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    primeOrganization(fake);

    const outcome = await runPhotoRetention(envWith(fake, rec), MESSAGE);

    expect(outcome).toMatchObject({ kind: "OK", retentionMonths: 6 });
  });

  it("上位プランは 13 か月", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    primeOrganization(fake);

    const outcome = await runPhotoRetention(envWith(fake, rec), { ...MESSAGE, plan: "PRO" });

    expect(outcome).toMatchObject({ kind: "OK", retentionMonths: 13 });
  });

  it("**組織の延長設定が効く**（§4.5 MUST「必要なら期間延長できる」）", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    primeOrganization(fake, 24);

    const outcome = await runPhotoRetention(envWith(fake, rec), MESSAGE);

    expect(outcome).toMatchObject({ kind: "OK", retentionMonths: 24 });
  });

  it("**期限切れを消す。行を消してから R2 の実体を消す**", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    primeOrganization(fake);
    // 200 日前 = 6 か月より前。期限切れ。
    primePhotos(fake, [["p1", "photos/a/1.jpg", daysAgo(200)]]);

    const outcome = await runPhotoRetention(envWith(fake, rec), MESSAGE);

    expect(outcome).toMatchObject({ kind: "OK", deleted: 1 });
    expect(rec.deletedKeys).toEqual(["photos/a/1.jpg"]);

    // **順序**: D1 の delete が R2 の delete より前に出ていること。
    const deleteIndex = fake.queries.findIndex((query) =>
      query.sql.startsWith('delete from "task_photo"'),
    );
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
  });

  it("**30 日以内に切れるものは消さない。通知する**", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    primeOrganization(fake);
    // 6 か月 = 約 181 日。170 日前は「もうすぐ切れる」側。
    primePhotos(fake, [["p1", "photos/a/1.jpg", daysAgo(170)]]);

    const outcome = await runPhotoRetention(envWith(fake, rec), MESSAGE);

    expect(outcome).toMatchObject({ kind: "OK", deleted: 0, expiringSoon: 1 });
    // **消えていない。**
    expect(rec.deletedKeys).toHaveLength(0);
    expect(rec.notifications).toHaveLength(1);
    expect(rec.notifications[0]).toMatchObject({
      kind: "NOTIFY",
      eventCode: "photo.retention_due",
      propertyId: null,
    });
  });

  it("通知の対象が 0 件なら送らない", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    primeOrganization(fake);

    await runPhotoRetention(envWith(fake, rec), MESSAGE);

    expect(rec.notifications).toHaveLength(0);
  });

  it("**削除を監査ログに記録する。0 件でも記録する**（§4.5）", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    primeOrganization(fake);

    await runPhotoRetention(envWith(fake, rec), MESSAGE);

    const audit = fake.queries.find((query) => query.sql.startsWith('insert into "audit_log"'));
    expect(audit).toBeDefined();
    expect(audit?.params).toContain("photo.retentionDeleted");
    // **操作者はシステム。** 人の ID を借りない（DECISIONS #164）。
    expect(audit?.params).toContain(`${TEST_ORG.orgShortId}__sys_00000000000000000000000000`);
  });

  it("**R2 が落ちても行の削除は取り消さない**（実体は次の回に持ち越す）", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    primeOrganization(fake);
    primePhotos(fake, [["p1", "photos/a/1.jpg", daysAgo(200)]]);

    const outcome = await runPhotoRetention(envWith(fake, rec, { r2Fails: true }), MESSAGE);

    // 行は消えている。参照されない R2 オブジェクトが残るだけ。
    expect(outcome).toMatchObject({ kind: "OK", deleted: 1 });
  });

  it("**3 回走らせても結果が変わらない**（testing.md §4）", async () => {
    const runs = await Promise.all(
      [0, 1, 2].map(async () => {
        const fake = createFakeD1();
        const rec = recorder();
        primeOrganization(fake);
        primePhotos(fake, [["p1", "photos/a/1.jpg", daysAgo(200)]]);
        const outcome = await runPhotoRetention(envWith(fake, rec), MESSAGE);
        return { outcome, deletedKeys: rec.deletedKeys };
      }),
    );
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });
});

describe("handlePhotoRetentionBatch", () => {
  function fakeMessage(body: unknown) {
    const calls = { ack: 0, retry: 0 };
    return {
      calls,
      message: {
        body,
        ack: () => {
          calls.ack += 1;
        },
        retry: () => {
          calls.retry += 1;
        },
      },
    };
  }

  it("形の違うメッセージは ack して落とす", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    const entry = fakeMessage({ kind: "NOPE" });

    await handlePhotoRetentionBatch(envWith(fake, rec), {
      messages: [entry.message],
    } as unknown as MessageBatch);

    expect(entry.calls).toEqual({ ack: 1, retry: 0 });
    expect(fake.queries).toHaveLength(0);
  });

  it("処理できたら ack する", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    primeOrganization(fake);
    const entry = fakeMessage(MESSAGE);

    await handlePhotoRetentionBatch(envWith(fake, rec), {
      messages: [entry.message],
    } as unknown as MessageBatch);

    expect(entry.calls).toEqual({ ack: 1, retry: 0 });
  });
});
