/**
 * 検査開始の排他の検査。
 *
 * task:  docs/tasks/P2-03.md
 * ルール: .claude/rules/testing.md §5（同時検査開始 → 1 件のみ成功）
 *
 * `InspectionGate` を直に回す。DO の殻（`fetch`）は経路の分岐しか持たない。
 */

import { describe, expect, it } from "vitest";

import {
  InspectionGate,
  LOCK_STORAGE_KEY,
  inspectionLockName,
  type InspectionHolder,
  type LockStorage,
} from "./InspectionLock.js";

const NOW = Date.parse("2026-09-10T04:00:00.000Z");

/**
 * 永続化の代役。**`put` / `delete` を意図的に非同期にしてある。**
 * 同期で終わる代役だと、`await` の隙に別の要求が入る状況を再現できない。
 */
function fakeStorage(initial?: InspectionHolder): LockStorage {
  const store = new Map<string, InspectionHolder>();
  if (initial !== undefined) store.set(LOCK_STORAGE_KEY, initial);
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

describe("InspectionGate", () => {
  it("空いていれば取れる", async () => {
    const gate = new InspectionGate(fakeStorage());

    const result = await gate.acquire({ round: 1, inspectorId: "mem_a", nowMs: NOW });

    expect(result.acquired).toBe(true);
    expect(result.holder).toEqual({ round: 1, inspectorId: "mem_a", startedAtMs: NOW });
  });

  it("同じラウンドの別の検査者は断られ、保持者が返る", async () => {
    const gate = new InspectionGate(fakeStorage());
    await gate.acquire({ round: 1, inspectorId: "mem_a", nowMs: NOW });

    const result = await gate.acquire({ round: 1, inspectorId: "mem_b", nowMs: NOW + 1000 });

    expect(result.acquired).toBe(false);
    expect(result.holder.inspectorId).toBe("mem_a");
  });

  it("同じ検査者の再要求は通る（再送・画面の再読み込み）", async () => {
    const gate = new InspectionGate(fakeStorage());
    const first = await gate.acquire({ round: 1, inspectorId: "mem_a", nowMs: NOW });

    const again = await gate.acquire({ round: 1, inspectorId: "mem_a", nowMs: NOW + 5000 });

    expect(again.acquired).toBe(true);
    // **開始時刻は最初のまま。** 再送で検査時間が短く見えないようにする。
    expect(again.holder.startedAtMs).toBe(first.holder.startedAtMs);
  });

  it("差戻し後の次ラウンドは別の検査者でも取れる", async () => {
    // §4.6: 再検査は別の検査者が担当しうる。前ラウンドの保持が残っていても
    // 次のラウンドを塞がない。
    const gate = new InspectionGate(fakeStorage());
    await gate.acquire({ round: 1, inspectorId: "mem_a", nowMs: NOW });

    const second = await gate.acquire({ round: 2, inspectorId: "mem_b", nowMs: NOW + 60_000 });

    expect(second.acquired).toBe(true);
    expect(second.holder).toEqual({ round: 2, inspectorId: "mem_b", startedAtMs: NOW + 60_000 });
  });

  it("古いラウンドの遅れて届いた要求は断る", async () => {
    const gate = new InspectionGate(fakeStorage());
    await gate.acquire({ round: 2, inspectorId: "mem_b", nowMs: NOW });

    const stale = await gate.acquire({ round: 1, inspectorId: "mem_a", nowMs: NOW + 1 });

    expect(stale.acquired).toBe(false);
    expect(stale.holder.round).toBe(2);
  });

  it("同時に 50 件届いても成功は 1 件だけ（testing.md §5）", async () => {
    const gate = new InspectionGate(fakeStorage());

    const results = await Promise.all(
      Array.from({ length: 50 }, (_unused, index) =>
        gate.acquire({ round: 1, inspectorId: `mem_${String(index)}`, nowMs: NOW + index }),
      ),
    );

    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    // 断られた 49 件はすべて同じ保持者を指す。
    const holders = new Set(results.map((result) => result.holder.inspectorId));
    expect(holders.size).toBe(1);
    expect(holders.has("mem_0")).toBe(true);
  });

  it("同じ検査者からの 50 並列は全部通る（再送は競合ではない）", async () => {
    const gate = new InspectionGate(fakeStorage());

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        gate.acquire({ round: 1, inspectorId: "mem_a", nowMs: NOW }),
      ),
    );

    expect(results.every((result) => result.acquired)).toBe(true);
  });

  it("保持を手放すと次の検査者が取れる", async () => {
    const gate = new InspectionGate(fakeStorage());
    await gate.acquire({ round: 1, inspectorId: "mem_a", nowMs: NOW });

    expect(await gate.release(1)).toBe(true);

    const next = await gate.acquire({ round: 1, inspectorId: "mem_b", nowMs: NOW + 1000 });
    expect(next.acquired).toBe(true);
  });

  it("別のラウンドの release は何もしない", async () => {
    const gate = new InspectionGate(fakeStorage());
    await gate.acquire({ round: 2, inspectorId: "mem_b", nowMs: NOW });

    expect(await gate.release(1)).toBe(false);
    expect((await gate.peek())?.inspectorId).toBe("mem_b");
  });

  it("保持が無いときの release は false", async () => {
    const gate = new InspectionGate(fakeStorage());
    expect(await gate.release(1)).toBe(false);
  });

  it("永続化された保持を読み直す（インスタンスが落ちても続く）", async () => {
    const stored: InspectionHolder = { round: 1, inspectorId: "mem_a", startedAtMs: NOW };
    const gate = new InspectionGate(fakeStorage(stored));

    const result = await gate.acquire({ round: 1, inspectorId: "mem_b", nowMs: NOW + 1000 });

    expect(result.acquired).toBe(false);
    expect(result.holder).toEqual(stored);
  });

  it("peek は保持を取らない", async () => {
    const gate = new InspectionGate(fakeStorage());

    expect(await gate.peek()).toBeNull();

    const result = await gate.acquire({ round: 1, inspectorId: "mem_a", nowMs: NOW });
    expect(result.acquired).toBe(true);
  });
});

describe("inspectionLockName", () => {
  it("組織 ID とタスク ID から名前を組み立てる", () => {
    expect(inspectionLockName("org_a", "a1b2c3__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH")).toBe(
      "org_a:a1b2c3__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
    );
  });

  it("組織が違えば別のインスタンスになる", () => {
    const taskId = "a1b2c3__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH";
    expect(inspectionLockName("org_a", taskId)).not.toBe(inspectionLockName("org_b", taskId));
  });
});
