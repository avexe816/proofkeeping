/**
 * 採番の検査。
 *
 * task:  docs/tasks/P0-17.md
 * ルール: .claude/rules/testing.md §5（500 並列採番 → 欠番・重複ゼロ）
 *
 * `DocumentCounter` を直に回す。DO の殻（`fetch`）は経路の分岐しか
 * 持たないので、並列性の検証は本体で行う。
 */

import { describe, expect, it } from "vitest";

import { DocumentCounter, SEQUENCE_STORAGE_KEY, type SequenceStorage } from "./DocumentSequencer.js";

/**
 * 永続化の代役。**`put` を意図的に非同期にしてある。**
 * 同期で終わる代役だと、`await` の隙に別の要求が入る状況を再現できない。
 */
function fakeStorage(initial?: number): SequenceStorage & { readonly values: number[] } {
  const store = new Map<string, number>();
  if (initial !== undefined) store.set(SEQUENCE_STORAGE_KEY, initial);
  const values: number[] = [];
  return {
    values,
    get: (key) => Promise.resolve(store.get(key)),
    put: async (key, value) => {
      // マイクロタスクを 1 つ挟む。ここで別の issue() が割り込める。
      await Promise.resolve();
      store.set(key, value);
      values.push(value);
    },
  };
}

describe("DocumentCounter", () => {
  it("1 から始まる", async () => {
    const counter = new DocumentCounter(fakeStorage());
    expect(await counter.issue()).toBe(1);
    expect(await counter.issue()).toBe(2);
  });

  it("保存済みの値の続きから採る", async () => {
    const counter = new DocumentCounter(fakeStorage(41));
    expect(await counter.issue()).toBe(42);
  });

  it("500 並列でも欠番・重複が出ない", async () => {
    const counter = new DocumentCounter(fakeStorage());
    const issued = await Promise.all(Array.from({ length: 500 }, () => counter.issue()));

    const sorted = [...issued].sort((a, b) => a - b);
    expect(new Set(issued).size).toBe(500);
    expect(sorted[0]).toBe(1);
    expect(sorted.at(-1)).toBe(500);
    // 欠番が無いこと。1..500 が 1 つずつ。
    expect(sorted).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
  });

  it("同時に始まっても読み込みは 1 回だけ（同じ値から 2 本走らない）", async () => {
    let reads = 0;
    const base = fakeStorage(10);
    const counter = new DocumentCounter({
      get: async (key) => {
        reads += 1;
        return base.get(key);
      },
      put: (key, value) => base.put(key, value),
    });

    const issued = await Promise.all([counter.issue(), counter.issue(), counter.issue()]);
    expect(reads).toBe(1);
    expect([...issued].sort((a, b) => a - b)).toEqual([11, 12, 13]);
  });

  it("peek は番号を進めない", async () => {
    const counter = new DocumentCounter(fakeStorage());
    expect(await counter.peek()).toBe(0);
    expect(await counter.issue()).toBe(1);
    expect(await counter.peek()).toBe(1);
    expect(await counter.peek()).toBe(1);
    expect(await counter.issue()).toBe(2);
  });

  it("取消しても番号は戻らない（欠番のまま残る）", async () => {
    // 「戻す」API を持たないことがそのまま仕様。3 番を捨てても次は 4。
    const counter = new DocumentCounter(fakeStorage());
    await counter.issue();
    await counter.issue();
    const cancelled = await counter.issue();
    expect(cancelled).toBe(3);
    expect(await counter.issue()).toBe(4);
  });

  it("別インスタンス（＝別年度）は 1 から始まる", async () => {
    // 年度はインスタンス名に含まれる（documentSequencerName）。
    // 別インスタンスは別ストレージなので、リセット処理は要らない。
    const fy2025 = new DocumentCounter(fakeStorage(120));
    const fy2026 = new DocumentCounter(fakeStorage());
    expect(await fy2025.issue()).toBe(121);
    expect(await fy2026.issue()).toBe(1);
  });

  it("永続化された値が単調に増える", async () => {
    const storage = fakeStorage();
    const counter = new DocumentCounter(storage);
    await Promise.all(Array.from({ length: 50 }, () => counter.issue()));
    const sorted = [...storage.values].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});
