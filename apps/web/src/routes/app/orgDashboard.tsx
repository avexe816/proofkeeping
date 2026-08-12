import { ALL_PROPERTIES } from "@pk/contracts";
import { useLoaderData, type LoaderFunctionArgs } from "react-router";

import { businessDateOf } from "../../lib/businessDate.js";
import { t } from "../../lib/i18n.js";
import { ScopeForbiddenError, switchProperty } from "../../lib/property/selection.js";
import { getPropertySummaries } from "../../lib/property/summary.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { HOME_PATH, requireAppContext } from "../../lib/ui/requireSession.js";
import { PropertySummaryTable } from "../../ui/PropertySummaryTable.js";
import type { PropertySummary } from "@pk/contracts";
import { redirect } from "react-router";

/**
 * 全社サマリー（PK-SPEC-P0 §23.5）。
 *
 *   /app/org/dashboard
 *
 * task: docs/tasks/P0-21.md
 *
 * **全社ビューを持たないロールはここへ来られない。** URL 直打ちは
 * `ScopeForbiddenError` になるので、既定の画面へ戻す（画面では 403 を
 * 見せずに戻す — 業務を止めない）。API は 403 を返す。
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, cookieValue } = await requireAppContext(env, request, now);

  // URL を正としてセッションを `"ALL"` へ寄せる（§23.5）。
  try {
    await switchProperty(env, tenant, cookieValue, ALL_PROPERTIES, now, session.membershipId);
  } catch (error) {
    if (error instanceof ScopeForbiddenError) throw redirect(HOME_PATH);
    throw error;
  }

  const businessDate = businessDateOf(now);
  return { businessDate, summaries: await getPropertySummaries(env, tenant, businessDate) };
}

export default function OrgDashboard() {
  const data = useLoaderData<{ businessDate: string; summaries: readonly PropertySummary[] }>();

  return (
    <section className="pk-page">
      <h1 className="pk-page__title">{t("dashboard.org.title")}</h1>
      <PropertySummaryTable summaries={data.summaries} />
    </section>
  );
}
