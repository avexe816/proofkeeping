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
 * ── 削除と監査ログは同じ D1 batch（**原子的**）────────────
 * `deleteResidencyRecords()` が塊ごとに `[監査ログ, DELETE]` を 1 つの
 * `batch()` で書く。**どちらかが落ちればその塊は丸ごと巻き戻る。**
 * ここで監査ログを後から書き足さないこと —
 * 別の `await` にした瞬間、間で落ちて「消えたのに記録が無い」状態が
 * 作れてしまう（2026-08-22 の hotfix はまさにそれを塞いだ）。
 *
 * **監査ログの件数は候補の数ではない。** 選定から DELETE までの間に
 * 消えている行がありうるので、同じトランザクションの中で DB が数えた
 * 実在行数を記録する（`repositories/residency.ts` の注記）。
 *
 * ── 0 件の回だけは、記録を別に書く ──────────────────────
 * 消す行が無ければ DELETE が 1 文も出ないので、束ねる相手がいない。
 * **「走ったが 0 件」と「走っていない」を区別する**ために、
 * `recordEmptyResidencyRetentionRun()` で 1 行だけ残す。
 * **あの関数は件数の引数を持たない**ので、消えた回の記録をそこから
 * 作ることはできない（DECISIONS #268）。
 *
 * ── 冪等（testing.md §4）─────────────────────────────────
 * 3 回走らせても在留資格の表は同じ。1 回目で消えた行は 2 回目の
 * `listResidencyRecords()` に出てこない。監査ログだけは走った回数ぶん
 * 増えるが、**それは記録であって状態ではない**（INV-30 が追記のみを
 * 求めている以上、走った回数が残るのが正しい）。2 回目以降に増えるのは
 * `deleted: 0` の行なので、**件数の合計は実際の削除総数のまま。**
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

import { recordEmptyResidencyRetentionRun } from "../lib/staff/residencyRetentionAudit.js";
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

  // 消す行が無い回。**束ねる DELETE がいない**ので、実行したことだけを残す
  // （`photo.retentionDeleted` と同じ判断 / DECISIONS #165）。
  if (targets.length === 0) {
    await recordEmptyResidencyRetentionRun(env, ctx);
    return { candidates: 0, deleted: 0 };
  }

  // 監査ログは `deleteResidencyRecords()` が **DELETE と同じ batch の中で**
  // 書く。**ここで追加の記録を書かないこと**（冒頭の注記）。
  const deleted = await deleteResidencyRecords(env, ctx, targets);
  return { candidates: targets.length, deleted };
}
