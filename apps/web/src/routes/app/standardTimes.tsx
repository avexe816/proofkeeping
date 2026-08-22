import { redirect } from "react-router";

/**
 * 旧 W-17 標準時間設定の URL（人間の指示 2026-08-22 で客室タイプへ統合）。
 *
 *   /app/settings/standard-times  →  /app/settings/room-types
 *
 * task: docs/tasks/P1-02.md
 *
 * ── 画面はもう無い ──────────────────────────────────────
 * 目安時間の表は**行が客室タイプそのもの**で、客室タイプを 1 つ足すたびに
 * 別の設定画面を開き直す必要があった。`roomTypes.tsx` の 2 枚目のカードへ
 * 移してある（同ファイルの注記）。
 *
 * ── それでも URL を残す理由 ─────────────────────────────
 * 消すとブックマーク・開きっぱなしのタブ・過去のリンクが 404 になる。
 * **中身を持たない 301 だけ**を置く。設定内ナビの項目は外してあるので、
 * ここへ新しく来る経路は無い。
 *
 * 権限の判定を持たないのは意図。**行き先の loader が同じ門を持つ**
 * （`room-types` は `property.read`、目安時間のカードは
 * `standardTime.read`）。ここで先に弾くと、同じ判定が 2 か所になる。
 */
export function loader(): Response {
  return redirect("/app/settings/room-types", 301);
}
