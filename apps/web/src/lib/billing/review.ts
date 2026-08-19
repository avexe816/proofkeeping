/**
 * 双方合意（合意・差戻し・確認依頼）の共有実装（PK-SPEC-P5 §6 / P5-19）。
 *
 * task:  docs/tasks/P5-19.md
 * ルール: .claude/rules/billing.md §2 / security.md §1
 *
 * ── なぜ lib に寄せたのか ───────────────────────────────
 * 同じ操作の入口が 3 つある: API（`routes/api/v1/billingPeriods.ts`）、
 * 請求確認の PC 画面（`routes/app/billingPeriods.tsx`）、メールリンク
 * （`routes/review/billingReview.tsx` / P5-17）。実装が 3 つに割れると、
 * 「合意した瞬間の明細を履歴に固定する」約束（§6.2 MUST）が 1 か所で
 * だけ守られる事故が起きる。`lib/staff/register.ts` と同じ判断
 * （DECISIONS #181 の向き）。
 *
 * ── ここは権限を見ない ──────────────────────────────────
 * `assertPermission()`（ログイン経路）と署名検証（メールリンク経路）は
 * 呼び出し側の責任。ここに入った時点で認可は済んでいる。
 *
 * ── 履歴は追記だけ ──────────────────────────────────────
 * `appendBillingPeriodReview()` に更新・削除の口は無い（CLAUDE.md §4）。
 */

import {
  evaluateBillingPeriodTransition,
  type BillingPeriodStatusValue,
  type InvoiceDraft,
} from "@pk/billing";
import {
  appendBillingPeriodReview,
  findBillingPeriodById,
  findCounterpartyById,
  recordAudit,
  updateBillingPeriodStatus,
  type BillingPeriodReviewLineComment,
  type BillingPeriodReviewLineSnapshot,
  type Env,
  type TenantContext,
} from "@pk/db";

import type { ReviewRequestDeliveryMessage } from "../../consumers/notification.js";
import { buildPeriodDraft } from "./draft.js";

/**
 * 締めと、そのとき見える明細を揃えて返す。
 *
 * **発行（`lib/billing/issue.ts`）と同じ `buildPeriodDraft()` を通る。**
 * 合意の画面が別の計算をすると、見て合意した数字と請求書が食い違う
 * （§0.2 の出荷判定）。
 */
export async function loadPeriodWithDraft(env: Env, ctx: TenantContext, billingPeriodId: string) {
  const period = await findBillingPeriodById(env, ctx, billingPeriodId);
  if (period === undefined) return undefined;

  const counterparty = await findCounterpartyById(env, ctx, period.counterpartyId);
  // 取引先が引けない締めは**明細を組めない**（端数処理の方式が決まらない）。
  // 越境と同じ 404 に寄せる（403 を作らない / DECISIONS #022）。
  if (counterparty === undefined) return undefined;

  const draft = await buildPeriodDraft(env, ctx, {
    counterpartyId: period.counterpartyId,
    periodFrom: period.periodFrom,
    periodTo: period.periodTo,
    taxRoundingMode: counterparty.taxRoundingMode,
  });

  return { period, draft, counterparty };
}

/** 履歴に残す明細の写し（§6.2 の修正履歴）。**金額は整数のまま。** */
export function snapshotOf(draft: InvoiceDraft): BillingPeriodReviewLineSnapshot[] {
  return draft.lines.map((line) => ({
    lineNo: line.lineNo,
    lineKey: line.lineKey,
    itemCode: line.itemCode,
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    amount: line.amount,
    taxRate: line.taxRate,
  }));
}

/** 操作の主体。3 つの入口（API・画面・メールリンク）が同じ形で渡す。 */
interface ActorInput {
  actorId: string;
  /** メールリンク承認（P5-17）の宛先。ログイン主体の操作では省略。 */
  externalActorEmail?: string;
  /** メールリンク経由の操作か。監査ログの `after` に残す。 */
  viaReviewLink?: boolean;
  ip?: string;
}

export type AgreeOutcome =
  | { kind: "OK"; status: BillingPeriodStatusValue }
  /** 期間が無い・取引先が引けない。**404 に写す**（403 を作らない）。 */
  | { kind: "NOT_FOUND" }
  /** 状態遷移が許されない・並行更新に負けた。**409 に写す。** */
  | { kind: "CONFLICT" };

/**
 * 合意（`REVIEWING → AGREED` / §6.1）。
 *
 * **合意した瞬間の明細を履歴に固定する**（§6.2 MUST）。
 * `byCounterparty` の決め方は呼び出し側: CLIENT_VIEWER とメールリンクは
 * 常に取引先の意思（true を強制）、清掃会社の代行入力はフォームの値。
 */
export async function agreeBillingPeriod(
  env: Env,
  ctx: TenantContext,
  input: { billingPeriodId: string; comment: string | null; byCounterparty: boolean } & ActorInput,
): Promise<AgreeOutcome> {
  const loaded = await loadPeriodWithDraft(env, ctx, input.billingPeriodId);
  if (loaded === undefined) return { kind: "NOT_FOUND" };
  const { period, draft } = loaded;

  const transition = evaluateBillingPeriodTransition(period.status, "AGREE");
  if (!transition.allowed) return { kind: "CONFLICT" };

  const changed = await updateBillingPeriodStatus(
    env,
    ctx,
    period.id,
    { status: transition.next, agreedAt: ctx.now, agreedByCounterparty: input.byCounterparty },
    period.status,
  );
  // 0 なら別のリクエストが先に進めている。**履歴を書く前に落とす。**
  // 状態が動いていないのに「合意した」と残ると、履歴のほうが嘘になる。
  if (changed === 0) return { kind: "CONFLICT" };

  await appendBillingPeriodReview(env, ctx, {
    billingPeriodId: period.id,
    action: "AGREE",
    comment: input.comment,
    lineComments: [],
    linesSnapshot: snapshotOf(draft),
    snapshotTotalAmount: draft.totalAmount,
    statusBefore: period.status,
    statusAfter: transition.next,
    byCounterparty: input.byCounterparty,
    actorId: input.actorId,
    ...(input.externalActorEmail === undefined
      ? {}
      : { externalActorEmail: input.externalActorEmail }),
  });

  await recordAudit(env, ctx, {
    actorId: input.actorId,
    action: "billingPeriod.statusChanged",
    targetType: "billingPeriod",
    targetId: period.id,
    before: { status: period.status },
    after: {
      status: transition.next,
      agreedByCounterparty: input.byCounterparty,
      ...(input.viaReviewLink === true ? { viaReviewLink: true } : {}),
    },
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  });

  return { kind: "OK", status: transition.next };
}

export type RejectOutcome =
  | { kind: "OK"; status: BillingPeriodStatusValue; seq: number }
  | { kind: "NOT_FOUND" }
  | { kind: "CONFLICT" }
  /** いま組み立てた明細に無い `lineKey`。**400 に写す。** */
  | { kind: "INVALID_LINE" };

/**
 * 差戻し（§6.2 MUST）。
 *
 * **コメント必須の強制は呼び出し側**（API は zod、画面はフォーム検証）。
 * ここは `comment` を非 null で受け取る型にして、忘れを型で防ぐ。
 *
 * `AGREED` からも差し戻せる（§6.1）。そのとき `agreedAt` と
 * `agreedByCounterparty` を**戻す** — 残っていると `AGREED` 相当の
 * 請求ができてしまう。取り消した事実は履歴に残る。
 */
export async function rejectBillingPeriod(
  env: Env,
  ctx: TenantContext,
  input: {
    billingPeriodId: string;
    comment: string;
    lineComments: readonly { lineKey: string; comment: string }[];
  } & ActorInput,
): Promise<RejectOutcome> {
  const loaded = await loadPeriodWithDraft(env, ctx, input.billingPeriodId);
  if (loaded === undefined) return { kind: "NOT_FOUND" };
  const { period, draft } = loaded;

  // 行コメントの検証は遷移判定より先（既存 API の順序を保つ）。
  // 消えた行へのコメントを受け取ると、どの作業への指摘か誰にも分からない。
  const byLineKey = new Map(draft.lines.map((line) => [line.lineKey, line]));
  const lineComments: BillingPeriodReviewLineComment[] = [];
  for (const entry of input.lineComments) {
    const line = byLineKey.get(entry.lineKey);
    if (line === undefined) return { kind: "INVALID_LINE" };
    lineComments.push({
      lineKey: entry.lineKey,
      lineNo: line.lineNo,
      description: line.description,
      comment: entry.comment,
    });
  }

  const transition = evaluateBillingPeriodTransition(period.status, "REJECT");
  if (!transition.allowed) return { kind: "CONFLICT" };

  const changed = await updateBillingPeriodStatus(
    env,
    ctx,
    period.id,
    { status: transition.next, agreedAt: null, agreedByCounterparty: false },
    period.status,
  );
  if (changed === 0) return { kind: "CONFLICT" };

  const appended = await appendBillingPeriodReview(env, ctx, {
    billingPeriodId: period.id,
    action: "REJECT",
    comment: input.comment,
    lineComments,
    linesSnapshot: snapshotOf(draft),
    snapshotTotalAmount: draft.totalAmount,
    statusBefore: period.status,
    statusAfter: transition.next,
    // 差戻しはホテル側の意思（§6.2 の見本の「行2 へのコメント（ホテル側）」）。
    byCounterparty: true,
    actorId: input.actorId,
    ...(input.externalActorEmail === undefined
      ? {}
      : { externalActorEmail: input.externalActorEmail }),
  });

  await recordAudit(env, ctx, {
    actorId: input.actorId,
    action: "billingPeriod.statusChanged",
    targetType: "billingPeriod",
    targetId: period.id,
    before: { status: period.status },
    after: {
      status: transition.next,
      rejected: true,
      ...(input.viaReviewLink === true ? { viaReviewLink: true } : {}),
    },
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  });

  return { kind: "OK", status: transition.next, seq: appended.seq };
}

export type RequestReviewOutcome =
  | { kind: "OK"; status: BillingPeriodStatusValue; seq: number }
  | { kind: "NOT_FOUND" }
  | { kind: "CONFLICT" };

/**
 * 確認依頼（§9 / P5-17）。**状態を変えない**（DECISIONS #128）。
 *
 * 履歴に「そのとき見えていた明細」を残し、取引先へ署名付きリンクを
 * Queue 経由で送る。**投入の失敗で依頼自体を落とさない**（`notify()` と
 * 同じ判断 — 履歴は既に残っており、再依頼すれば送り直せる）。
 */
export async function requestBillingPeriodReview(
  env: Env,
  ctx: TenantContext,
  input: { billingPeriodId: string; comment: string | null; actorId: string; ip?: string },
): Promise<RequestReviewOutcome> {
  const loaded = await loadPeriodWithDraft(env, ctx, input.billingPeriodId);
  if (loaded === undefined) return { kind: "NOT_FOUND" };
  const { period, draft, counterparty } = loaded;

  // `REVIEWING` のときだけ。集計前（`OPEN`）に確認は頼めないし、
  // 合意済み・発行済みに頼み直すのは差戻し（`reject`）である。
  if (period.status !== "REVIEWING") return { kind: "CONFLICT" };

  const appended = await appendBillingPeriodReview(env, ctx, {
    billingPeriodId: period.id,
    action: "REQUEST_REVIEW",
    comment: input.comment,
    lineComments: [],
    linesSnapshot: snapshotOf(draft),
    snapshotTotalAmount: draft.totalAmount,
    statusBefore: period.status,
    statusAfter: period.status,
    byCounterparty: false,
    actorId: input.actorId,
  });

  // 送信は Queue コンシューマ（`consumers/notification.ts`）。リンクの署名も
  // そちらで行う（送信時刻を起点に 30 日）。送付ログは docType =
  // REVIEW_REQUEST でコンシューマが残す。
  const message: ReviewRequestDeliveryMessage = {
    kind: "REVIEW_REQUEST_DELIVERY",
    organizationId: ctx.organizationId,
    orgShortId: ctx.orgShortId,
    billingPeriodId: period.id,
    toEmail: counterparty.billingEmail,
    ccEmails: [...counterparty.ccEmails],
    sentById: input.actorId,
    requestedAtMs: ctx.now.getTime(),
  };
  try {
    await env.QUEUE_NOTIFICATION.send(message);
  } catch {
    console.error("review-request-enqueue-failed");
  }

  await recordAudit(env, ctx, {
    actorId: input.actorId,
    action: "billingPeriod.reviewRequested",
    targetType: "billingPeriod",
    targetId: period.id,
    after: { seq: appended.seq },
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  });

  return { kind: "OK", status: period.status, seq: appended.seq };
}
