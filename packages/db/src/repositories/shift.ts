/**
 * シフトのリポジトリ（P8-03 / PK-SPEC-P8 §1.5）。
 *
 * task: docs/tasks/P8-03.md
 * ルール: .claude/rules/architecture.md §2 / security.md §5
 *
 * ── 施設スコープを掛けない ──────────────────────────────
 * シフトはスタッフ（組織の人）の予定で、`propertyId` は `WORK` の行しか
 * 持たない。施設スコープを掛けると休み（`OFF` など）の行が消える。
 * `NO_PROPERTY_SCOPE`。到達の制限は `shift.manage` が担う。
 *
 * ── 打刻の関数を置かない ────────────────────────────────
 * これは**予定**の表（DECISIONS #221）。「出勤済み」はタスクの開始から
 * 数える（`lib/staff/shiftBoard.ts`）ので、実績を書く関数が無い。
 *
 * ── 個人の集計関数を置かない ────────────────────────────
 * security.md §5。日ごと・週ごとの**人数**は数えるが、個人ごとの
 * 勤務時間合計・出勤率を返す関数を足さないこと。
 */

import { and, eq, gte, lte } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { shiftPlan, type ShiftType } from "../schema/workforce.js";

import { NO_PROPERTY_SCOPE, withTenantScope } from "./base.js";

/** シフト 1 件。 */
export interface ShiftRow {
  id: string;
  membershipId: string;
  businessDate: string;
  shiftType: ShiftType;
  propertyId: string | null;
  startAt: string | null;
  endAt: string | null;
  breakMinutes: number;
  note: string | null;
}

const SHIFT_COLUMNS = {
  id: shiftPlan.id,
  membershipId: shiftPlan.membershipId,
  businessDate: shiftPlan.businessDate,
  shiftType: shiftPlan.shiftType,
  propertyId: shiftPlan.propertyId,
  startAt: shiftPlan.startAt,
  endAt: shiftPlan.endAt,
  breakMinutes: shiftPlan.breakMinutes,
  note: shiftPlan.note,
} as const;

/**
 * 期間のシフト（両端を含む）。週の画面と KPI が使う。
 *
 * 業務日は `YYYY-MM-DD` の text なので辞書順の比較で日付順になる
 * （architecture.md §7 / `TaskFilter` と同じ形）。
 */
export async function listShifts(
  env: Env,
  ctx: TenantContext,
  range: { from: string; to: string },
): Promise<ShiftRow[]> {
  const db = await getTenantDb(env, ctx);
  return db
    .select(SHIFT_COLUMNS)
    .from(shiftPlan)
    .where(
      withTenantScope(
        shiftPlan,
        ctx,
        NO_PROPERTY_SCOPE,
        gte(shiftPlan.businessDate, range.from),
        lte(shiftPlan.businessDate, range.to),
      ),
    )
    .orderBy(shiftPlan.businessDate, shiftPlan.membershipId);
}

/** `upsertShift()` の入力。1 スタッフ × 1 業務日。 */
export interface UpsertShiftInput {
  membershipId: string;
  businessDate: string;
  shiftType: ShiftType;
  /** `WORK` のときだけ。**検証は呼び出し側**（contracts の Zod）。 */
  propertyId: string | null;
  startAt: string | null;
  endAt: string | null;
  breakMinutes: number;
  note: string | null;
}

/**
 * 1 スタッフ 1 業務日 1 行（`uq_shift_plan`）。2 回目は上書き。
 *
 * **履歴を行で持たない。** シフトは予定で、確定した実績ではない。
 * 変更の追跡が要る運用になったら監査ログを検討する（いまは
 * `recordAudit()` の対象に入れていない — 予定の組み替えは日常の操作で、
 * security.md §6 の列挙にも無い）。
 */
export async function upsertShift(
  env: Env,
  ctx: TenantContext,
  input: UpsertShiftInput,
): Promise<void> {
  assertIdBelongsToTenant(input.membershipId, ctx);
  if (input.propertyId !== null) assertIdBelongsToTenant(input.propertyId, ctx);

  const db = await getTenantDb(env, ctx);
  const values = {
    shiftType: input.shiftType,
    propertyId: input.propertyId,
    startAt: input.startAt,
    endAt: input.endAt,
    breakMinutes: input.breakMinutes,
    note: input.note,
    updatedAt: ctx.now,
  };
  await db
    .insert(shiftPlan)
    .values({
      id: generateId(ctx.orgShortId, "shift"),
      organizationId: ctx.organizationId,
      membershipId: input.membershipId,
      businessDate: input.businessDate,
      createdAt: ctx.now,
      ...values,
    })
    .onConflictDoUpdate({
      target: [shiftPlan.organizationId, shiftPlan.membershipId, shiftPlan.businessDate],
      set: values,
    });
}

/**
 * シフトを消す（「未登録」へ戻す）。
 *
 * `OFF` と「未登録」は違う — `OFF` は「休みと決めた」、未登録は
 * 「まだ決めていない」。間違えて登録した行を戻す口が無いと、
 * 全員ぶんの行が消せないゴミとして残る。**発行済み帳票ではない**
 * （billing.md §2 の禁止はここに当たらない。予定の表）。
 */
export async function deleteShift(
  env: Env,
  ctx: TenantContext,
  input: { membershipId: string; businessDate: string },
): Promise<void> {
  assertIdBelongsToTenant(input.membershipId, ctx);
  const db = await getTenantDb(env, ctx);
  await db
    .delete(shiftPlan)
    .where(
      and(
        eq(shiftPlan.organizationId, ctx.organizationId),
        eq(shiftPlan.membershipId, input.membershipId),
        eq(shiftPlan.businessDate, input.businessDate),
      ),
    );
}

/**
 * 前週の複製（仕様 §1.5 MUST「前週のシフトを複製できること」）。
 *
 * `sourceFrom`〜`sourceTo`（7 日）を `targetFrom` からの同じ並びへ写す。
 *
 * ── 冪等（testing.md §4）─────────────────────────────────
 * 3 回実行しても結果は同じ。**書き込み先に既に行がある日は飛ばす**
 * （`onConflictDoNothing`）。上書きにしないのは、複製後に手で直した
 * シフトを、もう一度押した複製が黙って戻すため。
 */
export async function copyShiftWeek(
  env: Env,
  ctx: TenantContext,
  input: { sourceFrom: string; sourceTo: string; targetFrom: string },
): Promise<{ copied: number; skipped: number }> {
  const source = await listShifts(env, ctx, { from: input.sourceFrom, to: input.sourceTo });
  if (source.length === 0) return { copied: 0, skipped: 0 };

  const db = await getTenantDb(env, ctx);
  let copied = 0;
  let skipped = 0;
  for (const row of source) {
    const offset = daysBetween(input.sourceFrom, row.businessDate);
    const targetDate = addDays(input.targetFrom, offset);
    if (targetDate === null) {
      skipped += 1;
      continue;
    }
    const result = await db
      .insert(shiftPlan)
      .values({
        id: generateId(ctx.orgShortId, "shift"),
        organizationId: ctx.organizationId,
        membershipId: row.membershipId,
        businessDate: targetDate,
        shiftType: row.shiftType,
        propertyId: row.propertyId,
        startAt: row.startAt,
        endAt: row.endAt,
        breakMinutes: row.breakMinutes,
        // メモは写さない。「8/12 は歯医者で早退」が翌週に残ると誤読を生む。
        note: null,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .onConflictDoNothing({
        target: [shiftPlan.organizationId, shiftPlan.membershipId, shiftPlan.businessDate],
      });
    if (result.meta.changes > 0) copied += 1;
    else skipped += 1;
  }
  return { copied, skipped };
}

/** `YYYY-MM-DD` 同士の日数差。形が違えば 0（複製を黙って別の日へ飛ばさない）。 */
function daysBetween(from: string, to: string): number {
  const a = epochDayOf(from);
  const b = epochDayOf(to);
  return a === null || b === null ? 0 : b - a;
}

function epochDayOf(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return null;
  return Math.floor(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000,
  );
}

function addDays(date: string, days: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return null;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days);
  return new Date(at).toISOString().slice(0, 10);
}
