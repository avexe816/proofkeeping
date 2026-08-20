/**
 * 進捗モニタ（施設横断）。
 *
 *   /app/ops/progress
 *
 * task:  docs/tasks/P7-19.md
 * 参照:  ui-prototypes/ops/pkops-A-daily-quality.html（03 進捗モニタ）
 * ルール: .claude/rules/ui-writing.md §2・§3 / .claude/rules/architecture.md §3
 *
 * ── 門は loader の `resolveListScope()` ──────────────────
 * 操作は `property.read`（施設スコープロールは担当施設のみ）。
 * `VENDOR_ADMIN` が受託外の施設 ID を指定すると **404**
 * （P7-19 完了条件 / security.md §1）。
 *
 * ── 集計は rollup 経由 ──────────────────────────────────
 * データは `getPropertySummaries()`（P0-21 / §26「rollup 以外から
 * 取得しない」）で、60 秒の KV キャッシュを通る。**30 秒の自動更新より
 * キャッシュが長いので、画面の数字が動くのは実質 60 秒ごと。**
 * これは §23.3 が課すキャッシュで、この画面だけ側道を作らない。
 *
 * ── 個人の数字を出さない ────────────────────────────────
 * 施設・全体の 2 段だけ（CLAUDE.md §4 / ui-writing.md §3
 * 「他人との比較・ランキング表示をやらない」）。
 * 進捗の遅れを赤にしない（同 §3「急かさない」）。
 */

import { useEffect } from "react";
import { Form, useLoaderData, useRevalidator, type LoaderFunctionArgs } from "react-router";

import { businessDateOf } from "../../lib/businessDate.js";
import { t } from "../../lib/i18n.js";
import { buildProgressView, type ProgressView } from "../../lib/ops/progress.js";
import { resolveListScope } from "../../lib/property/listScope.js";
import { listSelectableProperties, resolveSelectedScope } from "../../lib/property/selection.js";
import { getPropertySummaries } from "../../lib/property/summary.js";
import { sumLinenByProperty } from "@pk/db";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/** 自動更新の間隔（ms）。ui-writing.md §3 の「30 秒ごと」。 */
export const REFRESH_INTERVAL_MS = 30_000;

interface OpsProgressData extends ProgressView {
  businessDate: string;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<OpsProgressData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const url = new URL(request.url);

  // 施設はヘッダーの施設セレクタが唯一の入口（DECISIONS #204）。
  // **これが唯一の門**（inspectionQueue と同じ形）。権限が無ければ 404。
  const selectable = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, selectable);
  const scope = resolveListScope(tenant, "property.read", property?.id ?? null);

  const businessDate = url.searchParams.get("businessDate") ?? businessDateOf(now);
  // リネンは rollup に無いので別引き（`sumLinenByProperty()` の注記）。
  const [summaries, linen] = await Promise.all([
    getPropertySummaries(env, tenant, businessDate),
    sumLinenByProperty(env, tenant, businessDate),
  ]);

  return {
    businessDate,
    ...buildProgressView(summaries, scope, linen),
  };
}

export default function OpsProgress() {
  const data = useLoaderData<OpsProgressData>();
  const revalidator = useRevalidator();

  // 30 秒ごとの自動更新（ui-writing.md §3。手動更新ボタンも下に置く）。
  // `revalidate()` は loader を引き直すだけで、フォームの入力を消さない。
  useEffect(() => {
    const timer = setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, REFRESH_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [revalidator]);

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("opsProgress.title")}</h1>
        <Form method="get" className="pk-pagehead__actions">
          <label className="pk-field">
            <span className="pk-field__label">{t("opsProgress.filter.businessDate")}</span>
            <input
              className="pk-input"
              type="date"
              name="businessDate"
              defaultValue={data.businessDate}
            />
          </label>

          {/* 手動更新（ui-writing.md §3）。GET の再送 = loader の引き直し。 */}
          <button className="pk-button pk-button--primary" type="submit">
            {t("opsProgress.filter.refresh")}
          </button>
        </Form>
      </div>

      <ul className="pk-board__counts">
        <li>{`${t("opsProgress.totals.planned")} ${String(data.totals.totalTasks)}`}</li>
        <li>{`${t("opsProgress.totals.completed")} ${String(data.totals.completedTasks)}`}</li>
        <li>{`${t("opsProgress.totals.rework")} ${String(data.totals.reworkTasks)}`}</li>
        <li>
          {`${t("opsProgress.totals.percent")} ${data.totals.percent ?? t("opsProgress.noRollup")}`}
        </li>
        <li>{`${t("opsProgress.totals.linen")} ${String(data.totals.linen.collectedQty)} / ${String(data.totals.linen.suppliedQty)}`}</li>
      </ul>

      {/* 集計前の施設を 0% と読ませない（`buildProgressView()` の注記）。 */}
      {data.totals.pendingProperties === 0 ? null : (
        <p className="pk-muted">{t("opsProgress.pendingNotice")}</p>
      )}

      {/* プロトタイプ ops 03「🏨 施設別の進捗」。**表はカードの中。** */}
      <section className="pk-panel">
        <div className="pk-panel__head">
          <span className="pk-panel__icon" aria-hidden="true">
            🏨
          </span>
          {t("opsProgress.byProperty.title")}
          <span className="pk-panel__note">{data.businessDate}</span>
        </div>
        {data.rows.length === 0 ? (
          <div className="pk-panel__body">
            <p className="pk-muted">{t("opsProgress.empty")}</p>
          </div>
        ) : (
          <div className="pk-panel__body pk-panel__body--flush pk-scroll-x">
            <table className="pk-tbl">
              <thead>
                <tr>
                  <th>{t("opsProgress.column.property")}</th>
                  <th>{t("opsProgress.column.rooms")}</th>
                  <th>{t("opsProgress.column.planned")}</th>
                  <th>{t("opsProgress.column.completed")}</th>
                  <th>{t("opsProgress.column.rework")}</th>
                  <th>{t("opsProgress.column.percent")}</th>
                  <th>{t("opsProgress.column.linenCollected")}</th>
                  <th>{t("opsProgress.column.linenSupplied")}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.propertyId}>
                    <th scope="row">{row.name}</th>
                    <td>{String(row.roomCount)}</td>
                    {row.hasRollup ? (
                      <>
                        <td>{String(row.totalTasks)}</td>
                        <td>{String(row.completedTasks)}</td>
                        <td>{String(row.reworkTasks)}</td>
                        <td>{row.percent ?? "—"}</td>
                        <td>
                          {row.linen === null
                            ? t("opsProgress.noLinen")
                            : String(row.linen.collectedQty)}
                        </td>
                        <td>{row.linen === null ? "" : String(row.linen.suppliedQty)}</td>
                      </>
                    ) : (
                      // 「0」と「集計前」を区別する（`propertySummarySchema` の注記）。
                      <td colSpan={6}>{t("opsProgress.noRollup")}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
