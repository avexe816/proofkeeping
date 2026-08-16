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
import { getPropertySummaries } from "../../lib/property/summary.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/** 自動更新の間隔（ms）。ui-writing.md §3 の「30 秒ごと」。 */
export const REFRESH_INTERVAL_MS = 30_000;

/** 施設セレクタの「全施設」。 */
const ALL_PROPERTIES = "";

interface OpsProgressData extends ProgressView {
  businessDate: string;
  selectedPropertyId: string | null;
  canSelectAll: boolean;
  /** セレクタの選択肢。行と別に持つ（1 施設に絞っても選択肢は全部出す）。 */
  options: { id: string; name: string }[];
}

export async function loader({
  request,
  context,
}: LoaderFunctionArgs): Promise<OpsProgressData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);

  const url = new URL(request.url);
  const requested = url.searchParams.get("propertyId");

  // **これが唯一の門**（inspectionQueue と同じ形）。担当外の施設 ID は 404。
  const scope = resolveListScope(
    tenant,
    "property.read",
    requested === null || requested === ALL_PROPERTIES ? null : requested,
  );

  const businessDate = url.searchParams.get("businessDate") ?? businessDateOf(now);
  const summaries = await getPropertySummaries(env, tenant, businessDate);

  return {
    businessDate,
    selectedPropertyId: scope.selectedPropertyId,
    canSelectAll: scope.canSelectAll,
    options: summaries.map((summary) => ({ id: summary.propertyId, name: summary.name })),
    ...buildProgressView(summaries, scope),
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
      </div>

      <Form method="get" className="pk-filter">
        <label className="pk-field">
          <span className="pk-field__label">{t("opsProgress.filter.property")}</span>
          <select
            className="pk-select"
            name="propertyId"
            defaultValue={data.selectedPropertyId ?? ""}
          >
            {data.canSelectAll ? (
              <option value="">{t("opsProgress.filter.allProperties")}</option>
            ) : null}
            {data.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>

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
        <button className="pk-button" type="submit">
          {t("opsProgress.filter.refresh")}
        </button>
      </Form>

      <ul className="pk-board__counts">
        <li>{`${t("opsProgress.totals.planned")} ${String(data.totals.totalTasks)}`}</li>
        <li>{`${t("opsProgress.totals.completed")} ${String(data.totals.completedTasks)}`}</li>
        <li>{`${t("opsProgress.totals.rework")} ${String(data.totals.reworkTasks)}`}</li>
        <li>
          {`${t("opsProgress.totals.percent")} ${data.totals.percent ?? t("opsProgress.noRollup")}`}
        </li>
      </ul>

      {/* 集計前の施設を 0% と読ませない（`buildProgressView()` の注記）。 */}
      {data.totals.pendingProperties === 0 ? null : (
        <p className="pk-muted">{t("opsProgress.pendingNotice")}</p>
      )}

      {data.rows.length === 0 ? (
        <p className="pk-muted">{t("opsProgress.empty")}</p>
      ) : (
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("opsProgress.column.property")}</th>
              <th>{t("opsProgress.column.rooms")}</th>
              <th>{t("opsProgress.column.planned")}</th>
              <th>{t("opsProgress.column.completed")}</th>
              <th>{t("opsProgress.column.rework")}</th>
              <th>{t("opsProgress.column.percent")}</th>
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
                  </>
                ) : (
                  // 「0」と「集計前」を区別する（`propertySummarySchema` の注記）。
                  <td colSpan={4}>{t("opsProgress.noRollup")}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
