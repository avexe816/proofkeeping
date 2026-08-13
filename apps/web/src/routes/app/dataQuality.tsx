/**
 * W-22 データ品質ダッシュボード（PK-SPEC-P3 §6.3）。
 *
 *   /app/p/:propertyId/data-quality
 *
 * task:  docs/tasks/P3-12.md
 * ルール: .claude/rules/security.md §5（従業員データ）
 *
 * ── 5 指標 ──────────────────────────────────────────────
 * 入力率・既定値のまま確定・平均入力時間・外れ値除外率・未記録率。
 * 目標と警告の値は `packages/engine` が持ち、**画面は判定を受け取るだけ。**
 * 閾値をここへ書かない（別の画面が別の閾値で出す形にしないため）。
 *
 * ── 評価に使わない（§6.3 MUST / INV-07）─────────────────
 * スタッフ別に出すのは入力率だけ。**画面に「評価には使用しません」を
 * 常時表示する。** 対象期間 20 タスク未満の人は率を出さない
 * （`display: false` / security.md §5）。順位も差分も付けない。
 *
 * ── 施設 1 つぶん ───────────────────────────────────────
 * §6.3 の画面は施設 1 件。全社の平均は「どの施設を直せばよいか」を隠す。
 */

import type { DataQualityResponse } from "@pk/contracts";
import { NotFoundError } from "@pk/db";
import { useLoaderData, type LoaderFunctionArgs } from "react-router";

import { assertPermission, propertyTarget } from "../../lib/auth/permission.js";
import { collectDataQuality, monthRangeOf } from "../../lib/baseline/dataQuality.js";
import { businessDateOf } from "../../lib/businessDate.js";
import { t } from "../../lib/i18n.js";
import { switchProperty } from "../../lib/property/selection.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

interface DataQualityData {
  quality: DataQualityResponse;
}

/** 画面に並べる 5 指標。**順序は §6.3 の並び。** */
const METERS = [
  { key: "inputRate", label: "dq.inputRate", note: "dq.inputRate.target", unit: "dq.unit.percent" },
  {
    key: "defaultRate",
    label: "dq.defaultRate",
    note: "dq.defaultRate.warn",
    unit: "dq.unit.percent",
  },
  {
    key: "inputDuration",
    label: "dq.inputDuration",
    note: "dq.inputDuration.target",
    unit: "dq.unit.second",
  },
  {
    key: "exclusionRate",
    label: "dq.exclusionRate",
    note: "dq.exclusionRate.warn",
    unit: "dq.unit.percent",
  },
  { key: "skipRate", label: "dq.skipRate", note: "dq.skipRate.warn", unit: "dq.unit.percent" },
] as const;

export async function loader({
  request,
  params,
  context,
}: LoaderFunctionArgs): Promise<DataQualityData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, cookieValue } = await requireAppContext(env, request, now);

  const propertyId = params["propertyId"];
  if (propertyId === undefined) throw new NotFoundError();

  // URL を正としてセッションを更新する（PK-SPEC-P0 §23.5 / W-03 と同じ）。
  await switchProperty(env, tenant, cookieValue, propertyId, now, session.membershipId);

  assertPermission(tenant, "dataQuality.read", propertyTarget([propertyId]));

  const requested = new URL(request.url).searchParams.get("month");
  const month = requested ?? businessDateOf(now).slice(0, 7);
  const range = monthRangeOf(month);
  if (range === null) throw new NotFoundError();

  return { quality: await collectDataQuality(env, tenant, { propertyId, month, range }) };
}

export default function DataQuality() {
  const { quality } = useLoaderData<DataQualityData>();

  return (
    <section className="pk-page">
      <h1 className="pk-page__title">{t("dq.title")}</h1>
      <p className="pk-muted">{quality.month}</p>

      <ul className="pk-meters">
        {METERS.map((meter) => (
          <li key={meter.key} className="pk-meter">
            <span className="pk-meter__label">{t(meter.label)}</span>
            <span className="pk-meter__value">
              {`${valueOf(quality, meter.key)}${t(meter.unit)}`}
            </span>
            <span className="pk-meter__note">{t(meter.note)}</span>
            {quality.statuses[meter.key] === "WARN" ? (
              <span className="pk-badge pk-badge--warn">{t("dq.warn")}</span>
            ) : null}
          </li>
        ))}
      </ul>

      <h2 className="pk-pagehead__title">{t("dq.staff")}</h2>
      {/* §6.3 MUST。**この文は消さないこと**（security.md §5）。 */}
      <p className="pk-notice">{t("dq.staffNotForReview")}</p>
      {quality.staffInputRates.length === 0 ? (
        <p className="pk-muted">{t("dq.staffEmpty")}</p>
      ) : (
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("dq.staffName")}</th>
              <th>{t("dq.staffRate")}</th>
              <th>{t("dq.staffTasks")}</th>
            </tr>
          </thead>
          <tbody>
            {quality.staffInputRates.map((staff) => (
              <tr key={staff.assigneeId}>
                <th scope="row">
                  {staff.displayName === "" ? t("dq.staffUnknown") : staff.displayName}
                </th>
                <td>
                  {/* 20 タスク未満は率を出さない（security.md §5）。 */}
                  {staff.display
                    ? `${formatPermille(staff.rate.permille)}${t("dq.unit.percent")}`
                    : t("dq.staffTooFew")}
                </td>
                <td>{String(staff.rate.denominator)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="pk-pagehead__title">{t("dq.maturity")}</h2>
      <p className="pk-muted">
        {`${String(quality.reliableCombinationCount)} / ${String(quality.totalCombinationCount)}`}
      </p>
      {quality.maturity.length === 0 ? (
        <p className="pk-muted">{t("dq.maturityEmpty")}</p>
      ) : (
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("dq.roomType")}</th>
              <th>{t("dq.guestCount")}</th>
              <th>{t("dq.reliableItems")}</th>
            </tr>
          </thead>
          <tbody>
            {quality.maturity.map((combination) => (
              <tr
                key={`${combination.roomTypeId}|${String(combination.guestCount)}`}
                className={combination.isReliable ? undefined : "pk-row--muted"}
              >
                <th scope="row">
                  {combination.roomTypeName === ""
                    ? t("dq.roomTypeUnknown")
                    : combination.roomTypeName}
                </th>
                <td>{String(combination.guestCount)}</td>
                <td>
                  {`${String(combination.reliableItemCount)} / ${String(combination.itemCount)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** 母数が無いときの表示。**0 と区別する**（`metricRate()` の `permille: null`）。 */
const NO_VALUE = "—";

/** 千分率を「94.2」へ（単位は呼び出し側が付ける）。 */
function formatPermille(permille: number | null): string {
  return permille === null ? NO_VALUE : (permille / 10).toFixed(1);
}

/** 指標 1 つの表示値。**平均入力時間だけ秒**（§6.3 の「12.4秒」）。 */
function valueOf(quality: DataQualityResponse, key: (typeof METERS)[number]["key"]): string {
  if (key === "inputDuration") {
    return quality.averageInputMs === null
      ? NO_VALUE
      : (quality.averageInputMs / 1000).toFixed(1);
  }
  return formatPermille(quality[key].permille);
}
