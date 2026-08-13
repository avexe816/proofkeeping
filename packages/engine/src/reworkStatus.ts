/**
 * 差戻しサイクルの状態機械と、再清掃に見せる項目の絞り（PK-SPEC-P2 §4.5〜§4.7）。
 * **純粋関数。**
 *
 * task: docs/tasks/P2-07.md
 *
 * ── タスクの状態機械と別に持つ ──────────────────────────
 * §4.1 の図では `REWORK → IN_PROGRESS → AWAITING_INSPECTION` がタスクの
 * 遷移で、これは `taskStatus.ts` の `start` / `complete` がすでに担う。
 * **`reworkCycle.status` はそれとは別の軸**で、「この差戻しが片付いたか」を
 * 表す（`RESOLVED` / `WAIVED`）。同じ表に混ぜられない理由は 2 つ。
 *   ① 免除（§4.7）はタスクを再清掃させずに差戻しを閉じる。タスクの状態は
 *      `REWORK` から直接 `COMPLETED` 相当へ動くが、**差戻しが解決したのでは
 *      ない**ことが残らないと、§10.1 の差戻し件数が実態と合わなくなる。
 *   ② 1 タスクに複数ラウンドの差戻しが並ぶ（`(taskId, round)` が一意）。
 *      タスクの状態は 1 つしか持てない。
 *
 * ── 「やり直し」と書かない ──────────────────────────────
 * 語彙は「再清掃」（ui-writing.md §2）。この表の値も `REWORK`（差戻し）と
 * `RESOLVED`（解決）で、担当者の評価を表す語を持たない（§1.3）。
 */

/** 差戻しの状態（`packages/db` の `REWORK_STATUSES` と同じ語彙。依存はさせない）。 */
export const REWORK_STATUS_VALUES = ["OPEN", "IN_PROGRESS", "RESOLVED", "WAIVED"] as const;

export type ReworkStatusValue = (typeof REWORK_STATUS_VALUES)[number];

/**
 * 差戻しに対する操作（§4.6 の再清掃 2 つと §4.7 の免除）。
 *
 * **`reopen` を置かない。** 一度閉じた差戻しを開き直す経路を作ると、
 * 「差戻し → 再清掃 → 再検査の履歴が欠落なく残る」（§16.1）が崩れる。
 * 再検査で再び不合格になったときは**次のラウンドの行が増える**。
 */
export const REWORK_ACTIONS = ["start", "complete", "waive"] as const;

export type ReworkAction = (typeof REWORK_ACTIONS)[number];

/** 遷移の判定結果。`taskStatus.ts` の `TransitionResult` と同じ 3 値。 */
export type ReworkTransitionResult =
  /** 状態を `to` へ進める。 */
  | { kind: "MOVE"; to: ReworkStatusValue }
  /** 既に目的の状態。成功として扱い、何も変えない（再送）。 */
  | { kind: "NOOP" }
  /** その状態からは実行できない。 */
  | { kind: "REJECTED"; reason: "INVALID_TRANSITION" };

/** 各操作を実行できる状態。 */
const ALLOWED_FROM: Readonly<Record<ReworkAction, readonly ReworkStatusValue[]>> = {
  start: ["OPEN"],
  /**
   * **開始していない差戻しは完了できない。** §11.4 のワイヤーは
   * 「再清掃を開始」→（作業）→「再清掃を完了」の順で、完了だけが届くのは
   * 開始の記録が落ちた場合。そこを通すと、作業時間が 0 の再清掃が
   * 記録できてしまう（`startedAt` が入らない）。
   */
  complete: ["IN_PROGRESS"],
  /**
   * 免除は着手前でも作業中でも入れる。設備故障（§4.7）は再清掃を
   * 始めてから分かることもある。
   */
  waive: ["OPEN", "IN_PROGRESS"],
};

/** 操作が成功したときの遷移先。 */
const MOVE_TO: Readonly<Record<ReworkAction, ReworkStatusValue>> = {
  start: "IN_PROGRESS",
  complete: "RESOLVED",
  waive: "WAIVED",
};

/**
 * 再送とみなす状態。**その操作の結果として既に到達している状態。**
 *
 * `RESOLVED` への `waive` は再送ではない（解決済みを免除に書き換える操作）。
 * `ALLOWED_FROM` 側で拒否する。
 */
const IDEMPOTENT_AT: Readonly<Record<ReworkAction, readonly ReworkStatusValue[]>> = {
  start: ["IN_PROGRESS"],
  complete: ["RESOLVED"],
  waive: ["WAIVED"],
};

/**
 * 差戻しの遷移を判定する。
 *
 * 再送は「拒否」ではなく「何も起きない」（`taskStatus.ts` と同じ方針）。
 */
export function evaluateReworkTransition(
  from: ReworkStatusValue,
  action: ReworkAction,
): ReworkTransitionResult {
  if (IDEMPOTENT_AT[action].includes(from)) return { kind: "NOOP" };
  if (!ALLOWED_FROM[action].includes(from)) {
    return { kind: "REJECTED", reason: "INVALID_TRANSITION" };
  }
  return { kind: "MOVE", to: MOVE_TO[action] };
}

/** 差戻しが決着したか（`RESOLVED` / `WAIVED`）。 */
export function isReworkSettled(status: ReworkStatusValue): boolean {
  return status === "RESOLVED" || status === "WAIVED";
}

// ────────────────────────────────────────────────────────────
// 再清掃に見せる項目（§4.6）
// ────────────────────────────────────────────────────────────

/**
 * 絞り込みの入力 1 件。`inspectionItemResult` の行から詰める。
 *
 * `status` が `null` の項目は検査者がまだ見ていない（`schema/inspection.ts`）。
 */
export interface ReworkCandidateItem {
  checklistItemId: string;
  status: string | null;
  reworkRequired: boolean;
}

/**
 * 再清掃画面に出す項目（§4.6「清掃者は差戻し項目だけを表示できる」）。
 *
 * **不合格かつ再清掃が要ると記録された項目だけ。** 2 つの条件を
 * ここで 1 か所に閉じてあるのは、画面側の絞り込みを権限とみなさない
 * ため（CLAUDE.md §5）。API の応答を組む側がこの関数を通す。
 *
 * `NOT_APPLICABLE`（対象外）と `PASS` は出さない。合格した項目まで
 * 見せると、再清掃が「もう一度全部やる」作業になる。
 *
 * @returns 入力の順序を保った、出してよい項目 ID の集合。
 */
export function reworkVisibleItemIds(items: readonly ReworkCandidateItem[]): string[] {
  return items
    .filter((item) => item.status === "FAIL" && item.reworkRequired)
    .map((item) => item.checklistItemId);
}

/**
 * 免除の入力が揃っているか（§4.7「理由必須」「関連する IssueReport 必須」）。
 *
 * **どちらも欠けたら両方を返す。** 直しては拒否される往復を作らない
 * （`checkInspectionCompletion()` と同じ方針）。
 */
export interface WaiveRequirementCheck {
  ok: boolean;
  missingReason: boolean;
  missingIssueReport: boolean;
}

export function checkWaiveRequirements(
  reason: string | null,
  issueReportId: string | null,
): WaiveRequirementCheck {
  const missingReason = (reason ?? "").trim() === "";
  const missingIssueReport = (issueReportId ?? "").trim() === "";
  return { ok: !missingReason && !missingIssueReport, missingReason, missingIssueReport };
}
