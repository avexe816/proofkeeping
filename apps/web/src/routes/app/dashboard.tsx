import { isOrgWideRole } from "@pk/db";
import { redirect, type LoaderFunctionArgs } from "react-router";

import { t } from "../../lib/i18n.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/**
 * ダッシュボード（`HOME_PATH`）。**実体のある画面へ寄せる。**
 *
 * task: docs/tasks/P0-14.md（器）→ 本 route は転送だけを持つ
 *
 * ── なぜ転送なのか ──────────────────────────────────────
 * P0-14 はレイアウトを確かめるための**空の画面**としてここを作り、
 * 「中身は後続 task が入れる」と書いた。その後続が入れた先は
 * `/app/org/dashboard`（全社サマリー）と `/app/p/:propertyId/board`
 * （客室ボード）で、**この URL には何も入らないまま残った。**
 *
 * ログイン後の着地は `HOME_PATH` = `/app/dashboard`。つまり
 * **ログインすると必ず空の画面に出る。** 実際に staging でそうなった。
 *
 * 画面を 2 つに分けたのは仕様どおり（A01 / §23.5）なので、**ここは
 * どちらへ送るかだけを決める。** 中身を持たせると 3 つ目の実装が生まれる。
 *
 * ── 送り先 ──────────────────────────────────────────────
 *   組織全体を見るロール  → `/app/org/dashboard`（全社サマリー）
 *   施設スコープのロール  → 表示中の施設の客室ボード
 *
 * 施設が 1 つも割り当てられていないときだけ、行き先が無い。
 * その場合は**転送せずに案内を出す**（転送の輪を作らない）。
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const { tenant } = await requireAppContext(env, request, new Date());

  if (isOrgWideRole(tenant.role)) throw redirect("/app/org/dashboard");

  // 施設スコープのロールは割当の先頭へ。**表示中の施設はここでは見ない。**
  // 選択は `switchProperty()` が持つ状態で、行き先を決めるだけのこの
  // route が触ると、転送のたびに選択が動く。
  const propertyId = tenant.allowedPropertyIds[0] ?? null;
  if (propertyId !== null) throw redirect(`/app/p/${propertyId}/board`);

  return null;
}

/**
 * 施設が 1 件も割り当てられていない場合だけ描画される。
 * **管理者に割当を依頼する以外にできることが無い**ので、それだけを書く。
 */
export default function DashboardRoute() {
  return (
    <>
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("dashboard.title")}</h1>
      </div>
      <div className="pk-content">
        <p className="pk-muted">{t("dashboard.noProperty")}</p>
      </div>
    </>
  );
}
