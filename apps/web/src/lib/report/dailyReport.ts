/**
 * 日報の組み立て（PK-SPEC-P2 §9）。
 *
 * task:  docs/tasks/P2-14.md
 * ルール: .claude/rules/architecture.md §5 / billing.md §5
 *
 * ── 集計はここでしない ──────────────────────────────────
 * 行を集めて `buildDailyReportPayload()`（`@pk/engine`）へ渡すだけ。
 * **件数を数える式をこのファイルに書かないこと。** 数える場所が 2 つに
 * なった時点で「PDF の集計値と DB 明細が一致する」は保証でなくなる。
 *
 * ── 1 室ずつ引かない ────────────────────────────────────
 * 100 室の日報を作る（§15「100 室で 30 秒以内」）。検査と差戻しは
 * `listInspectionsByTaskIds()` / `listReworkCyclesByTaskIds()` で
 * まとめて引く。**タスクごとに `listInspectionsByTask()` を呼ばないこと。**
 *
 * ── 不具合は「その日のタスクから辿れるもの」だけ ────────
 * `issue_report` は業務日の列を持たない（§3.6）。持っているのは
 * `taskId` と `reportedAt` で、**現地時刻の業務日境界を UTC の瞬間へ
 * 直す手段をこの層は持たない**（タイムゾーンの逆変換を自前で書かない /
 * `lib/businessDate.ts` の方針）。そこで日報に載せるのは
 * **その業務日のタスクに紐づく不具合**に限る。施設全体の未解決一覧は
 * 不具合一覧（W-15 / `GET /api/v1/issues`）の役目で、日報の役目ではない。
 * 忘れ物は `businessDate` を持つのでそちらで絞る。
 *
 * ── 「未解決」の定義 ────────────────────────────────────
 * §9.4 の `openIssues` / `openLostItems`。終端に達していないものを数える。
 * 忘れ物は返却・処分・引継ぎで終わり（§3.5）、不具合は解決・完了・
 * 対応しないで終わる（§3.6）。**終端の判定を engine 側の
 * `isTerminalIssueStatus()` と揃えてある。**
 */

import {
  findPropertyById,
  listInspectionsByTaskIds,
  listIssueReports,
  listLostItems,
  listPropertyStaff,
  listReworkCyclesByTaskIds,
  listRooms,
  listTasks,
  type Env,
  type TenantContext,
} from "@pk/db";
import {
  buildDailyReportPayload,
  isTerminalIssueStatus,
  type DailyReportFindingInput,
  type DailyReportPayload,
} from "@pk/engine";

/** 忘れ物の終端（§3.5）。**ここに達したものは日報に載せない。** */
const CLOSED_LOST_ITEM_STATUSES: readonly string[] = ["RETURNED", "DISPOSED", "TRANSFERRED"];

/** `collectDailyReport()` の入力。 */
export interface CollectDailyReportInput {
  propertyId: string;
  businessDate: string;
  documentNo: string;
  revision: number;
  /** 生成の時刻。**メッセージが持つ値**（再送で payload が変わらないように）。 */
  generatedAt: Date;
}

/** 施設が無い・別組織のときは `null`。**呼び出し側が ack する。** */
export type CollectDailyReportResult =
  | { kind: "OK"; payload: DailyReportPayload }
  | { kind: "PROPERTY_NOT_FOUND" };

/**
 * 日報の payload を組む。**読み取りだけ。** 何も書かない。
 *
 * 手動再生成（§9.3）も同じ関数を通る。**版が変われば payload の
 * `revision` が変わるので、ハッシュも変わる。** 同じ日の同じ版を
 * 作り直せば、（`generatedAt` が同じなら）同じ payload になる。
 */
export async function collectDailyReport(
  env: Env,
  ctx: TenantContext,
  input: CollectDailyReportInput,
): Promise<CollectDailyReportResult> {
  const property = await findPropertyById(env, ctx, input.propertyId);
  if (property === undefined) return { kind: "PROPERTY_NOT_FOUND" };

  const [tasks, rooms, staff, lostItems] = await Promise.all([
    listTasks(env, ctx, { propertyId: input.propertyId, businessDate: input.businessDate }),
    listRooms(env, ctx, { propertyId: input.propertyId }),
    listPropertyStaff(env, ctx, input.propertyId),
    listLostItems(env, ctx, {
      propertyId: input.propertyId,
      businessDateFrom: input.businessDate,
      businessDateTo: input.businessDate,
    }),
  ]);

  const taskIds = tasks.map((task) => task.id);
  const [inspections, reworks, issues] = await Promise.all([
    listInspectionsByTaskIds(env, ctx, taskIds),
    listReworkCyclesByTaskIds(env, ctx, taskIds),
    listIssueReports(env, ctx, { propertyId: input.propertyId }),
  ]);

  const roomNumbers = new Map(rooms.map((room) => [room.id, room.roomNumber]));
  const staffNames = new Map(staff.map((member) => [member.membershipId, member.displayName]));
  const taskIdSet = new Set(taskIds);

  const findings: DailyReportFindingInput[] = [
    ...lostItems
      .filter((item) => !CLOSED_LOST_ITEM_STATUSES.includes(item.status))
      .map((item) => ({
        reference: item.managementNo,
        roomNumber: roomNumbers.get(item.roomId) ?? "",
        kind: item.category,
        status: item.status,
        source: "LOST_ITEM" as const,
      })),
    ...issues
      // **その業務日のタスクに紐づくものだけ**（冒頭の注記）。
      .filter((issue) => issue.taskId !== null && taskIdSet.has(issue.taskId))
      .filter((issue) => !isTerminalIssueStatus(issue.status))
      .map((issue) => ({
        // 不具合に管理番号は無い（§3.6）。ID の末尾（ULID）を参照に使う。
        reference: issue.id.split("_").at(-1) ?? issue.id,
        roomNumber: roomNumbers.get(issue.roomId) ?? "",
        kind: issue.category,
        status: issue.status,
        source: "ISSUE" as const,
      })),
  ];

  return {
    kind: "OK",
    payload: buildDailyReportPayload({
      documentNo: input.documentNo,
      revision: input.revision,
      businessDate: input.businessDate,
      generatedAtMs: input.generatedAt.getTime(),
      property: {
        code: property.code,
        name: property.name,
        timezone: property.timezone,
      },
      tasks: tasks.map((task) => ({
        taskId: task.id,
        roomNumber: roomNumbers.get(task.roomId) ?? "",
        taskType: task.taskType,
        status: task.status,
        assigneeName: task.assigneeId === null ? null : (staffNames.get(task.assigneeId) ?? null),
        startedAtMs: task.startedAt?.getTime() ?? null,
        completedAtMs: task.completedAt?.getTime() ?? null,
        actualMinutes: task.actualMinutes,
        blockedReason: task.blockedReason,
      })),
      inspections: inspections.map((inspection) => ({
        taskId: inspection.taskId,
        round: inspection.round,
        inspectorName: staffNames.get(inspection.inspectorId) ?? null,
        result: inspection.result,
        selfApproved: inspection.selfApproved,
      })),
      reworks: reworks.map((rework) => ({
        taskId: rework.taskId,
        round: rework.round,
        status: rework.status,
      })),
      findings,
    }),
  };
}
