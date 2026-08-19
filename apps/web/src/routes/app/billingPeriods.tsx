/**
 * 請求確認（月次締めの双方合意 / PK-SPEC-P5 §6 / P5-19）。
 *
 *   /app/billing-periods?period={billingPeriodId}
 *
 * task:  docs/tasks/P5-19.md
 * ルール: .claude/rules/billing.md / security.md §1
 *
 * ── 誰が見る画面か ──────────────────────────────────────
 * 清掃会社（OWNER / ORG_ADMIN）と発注元（CLIENT_VIEWER / P5-16）の両方。
 * 発注元にはリポジトリ層が自分の取引先の期間だけを返す
 * （`scopeToCounterparty()` — 画面は絞りを持たない）。
 *
 * ── 操作の門は 3 つに分かれる ───────────────────────────
 *   閲覧       billing.read    （OWNER / ORG_ADMIN / PM / AUDITOR / CLIENT_VIEWER）
 *   合意・差戻し billing.review （OWNER / ORG_ADMIN / CLIENT_VIEWER）
 *   確認依頼   billing.write   （OWNER / ORG_ADMIN — 発注元は自分に依頼しない）
 * 本体は `lib/billing/review.ts`（API・メールリンクと同じ実装）。
 *
 * ── 明細は毎回組み立てる ────────────────────────────────
 * 発行前の締めに保存された明細は無い。発行と同じ `buildPeriodDraft()` を
 * 通る（`loadPeriodWithDraft()`）。見て合意した数字と請求書が食い違わない。
 */

import {
  listBillingPeriodReviews,
  listBillingPeriods,
  listCounterparties,
  type BillingPeriodStatus,
} from "@pk/db";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { ORGANIZATION_TARGET, assertPermission, can } from "../../lib/auth/permission.js";
import {
  agreeBillingPeriod,
  loadPeriodWithDraft,
  rejectBillingPeriod,
  requestBillingPeriodReview,
} from "../../lib/billing/review.js";
import { t, type MessageKey } from "../../lib/i18n.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

interface PeriodRow {
  billingPeriodId: string;
  counterpartyName: string;
  periodFrom: string;
  periodTo: string;
  status: BillingPeriodStatus;
  agreedByCounterparty: boolean;
}

interface LineRow {
  lineNo: number;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
}

interface ReviewRow {
  seq: number;
  action: string;
  comment: string | null;
  byCounterparty: boolean;
  snapshotTotalAmount: number;
  createdAt: string;
  lineComments: { lineNo: number | null; description: string; comment: string }[];
}

interface BillingPeriodsData {
  rows: PeriodRow[];
  detail: {
    billingPeriodId: string;
    counterpartyName: string;
    periodFrom: string;
    periodTo: string;
    status: BillingPeriodStatus;
    lines: LineRow[];
    subtotalAmount: number;
    taxAmount: number;
    totalAmount: number;
    /** 単価未設定など（§3.2 MUST — 黙って落とさない）。件数だけ出す。 */
    warningCount: number;
    reviews: ReviewRow[];
  } | null;
  /** 合意・差戻しの操作を出すか（billing.review）。 */
  canReview: boolean;
  /** 確認依頼の操作を出すか（billing.write）。 */
  canRequest: boolean;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<BillingPeriodsData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);
  assertPermission(tenant, "billing.read", ORGANIZATION_TARGET);

  const [periods, counterparties] = await Promise.all([
    listBillingPeriods(env, tenant, {}),
    listCounterparties(env, tenant),
  ]);
  const nameOf = new Map(
    counterparties.map((row) => [row.id, row.displayName ?? row.legalName]),
  );

  const rows: PeriodRow[] = periods.map((period) => ({
    billingPeriodId: period.id,
    counterpartyName: nameOf.get(period.counterpartyId) ?? "",
    periodFrom: period.periodFrom,
    periodTo: period.periodTo,
    status: period.status,
    agreedByCounterparty: period.agreedByCounterparty,
  }));

  const url = new URL(request.url);
  const periodId = url.searchParams.get("period");
  let detail: BillingPeriodsData["detail"] = null;
  if (periodId !== null && periodId !== "") {
    const loaded = await loadPeriodWithDraft(env, tenant, periodId);
    if (loaded !== undefined) {
      const reviews = await listBillingPeriodReviews(env, tenant, periodId);
      detail = {
        billingPeriodId: loaded.period.id,
        counterpartyName: loaded.counterparty.displayName ?? loaded.counterparty.legalName,
        periodFrom: loaded.period.periodFrom,
        periodTo: loaded.period.periodTo,
        status: loaded.period.status,
        lines: loaded.draft.lines.map((line) => ({
          lineNo: line.lineNo,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
          amount: line.amount,
        })),
        subtotalAmount: loaded.draft.subtotalAmount,
        taxAmount: loaded.draft.taxAmount,
        totalAmount: loaded.draft.totalAmount,
        warningCount: loaded.draft.warnings.length,
        reviews: reviews.map((row) => ({
          seq: row.seq,
          action: row.action,
          comment: row.comment,
          byCounterparty: row.byCounterparty,
          snapshotTotalAmount: row.snapshotTotalAmount,
          createdAt: row.createdAt.toISOString(),
          // 履歴の主体は「発注元 / 組織内」だけを出す。**actorId（個人）を
          // 画面に出さない** — 発注元にスタッフを特定させない（契約 §4）。
          lineComments: row.lineComments.map((entry) => ({
            lineNo: entry.lineNo,
            description: entry.description,
            comment: entry.comment,
          })),
        })),
      };
    }
  }

  return {
    rows,
    detail,
    canReview: can(tenant, "billing.review", ORGANIZATION_TARGET),
    canRequest: can(tenant, "billing.write", ORGANIZATION_TARGET),
  };
}

type BillingPeriodsFailure = "INVALID" | "CONFLICT" | "COMMENT_REQUIRED";

interface BillingPeriodsActionResult {
  done?: "AGREE" | "REJECT" | "REQUEST";
  failure?: BillingPeriodsFailure;
}

export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<BillingPeriodsActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const form = await request.formData();
  const intent = form.get("intent");
  const billingPeriodId = form.get("billingPeriodId");
  if (typeof billingPeriodId !== "string" || billingPeriodId === "") {
    return { failure: "INVALID" };
  }
  const commentRaw = form.get("comment");
  const comment = typeof commentRaw === "string" ? commentRaw.trim().slice(0, 1000) : "";

  if (intent === "agree" || intent === "reject") {
    // 合意・差戻し専用の門（P5-16。billing.write と分けてある）。
    assertPermission(tenant, "billing.review", ORGANIZATION_TARGET);

    if (intent === "reject" && comment === "") return { failure: "COMMENT_REQUIRED" };
    // 発注元が押した操作は、フォームの値によらず取引先の意思（API と同じ強制）。
    const byCounterparty =
      tenant.role === "CLIENT_VIEWER" ? true : form.get("byCounterparty") === "on";

    const outcome =
      intent === "agree"
        ? await agreeBillingPeriod(env, tenant, {
            billingPeriodId,
            comment: comment === "" ? null : comment,
            byCounterparty,
            actorId: session.membershipId,
          })
        : await rejectBillingPeriod(env, tenant, {
            billingPeriodId,
            comment,
            lineComments: [],
            actorId: session.membershipId,
          });
    if (outcome.kind !== "OK") {
      return { failure: outcome.kind === "CONFLICT" ? "CONFLICT" : "INVALID" };
    }
    return { done: intent === "agree" ? "AGREE" : "REJECT" };
  }

  if (intent === "request") {
    // 確認依頼は清掃会社側の操作（発注元は自分に依頼しない）。
    assertPermission(tenant, "billing.write", ORGANIZATION_TARGET);
    const outcome = await requestBillingPeriodReview(env, tenant, {
      billingPeriodId,
      comment: comment === "" ? null : comment,
      actorId: session.membershipId,
    });
    if (outcome.kind !== "OK") {
      return { failure: outcome.kind === "CONFLICT" ? "CONFLICT" : "INVALID" };
    }
    return { done: "REQUEST" };
  }

  return { failure: "INVALID" };
}

function yen(amount: number): string {
  return `¥${amount.toLocaleString("ja-JP")}`;
}

const STATUS_LABEL: Record<BillingPeriodStatus, MessageKey> = {
  OPEN: "billingPeriods.status.open",
  REVIEWING: "billingPeriods.status.reviewing",
  AGREED: "billingPeriods.status.agreed",
  INVOICED: "billingPeriods.status.invoiced",
  CLOSED: "billingPeriods.status.closed",
};

const ACTION_LABEL: Record<string, MessageKey> = {
  AGREE: "billingPeriods.review.agree",
  REJECT: "billingPeriods.review.reject",
  REQUEST_REVIEW: "billingPeriods.review.requestReview",
};

const FAILURE_MESSAGE: Record<BillingPeriodsFailure, MessageKey> = {
  INVALID: "billingPeriods.error.invalid",
  CONFLICT: "billingPeriods.error.conflict",
  COMMENT_REQUIRED: "billingPeriods.error.commentRequired",
};

const DONE_MESSAGE: Record<"AGREE" | "REJECT" | "REQUEST", MessageKey> = {
  AGREE: "billingPeriods.done.agree",
  REJECT: "billingPeriods.done.reject",
  REQUEST: "billingPeriods.done.request",
};

/** `2026-08-19T…Z` → `2026-08-19`（履歴は日付で足りる）。 */
function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

export default function BillingPeriods() {
  const data = useLoaderData<BillingPeriodsData>();
  const result = useActionData<BillingPeriodsActionResult>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("billingPeriods.title")}</h1>
      </div>
      <p className="pk-muted">{t("billingPeriods.lede")}</p>

      {result?.failure !== undefined ? (
        <p className="pk-notice pk-notice--warn">{t(FAILURE_MESSAGE[result.failure])}</p>
      ) : null}
      {result?.done !== undefined ? (
        <p className="pk-notice">{t(DONE_MESSAGE[result.done])}</p>
      ) : null}

      <table className="pk-grid">
        <thead>
          <tr>
            <th>{t("billingPeriods.column.counterparty")}</th>
            <th>{t("billingPeriods.column.period")}</th>
            <th>{t("billingPeriods.column.status")}</th>
            <th>{t("billingPeriods.column.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.billingPeriodId}>
              <th scope="row">{row.counterpartyName}</th>
              <td>{`${row.periodFrom} 〜 ${row.periodTo}`}</td>
              <td>
                {t(STATUS_LABEL[row.status])}
                {row.status === "AGREED" && row.agreedByCounterparty ? (
                  <span className="pk-badge">{t("billingPeriods.badge.byCounterparty")}</span>
                ) : null}
              </td>
              <td>
                <a className="pk-button" href={`?period=${row.billingPeriodId}`}>
                  {t("billingPeriods.action.open")}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.rows.length === 0 ? <p className="pk-muted">{t("billingPeriods.empty")}</p> : null}

      {data.detail === null ? null : (
        <>
          <h2 className="pk-section__title">
            {`${t("billingPeriods.detail.title")} — ${data.detail.counterpartyName}（${data.detail.periodFrom} 〜 ${data.detail.periodTo}）`}
          </h2>
          <p className="pk-muted">{t(STATUS_LABEL[data.detail.status])}</p>
          {data.detail.warningCount > 0 ? (
            <p className="pk-notice pk-notice--warn">{t("billingPeriods.detail.warnings")}</p>
          ) : null}

          <table className="pk-grid">
            <thead>
              <tr>
                <th>{t("billingPeriods.lines.description")}</th>
                <th>{t("billingPeriods.lines.quantity")}</th>
                <th>{t("billingPeriods.lines.unitPrice")}</th>
                <th>{t("billingPeriods.lines.amount")}</th>
              </tr>
            </thead>
            <tbody>
              {data.detail.lines.map((line) => (
                <tr key={line.lineNo}>
                  <th scope="row">{line.description}</th>
                  <td>{`${String(line.quantity)} ${line.unit}`}</td>
                  <td>{yen(line.unitPrice)}</td>
                  <td>{yen(line.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={3} scope="row">
                  {t("billingPeriods.lines.subtotal")}
                </th>
                <td>{yen(data.detail.subtotalAmount)}</td>
              </tr>
              <tr>
                <th colSpan={3} scope="row">
                  {t("billingPeriods.lines.tax")}
                </th>
                <td>{yen(data.detail.taxAmount)}</td>
              </tr>
              <tr>
                <th colSpan={3} scope="row">
                  {t("billingPeriods.lines.total")}
                </th>
                <td>{yen(data.detail.totalAmount)}</td>
              </tr>
            </tfoot>
          </table>

          {/* 操作。状態が許すものだけを出す（押して 409 になる導線を並べない）。 */}
          {data.detail.status === "REVIEWING" && data.canRequest ? (
            <Form method="post" className="pk-inlineform">
              <input type="hidden" name="intent" value="request" />
              <input type="hidden" name="billingPeriodId" value={data.detail.billingPeriodId} />
              <button className="pk-button" type="submit">
                {t("billingPeriods.action.requestReview")}
              </button>
            </Form>
          ) : null}
          {data.detail.status === "REVIEWING" && data.canReview ? (
            <Form method="post" className="pk-filter">
              <input type="hidden" name="intent" value="agree" />
              <input type="hidden" name="billingPeriodId" value={data.detail.billingPeriodId} />
              <label className="pk-field">
                <span className="pk-field__label">{t("billingPeriods.agree.comment")}</span>
                <input className="pk-input" name="comment" maxLength={1000} />
              </label>
              <label className="pk-field">
                <span className="pk-field__label">{t("billingPeriods.agree.byCounterparty")}</span>
                <input name="byCounterparty" type="checkbox" />
              </label>
              <button className="pk-button" type="submit">
                {t("billingPeriods.action.agree")}
              </button>
            </Form>
          ) : null}
          {(data.detail.status === "REVIEWING" || data.detail.status === "AGREED") &&
          data.canReview ? (
            <Form method="post" className="pk-filter">
              <input type="hidden" name="intent" value="reject" />
              <input type="hidden" name="billingPeriodId" value={data.detail.billingPeriodId} />
              <label className="pk-field">
                <span className="pk-field__label">{t("billingPeriods.reject.comment")}</span>
                <input className="pk-input" name="comment" required maxLength={1000} />
              </label>
              <button className="pk-button" type="submit">
                {t("billingPeriods.action.reject")}
              </button>
            </Form>
          ) : null}

          {/* 合意・差戻しの履歴（§6.2 MUST）。古い順・追記だけ。 */}
          <h2 className="pk-section__title">{t("billingPeriods.review.title")}</h2>
          {data.detail.reviews.length === 0 ? (
            <p className="pk-muted">{t("billingPeriods.review.empty")}</p>
          ) : (
            <ul className="pk-timeline">
              {data.detail.reviews.map((row) => (
                <li className="pk-timeline__item" key={row.seq}>
                  <span className="pk-timeline__time">{dateOf(row.createdAt)}</span>
                  <span>
                    {t(ACTION_LABEL[row.action] ?? "billingPeriods.review.other")}
                    {`（${
                      row.byCounterparty
                        ? t("billingPeriods.actor.counterparty")
                        : t("billingPeriods.actor.internal")
                    } / ${yen(row.snapshotTotalAmount)}）`}
                  </span>
                  {row.comment === null ? null : <span>{row.comment}</span>}
                  {row.lineComments.map((entry, index) => (
                    <span key={`${String(row.seq)}-${String(index)}`} className="pk-muted">
                      {`${entry.description}: ${entry.comment}`}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
