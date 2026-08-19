/**
 * 確認依頼のメールリンク画面（P5-17 / PK-SPEC-P5 §6.1・§13）。
 *
 *   /r/billing/:billingPeriodId?exp=...&sig=...
 *
 * task:  docs/tasks/P5-17.md
 * ルール: .claude/rules/security.md §7・§8 / ui-writing.md §2
 *
 * ── 認可はセッションではなく署名 ────────────────────────
 * ホテル（発注元）が ProofKeeping 未導入でも開ける画面（§13）。
 * `layout()` の外・セッション middleware の外に置く（`/login` と同格）。
 * 到達の判定は `verifyReviewLink()`（HMAC + 期限 30 日）だけで行い、
 * 失敗はすべて **404**（改竄・期限切れ・存在しない ID を区別しない）。
 *
 * ── この画面に置かないもの ──────────────────────────────
 * 証跡（写真）・他の期間への導線・清掃スタッフの氏名。リンクが転送されても
 * 見えるのは**この期間の明細だけ**（`lib/billing/reviewLink.ts` の注記）。
 *
 * ── 操作の主体 ──────────────────────────────────────────
 * 承認・差戻しは取引先の意思（`byCounterparty: true`）。ログイン主体が
 * 無いので `actorId` は `systemActorId()`、リンクの宛先を
 * `externalActorEmail` に残す。
 */

import type { InvoiceDraft } from "@pk/billing";
import {
  NotFoundError,
  findBillingPeriodById,
  findCounterpartyById,
  lookupOrganizationId,
  systemActorId,
  type BillingPeriodStatus,
  type Env,
  type TenantContext,
} from "@pk/db";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { clientIp, consumeRateLimit } from "../../lib/auth/rateLimit.js";
import { buildPeriodDraft } from "../../lib/billing/draft.js";
import { agreeBillingPeriod, rejectBillingPeriod } from "../../lib/billing/review.js";
import { verifyReviewLink } from "../../lib/billing/reviewLink.js";
import { t } from "../../lib/i18n.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

/** 明細の 1 行（画面用の写し）。 */
interface ReviewLine {
  lineNo: number;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
}

interface ReviewData {
  periodFrom: string;
  periodTo: string;
  counterpartyName: string;
  status: BillingPeriodStatus;
  lines: ReviewLine[];
  totalAmount: number;
}

/**
 * 署名を確かめて文脈を組み立てる。**失敗はすべて 404。**
 *
 * `lookupOrganizationId()` を毎回引く（`middleware/apiKey.ts` と同じ経路）。
 * セッションが無い画面なので、組織はリンクの ID（自己記述）から解決する。
 */
async function requireReviewContext(
  env: Env,
  request: Request,
  billingPeriodId: string,
  now: Date,
): Promise<TenantContext> {
  // 認証を要しない画面なので IP で絞る（security.md §8 / RATE_LIMITS の注記）。
  const rate = await consumeRateLimit(env, "reviewLink", clientIp(request), now);
  if (!rate.allowed) {
    throw new Response(null, {
      status: 429,
      headers: { "Retry-After": String(rate.retryAfterSeconds) },
    });
  }

  const url = new URL(request.url);
  const verified = await verifyReviewLink(
    env.SESSION_SECRET,
    billingPeriodId,
    url.searchParams.get("exp"),
    url.searchParams.get("sig"),
    now,
  );
  if (!verified) throw new NotFoundError();

  const orgShortId = billingPeriodId.split("__")[0] ?? "";
  const organizationId = await lookupOrganizationId(env, orgShortId);
  if (organizationId === null) throw new NotFoundError();

  // バッチと同じ扱い（`consumers/notification.ts` の注記）。権限マトリクスは
  // 通らない画面で、到達の判定は上の署名検証が既に済ませている。
  return { organizationId, orgShortId, role: "ORG_ADMIN", allowedPropertyIds: [], now };
}

async function loadReview(
  env: Env,
  ctx: TenantContext,
  billingPeriodId: string,
): Promise<{ data: ReviewData; draft: InvoiceDraft }> {
  const period = await findBillingPeriodById(env, ctx, billingPeriodId);
  if (period === undefined) throw new NotFoundError();
  const counterparty = await findCounterpartyById(env, ctx, period.counterpartyId);
  if (counterparty === undefined) throw new NotFoundError();

  const draft = await buildPeriodDraft(env, ctx, {
    counterpartyId: period.counterpartyId,
    periodFrom: period.periodFrom,
    periodTo: period.periodTo,
    taxRoundingMode: counterparty.taxRoundingMode,
  });

  return {
    data: {
      periodFrom: period.periodFrom,
      periodTo: period.periodTo,
      counterpartyName: counterparty.displayName ?? counterparty.legalName,
      status: period.status,
      lines: draft.lines.map((line) => ({
        lineNo: line.lineNo,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        amount: line.amount,
      })),
      totalAmount: draft.totalAmount,
    },
    draft,
  };
}

export async function loader({ params, request, context }: LoaderFunctionArgs): Promise<ReviewData> {
  const env = getEnv(context);
  const now = new Date();
  const billingPeriodId = params["billingPeriodId"] ?? "";
  const ctx = await requireReviewContext(env, request, billingPeriodId, now);
  const { data } = await loadReview(env, ctx, billingPeriodId);
  return data;
}

type ReviewActionResult =
  | { done: "AGREE" | "REJECT" }
  | { failure: "COMMENT_REQUIRED" | "CONFLICT" };

export async function action({
  params,
  request,
  context,
}: ActionFunctionArgs): Promise<ReviewActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const billingPeriodId = params["billingPeriodId"] ?? "";
  const ctx = await requireReviewContext(env, request, billingPeriodId, now);

  const form = await request.formData();
  const intent = form.get("intent");
  if (intent !== "agree" && intent !== "reject") throw new NotFoundError();

  const commentRaw = form.get("comment");
  const comment = typeof commentRaw === "string" ? commentRaw.trim().slice(0, 1000) : "";
  // 差戻しはコメント必須（§6.2 MUST）。API の `reject` と同じ強制。
  if (intent === "reject" && comment === "") return { failure: "COMMENT_REQUIRED" };

  const period = await findBillingPeriodById(env, ctx, billingPeriodId);
  if (period === undefined) throw new NotFoundError();
  const counterparty = await findCounterpartyById(env, ctx, period.counterpartyId);
  if (counterparty === undefined) throw new NotFoundError();

  // 本体は共有実装（`lib/billing/review.ts` / P5-19）。メールリンクからの
  // 操作は常に取引先の意思（`byCounterparty: true`）で、ログイン主体が
  // 無いので `actorId` は `systemActorId()`、宛先を `externalActorEmail` に残す。
  const actor = {
    actorId: systemActorId(ctx.orgShortId),
    externalActorEmail: counterparty.billingEmail,
    viaReviewLink: true,
    ...(clientIp(request) === "unknown" ? {} : { ip: clientIp(request) }),
  };
  const outcome =
    intent === "agree"
      ? await agreeBillingPeriod(env, ctx, {
          billingPeriodId,
          comment: comment === "" ? null : comment,
          byCounterparty: true,
          ...actor,
        })
      : await rejectBillingPeriod(env, ctx, {
          billingPeriodId,
          comment,
          lineComments: [],
          ...actor,
        });
  if (outcome.kind === "NOT_FOUND") throw new NotFoundError();
  if (outcome.kind !== "OK") return { failure: "CONFLICT" };

  return { done: intent === "agree" ? "AGREE" : "REJECT" };
}

/** 金額。**明細は整数の円**（billing.md §4）。 */
function yen(amount: number): string {
  return `¥${amount.toLocaleString("ja-JP")}`;
}

export default function BillingReview() {
  const data = useLoaderData<ReviewData>();
  const result = useActionData<ReviewActionResult>();

  const reviewable = data.status === "REVIEWING";

  return (
    <main className="pk-review">
      <header className="pk-review__head">
        <p className="pk-review__brand">
          {t("app.brand.proof")}
          <em className="pk-topbar__brandAccent">{t("app.brand.keeping")}</em>
        </p>
        <h1 className="pk-review__title">{t("reviewLink.title")}</h1>
      </header>

      <dl className="pk-items">
        <dt>{t("reviewLink.to")}</dt>
        <dd>{data.counterpartyName}</dd>
        <dt>{t("reviewLink.period")}</dt>
        <dd>{`${data.periodFrom} 〜 ${data.periodTo}`}</dd>
      </dl>

      {result !== undefined && "done" in result ? (
        <p className="pk-notice">
          {result.done === "AGREE" ? t("reviewLink.done.agree") : t("reviewLink.done.reject")}
        </p>
      ) : null}
      {result !== undefined && "failure" in result ? (
        <p className="pk-notice pk-notice--warn">
          {result.failure === "COMMENT_REQUIRED"
            ? t("reviewLink.error.commentRequired")
            : t("reviewLink.error.conflict")}
        </p>
      ) : null}
      {data.status === "AGREED" ? <p className="pk-notice">{t("reviewLink.status.agreed")}</p> : null}
      {data.status === "INVOICED" || data.status === "CLOSED" ? (
        <p className="pk-notice">{t("reviewLink.status.invoiced")}</p>
      ) : null}
      {data.status === "OPEN" ? (
        <p className="pk-notice pk-notice--warn">{t("reviewLink.status.open")}</p>
      ) : null}

      <table className="pk-grid">
        <thead>
          <tr>
            <th>{t("reviewLink.column.description")}</th>
            <th>{t("reviewLink.column.quantity")}</th>
            <th>{t("reviewLink.column.unitPrice")}</th>
            <th>{t("reviewLink.column.amount")}</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((line) => (
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
              {t("reviewLink.total")}
            </th>
            <td>{yen(data.totalAmount)}</td>
          </tr>
        </tfoot>
      </table>

      {reviewable ? (
        <div className="pk-review__actions">
          <Form method="post" className="pk-filter">
            <input type="hidden" name="intent" value="agree" />
            <button className="pk-button" type="submit">
              {t("reviewLink.approve")}
            </button>
          </Form>
          <Form method="post" className="pk-filter">
            <input type="hidden" name="intent" value="reject" />
            <label className="pk-field">
              <span className="pk-field__label">{t("reviewLink.rejectComment")}</span>
              <input className="pk-input" name="comment" maxLength={1000} />
            </label>
            <button className="pk-button" type="submit">
              {t("reviewLink.rejectSubmit")}
            </button>
          </Form>
        </div>
      ) : null}

      <p className="pk-muted">{t("reviewLink.note.evidence")}</p>
      <p className="pk-muted">{t("reviewLink.footer")}</p>
    </main>
  );
}
