/**
 * 証跡の整合性確認（PK-SPEC-P2 §6.3 / §12.2「整合性を確認」）。
 *
 * task: docs/tasks/P2-08.md
 *
 * ── 保存された文字列を読み直してハッシュする ─────────────
 * `payload` は正規化済みの文字列として保存されている。**その文字列を
 * そのままハッシュする。** `JSON.parse` → `canonicalJson()` を通し直すと
 * 「正規化の実装を変えた」ときに全件が不一致になり、改ざんと区別できない。
 * ここで見ているのは「保存後に書き換えられていないか」だけ。
 *
 * ── 法的タイムスタンプではない ──────────────────────────
 * P2 は外部の時刻認証を導入していない（§6.1 / P2 固有の絶対ルール）。
 * この関数が示せるのは**保存後に書き換えられていないこと**で、
 * 「その時刻に存在したこと」ではない。画面の文言もそう書くこと。
 */

import type { EvidenceVerifyResponse, SnapshotVerificationResult } from "@pk/contracts";
import { listEvidenceSnapshotsByTask, type Env, type TenantContext } from "@pk/db";
import { chainHashInput, verifyEvidenceChain } from "@pk/engine";

import { sha256HexOfText } from "./hash.js";

/**
 * タスク 1 件の証跡連鎖を検証する。
 *
 * 並びは `listEvidenceSnapshotsByTask()`（`createdAt` 昇順）。
 * **その順序が連鎖の順序。** 並べ替えないこと。
 */
export async function verifyTaskEvidence(
  env: Env,
  ctx: TenantContext,
  taskId: string,
): Promise<EvidenceVerifyResponse> {
  const rows = await listEvidenceSnapshotsByTask(env, ctx, taskId);

  const inputs = await Promise.all(
    rows.map(async (row) => {
      const recomputedPayloadSha256 = await sha256HexOfText(row.payload);
      // **保存されている `payloadSha256` から連鎖を再計算する。**
      // 再計算した payload ハッシュを使うと、payload の改ざん 1 件で
      // `chainMatches` も同時に落ち、どちらが起点か読めなくなる。
      const recomputedChainHash = await sha256HexOfText(
        chainHashInput(row.previousHash, row.payloadSha256),
      );
      return {
        snapshotId: row.id,
        storedPayloadSha256: row.payloadSha256,
        recomputedPayloadSha256,
        storedChainHash: row.chainHash,
        recomputedChainHash,
        previousHash: row.previousHash,
      };
    }),
  );

  const verdict = verifyEvidenceChain(inputs);
  const typeById = new Map(rows.map((row) => [row.id, row.evidenceType]));

  const snapshots: SnapshotVerificationResult[] = verdict.snapshots.map((snapshot) => ({
    snapshotId: snapshot.snapshotId,
    evidenceType: typeById.get(snapshot.snapshotId) ?? "CLEANING_COMPLETION",
    payloadMatches: snapshot.payloadMatches,
    chainMatches: snapshot.chainMatches,
    linkMatches: snapshot.linkMatches,
    ok: snapshot.ok,
  }));

  return {
    taskId,
    ok: verdict.ok,
    firstBrokenSnapshotId: verdict.firstBrokenSnapshotId,
    snapshots,
  };
}
