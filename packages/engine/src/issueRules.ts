/**
 * 設備不具合の規則（PK-SPEC-P2 §8.2・§8.3）。**純粋関数。**
 *
 * task: docs/tasks/P2-12.md
 *
 * ── 止めるのは `CRITICAL` だけ ──────────────────────────
 * §8.2 MUST は `CRITICAL` にだけ自動変更を定める。`HIGH` は
 * 「原則 BLOCKED」で、**判断を責任者に残す言い方。**
 * `roomEffectOf()` が `HIGH` に `SUGGEST_BLOCK` を返すのはそのためで、
 * これを `AUTO_BLOCK` にしないこと。
 *
 * ── 戻す規則を持たない ──────────────────────────────────
 * §8.3「不具合を閉じても客室状態は自動復旧しない。明示操作が必要」。
 * このモジュールに「解決したら READY へ戻す」に当たる関数は無い。
 * **足さないこと。** 復旧は W-03 の手動上書き（`room.statusOverride` /
 * 理由必須・監査ログ）を通る。
 */

/** 重要度（`packages/db` の `ISSUE_SEVERITIES` と同じ語彙。依存はさせない）。 */
export const ISSUE_SEVERITY_VALUES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export type IssueSeverityValue = (typeof ISSUE_SEVERITY_VALUES)[number];

/** 状態（`packages/db` の `ISSUE_STATUSES` と同じ語彙）。 */
export const ISSUE_STATUS_VALUES = [
  "OPEN",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "RESOLVED",
  "CLOSED",
  "WONT_FIX",
] as const;

export type IssueStatusValue = (typeof ISSUE_STATUS_VALUES)[number];

/**
 * 客室への影響（§8.2 の「客室への影響」欄）。
 *
 * | 値 | 意味 | §8.2 |
 * |---|---|---|
 * | `NONE` | 何もしない | LOW「販売可」 |
 * | `ASK_MANAGER` | 責任者の判断を仰ぐ | MEDIUM「責任者判断」 |
 * | `SUGGEST_BLOCK` | 止めることを勧める。**自動では止めない** | HIGH「原則 BLOCKED」 |
 * | `AUTO_BLOCK` | 確認のうえ自動で止める | CRITICAL「即時 OUT_OF_ORDER」 |
 */
export const ROOM_EFFECTS = ["NONE", "ASK_MANAGER", "SUGGEST_BLOCK", "AUTO_BLOCK"] as const;

export type RoomEffect = (typeof ROOM_EFFECTS)[number];

const ROOM_EFFECT_BY_SEVERITY: Readonly<Record<IssueSeverityValue, RoomEffect>> = {
  LOW: "NONE",
  MEDIUM: "ASK_MANAGER",
  HIGH: "SUGGEST_BLOCK",
  CRITICAL: "AUTO_BLOCK",
};

/** 重要度から客室への影響（§8.2）。 */
export function roomEffectOf(severity: IssueSeverityValue): RoomEffect {
  return ROOM_EFFECT_BY_SEVERITY[severity];
}

/**
 * 登録の前に確認画面を出すか（§8.2 MUST「CRITICAL 登録時は確認画面を出し」）。
 *
 * **現場 UI で確認ダイアログを挟むのはここだけ。** ui-writing.md §3 は
 * 「主要操作は 1 タップ。確認ダイアログを挟まない」と定めるが、
 * これは客室を止める操作で、押し間違いの影響が販売にまで及ぶ。
 */
export function requiresConfirmation(severity: IssueSeverityValue): boolean {
  return roomEffectOf(severity) === "AUTO_BLOCK";
}

/**
 * 状態遷移の可否（§3.6 / §8.3）。
 *
 * ```
 * OPEN ─→ ACKNOWLEDGED ─→ IN_PROGRESS ─→ RESOLVED ─→ CLOSED
 *   └────→ WONT_FIX                          └──→ IN_PROGRESS（再発）
 * ```
 *
 * **`CLOSED` と `WONT_FIX` は終端。** 閉じた報告を開き直せる形にすると、
 * 「いつ閉じたか」が意味を失う（再発は新しい報告として起票する）。
 * §4.7 の免除が `issueReportId` を参照するので、**閉じた報告が
 * 後から別の状態へ動くと、免除の根拠が後付けで変わる。**
 */
const ALLOWED_TRANSITIONS: Readonly<Record<IssueStatusValue, readonly IssueStatusValue[]>> = {
  OPEN: ["ACKNOWLEDGED", "IN_PROGRESS", "RESOLVED", "WONT_FIX"],
  ACKNOWLEDGED: ["IN_PROGRESS", "RESOLVED", "WONT_FIX"],
  // 解決へ進むか、対応しないと決めるか。**`OPEN` へは戻さない**
  // （着手した事実は消えない）。
  IN_PROGRESS: ["RESOLVED", "WONT_FIX"],
  // 直したつもりが直っていなかった場合だけ `IN_PROGRESS` へ戻れる。
  RESOLVED: ["CLOSED", "IN_PROGRESS"],
  CLOSED: [],
  WONT_FIX: [],
};

/** その遷移を許すか（§3.6）。 */
export function canTransitionIssue(from: IssueStatusValue, to: IssueStatusValue): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** 遷移の判定結果。**文言を持たない。** 画面が i18n キーへ写す。 */
export type IssueTransitionResult =
  | { kind: "OK" }
  /** 同じ状態への遷移。**再送とみなして成功扱いにする**（冪等 / testing.md §4）。 */
  | { kind: "NOOP" }
  | { kind: "REJECTED"; reason: "INVALID_TRANSITION" | "RESOLUTION_NOTE_REQUIRED" };

/**
 * 遷移してよいか（§8.3）。
 *
 * §8.3「RESOLVED へ変更する際は解決内容と写真を任意登録」。
 * **「任意」と書かれているのは写真だけ**と読み、解決内容（`resolutionNote`）は
 * 必須にした。何をしたか分からない「解決」は、§4.7 の免除の根拠に使えない
 * （免除は「設備故障等で清掃者が改善できない項目」に限るので、
 * その故障がどう処理されたかが後から辿れる必要がある）。
 * この読み方は docs/DECISIONS.md #081。
 */
export function evaluateIssueTransition(input: {
  from: IssueStatusValue;
  to: IssueStatusValue;
  resolutionNote: string | null;
}): IssueTransitionResult {
  if (input.from === input.to) return { kind: "NOOP" };
  if (!canTransitionIssue(input.from, input.to)) {
    return { kind: "REJECTED", reason: "INVALID_TRANSITION" };
  }
  if (input.to === "RESOLVED" && (input.resolutionNote ?? "").trim() === "") {
    return { kind: "REJECTED", reason: "RESOLUTION_NOTE_REQUIRED" };
  }
  return { kind: "OK" };
}

/** 終端の状態。**ここから動かない。** */
export function isTerminalIssueStatus(status: IssueStatusValue): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}
