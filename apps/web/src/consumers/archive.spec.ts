/**
 * 年次アーカイブのコンシューマ（P7-08 / PK-SPEC-P0 §19.7）。
 *
 * ルール: .claude/rules/testing.md §4（冪等）
 * 完了条件: 「R2 へ JSONL でエクスポートされる」
 *           「SHA-256 が manifest に記録される」
 *           「除外対象（証跡ハッシュ・監査ログ・帳票・マスタ）が守られる」
 *
 * ── どこで何を押さえているか ────────────────────────────
 *   ① 対象と除外の判断 …… `packages/db/src/archivePolicy.spec.ts`
 *   ② **除外が R2 まで通らないこと** …… ここ（PUT されたキーを数える）
 *   ③ **SHA-256 が圧縮前の JSONL のもの** …… ここ
 *   ④ **冪等**（3 回走らせても同じキー・同じハッシュ）…… ここ
 *   ⑤ **D1 から行を外さない**（退避であって削除ではない）…… ここ
 */

import { createFakeD1, createFakeEnv, TEST_ORG, type FakeD1 } from "@pk/db/test-support";
import type { Env } from "@pk/db";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { sha256HexOfText } from "../lib/evidence/hash.js";

import {
  gzip,
  handleArchiveExportBatch,
  isArchiveExportMessage,
  runArchiveExport,
  type ArchiveExportMessage,
} from "./archive.js";

/** 2026-08-15。13 か月前は 2025-07-15。 */
const NOW = new Date("2026-08-15T00:00:00.000Z");

const MESSAGE: ArchiveExportMessage = {
  kind: "ARCHIVE_EXPORT",
  orgShortId: TEST_ORG.orgShortId,
  year: 2024,
  requestedAtMs: NOW.getTime(),
};

interface PutCall {
  key: string;
  body: Uint8Array;
  customMetadata: Record<string, string>;
}

interface FakeR2 {
  readonly puts: PutCall[];
  readonly bucket: R2Bucket;
}

function createFakeR2(options: { fail?: boolean } = {}): FakeR2 {
  const puts: PutCall[] = [];
  const bucket = {
    put(key: string, body: Uint8Array, put?: { customMetadata?: Record<string, string> }) {
      if (options.fail === true) return Promise.reject(new TypeError("r2-unavailable"));
      puts.push({ key, body, customMetadata: put?.customMetadata ?? {} });
      return Promise.resolve({});
    },
  };
  return { puts, bucket: bucket as unknown as R2Bucket };
}

function envWith(fake: FakeD1, r2: FakeR2): Env {
  return { ...createFakeEnv(fake), ARCHIVE: r2.bucket };
}

/** 組織の逆引きだけを積む。表の読み取りはすべて 0 件になる。 */
function primeOrganization(fake: FakeD1): void {
  fake.enqueueRows([[TEST_ORG.organizationId]]);
}

describe("isArchiveExportMessage", () => {
  it("正しい形を受け入れる", () => {
    expect(isArchiveExportMessage(MESSAGE)).toBe(true);
  });

  it("kind が違えば拒む", () => {
    expect(isArchiveExportMessage({ ...MESSAGE, kind: "SIGNAL_INGEST" })).toBe(false);
  });

  it("年が整数でなければ拒む", () => {
    expect(isArchiveExportMessage({ ...MESSAGE, year: 2024.5 })).toBe(false);
    expect(isArchiveExportMessage({ ...MESSAGE, year: "2024" })).toBe(false);
  });

  it("組織短縮 ID が空なら拒む", () => {
    expect(isArchiveExportMessage({ ...MESSAGE, orgShortId: "" })).toBe(false);
  });

  it("オブジェクトでなければ拒む", () => {
    expect(isArchiveExportMessage(null)).toBe(false);
    expect(isArchiveExportMessage("ARCHIVE_EXPORT")).toBe(false);
  });
});

describe("runArchiveExport", () => {
  it("組織が引けなければ **ack して捨てる**（再送しても直らない）", async () => {
    const fake = createFakeD1();
    const r2 = createFakeR2();
    fake.enqueueRows([]); // org_directory が 0 件

    const outcome = await runArchiveExport(envWith(fake, r2), MESSAGE);

    expect(outcome).toEqual({ kind: "DROPPED", reason: "ORGANIZATION_NOT_FOUND" });
    // **1 件も書き出さない。**
    expect(r2.puts).toHaveLength(0);
  });

  it("**まだ 13 か月経っていない年は書き出さない**（§19.7 の下限）", async () => {
    const fake = createFakeD1();
    const r2 = createFakeR2();
    primeOrganization(fake);

    const outcome = await runArchiveExport(envWith(fake, r2), { ...MESSAGE, year: 2026 });

    expect(outcome).toEqual({ kind: "DROPPED", reason: "WITHIN_RETENTION" });
    expect(r2.puts).toHaveLength(0);
  });

  it("`businessDate` を自分で持つ 5 表を R2 へ書き出す", async () => {
    const fake = createFakeD1();
    const r2 = createFakeR2();
    primeOrganization(fake);

    const outcome = await runArchiveExport(envWith(fake, r2), MESSAGE);

    expect(outcome).toEqual({ kind: "OK", tables: 5, rows: 0 });
    expect(r2.puts.map((put) => put.key)).toEqual([
      `archive/${TEST_ORG.organizationId}/2024/cleaning_task.jsonl.gz`,
      `archive/${TEST_ORG.organizationId}/2024/room_observation.jsonl.gz`,
      `archive/${TEST_ORG.organizationId}/2024/linen_record.jsonl.gz`,
      `archive/${TEST_ORG.organizationId}/2024/occupancy_snapshot.jsonl.gz`,
      `archive/${TEST_ORG.organizationId}/2024/physical_signal.jsonl.gz`,
    ]);
  });

  it("**除外対象を 1 件も書き出さない**（証跡ハッシュ・監査ログ・帳票・マスタ）", async () => {
    const fake = createFakeD1();
    const r2 = createFakeR2();
    primeOrganization(fake);

    await runArchiveExport(envWith(fake, r2), MESSAGE);

    const keys = r2.puts.map((put) => put.key).join("\n");
    for (const excluded of [
      "evidence_snapshot",
      "audit_log",
      "invoice",
      "receipt",
      "daily_report",
      "organization",
      "property",
      "room_type",
      "user",
      "membership",
    ]) {
      expect(keys, excluded).not.toContain(`/${excluded}.jsonl.gz`);
    }
  });

  it("**R2 のキーにシャード番号を載せない**（CLAUDE.md §4）", async () => {
    const fake = createFakeD1();
    const r2 = createFakeR2();
    primeOrganization(fake);

    await runArchiveExport(envWith(fake, r2), MESSAGE);

    for (const put of r2.puts) {
      expect(put.key, put.key).not.toMatch(/shard/i);
    }
  });

  it("**圧縮前の JSONL の SHA-256** を manifest とオブジェクトの両方に載せる", async () => {
    const fake = createFakeD1();
    const r2 = createFakeR2();
    primeOrganization(fake);

    await runArchiveExport(envWith(fake, r2), MESSAGE);

    // 0 件の年は空文字。**改行だけの行を作らない**（`toJsonl()`）。
    const expected = await sha256HexOfText("");
    for (const put of r2.puts) {
      expect(put.customMetadata["sha256"]).toBe(expected);
      expect(put.customMetadata["rowCount"]).toBe("0");
      // その年は年末まで丸ごと 13 か月より前なので、境界は年末。
      expect(put.customMetadata["cutoffBusinessDate"]).toBe("2024-12-31");
    }

    const manifestInsert = fake.queries.find(
      (query) => query.sql.includes("archive_manifest") && query.sql.includes("insert"),
    );
    // 既定の `changes = 1` で UPDATE が当たるため、INSERT は出ない。
    expect(manifestInsert).toBeUndefined();
    const manifestUpdate = fake.queries.find((query) =>
      query.sql.startsWith('update "archive_manifest"'),
    );
    expect(manifestUpdate?.params).toContain(expected);
  });

  it("記録が無ければ INSERT する（`changes = 0` の経路）", async () => {
    const fake = createFakeD1();
    const r2 = createFakeR2();
    primeOrganization(fake);
    // 5 表ぶん、UPDATE を「0 行」・続く INSERT を「1 行」にする。
    // **代役の `changes` は書き込み 1 回ごとに 1 つ消える**ので、
    // UPDATE のぶんだけ積むと途中から既定の 1 に戻ってしまう。
    for (let index = 0; index < 5; index += 1) {
      fake.enqueueChanges(0);
      fake.enqueueChanges(1);
    }

    await runArchiveExport(envWith(fake, r2), MESSAGE);

    const inserts = fake.queries.filter((query) =>
      query.sql.startsWith('insert into "archive_manifest"'),
    );
    expect(inserts).toHaveLength(5);
  });

  it("**3 回走らせても同じキー・同じハッシュ**（testing.md §4）", async () => {
    const runs = await Promise.all(
      [0, 1, 2].map(async () => {
        const fake = createFakeD1();
        const r2 = createFakeR2();
        primeOrganization(fake);
        const outcome = await runArchiveExport(envWith(fake, r2), MESSAGE);
        return {
          outcome,
          keys: r2.puts.map((put) => put.key),
          hashes: r2.puts.map((put) => put.customMetadata["sha256"]),
        };
      }),
    );

    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });

  it("**D1 から行を外さない**（退避であって削除ではない / DECISIONS #159）", async () => {
    const fake = createFakeD1();
    const r2 = createFakeR2();
    primeOrganization(fake);

    await runArchiveExport(envWith(fake, r2), MESSAGE);

    for (const query of fake.queries) {
      expect(query.sql.toLowerCase(), query.sql).not.toContain("delete from");
    }
  });

  it("R2 が落ちていれば FAILED（**retry させる**）", async () => {
    const fake = createFakeD1();
    const r2 = createFakeR2({ fail: true });
    primeOrganization(fake);

    const outcome = await runArchiveExport(envWith(fake, r2), MESSAGE);

    expect(outcome).toEqual({ kind: "FAILED", reason: "TypeError" });
  });

  it("年の途中までしか経っていなければ、境界までで切る", async () => {
    const fake = createFakeD1();
    const r2 = createFakeR2();
    primeOrganization(fake);

    const outcome = await runArchiveExport(envWith(fake, r2), { ...MESSAGE, year: 2025 });

    expect(outcome.kind).toBe("OK");
    // 13 か月前は 2025-07-15。**その先は書き出さない。**
    for (const put of r2.puts) {
      expect(put.customMetadata["cutoffBusinessDate"]).toBe("2025-07-15");
    }
  });
});

describe("gzip", () => {
  it("展開すると元に戻る", async () => {
    const text = '{"id":"a1b2c3__task_01"}\n';
    const compressed = await gzip(text);

    const stream = new Blob([compressed as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    expect(await new Response(stream).text()).toBe(text);
  });

  it("空文字も扱える（0 件の年）", async () => {
    const compressed = await gzip("");
    expect(compressed.byteLength).toBeGreaterThan(0);
  });
});

describe("handleArchiveExportBatch", () => {
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

  it("形の違うメッセージは **ack して落とす**（再送しても直らない）", async () => {
    const fake = createFakeD1();
    const r2 = createFakeR2();
    const entry = fakeMessage({ kind: "NOPE" });

    await handleArchiveExportBatch(envWith(fake, r2), {
      messages: [entry.message],
    } as unknown as MessageBatch);

    expect(entry.calls).toEqual({ ack: 1, retry: 0 });
    expect(fake.queries).toHaveLength(0);
  });

  it("書き出せたら ack する", async () => {
    const fake = createFakeD1();
    const r2 = createFakeR2();
    primeOrganization(fake);
    const entry = fakeMessage(MESSAGE);

    await handleArchiveExportBatch(envWith(fake, r2), {
      messages: [entry.message],
    } as unknown as MessageBatch);

    expect(entry.calls).toEqual({ ack: 1, retry: 0 });
  });

  it("R2 が落ちていれば retry する", async () => {
    const fake = createFakeD1();
    const r2 = createFakeR2({ fail: true });
    primeOrganization(fake);
    const entry = fakeMessage(MESSAGE);

    await handleArchiveExportBatch(envWith(fake, r2), {
      messages: [entry.message],
    } as unknown as MessageBatch);

    expect(entry.calls).toEqual({ ack: 0, retry: 1 });
  });
});

describe("「削除」と表現しない（P7 固有の絶対ルール）", () => {
  it("コンシューマの本体に `delete` / `purge` を書かない", () => {
    const source = readFileSync(new URL("./archive.ts", import.meta.url), "utf8");
    // 注記（「削除ではない」と説明している箇所）を除いて走査する。
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code.toLowerCase()).not.toContain("delete");
    expect(code.toLowerCase()).not.toContain("purge");
  });
});
