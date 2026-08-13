/**
 * 正規化 JSON とハッシュ連鎖の入力（PK-SPEC-P2 §6.2 / §6.3）。
 *
 * task:  docs/tasks/P2-08.md
 * ルール: .claude/rules/testing.md §3
 *
 * **決定性を直接押さえる。** 「同入力 → 同ハッシュ」は P2-08 の完了条件で、
 * ハッシュ関数を通す前の文字列が決定的であることがその実体。
 */

import { describe, expect, it } from "vitest";

import {
  CanonicalJsonError,
  GENESIS_HASH,
  buildCleaningCompletionPayload,
  buildInspectionPayload,
  buildReworkCompletionPayload,
  canonicalJson,
  chainHashInput,
  isoUtc,
  verifyEvidenceChain,
  type CanonicalValue,
  type SnapshotVerificationInput,
} from "./evidence.js";

describe("canonicalJson — 正例", () => {
  it("キーを辞書順に並べる", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("挿入順が違っても同じ文字列になる（決定的）", () => {
    const first = canonicalJson({ taskId: "t", businessDate: "2026-09-10", round: 1 });
    const second = canonicalJson({ round: 1, businessDate: "2026-09-10", taskId: "t" });
    expect(first).toBe(second);
  });

  it("入れ子のオブジェクトも並べ替える", () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it("配列の順序は保つ（順序そのものが記録）", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("配列の中のオブジェクトも並べ替える", () => {
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it("null を残す（「無い」と「空」を区別する）", () => {
    expect(canonicalJson({ note: null })).toBe('{"note":null}');
  });

  it("undefined のキーは落とす", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("空白を入れない", () => {
    expect(canonicalJson({ a: [1, 2], b: "x" })).toBe('{"a":[1,2],"b":"x"}');
  });

  it("真偽値・文字列のエスケープが JSON として妥当", () => {
    const text = canonicalJson({ ok: true, note: 'a"b\n' });
    expect(text).toBe('{"note":"a\\"b\\n","ok":true}');
    expect(JSON.parse(text)).toEqual({ ok: true, note: 'a"b\n' });
  });

  it("-0 を 0 に寄せる", () => {
    expect(canonicalJson({ n: -0 })).toBe('{"n":0}');
  });

  it("非 ASCII のキーもコードユニット順（ロケールに依存しない）", () => {
    expect(canonicalJson({ 部屋: 1, ID: 2 })).toBe('{"ID":2,"部屋":1}');
  });

  it("空のオブジェクト・空の配列", () => {
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
  });
});

describe("canonicalJson — 負例", () => {
  it("小数を拒否する（§6.2「数値を整数へ統一」）", () => {
    expect(() => canonicalJson({ amount: 1.5 })).toThrow(CanonicalJsonError);
  });

  it("NaN を拒否する", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(CanonicalJsonError);
  });

  it("Infinity を拒否する", () => {
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(CanonicalJsonError);
  });

  it("関数を拒否する", () => {
    const value = { fn: (): void => undefined } as unknown as CanonicalValue;
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });

  it("undefined を直接渡したら拒否する（キーの値としては落ちるが、根は通さない）", () => {
    expect(() => canonicalJson(undefined as unknown as CanonicalValue)).toThrow(
      CanonicalJsonError,
    );
  });

  it("Date を拒否する（isoUtc を通すこと）", () => {
    // `Date` は object なので走査に入り、キーが 0 個の `{}` になってしまう。
    // **黙って空になるほうが危ない**ので、そうならないことを固定する。
    const value = { at: new Date(0) } as unknown as CanonicalValue;
    expect(canonicalJson(value)).toBe('{"at":{}}');
  });
});

describe("isoUtc", () => {
  it("ISO 8601 UTC のミリ秒付き", () => {
    expect(isoUtc(Date.UTC(2026, 8, 10, 4, 25, 31))).toBe("2026-09-10T04:25:31.000Z");
  });

  it("epoch 0", () => {
    expect(isoUtc(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("整数でない時刻を拒否する", () => {
    expect(() => isoUtc(1.5)).toThrow(CanonicalJsonError);
  });
});

describe("chainHashInput", () => {
  it("先頭は GENESIS", () => {
    expect(chainHashInput(null, "abc")).toBe(`${GENESIS_HASH}abc`);
  });

  it("2 件目以降は前の chainHash を前置する", () => {
    expect(chainHashInput("prev", "abc")).toBe("prevabc");
  });
});

describe("payload の組立", () => {
  it("清掃完了は §6.2 の例と同じキーを持つ", () => {
    const payload = buildCleaningCompletionPayload({
      taskId: "o7k2m9__task_1",
      roomId: "o7k2m9__room_302",
      businessDate: "2026-09-10",
      taskType: "CHECKOUT",
      cleanerId: "o7k2m9__mem_1",
      completedAtMs: Date.UTC(2026, 8, 10, 4, 25, 31),
      actualMinutes: 42,
      checklistTemplateVersion: 2,
      photos: [{ id: "o7k2m9__photo_1", sha256: "aa" }],
      timeLogs: [{ event: "START", atMs: Date.UTC(2026, 8, 10, 4, 12, 0), reasonCode: null }],
    });
    const parsed = JSON.parse(canonicalJson(payload)) as Record<string, unknown>;

    expect(Object.keys(parsed)).toEqual([
      "actualMinutes",
      "businessDate",
      "cleanerId",
      "completedAt",
      "photos",
      "roomId",
      "taskId",
      "taskType",
      "templateVersion",
      "timeLogs",
    ]);
    expect(parsed.completedAt).toBe("2026-09-10T04:25:31.000Z");
  });

  it("清掃完了の payload に宿泊者・氏名の項目が無い（security.md §3）", () => {
    const text = canonicalJson(
      buildCleaningCompletionPayload({
        taskId: "t",
        roomId: "r",
        businessDate: "2026-09-10",
        taskType: "CHECKOUT",
        cleanerId: "o7k2m9__mem_1",
        completedAtMs: 0,
        actualMinutes: null,
        checklistTemplateVersion: null,
        photos: [],
        timeLogs: [],
      }),
    );
    for (const forbidden of ["guest", "Name", "name", "phone", "email", "passport"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("同じ入力から同じ文字列（清掃完了）", () => {
    const input = {
      taskId: "t",
      roomId: "r",
      businessDate: "2026-09-10",
      taskType: "CHECKOUT",
      cleanerId: null,
      completedAtMs: 1_000,
      actualMinutes: 10,
      checklistTemplateVersion: 1,
      photos: [{ id: "p", sha256: "aa" }],
      timeLogs: [{ event: "START", atMs: 0, reasonCode: null }],
    } as const;
    expect(canonicalJson(buildCleaningCompletionPayload(input))).toBe(
      canonicalJson(buildCleaningCompletionPayload(input)),
    );
  });

  it("検査は項目を全部載せる（不合格だけに絞らない）", () => {
    const payload = buildInspectionPayload({
      taskId: "t",
      roomId: "r",
      businessDate: "2026-09-10",
      inspectionId: "i",
      round: 1,
      inspectorId: "m",
      result: "FAIL",
      startedAtMs: 0,
      completedAtMs: 1_000,
      durationSeconds: 1,
      selfApproved: false,
      generalNote: null,
      items: [
        {
          checklistItemId: "a",
          status: "PASS",
          defectCode: null,
          note: null,
          reworkRequired: false,
          photos: [],
        },
        {
          checklistItemId: "b",
          status: "FAIL",
          defectCode: "WATER_SPOT",
          note: "右下に水滴跡があります",
          reworkRequired: true,
          photos: [{ id: "ip", sha256: "bb" }],
        },
      ],
    });
    const parsed = JSON.parse(canonicalJson(payload)) as { items: unknown[] };
    expect(parsed.items).toHaveLength(2);
  });

  it("再清掃完了は差し戻された項目 ID を持つ", () => {
    const parsed = JSON.parse(
      canonicalJson(
        buildReworkCompletionPayload({
          taskId: "t",
          roomId: "r",
          businessDate: "2026-09-10",
          reworkCycleId: "w",
          inspectionId: "i",
          round: 1,
          assignedToId: "m",
          reasonSummary: "WATER_SPOT",
          startedAtMs: 0,
          completedAtMs: 1_000,
          reworkItemIds: ["b"],
          photos: [],
        }),
      ),
    ) as { reworkItemIds: string[]; startedAt: string | null };
    expect(parsed.reworkItemIds).toEqual(["b"]);
    expect(parsed.startedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("再清掃完了は開始時刻が無くても組める", () => {
    const parsed = JSON.parse(
      canonicalJson(
        buildReworkCompletionPayload({
          taskId: "t",
          roomId: "r",
          businessDate: "2026-09-10",
          reworkCycleId: "w",
          inspectionId: "i",
          round: 1,
          assignedToId: "m",
          reasonSummary: "",
          startedAtMs: null,
          completedAtMs: 1_000,
          reworkItemIds: [],
          photos: [],
        }),
      ),
    ) as { startedAt: string | null };
    expect(parsed.startedAt).toBeNull();
  });
});

describe("verifyEvidenceChain", () => {
  /** 健全な 1 件。 */
  const healthy = (
    id: string,
    payloadHash: string,
    chain: string,
    previous: string | null,
  ): SnapshotVerificationInput => ({
    snapshotId: id,
    storedPayloadSha256: payloadHash,
    recomputedPayloadSha256: payloadHash,
    storedChainHash: chain,
    recomputedChainHash: chain,
    previousHash: previous,
  });

  it("空の連鎖は健全", () => {
    expect(verifyEvidenceChain([])).toEqual({
      ok: true,
      firstBrokenSnapshotId: null,
      snapshots: [],
    });
  });

  it("先頭の previousHash が null なら繋がっている", () => {
    expect(verifyEvidenceChain([healthy("s1", "p1", "c1", null)]).ok).toBe(true);
  });

  it("3 件が正しく繋がっていれば健全", () => {
    const result = verifyEvidenceChain([
      healthy("s1", "p1", "c1", null),
      healthy("s2", "p2", "c2", "c1"),
      healthy("s3", "p3", "c3", "c2"),
    ]);
    expect(result.ok).toBe(true);
    expect(result.snapshots).toHaveLength(3);
  });

  it("payload の書き換えを検出する", () => {
    const result = verifyEvidenceChain([
      healthy("s1", "p1", "c1", null),
      { ...healthy("s2", "p2", "c2", "c1"), recomputedPayloadSha256: "TAMPERED" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.firstBrokenSnapshotId).toBe("s2");
    expect(result.snapshots[1]?.payloadMatches).toBe(false);
    // 連鎖そのものは自己整合のまま。**payload の不一致だけで落ちる。**
    expect(result.snapshots[1]?.chainMatches).toBe(true);
  });

  it("chainHash の書き換えを検出する", () => {
    const result = verifyEvidenceChain([
      { ...healthy("s1", "p1", "c1", null), recomputedChainHash: "OTHER" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.snapshots[0]?.chainMatches).toBe(false);
  });

  it("途中の 1 件の削除を linkMatches で検出する", () => {
    // s2 を消すと、残った s1 / s3 はそれぞれ自己整合のままだが繋がりが切れる。
    const result = verifyEvidenceChain([
      healthy("s1", "p1", "c1", null),
      healthy("s3", "p3", "c3", "c2"),
    ]);
    expect(result.ok).toBe(false);
    expect(result.firstBrokenSnapshotId).toBe("s3");
    expect(result.snapshots[1]?.linkMatches).toBe(false);
    expect(result.snapshots[1]?.payloadMatches).toBe(true);
  });

  it("先頭に previousHash があるのは繋がっていない", () => {
    expect(verifyEvidenceChain([healthy("s1", "p1", "c1", "somewhere")]).ok).toBe(false);
  });

  it("1 件の改ざんが以降すべてを壊れ扱いにしない（起点が読める）", () => {
    const result = verifyEvidenceChain([
      { ...healthy("s1", "p1", "c1", null), recomputedPayloadSha256: "TAMPERED" },
      healthy("s2", "p2", "c2", "c1"),
    ]);
    expect(result.firstBrokenSnapshotId).toBe("s1");
    expect(result.snapshots[1]?.ok).toBe(true);
  });
});
