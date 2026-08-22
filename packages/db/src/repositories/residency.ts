/**
 * 在留資格のリポジトリ（P8-02 / PK-SPEC-P8 §1.4）。
 *
 * task: docs/tasks/P8-02.md
 * 契約: docs/PK-IMPL-CONTRACT.md **INV-08**
 * ルール: .claude/rules/security.md §3 / §6
 *
 * ── 読める相手を狭くしたまま渡す ────────────────────────
 * INV-08 は「在留資格の情報は**運営管理者のみ**が閲覧できる。
 * 現場責任者・オーナー・プラットフォーム運営に公開しない」。
 * **権限判定は呼び出し側**（`assertPermission(ctx, "residency.read", …)`）。
 * リポジトリはテナントスコープだけを見る（他の表と同じ / DECISIONS #017）。
 *
 * ── 件数だけを返す口を分けてある ────────────────────────
 * `PROPERTY_MANAGER` には「期限確認が必要なスタッフがいます」の**件数のみ**
 * （仕様 §1.4 MUST）。一覧の関数を呼んで画面側で数えると、間違えたときに
 * 一覧が丸ごと漏れる。**数えるための関数を別に置く**
 * （`countExpiringResidencies()` は個人を特定できる列を 1 つも返さない）。
 *
 * ── 施設スコープを掛けない ──────────────────────────────
 * 在留資格は組織に属する事実で、施設に紐づかない。`NO_PROPERTY_SCOPE`。
 * 到達の制限は `residency.read`（`ORG_ADMIN` のみ組織全体）が担う。
 */

import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { chunkIdsForInArray } from "../limits.js";
import { getTenantDb, type TenantContext } from "../router.js";
import {
  residencyRecord,
  type ResidencyStatusType,
} from "../schema/workforce.js";

import { NO_PROPERTY_SCOPE, withTenantScope } from "./base.js";

/** 在留資格 1 件。**番号も国籍も含まない**（そもそも列が無い）。 */
export interface ResidencyRow {
  id: string;
  staffProfileId: string;
  statusType: ResidencyStatusType;
  statusLabel: string | null;
  expiresOn: string | null;
  renewalAppliedOn: string | null;
  workPermitRequired: boolean;
  weeklyHourLimit: number | null;
  note: string | null;
}

/**
 * 在留資格の一覧（仕様 §1.4）。**期限の近い順。**
 *
 * `expiresOn` が `null`（日本国籍など）の行は**最後**に置く。
 * SQLite の `ORDER BY` は `NULL` を先に並べるので、明示的に後ろへ送る。
 */
export async function listResidencyRecords(
  env: Env,
  ctx: TenantContext,
): Promise<ResidencyRow[]> {
  const db = await getTenantDb(env, ctx);
  return db
    .select({
      id: residencyRecord.id,
      staffProfileId: residencyRecord.staffProfileId,
      statusType: residencyRecord.statusType,
      statusLabel: residencyRecord.statusLabel,
      expiresOn: residencyRecord.expiresOn,
      renewalAppliedOn: residencyRecord.renewalAppliedOn,
      workPermitRequired: residencyRecord.workPermitRequired,
      weeklyHourLimit: residencyRecord.weeklyHourLimit,
      note: residencyRecord.note,
    })
    .from(residencyRecord)
    .where(withTenantScope(residencyRecord, ctx, NO_PROPERTY_SCOPE))
    .orderBy(sql`${residencyRecord.expiresOn} is null`, residencyRecord.expiresOn);
}

/**
 * 期限が `onOrBefore` 以前に来る件数（仕様 §1.4 MUST の「件数のみ」）。
 *
 * **個人を特定できる値を 1 つも返さない。** `PROPERTY_MANAGER` の画面と、
 * `ORG_ADMIN` の KPI（「在留期限 90 日以内 2 名」）の両方がこれを使う。
 *
 * `expiresOn` が `null` の行は数えない（期限が無いものは近づかない）。
 */
export async function countExpiringResidencies(
  env: Env,
  ctx: TenantContext,
  onOrBefore: string,
): Promise<number> {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(residencyRecord)
    .where(
      withTenantScope(
        residencyRecord,
        ctx,
        NO_PROPERTY_SCOPE,
        isNotNull(residencyRecord.expiresOn),
        lte(residencyRecord.expiresOn, onOrBefore),
      ),
    );
  return rows[0]?.count ?? 0;
}

/**
 * 期限切れのスタッフ（`staff_pay_profile.id`）の集合。
 *
 * **P8-02 の「期限切れで新規タスク配分を停止する」がこれを引く。**
 * 配分は現場を止めない方向に倒すので、返すのは ID だけで、
 * 画面へ出す情報は含めない。
 */
export async function listExpiredResidencyStaffIds(
  env: Env,
  ctx: TenantContext,
  businessDate: string,
): Promise<string[]> {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ staffProfileId: residencyRecord.staffProfileId })
    .from(residencyRecord)
    .where(
      withTenantScope(
        residencyRecord,
        ctx,
        NO_PROPERTY_SCOPE,
        isNotNull(residencyRecord.expiresOn),
        // **`< businessDate`。当日はまだ切れていない**（仕様の「0日 → 期限切れ」は
        // その日をもって満了する意で、当日の勤務まで止めると現場が止まる）。
        sql`${residencyRecord.expiresOn} < ${businessDate}`,
      ),
    );
  return rows.map((row) => row.staffProfileId);
}

/** `upsertResidencyRecord()` の入力。 */
export interface UpsertResidencyInput {
  staffProfileId: string;
  statusType: ResidencyStatusType;
  statusLabel: string | null;
  expiresOn: string | null;
  renewalAppliedOn: string | null;
  workPermitRequired: boolean;
  weeklyHourLimit: number | null;
  note: string | null;
  /** 更新した `membership.id`。 */
  updatedById: string;
}

/**
 * 1 スタッフ 1 行（`uq_residency_staff`）。2 回目は更新になる。
 *
 * **履歴を行で持たない。** 訂正の追跡は `recordAudit()`（security.md §6）。
 * 呼び出し側が `before` / `after` を残すこと。
 *
 * ── 停止の解除がここを通ることに意味がある ──────────────
 * 仕様 §1.4 MUST は「停止解除は `ORG_ADMIN` 以上が `expiresOn` を更新した
 * 場合のみ。**手動での解除ボタンを作らない**」。解除の口をこの関数の
 * 外に作らないこと。
 */
export async function upsertResidencyRecord(
  env: Env,
  ctx: TenantContext,
  input: UpsertResidencyInput,
): Promise<{ id: string }> {
  assertIdBelongsToTenant(input.staffProfileId, ctx);
  assertIdBelongsToTenant(input.updatedById, ctx);
  const db = await getTenantDb(env, ctx);
  const id = generateId(ctx.orgShortId, "resd");

  const values = {
    statusType: input.statusType,
    statusLabel: input.statusLabel,
    expiresOn: input.expiresOn,
    renewalAppliedOn: input.renewalAppliedOn,
    workPermitRequired: input.workPermitRequired,
    weeklyHourLimit: input.weeklyHourLimit,
    note: input.note,
    updatedById: input.updatedById,
    updatedAt: ctx.now,
  };

  await db
    .insert(residencyRecord)
    .values({
      id,
      organizationId: ctx.organizationId,
      staffProfileId: input.staffProfileId,
      createdAt: ctx.now,
      ...values,
    })
    .onConflictDoUpdate({
      target: [residencyRecord.organizationId, residencyRecord.staffProfileId],
      set: values,
    });

  const rows = await db
    .select({ id: residencyRecord.id })
    .from(residencyRecord)
    .where(
      and(
        eq(residencyRecord.organizationId, ctx.organizationId),
        eq(residencyRecord.staffProfileId, input.staffProfileId),
      ),
    )
    .limit(1);
  return { id: rows[0]?.id ?? id };
}

/**
 * 保存期間を満了した在留資格の記録を**物理削除する**（P8-11）。
 *
 * task: docs/tasks/P8-11.md
 *
 * ── 消してよいかを、ここで判断しない ────────────────────
 * 受け取るのは `staff_pay_profile.id` の配列だけ。**退職日も経過日数も
 * 見ない。** 判定は `lib/staff/residencyRetention.ts` の純粋関数が行い、
 * ここは言われたものを消すだけにする（判定が 2 か所にあると、
 * 片方だけ直したときに消しすぎる）。
 *
 * ── 物理削除にする ──────────────────────────────────────
 * 訂正の履歴を残す帳票や `EvidenceSnapshot` と違い、**在留資格は
 * 「持たないこと」に意味がある。** 論理削除の列を作らない。
 *
 * ── 冪等 ────────────────────────────────────────────────
 * 2 回目は消す行が無いので 0 を返す。**呼び出し側が件数で分岐しない
 * かぎり、何度実行しても結果は変わらない。**
 *
 * @returns 実際に消えた行数。
 */
export async function deleteResidencyRecords(
  env: Env,
  ctx: TenantContext,
  staffProfileIds: readonly string[],
): Promise<number> {
  if (staffProfileIds.length === 0) return 0;
  for (const staffProfileId of staffProfileIds) assertIdBelongsToTenant(staffProfileId, ctx);

  const db = await getTenantDb(env, ctx);
  let deleted = 0;
  // D1 の束縛変数の上限を超えないように分ける（`chunkIdsForInArray()`）。
  for (const chunk of chunkIdsForInArray(staffProfileIds)) {
    const result = await db
      .delete(residencyRecord)
      .where(
        withTenantScope(
          residencyRecord,
          ctx,
          NO_PROPERTY_SCOPE,
          inArray(residencyRecord.staffProfileId, [...chunk]),
        ),
      );
    deleted += result.meta.changes;
  }
  return deleted;
}
