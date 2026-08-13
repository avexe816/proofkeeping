/**
 * 証跡スナップショットの書き込み（PK-SPEC-P2 §6.2）。
 *
 * task:  docs/tasks/P2-08.md
 * ルール: .claude/rules/architecture.md §2
 *
 * ── 呼ぶ順序 ────────────────────────────────────────────
 *   1. payload を組む（`packages/engine` の純粋関数）
 *   2. `canonicalJson()` で文字列にする
 *   3. `payloadSha256 = sha256(その文字列)`
 *   4. 同一タスクの直前のスナップショットを引く → `previousHash`
 *   5. `chainHash = sha256(chainHashInput(previousHash, payloadSha256))`
 *   6. INSERT
 *
 * **業務操作が成功したあとに呼ぶこと。** 証跡は起きた事実の記録で、
 * これから起きることの予約ではない。呼び出し側（`complete.ts` /
 * `transition.ts` / `lib/rework/advance.ts`）は状態遷移が
 * 成功した枝でだけこれを呼ぶ。
 *
 * ── 失敗を業務操作へ伝播させない ────────────────────────
 * 証跡の書き込みが落ちても、検査や再清掃そのものは成立している。
 * ここで例外を投げると、**現場の操作が「失敗」に見えて再送が始まり、
 * 二重に進む余地を作る。** `recordEvidence()` は結果を戻り値で返し、
 * 呼び出し側は成否を見ずに進む（`releaseInspectionLock()` と同じ扱い）。
 * 落ちたことは戻り値の `kind` で分かるので、後から検出できる。
 *
 * **そのために `payload` を関数で受ける。** 値で受けると
 * `recordEvidence(..., { payload: await build(...) })` と書けてしまい、
 * payload を組む段の DB 読み取りが**この関数の外**で走る。そこで落ちた
 * 例外は上の約束を素通りして業務操作を 500 にする。関数で受ければ
 * 組み立ても `try` の内側に入る。
 *
 * ── 連鎖の競合について ──────────────────────────────────
 * 手順 4 と 6 の間に別の証跡が入ると、2 件が同じ `previousHash` を持つ。
 * **実際には起きない**（証跡を書く 3 経路はいずれも楽観的排他に勝った
 * 1 つの操作からしか呼ばれない — `result IS NULL` / `status = from` /
 * `applyTransition()` の状態条件）。**分岐が生じても検出はできる**
 * （`verifyEvidenceChain()` の `linkMatches` が偽になる）ので、
 * 静かに壊れる形にはなっていない。ロックを増やしていないのはこのため。
 */

import type { EvidenceTypeValue } from "@pk/contracts";
import {
  appendEvidenceSnapshot,
  findLatestEvidenceSnapshotByTask,
  type Env,
  type TenantContext,
} from "@pk/db";
import { canonicalJson, chainHashInput, type CanonicalValue } from "@pk/engine";

import { sha256HexOfText } from "./hash.js";

/** 書き込みの入力。 */
export interface RecordEvidenceInput {
  propertyId: string;
  /** 日報など、タスクに紐づかない証跡がある（§3.7）。 */
  taskId: string | null;
  businessDate: string;
  evidenceType: EvidenceTypeValue;
  /**
   * payload を組む関数。**値ではなく関数**（冒頭の注記）。
   *
   * 材料の読み取り（`lib/evidence/payload.ts`）もこの中で行うこと。
   */
  payload: () => CanonicalValue | Promise<CanonicalValue>;
  /** 生成した `membership.id`。バッチ生成では `null`。 */
  createdById?: string | null | undefined;
  /** 訂正元（§6.4）。**元の行は残る。** */
  correctsSnapshotId?: string | null | undefined;
  correctionReason?: string | null | undefined;
}

/** 書き込みの結果。**失敗も戻り値で返す**（冒頭の注記）。 */
export type RecordEvidenceOutcome =
  | { kind: "OK"; snapshotId: string; payloadSha256: string; chainHash: string }
  | { kind: "FAILED"; reason: string };

/**
 * 証跡を 1 件残す。
 *
 * @returns 成否。**呼び出し側は失敗しても業務操作を巻き戻さない。**
 */
export async function recordEvidence(
  env: Env,
  ctx: TenantContext,
  input: RecordEvidenceInput,
): Promise<RecordEvidenceOutcome> {
  try {
    // 正規化した**文字列をそのまま保存する。** 読み出し側で
    // `JSON.parse` → `JSON.stringify` を通さない（並びが変わる）。
    const payload = canonicalJson(await input.payload());
    const payloadSha256 = await sha256HexOfText(payload);

    // 連鎖は**同一タスク内**（§3.7）。タスクに紐づかない証跡（日報）は
    // 先頭として扱う。**施設・業務日でまとめた連鎖を作らない**（仕様に無い）。
    const previous =
      input.taskId === null
        ? undefined
        : await findLatestEvidenceSnapshotByTask(env, ctx, input.taskId);
    const previousHash = previous?.chainHash ?? null;
    const chainHash = await sha256HexOfText(chainHashInput(previousHash, payloadSha256));

    const created = await appendEvidenceSnapshot(env, ctx, {
      propertyId: input.propertyId,
      taskId: input.taskId,
      businessDate: input.businessDate,
      evidenceType: input.evidenceType,
      payload,
      payloadSha256,
      previousHash,
      chainHash,
      createdById: input.createdById ?? null,
      correctsSnapshotId: input.correctsSnapshotId ?? null,
      correctionReason: input.correctionReason ?? null,
    });

    return { kind: "OK", snapshotId: created.id, payloadSha256, chainHash };
  } catch (error) {
    // **文言を組み立てない。** 例外の名前だけを残す（payload に業務データが
    // 入っているため、メッセージをそのまま持ち回るとログへ漏れる）。
    return { kind: "FAILED", reason: error instanceof Error ? error.name : "UNKNOWN" };
  }
}
