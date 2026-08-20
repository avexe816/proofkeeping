/**
 * シフトと当日の割当の組み立て（P8-03 / プロトタイプ ops 02）。**純粋。**
 *
 * task:  docs/tasks/P8-03.md
 * 決定: docs/DECISIONS.md #221（出勤打刻を作らない）
 * ルール: .claude/rules/security.md §5
 *
 * ── 出勤済みはタスクの開始から数える ────────────────────
 * `attendance` の表は無い（#221）。「出勤済み」は**その業務日に
 * タスクを 1 件でも開始した人**。打刻を求めないので、打刻忘れで
 * 欠勤に見える事故が構造的に起きない。
 *
 *   出勤予定 = シフトが `WORK` の人数
 *   出勤済み = 出勤予定のうち、タスクを開始した人数
 *   欠勤     = 出勤予定 − 出勤済み
 *
 * **予定に無い人が働いても欠勤側に数えない**（引き算は予定の中で閉じる）。
 *
 * ── 個人を序列化しない ──────────────────────────────────
 * 行にあるのは割当・完了の件数だけ。**所要時間・速度・順位を持ち込まない**
 * （security.md §5）。プロトタイプの表もそこまでしか出していない。
 *
 * ── 週間グリッドは作らない ──────────────────────────────
 * プロトタイプに無い（DECISIONS #221）。週はその日ごとの
 * **出勤者数の棒グラフ 1 本**だけ。
 */

import type { OrgStaff, ShiftRow } from "@pk/db";

/** 当日の割当 1 行（プロトタイプの「👥 本日の割当」）。 */
export interface ShiftBoardRow {
  membershipId: string;
  displayName: string;
  /** シフト上の勤務先。施設名は呼び出し側が引いて渡す。 */
  propertyName: string | null;
  assigned: number;
  completed: number;
  /** 0〜100。割当が 0 なら `null`（0% と「配っていない」を混ぜない）。 */
  percent: number | null;
  status: "DONE" | "WORKING" | "NOT_STARTED";
}

/** KPI 4 枚（プロトタイプ ops 02）。 */
export interface ShiftBoardSummary {
  planned: number;
  present: number;
  absent: number;
  /** 担当者が付いていないタスクの数。 */
  unassignedTasks: number;
}

/** 週の棒グラフの 1 本。 */
export interface WeekBar {
  businessDate: string;
  count: number;
}

/** 盤面 1 枚ぶん。 */
export interface ShiftBoard {
  rows: readonly ShiftBoardRow[];
  summary: ShiftBoardSummary;
  week: readonly WeekBar[];
  registeredStaff: number;
  /** 週平均の出勤者数（小数 1 桁で丸め済み）。 */
  weekAverage: number;
}

/** タスク側から要る最小の形。**担当と開始の事実だけ。** */
export interface BoardTask {
  assigneeId: string | null;
  status: string;
  startedAtMs: number | null;
}

export interface BuildShiftBoardInput {
  staff: readonly OrgStaff[];
  /** その業務日のシフト。 */
  shifts: readonly ShiftRow[];
  /** その業務日のタスク（組織全体）。 */
  tasks: readonly BoardTask[];
  /** 週（7 日ぶん）のシフト。 */
  weekShifts: readonly ShiftRow[];
  /** 週の 7 日（月曜はじまりで並べた `YYYY-MM-DD`）。 */
  weekDates: readonly string[];
  /** `propertyId` → 表示名。 */
  propertyNames: ReadonlyMap<string, string>;
}

export function buildShiftBoard(input: BuildShiftBoardInput): ShiftBoard {
  const nameByMembership = new Map(input.staff.map((row) => [row.membershipId, row.displayName]));

  // 開始した人と、担当ごとの件数。**CANCELLED は数えない**（消えた予定）。
  const started = new Set<string>();
  const assignedCounts = new Map<string, { assigned: number; completed: number }>();
  let unassignedTasks = 0;
  for (const task of input.tasks) {
    if (task.status === "CANCELLED") continue;
    if (task.assigneeId === null) {
      unassignedTasks += 1;
      continue;
    }
    if (task.startedAtMs !== null) started.add(task.assigneeId);
    const bucket = assignedCounts.get(task.assigneeId) ?? { assigned: 0, completed: 0 };
    bucket.assigned += 1;
    if (task.status === "COMPLETED") bucket.completed += 1;
    assignedCounts.set(task.assigneeId, bucket);
  }

  const rows: ShiftBoardRow[] = [];
  const planned = new Set<string>();
  for (const shift of input.shifts) {
    if (shift.shiftType !== "WORK") continue;
    planned.add(shift.membershipId);

    const counts = assignedCounts.get(shift.membershipId) ?? { assigned: 0, completed: 0 };
    const hasStarted = started.has(shift.membershipId);
    rows.push({
      membershipId: shift.membershipId,
      // 台帳から消えた人のシフトは名前が引けない。**行は残す**（予定の事実）。
      displayName: nameByMembership.get(shift.membershipId) ?? "",
      propertyName:
        shift.propertyId === null ? null : (input.propertyNames.get(shift.propertyId) ?? null),
      assigned: counts.assigned,
      completed: counts.completed,
      percent:
        counts.assigned === 0 ? null : Math.round((counts.completed / counts.assigned) * 100),
      status:
        counts.assigned > 0 && counts.completed === counts.assigned
          ? "DONE"
          : hasStarted
            ? "WORKING"
            : "NOT_STARTED",
    });
  }

  // 出勤済み・欠勤は**予定の中で閉じる**（冒頭の注記）。
  const present = [...planned].filter((membershipId) => started.has(membershipId)).length;

  // 週の棒グラフ。日付の順序は呼び出し側が決める（月曜はじまり）。
  const workByDate = new Map<string, number>();
  for (const shift of input.weekShifts) {
    if (shift.shiftType !== "WORK") continue;
    workByDate.set(shift.businessDate, (workByDate.get(shift.businessDate) ?? 0) + 1);
  }
  const week = input.weekDates.map((businessDate) => ({
    businessDate,
    count: workByDate.get(businessDate) ?? 0,
  }));
  const weekTotal = week.reduce((sum, bar) => sum + bar.count, 0);

  return {
    rows,
    summary: {
      planned: planned.size,
      present,
      absent: planned.size - present,
      unassignedTasks,
    },
    week,
    registeredStaff: input.staff.filter((row) => row.isActive).length,
    weekAverage: week.length === 0 ? 0 : Math.round((weekTotal / week.length) * 10) / 10,
  };
}

/** 業務日を含む週の月曜〜日曜（`YYYY-MM-DD` × 7）。形が違えばその日 1 日だけ。 */
export function weekOf(businessDate: string): string[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate);
  if (match === null) return [businessDate];
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const day = new Date(at).getUTCDay(); // 0 = 日曜
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return Array.from({ length: 7 }, (_, index) =>
    new Date(at + (mondayOffset + index) * 86_400_000).toISOString().slice(0, 10),
  );
}
