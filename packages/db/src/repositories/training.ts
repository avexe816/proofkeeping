/**
 * 研修と資格のリポジトリ（P8-10 / プロトタイプ ops 08）。
 *
 * task: docs/tasks/P8-10.md
 * ルール: .claude/rules/security.md §5
 *
 * ── 成績・点数・順位の関数を置かない ────────────────────
 * 研修は「修了したか」だけを記録する。個人の進捗率ランキングも、
 * 修了までの速さの比較も作らない（security.md §5）。
 *
 * ── 施設スコープを掛けない ──────────────────────────────
 * 研修も資格も組織の事実で、施設に紐づかない。`NO_PROPERTY_SCOPE`。
 * 到達の制限は呼び出し側の `user.write`（OWNER / ORG_ADMIN）が担う。
 */

import { and, eq } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { certificationRecord, trainingProgram, trainingRecord } from "../schema/workforce.js";

import { NO_PROPERTY_SCOPE, withTenantScope } from "./base.js";

/** 研修プログラム 1 件。 */
export interface TrainingProgramRow {
  id: string;
  name: string;
  expectedMinutes: number;
  languages: string[];
  sortOrder: number;
  isActive: boolean;
}

/** 並びは表示順。**無効も返す**（過去の修了記録が指す先を消さない）。 */
export async function listTrainingPrograms(
  env: Env,
  ctx: TenantContext,
): Promise<TrainingProgramRow[]> {
  const db = await getTenantDb(env, ctx);
  return db
    .select({
      id: trainingProgram.id,
      name: trainingProgram.name,
      expectedMinutes: trainingProgram.expectedMinutes,
      languages: trainingProgram.languages,
      sortOrder: trainingProgram.sortOrder,
      isActive: trainingProgram.isActive,
    })
    .from(trainingProgram)
    .where(withTenantScope(trainingProgram, ctx, NO_PROPERTY_SCOPE))
    .orderBy(trainingProgram.sortOrder, trainingProgram.name);
}

/** プログラムを足す（初期 6 項目の投入と、後からの追加）。 */
export async function createTrainingProgram(
  env: Env,
  ctx: TenantContext,
  input: { name: string; expectedMinutes: number; languages: string[]; sortOrder: number },
): Promise<{ id: string }> {
  const db = await getTenantDb(env, ctx);
  const id = generateId(ctx.orgShortId, "trpg");
  await db.insert(trainingProgram).values({
    id,
    organizationId: ctx.organizationId,
    name: input.name,
    expectedMinutes: input.expectedMinutes,
    languages: input.languages,
    sortOrder: input.sortOrder,
    isActive: true,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  return { id };
}

/** 修了記録 1 件。 */
export interface TrainingRecordRow {
  id: string;
  membershipId: string;
  programId: string;
  completedOn: string;
  mentorMembershipId: string | null;
}

export async function listTrainingRecords(
  env: Env,
  ctx: TenantContext,
): Promise<TrainingRecordRow[]> {
  const db = await getTenantDb(env, ctx);
  return db
    .select({
      id: trainingRecord.id,
      membershipId: trainingRecord.membershipId,
      programId: trainingRecord.programId,
      completedOn: trainingRecord.completedOn,
      mentorMembershipId: trainingRecord.mentorMembershipId,
    })
    .from(trainingRecord)
    .where(withTenantScope(trainingRecord, ctx, NO_PROPERTY_SCOPE))
    .orderBy(trainingRecord.completedOn);
}

/** 1 人 × 1 項目で 1 行（`uq_training_record`）。2 回目は上書き（受け直し）。 */
export async function upsertTrainingRecord(
  env: Env,
  ctx: TenantContext,
  input: {
    membershipId: string;
    programId: string;
    completedOn: string;
    mentorMembershipId: string | null;
  },
): Promise<void> {
  assertIdBelongsToTenant(input.membershipId, ctx);
  assertIdBelongsToTenant(input.programId, ctx);
  if (input.mentorMembershipId !== null) assertIdBelongsToTenant(input.mentorMembershipId, ctx);

  const db = await getTenantDb(env, ctx);
  const values = {
    completedOn: input.completedOn,
    mentorMembershipId: input.mentorMembershipId,
    updatedAt: ctx.now,
  };
  await db
    .insert(trainingRecord)
    .values({
      id: generateId(ctx.orgShortId, "trrc"),
      organizationId: ctx.organizationId,
      membershipId: input.membershipId,
      programId: input.programId,
      createdAt: ctx.now,
      ...values,
    })
    .onConflictDoUpdate({
      target: [
        trainingRecord.organizationId,
        trainingRecord.membershipId,
        trainingRecord.programId,
      ],
      set: values,
    });
}

/**
 * 1 人ぶんの研修の進み（検査の新人判定 / P8-10）。
 *
 * **点数ではない。** 有効なプログラムの総数・修了した数・最後の修了日だけ。
 * 検査の判定（`lib/task/inspectionDecision.ts`）が「未修了 = 新人」
 * 「修了から 30 日以内 = 新人」を導くのに使う。
 */
export async function summarizeTrainingProgress(
  env: Env,
  ctx: TenantContext,
  membershipId: string,
): Promise<{ activePrograms: number; completed: number; lastCompletedOn: string | null }> {
  assertIdBelongsToTenant(membershipId, ctx);
  const db = await getTenantDb(env, ctx);

  const programs = await db
    .select({ id: trainingProgram.id })
    .from(trainingProgram)
    .where(
      withTenantScope(trainingProgram, ctx, NO_PROPERTY_SCOPE, eq(trainingProgram.isActive, true)),
    );
  if (programs.length === 0) return { activePrograms: 0, completed: 0, lastCompletedOn: null };

  const records = await db
    .select({ programId: trainingRecord.programId, completedOn: trainingRecord.completedOn })
    .from(trainingRecord)
    .where(
      withTenantScope(
        trainingRecord,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(trainingRecord.membershipId, membershipId),
      ),
    );

  const activeIds = new Set(programs.map((row) => row.id));
  const done = records.filter((row) => activeIds.has(row.programId));
  const lastCompletedOn = done.reduce<string | null>(
    (max, row) => (max === null || row.completedOn > max ? row.completedOn : max),
    null,
  );
  return { activePrograms: programs.length, completed: done.length, lastCompletedOn };
}

/** 資格・講習 1 件。 */
export interface CertificationRow {
  id: string;
  membershipId: string;
  name: string;
  expiresOn: string | null;
  note: string | null;
}

/** 期限の近い順（null は最後）。 */
export async function listCertifications(
  env: Env,
  ctx: TenantContext,
): Promise<CertificationRow[]> {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({
      id: certificationRecord.id,
      membershipId: certificationRecord.membershipId,
      name: certificationRecord.name,
      expiresOn: certificationRecord.expiresOn,
      note: certificationRecord.note,
    })
    .from(certificationRecord)
    .where(withTenantScope(certificationRecord, ctx, NO_PROPERTY_SCOPE));
  return rows.sort((a, b) => {
    if (a.expiresOn === null) return b.expiresOn === null ? 0 : 1;
    if (b.expiresOn === null) return -1;
    return a.expiresOn < b.expiresOn ? -1 : a.expiresOn > b.expiresOn ? 1 : 0;
  });
}

/** 資格を記録する。同じ講習の更新は**行の追加ではなく上書き**にしない — 履歴が要るため追加。 */
export async function createCertification(
  env: Env,
  ctx: TenantContext,
  input: { membershipId: string; name: string; expiresOn: string | null; note: string | null },
): Promise<{ id: string }> {
  assertIdBelongsToTenant(input.membershipId, ctx);
  const db = await getTenantDb(env, ctx);
  const id = generateId(ctx.orgShortId, "cert");
  await db.insert(certificationRecord).values({
    id,
    organizationId: ctx.organizationId,
    membershipId: input.membershipId,
    name: input.name,
    expiresOn: input.expiresOn,
    note: input.note,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  return { id };
}

/** 記録の取り違えを消す（資格は履歴で持つため、上書きの口が無い）。 */
export async function deleteCertification(
  env: Env,
  ctx: TenantContext,
  certificationId: string,
): Promise<void> {
  assertIdBelongsToTenant(certificationId, ctx);
  const db = await getTenantDb(env, ctx);
  await db
    .delete(certificationRecord)
    .where(
      and(
        eq(certificationRecord.organizationId, ctx.organizationId),
        eq(certificationRecord.id, certificationId),
      ),
    );
}
