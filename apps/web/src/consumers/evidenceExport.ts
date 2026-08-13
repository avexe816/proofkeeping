/**
 * 証跡 ZIP の生成（PK-SPEC-P2 §6.5）。**Queue コンシューマ。**
 *
 * task:  docs/tasks/P2-10.md
 * ルール: .claude/rules/architecture.md §5（CPU 50ms 超は Queue へ）
 *
 * ```
 * POST /api/v1/evidence/tasks/:taskId/export   → QUEUE_EVIDENCE_EXPORT へ投げる
 *                                              ← ここで ZIP を組み、R2 へ置く
 * GET  /api/v1/evidence/tasks/:taskId/export   → 出来ていれば署名付き URL
 * ```
 *
 * ── なぜ Queue なのか ───────────────────────────────────
 * 写真 20 枚（各 500KB）を R2 から読み、SHA-256 を 20 回以上取り、
 * ZIP に詰める。**リクエストハンドラの CPU 予算（50ms）に収まらない。**
 * §6.5 は非同期処理を明示していないが、architecture.md §5 の
 * `evidence-export` キューはこのために用意されている。
 *
 * ── 状態を持つ表を作っていない ──────────────────────────
 * 「生成中 / 完了 / 失敗」を持つ表を足すと、**発行済み帳票と同じ重みの
 * 管理対象が 1 つ増える**（消せない・訂正できない）。ZIP は証跡そのもの
 * ではなく**証跡の写し**で、いつでも作り直せる。だから状態は
 * **R2 にオブジェクトがあるかどうか**で表す（`GET` が `head()` で見る）。
 * 作り直しは同じキーへの上書きになる（下の「冪等」）。
 *
 * ── 冪等（testing.md §4）─────────────────────────────────
 * 同じメッセージを 3 回処理しても結果が変わらない。キーは
 * `taskId` から決まり、中身も同じ入力から同じバイト列になる
 * （`buildZip()` は決定的、`generatedAt` はメッセージが持つ時刻）。
 * **`generatedAt` を `new Date()` にしないこと。** 再送のたびに
 * manifest が変わり、「同じ結果」でなくなる。
 *
 * ── 監査ログ（§6.5 MUST）────────────────────────────────
 * 「ZIP 生成も evidence.export として監査ログへ記録する」。
 * `export.evidenceZip` は P0 から `AUDIT_ACTIONS` に載っている。
 * **成功したときだけ書く。** 失敗を監査ログへ書くと、「持ち出した記録」に
 * 持ち出していないものが混じる。失敗はログ（`console.error`）に残す。
 */

import {
  findPropertyById,
  findRoomById,
  findTaskById,
  listEvidenceSnapshotsByTask,
  listInspectionPhotos,
  listInspectionsByTask,
  listTaskPhotos,
  recordAudit,
  type Env,
  type TenantContext,
} from "@pk/db";

import {
  buildEvidenceBundle,
  type BundlePhotoInput,
  type BundleSnapshotInput,
} from "../lib/evidence/bundle.js";
import { verifyTaskEvidence } from "../lib/evidence/verify.js";
import { buildZip } from "../lib/zip/store.js";

/** `EVIDENCE` バケットの接頭辞。**写真とは別のバケット**（保持期間が違う）。 */
export const EVIDENCE_BUNDLE_PREFIX = "bundles/";

/**
 * 証跡 ZIP の R2 キー。**`taskId` から決まる。**
 *
 * 組織 ID を先頭に置くのは写真（security.md §4）と同じ理由で、
 * バケットの中を組織で切れるようにするため。**シャード番号は入れない**
 * （architecture.md §1）。
 */
export function evidenceBundleKey(organizationId: string, taskId: string): string {
  return `${EVIDENCE_BUNDLE_PREFIX}${organizationId}/${taskId}.zip`;
}

/** キューへ載せるメッセージ。**組織の解決に要る値を全部持たせる。** */
export interface EvidenceExportMessage {
  kind: "EVIDENCE_ZIP";
  organizationId: string;
  orgShortId: string;
  taskId: string;
  /** 要求した `membership.id`。監査ログの `actorId` になる。 */
  requestedById: string;
  /** 要求した時刻（ミリ秒）。**再送でも変わらない**（冒頭の「冪等」）。 */
  requestedAtMs: number;
}

/** メッセージの形を確かめる。**Zod を使わない**（contracts は API の入出力の定義）。 */
export function isEvidenceExportMessage(value: unknown): value is EvidenceExportMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message["kind"] === "EVIDENCE_ZIP" &&
    typeof message["organizationId"] === "string" &&
    typeof message["orgShortId"] === "string" &&
    typeof message["taskId"] === "string" &&
    typeof message["requestedById"] === "string" &&
    typeof message["requestedAtMs"] === "number"
  );
}

/** 1 件の処理結果。**呼び出し側（`queue()`）が ack / retry を決める。** */
export type EvidenceExportOutcome =
  | { kind: "OK"; key: string; fileName: string; bytes: number }
  /** タスクが無い・別組織。**再送しても直らない**ので ack する。 */
  | { kind: "SKIPPED"; reason: string }
  /** R2 / D1 の一時的な失敗。**再送で直りうる**ので retry する。 */
  | { kind: "FAILED"; reason: string };

/**
 * 証跡 ZIP を 1 件作る。
 *
 * **写真の実体が無い（保持期間切れ）ときは、その写真を飛ばして続ける。**
 * 書庫が作れないより、揃っているものだけでも渡せる方がよい。
 * 欠けは `manifest.json` の `photos` に現れない形になるが、
 * 証跡の payload 側には `{ id, sha256 }` が残るので、
 * **「あったはずの写真が無い」ことは受け取った側で分かる。**
 */
export async function exportEvidenceBundle(
  env: Env,
  message: EvidenceExportMessage,
): Promise<EvidenceExportOutcome> {
  const generatedAt = new Date(message.requestedAtMs);
  const ctx: TenantContext = {
    organizationId: message.organizationId,
    orgShortId: message.orgShortId,
    // バッチと同じ扱い（`lib/task/nightly.ts` の注記 / OPEN_QUESTIONS #033）。
    // **`assertPermission()` は呼ばない。** 認可は投入した API 側で済んでいる。
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now: generatedAt,
  };

  try {
    const task = await findTaskById(env, ctx, message.taskId);
    if (task === undefined) return { kind: "SKIPPED", reason: "TASK_NOT_FOUND" };

    const [property, room, snapshots, inspections, cleaningPhotos, chain] = await Promise.all([
      findPropertyById(env, ctx, task.propertyId),
      findRoomById(env, ctx, task.roomId),
      listEvidenceSnapshotsByTask(env, ctx, task.id),
      listInspectionsByTask(env, ctx, task.id),
      listTaskPhotos(env, ctx, task.id),
      verifyTaskEvidence(env, ctx, task.id),
    ]);

    const inspectionPhotos = (
      await Promise.all(
        inspections.map((inspection) => listInspectionPhotos(env, ctx, inspection.id)),
      )
    ).flat();

    const photos = await loadPhotoBytes(env, [
      ...cleaningPhotos.map((row) => ({
        photoId: row.id,
        storageKey: row.storageKey,
        sha256: row.sha256,
        source: "CLEANING" as const,
      })),
      ...inspectionPhotos.map((row) => ({
        photoId: row.id,
        storageKey: row.storageKey,
        sha256: row.sha256,
        source: "INSPECTION" as const,
      })),
    ]);

    const bundle = await buildEvidenceBundle(
      {
        taskId: task.id,
        propertyCode: property?.code ?? "X",
        roomNumber: room?.roomNumber ?? "X",
        businessDate: task.businessDate,
        taskType: task.taskType,
        generatedAt,
        requestedById: message.requestedById,
        chainOk: chain.ok,
      },
      snapshots.map(toBundleSnapshot),
      photos,
    );

    const zip = buildZip(bundle.entries);
    const key = evidenceBundleKey(message.organizationId, task.id);
    await env.EVIDENCE.put(key, zip, {
      httpMetadata: {
        contentType: "application/zip",
        // 書庫の名前は R2 のキーでは表せない（キーは `taskId`）。
        // 受け取った側のファイル名は **`Content-Disposition`** で決まる。
        contentDisposition: `attachment; filename="${bundle.fileName}"`,
      },
      customMetadata: { taskId: task.id, chainOk: String(chain.ok) },
    });

    // §6.5 MUST。**成功したときだけ。** 誰が何を持ち出せる状態にしたかを残す。
    await recordAudit(env, ctx, {
      actorId: message.requestedById,
      action: "export.evidenceZip",
      targetType: "task",
      targetId: task.id,
      propertyId: task.propertyId,
      after: {
        fileName: bundle.fileName,
        snapshotCount: snapshots.length,
        photoCount: photos.length,
        chainOk: chain.ok,
      },
    });

    return { kind: "OK", key, fileName: bundle.fileName, bytes: zip.length };
  } catch (error) {
    // **payload をログへ流さない。** 例外の名前と task の ID だけ。
    const reason = error instanceof Error ? error.name : "UNKNOWN";
    console.error(`evidence-export-failed task=${message.taskId} reason=${reason}`);
    return { kind: "FAILED", reason };
  }
}

/** `evidenceSnapshot` の行 → 書庫の入力。**payload を触らない。** */
function toBundleSnapshot(row: {
  id: string;
  evidenceType: string;
  payload: string;
  payloadSha256: string;
  previousHash: string | null;
  chainHash: string;
  correctsSnapshotId: string | null;
  createdAt: Date;
}): BundleSnapshotInput {
  return {
    snapshotId: row.id,
    evidenceType: row.evidenceType,
    payload: row.payload,
    payloadSha256: row.payloadSha256,
    previousHash: row.previousHash,
    chainHash: row.chainHash,
    correctsSnapshotId: row.correctsSnapshotId,
    createdAtMs: row.createdAt.getTime(),
  };
}

/** R2 から実体を読む。**無い写真は飛ばす**（冒頭の注記）。 */
async function loadPhotoBytes(
  env: Env,
  rows: readonly {
    photoId: string;
    storageKey: string;
    sha256: string | null;
    source: BundlePhotoInput["source"];
  }[],
): Promise<BundlePhotoInput[]> {
  const loaded = await Promise.all(
    rows.map(async (row): Promise<BundlePhotoInput | null> => {
      const object = await env.PHOTOS.get(row.storageKey);
      if (object === null) return null;
      return {
        photoId: row.photoId,
        source: row.source,
        bytes: new Uint8Array(await object.arrayBuffer()),
        sha256: row.sha256,
      };
    }),
  );
  return loaded.filter((photo): photo is BundlePhotoInput => photo !== null);
}

/**
 * `evidence-export` キューのハンドラ。
 *
 * **1 件ずつ ack / retry を決める。** バッチ全体を retry にすると、
 * 成功した書庫を作り直すことになる（結果は同じだが R2 の書き込みが無駄）。
 */
export async function handleEvidenceExportBatch(
  env: Env,
  batch: MessageBatch,
): Promise<void> {
  for (const message of batch.messages) {
    if (!isEvidenceExportMessage(message.body)) {
      // 形が違うものは**再送しても直らない。** ack して落とす。
      console.error("evidence-export-invalid-message");
      message.ack();
      continue;
    }
    const outcome = await exportEvidenceBundle(env, message.body);
    if (outcome.kind === "FAILED") message.retry();
    else message.ack();
  }
}
