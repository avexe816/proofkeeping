/**
 * 在留資格の保存期間と削除の判定（P8-11 / PK-SPEC-P8 §1.4）。**純粋。**
 *
 * task: docs/tasks/P8-11.md
 * 決定: docs/DECISIONS.md #261（INV-08 v2）/ オーナー判断 2026-08-22
 *
 * > **在留資格の記録は、従業員の退職日から 3 年の保存期間が満了した
 * > 翌日以降に物理削除する。**
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

/** その年・その月の最終日。`Date.UTC` の 0 日目 ＝ 前月の末日。 */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * 保存期間の**満了日**（`YYYY-MM-DD`）。**この日はまだ消さない。**
 *
 * **暦で 3 年後の同じ日。** 2 月 29 日の退職は 3 年後に同じ日が無いので
 * 月末（2 月 28 日）へ丸める。**丸める向きは「遅らせる側」ではなく
 * 「その月の最終日」** — 民法 143 条 2 項が「最後の月に応当する日が
 * ないときは、その月の末日に満了する」と定めており、3 月 1 日へ送ると
 * 法の定めより 1 日長く持つことになる。
 *
 * ── 暦として実在しない退職日は `null`（**hotfix 2026-08-22**）──
 * 以前は形（`YYYY-MM-DD`）しか見ておらず、`2023-02-30` や `2023-00-15`
 * のような値が**削除対象になっていた。** `Date.UTC` は範囲外の月日を
 * 黙って繰り上げるので、壊れた値が「それらしい日付」に化ける。
 * **物理削除は取り返しがつかないので、判定できない入力は消さない側へ倒す。**
 *
 * 書き込み側は守ってくれない — `businessDateSchema`（`packages/contracts`）は
 * 正規表現で形だけを見ており、暦の妥当性を見ていない。**入口をここで閉じる。**
 *
 * @returns 満了日。**実在しない退職日なら `null`。**
 */
export function retentionDueOn(resignedOn: string): string | null {
  // ① 形。
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(resignedOn);
  if (match === null) return null;
  const [, y, m, d] = match;
  if (y === undefined || m === undefined || d === undefined) return null;

  const year = Number(y);
  const month = Number(m);
  const day = Number(d);

  // ② 月が 1〜12。
  if (month < 1 || month > 12) return null;
  // ③ 日が 1〜その月の最終日（**閏年もここで決まる**）。
  if (day < 1 || day > lastDayOfMonth(year, month)) return null;

  // ④ 実在する日付にだけ 3 年を足す。
  const dueYear = year + RESIDENCY_RETENTION_YEARS;
  // ⑤ 3 年後に応当する日が無いとき（正しい 2 月 29 日）だけ月末へ丸める。
  const safeDay = Math.min(day, lastDayOfMonth(dueYear, month));

  return `${String(dueYear).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(
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
 *   2. `resignedOn` が入っていて、**暦として実在する日付**である
 *   3. `resignedOn` ＋ 3 年（＝満了日）を**過ぎている**
 *
 * ── 満了日当日は消さない（**hotfix 2026-08-22**）─────────
 * 以前は満了日ちょうどの回で消していた。日次バッチは 07:00 JST に走るので、
 * **民法 140 条（初日不算入）で数えると 3 年の満了は当日の終了時**であり、
 * 朝 7 時の削除は 17 時間ほど早い。**翌日の回から**にする。
 *
 * この向きは repo の他の保存期間処理と揃っている —
 * 在留期限切れの配分停止は `expiresOn < businessDate`（当日はまだ切れて
 * いない / `repositories/residency.ts`）、写真の保持は
 * `uploadedAtMs < cutoff`（`lib/photo/retention.ts`）、年次退避の
 * `cutoffBusinessDate` は「この日より前」。**境界日そのものは対象外。**
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

    // 残り日数が負＝満了日を**過ぎた**（0＝満了日当日はまだ消さない）。
    const remaining = daysUntil(input.businessDate, dueOn);
    if (remaining === null || remaining >= 0) continue;

    targets.push(record.staffProfileId);
  }
  // 並びを決める（同じ入力で同じ順に返す。ログと検査を安定させる）。
  return [...new Set(targets)].sort();
}
