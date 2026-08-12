import { NotFoundError } from "@pk/db";
import { redirect, type ActionFunctionArgs } from "react-router";

import { ScopeForbiddenError, switchProperty } from "../../lib/property/selection.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { HOME_PATH, requireAppContext, safeNextPath } from "../../lib/ui/requireSession.js";

/**
 * 施設の切り替え（PK-SPEC-P0 §23.4）。**action だけ。画面を持たない。**
 *
 * task: docs/tasks/P0-14.md
 *
 * 判定の実体は `lib/property/selection.ts` の `switchProperty()`。
 * `POST /api/v1/auth/switch-property`（`routes/api/v1/session.ts`）も
 * **同じ関数を呼ぶ。** 画面用に別の判定を作らない。
 *
 * 到達できない施設（担当外・別組織・無効化済み）は `NotFoundError`。
 * 画面では 404 を出さずに既定の画面へ戻す — 切替の失敗で作業を止めない。
 * **どの施設が存在するかを画面の挙動から読み取れないようにする**という点でも、
 * 「存在しない ID」と「担当外の ID」の結果が同じである必要がある。
 *
 * **`"ALL"`（全社サマリー）も受け付ける**（P0-21）。全社ビューを持たない
 * ロールが指定した場合は API なら 403 だが、**画面では戻すだけ**にする。
 * 押せないはずの項目が押された状態なので、業務を止める必要が無い。
 */
export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, cookieValue } = await requireAppContext(env, request, now);

  const form = await request.formData();
  const propertyId = form.get("propertyId");
  const next = safeNextPath(form.get("next") as string | null);

  if (typeof propertyId !== "string" || propertyId === "") return redirect(next);

  try {
    await switchProperty(env, tenant, cookieValue, propertyId, now, session.membershipId);
  } catch (error) {
    // 到達できない施設（404）／権限の無い全社サマリー（403）。
    // どちらも選択は変えずに戻す。
    if (!(error instanceof NotFoundError) && !(error instanceof ScopeForbiddenError)) throw error;
  }

  return redirect(next);
}

/** GET では何もしない。 */
export function loader() {
  return redirect(HOME_PATH);
}
