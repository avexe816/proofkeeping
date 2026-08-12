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
 * 契約 §4 の権限マトリクスは `SITE_LEAD` / `OPS_MANAGER` / `VIEWER` という
 * 別語彙で書かれており、7 ロールへの写像は未決（OPEN_QUESTIONS #011）。
 * ここでは **`OWNER` と `AUDITOR` を伏せる側**に倒した。§4 の表で
 * 氏名が `×` なのは `OWNER` / `VIEWER` / `PLATFORM_ADMIN` の 3 つで、
 * このうち 7 ロールに実在するのは「組織全体を読むだけの立場」。
 * 配分・検査・現場運用を担う `ORG_ADMIN` / `PROPERTY_MANAGER` /
 * `VENDOR_ADMIN` は §4 で `○` または「担当施設」にあたる。
 * 判断の経緯は docs/DECISIONS.md #036。
 */

import type { Role } from "@pk/db";

/** 氏名を伏せるロール。**増やすときは契約 §4 の根拠を書くこと。** */
export const STAFF_NAME_HIDDEN_ROLES: readonly Role[] = ["OWNER", "AUDITOR"];

/** そのロールの画面に清掃スタッフの氏名を出してよいか。 */
export function canViewStaffName(role: Role): boolean {
  return !STAFF_NAME_HIDDEN_ROLES.includes(role);
}
