/**
 * 証跡 ZIP コンシューマのテスト（PK-SPEC-P2 §6.5）。
 *
 * task:  docs/tasks/P2-10.md
 * ルール: .claude/rules/testing.md §4（冪等: 3 回実行しても結果が変わらない）
 *
 * ── 何をテストしているか ────────────────────────────────
 * `exportEvidenceBundle()` を丸ごと動かすには、D1 の代役へ
 * 「タスク → 施設 → 客室 → 証跡 → 検査 → 写真」の 6 種類の行を
 * **実行順どおりに積む**ことになる（`createFakeD1()` は順番に返す）。
 * 順序に依存したテストは、実装の読み取り順を変えただけで壊れ、
 * **壊れたことが「壊れた」を意味しない。**
 *
 * そこで冪等性は**結果が決まる 3 か所**で押さえる。
 *   ① R2 のキー … `taskId` から決まる（同じタスクは同じキーへ上書き）
 *   ② 中身 … 同じ入力・同じ `requestedAtMs` から同じバイト列
 *   ③ メッセージの検証 … 壊れたメッセージを ack して落とす
 * ①②が揃えば「3 回処理しても R2 の状態が同じ」が成り立つ。
 */

import { describe, expect, it } from "vitest";

import { buildEvidenceBundle, type BundleContextInput } from "../lib/evidence/bundle.js";
import { buildZip } from "../lib/zip/store.js";

import {
  EVIDENCE_BUNDLE_PREFIX,
  evidenceBundleKey,
  isEvidenceExportMessage,
  type EvidenceExportMessage,
} from "./evidenceExport.js";

const MESSAGE: EvidenceExportMessage = {
  kind: "EVIDENCE_ZIP",
  organizationId: "org_test_alpha",
  orgShortId: "a1b2c3",
  taskId: "a1b2c3__task_01JBXQ3ZK8N4P2VYR6",
  requestedById: "a1b2c3__mem_admin",
  requestedAtMs: Date.UTC(2026, 8, 10, 5, 0, 0),
};

describe("evidenceBundleKey", () => {
  it("組織 ID を接頭辞に持つ", () => {
    expect(evidenceBundleKey("org_a", "task_1")).toBe(`${EVIDENCE_BUNDLE_PREFIX}org_a/task_1.zip`);
  });

  it("同じタスクは何度呼んでも同じキー（＝上書き / 冪等）", () => {
    const keys = [1, 2, 3].map(() => evidenceBundleKey(MESSAGE.organizationId, MESSAGE.taskId));
    expect(new Set(keys).size).toBe(1);
  });

  it("組織が違えばキーも違う", () => {
    expect(evidenceBundleKey("org_a", "task_1")).not.toBe(evidenceBundleKey("org_b", "task_1"));
  });

  it("シャード番号を含まない（architecture.md §1）", () => {
    expect(evidenceBundleKey("org_a", "task_1")).not.toMatch(/shard/i);
  });
});

describe("isEvidenceExportMessage", () => {
  it("正しいメッセージを通す", () => {
    expect(isEvidenceExportMessage(MESSAGE)).toBe(true);
  });

  it.each([
    ["null", null],
    ["文字列", "EVIDENCE_ZIP"],
    ["kind 違い", { ...MESSAGE, kind: "PDF" }],
    ["taskId が無い", { ...MESSAGE, taskId: undefined }],
    ["requestedAtMs が文字列", { ...MESSAGE, requestedAtMs: "0" }],
    ["orgShortId が無い", { ...MESSAGE, orgShortId: undefined }],
  ])("%s は通さない", (_label, value) => {
    expect(isEvidenceExportMessage(value)).toBe(false);
  });
});

describe("冪等: 同じメッセージから同じ書庫ができる", () => {
  const context: BundleContextInput = {
    taskId: MESSAGE.taskId,
    propertyCode: "HTLA",
    roomNumber: "302",
    businessDate: "2026-09-10",
    taskType: "CHECKOUT",
    // **メッセージが持つ時刻を使う。** `new Date()` にすると
    // 再送のたびに manifest が変わり「同じ結果」でなくなる。
    generatedAt: new Date(MESSAGE.requestedAtMs),
    requestedById: MESSAGE.requestedById,
    chainOk: true,
  };
  const snapshots = [
    {
      snapshotId: "evd_1",
      evidenceType: "CLEANING_COMPLETION",
      payload: '{"taskId":"t"}',
      payloadSha256: "p1",
      previousHash: null,
      chainHash: "c1",
      correctsSnapshotId: null,
      createdAtMs: Date.UTC(2026, 8, 10, 4, 25, 31),
    },
  ];
  const photos = [
    {
      photoId: "ph_1",
      source: "CLEANING" as const,
      bytes: new TextEncoder().encode("jpeg"),
      sha256: "abc",
    },
  ];

  it("3 回組み立てても同じバイト列になる", async () => {
    const runs = await Promise.all(
      [1, 2, 3].map(async () => buildZip((await buildEvidenceBundle(context, snapshots, photos)).entries)),
    );
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });

  it("要求時刻が変われば manifest も変わる（時刻を握り潰していない）", async () => {
    const first = await buildEvidenceBundle(context, snapshots, photos);
    const later = await buildEvidenceBundle(
      { ...context, generatedAt: new Date(MESSAGE.requestedAtMs + 60_000) },
      snapshots,
      photos,
    );
    expect(buildZip(later.entries)).not.toEqual(buildZip(first.entries));
  });

  it("ファイル名も 3 回とも同じ", async () => {
    const names = await Promise.all(
      [1, 2, 3].map(async () => (await buildEvidenceBundle(context, snapshots, photos)).fileName),
    );
    expect(new Set(names)).toEqual(new Set(["PK-20260910-HTLA-302.zip"]));
  });
});
