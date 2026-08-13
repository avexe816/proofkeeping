/**
 * W-06 証跡一覧（PK-SPEC-P2 §12.1）。
 *
 *   /app/p/{propertyId}/evidence?date=YYYY-MM-DD
 *
 * task: docs/tasks/P2-09.md
 *
 * ── 1 日ぶんだけを出す ──────────────────────────────────
 * 証跡は積み上がる表なので、施設だけで引ける口を作らない
 * （`lib/evidence/detail.ts` の `listEvidenceForProperty()` の注記）。
 * 日付は URL の `?date=`。既定は当日の業務日。
 *
 * ── 「証拠」と書かない ──────────────────────────────────
 * ui-writing.md §2。画面の語彙は「証跡」。**「改ざん」も出さない**
 * （整合性が崩れた行には「内容が変わっています」と出す）。
 *
 * ── 並べ替え・ランキングを付けない ──────────────────────
 * 担当者ごとの件数で並べ替える口を作らない（§1.3 / INV-07）。
 * 並びは `listTasks()` の順（部屋番号）のまま。
 */

import { NotFoundError } from "@pk/db";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";

import { businessDateOf } from "../../lib/businessDate.js";
import { listEvidenceForProperty, type EvidenceListRow } from "../../lib/evidence/detail.js";
import { t } from "../../lib/i18n.js";
import { switchProperty } from "../../lib/property/selection.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

interface EvidenceListData {
  propertyId: string;
  businessDate: string;
  rows: readonly EvidenceListRow[];
}

export async function loader({
  request,
  params,
  context,
}: LoaderFunctionArgs): Promise<EvidenceListData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, cookieValue } = await requireAppContext(env, request, now);

  const propertyId = params["propertyId"];
  if (propertyId === undefined) throw new NotFoundError();

  // URL を正としてセッションを寄せる（PK-SPEC-P0 §23.5 / W-03 と同じ）。
  // 到達できない施設なら `NotFoundError`（INV-31）。
  await switchProperty(env, tenant, cookieValue, propertyId, now, session.membershipId);

  const businessDate = new URL(request.url).searchParams.get("date") ?? businessDateOf(now);
  return {
    propertyId,
    businessDate,
    rows: await listEvidenceForProperty(env, tenant, propertyId, businessDate),
  };
}

export default function EvidenceList(): React.ReactElement {
  const data = useLoaderData<EvidenceListData>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("evidence.list.title")}</h1>
        <p className="pk-muted">{data.businessDate}</p>
      </div>

      {/* §6.1 / P2 固有の絶対ルール。**法的タイムスタンプと表現しない。** */}
      <p className="pk-notice">{t("evidence.disclaimer")}</p>

      <form method="get" className="pk-filter">
        <label htmlFor="evidence-date">{t("evidence.list.date")}</label>
        <input
          id="evidence-date"
          type="date"
          name="date"
          defaultValue={data.businessDate}
          className="pk-input"
        />
        <button className="pk-button" type="submit">
          {t("evidence.list.apply")}
        </button>
      </form>

      {data.rows.length === 0 ? (
        <p className="pk-muted">{t("evidence.list.empty")}</p>
      ) : (
        <table className="pk-table">
          <thead>
            <tr>
              <th scope="col">{t("evidence.list.room")}</th>
              <th scope="col">{t("evidence.list.taskType")}</th>
              <th scope="col">{t("evidence.list.status")}</th>
              <th scope="col">{t("evidence.list.snapshotCount")}</th>
              <th scope="col">{t("evidence.list.chainHash")}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.taskId}>
                <td>
                  <Link to={`/app/p/${data.propertyId}/evidence/${row.taskId}`}>{row.roomId}</Link>
                </td>
                <td>{row.taskType}</td>
                <td>{row.status}</td>
                <td>{String(row.snapshotCount)}</td>
                {/* ハッシュは全 64 桁を出さない。**先頭 12 桁で足りる**
                    （目視の突き合わせ用。検証は「整合性を確認」が行う）。 */}
                <td className="pk-mono">{row.chainHash?.slice(0, 12) ?? t("evidence.none")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
