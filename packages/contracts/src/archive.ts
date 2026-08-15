/**
 * 退避データの復元（PK-SPEC-P7 §9 / P7-09）の入出力。
 *
 * task: docs/tasks/P7-09.md
 *
 * ── 「削除」ではなく「退避」──────────────────────────────
 * P7 固有の絶対ルール。**この定義に `delete` を含む名前を置かない。**
 * 期限が来て読めなくなるのは**復元した写し**であって、退避そのものは
 * R2 に在り続ける（何度でも復元できる）。
 *
 * ── `organizationId` を受け取らない ─────────────────────
 * CLAUDE.md §4。組織はセッションから解決する。
 */

import { z } from "zod";

/** `YYYY-MM-DD`。業務日（architecture.md §7）。 */
const businessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * 復元の要求（§9.1 の手順 1「期間と施設を指定して」）。
 *
 * **期間の幅（最大 3 か月 / §9.2）はここで検証しない。**
 * 月の加減算が要るので `packages/db` の `validateRestoreRange()` が持つ
 * （型の二重定義をしない / CLAUDE.md §5）。ここは形だけを見る。
 */
export const archiveRestoreCreateRequestSchema = z.object({
  /** `null` は組織全体。 */
  propertyId: z.string().min(1).nullable().default(null),
  fromBusinessDate: businessDateSchema,
  toBusinessDate: businessDateSchema,
});

export type ArchiveRestoreCreateRequest = z.infer<typeof archiveRestoreCreateRequestSchema>;

/** 復元の状態（`schema/integration.ts` の `ARCHIVE_RESTORE_STATUSES`）。 */
export const ARCHIVE_RESTORE_STATUS_CODES = [
  "PENDING",
  "RUNNING",
  "READY",
  "EXPIRED",
  "FAILED",
] as const;

export const archiveRestoreStatusSchema = z.enum(ARCHIVE_RESTORE_STATUS_CODES);

export type ArchiveRestoreStatusCode = z.infer<typeof archiveRestoreStatusSchema>;

/** 一覧・詳細が返す 1 件。 */
export interface ArchiveRestoreView {
  id: string;
  propertyId: string | null;
  fromBusinessDate: string;
  toBusinessDate: string;
  status: ArchiveRestoreStatusCode;
  tableCount: number;
  rowCount: number;
  /** 閲覧できる期限（ミリ秒）。`READY` 以外は `null`。 */
  expiresAtMs: number | null;
  /** **短い符号だけ。** 例外の文面を利用者に見せない。 */
  errorCode: string | null;
  requestedAtMs: number;
  completedAtMs: number | null;
}

/** 展開した行 1 件。 */
export interface ArchiveRestoreRowView {
  id: string;
  tableName: string;
  businessDate: string;
  /** JSONL の 1 行そのまま（列名 → 値）。 */
  payload: Record<string, unknown>;
}
