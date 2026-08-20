import { redirect, type ActionFunctionArgs } from "react-router";

import { setSidebarCollapsed } from "../../lib/auth/session.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { HOME_PATH, requireAppContext, safeNextPath } from "../../lib/ui/requireSession.js";

/**
 * サイドバーの折りたたみ（PK-SPEC-UI-A01 §4.4 / P7-21）。
 * **action だけ。画面を持たない**（`switchProperty.ts` と同じ形）。
 *
 * task: docs/tasks/P7-21.md
 *
 * 状態はセッションに持つ。`localStorage` にしないのは、SSR の初回描画から
 * 確定した幅で描くため（A01 §4.4「ちらつき禁止」）。表示の好みであって
 * 認可情報ではない（`session.ts` の注記）。
 *
 * 書き込みに失敗しても（セッション失効の競合）そのまま戻す。
 * 折りたたみの失敗で作業を止めない。
 *
 * ── 2 つの呼ばれ方 ──────────────────────────────────────
 * | 呼び手 | `mode` | 返すもの |
 * |---|---|---|
 * | JS 無効（`<Form>` の素の POST） | 無し | `redirect(next)` |
 * | 画面（背景の `fetch`） | `"fetch"` | **204。本文も遷移も無い** |
 *
 * 背景の `fetch` に `redirect` を返すと、`fetch` が既定でそれを追いかけて
 * **画面ぶんの loader をもう 1 度走らせる**（D1 の往復が倍になる）。
 * 見た目はクリックした瞬間に切り替わっており（`layout.tsx`）、
 * ここでやることはセッションへの書き込みだけ。
 */
export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const now = new Date();
  const { cookieValue } = await requireAppContext(env, request, now);

  const form = await request.formData();
  const collapsed = form.get("collapsed") === "true";
  const next = safeNextPath(form.get("next") as string | null);

  await setSidebarCollapsed(env, cookieValue, collapsed, now);

  // 画面から呼ばれたときは何も返さない（上の表）。
  if (form.get("mode") === "fetch") return new Response(null, { status: 204 });

  return redirect(next);
}

/** GET では何もしない。 */
export function loader() {
  return redirect(HOME_PATH);
}
