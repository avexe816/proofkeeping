import { describe, expect, it } from "vitest";

import {
  SCHEMA_VERSION_DDL,
  buildRecordSql,
  computeChecksum,
  planPending,
  runMigrations,
  type AppliedMigration,
  type MigrateDeps,
  type MigrationSource,
  type ShardTarget,
} from "./migrate.js";

/**
 * マイグレーションランナー（P0-06 / PK-SPEC-P0 §19.8）。
 *
 * 実 D1 を使わず、注入した `query` / `execute` で全分岐を決定的に検証する。
 * 実際の適用は `pnpm db:migrate --env local` で確認する（作業ログ参照）。
 */

const NOW = new Date("2026-08-11T00:00:00.000Z");

function shard(index: number): ShardTarget {
  return {
    index,
    bindingName: `SHARD_${String(index).padStart(2, "0")}`,
    databaseName: `proofkeeping-shard-${String(index).padStart(2, "0")}`,
  };
}

function migration(tag: string, sql = `CREATE TABLE ${tag} (id text);`): MigrationSource {
  return { tag, sql };
}

/** 各シャードの `schema_version` を持つ、記憶だけの D1 代役。 */
function createFakeShards(shards: ShardTarget[]) {
  const applied = new Map<number, AppliedMigration[]>(shards.map((s) => [s.index, []]));
  const executed: Array<{ index: number; sql: string }> = [];
  const messages: string[] = [];
  /** ここに載せた SQL が来たら投げる。失敗時の中止を再現する。 */
  const failOn = new Map<number, string>();

  const deps: MigrateDeps = {
    execute: (target, sql) => {
      executed.push({ index: target.index, sql });
      const failure = failOn.get(target.index);
      if (failure !== undefined && sql.includes(failure)) {
        return Promise.reject(new Error("D1_EXEC_FAILED"));
      }
      const recorded = /INSERT INTO schema_version \(tag, checksum, applied_at\) VALUES \('([^']+)', '([^']+)'/.exec(
        sql,
      );
      if (recorded?.[1] !== undefined && recorded[2] !== undefined) {
        applied.get(target.index)?.push({ tag: recorded[1], checksum: recorded[2] });
      }
      return Promise.resolve();
    },
    query: (target) => Promise.resolve([...(applied.get(target.index) ?? [])]),
    log: {
      info: (message) => messages.push(message),
      error: (message) => messages.push(message),
    },
  };

  return { deps, applied, executed, messages, failOn };
}

describe("planPending", () => {
  const first = { ...migration("0000_p0_initial"), checksum: "a".repeat(64) };
  const second = { ...migration("0001_tasks"), checksum: "b".repeat(64) };

  it("未適用の tag を journal 順で返す", () => {
    expect(planPending([first, second], [])).toEqual(["0000_p0_initial", "0001_tasks"]);
    expect(planPending([first, second], [{ tag: first.tag, checksum: first.checksum }])).toEqual([
      "0001_tasks",
    ]);
  });

  it("すべて適用済みなら空を返す", () => {
    const applied = [
      { tag: first.tag, checksum: first.checksum },
      { tag: second.tag, checksum: second.checksum },
    ];

    expect(planPending([first, second], applied)).toEqual([]);
  });

  it("適用済みの .sql が書き換えられていたら投げる", () => {
    // 黙って再適用すると、シャードごとに中身の違うスキーマができる。
    expect(() => planPending([first], [{ tag: first.tag, checksum: "c".repeat(64) }])).toThrow(
      "MIGRATION_CHECKSUM_MISMATCH:0000_p0_initial",
    );
  });

  it("適用済みの tag が journal から消えていたら投げる", () => {
    expect(() => planPending([second], [{ tag: first.tag, checksum: first.checksum }])).toThrow(
      "MIGRATION_MISSING_LOCALLY:0000_p0_initial",
    );
  });

  it("適用済みより前に未適用が挿し込まれていたら投げる", () => {
    // 0000 が未適用のまま 0001 だけ適用済み = 適用順が journal と食い違う。
    expect(() =>
      planPending([first, second], [{ tag: second.tag, checksum: second.checksum }]),
    ).toThrow("MIGRATION_OUT_OF_ORDER:0001_tasks");
  });
});

describe("buildRecordSql", () => {
  it("tag と checksum を記録する SQL を作る", () => {
    expect(buildRecordSql("0000_p0_initial", "a".repeat(64), 1_786_000_000_000)).toBe(
      "INSERT INTO schema_version (tag, checksum, applied_at) VALUES " +
        `('0000_p0_initial', '${"a".repeat(64)}', 1786000000000)`,
    );
  });

  it("形の合わない tag / checksum を拒む", () => {
    // wrangler d1 execute はプレースホルダを取れず文字列連結になるため、
    // 値の形をここで閉じておく。
    expect(() => buildRecordSql("0000_p0'; DROP TABLE room; --", "a".repeat(64), 0)).toThrow(
      "MIGRATION_TAG_INVALID",
    );
    expect(() => buildRecordSql("0000_p0_initial", "not-a-checksum", 0)).toThrow(
      "MIGRATION_CHECKSUM_INVALID",
    );
  });
});

describe("runMigrations", () => {
  it("SHARD_00 から順に適用し、schema_version を記録する", async () => {
    const shards = [shard(0), shard(1), shard(2)];
    const fake = createFakeShards(shards);

    const result = await runMigrations(fake.deps, {
      shards,
      migrations: [migration("0000_p0_initial")],
      now: NOW,
    });

    expect(result.shards.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(result.shards.every((s) => s.applied.length === 1)).toBe(true);
    expect(result.consistent).toBe(true);
    for (const s of shards) {
      expect(fake.applied.get(s.index)?.map((row) => row.tag)).toEqual(["0000_p0_initial"]);
    }
  });

  it("シャードの順序が入れ替わっていても index 昇順で適用する", async () => {
    const shards = [shard(2), shard(0), shard(1)];
    const fake = createFakeShards(shards);

    const result = await runMigrations(fake.deps, {
      shards,
      migrations: [migration("0000_p0_initial")],
      now: NOW,
    });

    expect(result.shards.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("3 回実行しても結果が変わらない（冪等）", async () => {
    // .claude/rules/testing.md §4。
    const shards = [shard(0), shard(1)];
    const fake = createFakeShards(shards);
    const options = { shards, migrations: [migration("0000_p0_initial")], now: NOW };

    await runMigrations(fake.deps, options);
    const second = await runMigrations(fake.deps, options);
    const third = await runMigrations(fake.deps, options);

    expect(second.shards.every((s) => s.applied.length === 0)).toBe(true);
    expect(third.shards.every((s) => s.applied.length === 0)).toBe(true);
    for (const s of shards) {
      expect(fake.applied.get(s.index)?.map((row) => row.tag)).toEqual(["0000_p0_initial"]);
    }
  });

  it("失敗したら以降のシャードに触れず、シャード番号を出して中止する", async () => {
    const shards = [shard(0), shard(1), shard(2)];
    const fake = createFakeShards(shards);
    fake.failOn.set(1, "CREATE TABLE 0000_p0_initial");

    await expect(
      runMigrations(fake.deps, {
        shards,
        migrations: [migration("0000_p0_initial")],
        now: NOW,
      }),
    ).rejects.toThrow("MIGRATION_FAILED:SHARD_01");

    // SHARD_02 は DDL すら投げられていない。
    expect(fake.executed.some((entry) => entry.index === 2)).toBe(false);
    expect(fake.applied.get(0)?.length).toBe(1);
    expect(fake.applied.get(2)?.length).toBe(0);
    expect(fake.messages.some((m) => m.includes("shard 1"))).toBe(true);
  });

  it("checkOnly では書き込まず、未適用を報告する", async () => {
    const shards = [shard(0)];
    const fake = createFakeShards(shards);

    const result = await runMigrations(fake.deps, {
      shards,
      migrations: [migration("0000_p0_initial")],
      now: NOW,
      checkOnly: true,
    });

    expect(result.shards[0]?.pending).toEqual(["0000_p0_initial"]);
    expect(result.shards[0]?.applied).toEqual([]);
    expect(fake.applied.get(0)).toEqual([]);
    // 実行したのは記録表の作成だけ（IF NOT EXISTS なので副作用にならない）。
    expect(fake.executed.map((entry) => entry.sql)).toEqual([SCHEMA_VERSION_DDL]);
  });

  it("シャード間で schema_version が食い違ったら consistent = false", async () => {
    // 部分適用のまま次のリリースへ進むと、起動時ヘルスチェック（P0-20）が
    // 書き込み系 API を 503 にする。その入力になる判定。
    const shards = [shard(0), shard(1)];
    const fake = createFakeShards(shards);
    const first = migration("0000_p0_initial");
    const second = migration("0001_tasks");
    const migrations = [first, second];

    const firstApplied = { tag: first.tag, checksum: await computeChecksum(first.sql) };
    const secondApplied = { tag: second.tag, checksum: await computeChecksum(second.sql) };

    // SHARD_00 だけ 2 本目まで適用済みという状態を作る。
    fake.applied.set(0, [firstApplied, secondApplied]);
    fake.applied.set(1, [firstApplied]);

    const result = await runMigrations(fake.deps, {
      shards,
      migrations,
      now: NOW,
      checkOnly: true,
    });

    expect(result.consistent).toBe(false);
    expect(result.shards[0]?.currentTag).toBe("0001_tasks");
    expect(result.shards[1]?.currentTag).toBe("0000_p0_initial");
  });

  it("形の合わない tag があれば 1 行も適用せずに投げる", async () => {
    const shards = [shard(0)];
    const fake = createFakeShards(shards);

    await expect(
      runMigrations(fake.deps, {
        shards,
        migrations: [migration("initial")],
        now: NOW,
      }),
    ).rejects.toThrow("MIGRATION_TAG_INVALID:initial");

    expect(fake.executed).toEqual([]);
  });
});

describe("computeChecksum", () => {
  it("同じ内容には同じ SHA-256 を返す", async () => {
    const digest = await computeChecksum("CREATE TABLE room (id text);");

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeChecksum("CREATE TABLE room (id text);")).toBe(digest);
    expect(await computeChecksum("CREATE TABLE room (id text); -- edited")).not.toBe(digest);
  });
});
