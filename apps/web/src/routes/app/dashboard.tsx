import { t } from "../../lib/i18n.js";

/**
 * ダッシュボード（P0-14 では**器だけ**）。
 *
 * task: docs/tasks/P0-14.md
 *
 * v3 標準の PAGE HEADER（画面名 + 操作）と CONTENT の位置関係を確かめるための
 * 最小の画面。**KPI もテーブルも置かない。** 中身は後続 task が入れる
 * （プロトタイプ ui-prototypes/owner/pkown-v3-A-login-daily.html の 02）。
 */
export default function DashboardRoute() {
  return (
    <>
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("dashboard.title")}</h1>
      </div>
      <div className="pk-content">
        <p className="pk-muted">{t("dashboard.placeholder")}</p>
      </div>
    </>
  );
}
