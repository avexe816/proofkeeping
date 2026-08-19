/**
 * 清掃スタッフの氏名を出してよいロールか（PK-IMPL-CONTRACT INV-06）。
 *
 * task:  docs/tasks/P1-14.md / docs/tasks/P1-15.md
 * 契約:  docs/PK-IMPL-CONTRACT.md §1.2（INV-06）/ §11.4 / §11.5
 *
 * ── 設定項目にしない ────────────────────────────────────
 * 契約 §11.4 は「オーナーへの氏名開示（不可）」を**コード上の定数**と
 * 定める。この表を DB・環境変数・設定画面から動かせるようにしないこと。
 *
 * ── 空欄にしない ────────────────────────────────────────
 * INV-06 は「空欄にせず『非表示』バッジを表示する」。空欄だと
 * 「登録されていない」に見え、現場が名前を入れ直そうとする。
 *
 * ── 語彙の対応 ──────────────────────────────────────────
 * 契約 §4 の権限マトリクスの語彙は §2.10.1 の写像表で固定した
 * （OPEN_QUESTIONS #011 の決着 / P5-16）。§4 で氏名が `×` なのは
 * `OWNER`（施設オーナー）/ `VIEWER` / `PLATFORM_ADMIN` の 3 つで、
 * 発注元の 2 語は実装の `CLIENT_VIEWER` に写る。実装の `OWNER` /
 * `AUDITOR`（組織全体を読むだけの立場）を伏せる判断は DECISIONS #036。
 */

import type { Role } from "@pk/db";

/** 氏名を伏せるロール。**増やすときは契約 §4 の根拠を書くこと。** */
export const STAFF_NAME_HIDDEN_ROLES: readonly Role[] = ["OWNER", "AUDITOR", "CLIENT_VIEWER"];

/** そのロールの画面に清掃スタッフの氏名を出してよいか。 */
export function canViewStaffName(role: Role): boolean {
  return !STAFF_NAME_HIDDEN_ROLES.includes(role);
}
