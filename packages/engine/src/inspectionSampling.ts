/**
 * 検査の要否を決める（PK-SPEC-P2 §2.1〜§2.3）。
 *
 * task: docs/tasks/P2-02.md
 *
 * ── いつ呼ぶか ──────────────────────────────────────────
 * **清掃完了の瞬間だけ。** §2.2 は「抽出はタスク生成時ではなく、清掃完了時に
 * 決定する」と定める。生成時に決めると、タスク一覧の応答へ載せるかどうかに
 * 関わらず**決まった値が DB にあるという状態**が生まれ、API の 1 つが
 * 漏らした時点で「今日は検査されない」と分かってしまう。
 * 決まっていない値は漏れない。
 *
 * ── 乱数を引数で受け取る ────────────────────────────────
 * `packages/engine` に `Math.random()` も `Date.now()` も持ち込まない
 * （CLAUDE.md §5）。抽選値 `draw` は呼び出し側が `crypto` で作って渡す。
 * テストは境界値をそのまま書ける。
 *
 * ── 「検査なし」は「合格」ではない ──────────────────────
 * 戻り値は `required: false` のとき必ず `skipReason` を持つ。判定
 * （`PASS` / `FAIL`）と省略は別の列に落ちる（§2.3 / `schema/inspection.ts`）。
 */

/** 施設ごとの検査方式（`schema/inspection.ts` の `INSPECTION_MODES` と同じ語彙）。 */
export const INSPECTION_MODE_VALUES = ["ALL", "SAMPLE", "NONE"] as const;

export type InspectionModeValue = (typeof INSPECTION_MODE_VALUES)[number];

/** 判定に使う施設の設定（§2.1 の `PropertyInspectionPolicy` の部分集合）。 */
export interface InspectionPolicyInput {
  mode: InspectionModeValue;
  /** 抽出率 0〜100（%）。範囲外は丸める。 */
  sampleRate: number;
  /** 1 日あたりの最低抽出件数。 */
  minDailySample: number;
  alwaysInspectCheckin: boolean;
  alwaysInspectRework: boolean;
}

/**
 * 必ず検査対象とする条件（§2.2）。
 *
 * **すべて「観察できる事実」で書く。** 「怪しい」「気になる」のような
 * 解釈を入力にしない（ui-writing.md §4 と同じ向き）。
 */
export interface MandatoryInspectionSignals {
  /** 当日チェックインがある客室（`dailyRoomPlan.hasCheckin`）。 */
  hasCheckin: boolean;
  /** 前回差戻しとなったタスク（`cleaningTask.reworkCount > 0`）。 */
  hadRework: boolean;
  /** 運用開始から 30 日未満のスタッフが担当した。 */
  isNewStaff: boolean;
  /** 設備不具合または忘れ物の報告があるタスク。 */
  hasReport: boolean;
  /** 施設が「重点客室」として指定した客室。 */
  isPriorityRoom: boolean;
}

/** 検査対象に選ばれた理由。**画面には出さない**（§2.2 MUST）。集計と監査のため。 */
export type InspectionSelectionReason =
  | "POLICY_ALL"
  | "CHECKIN"
  | "PREVIOUS_REWORK"
  | "NEW_STAFF"
  | "REPORT_FILED"
  | "PRIORITY_ROOM"
  | "MIN_DAILY_SAMPLE"
  | "SAMPLED";

/** 省略の理由（`INSPECTION_SKIP_REASONS` の部分集合。`EMERGENCY_OVERRIDE` は別経路）。 */
export type InspectionSkipReasonValue = "POLICY_NONE" | "NOT_SAMPLED";

export type InspectionDecision =
  | { required: true; reason: InspectionSelectionReason }
  | { required: false; skipReason: InspectionSkipReasonValue };

/** `decideInspection()` の入力。 */
export interface InspectionDecisionInput {
  policy: InspectionPolicyInput;
  signals: MandatoryInspectionSignals;
  /**
   * その施設・その業務日で**既に検査対象に決まった件数**。
   * `minDailySample` の判定に使う。
   */
  selectedToday: number;
  /**
   * 抽選値 `0 <= draw < 1`。呼び出し側が乱数で作る。
   *
   * **範囲外は 0 として扱う**（＝抽選に当たる側）。壊れた乱数源が
   * 「検査されない」方向へ倒れないようにする。
   */
  draw: number;
}

/** 抽出率を 0〜100 の整数に丸める。設定画面の検証を通らなかった値への保険。 */
function normalizeRate(rate: number): number {
  if (!Number.isFinite(rate)) return 100;
  return Math.min(100, Math.max(0, Math.trunc(rate)));
}

/**
 * 検査の要否を決める。
 *
 * ── `NONE` は必須条件より強い ───────────────────────────
 * §2.2 の必須条件は「`SAMPLE` の場合」に掛かる。検査体制を持たない施設
 * （`NONE`）で当日チェックインだけを検査対象にしても、検査する人がいない。
 * タスクが `AWAITING_INSPECTION` のまま滞留し、現場が止まる。
 */
export function decideInspection(input: InspectionDecisionInput): InspectionDecision {
  const { policy, signals } = input;

  if (policy.mode === "NONE") return { required: false, skipReason: "POLICY_NONE" };
  if (policy.mode === "ALL") return { required: true, reason: "POLICY_ALL" };

  // ここから SAMPLE。§2.2 の必須条件を順に見る。
  if (signals.hasCheckin && policy.alwaysInspectCheckin) {
    return { required: true, reason: "CHECKIN" };
  }
  if (signals.hadRework && policy.alwaysInspectRework) {
    return { required: true, reason: "PREVIOUS_REWORK" };
  }
  // 新人・報告あり・重点客室には施設側の切り替えを設けていない（§2.1 に
  // 対応する列が無い）。**設定で外せる条件を勝手に増やさない。**
  if (signals.isNewStaff) return { required: true, reason: "NEW_STAFF" };
  if (signals.hasReport) return { required: true, reason: "REPORT_FILED" };
  if (signals.isPriorityRoom) return { required: true, reason: "PRIORITY_ROOM" };

  // 残りから抽出する。まず最低件数を満たす。
  if (input.selectedToday < policy.minDailySample) {
    return { required: true, reason: "MIN_DAILY_SAMPLE" };
  }

  const rate = normalizeRate(policy.sampleRate);
  const draw = Number.isFinite(input.draw) && input.draw >= 0 && input.draw < 1 ? input.draw : 0;
  if (draw * 100 < rate) return { required: true, reason: "SAMPLED" };

  return { required: false, skipReason: "NOT_SAMPLED" };
}

/** 「新人スタッフ」とみなす日数（§2.2 の「運用開始から 30 日未満」）。 */
export const NEW_STAFF_DAYS = 30;

/**
 * 新人スタッフか（§2.2）。
 *
 * 時刻は引数で受け取る（この層に `Date.now()` を持ち込まない）。
 * **開始時刻が分からない場合は `false`。** 分からないことを「新人」に
 * 倒すと、`membership` を引けない障害時に全タスクが検査対象になり、
 * 検査待ちが詰まる。判定の材料が無いことは、検査を増やす理由ではない。
 *
 * @param startedAtMs 所属の開始時刻（epoch ミリ秒）。不明なら `null`。
 * @param nowMs 現在時刻（epoch ミリ秒）。
 */
export function isNewStaff(startedAtMs: number | null, nowMs: number): boolean {
  if (startedAtMs === null || !Number.isFinite(startedAtMs)) return false;
  const elapsed = nowMs - startedAtMs;
  if (elapsed < 0) return true; // 未来日付。登録の誤りだが、新しい側として扱う
  return elapsed < NEW_STAFF_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * 施設の設定が無いときの既定。
 *
 * ── P1 の `property.inspectionRequired` から作る ─────────
 * `propertyInspectionPolicy` の行が無い施設では、P1 の真偽値がそのまま
 * `ALL` / `NONE` に対応する。**行が無いことを `ALL` の既定で埋めない。**
 * P1 の運用では `inspectionRequired = false` の施設が普通にあり、
 * 埋めると全タスクが検査待ちで滞留する（`schema/property.ts` の注記）。
 */
export function policyFromLegacyFlag(inspectionRequired: boolean): InspectionPolicyInput {
  return {
    mode: inspectionRequired ? "ALL" : "NONE",
    sampleRate: 100,
    minDailySample: 0,
    alwaysInspectCheckin: true,
    alwaysInspectRework: true,
  };
}
