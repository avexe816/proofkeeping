/**
 * ヘルスチェックの検査。
 *
 * task: docs/tasks/P0-20.md
 *
 * **番号を漏らしていないこと**を最後の 1 件で押さえる。
 * ここが緩むと、認証不要の経路から内部構成が読める。
 */

import { describe, expect, it } from "vitest";

import { checkHealth, type HealthReport } from "./health.js";
import type { Env } from "./env.js";

type ShardBehaviour = "ok" | "unreachable" | { tags: string[] };

/** `schema_version` を返すだけの D1 の代役。 */
function fakeShard(behaviour: ShardBehaviour): D1Database {
  const tags = behaviour === "ok" ? ["0000_p0_initial"] : behaviour === "unreachable" ? null : behaviour.tags;
  return {
    prepare: () => ({
      all: () => (tags === null ? Promise.reject(new Error("D1_UNREACHABLE")) : Promise.resolve({ results: tags.map((tag) => ({ tag })) })),
    }),
  } as unknown as D1Database;
}

interface FakeEnvOptions {
  shardCount?: number;
  shards?: ShardBehaviour[];
  r2Fails?: boolean;
  kvFails?: boolean;
  missingQueue?: boolean;
}

function fakeEnv(options: FakeEnvOptions = {}): Env {
  const shardCount = options.shardCount ?? 2;
  const behaviours = options.shards ?? Array.from({ length: shardCount }, () => "ok" as const);

  const env: Record<string, unknown> = {
    SHARD_COUNT: String(shardCount),
    ENVIRONMENT: "local",
    APP_BASE_URL: "http://localhost:8787",
    DOCUMENTS: {
      head: () => (options.r2Fails === true ? Promise.reject(new Error("R2")) : Promise.resolve(null)),
    },
    SESSION: {
      get: () => (options.kvFails === true ? Promise.reject(new Error("KV")) : Promise.resolve(null)),
    },
    QUEUE_PDF_GENERATION: {},
    QUEUE_EVIDENCE_EXPORT: {},
    QUEUE_RECONCILIATION: {},
    QUEUE_ROLLUP_UPDATE: {},
    QUEUE_BASELINE_LEARNING: {},
    QUEUE_NOTIFICATION: {},
    QUEUE_ARCHIVE_RESTORE: options.missingQueue === true ? undefined : {},
  };

  // binding は Record へ組んでから広げる（router.spec.ts と同じ形）。
  // `env` へ直に添字で書くと、シャード binding を組み立てたとみなされる。
  const shards: Record<string, D1Database> = {};
  behaviours.forEach((behaviour, idx) => {
    const key = `SHARD_${String(idx).padStart(2, "0")}`;
    shards[key] = fakeShard(behaviour);
  });

  return { ...env, ...shards } as unknown as Env;
}

describe("checkHealth", () => {
  it("すべて揃っていれば ok", async () => {
    const report = await checkHealth(fakeEnv());
    expect(report.state).toBe("ok");
    expect(report.shards).toEqual({
      state: "ok",
      expected: 2,
      declared: 2,
      reachable: 2,
      schemaVersionConsistent: true,
    });
  });

  it("到達できないシャードがあると degraded", async () => {
    const report = await checkHealth(fakeEnv({ shards: ["ok", "unreachable"] }));
    expect(report.state).toBe("degraded");
    expect(report.shards.reachable).toBe(1);
    expect(report.shards.schemaVersionConsistent).toBe(false);
  });

  it("binding が足りないと degraded（宣言漏れ）", async () => {
    // SHARD_COUNT = 3 なのに binding は 2 本。
    const report = await checkHealth(fakeEnv({ shardCount: 3, shards: ["ok", "ok"] }));
    expect(report.shards.expected).toBe(3);
    expect(report.shards.declared).toBe(2);
    expect(report.state).toBe("degraded");
  });

  it("schema_version が不一致なら degraded（§19.8）", async () => {
    const report = await checkHealth(
      fakeEnv({
        shards: [{ tags: ["0000_p0_initial"] }, { tags: ["0000_p0_initial", "0001_next"] }],
      }),
    );
    expect(report.shards.reachable).toBe(2);
    expect(report.shards.schemaVersionConsistent).toBe(false);
    expect(report.state).toBe("degraded");
  });

  it("R2 が落ちていると degraded", async () => {
    const report = await checkHealth(fakeEnv({ r2Fails: true }));
    expect(report.storage).toBe("degraded");
    expect(report.state).toBe("degraded");
  });

  it("KV が落ちていると degraded", async () => {
    const report = await checkHealth(fakeEnv({ kvFails: true }));
    expect(report.cache).toBe("degraded");
    expect(report.state).toBe("degraded");
  });

  it("Queue の binding 欠けを検出する。メッセージは送らない", async () => {
    const report = await checkHealth(fakeEnv({ missingQueue: true }));
    expect(report.queues).toBe("degraded");
  });

  it("シャードが落ちていても例外にせず報告として返す", async () => {
    await expect(
      checkHealth(fakeEnv({ shards: ["unreachable", "unreachable"] })),
    ).resolves.toMatchObject({ state: "degraded" });
  });

  it("応答にシャード番号・binding 名・例外メッセージを含めない", async () => {
    const report: HealthReport = await checkHealth(
      fakeEnv({ shards: ["ok", "unreachable"], r2Fails: true, kvFails: true }),
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/SHARD_\d/);
    expect(serialized).not.toContain("D1_UNREACHABLE");
    expect(serialized).not.toContain("DOCUMENTS");
    expect(serialized).not.toContain("SESSION");
    // 含めてよいのは件数と真偽だけ。
    expect(Object.keys(report).sort()).toEqual(["cache", "queues", "shards", "state", "storage"]);
  });
});
