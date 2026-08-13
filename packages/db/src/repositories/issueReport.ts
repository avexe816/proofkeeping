/**
 * 設備不具合のリポジトリ（PK-SPEC-P2 §3.6 / §8）。
 *
 * task: docs/tasks/P2-12.md
 *
 * ── 客室を戻さない ──────────────────────────────────────
 * §8.3「不具合を閉じても客室状態は自動復旧しない」。この層に
 * `room` を書く関数は 1 つも無い。**止める側**（§8.2 の `CRITICAL`）は
 * `setHousekeepingStatus()` / `setRoomSaleStatus()` を呼び出し側から使う。
 * 戻す側は W-03 の手動上書き（理由必須・監査ログ）だけ。
 *
 * ── 物理削除しない ──────────────────────────────────────
 * `db.delete(issueReport)` を書かない。取り下げは `WONT_FIX`。
 * `repositories.spec.ts` がソースを走査して固定する。
 *
 * ── 免除（§4.7）が参照する ──────────────────────────────
 * `reworkCycle.waivedIssueId` がこの表を指す。P2-07 は**形式しか
 * 検査していなかった**（DECISIONS #071）。`findIssueReportById()` が
 * 実在確認の入口になる（`lib/rework/advance.ts` が使う）。
 */

import { and, desc, eq, inArray } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import {
  issueHistory,
  issuePhoto,
  issueReport,
  type IssueCategory,
  type IssueSeverity,
  type IssueStatus,
} from "../schema/report.js";

import { withTenantScope } from "./base.js";

/** 一覧の絞り込み。 */
export interface IssueReportFilter {
  propertyId?: string | undefined;
  roomId?: string | undefined;
  status?: readonly IssueStatus[] | undefined;
  severity?: readonly IssueSeverity[] | undefined;
  reportedById?: string | undefined;
}

/** 一覧。**報告が新しい順。** 重要度で並べ替えない（一覧の意味が変わる）。 */
export async function listIssueReports(
  env: Env,
  ctx: TenantContext,
  filter: IssueReportFilter = {},
) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(issueReport)
    .where(
      withTenantScope(
        issueReport,
        ctx,
        issueReport.propertyId,
        filter.propertyId === undefined
          ? undefined
          : eq(issueReport.propertyId, filter.propertyId),
        filter.roomId === undefined ? undefined : eq(issueReport.roomId, filter.roomId),
        filter.status === undefined || filter.status.length === 0
          ? undefined
          : inArray(issueReport.status, [...filter.status]),
        filter.severity === undefined || filter.severity.length === 0
          ? undefined
          : inArray(issueReport.severity, [...filter.severity]),
        filter.reportedById === undefined
          ? undefined
          : eq(issueReport.reportedById, filter.reportedById),
      ),
    )
    .orderBy(desc(issueReport.reportedAt), desc(issueReport.id));
}

/**
 * 1 件。
 *
 * **免除（§4.7）の実在確認にも使う**（DECISIONS #071 の未達を閉じる）。
 * 別組織の ID は `assertIdBelongsToTenant()` で 404 になる。
 */
export async function findIssueReportById(env: Env, ctx: TenantContext, issueId: string) {
  assertIdBelongsToTenant(issueId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(issueReport)
    .where(withTenantScope(issueReport, ctx, issueReport.propertyId, eq(issueReport.id, issueId)))
    .limit(1);
  return rows[0];
}

/** `createIssueReport()` の入力。 */
export interface CreateIssueReportInput {
  propertyId: string;
  taskId: string | null;
  roomId: string;
  category: IssueCategory;
  severity: IssueSeverity;
  title: string;
  description: string;
  reportedById: string;
  /** この報告が客室を止めたか（§8.2）。**判断は呼び出し側**（engine の `roomEffectOf()`）。 */
  roomBlocked: boolean;
}

/**
 * 不具合を 1 件登録する（§8.1）。
 *
 * 状態は `OPEN` から始まり、履歴に 1 行（`fromStatus = null`）を残す。
 * `createLostItem()` と同じく `batch()` で 2 文をまとめる。
 */
export async function createIssueReport(
  env: Env,
  ctx: TenantContext,
  input: CreateIssueReportInput,
): Promise<{ issueId: string }> {
  assertIdBelongsToTenant(input.propertyId, ctx);
  assertIdBelongsToTenant(input.roomId, ctx);
  if (input.taskId !== null) assertIdBelongsToTenant(input.taskId, ctx);
  const db = await getTenantDb(env, ctx);

  const id = generateId(ctx.orgShortId, "issue");
  await db.batch([
    db.insert(issueReport).values({
      id,
      organizationId: ctx.organizationId,
      propertyId: input.propertyId,
      taskId: input.taskId,
      roomId: input.roomId,
      category: input.category,
      severity: input.severity,
      title: input.title,
      description: input.description,
      status: "OPEN",
      reportedById: input.reportedById,
      reportedAt: ctx.now,
      roomBlocked: input.roomBlocked,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    }),
    db.insert(issueHistory).values({
      id: generateId(ctx.orgShortId, "issue"),
      organizationId: ctx.organizationId,
      propertyId: input.propertyId,
      issueId: id,
      fromStatus: null,
      toStatus: "OPEN",
      actorId: input.reportedById,
      note: null,
      occurredAt: ctx.now,
    }),
  ]);

  return { issueId: id };
}

/** `advanceIssueReport()` の入力。 */
export interface AdvanceIssueReportInput {
  issueId: string;
  /** 期待する現在の状態。**これと違えば書かない**（楽観的排他）。 */
  from: IssueStatus;
  to: IssueStatus;
  actorId: string;
  note: string | null;
  /** 解決内容（`RESOLVED` へ進むとき必須。判定は engine）。 */
  resolutionNote?: string | null | undefined;
  assignedToId?: string | null | undefined;
}

/** 遷移の結果。 */
export type AdvanceIssueReportResult = { kind: "ADVANCED" } | { kind: "NOOP" };

/**
 * 状態を進める（§3.6 / §8.3）。
 *
 * **`status = from` の行にしか当たらない。** 再送は 0 行更新になり `NOOP`。
 *
 * **`roomBlocked` を偽へ戻さない**（§8.3）。この列は「この報告が客室を
 * 止めたか」であって「いま止まっているか」ではない。
 */
export async function advanceIssueReport(
  env: Env,
  ctx: TenantContext,
  input: AdvanceIssueReportInput,
): Promise<AdvanceIssueReportResult> {
  assertIdBelongsToTenant(input.issueId, ctx);
  const db = await getTenantDb(env, ctx);

  const result = await db
    .update(issueReport)
    .set({
      status: input.to,
      ...(input.resolutionNote === undefined ? {} : { resolutionNote: input.resolutionNote }),
      ...(input.assignedToId === undefined ? {} : { assignedToId: input.assignedToId }),
      ...(input.to === "ACKNOWLEDGED" ? { acknowledgedAt: ctx.now } : {}),
      ...(input.to === "RESOLVED" ? { resolvedAt: ctx.now } : {}),
      updatedAt: ctx.now,
    })
    .where(
      and(
        eq(issueReport.organizationId, ctx.organizationId),
        eq(issueReport.id, input.issueId),
        eq(issueReport.status, input.from),
      ),
    );

  // `meta.changes` は D1 が必ず返す（型も `number`）。0 は「その行が
  // 期待した状態でなかった」＝再送・並行操作。
  if (result.meta.changes === 0) return { kind: "NOOP" };

  const row = await findIssueReportById(env, ctx, input.issueId);
  await db.insert(issueHistory).values({
    id: generateId(ctx.orgShortId, "issue"),
    organizationId: ctx.organizationId,
    propertyId: row?.propertyId ?? "",
    issueId: input.issueId,
    fromStatus: input.from,
    toStatus: input.to,
    actorId: input.actorId,
    note: input.note,
    occurredAt: ctx.now,
  });

  return { kind: "ADVANCED" };
}

/** 状態履歴。**古い順。** */
export async function listIssueHistory(env: Env, ctx: TenantContext, issueId: string) {
  assertIdBelongsToTenant(issueId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(issueHistory)
    .where(
      withTenantScope(issueHistory, ctx, issueHistory.propertyId, eq(issueHistory.issueId, issueId)),
    )
    .orderBy(issueHistory.occurredAt, issueHistory.id);
}

/** 写真。**1 枚以上が必須**（§8.1。必須判定は呼び出し側）。 */
export async function listIssuePhotos(env: Env, ctx: TenantContext, issueId: string) {
  assertIdBelongsToTenant(issueId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(issuePhoto)
    .where(withTenantScope(issuePhoto, ctx, issuePhoto.propertyId, eq(issuePhoto.issueId, issueId)))
    .orderBy(issuePhoto.uploadedAt, issuePhoto.id);
}

/** `createIssuePhoto()` の入力。 */
export interface CreateIssuePhotoInput {
  issueId: string;
  propertyId: string;
  storageKey: string;
  sha256: string;
  uploadedById: string;
}

/** 写真を 1 枚足す。 */
export async function createIssuePhoto(
  env: Env,
  ctx: TenantContext,
  input: CreateIssuePhotoInput,
): Promise<{ photoId: string }> {
  assertIdBelongsToTenant(input.issueId, ctx);
  assertIdBelongsToTenant(input.propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  const id = generateId(ctx.orgShortId, "issue");
  await db.insert(issuePhoto).values({
    id,
    organizationId: ctx.organizationId,
    propertyId: input.propertyId,
    issueId: input.issueId,
    storageKey: input.storageKey,
    sha256: input.sha256,
    uploadedAt: ctx.now,
    uploadedById: input.uploadedById,
  });
  return { photoId: id };
}
