/**
 * 日報の自動生成の投入（PK-SPEC-P2 §9.3）。**Cron Trigger の入口。**
 *
 * task:  docs/tasks/P2-14.md
 * ルール: .claude/rules/architecture.md §5
 *
 * ```
 * 10 分ごと  全組織・全アクティブ施設のうち、日締め + 10 分の窓に
 *            入った施設ぶんを QUEUE_PDF_GENERATION へ投げる
 * ```
 *
 * ── ここでは PDF を作らない ─────────────────────────────
 * 作るのはコンシューマ（`consumers/dailyReport.ts`）。この関数は
 * **読み取りとキュー投入だけ**で、Cron の CPU を使い切らないようにする。
 * 施設が 200 あっても、ここでの仕事は「日締めの時刻と今を比べる」だけ。
 *
 * ── セッションを持たない経路 ────────────────────────────
 * `lib/task/nightly.ts` と同じ形（OPEN_QUESTIONS #033）。組織の一覧は
 * SHARD_00 の `org_directory` から取り、組織ごとに文脈を組み立てる。
 *
 * ── 二重投入を怖がらない ────────────────────────────────
 * cron が 2 回発火しても、コンシューマ側が「その業務日の日報が
 * 既にあれば何もしない」ので結果は変わらない（testing.md §4）。
 */

import {
  listOrganizationDirectory,
  listProperties,
  type Env,
  type TenantContext,
} from "@pk/db";

import type { DailyReportMessage } from "../../consumers/dailyReport.js";

import { dueBusinessDate } from "./schedule.js";

/**
 * 日報の cron 式。**wrangler.toml の `[triggers]` と一字一句同じであること。**
 *
 * `scheduled()` はどの cron が発火したかを式の文字列で受け取る。
 * ここと wrangler.toml がずれると、**日報の回でタスク生成が走る**
 * （分岐が一致せず既定へ落ちる）。
 */
export const DAILY_REPORT_CRON = "*/10 * * * *";

/**
 * 1 回の cron で扱う組織数の上限。
 *
 * `lib/task/nightly.ts` と同じ値・同じ理由（Cron の CPU 予算に対する歯止め）。
 */
export const DAILY_REPORT_ORGANIZATION_LIMIT = 200;

/** バッチの結果。**件数だけ。組織 ID を返さない**（ログに載せないため）。 */
export interface DailyReportDispatchResult {
  organizations: number;
  /** 窓に入っていて投入した施設の数。 */
  queued: number;
  /** 投入に失敗した組織の数。0 でなければ調査が要る。 */
  failedOrganizations: number;
  /** 組織数が上限に達したか。真なら取りこぼしている可能性がある。 */
  truncated: boolean;
}

/**
 * 日締め + 10 分を迎えた施設の日報をキューへ投げる。
 *
 * @param now cron の発火時刻。**この関数の中で `Date.now()` を呼ばない**
 *   （テストから時刻を固定できるようにする / CLAUDE.md §5）。
 */
export async function dispatchDailyReports(
  env: Env,
  now: Date,
): Promise<DailyReportDispatchResult> {
  const organizations = await listOrganizationDirectory(env, DAILY_REPORT_ORGANIZATION_LIMIT);

  const result: DailyReportDispatchResult = {
    organizations: organizations.length,
    queued: 0,
    failedOrganizations: 0,
    truncated: organizations.length >= DAILY_REPORT_ORGANIZATION_LIMIT,
  };

  for (const organization of organizations) {
    const ctx: TenantContext = {
      organizationId: organization.organizationId,
      orgShortId: organization.orgShortId,
      role: "ORG_ADMIN",
      allowedPropertyIds: [],
      now,
    };

    try {
      const properties = await listProperties(env, ctx, { isActive: true });
      for (const property of properties) {
        const businessDate = dueBusinessDate(now, {
          timezone: property.timezone,
          dayCutoffTime: property.dayCutoffTime,
        });
        if (businessDate === null) continue;

        const message: DailyReportMessage = {
          kind: "DAILY_REPORT",
          organizationId: organization.organizationId,
          orgShortId: organization.orgShortId,
          propertyId: property.id,
          businessDate,
          mode: "AUTO",
          requestedById: null,
          // **メッセージが時刻を持つ。** 再送で payload が変わらないようにする。
          requestedAtMs: now.getTime(),
        };
        await env.QUEUE_PDF_GENERATION.send(message);
        result.queued += 1;
      }
    } catch {
      // 1 組織で落ちても残りを止めない（`lib/task/nightly.ts` と同じ判断）。
      result.failedOrganizations += 1;
    }
  }

  return result;
}
