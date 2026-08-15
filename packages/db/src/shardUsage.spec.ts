/**
 * シャードの使用率と警告レベル（P7-06 / PK-SPEC-P7 §4.3）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * 完了条件（`docs/tasks/P7-06.md`）:
 *   - 16 シャードの使用率が表示される
 *   - **60% / 75% / 85% で警告レベルが変わる**
 */

import { describe, expect, it } from "vitest";

import type { Env } from "./env.js";

import {
  SHARD_CAPACITY_BYTES,
  SHARD_USAGE_CRITICAL_RATIO,
  SHARD_USAGE_INFO_RATIO,
  SHARD_USAGE_LEVELS,
  SHARD_USAGE_WARNING_RATIO,
  formatBytes,
  formatUsageRatio,
  needsAction,
  shardUsageLevelOf,
  worstLevelOf,
} from "./shardUsage.js";
import { collectShardUsage } from "./shardUsageCollector.js";

describe("shardUsageLevelOf — 閾値（§4.3）", () => {
  it("**60% ちょうどで `info`**（到達した時点で上げる）", () => {
    expect(shardUsageLevelOf(SHARD_USAGE_INFO_RATIO)).toBe("info");
  });

  it("**75% ちょうどで `warning`**", () => {
    expect(shardUsageLevelOf(SHARD_USAGE_WARNING_RATIO)).toBe("warning");
  });

  it("**85% ちょうどで `critical`**", () => {
    expect(shardUsageLevelOf(SHARD_USAGE_CRITICAL_RATIO)).toBe("critical");
  });

  it("閾値は 60 / 75 / 85 %", () => {
    expect(SHARD_USAGE_INFO_RATIO).toBe(0.6);
    expect(SHARD_USAGE_WARNING_RATIO).toBe(0.75);
    expect(SHARD_USAGE_CRITICAL_RATIO).toBe(0.85);
  });

  it("4 段が順に切り替わる", () => {
    expect(shardUsageLevelOf(0.1)).toBe("ok");
    expect(shardUsageLevelOf(0.65)).toBe("info");
    expect(shardUsageLevelOf(0.8)).toBe("warning");
    expect(shardUsageLevelOf(0.99)).toBe("critical");
  });
});

describe("shardUsageLevelOf — 境界の直前は上がらない", () => {
  it("59.9% は `ok`", () => {
    expect(shardUsageLevelOf(0.599)).toBe("ok");
  });

  it("74.9% は `info`", () => {
    expect(shardUsageLevelOf(0.749)).toBe("info");
  });

  it("84.9% は `warning`", () => {
    expect(shardUsageLevelOf(0.849)).toBe("warning");
  });

  it("0% は `ok`", () => {
    expect(shardUsageLevelOf(0)).toBe("ok");
  });

  it("100% を超えても `critical`", () => {
    expect(shardUsageLevelOf(1.5)).toBe("critical");
  });
});

describe("shardUsageLevelOf — 取れていない値を緑にしない", () => {
  it("**`null` は `unknown`**（`ok` と混ぜない）", () => {
    expect(shardUsageLevelOf(null)).toBe("unknown");
    expect(shardUsageLevelOf(null)).not.toBe("ok");
  });

  it("NaN は `unknown`", () => {
    expect(shardUsageLevelOf(Number.NaN)).toBe("unknown");
  });

  it("Infinity は `unknown`", () => {
    expect(shardUsageLevelOf(Number.POSITIVE_INFINITY)).toBe("unknown");
  });

  it("**`unknown` は `ok` より重い**（測れていない方が危ない）", () => {
    expect(SHARD_USAGE_LEVELS.indexOf("unknown")).toBeLessThan(
      SHARD_USAGE_LEVELS.indexOf("ok"),
    );
    expect(worstLevelOf(["ok", "unknown"])).toBe("ok");
  });
});

describe("needsAction（§4.3 の「実行を検討」「実行」）", () => {
  it("`warning` は動く", () => {
    expect(needsAction("warning")).toBe(true);
  });

  it("`critical` は動く", () => {
    expect(needsAction("critical")).toBe(true);
  });

  it("`info` では動かない（情報のみ）", () => {
    expect(needsAction("info")).toBe(false);
  });

  it("`ok` では動かない", () => {
    expect(needsAction("ok")).toBe(false);
  });

  it("`unknown` は「動く」に数えない（まず測れるようにする）", () => {
    expect(needsAction("unknown")).toBe(false);
  });
});

describe("worstLevelOf", () => {
  it("いちばん重いものを返す", () => {
    expect(worstLevelOf(["ok", "info", "critical", "warning"])).toBe("critical");
  });

  it("全部 `ok` なら `ok`", () => {
    expect(worstLevelOf(["ok", "ok"])).toBe("ok");
  });

  it("空なら `unknown`（1 本も測れていない）", () => {
    expect(worstLevelOf([])).toBe("unknown");
  });
});

/**
 * D1 の代わり。**SQL の中身で応答を選ぶ。**
 *
 * `test-support/fake-d1.ts` は行を配列で返す（drizzle が組み直す前提）が、
 * ここは生の SQL を `.first<T>()` で読むので、**実際の D1 と同じく
 * 列名を持つオブジェクト**を返す必要がある。`health.spec.ts` と同じ形。
 */
function stubEnv(options: { sizeBytes?: number | null; tenantCount?: number | null }): Env {
  const database = {
    prepare: (sql: string) => ({
      first: () => {
        if (sql.includes("pragma_page_count")) {
          return options.sizeBytes === undefined || options.sizeBytes === null
            ? Promise.resolve(null)
            : Promise.resolve({ bytes: options.sizeBytes });
        }
        return options.tenantCount === undefined || options.tenantCount === null
          ? Promise.reject(new Error("D1_UNREACHABLE"))
          : Promise.resolve({ count: options.tenantCount });
      },
    }),
  };
  return {
    SHARD_00: database,
    SHARD_COUNT: "1",
    ENVIRONMENT: "local",
  } as unknown as Env;
}

describe("collectShardUsage — 16 本ぶんを集める", () => {
  it("宣言されている本数ぶん返す", async () => {
    const report = await collectShardUsage(stubEnv({ sizeBytes: 1024, tenantCount: 1 }));
    expect(report.shards).toHaveLength(report.declared);
    expect(report.declared).toBeGreaterThan(0);
  });

  it("使用率と警告レベルが載る", async () => {
    const report = await collectShardUsage(
      stubEnv({ sizeBytes: SHARD_CAPACITY_BYTES * 0.8, tenantCount: 42 }),
    );
    const shard = report.shards[0];
    expect(shard?.usageRatio).toBeCloseTo(0.8, 5);
    expect(shard?.level).toBe("warning");
    expect(shard?.tenantCount).toBe(42);
    expect(report.worst).toBe("warning");
  });

  it("**サイズが取れなければ `null`**（0 で埋めない）", async () => {
    const report = await collectShardUsage(stubEnv({ sizeBytes: null, tenantCount: 7 }));
    expect(report.shards[0]?.sizeBytes).toBeNull();
    expect(report.shards[0]?.usageRatio).toBeNull();
    expect(report.shards[0]?.level).toBe("unknown");
  });

  it("**サイズが 0 でも「取れていない」扱い**（空の緑にしない）", async () => {
    const report = await collectShardUsage(stubEnv({ sizeBytes: 0, tenantCount: 7 }));
    expect(report.shards[0]?.sizeBytes).toBeNull();
    expect(report.shards[0]?.level).toBe("unknown");
  });

  it("テナント数が引けなくてもサイズは報告する（1 本の不調で全体を落とさない）", async () => {
    const report = await collectShardUsage(stubEnv({ sizeBytes: 1024, tenantCount: null }));
    expect(report.shards[0]?.tenantCount).toBeNull();
    expect(report.shards[0]?.sizeBytes).toBe(1024);
    expect(report.shards[0]?.reachable).toBe(true);
  });

  it("どちらも引けなければ到達できていない", async () => {
    const report = await collectShardUsage(stubEnv({ sizeBytes: null, tenantCount: null }));
    expect(report.shards[0]?.reachable).toBe(false);
  });

  it("シャード番号が 0 起点で載る（運用者向け）", async () => {
    const report = await collectShardUsage(stubEnv({ sizeBytes: 1024, tenantCount: 1 }));
    expect(report.shards[0]?.index).toBe(0);
  });
});

describe("表示の整形", () => {
  it("使用率は 1 桁", () => {
    expect(formatUsageRatio(0.8123)).toBe("81.2%");
  });

  it("**取れていなければダッシュ**（0% と区別する）", () => {
    expect(formatUsageRatio(null)).toBe("—");
    expect(formatUsageRatio(0)).toBe("0.0%");
  });

  it("1GB 以上は GB", () => {
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.00 GB");
  });

  it("1GB 未満は MB", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("バイト数も取れていなければダッシュ", () => {
    expect(formatBytes(null)).toBe("—");
  });
});
