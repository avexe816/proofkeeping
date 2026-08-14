/**
 * 照合バッチの排他の検査（P4-05 / PK-SPEC-P4 §5.2）。
 *
 * ルール: .claude/rules/testing.md §5（同時起動 → 1 件のみ成功）
 *
 * `ReconciliationGate` を直に回す。DO の殻（`fetch`）は経路の分岐しか持たない。
 */

import { describe, expect, it } from "vitest";

import {
  RECONCILIATION_LEASE_MS,
  RECONCILIATION_LOCK_STORAGE_KEY,
  ReconciliationGate,
  reconciliationLockName,
  type ReconciliationHolder,
  type ReconciliationLockStorage,
} from "./ReconciliationLock.js";

const NOW = Date.parse("2026-09-09T17:00:00.000Z");

/**
 * 永続化の代役。**`put` / `delete` を意図的に非同期にしてある。**
 * 同期で終わる代役だと、`await` の隙に別の要求が入る状況を再現できない。
 */
function fakeStorage(initial?: ReconciliationHolder): ReconciliationLockStorage {
  const store = new Map<string, ReconciliationHolder>();
  if (initial !== undefined) store.set(RECONCILIATION_LOCK_STORAGE_KEY, initial);
  return {
    get: (key) => Promise.resolve(store.get(key)),
    put: async (key, value) => {
      await Promise.resolve();
      store.set(key, value);
    },
    delete: async (key) => {
      await Promise.resolve();
      store.delete(key);
    },
  };
}

describe("ReconciliationGate — 二重起動を断る（§5.2）", () => {
  it("空いていれば取れる", async () => {
    const gate = new ReconciliationGate(fakeStorage());

    const result = await gate.acquire({ runKey: "a", engineVersion: "1.0", nowMs: NOW });

    expect(result.acquired).toBe(true);
    expect(result.holder).toEqual({ runKey: "a", engineVersion: "1.0", startedAtMs: NOW });
  });

  it("走っている実行があれば断られ、何が走っているかが返る", async () => {
    const gate = new ReconciliationGate(fakeStorage());
    await gate.acquire({ runKey: "a", engineVersion: "1.0", nowMs: NOW });

    const result = await gate.acquire({ runKey: "b", engineVersion: "1.0", nowMs: NOW + 1000 });

    expect(result.acquired).toBe(false);
    expect(result.holder.runKey).toBe("a");
  });

  it("同時に 10 本が要求しても 1 本だけが取れる", async () => {
    const gate = new ReconciliationGate(fakeStorage());

    const results = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        gate.acquire({ runKey: `run-${String(index)}`, engineVersion: "1.0", nowMs: NOW }),
      ),
    );

    expect(results.filter((result) => result.acquired)).toHaveLength(1);
  });

  it("同じ実行の再送は通る（Queue の再配信で自分に締め出されない）", async () => {
    const gate = new ReconciliationGate(fakeStorage());
    await gate.acquire({ runKey: "a", engineVersion: "1.0", nowMs: NOW });

    const result = await gate.acquire({ runKey: "a", engineVersion: "1.0", nowMs: NOW + 5000 });

    expect(result.acquired).toBe(true);
  });

  it("engineVersion が違っても、走っている実行があれば断る", async () => {
    // **版が違えば別の Run**（§5.4）だが、同じ施設・同じ業務日を
    // 同時に 2 本読ませない。
    const gate = new ReconciliationGate(fakeStorage());
    await gate.acquire({ runKey: "a", engineVersion: "1.0", nowMs: NOW });

    const result = await gate.acquire({ runKey: "b", engineVersion: "2.0", nowMs: NOW + 1000 });

    expect(result.acquired).toBe(false);
  });
});

describe("ReconciliationGate — 落ちた実行に塞がれない（DECISIONS #109）", () => {
  it("貸出期限を過ぎた保持は奪える", async () => {
    const gate = new ReconciliationGate(fakeStorage());
    await gate.acquire({ runKey: "a", engineVersion: "1.0", nowMs: NOW });

    const result = await gate.acquire({
      runKey: "b",
      engineVersion: "1.0",
      nowMs: NOW + RECONCILIATION_LEASE_MS,
    });

    expect(result.acquired).toBe(true);
    expect(result.acquired && result.tookOverStale).toBe(true);
  });

  it("期限の 1 ミリ秒手前ではまだ奪えない", async () => {
    const gate = new ReconciliationGate(fakeStorage());
    await gate.acquire({ runKey: "a", engineVersion: "1.0", nowMs: NOW });

    const result = await gate.acquire({
      runKey: "b",
      engineVersion: "1.0",
      nowMs: NOW + RECONCILIATION_LEASE_MS - 1,
    });

    expect(result.acquired).toBe(false);
  });

  it("正常に取れた実行は「奪った」と印を付けない", async () => {
    const gate = new ReconciliationGate(fakeStorage());

    const result = await gate.acquire({ runKey: "a", engineVersion: "1.0", nowMs: NOW });

    expect(result.acquired && result.tookOverStale).toBe(false);
  });
});

describe("ReconciliationGate — 解放", () => {
  it("手放したあとは次が取れる", async () => {
    const gate = new ReconciliationGate(fakeStorage());
    await gate.acquire({ runKey: "a", engineVersion: "1.0", nowMs: NOW });

    expect(await gate.release("a")).toBe(true);
    const result = await gate.acquire({ runKey: "b", engineVersion: "1.0", nowMs: NOW + 10 });
    expect(result.acquired).toBe(true);
  });

  it("別の実行の解放要求は無視する（奪われたあとの遅れた解放）", async () => {
    const gate = new ReconciliationGate(fakeStorage());
    await gate.acquire({ runKey: "a", engineVersion: "1.0", nowMs: NOW });

    expect(await gate.release("b")).toBe(false);
    expect((await gate.peek())?.runKey).toBe("a");
  });

  it("何も走っていなければ解放は何もしない", async () => {
    const gate = new ReconciliationGate(fakeStorage());
    expect(await gate.release("a")).toBe(false);
  });

  it("永続化された保持を読み直す（インスタンスが作り直されても続く）", async () => {
    const storage = fakeStorage({ runKey: "a", engineVersion: "1.0", startedAtMs: NOW });
    const gate = new ReconciliationGate(storage);

    expect((await gate.peek())?.runKey).toBe("a");
    const result = await gate.acquire({ runKey: "b", engineVersion: "1.0", nowMs: NOW + 10 });
    expect(result.acquired).toBe(false);
  });
});

describe("reconciliationLockName", () => {
  it("粒度は施設 × 業務日（architecture.md §4）", () => {
    expect(reconciliationLockName("org_a", "o7k2m9__prop_1", "2026-09-09")).toBe(
      "org_a:o7k2m9__prop_1:2026-09-09",
    );
  });

  it("業務日が違えば別のインスタンス（同じ施設の別日は同時に走ってよい）", () => {
    const first = reconciliationLockName("org_a", "o7k2m9__prop_1", "2026-09-09");
    const second = reconciliationLockName("org_a", "o7k2m9__prop_1", "2026-09-10");
    expect(first).not.toBe(second);
  });

  it("組織が違えば別のインスタンス", () => {
    const first = reconciliationLockName("org_a", "o7k2m9__prop_1", "2026-09-09");
    const second = reconciliationLockName("org_b", "o7k2m9__prop_1", "2026-09-09");
    expect(first).not.toBe(second);
  });
});
