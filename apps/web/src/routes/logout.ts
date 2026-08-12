import { redirect, type ActionFunctionArgs } from "react-router";

import { buildExpiredSessionCookie, readSessionCookie } from "../lib/auth/cookie.js";
import { deleteSession } from "../lib/auth/session.js";
import { getEnv } from "../lib/ui/cloudflare.js";
import { LOGIN_PATH } from "../lib/ui/requireSession.js";

/**
 * ログアウト（P0-14）。
 *
 * task: docs/tasks/P0-14.md
 *
 * `POST` のみ。**リンク（GET）でログアウトさせない。** ブラウザや拡張が
 * 先読みしただけで勤務中のセッションが切れる。
 *
 * `/api/v1/auth/logout`（P0-08）と同じく、セッションが無くても・署名が
 * 壊れていても同じ結果を返す。「有効なセッションだった」ことが分かる
 * 応答にしない。
 */
export async function action({ request, context }: ActionFunctionArgs) {
  const cookieValue = readSessionCookie(request.headers.get("Cookie"));
  if (cookieValue !== null) await deleteSession(getEnv(context), cookieValue);

  // 消えたことを確実にするため、無効なセッションでも Cookie は落とす。
  return redirect(LOGIN_PATH, { headers: { "Set-Cookie": buildExpiredSessionCookie() } });
}

/** GET で来たら入り口へ戻すだけ。ここでセッションを消さない。 */
export function loader() {
  return redirect(LOGIN_PATH);
}
