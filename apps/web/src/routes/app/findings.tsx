/**
 * W-06 差異レポート一覧（PK-SPEC-P4 §6.1）。
 *
 *   /app/audit/findings
 *
 * task:  docs/tasks/P4-06.md
 * ルール: .claude/rules/security.md §1 / .claude/rules/ui-writing.md §2
 * 参照:  ui-prototypes/owner/pkown-v3-B-findings-records.html（04 稼働の差異）
 *
 * ── `CLEANER` / `INSPECTOR` はここに到達できない ─────────
 * §6.4 MUST。`assertPermission()` が `NotFoundError` を投げ、**404** になる。
 * サイドバーからも消える（`navigation.ts` の `finding.read`）が、
 * **メニュー非表示は権限制御ではない**（security.md §1）。この loader が門。
 *
 * ── 差異は不正の認定ではない ────────────────────────────
 * §1.1 / ui-writing.md §2。画面の語彙は「差異」「要確認項目」。
 * 「不正」「検知」「監視」「疑わしい」を出さない。
 *
 * ── 抑制を沈黙させない ──────────────────────────────────
 * §4.3。「抑制された差異 N 件」を常に出す。0 件のときも出す
 * （**出ないと「抑制という仕組みがある」こと自体が伝わらない**）。
 *
 * ── 差異率を目標として出さない ──────────────────────────
 * プロトタイプの注記どおり、差異率 0% を目標として提示しない。
 * 清掃会社の評価指標になると、既定値のまま確定する動機が生まれ、
 * P4 の精度そのものが落ちる（§11）。
 */

import type { FindingCounts, FindingSummary } from "@pk/contracts";
import { FINDING_STATUSES, type FindingStatus } from "@pk/db";
import { Form, useLoaderData, type LoaderFunctionArgs } from "react-router";

import {
  ORGANIZATION_TARGET,
  assertPermission,
  can,
  propertyTarget,
} from "../../lib/auth/permission.js";
import { monthRangeOf } from "../../lib/baseline/dataQuality.js";
import { businessDateOf } from "../../lib/businessDate.js";
import { t } from "../../lib/i18n.js";
import { listSelectableProperties, resolveSelectedScope } from "../../lib/property/selection.js";
import { collectFindingList } from "../../lib/reconciliation/findings.js";
import { SEVERITY_LABEL, STATUS_LABEL } from "../../lib/reconciliation/labels.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/** 施設セレクタの「全施設」。**組織全体を読める相手にだけ出す。** */
const ALL_PROPERTIES = "";

interface PropertyOption {
  id: string;
  name: string;
}

interface FindingsData {
  month: string;
  propertyId: string | null;
  properties: PropertyOption[];
  status: FindingStatus | null;
  rows: FindingSummary[];
  counts: FindingCounts;
  suppressedCount: number;
  canSelectAll: boolean;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<FindingsData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const url = new URL(request.url);
  const properties = await listSelectableProperties(env, tenant);
  const canSelectAll = can(tenant, "finding.read", ORGANIZATION_TARGET);

  // 施設の決め方: URL → 表示中の施設 → （全施設を読めるなら）全施設。
  const requestedProperty = url.searchParams.get("propertyId");
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
  const propertyId =
    requestedProperty === ALL_PROPERTIES && canSelectAll
      ? null
      : (requestedProperty ?? property?.id ?? (canSelectAll ? null : (properties[0]?.id ?? null)));

  // **これが唯一の門。** 施設を選んでいなければ組織全体の権限を要る。
  assertPermission(
    tenant,
    "finding.read",
    propertyId === null ? ORGANIZATION_TARGET : propertyTarget([propertyId]),
  );

  const month = url.searchParams.get("month") ?? businessDateOf(now).slice(0, 7);
  const range = monthRangeOf(month);

  const statusRaw = url.searchParams.get("status");
  const status = (FINDING_STATUSES as readonly string[]).includes(statusRaw ?? "")
    ? (statusRaw as FindingStatus)
    : null;

  const list = await collectFindingList(env, tenant, {
    ...(propertyId === null ? {} : { propertyId }),
    ...(range === null ? {} : { from: range.from, to: range.to }),
    ...(status === null ? {} : { status: [status] }),
  });

  return {
    month,
    propertyId,
    properties: properties.map((row) => ({ id: row.id, name: row.name })),
    status,
    rows: list.data,
    counts: list.counts,
    suppressedCount: list.suppressedCount,
    canSelectAll,
  };
}

export default function Findings() {
  const data = useLoaderData<FindingsData>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("finding.title")}</h1>
      </div>

      {/* §1.1。**この文は消さないこと。** 差異は示唆であって認定ではない。 */}
      <p className="pk-notice">{t("finding.intro")}</p>

      <Form method="get" className="pk-filter">
        <label className="pk-field">
          <span className="pk-field__label">{t("finding.filter.property")}</span>
          <select className="pk-select" name="propertyId" defaultValue={data.propertyId ?? ""}>
            {data.canSelectAll ? <option value="">{t("finding.filter.allProperties")}</option> : null}
            {data.properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>
        </label>

        <label className="pk-field">
          <span className="pk-field__label">{t("finding.filter.status")}</span>
          <select className="pk-select" name="status" defaultValue={data.status ?? ""}>
            <option value="">{t("finding.filter.allStatuses")}</option>
            {FINDING_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(STATUS_LABEL[status])}
              </option>
            ))}
          </select>
        </label>

        <label className="pk-field">
          <span className="pk-field__label">{t("finding.filter.month")}</span>
          <input className="pk-input" type="month" name="month" defaultValue={data.month} />
        </label>

        <button className="pk-button" type="submit">
          {t("finding.filter.apply")}
        </button>
      </Form>

      <ul className="pk-board__counts">
        {(["OPEN", "REVIEWING", "RESOLVED", "FALSE_POSITIVE"] as const).map((status) => (
          <li key={status}>
            {`${t(STATUS_LABEL[status])} ${String(data.counts[status])}`}
          </li>
        ))}
      </ul>

      {data.rows.length === 0 ? (
        <p className="pk-muted">{t("finding.empty")}</p>
      ) : (
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("finding.column.severity")}</th>
              <th>{t("finding.column.date")}</th>
              <th>{t("finding.column.property")}</th>
              <th>{t("finding.column.room")}</th>
              <th>{t("finding.column.title")}</th>
              <th>{t("finding.column.confidence")}</th>
              <th>{t("finding.column.status")}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.id}>
                <td>{t(SEVERITY_LABEL[row.severity])}</td>
                <td>{row.businessDate}</td>
                <td>{row.propertyName}</td>
                <td>{row.roomNumber}</td>
                <th scope="row">
                  <a href={`/app/audit/findings/${row.id}`}>{row.title}</a>
                </th>
                {/* §1.3 MUST。**確信度を必ず示す。** */}
                <td>{`${String(row.confidence)}%`}</td>
                <td>{t(STATUS_LABEL[row.status])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* §4.3。**0 件でも出す。** 抑制を沈黙させない。 */}
      <p className="pk-muted">
        {`${t("finding.suppressed")} ${String(data.suppressedCount)}`}
      </p>
      <p className="pk-muted">{t("finding.suppressedNote")}</p>
    </section>
  );
}
