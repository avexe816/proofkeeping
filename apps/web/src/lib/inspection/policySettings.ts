/**
 * W-18 検査ポリシー設定の値づくり（PK-SPEC-P2 §2.1 / §12.1）。
 *
 * ── 純粋関数にしてある ──────────────────────────────────
 * 画面（`routes/app/inspectionSettings.tsx`）から DB を触る部分を外し、
 * 「いま効いている値」と「フォームから作る次の値」だけをここに置く。
 * 検査の要否そのものは `packages/engine` の `decideInspection()` が決める。
 * **判定をここへ写さないこと。**
 *
 * ── 行が無い施設を「未設定」として見せる ────────────────
 * `propertyInspectionPolicy` は行が無いことに意味がある
 * （`repositories/inspectionPolicy.ts` の注記）。読み取りのついでに
 * 既定行を作らず、P1 の `property.inspectionRequired` から導いた値を
 * 「いまの動き」として画面に出す。`resolveInspectionDecision()` が
 * 同じ落とし方をしているので、**画面の表示と実際の判定が一致する。**
 */

import { INSPECTION_MODES, legacyPolicyValues, type InspectionPolicyInput } from "@pk/db";

/**
 * 1 日あたりの最低検査件数の上限。
 *
 * 仕様（§2.1）に上限の定めは無い。engine は `selectedToday < minDailySample`
 * を見るだけなので大きい値でも壊れないが、**桁を打ち間違えた値をそのまま
 * 保存すると「全件検査」と区別が付かない。** 施設 1 日の清掃件数を超える
 * 桁で頭打ちにし、それ以上は現在値のまま残す。
 */
export const MAX_MIN_DAILY_SAMPLE = 999;

/** 画面が出す「いま効いている検査方式」。 */
export interface EffectiveInspectionPolicy {
  values: InspectionPolicyInput;
  /**
   * 施設に `propertyInspectionPolicy` の行があるか。
   * `false` のとき、`values` は P1 の真偽値から導いた値。
   */
  configured: boolean;
}

/**
 * いま効いている検査方式を求める。
 *
 * @param stored `findInspectionPolicy()` の戻り値。行が無ければ `undefined`。
 * @param legacyInspectionRequired 施設の P1 設定（`property.inspectionRequired`）。
 */
export function resolveEffectivePolicy(
  stored: InspectionPolicyInput | undefined,
  legacyInspectionRequired: boolean,
): EffectiveInspectionPolicy {
  if (stored === undefined) {
    return { values: legacyPolicyValues(legacyInspectionRequired), configured: false };
  }
  // 行の余分な列（id / 組織 / 時刻）を持ち込まない。**保存する 8 項目だけ。**
  return {
    values: {
      mode: stored.mode,
      sampleRate: stored.sampleRate,
      minDailySample: stored.minDailySample,
      alwaysInspectCheckin: stored.alwaysInspectCheckin,
      alwaysInspectRework: stored.alwaysInspectRework,
      selfInspectionAllowed: stored.selfInspectionAllowed,
      autoAssignInspector: stored.autoAssignInspector,
      inspectionSlaMinutes: stored.inspectionSlaMinutes,
    },
    configured: true,
  };
}

/** フォームから読む最小限の口（`FormData` をそのまま渡せる形）。 */
export interface PolicyFormLike {
  get(name: string): FormDataEntryValue | null;
}

/**
 * フォームから次の検査方式を作る。
 *
 * ── 画面に無い項目は現在値を持ち越す ────────────────────
 * この画面が扱うのは §2.1 の 8 項目のうち **3 つだけ**（方式・抽出率・
 * 最低件数）。残る 5 つ（当日チェックイン・前回差戻しの必須検査、
 * 自己検査の可否、検査担当の自動割当、未着手の警告分数）は入力欄を
 * 置かず、**現在値をそのまま書き戻す。** 入力欄が無いことを理由に
 * 既定値へ戻すと、`selfInspectionAllowed` のような安全側の設定が
 * 保存のたびに静かに変わる。
 *
 * ── 壊れた値は現在値のまま ──────────────────────────────
 * 数値が読めないときに 0 を保存すると、**抽出率 0%・最低件数 0 件**に
 * なって検査対象が 1 件も出なくなる。保存で流れが止まる向きに倒さない。
 */
export function parseInspectionPolicyForm(
  form: PolicyFormLike,
  current: InspectionPolicyInput,
): InspectionPolicyInput {
  return {
    ...current,
    mode: parseMode(form.get("mode"), current.mode),
    sampleRate: parseBoundedInt(form.get("sampleRate"), current.sampleRate, 0, 100),
    minDailySample: parseBoundedInt(
      form.get("minDailySample"),
      current.minDailySample,
      0,
      MAX_MIN_DAILY_SAMPLE,
    ),
  };
}

/** 語彙にある方式だけを通す。**フォームの値をそのまま信用しない。** */
function parseMode(
  value: FormDataEntryValue | null,
  fallback: InspectionPolicyInput["mode"],
): InspectionPolicyInput["mode"] {
  if (typeof value !== "string") return fallback;
  return (INSPECTION_MODES as readonly string[]).includes(value)
    ? (value as InspectionPolicyInput["mode"])
    : fallback;
}

/** `min`〜`max` の整数。範囲外・非数は現在値のまま。 */
function parseBoundedInt(
  value: FormDataEntryValue | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  // `Number.parseInt` は "12abc" を 12 と読む。**全体が整数の形のときだけ通す。**
  if (!/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}
