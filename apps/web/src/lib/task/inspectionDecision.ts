/**
 * 清掃完了時に検査の要否を決める（PK-SPEC-P2 §2.1〜§2.3）。
 *
 * task: docs/tasks/P2-02.md
 *
 * ── ここが唯一の呼び出し点 ──────────────────────────────
 * `decideInspection()`（`packages/engine`）を呼ぶのはこのファイルだけ。
 * **完了以外の経路から呼ばないこと。** タスク生成時や一覧の応答で
 * 呼ぶと、抽出対象かどうかが清掃完了前に決まってしまう（§2.2 MUST）。
 *
 * ── SAMPLE のときしか材料を集めない ─────────────────────
 * `ALL` / `NONE` は施設の設定だけで決まる。当日の予定・所属の開始時刻・
 * 当日の抽出済み件数を引くのは `SAMPLE` の施設だけにする
 * （§15 の「検査完了処理 p95 < 800ms」に効く）。
 *
 * ── まだ配線していない材料が 2 つある ───────────────────
 * §2.2 は「不具合または忘れ物の報告があるタスク」と「重点客室」も必須
 * 検査対象に挙げるが、前者の表は P2-11 / P2-12、後者は §3 に対応する列が
 * 無い（docs/OPEN_QUESTIONS.md #036）。**規則は engine 側に実装して
 * テストしてあり、ここでは `false` を渡している。** 表と列ができた task が
 * この 2 行を差し替える。
 */

import {
  countInspectionSelected,
  findInspectionPolicy,
  findMembershipStartedAt,
  summarizeTrainingProgress,
  listRoomPlans,
  type Env,
  type TenantContext,
} from "@pk/db";
import {
  decideInspection,
  isNewStaff,
  isNewStaffByTraining,
  policyFromLegacyFlag,
  type InspectionDecision,
  type InspectionPolicyInput,
} from "@pk/engine";

/** 判定に要るタスクの情報。**リクエストから受け取らない。** */
export interface InspectionSubject {
  taskId: string;
  propertyId: string;
  roomId: string;
  businessDate: string;
  /** 差戻し回数。1 以上なら「前回差戻し」。 */
  reworkCount: number;
  /** 清掃担当者の `membership.id`。未割当なら操作者。 */
  cleanerId: string | null;
}

/**
 * 抽選値 `0 <= draw < 1` を作る。
 *
 * `Math.random()` を使わない（`packages/db/src/id.ts` と同じ理由で、
 * 予測可能な抽選は「今日は当たらない」を推測させる）。
 */
function drawUniform(): number {
  const [value] = crypto.getRandomValues(new Uint32Array(1));
  return (value ?? 0) / 2 ** 32;
}

/**
 * 検査の要否を決める。
 *
 * @param legacyInspectionRequired 施設の P1 設定（`property.inspectionRequired`）。
 *   `propertyInspectionPolicy` の行が無い施設で使う。
 */
export async function resolveInspectionDecision(
  env: Env,
  ctx: TenantContext,
  subject: InspectionSubject,
  legacyInspectionRequired: boolean,
): Promise<InspectionDecision> {
  const stored = await findInspectionPolicy(env, ctx, subject.propertyId);
  const policy: InspectionPolicyInput =
    stored === undefined
      ? policyFromLegacyFlag(legacyInspectionRequired)
      : {
          mode: stored.mode,
          sampleRate: stored.sampleRate,
          minDailySample: stored.minDailySample,
          alwaysInspectCheckin: stored.alwaysInspectCheckin,
          alwaysInspectRework: stored.alwaysInspectRework,
        };

  // ALL / NONE は施設の設定だけで決まる。材料を引かずに返す。
  if (policy.mode !== "SAMPLE") {
    return decideInspection({
      policy,
      signals: {
        hasCheckin: false,
        hadRework: false,
        isNewStaff: false,
        hasReport: false,
        isPriorityRoom: false,
      },
      selectedToday: 0,
      draw: 0,
    });
  }

  const [hasCheckin, startedAt, selectedToday, training] = await Promise.all([
    policy.alwaysInspectCheckin
      ? hasCheckinToday(env, ctx, subject)
      : Promise.resolve(false),
    subject.cleanerId === null
      ? Promise.resolve(undefined)
      : findMembershipStartedAt(env, ctx, subject.cleanerId),
    countInspectionSelected(env, ctx, subject.propertyId, subject.businessDate),
    // 研修から見た新人（P8-10 / PK-SPEC-P8 §1.7）。**プログラムの無い
    // 組織では効かない**（`isNewStaffByTraining()` の注記）。
    subject.cleanerId === null
      ? Promise.resolve(null)
      : summarizeTrainingProgress(env, ctx, subject.cleanerId),
  ]);

  return decideInspection({
    policy,
    signals: {
      hasCheckin,
      hadRework: subject.reworkCount > 0,
      // 所属からの日数（P2 §2.2）**または**研修の状態（P8-10）。
      // どちらかが新人と言えば新人 — 検査を減らす側に倒さない。
      isNewStaff:
        isNewStaff(startedAt?.getTime() ?? null, ctx.now.getTime()) ||
        (training !== null &&
          isNewStaffByTraining({
            activePrograms: training.activePrograms,
            completed: training.completed,
            lastCompletedOnMs: epochMsOf(training.lastCompletedOn),
            nowMs: ctx.now.getTime(),
          })),
      // P2-11 / P2-12 で表ができたら差し替える（冒頭の注記）。
      hasReport: false,
      isPriorityRoom: false,
    },
    selectedToday,
    draw: drawUniform(),
  });
}

/** `YYYY-MM-DD` → epoch ミリ秒（UTC）。形が違えば `null`。 */
function epochMsOf(date: string | null): number | null {
  if (date === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** 当日チェックインの有無（`dailyRoomPlan`）。予定が無ければ `false`。 */
async function hasCheckinToday(
  env: Env,
  ctx: TenantContext,
  subject: InspectionSubject,
): Promise<boolean> {
  const plans = await listRoomPlans(env, ctx, subject.propertyId, subject.businessDate);
  return plans.some((plan) => plan.roomId === subject.roomId && plan.hasCheckin);
}
