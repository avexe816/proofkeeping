import { redirect, type ActionFunctionArgs } from "react-router";

import {
  buildExpiredPlatformSessionCookie,
  destroyPlatformSession,
  readPlatformSessionCookie,
} from "../../lib/platform/session.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

/**
 * 運営のログアウト（PF-01）。**KV の実体を消してから** Cookie を失効させる。
 *
 * task: docs/tasks/PF-01.md
 *
 * 門（`requirePlatformOperator()`）を通さない。セッションが壊れていても
 * 消せる必要がある（通すと 404 で出られなくなる）。
 */
export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const cookieValue = readPlatformSessionCookie(request.headers.get("Cookie"));
  await destroyPlatformSession(env, cookieValue);
  return redirect("/plat/login", {
    headers: { "Set-Cookie": buildExpiredPlatformSessionCookie() },
  });
}
