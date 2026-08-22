/**
 * 在留資格の保存期間の満了（P8-11 / PK-SPEC-P8 §1.4）。**日次バッチの一部。**
 *
 * task:  docs/tasks/P8-11.md
 * 契約: docs/PK-IMPL-CONTRACT.md **INV-08**（v2 / DECISIONS #261）
 * ルール: .claude/rules/security.md §5 / .claude/rules/testing.md §4
 *
 * > **在留資格の記録は、従業員の退職日から 3 年が経過した時点で物理削除する。**
 * > （オーナー判断 2026-08-22）
 *
 * ```
 * 毎日 07:00 JST（RESIDENCY_ALERT_CRON）
 *   → QUEUE_NOTIFICATION（kind: "RESIDENCY_ALERT"）
 *     → consumers/residencyAlert.ts が台帳と在留資格を読む
 *       → ここ: 保存期間を満了した記録を消す
 * ```
 *
 * ── cron もキューも増やさない ───────────────────────────
 * 期限アラートが**同じ 2 つの表を毎日読んでいる。** そこへ相乗りする
 * （資格・講習の通知が同じバッチに相乗りしているのと同じ判断 /
 * `residencyAlertDispatch.ts` 冒頭）。新しい cron は 4 環境ぶんの
 * Cloudflare リソースが要り、読み直しの D1 も増える。
 *
 * ── 消す順序と、途中で落ちたとき ────────────────────────
 * **行を消してから監査ログを書く。** 逆にすると「消したと書いたのに
 * 消えていない」記録ができる。監査ログの書き込みで落ちた場合は、
 * 翌日（または retry）の回で対象が 0 件になり、`deleted: 0` の行が残る。
 * **記録が 1 日ずれることはあっても、消えた事実が残らないことは無い。**
 *
 * ── 冪等（testing.md §4）─────────────────────────────────
 * 3 回走らせても在留資格の表は同じ。1 回目で消えた行は 2 回目の
 * `listResidencyRecords()` に出てこない。監査ログだけは走った回数ぶん
 * 増えるが、**それは記録であって状態ではない**（INV-30 が追記のみを
 * 求めている以上、走った回数が残るのが正しい）。
 *
 * ── 期限切れでは消さない ────────────────────────────────
 * 在職中の人の記録は、在留期限が切れていても残す。期限切れは**配分を
 * 止める**理由（`lib/staff/assignmentBlock.ts`）であって、記録を消す
 * 理由ではない。判定は `lib/staff/residencyRetention.ts`（純粋）。
 */

import {
  deleteResidencyRecords,
  type Env,
  type ResidencyRow,
  type StaffLedgerRow,
  type TenantContext,
} from "@pk/db";

import { recordResidencyDeletion } from "../lib/staff/residencyRetentionAudit.js";
import { selectResidencyForDeletion } from "../lib/staff/residencyRetention.js";

/** 1 組織 1 回ぶんの結果。**件数だけ。誰のものかを返さない。** */
export interface ResidencyRetentionResult {
  /** 保存期間を満了していた記録の数。 */
  candidates: number;
  /** 実際に消えた行数。 */
  deleted: number;
}

/**
 * 保存期間を満了した在留資格を消す。
 *
 * 呼び出し側が読み終えた台帳と在留資格をそのまま受け取る
 * （**D1 を読み直さない。** 同じバッチの中で 2 度読む理由が無い）。
 *
 * @param input.businessDate 判定の基準日。**この関数の中で `Date.now()` を呼ばない。**
 */
export async function runResidencyRetention(
  env: Env,
  ctx: TenantContext,
  input: {
    ledger: readonly StaffLedgerRow[];
    residency: readonly ResidencyRow[];
    businessDate: string;
  },
): Promise<ResidencyRetentionResult> {
  const targets = selectResidencyForDeletion(input);
  const deleted = await deleteResidencyRecords(env, ctx, targets);

  // **0 件でも記録する。** 「走ったが対象が無かった」と「走っていない」を
  // 区別できないと、消えていない理由を追えない（`photo.retentionDeleted`
  // と同じ判断 / DECISIONS #165）。件数以外は載らない
  // （`recordResidencyDeletion()` は値を引数に取れない）。
  await recordResidencyDeletion(env, ctx, { deleted });

  return { candidates: targets.length, deleted };
}
