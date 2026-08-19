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
 */
export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const now = new Date();
  const { cookieValue } = await requireAppContext(env, request, now);

  const form = await request.formData();
  const collapsed = form.get("collapsed") === "true";
  const next = safeNextPath(form.get("next") as string | null);

  await setSidebarCollapsed(env, cookieValue, collapsed, now);

  return redirect(next);
}

/** GET では何もしない。 */
export function loader() {
  return redirect(HOME_PATH);
}
