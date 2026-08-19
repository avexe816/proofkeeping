/**
 * 確認依頼のメールリンク（P5-17 / PK-SPEC-P5 §6.1・§13）。
 *
 * task:  docs/tasks/P5-17.md
 * ルール: .claude/rules/security.md §7 / ui-writing.md §6
 *
 * ── 何を守るか ──────────────────────────────────────────
 * ホテルが ProofKeeping 未導入でも、メールのリンクから請求明細を確認し、
 * 承認・差戻しができる（§13 の「メールリンクでの簡易承認」）。
 *
 *   /r/billing/{billingPeriodId}?exp=...&sig=...
 *
 * `sig` は `HMAC-SHA256(SESSION_SECRET, "{billingPeriodId}\n{exp}")`。
 * 署名付き URL（`lib/storage/signedUrl.ts`）と同じ形・同じ鍵。
 *
 * ── 有効期限は 30 日 ────────────────────────────────────
 * `counterparty.paymentTermDays` の既定（30 日）に合わせた固定値。
 * OPEN_QUESTIONS #101 は「トークンの寿命を推測で作らない」と定めたが、
 * ここはオーナー指示（2026-08-19 / P5-17）で明示的に決めた値。
 * 期限内の再依頼は新しいリンクを発行する（古いリンクも期限までは有効。
 * 無効化が必要になったら失効リストを設ける — いまは状態遷移が守る:
 * REVIEWING 以外では承認も差戻しも通らない）。
 *
 * ── リンクは認可の代わりではない ────────────────────────
 * 署名は「この鍵が発行した」ことしか言わない。リンクが転送されれば
 * 期限内は誰でも開ける。**明細と承認操作だけを置き、証跡（写真）や
 * 他の期間への導線を置かない**（P5-17「やらないこと」）。
 */

import { hmacHex, timingSafeEqualHex } from "../auth/hmacToken.js";

/** リンクの有効期間（秒）。**30 日**（支払サイトの既定に合わせる）。 */
export const REVIEW_LINK_TTL_SECONDS = 30 * 24 * 60 * 60;

/** リンクのパス。**署名は含まない**（`signReviewLinkPath()` が付ける）。 */
export function reviewLinkBasePath(billingPeriodId: string): string {
  return `/r/billing/${encodeURIComponent(billingPeriodId)}`;
}

/** 署名付きの相対パスを作る。**呼ぶ前に送ってよい相手か判定すること。** */
export async function signReviewLinkPath(
  secret: string,
  billingPeriodId: string,
  now: Date,
): Promise<string> {
  const exp = Math.floor(now.getTime() / 1000) + REVIEW_LINK_TTL_SECONDS;
  const sig = await hmacHex(secret, `${billingPeriodId}\n${String(exp)}`);
  return `${reviewLinkBasePath(billingPeriodId)}?exp=${String(exp)}&sig=${sig}`;
}

/** 署名と期限を検証する。**期限切れ・改竄・欠落はすべて偽。** */
export async function verifyReviewLink(
  secret: string,
  billingPeriodId: string,
  exp: string | null,
  sig: string | null,
  now: Date,
): Promise<boolean> {
  if (exp === null || sig === null) return false;
  if (!/^\d+$/.test(exp)) return false;
  if (Number(exp) * 1000 <= now.getTime()) return false;
  return timingSafeEqualHex(await hmacHex(secret, `${billingPeriodId}\n${exp}`), sig);
}
