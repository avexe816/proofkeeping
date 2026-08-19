/**
 * 支払集計（P5-18 / docs/PK-SPEC-PAY.md §3）。
 *
 *   /app/org/payouts?month=YYYY-MM&period={payoutPeriodId}
 *
 * task:  docs/tasks/P5-18.md
 * ルール: .claude/rules/billing.md §4・§5 / security.md §5
 *
 * ── 評価に使わない（security.md §5）────────────────────
 * この画面は支払の根拠を出すためのもの。**個人の比較・ランキング・
 * 平均との対比を置かないこと。** 画面に「評価には使用しません」を明記する。
 *
 * ── 門は `payout.read` / `payout.write`（OWNER / ORG_ADMIN のみ）─
 * 単価と支払額を施設責任者・発注元・監査閲覧に出さない（PAY §4）。
 */

import {
  addAdjustmentLine,
  findPayoutPeriodById,
  listOrgMembers,
  listPayoutLines,
  listPayoutPeriods,
  listStaffPayProfiles,
  recordAudit,
  type PayoutPeriodStatus,
} from "@pk/db";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { ORGANIZATION_TARGET, assertPermission } from "../../lib/auth/permission.js";
import { businessDateOf } from "../../lib/businessDate.js";
import { t, type MessageKey } from "../../lib/i18n.js";
import {
  aggregateStaffPayout,
  confirmPayoutPeriod,
  payoutMonthRange,
} from "../../lib/payout/aggregate.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

interface PayoutRow {
  payoutPeriodId: string;
  staffName: string;
  staffNumber: string;
  status: PayoutPeriodStatus;
  documentNo: string | null;
  totalAmount: number;
}

interface PayoutLineRow {
  lineNo: number;
  lineType: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  taskCount: number;
  reason: string | null;
  warning: string | null;
}

interface PayoutsData {
  month: string;
  rows: PayoutRow[];
  /** `?period=` で選んだ 1 件の明細。未選択なら null。 */
  detail: { payoutPeriodId: string; staffName: string; status: PayoutPeriodStatus; lines: PayoutLineRow[] } | null;
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function loader({ request, context }: LoaderFunctionArgs): Promise<PayoutsData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);
  assertPermission(tenant, "payout.read", ORGANIZATION_TARGET);

  const url = new URL(request.url);
  const monthRaw = url.searchParams.get("month");
  // 既定は今日（業務日）の月。
  const month =
    monthRaw !== null && MONTH_PATTERN.test(monthRaw)
      ? monthRaw
      : businessDateOf(now).slice(0, 7);
  const range = payoutMonthRange(month);

  const [periods, members] = await Promise.all([
    listPayoutPeriods(env, tenant, { periodToFrom: range.periodTo, periodFromTo: range.periodFrom }),
    listOrgMembers(env, tenant),
  ]);
  const memberOf = new Map(members.map((member) => [member.membershipId, member]));

  const rows: PayoutRow[] = periods
    .map((period) => ({
      payoutPeriodId: period.id,
      staffName: memberOf.get(period.membershipId)?.displayName ?? "",
      staffNumber: memberOf.get(period.membershipId)?.staffNumber ?? "",
      status: period.status,
      documentNo: period.documentNo,
      totalAmount: period.totalAmount,
    }))
    .sort((a, b) => a.staffNumber.localeCompare(b.staffNumber));

  const periodId = url.searchParams.get("period");
  let detail: PayoutsData["detail"] = null;
  if (periodId !== null && periodId !== "") {
    const period = await findPayoutPeriodById(env, tenant, periodId);
    if (period !== undefined) {
      const lines = await listPayoutLines(env, tenant, period.id);
      detail = {
        payoutPeriodId: period.id,
        staffName: memberOf.get(period.membershipId)?.displayName ?? "",
        status: period.status,
        lines: lines.map((line) => ({
          lineNo: line.lineNo,
          lineType: line.lineType,
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          amount: line.amount,
          taskCount: line.taskIds.length,
          reason: line.reason,
          warning: line.warning,
        })),
      };
    }
  }

  return { month, rows, detail };
}

type PayoutsFailure = "INVALID" | "CONFLICT" | "TAX_PROFILE";

interface PayoutsActionResult {
  aggregated?: number;
  adjusted?: boolean;
  confirmed?: string;
  failure?: PayoutsFailure;
}

function textOf(value: FormDataEntryValue | null, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > maxLength ? null : trimmed;
}

export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<PayoutsActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);
  assertPermission(tenant, "payout.write", ORGANIZATION_TARGET);

  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "aggregate") {
    const month = textOf(form.get("month"), 7);
    if (month === null || !MONTH_PATTERN.test(month)) return { failure: "INVALID" };
    const profiles = (await listStaffPayProfiles(env, tenant)).filter(
      (profile) => profile.isActive,
    );
    let aggregated = 0;
    for (const profile of profiles) {
      const outcome = await aggregateStaffPayout(env, tenant, {
        membershipId: profile.membershipId,
        month,
      });
      if (outcome.kind === "AGGREGATED") aggregated += 1;
    }
    return { aggregated };
  }

  const payoutPeriodId = form.get("payoutPeriodId");
  if (typeof payoutPeriodId !== "string" || payoutPeriodId === "") return { failure: "INVALID" };

  if (intent === "adjust") {
    const lineTypeRaw = form.get("lineType");
    const lineType =
      lineTypeRaw === "ADJUSTMENT" || lineTypeRaw === "REIMBURSEMENT" ? lineTypeRaw : null;
    const description = textOf(form.get("description"), 120);
    const reason = textOf(form.get("reason"), 500);
    const amountRaw = textOf(form.get("amount"), 12);
    const amount = amountRaw === null ? Number.NaN : Number(amountRaw);
    if (lineType === null || description === null || reason === null) return { failure: "INVALID" };
    if (!Number.isInteger(amount)) return { failure: "INVALID" };

    const period = await findPayoutPeriodById(env, tenant, payoutPeriodId);
    if (period === undefined) return { failure: "INVALID" };
    if (period.status === "CONFIRMED") return { failure: "CONFLICT" };

    await addAdjustmentLine(env, tenant, { payoutPeriodId, lineType, description, amount, reason });
    return { adjusted: true };
  }

  if (intent === "confirm") {
    const outcome = await confirmPayoutPeriod(env, tenant, payoutPeriodId);
    if (outcome === undefined) return { failure: "INVALID" };
    if (outcome.kind === "REJECTED") {
      return { failure: outcome.reason === "TAX_PROFILE_NOT_FOUND" ? "TAX_PROFILE" : "CONFLICT" };
    }
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "payout.confirmed",
      targetType: "payoutPeriod",
      targetId: payoutPeriodId,
      after: { documentNo: outcome.documentNo, totalAmount: outcome.totalAmount },
    });
    return { confirmed: outcome.documentNo };
  }

  return { failure: "INVALID" };
}

const FAILURE_MESSAGE: Record<PayoutsFailure, MessageKey> = {
  INVALID: "payouts.error.invalid",
  CONFLICT: "payouts.error.conflict",
  TAX_PROFILE: "payouts.error.taxProfile",
};

function yen(amount: number): string {
  return `¥${amount.toLocaleString("ja-JP")}`;
}

const STATUS_LABEL: Record<PayoutPeriodStatus, MessageKey> = {
  OPEN: "payouts.status.open",
  REVIEWING: "payouts.status.reviewing",
  CONFIRMED: "payouts.status.confirmed",
};

export default function Payouts() {
  const data = useLoaderData<PayoutsData>();
  const result = useActionData<PayoutsActionResult>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("payouts.title")}</h1>
      </div>
      <p className="pk-muted">{t("payouts.lede")}</p>
      {/* security.md §5。支払の根拠であって評価の道具ではない。 */}
      <p className="pk-muted">{t("payouts.noEvaluationNote")}</p>

      {result?.failure !== undefined ? (
        <p className="pk-notice pk-notice--warn">{t(FAILURE_MESSAGE[result.failure])}</p>
      ) : null}
      {result?.aggregated !== undefined ? <p className="pk-notice">{t("payouts.aggregated")}</p> : null}
      {result?.adjusted === true ? <p className="pk-notice">{t("payouts.adjusted")}</p> : null}
      {result?.confirmed !== undefined ? (
        <p className="pk-notice">{`${t("payouts.confirmedNotice")}（${result.confirmed}）`}</p>
      ) : null}

      <Form method="get" className="pk-filter">
        <label className="pk-field">
          <span className="pk-field__label">{t("payouts.field.month")}</span>
          <input className="pk-input" name="month" type="month" defaultValue={data.month} />
        </label>
        <button className="pk-button" type="submit">
          {t("payouts.show")}
        </button>
      </Form>

      <Form method="post" className="pk-inlineform">
        <input type="hidden" name="intent" value="aggregate" />
        <input type="hidden" name="month" value={data.month} />
        <button className="pk-button" type="submit">
          {t("payouts.aggregate")}
        </button>
      </Form>
      <p className="pk-muted">{t("payouts.aggregateNote")}</p>

      <table className="pk-grid">
        <thead>
          <tr>
            <th>{t("payouts.column.staff")}</th>
            <th>{t("payouts.column.status")}</th>
            <th>{t("payouts.column.documentNo")}</th>
            <th>{t("payouts.column.total")}</th>
            <th>{t("payouts.column.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.payoutPeriodId}>
              <th scope="row">{`${row.staffName}（${row.staffNumber}）`}</th>
              <td>{t(STATUS_LABEL[row.status])}</td>
              <td>{row.documentNo ?? "—"}</td>
              <td>{yen(row.totalAmount)}</td>
              <td>
                <a className="pk-button" href={`?month=${data.month}&period=${row.payoutPeriodId}`}>
                  {t("payouts.action.lines")}
                </a>
                {row.status === "REVIEWING" ? (
                  <Form method="post" className="pk-inlineform">
                    <input type="hidden" name="intent" value="confirm" />
                    <input type="hidden" name="payoutPeriodId" value={row.payoutPeriodId} />
                    <button className="pk-button" type="submit">
                      {t("payouts.action.confirm")}
                    </button>
                  </Form>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.rows.length === 0 ? <p className="pk-muted">{t("payouts.empty")}</p> : null}

      {data.detail === null ? null : (
        <>
          <h2 className="pk-section__title">{`${t("payouts.lines.title")} — ${data.detail.staffName}`}</h2>
          <table className="pk-grid">
            <thead>
              <tr>
                <th>{t("payouts.lines.description")}</th>
                <th>{t("payouts.lines.quantity")}</th>
                <th>{t("payouts.lines.unitPrice")}</th>
                <th>{t("payouts.lines.amount")}</th>
                <th>{t("payouts.lines.note")}</th>
              </tr>
            </thead>
            <tbody>
              {data.detail.lines.map((line) => (
                <tr key={line.lineNo}>
                  <th scope="row">{line.description}</th>
                  <td>{line.quantity}</td>
                  <td>{yen(line.unitPrice)}</td>
                  <td>{yen(line.amount)}</td>
                  <td>
                    {line.warning !== null ? (
                      <span className="pk-badge pk-badge--warn">{t("payouts.lines.noRule")}</span>
                    ) : null}
                    {line.reason ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.detail.status === "REVIEWING" ? (
            <Form method="post" className="pk-filter">
              <input type="hidden" name="intent" value="adjust" />
              <input type="hidden" name="payoutPeriodId" value={data.detail.payoutPeriodId} />
              <label className="pk-field">
                <span className="pk-field__label">{t("payouts.adjust.type")}</span>
                <select className="pk-select" name="lineType" defaultValue="ADJUSTMENT">
                  <option value="ADJUSTMENT">{t("payouts.adjust.type.adjustment")}</option>
                  <option value="REIMBURSEMENT">{t("payouts.adjust.type.reimbursement")}</option>
                </select>
              </label>
              <label className="pk-field">
                <span className="pk-field__label">{t("payouts.adjust.description")}</span>
                <input className="pk-input" name="description" required maxLength={120} />
              </label>
              <label className="pk-field">
                <span className="pk-field__label">{t("payouts.adjust.amount")}</span>
                <input className="pk-input" name="amount" required inputMode="numeric" pattern="-?[0-9]+" />
              </label>
              <label className="pk-field">
                <span className="pk-field__label">{t("payouts.adjust.reason")}</span>
                <input className="pk-input" name="reason" required maxLength={500} />
              </label>
              <button className="pk-button" type="submit">
                {t("payouts.adjust.submit")}
              </button>
            </Form>
          ) : null}
        </>
      )}

      <p className="pk-muted">
        <a href={`/api/v1/payouts/export?month=${data.month}`}>{t("payouts.exportCsv")}</a>
      </p>
    </section>
  );
}
