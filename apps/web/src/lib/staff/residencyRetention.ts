/**
 * 在留資格の保存期間と削除の判定（P8-11 / PK-SPEC-P8 §1.4）。**純粋。**
 *
 * task: docs/tasks/P8-11.md
 * 決定: docs/DECISIONS.md #261（INV-08 v2）/ オーナー判断 2026-08-22
 *
 * > **在留資格の記録は、従業員の退職日から 3 年が経過した時点で物理削除する。**
 *
 * ── 起算は退職日。在留期限ではない ──────────────────────
 * 期限切れは**配分を止める**理由（`assignmentBlock.ts`）であって、記録を
 * 消す理由ではない。在職中の人の記録は、期限が切れていても残す。
 * 消してよいのは「雇用関係が終わり、法定の保存期間も過ぎた」記録だけ。
 *
 * ── 分からないものを消さない ────────────────────────────
 * **退職日が入っていなければ対象にしない。** 経過日数を推測して消すと、
 * 入力漏れの人の記録が消える。物理削除は取り返しがつかないので、
 * 判定の材料が無いことは「消さない」に倒す（`archivePolicy.ts` の
 * 「知らない表は退避しない」と同じ向き）。
 *
 * ── 3 年の根拠 ──────────────────────────────────────────
 * 労働者名簿等の法定保存期間は退職日起算で 5 年、ただし経過措置により
 * 当分の間は 3 年（労働基準法 109 条・143 条）。**経過措置が終わって
 * 5 年になったら、この定数を変えて仕様と task を版上げすること。**
 * 設定で変えられるようにはしない（PK-IMPL-CONTRACT §11.4）。
 */

import type { ResidencyRow, StaffLedgerRow } from "@pk/db";

import { daysUntil } from "./ledger.js";

/** 退職日から数える保存期間（年）。**設定にしない。** */
export const RESIDENCY_RETENTION_YEARS = 3;

export interface ResidencyRetentionInput {
  ledger: readonly StaffLedgerRow[];
  residency: readonly ResidencyRow[];
  /** 判定の基準日（業務日）。**現在時刻をここで読まない。** */
  businessDate: string;
}

/**
 * 退職日に保存期間を足した日（`YYYY-MM-DD`）。
 *
 * **暦で 3 年後の同じ日。** 2 月 29 日の退職は 3 年後に同じ日が無いので
 * 月末（2 月 28 日）へ丸める。**丸める向きは「遅らせる側」ではなく
 * 「その月の最終日」** — 3 月 1 日に送ると、うるう年だけ 1 日長く持つ
 * 説明の付かない差が出る。
 */
export function retentionDueOn(resignedOn: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(resignedOn);
  if (match === null) return null;
  const [, y, m, d] = match;
  if (y === undefined || m === undefined || d === undefined) return null;

  const year = Number(y) + RESIDENCY_RETENTION_YEARS;
  const month = Number(m);
  const day = Number(d);
  // その月の最終日（`Date.UTC` の 0 日目 = 前月の末日）。
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const safeDay = Math.min(day, lastDay);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(
    safeDay,
  ).padStart(2, "0")}`;
}

/**
 * 削除してよい在留資格の記録を選ぶ。
 *
 * **戻すのは `staffProfileId` の配列だけ。** 種別も期限も返さない
 * （呼び出し側が監査ログへ書けてしまう形にしない / DECISIONS #261）。
 *
 * 対象になる条件は 3 つとも満たすこと。
 *
 *   1. 台帳の `workStatus` が `RESIGNED`
 *   2. `resignedOn` が入っている
 *   3. `resignedOn` ＋ 3 年 が基準日以前（**当日ちょうどは対象**）
 */
export function selectResidencyForDeletion(input: ResidencyRetentionInput): string[] {
  const byProfileId = new Map(input.ledger.map((row) => [row.id, row]));

  const targets: string[] = [];
  for (const record of input.residency) {
    const staff = byProfileId.get(record.staffProfileId);
    // 台帳から消えた行の残骸。**退職日が分からないので消さない。**
    if (staff === undefined) continue;
    // 在職中は在留期限が切れていても残す。
    if (staff.workStatus !== "RESIGNED") continue;
    // 退職日が分からなければ自動削除しない。
    if (staff.resignedOn === null) continue;

    const dueOn = retentionDueOn(staff.resignedOn);
    if (dueOn === null) continue;

    // 残り日数が 0 以下＝保存期間を満了した（当日ちょうどを含む）。
    const remaining = daysUntil(input.businessDate, dueOn);
    if (remaining === null || remaining > 0) continue;

    targets.push(record.staffProfileId);
  }
  // 並びを決める（同じ入力で同じ順に返す。ログと検査を安定させる）。
  return [...new Set(targets)].sort();
}
