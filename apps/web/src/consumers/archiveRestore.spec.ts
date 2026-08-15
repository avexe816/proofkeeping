/**
 * 退避データの復元（P7-09 / PK-SPEC-P7 §9）。
 *
 * 完了条件:
 *   - 復元リクエストが Queue で処理される
 *   - 7 日間閲覧可能
 *   - **「削除」ではなく「退避」と表現されている**
 *
 * ── ここが守っているもの ────────────────────────────────
 * ① **退避そのものを触らない**（R2 の delete も manifest の更新も出さない）
 * ② **部分的に読めた写しを「全部ある」と見せない**
 * ③ **7 日は READY からの 7 日**（要求時からではない）
 * ④ 冪等（`PENDING` 以外は着手しない）
 */

import { createFakeD1, createFakeEnv, TEST_ORG, type FakeD1 } from "@pk/db/test-support";
import { ARCHIVE_RESTORE_RETENTION_DAYS, type Env } from "@pk/db";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  gunzip,
  handleArchiveRestoreBatch,
  isArchiveRestoreMessage,
  runArchiveRestore,
  type ArchiveRestoreMessage,
} from "./archiveRestore.js";
import { gzip } from "./archive.js";

const NOW = new Date("2026-08-15T00:00:00.000Z");
const RESTORE_ID = `${TEST_ORG.orgShortId}__arst_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

const MESSAGE: ArchiveRestoreMessage = {
  kind: "ARCHIVE_RESTORE",
  orgShortId: TEST_ORG.orgShortId,
  restoreId: RESTORE_ID,
  requestedAtMs: NOW.getTime(),
};

interface Recorder {
  readonly gets: string[];
  readonly notifications: Record<string, unknown>[];
}

function recorder(): Recorder {
  return { gets: [], notifications: [] };
}

function envWith(
  fake: FakeD1,
  rec: Recorder,
  objects: Record<string, Uint8Array | null>,
): Env {
  return {
    ...createFakeEnv(fake),
    ARCHIVE: {
      get: (key: string) => {
        rec.gets.push(key);
        const body = objects[key];
        if (body === undefined || body === null) return Promise.resolve(null);
        return Promise.resolve({
          arrayBuffer: () => Promise.resolve(body.buffer as ArrayBuffer),
        });
      },
    },
    QUEUE_NOTIFICATION: {
      send: (message: Record<string, unknown>) => {
        rec.notifications.push(message);
        return Promise.resolve();
      },
    },
  } as unknown as Env;
}

/** `archive_restore` の 1 行（`select()` は全列。列順に並べる）。 */
function restoreRow(status: string, from = "2025-01-01", to = "2025-03-01"): unknown[] {
  return [
    RESTORE_ID,
    TEST_ORG.organizationId,
    `${TEST_ORG.orgShortId}__mem_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
    null, // property_id
    from,
    to,
    status,
    0, // table_count
    0, // row_count
    null, // expires_at
    null, // error_code
    NOW.getTime(),
    null, // completed_at
  ];
}

/** `archive_manifest` の 1 行（`select()` は全列）。 */
function manifestRow(tableName: string, objectKey: string): unknown[] {
  return [
    `${TEST_ORG.orgShortId}__arcm_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
    TEST_ORG.organizationId,
    2025,
    tableName,
    objectKey,
    1,
    "0".repeat(64),
    10,
    "2025-12-31",
    NOW.getTime(),
  ];
}

describe("isArchiveRestoreMessage", () => {
  it("正しい形を受け入れる", () => {
    expect(isArchiveRestoreMessage(MESSAGE)).toBe(true);
  });

  it("**同じキューの他の 2 種と取り違えない**", () => {
    expect(
      isArchiveRestoreMessage({
        kind: "ARCHIVE_EXPORT",
        orgShortId: TEST_ORG.orgShortId,
        year: 2024,
        requestedAtMs: 0,
      }),
    ).toBe(false);
    expect(
      isArchiveRestoreMessage({
        kind: "PHOTO_RETENTION",
        orgShortId: TEST_ORG.orgShortId,
        plan: "BASE",
        requestedAtMs: 0,
      }),
    ).toBe(false);
  });

  it("オブジェクトでなければ拒む", () => {
    expect(isArchiveRestoreMessage(null)).toBe(false);
  });
});

describe("runArchiveRestore", () => {
  it("組織が引けなければ ack して捨てる", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    fake.enqueueRows([]);

    const outcome = await runArchiveRestore(envWith(fake, rec, {}), MESSAGE);

    expect(outcome).toEqual({ kind: "DROPPED", reason: "ORGANIZATION_NOT_FOUND" });
  });

  it("要求が無ければ ack して捨てる", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    fake.enqueueRows([[TEST_ORG.organizationId]]);
    fake.enqueueRows([]); // archive_restore が 0 件

    const outcome = await runArchiveRestore(envWith(fake, rec, {}), MESSAGE);

    expect(outcome).toEqual({ kind: "DROPPED", reason: "RESTORE_NOT_FOUND" });
  });

  it("**着手済みなら何もしない**（冪等 / testing.md §4）", async () => {
    for (const status of ["RUNNING", "READY", "EXPIRED", "FAILED"]) {
      const fake = createFakeD1();
      const rec = recorder();
      fake.enqueueRows([[TEST_ORG.organizationId]]);
      fake.enqueueRows([restoreRow(status)]);

      const outcome = await runArchiveRestore(envWith(fake, rec, {}), MESSAGE);

      expect(outcome, status).toEqual({ kind: "DROPPED", reason: "ALREADY_HANDLED" });
      // **R2 を読まない。**
      expect(rec.gets, status).toHaveLength(0);
    }
  });

  it("R2 から読んで展開し、READY にする", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    const key = "archive/org/2025/cleaning_task.jsonl.gz";
    const body = await gzip(
      `${JSON.stringify({ id: "t1", businessDate: "2025-02-01" })}\n` +
        `${JSON.stringify({ id: "t2", businessDate: "2025-06-01" })}\n`,
    );

    fake.enqueueRows([[TEST_ORG.organizationId]]);
    fake.enqueueRows([restoreRow("PENDING")]);
    fake.enqueueRows([manifestRow("cleaning_task", key)]);

    const outcome = await runArchiveRestore(envWith(fake, rec, { [key]: body }), MESSAGE);

    // **期間の外（2025-06-01）は落ちる。**
    expect(outcome).toEqual({ kind: "OK", tables: 1, rows: 1 });
    expect(rec.gets).toEqual([key]);
  });

  it("**7 日は READY からの 7 日**（§9.2）", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    fake.enqueueRows([[TEST_ORG.organizationId]]);
    fake.enqueueRows([restoreRow("PENDING")]);
    fake.enqueueRows([]); // manifest 0 件

    await runArchiveRestore(envWith(fake, rec, {}), MESSAGE);

    const update = fake.queries.filter((query) =>
      query.sql.startsWith('update "archive_restore"'),
    );
    const ready = update.at(-1);
    const expected = NOW.getTime() + ARCHIVE_RESTORE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    expect(ready?.params).toContain(expected);
  });

  it("完了を通知する（§9.1 の手順 4）", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    fake.enqueueRows([[TEST_ORG.organizationId]]);
    fake.enqueueRows([restoreRow("PENDING")]);
    fake.enqueueRows([]);

    await runArchiveRestore(envWith(fake, rec, {}), MESSAGE);

    expect(rec.notifications).toHaveLength(1);
    expect(rec.notifications[0]).toMatchObject({
      kind: "NOTIFY",
      eventCode: "archive.restore_ready",
    });
  });

  it("**退避の実体が無ければ失敗させる**（「空だった」と見せない）", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    const key = "archive/org/2025/cleaning_task.jsonl.gz";
    fake.enqueueRows([[TEST_ORG.organizationId]]);
    fake.enqueueRows([restoreRow("PENDING")]);
    fake.enqueueRows([manifestRow("cleaning_task", key)]);

    const outcome = await runArchiveRestore(envWith(fake, rec, { [key]: null }), MESSAGE);

    expect(outcome).toEqual({ kind: "DROPPED", reason: "ARCHIVE_OBJECT_MISSING" });
  });

  it("**1 行でも壊れていたら全体を失敗させる**", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    const key = "archive/org/2025/cleaning_task.jsonl.gz";
    const body = await gzip(
      `${JSON.stringify({ id: "t1", businessDate: "2025-02-01" })}\nnot-json\n`,
    );
    fake.enqueueRows([[TEST_ORG.organizationId]]);
    fake.enqueueRows([restoreRow("PENDING")]);
    fake.enqueueRows([manifestRow("cleaning_task", key)]);

    const outcome = await runArchiveRestore(envWith(fake, rec, { [key]: body }), MESSAGE);

    expect(outcome).toEqual({ kind: "DROPPED", reason: "ARCHIVE_PAYLOAD_BROKEN" });
  });

  it("**退避そのものを触らない**（R2 の delete も manifest の更新も出さない）", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    fake.enqueueRows([[TEST_ORG.organizationId]]);
    fake.enqueueRows([restoreRow("PENDING")]);
    fake.enqueueRows([]);

    await runArchiveRestore(envWith(fake, rec, {}), MESSAGE);

    for (const query of fake.queries) {
      expect(query.sql).not.toContain('delete from "archive_manifest"');
      expect(query.sql).not.toContain('update "archive_manifest"');
    }
  });
});

describe("gunzip", () => {
  it("`gzip()` の出力を戻せる", async () => {
    const text = '{"id":"a"}\n';
    expect(await gunzip((await gzip(text)).buffer as ArrayBuffer)).toBe(text);
  });
});

describe("handleArchiveRestoreBatch", () => {
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

    await handleArchiveRestoreBatch(envWith(fake, rec, {}), {
      messages: [entry.message],
    } as unknown as MessageBatch);

    expect(entry.calls).toEqual({ ack: 1, retry: 0 });
    expect(fake.queries).toHaveLength(0);
  });

  it("処理できたら ack する", async () => {
    const fake = createFakeD1();
    const rec = recorder();
    fake.enqueueRows([[TEST_ORG.organizationId]]);
    fake.enqueueRows([restoreRow("PENDING")]);
    fake.enqueueRows([]);
    const entry = fakeMessage(MESSAGE);

    await handleArchiveRestoreBatch(envWith(fake, rec, {}), {
      messages: [entry.message],
    } as unknown as MessageBatch);

    expect(entry.calls).toEqual({ ack: 1, retry: 0 });
  });
});

describe("「削除」と表現しない（§9 MUST / P7 固有の絶対ルール）", () => {
  function code(path: string): string {
    return readFileSync(new URL(path, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
  }

  it("コンシューマの本体に `delete` を書かない", () => {
    expect(code("./archiveRestore.ts").toLowerCase()).not.toContain("delete");
  });

  it("**画面の文言に「削除」が出ない**（`locales/ja.json` の `archive.*`）", () => {
    const messages = JSON.parse(
      readFileSync(new URL("../locales/ja.json", import.meta.url), "utf8"),
    ) as Record<string, string>;
    for (const [key, value] of Object.entries(messages)) {
      if (!key.startsWith("archive.")) continue;
      expect(value, key).not.toContain("削除");
    }
  });

  it("**§9 MUST の 2 文が在る**（「データは保管されています。閲覧には復元が必要です」）", () => {
    const messages = JSON.parse(
      readFileSync(new URL("../locales/ja.json", import.meta.url), "utf8"),
    ) as Record<string, string>;
    expect(messages["archive.notice.retained"]).toContain("保管されています");
    expect(messages["archive.notice.restoreRequired"]).toContain("復元が必要です");
  });
});
