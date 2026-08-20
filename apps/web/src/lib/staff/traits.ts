/**
 * 自動配分に効くスタッフの属性（P8-04 / PK-SPEC-P8 §1.7）。**純粋。**
 *
 * task:  docs/tasks/P8-04.md
 * 参照: ui-prototypes/ops/pkops-A-daily-quality.html 02（自動割当のルール）
 *
 * ── 3 つの属性しか作らない ──────────────────────────────
 * プロトタイプのルールカードと仕様 §1.7 に対応するのは:
 *
 *   skills       スキル外の作業を割り当てない（§1.7）
 *   isFirstYear  「1年目には難易度の高い客室を割当てません」（トグル ON）
 *   inTraining   研修中は自動割当から除外（プロトタイプ 08）
 *
 * **評価・点数・速度をここに足さないこと**（security.md §5 /
 * CLAUDE.md §4「自動評価を作らない」）。
 *
 * ── 未入力を制約にしない ────────────────────────────────
 * 台帳に行が無い・入社日が無い・スキルが空 — いずれも**制約なし**として
 * 扱う。未整備のデータで配分が止まると、台帳を使わない組織の現場が
 * 止まる（仕様 §1.5 MUST のフォールバックと同じ向き）。
 */

import type { StaffLedgerRow } from "@pk/db";

/** 1 人ぶんの属性。 */
export interface StaffTraits {
  membershipId: string;
  /** 空・`undefined` は「制約なし」。 */
  skills: readonly string[] | undefined;
  /** 入社から 1 年未満か。**入社日が無ければ偽**（未入力を制約にしない）。 */
  isFirstYear: boolean;
  /** 研修中か（`workStatus = TRAINING`）。自動配分の候補から外れる。 */
  inTraining: boolean;
}

/** 満 1 年の日数。うるう年の 366 日でも「1 年経った」と扱う側へ倒す。 */
const FIRST_YEAR_DAYS = 365;

function epochDayOf(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return null;
  return Math.floor(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000,
  );
}

/** 台帳から自動配分用の属性を組む。台帳に無い人は**返さない**（= 制約なし）。 */
export function buildStaffTraits(
  ledger: readonly StaffLedgerRow[],
  businessDate: string,
): StaffTraits[] {
  const today = epochDayOf(businessDate);

  return ledger.map((row) => {
    const hired = row.hiredOn === null ? null : epochDayOf(row.hiredOn);
    const isFirstYear =
      today !== null && hired !== null && today - hired >= 0 && today - hired < FIRST_YEAR_DAYS;
    return {
      membershipId: row.membershipId,
      skills: row.skills.length === 0 ? undefined : row.skills,
      isFirstYear,
      inTraining: row.workStatus === "TRAINING",
    };
  });
}
