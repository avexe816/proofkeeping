/**
 * タスクの状態機械（PK-SPEC-P1 §5.1 / §5.3）。**純粋関数。**
 *
 * task: docs/tasks/P1-05.md
 *
 * ── 遷移表を 1 か所に閉じる ─────────────────────────────
 * API ハンドラに `if (status === "ASSIGNED")` を散らさない。散らすと
 * 「どの状態からどの操作ができるか」がコードから読めなくなり、
 * オフライン再送で届く順序違いの操作をどう扱うかが経路ごとに割れる。
 *
 * ── 再送は「拒否」ではなく「何も起きない」──────────────
 * オフラインキューは同じ操作を再送する（§8.2）。**既に目的の状態に居る
 * 操作は成功として扱い、状態を変えない**（`NOOP`）。409 を返してキューから
 * 消させる経路（§8.2）と合わせ、現場の画面が赤バッジで止まらないようにする。
 */

/** 状態。`packages/db` の `TASK_STATUSES` と同じ語彙（依存はさせない）。 */
export const TASK_STATUS_VALUES = [
  "CREATED",
  "ASSIGNED",
  "IN_PROGRESS",
  "PAUSED",
  "AWAITING_INSPECTION",
  "REWORK",
  "COMPLETED",
  "BLOCKED",
  "CANCELLED",
] as const;

export type TaskStatusValue = (typeof TASK_STATUS_VALUES)[number];

/**
 * 状態変更の操作（§5.3 の 6 行 + 状態機械が要求する 2 つ）。
 *
 * `resume` は §5.1 の図に、`unblock` は図と `TimeEvent` の双方にある。
 * docs/tasks/P1-05.md の やること は 7 つを挙げ、完了条件は「6 操作」と
 * 書いているが（本数が食い違う）、**状態機械を閉じるにはこの 8 つが要る。**
 * `unblock` が無いと `BLOCKED` が終端になり、入室できるようになった客室の
 * タスクを進められない。
 */
export const TASK_ACTIONS = [
  "assign",
  "start",
  "pause",
  "resume",
  "complete",
  "block",
  "unblock",
  "cancel",
] as const;

export type TaskAction = (typeof TASK_ACTIONS)[number];

/** 遷移の判定結果。 */
export type TransitionResult =
  /** 状態を `to` へ進める。 */
  | { kind: "MOVE"; to: TaskStatusValue }
  /** 既に目的の状態。成功として扱い、状態も時間ログも変えない。 */
  | { kind: "NOOP" }
  /** その状態からは実行できない。 */
  | { kind: "REJECTED"; reason: "INVALID_TRANSITION" };

/** 各操作を実行できる状態（§5.3 の「前提条件」列）。 */
const ALLOWED_FROM: Readonly<Record<TaskAction, readonly TaskStatusValue[]>> = {
  assign: ["CREATED", "ASSIGNED"],
  start: ["ASSIGNED", "PAUSED", "REWORK"],
  pause: ["IN_PROGRESS"],
  resume: ["PAUSED"],
  complete: ["IN_PROGRESS"],
  /**
   * §5.3 は `block` に状態の前提を書いていない（理由必須とだけある）。
   * §5.1 の図は `IN_PROGRESS` からの矢印だけを描くが、DND や施錠は
   * **入室前に分かる**ので、割当済み・中断中からも入れるようにした。
   */
  block: ["ASSIGNED", "IN_PROGRESS", "PAUSED"],
  unblock: ["BLOCKED"],
  cancel: ["CREATED", "ASSIGNED", "BLOCKED"],
};

/** 操作が成功したときの遷移先。`complete` だけは施設設定で分岐する。 */
const MOVE_TO: Readonly<Record<Exclude<TaskAction, "complete">, TaskStatusValue>> = {
  assign: "ASSIGNED",
  start: "IN_PROGRESS",
  pause: "PAUSED",
  resume: "IN_PROGRESS",
  block: "BLOCKED",
  // 入室できるようになった状態。担当は保持したまま未着手へ戻す。
  unblock: "ASSIGNED",
  cancel: "CANCELLED",
};

/**
 * 再送とみなす状態。**その操作の結果として既に到達している状態。**
 *
 * `start` の再送で `IN_PROGRESS` が返るのは正しい。一方 `COMPLETED` の
 * タスクへの `start` は再送ではないので `ALLOWED_FROM` 側で拒否する。
 */
const IDEMPOTENT_AT: Readonly<Record<TaskAction, readonly TaskStatusValue[]>> = {
  assign: [],
  start: ["IN_PROGRESS"],
  pause: ["PAUSED"],
  resume: ["IN_PROGRESS"],
  complete: ["AWAITING_INSPECTION", "COMPLETED"],
  block: ["BLOCKED"],
  unblock: ["ASSIGNED", "IN_PROGRESS"],
  cancel: ["CANCELLED"],
};

/**
 * 遷移を判定する。
 *
 * @param inspectionRequired 施設が検査を要求するか（§5.2）。
 *   `true` なら `complete` は `AWAITING_INSPECTION` で止まる。
 */
export function evaluateTransition(
  from: TaskStatusValue,
  action: TaskAction,
  inspectionRequired: boolean,
): TransitionResult {
  if (IDEMPOTENT_AT[action].includes(from)) return { kind: "NOOP" };
  if (!ALLOWED_FROM[action].includes(from)) {
    return { kind: "REJECTED", reason: "INVALID_TRANSITION" };
  }
  if (action === "complete") {
    return { kind: "MOVE", to: inspectionRequired ? "AWAITING_INSPECTION" : "COMPLETED" };
  }
  return { kind: "MOVE", to: MOVE_TO[action] };
}

/** 時間ログのイベント（`packages/db` の `TIME_EVENTS` と同じ語彙）。 */
export type TaskTimeEvent = "START" | "PAUSE" | "RESUME" | "COMPLETE" | "BLOCK" | "UNBLOCK";

/**
 * 操作に対応する時間ログのイベント（`taskTimeLog.event`）。
 *
 * 記録しない操作は `null`。`assign` / `cancel` は作業時間に関係しない
 * （`TimeEvent` にも対応する値が無い / §2.1）。
 */
export function timeEventOf(action: TaskAction): TaskTimeEvent | null {
  switch (action) {
    case "start":
      return "START";
    case "pause":
      return "PAUSE";
    case "resume":
      return "RESUME";
    case "complete":
      return "COMPLETE";
    case "block":
      return "BLOCK";
    case "unblock":
      return "UNBLOCK";
    default:
      return null;
  }
}

/** 理由コードが必須の操作（§5.3）。**説明文までは求めない**（INV-24）。 */
export function requiresReasonCode(action: TaskAction): boolean {
  return action === "pause" || action === "block";
}
