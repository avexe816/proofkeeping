/**
 * 日次集計の更新（PK-SPEC-P0 §19.6）。**Queue コンシューマ。**
 *
 * task:  docs/tasks/P5-14.md
 * ルール: .claude/rules/architecture.md §3・§5 / testing.md §4
 *
 * ```
 * タスク完了 / 検査完了 / 照合完了
 *   → QUEUE_ROLLUP_UPDATE { organizationId, propertyId, businessDate }
 *   → ここでシャード内を数え直して UPSERT
 * ```
 *
 * ── 表は P0-21 からあったが、書く側が無かった ──────────
 * `daily_property_rollup` は P0-21 で作られ、施設サマリー（§23.3）と
 * 組織ダッシュボード（PK-SPEC-P5 §7.1）の唯一の出どころに定められて
 * いた。**が、行を作る経路が存在せず、表は空のままだった**（P4-05 の
 * 申し送り「rollup へはまだ投げない」）。P5-14 がその経路を作る。
 *
 * ── 再計算方式（§19.6 MUST）────────────────────────────
 * 受け取るのは「どこを数え直すか」だけで、**差分を持たせない。**
 * 同じメッセージが 3 回届いても結果が変わらない（testing.md §4）。
 * 数える → 上書きする、以外のことをしない。
 *
 * ── 施設をまたがない ────────────────────────────────────
 * 1 メッセージ = 1 施設 × 1 業務日。複数施設を 1 通に詰めない。
 * 詰めると部分的に失敗したときの再送で、成功した施設まで数え直す。
 *
 * ── 失敗しても業務は止まらない ──────────────────────────
 * 集計はダッシュボードのための派生データで、タスクの完了そのものでは
 * ない。**投入側は失敗を握りつぶす**（`enqueueRollupUpdate()` の注記）。
 */

import {
  countHighFindingsForRollup,
  countOpenIssuesForRollup,
  countTasksForRollup,
  upsertPropertyRollup,
  type Env,
  type RollupCounts,
  type TenantContext,
} from "@pk/db";

/** キューへ載せるメッセージ。**組織の解決に要る値を全部持たせる。** */
export interface RollupUpdateMessage {
  kind: "ROLLUP_UPDATE";
  organizationId: string;
  orgShortId: string;
  propertyId: string;
  /** 数え直す業務日（`YYYY-MM-DD`）。 */
  businessDate: string;
  /**
   * きっかけ。**ログにしか出さない。** 数え方は原因で変わらない
   * （再計算方式なので、何が起きたかを知る必要がない）。
   */
  reason: RollupUpdateReason;
}

/** §19.6 が挙げる 3 つのきっかけ。 */
export const ROLLUP_UPDATE_REASONS = ["TASK", "INSPECTION", "RECONCILIATION"] as const;

export type RollupUpdateReason = (typeof ROLLUP_UPDATE_REASONS)[number];

const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** メッセージの形を確かめる。**壊れた形は再送しても直らない。** */
export function isRollupUpdateMessage(value: unknown): value is RollupUpdateMessage {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    body["kind"] === "ROLLUP_UPDATE" &&
    typeof body["organizationId"] === "string" &&
    body["organizationId"].length > 0 &&
    typeof body["orgShortId"] === "string" &&
    body["orgShortId"].length > 0 &&
    typeof body["propertyId"] === "string" &&
    body["propertyId"].length > 0 &&
    typeof body["businessDate"] === "string" &&
    BUSINESS_DATE_PATTERN.test(body["businessDate"]) &&
    typeof body["reason"] === "string" &&
    (ROLLUP_UPDATE_REASONS as readonly string[]).includes(body["reason"])
  );
}

/**
 * 集計を投げる。**呼び出し側の処理を失敗させない。**
 *
 * 派生データの更新に失敗しても、タスクの完了・検査の確定・照合の
 * 完了そのものは成立している。ここで例外を投げると、業務操作の
 * 応答が 500 になる。**ログだけ残して先へ進む。**
 * 取りこぼした日は、その施設で次に何かが起きたときに数え直される。
 */
export async function enqueueRollupUpdate(
  env: Env,
  ctx: Pick<TenantContext, "organizationId" | "orgShortId">,
  input: { propertyId: string; businessDate: string; reason: RollupUpdateReason },
): Promise<void> {
  const message: RollupUpdateMessage = {
    kind: "ROLLUP_UPDATE",
    organizationId: ctx.organizationId,
    orgShortId: ctx.orgShortId,
    propertyId: input.propertyId,
    businessDate: input.businessDate,
    reason: input.reason,
  };
  try {
    await env.QUEUE_ROLLUP_UPDATE.send(message);
  } catch {
    // **組織 ID・施設 ID をログへ出さない**（architecture.md §1）。
    console.error(`rollup-enqueue-failed reason=${input.reason}`);
  }
}

/** 数え直しの結果。 */
export type RollupUpdateOutcome = { kind: "DONE" } | { kind: "FAILED"; reason: string };

/**
 * 1 施設 × 1 業務日を数え直して上書きする。
 *
 * ── ロールは `ORG_ADMIN` ────────────────────────────────
 * バッチと同じ扱い（`consumers/reconciliation.ts` の注記 /
 * OPEN_QUESTIONS #033）。**`assertPermission()` は呼ばない。** 集計は
 * 誰かの要求ではなく、業務操作の副産物として走る。
 *
 * ── 3 本を並行に読む ────────────────────────────────────
 * タスク・不具合・差異は互いに依存しない。直列にすると 1 施設あたり
 * 3 往復になる。
 */
export async function runRollupUpdate(
  env: Env,
  message: RollupUpdateMessage,
  now: Date,
): Promise<RollupUpdateOutcome> {
  const ctx: TenantContext = {
    organizationId: message.organizationId,
    orgShortId: message.orgShortId,
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now,
  };

  try {
    const [tasks, openIssues, findingsHigh] = await Promise.all([
      countTasksForRollup(env, ctx, message.propertyId, message.businessDate),
      countOpenIssuesForRollup(env, ctx, message.propertyId),
      countHighFindingsForRollup(env, ctx, message.propertyId, message.businessDate),
    ]);

    const counts: RollupCounts = { ...tasks, openIssues, findingsHigh };
    await upsertPropertyRollup(env, ctx, {
      propertyId: message.propertyId,
      businessDate: message.businessDate,
      counts,
      now,
    });
    return { kind: "DONE" };
  } catch (error) {
    // **中身をログへ流さない。** 例外の名前と業務日だけ（architecture.md §1）。
    const name = error instanceof Error ? error.name : "UnknownError";
    console.error(`rollup-update-failed date=${message.businessDate} error=${name}`);
    return { kind: "FAILED", reason: name };
  }
}

/**
 * `rollup-update` キューのハンドラ。
 *
 * **1 件ずつ ack / retry を決める。** バッチ全体を retry にすると、
 * 成功した施設まで数え直すことになる（結果は同じだが、無駄に読む）。
 */
export async function handleRollupUpdateBatch(env: Env, batch: MessageBatch): Promise<void> {
  const now = new Date();
  for (const message of batch.messages) {
    if (!isRollupUpdateMessage(message.body)) {
      // 形が違うものは**再送しても直らない。** ack して落とす。
      console.error("rollup-update-invalid-message");
      message.ack();
      continue;
    }
    const outcome = await runRollupUpdate(env, message.body, now);
    if (outcome.kind === "FAILED") message.retry();
    else message.ack();
  }
}
