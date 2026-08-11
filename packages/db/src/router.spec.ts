/**
 * シャードルーターのユニットテスト。
 *
 * task: docs/tasks/P0-03.md
 * ルール: .claude/rules/testing.md
 *
 * `tests/` ではなくここに置いている理由:
 *   ルート tsconfig.json は `packages/db/**` を除外し、`tests/**` を
 *   `@types/node` のプログラムとして検査する。`D1Database` / `KVNamespace`
 *   に触れるテストは `@cloudflare/workers-types` を持つ
 *   packages/db/tsconfig.json 側のプログラムでなければ型検査が通らない。
 *   vitest.config.ts の include は packages 配下の src にある spec を
 *   既に対象にしている。
 */

import { describe, expect, it } from "vitest";

import type { Env } from "./env.js";
import {
  fnv1a32,
  getShardBinding,
  getTenantDb,
  resolveShard,
  shardIndexOf,
  type TenantContext,
} from "./router.js";

// ────────────────────────────────────────────────────────────
// テストダブル
// ────────────────────────────────────────────────────────────

/** 読み取りだけの KV。`get` 以外は使わない。 */
function fakeKv(entries: Readonly<Record<string, string>>): KVNamespace {
  return {
    get: (key: string): Promise<string | null> => Promise.resolve(entries[key] ?? null),
  } as unknown as KVNamespace;
}

/** binding の同一性だけを見るための番兵。クエリは実行しない。 */
function fakeD1(label: string): D1Database {
  return { __label: label } as unknown as D1Database;
}

interface FakeEnvInit {
  /** `env.SHARD_COUNT`。不正値のテストのため文字列のまま受ける。 */
  shardCount: string;
  /** `SHARD_MAP` の中身。キーは `shard:{organizationId}`。 */
  mappings?: Readonly<Record<string, string>>;
  /** 宣言する binding の番号。既定は 0..15 の全部。 */
  declaredShards?: readonly number[];
}

function fakeEnv(init: FakeEnvInit): Env {
  const declared = init.declaredShards ?? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const shards: Record<string, D1Database> = {};
  for (const n of declared) {
    const key = `SHARD_${String(n).padStart(2, "0")}`;
    shards[key] = fakeD1(key);
  }
  return {
    ...shards,
    SHARD_COUNT: init.shardCount,
    SHARD_MAP: fakeKv(init.mappings ?? {}),
  } as unknown as Env;
}

/** binding の同一性を確認するためのラベル取り出し。 */
function labelOf(db: D1Database): string {
  return (db as unknown as { __label: string }).__label;
}

// ────────────────────────────────────────────────────────────
// 決定的なテスト用組織 ID
// ────────────────────────────────────────────────────────────

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * 線形合同法で 6 桁英数の組織 ID を作る。同じ seed なら常に同じ列。
 *
 * 分散の判定を乱数任せにすると CI が確率的に落ちる。ここで固定する。
 */
function makeCorpus(count: number, seed: number): string[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    let id = "";
    for (let j = 0; j < 6; j++) id += ALPHABET.charAt(Math.floor(next() * ALPHABET.length));
    ids.push(id);
  }
  return ids;
}

/** シャードごとの件数を数える。 */
function countByShard(ids: readonly string[], shardCount: number): number[] {
  const counts = new Array<number>(shardCount).fill(0);
  for (const id of ids) {
    const idx = shardIndexOf(id, shardCount);
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  return counts;
}

const ctxOf = (organizationId: string): TenantContext => ({
  organizationId,
  orgShortId: organizationId,
});

// ────────────────────────────────────────────────────────────
// fnv1a32
// ────────────────────────────────────────────────────────────

describe("fnv1a32", () => {
  /**
   * FNV-1a 32bit の標準テストベクタ。
   *
   * **この期待値を書き換えてはならない。** ハッシュが変わると既存組織の
   * バケット割当が変わり、移送手続きを踏まないまま読み書きが別シャードへ
   * 向かう（= テナントのデータ分裂）。実装を変えたくなったら、まず
   * 移送手順を用意すること。
   */
  it("標準テストベクタと一致する", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("組織 ID の形をした入力の値を固定する", () => {
    expect(fnv1a32("o7k2m9")).toBe(0x0e66a108);
  });

  it("常に uint32 の範囲に収まる", () => {
    for (const id of makeCorpus(200, 4242)) {
      const hash = fnv1a32(id);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("同じ入力に対して決定的である", () => {
    expect(fnv1a32("o7k2m9")).toBe(fnv1a32("o7k2m9"));
    expect(fnv1a32("o7k2m9")).not.toBe(fnv1a32("o7k2m8"));
  });
});

// ────────────────────────────────────────────────────────────
// shardIndexOf — SHARD_COUNT ごとの分岐
// ────────────────────────────────────────────────────────────

describe("shardIndexOf", () => {
  it("SHARD_COUNT=1 ではすべて 0 に落ちる（local / preview）", () => {
    for (const id of makeCorpus(100, 12345)) {
      expect(shardIndexOf(id, 1)).toBe(0);
    }
  });

  /**
   * staging は SHARD_COUNT=2。ここが「複数シャードへ散る」経路を
   * 実際に通す唯一の非本番環境なので、両方の枝が踏まれることを見る。
   */
  it("SHARD_COUNT=2 では 0 と 1 の両方に分岐する", () => {
    const ids = makeCorpus(100, 999);
    const observed = new Set(ids.map((id) => shardIndexOf(id, 2)));
    expect([...observed].sort()).toEqual([0, 1]);
  });

  it("SHARD_COUNT=2 でどちらか一方に寄っていない", () => {
    const counts = countByShard(makeCorpus(100, 999), 2);
    // 実測 58 / 42。片側 30 件を下回るなら分岐が偏っている。
    expect(counts[0]).toBeGreaterThanOrEqual(30);
    expect(counts[1]).toBeGreaterThanOrEqual(30);
  });

  it("SHARD_COUNT=16 では 16 シャードすべてが使われる（production）", () => {
    const counts = countByShard(makeCorpus(100, 12345), 16);
    expect(counts).toHaveLength(16);
    for (const count of counts) expect(count).toBeGreaterThan(0);
  });

  it("不正な shardCount を拒否する", () => {
    for (const bad of [0, -1, 17, 1.5, Number.NaN]) {
      expect(() => shardIndexOf("o7k2m9", bad)).toThrow(/^SHARD_COUNT_INVALID:/);
    }
  });
});

// ────────────────────────────────────────────────────────────
// 分散
// ────────────────────────────────────────────────────────────

describe("シャードへの分散", () => {
  /**
   * 判定件数が 1600 なのは、100 件では一様ハッシュでも ±30% に収まらないため。
   * 平均 6.25 件・標準偏差 ≈2.4 に対し許容幅は ±1.9 しかない
   * （実測 -84%〜+108%）。1600 件なら平均 100 件・許容幅 ±30 件で意味を持つ。
   * docs/DECISIONS.md #008 を参照。
   */
  it("1600 組織で 16 シャードへの偏差が ±30% 以内", () => {
    const counts = countByShard(makeCorpus(1600, 12345), 16);
    const mean = 1600 / 16;
    for (const count of counts) {
      expect(count).toBeGreaterThanOrEqual(mean * 0.7);
      expect(count).toBeLessThanOrEqual(mean * 1.3);
    }
  });

  it("100 組織でも 16 シャードすべてに 1 件以上落ちる", () => {
    const counts = countByShard(makeCorpus(100, 12345), 16);
    for (const count of counts) expect(count).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────
// resolveShard — 明示マッピングの優先と不正値
// ────────────────────────────────────────────────────────────

describe("resolveShard", () => {
  const HASHES_TO_0 = "r1dfzr";
  const HASHES_TO_1 = "w64xgv";

  it("前提: この 2 件は SHARD_COUNT=2 で 0 と 1 に落ちる", () => {
    expect(shardIndexOf(HASHES_TO_0, 2)).toBe(0);
    expect(shardIndexOf(HASHES_TO_1, 2)).toBe(1);
  });

  it("明示マッピングが無ければハッシュを使う", async () => {
    const env = fakeEnv({ shardCount: "2" });
    await expect(resolveShard(env, HASHES_TO_0)).resolves.toBe(0);
    await expect(resolveShard(env, HASHES_TO_1)).resolves.toBe(1);
  });

  /**
   * 双方向で見るのが要点。片方向だけだと、KV を読まずハッシュを返す
   * 実装でも偶然通ってしまう。
   */
  it("明示マッピングがハッシュより優先される（0 → 1）", async () => {
    const env = fakeEnv({ shardCount: "2", mappings: { [`shard:${HASHES_TO_0}`]: "1" } });
    await expect(resolveShard(env, HASHES_TO_0)).resolves.toBe(1);
  });

  it("明示マッピングがハッシュより優先される（1 → 0）", async () => {
    const env = fakeEnv({ shardCount: "2", mappings: { [`shard:${HASHES_TO_1}`]: "0" } });
    await expect(resolveShard(env, HASHES_TO_1)).resolves.toBe(0);
  });

  it("他組織の明示マッピングに影響されない", async () => {
    const env = fakeEnv({ shardCount: "2", mappings: { [`shard:${HASHES_TO_1}`]: "0" } });
    await expect(resolveShard(env, HASHES_TO_0)).resolves.toBe(0);
  });

  /**
   * 不正値でハッシュへフォールバックしないこと。移送済み組織で静かに
   * ハッシュへ落ちると、移送前のシャードへ読み書きが向かい、同一テナントの
   * データが複数シャードに分裂する。越境テストにも引っかからない。
   */
  it("明示マッピングの値が不正なら例外にする（ハッシュへ落ちない）", async () => {
    for (const bad of ["", " ", "abc", "-1", "1.5", "0x1", "null"]) {
      const env = fakeEnv({ shardCount: "2", mappings: { [`shard:${HASHES_TO_0}`]: bad } });
      await expect(resolveShard(env, HASHES_TO_0)).rejects.toThrow(/^SHARD_MAP_INVALID:/);
    }
  });

  it("明示マッピングが SHARD_COUNT 以上なら例外にする", async () => {
    // 本番の値（7）を SHARD_COUNT=1 のローカルへ持ち込んだ状況。
    const env = fakeEnv({ shardCount: "1", mappings: { [`shard:${HASHES_TO_0}`]: "7" } });
    await expect(resolveShard(env, HASHES_TO_0)).rejects.toThrow(/^SHARD_MAP_INVALID:/);
  });

  it("例外メッセージにシャード番号を含めない", async () => {
    const env = fakeEnv({ shardCount: "1", mappings: { [`shard:${HASHES_TO_0}`]: "7" } });
    await expect(resolveShard(env, HASHES_TO_0)).rejects.toThrow(`SHARD_MAP_INVALID:${HASHES_TO_0}`);
  });

  it("値の前後の空白は許容する", async () => {
    const env = fakeEnv({ shardCount: "2", mappings: { [`shard:${HASHES_TO_0}`]: " 1 " } });
    await expect(resolveShard(env, HASHES_TO_0)).resolves.toBe(1);
  });

  it("不正な SHARD_COUNT を拒否する", async () => {
    for (const bad of ["0", "abc", "17", "1.5", "", "-1", " "]) {
      const env = fakeEnv({ shardCount: bad });
      await expect(resolveShard(env, HASHES_TO_0)).rejects.toThrow(/^SHARD_COUNT_INVALID:/);
    }
  });

  it("SHARD_COUNT の前後の空白は許容する", async () => {
    const env = fakeEnv({ shardCount: " 2 " });
    await expect(resolveShard(env, HASHES_TO_1)).resolves.toBe(1);
  });
});

// ────────────────────────────────────────────────────────────
// getShardBinding
// ────────────────────────────────────────────────────────────

describe("getShardBinding", () => {
  const HASHES_TO_0 = "r1dfzr";
  const HASHES_TO_1 = "w64xgv";

  it("SHARD_COUNT=1 ではすべて SHARD_00 を返す", async () => {
    const env = fakeEnv({ shardCount: "1", declaredShards: [0] });
    for (const id of makeCorpus(20, 12345)) {
      expect(labelOf(await getShardBinding(env, id))).toBe("SHARD_00");
    }
  });

  /** binding キーの組み立て（padStart）まで含めて分岐を通す。 */
  it("SHARD_COUNT=2 では 0 と 1 で別の binding を返す", async () => {
    const env = fakeEnv({ shardCount: "2", declaredShards: [0, 1] });
    expect(labelOf(await getShardBinding(env, HASHES_TO_0))).toBe("SHARD_00");
    expect(labelOf(await getShardBinding(env, HASHES_TO_1))).toBe("SHARD_01");
  });

  it("SHARD_COUNT=16 では 2 桁ゼロ埋めの binding を引く", async () => {
    const env = fakeEnv({ shardCount: "16" });
    for (const id of makeCorpus(100, 12345)) {
      const expected = `SHARD_${String(shardIndexOf(id, 16)).padStart(2, "0")}`;
      expect(labelOf(await getShardBinding(env, id))).toBe(expected);
    }
  });

  it("明示マッピング先の binding を引く", async () => {
    const env = fakeEnv({ shardCount: "2", mappings: { [`shard:${HASHES_TO_0}`]: "1" } });
    expect(labelOf(await getShardBinding(env, HASHES_TO_0))).toBe("SHARD_01");
  });

  it("binding が欠落していたら欠落した binding 名を含めて落ちる", async () => {
    // SHARD_COUNT=2 なのに SHARD_01 を宣言し忘れた wrangler.toml。
    const env = fakeEnv({ shardCount: "2", declaredShards: [0] });
    await expect(getShardBinding(env, HASHES_TO_1)).rejects.toThrow("SHARD_BINDING_MISSING:SHARD_01");
  });
});

// ────────────────────────────────────────────────────────────
// getTenantDb
// ────────────────────────────────────────────────────────────

describe("getTenantDb", () => {
  it("TenantContext の organizationId でシャードを解決する", async () => {
    const env = fakeEnv({ shardCount: "16" });
    await expect(getTenantDb(env, ctxOf("o7k2m9"))).resolves.toBeDefined();
  });

  it("同じ ctx で 3 回呼んでも同じシャードに解決する", async () => {
    const env = fakeEnv({ shardCount: "16" });
    const ctx = ctxOf("o7k2m9");
    const resolved = [
      await resolveShard(env, ctx.organizationId),
      await resolveShard(env, ctx.organizationId),
      await resolveShard(env, ctx.organizationId),
    ];
    expect(new Set(resolved).size).toBe(1);
    for (let i = 0; i < 3; i++) {
      await expect(getTenantDb(env, ctx)).resolves.toBeDefined();
    }
  });

  it("解決できない環境ではエラーを伝播する", async () => {
    const env = fakeEnv({ shardCount: "0" });
    await expect(getTenantDb(env, ctxOf("o7k2m9"))).rejects.toThrow(/^SHARD_COUNT_INVALID:/);
  });
});
