/**
 * 日次集計のリポジトリ。
 *
 * task: docs/tasks/P0-21.md, docs/tasks/P5-14.md
 * 仕様: docs/PK-SPEC-P0.md §19.6, §23.3 / docs/PK-SPEC-P5.md §7.1
 *
 * **施設サマリーはこの表からのみ取る**（§26 の絶対ルール）。
 * タスクテーブルへ直接集計する関数をここへ足さないこと。
 *
 * ── 例外は「再計算の材料」だけ（P5-14）────────────────────
 * 下半分にある `count*ForRollup()` の 3 本は、**タスク・不具合・差異を
 * 数えている。** これは §26 が禁じる「施設サマリーを rollup 以外から
 * 取得する」ではなく、rollup そのものを作る側の処理で、読み手は
 * `rollup-update` のコンシューマ 1 つだけ。**画面や API から呼ばないこと。**
 * ここへ置いたのは、材料と書き込み先を 1 ファイルで読めるようにするため。
 *
 * ── 再計算方式（§19.6 MUST）────────────────────────────
 * `upsertPropertyRollup()` は渡された値でそのまま上書きする。
 * **加算しない。** 同じメッセージを 3 回処理しても結果が変わらない
 * （testing.md §4）。
 */

import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { auditFinding } from "../schema/reconciliation.js";
import { issueReport } from "../schema/report.js";
import { dailyPropertyRollup } from "../schema/rollup.js";
import { cleaningTask } from "../schema/task.js";

import { withTenantScope } from "./base.js";

/**
 * その業務日の集計を、到達できる施設ぶんだけ返す。
 *
 * 施設スコープロールには担当施設の行だけが返る（第 1 層）。
 * **行が無い施設は返らない。** 呼び出し側が「まだ集計が無い」として扱う。
 */
export async function listPropertyRollups(
  env: Env,
  ctx: TenantContext,
  businessDate: string,
) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(dailyPropertyRollup)
    .where(
      withTenantScope(
        dailyPropertyRollup,
        ctx,
        dailyPropertyRollup.propertyId,
        eq(dailyPropertyRollup.businessDate, businessDate),
      ),
    );
}

/**
 * 施設 1 件の集計。
 *
 * 別組織の施設 ID は DB へ行く前に `NotFoundError`（第 2 層）。
 * **「集計がまだ無い」は別の話**で、そちらは自組織の ID に対して
 * `undefined` が返る。例外にしない。
 */
export async function findPropertyRollup(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  businessDate: string,
) {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(dailyPropertyRollup)
    .where(
      withTenantScope(
        dailyPropertyRollup,
        ctx,
        dailyPropertyRollup.propertyId,
        and(
          eq(dailyPropertyRollup.propertyId, propertyId),
          eq(dailyPropertyRollup.businessDate, businessDate),
        ),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * 期間の集計を、到達できる施設ぶんだけ返す（P5-14 / PK-SPEC-P5 §7.1）。
 *
 * 組織ダッシュボードは**月次**なので、1 日ずつ引くと 30 往復になる。
 * `idx_rollup_org`（`organizationId, businessDate`）がそのまま効く。
 *
 * **行が無い日は返らない。** 呼び出し側は「0 件の日」と
 * 「まだ集計されていない日」を区別しない — 月の合計を出すだけなので
 * どちらも足す量が 0 で同じ。
 *
 * @param from `YYYY-MM-DD`（含む）
 * @param to   `YYYY-MM-DD`（含む）
 */
export async function listRollupsInRange(
  env: Env,
  ctx: TenantContext,
  range: { from: string; to: string },
) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(dailyPropertyRollup)
    .where(
      withTenantScope(
        dailyPropertyRollup,
        ctx,
        dailyPropertyRollup.propertyId,
        gte(dailyPropertyRollup.businessDate, range.from),
        lte(dailyPropertyRollup.businessDate, range.to),
      ),
    );
}

/** 再計算した 1 日ぶんの数字。**すべて非負の整数。** */
export interface RollupCounts {
  totalTasks: number;
  completedTasks: number;
  reworkTasks: number;
  totalMinutes: number;
  inspectedTasks: number;
  firstPassTasks: number;
  openIssues: number;
  findingsHigh: number;
}

/**
 * 施設 1 件・業務日 1 日の集計を**上書きする**（§19.6 MUST）。
 *
 * ── 加算しない ──────────────────────────────────────────
 * `onConflictDoUpdate` の `set` は渡された値そのもの。`sql`+`n` の形を
 * 書かないこと。同じメッセージが 2 回届いたら 2 倍になる
 * （§19.6 MUST / testing.md §4）。
 *
 * ── 行 ID は衝突時に使われない ──────────────────────────
 * 一意制約は `(organizationId, propertyId, businessDate)`。2 回目以降は
 * `id` が捨てられ、最初に入った行が更新される。**採番が毎回変わっても
 * 行は増えない。**
 */
export async function upsertPropertyRollup(
  env: Env,
  ctx: TenantContext,
  input: { propertyId: string; businessDate: string; counts: RollupCounts; now: Date },
): Promise<void> {
  assertIdBelongsToTenant(input.propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  await db
    .insert(dailyPropertyRollup)
    .values({
      id: generateId(ctx.orgShortId, "roll"),
      organizationId: ctx.organizationId,
      propertyId: input.propertyId,
      businessDate: input.businessDate,
      ...input.counts,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [
        dailyPropertyRollup.organizationId,
        dailyPropertyRollup.propertyId,
        dailyPropertyRollup.businessDate,
      ],
      set: { ...input.counts, updatedAt: input.now },
    });
}

// ────────────────────────────────────────────────────────────
// 再計算の材料
//
// **ここから下は `rollup-update` のコンシューマ専用**（冒頭の注記）。
// 画面・API から呼ばないこと。施設 1 件・業務日 1 日に閉じており、
// 施設をまたぐ集計にはなっていない。
// ────────────────────────────────────────────────────────────

/**
 * タスク由来の 6 つを 1 本のクエリで数える（P5-14）。
 *
 * ── `CANCELLED` を総数に入れない ────────────────────────
 * §7.1 の「清掃実績」は実施した清掃の数。取り消したタスクを分母に
 * 入れると完了率が下がり続ける。
 *
 * ── 平均清掃時間の分母は `completedTasks` ───────────────
 * `totalMinutes` は完了したタスクの `actualMinutes` の合計。途中の
 * タスクの経過時間を混ぜない（まだ伸びる数字を平均に入れない）。
 */
export async function countTasksForRollup(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  businessDate: string,
): Promise<Pick<
  RollupCounts,
  "totalTasks" | "completedTasks" | "reworkTasks" | "totalMinutes" | "inspectedTasks" | "firstPassTasks"
>> {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  const [row] = await db
    .select({
      totalTasks: sql<number>`sum(case when ${cleaningTask.status} <> 'CANCELLED' then 1 else 0 end)`,
      completedTasks: sql<number>`sum(case when ${cleaningTask.status} = 'COMPLETED' then 1 else 0 end)`,
      // 「差戻しを受けたことがある」タスクの数。**いま REWORK の数ではない。**
      // 再清掃率は §7.1 の見本で完了率と並ぶので、その日の結果として
      // 数える（いまの状態を数えると、差戻しが解消した瞬間に 0 へ戻る）。
      reworkTasks: sql<number>`sum(case when ${cleaningTask.reworkCount} > 0 then 1 else 0 end)`,
      totalMinutes: sql<number>`coalesce(sum(case when ${cleaningTask.status} = 'COMPLETED' then coalesce(${cleaningTask.actualMinutes}, 0) else 0 end), 0)`,
      inspectedTasks: sql<number>`sum(case when ${cleaningTask.inspectionResult} in ('PASS','FAIL') then 1 else 0 end)`,
      firstPassTasks: sql<number>`sum(case when ${cleaningTask.inspectionResult} = 'PASS' and ${cleaningTask.reworkCount} = 0 then 1 else 0 end)`,
    })
    .from(cleaningTask)
    .where(
      withTenantScope(
        cleaningTask,
        ctx,
        cleaningTask.propertyId,
        eq(cleaningTask.propertyId, propertyId),
        eq(cleaningTask.businessDate, businessDate),
      ),
    );
  return {
    totalTasks: row?.totalTasks ?? 0,
    completedTasks: row?.completedTasks ?? 0,
    reworkTasks: row?.reworkTasks ?? 0,
    totalMinutes: row?.totalMinutes ?? 0,
    inspectedTasks: row?.inspectedTasks ?? 0,
    firstPassTasks: row?.firstPassTasks ?? 0,
  };
}

/** 未解決とみなす設備不具合の状態（`RESOLVED` / `CLOSED` / `WONT_FIX` 以外）。 */
const OPEN_ISSUE_STATUSES = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] as const;

/**
 * その施設でいま開いている設備不具合の数（P5-14）。
 *
 * **業務日で絞らない。** 理由は `schema/rollup.ts` の `openIssues` の注記と
 * OPEN_QUESTIONS #080。
 */
export async function countOpenIssuesForRollup(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
): Promise<number> {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(issueReport)
    .where(
      withTenantScope(
        issueReport,
        ctx,
        issueReport.propertyId,
        eq(issueReport.propertyId, propertyId),
        inArray(issueReport.status, [...OPEN_ISSUE_STATUSES]),
      ),
    );
  return row?.count ?? 0;
}

/**
 * その業務日に検出された重大な差異の数（P5-14）。
 *
 * **状態で絞らない。** 数えているのは「その日に見つかった重大差異」で、
 * 対応が済んだかどうかは別の話（要対応の件数は画面が
 * `countFindingsByStatus()` から取る）。状態で絞ると、過去の月の数字が
 * 対応の進捗で書き換わる。
 */
export async function countHighFindingsForRollup(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  businessDate: string,
): Promise<number> {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(auditFinding)
    .where(
      withTenantScope(
        auditFinding,
        ctx,
        auditFinding.propertyId,
        eq(auditFinding.propertyId, propertyId),
        eq(auditFinding.businessDate, businessDate),
        eq(auditFinding.severity, "HIGH"),
      ),
    );
  return row?.count ?? 0;
}
