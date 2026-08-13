/**
 * 忘れ物・不具合の写真アップロード（PK-SPEC-P2 §7.5 / §8.1）。
 *
 * task:  docs/tasks/P2-13.md
 * ルール: .claude/rules/security.md §4
 *
 * ── 清掃・検査と同じ手順を通る ──────────────────────────
 * サイズ・形式の検査 → EXIF 除去 → ハッシュ → R2 は
 * `lib/photo/pipeline.ts` に固定してある（4 経路で共有）。
 * ここが持つのは**経路ごとに違う 3 つ**だけ。
 *   ① 親の行を引く（施設は**資源から解決する** / INV-32）
 *   ② 権限（`lostItem.write` / `issue.write`）
 *   ③ INSERT 先の表
 *
 * ── `clientId` の再送判定を持たない ─────────────────────
 * `taskPhoto` / `inspectionPhoto` は端末が採番した `clientId` で再送を
 * 弾く（オフラインのキューが再送するため）。**忘れ物と不具合の写真には
 * その列を作っていない。** M-13 は「報告を立ててから写真を送る」1 往復で、
 * 送信中に画面を離れる作りにしていない（`routes/m/report.tsx`）。
 * オフラインのキューへ載せる task が現れたら、そのとき列を足すこと
 * （後方互換の追加で済む / architecture.md §6）。
 *
 * ── 保管場所の写真を撮らせない ──────────────────────────
 * §7.5 が求めるのは「忘れ物**全体が分かる写真** 1 枚」。security.md §4 は
 * 「パスポート・身分証・カード・予約票・PC 画面の撮影を促す UI を作らない」。
 * **この層は枚数を制限しない**が、画面（M-13）は 1 枚だけを撮らせる。
 */

import type { PhotoErrorCode } from "@pk/contracts";
import {
  createIssuePhoto,
  createLostItemPhoto,
  findIssueReportById,
  findLostItemById,
  type Env,
  type TenantContext,
} from "@pk/db";

import { assertPermission, propertyTarget } from "../auth/permission.js";

import { storePhoto } from "./pipeline.js";
import { photoStorageKey } from "./upload.js";

/** 1 枚ぶんの結果。 */
export type UploadReportPhotoOutcome =
  | { kind: "OK"; photoId: string; storageKey: string; sha256: string }
  | { kind: "REJECTED"; error: PhotoErrorCode };

/**
 * 忘れ物の写真（§7.5）。
 *
 * キーは清掃写真と同じ体系（`photos/{orgId}/{propertyId}/{businessDate}/…`）。
 * **`taskId` の位置に忘れ物の ID を入れる。** 別の体系を作ると、
 * `isOwnPhotoKey()`（`routes/api/v1/files.ts` のテナント照合）と
 * 保持期間の掃除の両方に例外が増える。
 */
export async function uploadLostItemPhoto(
  env: Env,
  ctx: TenantContext,
  input: { lostItemId: string; bytes: Uint8Array; uploadedById: string },
): Promise<UploadReportPhotoOutcome> {
  const row = await findLostItemById(env, ctx, input.lostItemId);
  if (row === undefined) return { kind: "REJECTED", error: "INVALID_REQUEST" };
  assertPermission(ctx, "lostItem.write", propertyTarget([row.propertyId]));

  // §7.4「自分が登録した内容」。**他人の忘れ物へ写真を足させない。**
  if (ctx.role === "CLEANER" && row.foundById !== input.uploadedById) {
    return { kind: "REJECTED", error: "INVALID_REQUEST" };
  }

  const photoId = crypto.randomUUID();
  const stored = await storePhoto(env, input.bytes, (extension) =>
    photoStorageKey({
      organizationId: ctx.organizationId,
      propertyId: row.propertyId,
      businessDate: row.businessDate,
      taskId: row.id,
      photoId,
      extension,
    }),
  );
  if (stored.kind === "REJECTED") return stored;

  const created = await createLostItemPhoto(env, ctx, {
    lostItemId: row.id,
    propertyId: row.propertyId,
    storageKey: stored.photo.storageKey,
    sha256: stored.photo.sha256,
    uploadedById: input.uploadedById,
  });

  return {
    kind: "OK",
    photoId: created.photoId,
    storageKey: stored.photo.storageKey,
    sha256: stored.photo.sha256,
  };
}

/**
 * 不具合の写真（§8.1「写真 1 枚以上」）。
 *
 * **閉じた報告には足せない。** 後から証跡を足せる形にしない
 * （`uploadInspectionPhoto()` が確定済みの検査を拒むのと同じ理由）。
 */
export async function uploadIssuePhoto(
  env: Env,
  ctx: TenantContext,
  input: { issueId: string; bytes: Uint8Array; uploadedById: string },
): Promise<UploadReportPhotoOutcome> {
  const row = await findIssueReportById(env, ctx, input.issueId);
  if (row === undefined) return { kind: "REJECTED", error: "INVALID_REQUEST" };
  assertPermission(ctx, "issue.write", propertyTarget([row.propertyId]));

  if (row.status === "CLOSED" || row.status === "WONT_FIX") {
    return { kind: "REJECTED", error: "INVALID_REQUEST" };
  }
  if (ctx.role === "CLEANER" && row.reportedById !== input.uploadedById) {
    return { kind: "REJECTED", error: "INVALID_REQUEST" };
  }

  const photoId = crypto.randomUUID();
  const stored = await storePhoto(env, input.bytes, (extension) =>
    photoStorageKey({
      organizationId: ctx.organizationId,
      propertyId: row.propertyId,
      // 不具合は業務日の列を持たない（§3.6）。**報告日で束ねる。**
      // 保持期間の掃除がこの区切りで走る（`photoStorageKey()` の注記）。
      businessDate: row.reportedAt.toISOString().slice(0, 10),
      taskId: row.id,
      photoId,
      extension,
    }),
  );
  if (stored.kind === "REJECTED") return stored;

  const created = await createIssuePhoto(env, ctx, {
    issueId: row.id,
    propertyId: row.propertyId,
    storageKey: stored.photo.storageKey,
    sha256: stored.photo.sha256,
    uploadedById: input.uploadedById,
  });

  return {
    kind: "OK",
    photoId: created.photoId,
    storageKey: stored.photo.storageKey,
    sha256: stored.photo.sha256,
  };
}
