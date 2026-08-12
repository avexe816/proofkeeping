import { redirect, type LoaderFunctionArgs } from "react-router";

import { t } from "../lib/i18n.js";
import { getEnv } from "../lib/ui/cloudflare.js";
import { HOME_PATH, LOGIN_PATH, readOptionalSession } from "../lib/ui/requireSession.js";

/**
 * `/` — 認証状態で振り分けるだけの画面（P0-14）。
 *
 * task: docs/tasks/P0-14.md
 *
 * 入っていれば既定の画面、入っていなければログイン画面。**中身を持たない。**
 * ロールごとの既定画面（PK-SPEC-P0 §23.1 — `CLEANER` は本日のタスク、
 * `INSPECTOR` は検査待ち一覧…）は、その画面が出来てから振り分ける。
 * 行き先の無い分岐をここに先に書かない。
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const session = await readOptionalSession(getEnv(context), request, new Date());
  return redirect(session === null ? LOGIN_PATH : HOME_PATH);
}

export function meta() {
  return [{ title: t("app.title") }];
}
