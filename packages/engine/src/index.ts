// 稼働照合の純粋関数。DB・fetch・環境変数・Date.now を持ち込まない。
// 稼働照合そのもの（P4）の実体は P4-03 以降。
//
// P1 が置いたのは「清掃タスクの規則」で、これも同じ制約で書いてある
// （時刻は引数で受け取り、DB を引かない）。ルールの表をテストで
// 直接押さえられるようにするための配置。

// タスク自動生成（P1-03 / PK-SPEC-P1 §3.1・§3.3）。
export {
  DEFAULT_STANDARD_MINUTES,
  RECHECK_VACANT_DAYS,
  ROOM_AVAILABILITY,
  TASK_PRIORITY,
  TASK_TYPE_VALUES,
  UNTOUCHABLE_STATUSES,
  determineTask,
  planGeneration,
  type DesiredTask,
  type ExistingTask,
  type GeneratedTaskType,
  type GenerationPlan,
  type RoomAvailability,
  type RoomPlanInput,
  type StandardMinutesLookup,
} from "./taskGeneration.js";

// 作業時間の集計（P1-05 / 同 §2.2）。
export {
  actualMinutesOf,
  summarizeTimeLogs,
  type ElapsedSummary,
  type TimeLogEntry,
} from "./taskTime.js";

// 状態機械（P1-05 / 同 §5.1・§5.3）。
export {
  TASK_ACTIONS,
  TASK_STATUS_VALUES,
  evaluateTransition,
  requiresReasonCode,
  timeEventOf,
  type TaskAction,
  type TaskStatusValue,
  type TaskTimeEvent,
  type TransitionResult,
} from "./taskStatus.js";

// チェックリスト（P1-06 / 同 §6）。
export {
  CHECKLIST_VALUE_VALUES,
  checkCompletion,
  checklistProgress,
  resolveTemplate,
  type ChecklistResultInput,
  type ChecklistValueKind,
  type CompletionCheck,
  type TemplateCandidate,
  type TemplateScope,
} from "./checklist.js";
