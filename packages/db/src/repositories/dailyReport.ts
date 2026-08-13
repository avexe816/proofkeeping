/**
 * 日報のリポジトリ（PK-SPEC-P2 §9.4）。
 *
 * task:  docs/tasks/P2-14.md
 * ルール: .claude/rules/billing.md §2 / architecture.md §2
 *
 * ── INSERT と SELECT しか無い ────────────────────────────
 * 発行済み帳票は物理削除も書き換えもしない（CLAUDE.md §4 / billing.md §2）。
 * **`db.update(dailyReport)` / `db.delete(dailyReport)` をここへ書かないこと。**
 * `repositories.spec.ts` が全リポジトリのソースを走査して固定しており、
 * 書けば CI が落ちる。再生成は revision を上げた**新しい行**（§9.3）。
 *
 * ── 版の決め方をこの層に置いていない ────────────────────
 * 「次の revision は現在の最大 + 1」という規則は
 * `apps/web/src/lib/report/revision.ts`（純粋関数）にある。ここは
 * 「最大の版を返す」「渡された版で 1 行入れる」までしかしない。
 * **採番の判断をリポジトリへ入れると、テストが D1 の代役ごしにしか
 * 書けなくなる**（`DocumentSequencer` を D1 の連番で代用しない理由と同じ /
 * billing.md §5）。
 */

import { asc, desc, eq, gte, lte, type SQL } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { dailyReport } from "../schema/dailyReport.js";

import { withTenantScope } from "./base.js";

/** `createDailyReport()` の入力。**集計値は呼び出し側が payload から作る。** */
export interface CreateDailyReportInput {
  propertyId: string;
  /** 業務日 `YYYY-MM-DD`（architecture.md §7）。 */
  businessDate: string;
  /** `RPT-2026-0042`（billing.md §5）。**版が変わっても同じ番号。** */
  documentNo: string;
  revision: number;
  storageKey: string;
  payloadSha256: string;
  pdfSha256: string;
  totalTasks: number;
  completedTasks: number;
  failedFirstInspection: number;
  openIssues: number;
  openLostItems: number;
  /** 手動再生成した `membership.id`。**自動生成では `null`**（§9.3）。 */
  generatedById: string | null;
  /** 前の版の `dailyReport.id`。revision 1 では `null`。 */
  supersedesId: string | null;
}

/**
 * 日報を 1 行足す。**PDF を R2 へ置き終えた後にだけ呼ぶ。**
 *
 * 一意制約 `(organizationId, propertyId, businessDate, revision)` があるので、
 * 同じ版を 2 回入れようとすると D1 が弾く。**これが自動生成の二重起動に
 * 対する最後の砦**（手前の砦は `findLatestDailyReport()` を見て
 * 「もうある日は作らない」と決める `consumers/dailyReport.ts`）。
 *
 * @returns 作った行の `id`。
 */
export async function createDailyReport(
  env: Env,
  ctx: TenantContext,
  input: CreateDailyReportInput,
): Promise<{ id: string }> {
  assertIdBelongsToTenant(input.propertyId, ctx);
  if (input.supersedesId !== null) assertIdBelongsToTenant(input.supersedesId, ctx);
  const db = await getTenantDb(env, ctx);

  const id = generateId(ctx.orgShortId, "rpt");
  await db.insert(dailyReport).values({
    id,
    organizationId: ctx.organizationId,
    propertyId: input.propertyId,
    businessDate: input.businessDate,
    documentNo: input.documentNo,
    revision: input.revision,
    storageKey: input.storageKey,
    payloadSha256: input.payloadSha256,
    pdfSha256: input.pdfSha256,
    totalTasks: input.totalTasks,
    completedTasks: input.completedTasks,
    failedFirstInspection: input.failedFirstInspection,
    openIssues: input.openIssues,
    openLostItems: input.openLostItems,
    generatedAt: ctx.now,
    generatedById: input.generatedById,
    supersedesId: input.supersedesId,
  });

  return { id };
}

/** 日報 1 件（§14.4 の `GET /reports/daily/:id`）。 */
export async function findDailyReportById(env: Env, ctx: TenantContext, reportId: string) {
  assertIdBelongsToTenant(reportId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(dailyReport)
    .where(
      withTenantScope(dailyReport, ctx, dailyReport.propertyId, eq(dailyReport.id, reportId)),
    )
    .limit(1);
  return rows[0];
}

/**
 * その業務日の最新版（§9.3 の再生成が次の版を決めるのに使う）。
 *
 * **`revision` の降順で 1 件。** `generatedAt` で並べない。同一ミリ秒に
 * 2 版が入る余地を残さないため（版は整数で必ず増える）。
 */
export async function findLatestDailyReport(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  businessDate: string,
) {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(dailyReport)
    .where(
      withTenantScope(
        dailyReport,
        ctx,
        dailyReport.propertyId,
        eq(dailyReport.propertyId, propertyId),
        eq(dailyReport.businessDate, businessDate),
      ),
    )
    .orderBy(desc(dailyReport.revision))
    .limit(1);
  return rows[0];
}

/** `listDailyReports()` の絞り込み。未指定の項目は条件に加えない。 */
export interface DailyReportFilter {
  /** **施設スコープの代わりにならない。** `withTenantScope()` と AND される。 */
  propertyId?: string | undefined;
  /** 業務日の範囲（両端を含む / §14.4 の `from` / `to`）。 */
  businessDateFrom?: string | undefined;
  businessDateTo?: string | undefined;
}

/**
 * 一覧（§14.4 の `GET /reports/daily`）。
 *
 * **旧版も返す。** §9.3 が「旧版を保持する」と定めており、
 * 一覧から消えると保持していないのと同じになる。どれが最新かは
 * `revision` で分かる（業務日ごとに最大のものが現行）。
 * 並びは業務日の降順・版の降順。
 */
export async function listDailyReports(
  env: Env,
  ctx: TenantContext,
  filter: DailyReportFilter = {},
) {
  const db = await getTenantDb(env, ctx);
  const conditions: (SQL | undefined)[] = [
    filter.propertyId === undefined ? undefined : eq(dailyReport.propertyId, filter.propertyId),
    filter.businessDateFrom === undefined
      ? undefined
      : gte(dailyReport.businessDate, filter.businessDateFrom),
    filter.businessDateTo === undefined
      ? undefined
      : lte(dailyReport.businessDate, filter.businessDateTo),
  ];

  return db
    .select()
    .from(dailyReport)
    .where(withTenantScope(dailyReport, ctx, dailyReport.propertyId, ...conditions))
    .orderBy(desc(dailyReport.businessDate), desc(dailyReport.revision), asc(dailyReport.id));
}

/** 一覧・詳細が返す行の型。API 側（`routes/api/v1/reports.ts`）が使う。 */
export type DailyReportRow = Awaited<ReturnType<typeof listDailyReports>>[number];
