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

// M-02 / M-03 の並び順と経過時間の色（P1-08 / P1-09 / 同 §9.2・§9.3）。
export {
  ELAPSED_TONES,
  FAR_OVER_RATIO,
  TASK_GROUPS,
  compareRoomNumber,
  countByGroup,
  elapsedToneOf,
  remainingMinutes,
  sortTasksForBoard,
  taskGroupOf,
  type ElapsedTone,
  type SortableTask,
  type TaskGroup,
} from "./taskBoard.js";

// 客室ステータスの同期（P1-16 / 同 §11.1）。**READY は検査完了後のみ。**
export {
  HOUSEKEEPING_STATUS_VALUES,
  ROOM_BOARD_GROUPS,
  countRoomsByGroup,
  housekeepingStatusFor,
  roomBoardGroupOf,
  type HousekeepingStatusValue,
  type RoomBoardGroup,
  type RoomStatusTrigger,
} from "./roomStatus.js";

// 客室ボードの並び（P1-15 / 同 §9.5）。W-03 と M-10 が同じ盤面を使う。
export {
  buildRoomBoard,
  type BoardCell,
  type BoardRoomInput,
  type BoardSection,
  type BoardTaskInput,
} from "./roomBoard.js";

// 人員配分（P1-14 / 同 §4）。**自動配分は提案。適用は呼び出し側。**
export {
  WORKLOAD_LIMIT_MINUTES,
  isAssignable,
  planAutoAssignment,
  sortTasksForAssignment,
  summarizeUnassigned,
  summarizeWorkload,
  type AssignableStaff,
  type AssignableTask,
  type AssignmentPlan,
  type WorkloadRow,
} from "./assignment.js";

// M-11 自分の実績（P1-17 / 同 §9.6）。**比較対象を引数に取らない。**
export {
  MINIMUM_TASKS_FOR_AVERAGE,
  monthRangeOf,
  summarizeOwnWork,
  summarizeOwnWorkByProperty,
  weekRangeOf,
  type OwnWorkByPropertyTask,
  type OwnWorkPropertyRow,
  type OwnWorkSummary,
  type OwnWorkTask,
} from "./ownWork.js";

// 1 日の動線（P1-21 / 同 §19.3・§19.5・§19.6）。
// **`dailyRoute` が未登録でも動く**（§19.5 MUST）。
export {
  MY_DAY_FILTERS,
  buildMyDay,
  filterMyDay,
  lastWorkedPropertyId,
  type MyDay,
  type MyDayFilter,
  type MyDayGroup,
  type MyDayProperty,
  type MyDaySummary,
  type MyDayTask,
  type RouteLeg,
  type WorkedTask,
} from "./myDay.js";

// 施設選択画面（P1-22 / 同 §19.4）。**閾値と比べるのは当日の担当施設数。**
export {
  buildPropertyPicker,
  needsPropertyPicker,
  type PickerEntry,
  type PickerSummary,
  type PropertyPicker,
} from "./propertyPicker.js";

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

// 検査の要否（P2-02 / PK-SPEC-P2 §2.1〜§2.3）。**清掃完了の瞬間に決める。**
// 抽選値は呼び出し側が渡す（この層に乱数を持ち込まない）。
export {
  INSPECTION_MODE_VALUES,
  NEW_STAFF_DAYS,
  decideInspection,
  isNewStaff,
  policyFromLegacyFlag,
  type InspectionDecision,
  type InspectionDecisionInput,
  type InspectionModeValue,
  type InspectionPolicyInput,
  type InspectionSelectionReason,
  type InspectionSkipReasonValue,
  type MandatoryInspectionSignals,
} from "./inspectionSampling.js";

// 検査結果の集約（P2-04 / 同 §4.3〜§4.5）。**全体の判定を人から受け取らない。**
export {
  DEFECT_NOTE_MAX_LENGTH,
  DEFECT_NOTE_MIN_LENGTH,
  INSPECTION_ITEM_STATUS_VALUES,
  INSPECTION_RESULT_VALUES,
  aggregateResult,
  checkInspectionCompletion,
  durationSecondsOf,
  evaluateSelfInspection,
  failedItemIds,
  hasFailure,
  reasonSummaryOf,
  type InspectionCompletionCheck,
  type InspectionItemInput,
  type InspectionItemStatusValue,
  type InspectionResultValue,
  type SelfInspectionVerdict,
} from "./inspectionResult.js";

// 検査待ちの並び（P2-05 / 同 §5.2・§5.3・§11.2）。**段を跨いだ入れ替えをしない。**
export {
  INSPECTION_QUEUE_TONES,
  INSPECTION_URGENT_CHECKIN_MINUTES,
  sortInspectionQueue,
  summarizeInspectionQueue,
  waitStateOf,
  type InspectionQueueSummary,
  type InspectionQueueTone,
  type QueuedInspection,
  type WaitingInspection,
} from "./inspectionQueue.js";

// 差戻しサイクルの状態機械と再清掃項目の絞り（P2-07 / 同 §4.5〜§4.7）。
// **タスクの状態機械（`taskStatus.ts`）とは別の軸。**
export {
  REWORK_ACTIONS,
  REWORK_STATUS_VALUES,
  checkWaiveRequirements,
  evaluateReworkTransition,
  isReworkSettled,
  reworkVisibleItemIds,
  type ReworkAction,
  type ReworkCandidateItem,
  type ReworkStatusValue,
  type ReworkTransitionResult,
  type WaiveRequirementCheck,
} from "./reworkStatus.js";

// 証跡の正規化 JSON と連鎖の入力（P2-08 / 同 §6.2・§6.3）。
// **ハッシュそのものは取らない**（WebCrypto は `apps/web/src/lib/evidence/`）。
export {
  CanonicalJsonError,
  GENESIS_HASH,
  buildCleaningCompletionPayload,
  buildInspectionPayload,
  buildReworkCompletionPayload,
  canonicalJson,
  chainHashInput,
  isoUtc,
  verifyEvidenceChain,
  type CanonicalValue,
  type CleaningCompletionInput,
  type EvidenceChainVerification,
  type EvidenceInspectionItemInput,
  type EvidencePhotoInput,
  type EvidenceTimeLogInput,
  type InspectionEvidenceInput,
  type ReworkCompletionInput,
  type SnapshotVerification,
  type SnapshotVerificationInput,
} from "./evidence.js";

// 証跡タイムライン（P2-09 / 同 §12.3）。**証跡の payload からは組まない。**
// 業務の記録（`taskTimeLog` / `inspection` / `reworkCycle`）から組む。
export {
  TIMELINE_KINDS,
  buildEvidenceTimeline,
  type EvidenceTimelineInput,
  type TimelineEntry,
  type TimelineInspectionInput,
  type TimelineKind,
  type TimelineReworkInput,
  type TimelineTimeLogInput,
} from "./evidenceTimeline.js";

// 忘れ物の規則（P2-11 / PK-SPEC-P2 §7.2・§7.3）。
// **期限から状態を導く関数を足さないこと**（§7.3 MUST「自動廃棄はしない」）。
export {
  DEFAULT_FOOD_RETENTION_DAYS,
  DEFAULT_PROPERTY_RETENTION_DAYS,
  LOST_ITEM_CATEGORY_VALUES,
  LOST_ITEM_WARNING_LEVELS,
  RETENTION_WARNING_DAYS,
  lostItemManagementNo,
  retentionDaysFor,
  retentionDueAtMs,
  warningLevelFor,
  type LostItemCategoryValue,
  type LostItemWarningLevel,
} from "./lostItemRules.js";

// 設備不具合の規則（P2-12 / 同 §8.2・§8.3）。
// **客室を戻す規則を足さないこと**（§8.3「自動復旧しない」）。
export {
  ISSUE_SEVERITY_VALUES,
  ISSUE_STATUS_VALUES,
  ROOM_EFFECTS,
  canTransitionIssue,
  evaluateIssueTransition,
  isTerminalIssueStatus,
  requiresConfirmation,
  roomEffectOf,
  type IssueSeverityValue,
  type IssueStatusValue,
  type IssueTransitionResult,
  type RoomEffect,
} from "./issueRules.js";

// 日報の集計（P2-14 / PK-SPEC-P2 §9.2）。
// **PDF も DB の集計列もこの payload から作る。** 数える口を 2 つ作らない。
export {
  DAILY_REPORT_SCHEMA_VERSION,
  buildDailyReportPayload,
  dailyReportCounters,
  dailyReportPayloadToCanonical,
  type DailyReportDetailRow,
  type DailyReportFindingInput,
  type DailyReportFindingRow,
  type DailyReportIncompleteRow,
  type DailyReportInput,
  type DailyReportInspectionInput,
  type DailyReportPayload,
  type DailyReportReworkInput,
  type DailyReportSummary,
  type DailyReportTaskInput,
} from "./dailyReport.js";

// 施設向け指標（P2-15 / PK-SPEC-P2 §10.1）。**日報のサマリーとは別物。**
// サマリーは件数（起きた事実）、こちらは率と平均（事実から作った指標）。
// **集計単位は施設・作業種別・客室タイプだけ**（INV-03）。
export {
  PROPERTY_METRIC_KEYS,
  computePropertyMetrics,
  metricAverage,
  metricRate,
  type MetricAverage,
  type MetricRate,
  type PropertyMetricKey,
  type PropertyMetrics,
  type PropertyMetricsInput,
  type PropertyMetricsInspectionInput,
  type PropertyMetricsReworkInput,
  type PropertyMetricsTaskInput,
  type WorkMinutesGroup,
} from "./metrics.js";

// 入室時の観察記録の既定値（P3-02 / PK-SPEC-P3 §3.3）。
// **推定の精度ではなく「1 タップで確定できること」が目的**（同 §1.2）。
export {
  FALLBACK_GUEST_COUNT,
  TRASH_LEVEL_VALUES,
  estimateGuestCount,
  estimateObservationDefaults,
  type ObservationDefaults,
  type RoomPlanForDefaults,
  type RoomTypeForDefaults,
  type TrashLevelValue,
} from "./observationDefaults.js";

// 消耗ベースライン（P3-08 / 同 §5）。**統計量だけを出し、判定はしない**（同 §0.2）。
// `sampleSize < 20` は `isReliable = false`。P4 のルール評価から外れる（同 §2.4）。
export {
  BASELINE_EXCLUSION_REASON_VALUES,
  DEFAULT_MIN_SAMPLE_SIZE,
  MIN_INPUT_DURATION_MS,
  OUTLIER_MEDIAN_MULTIPLIER,
  REPEATED_INPUT_THRESHOLD,
  baselineKeyOf,
  computeBaseline,
  percentile,
  standardDeviation,
  type BaselineComputation,
  type BaselineExclusion,
  type BaselineExclusionReasonValue,
  type BaselineGroupKey,
  type BaselineOptions,
  type BaselineResult,
  type ObservationSample,
} from "./baseline.js";
