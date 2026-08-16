/**
 * 検査キュー（施設横断）の組み立て。
 *
 * task:  docs/tasks/P7-18.md
 * 仕様:  ui-prototypes/ops/pkops-A-daily-quality.html 04 検査キュー
 * ルール: .claude/rules/security.md §1 / .claude/rules/ui-writing.md §2・§3
 *
 * ── `waiting.ts` と何が違うのか ─────────────────────────
 * `buildWaitingList()`（P2-05 / M-08）は**施設 1 件**の検査待ち。
 * こちらは**施設をまたぐ**（清掃会社の担当者が「次に検査するもの」を
 * 選ぶ画面）。並びの規則は同じ §11.2 だが、施設ごとに
 * `inspectionSlaMinutes` が違うため `sortInspectionQueue()` を
 * そのまま呼べない（あれは SLA を全件に掛ける）。
 * **各件を自分の施設の SLA で `waitStateOf()` に通してから
 * `compareInspectionQueue()` で 1 本に並べる。**
 *
 * ── 自分が清掃したタスクを出さない ──────────────────────
 * security.md §1「清掃担当者本人は自分のタスクを検査できない」。
 * P2-03 の `evaluateSelfInspection()` は施設の設定
 * （`selfInspectionAllowed`）と理由があれば通す例外を持つが、
 * **キューは無条件で落とす。** 例外は「緊急時に、理由を書いて、
 * その 1 件を開く」ためのもの（同 §1 の括弧書き）で、
 * 一覧から選ばせる形にすると例外が既定の導線になる。
 * 開く側の門は `lib/inspection/start.ts` に残っているので、
 * 緊急時はタスク画面から従来どおり入れる。
 *
 * ── 担当者名を持ち出さない ──────────────────────────────
 * INV-09。`assigneeId` はこの関数の中で「自分か」を見るためだけに使い、
 * 応答には載せない（`packages/contracts` の `inspectionQueueItemSchema`）。
 *
 * ── 急かす表現を作らない ────────────────────────────────
 * ui-writing.md §3。`tone` は `URGENT` / `OVER_SLA` / `NORMAL` の 3 つで、
 * これは engine が決める。ここで「遅れ」を別に数えない。
 */

import type { InspectionQueueItem, InspectionQueueResponse } from "@pk/contracts";
import {
  findInspectionPolicy,
  listProperties,
  listRooms,
  listTasks,
  type Env,
  type TenantContext,
} from "@pk/db";
import {
  compareInspectionQueue,
  summarizeInspectionQueue,
  waitStateOf,
  type QueuedInspection,
} from "@pk/engine";

import type { ListScope } from "../property/listScope.js";
import { DEFAULT_INSPECTION_SLA_MINUTES } from "./waiting.js";

export interface InspectionQueueInput {
  /** `resolveListScope()` の結果。**権限判定は済んでいる前提。** */
  scope: ListScope;
  businessDate: string;
  /**
   * いま見ている人の `membership.id`。**自己清掃の除外に使う。**
   *
   * `TenantContext` は `membershipId` を持たない（役割と担当施設だけ）ので、
   * 呼び出し側がセッションから渡す。
   */
  viewerMembershipId: string;
  now: Date;
}

/**
 * 検査待ちを施設横断で並べる。
 *
 * **権限判定は呼び出し側**（`resolveListScope()`）。ここは絞り込みだけを行う。
 * 担当外施設はリポジトリ層の第 1 層（`scopeToProperties()`）が落とすので、
 * `scope.propertyIds` を信用して `where` を組む形にはしていない。
 */
export async function buildInspectionQueue(
  env: Env,
  ctx: TenantContext,
  input: InspectionQueueInput,
): Promise<InspectionQueueResponse> {
  const { scope, businessDate, viewerMembershipId, now } = input;

  const [tasks, rooms, properties] = await Promise.all([
    listTasks(env, ctx, {
      businessDate,
      status: ["AWAITING_INSPECTION"],
      ...(scope.selectedPropertyId === null ? {} : { propertyId: scope.selectedPropertyId }),
    }),
    listRooms(env, ctx),
    listProperties(env, ctx, { isActive: true }),
  ]);

  // **自分が清掃したタスクを落とす**（冒頭の注記）。
  const inspectable = tasks.filter((task) => task.assigneeId !== viewerMembershipId);

  const roomById = new Map(rooms.map((room) => [room.id, room]));
  const propertyNameById = new Map(properties.map((property) => [property.id, property.name]));

  // 施設ごとの SLA。**残っている施設のぶんだけ引く**（全施設ぶんを
  // 引くと、検査待ちが 1 件も無い施設まで問い合わせることになる）。
  const propertyIds = [...new Set(inspectable.map((task) => task.propertyId))];
  const policies = await Promise.all(
    propertyIds.map(async (propertyId) => {
      const policy = await findInspectionPolicy(env, ctx, propertyId);
      return [propertyId, policy?.inspectionSlaMinutes ?? DEFAULT_INSPECTION_SLA_MINUTES] as const;
    }),
  );
  const slaByProperty = new Map(policies);

  const queued: (QueuedInspection & { propertyId: string; slaMinutes: number })[] = inspectable.map(
    (task) => {
      const slaMinutes = slaByProperty.get(task.propertyId) ?? DEFAULT_INSPECTION_SLA_MINUTES;
      const state = waitStateOf(
        {
          taskId: task.id,
          roomNumber: roomById.get(task.roomId)?.roomNumber ?? "",
          completedAtMs: task.completedAt?.getTime() ?? null,
          // `waiting.ts` と同じ（OPEN_QUESTIONS #045）。列ができたら両方差し替える。
          checkInAtMs: null,
          completedRounds: task.currentInspectionRound,
        },
        now.getTime(),
        slaMinutes,
      );
      return { ...state, propertyId: task.propertyId, slaMinutes };
    },
  );

  queued.sort(compareInspectionQueue);

  const data: InspectionQueueItem[] = queued.map((row) => ({
    taskId: row.taskId,
    roomNumber: row.roomNumber,
    propertyId: row.propertyId,
    propertyName: propertyNameById.get(row.propertyId) ?? "",
    tone: row.tone,
    waitedMinutes: row.waitedMinutes,
    minutesToCheckIn: row.minutesToCheckIn,
    slaMinutes: row.slaMinutes,
    isOverSla: row.isOverSla,
    isRecheck: row.isRecheck,
    nextRound: row.completedRounds + 1,
    completedAt: row.completedAtMs,
  }));

  return {
    businessDate,
    propertyId: scope.selectedPropertyId,
    summary: summarizeInspectionQueue(queued),
    data,
  };
}
