/**
 * 請求書の発行（PK-SPEC-P5 §4.1）。**中核機能。**
 *
 * task:  docs/tasks/P5-07.md
 * ルール: .claude/rules/billing.md §7（発行フロー）・§5（採番）・§6（スナップショット）
 *
 * ```
 * ① BillingPeriod を INVOICED にロック
 * ② DocumentSequencer（DO）で番号採番
 * ③ Invoice / InvoiceLine / InvoiceTaxSummary を INSERT
 * ④ issuerSnapshot / counterpartySnapshot を固定
 * ⑤ payloadSha256 を計算
 * ⑥ status = CONFIRMED
 *      ↑ ③〜⑥ は 1 トランザクション（§4.1 MUST）
 * ⑦ Queue: pdf-generation
 * ```
 * ⑧以降（PDF・送付）はコンシューマ（`consumers/invoicePdf.ts` /
 * `consumers/notification.ts`）。
 *
 * ── 順序を入れ替えない ──────────────────────────────────
 * **ロック（①）が採番（②）より先。** 逆にすると、締めが進められない
 * ときに番号だけが減る（欠番は許容されるが、理由の説明できない欠番を
 * 作らない）。`updateBillingPeriodStatus()` は楽観ロックなので、
 * 同時に 2 本走っても片方しか ① を通れない。
 *
 * ── 二重発行（§4.3 MUST）────────────────────────────────
 * 連打・再送で 2 通目を発行しない。効いているのは 2 つ。
 *   ① **締めの状態そのもの。** `AGREED` からしか発行できず、成功した
 *      瞬間に `INVOICED` になる。2 本目は ① で弾かれる。
 *   ② `billingPeriod.invoiceId` に発行済みの請求書が入る。**2 回目は
 *      それを返す**（新しく作らない）。
 * `Idempotency-Key` ヘッダは受けるが、**鍵の記録という別の状態を
 * 作らない。** 締めの行が既に「1 期間 1 請求書」を保証しているため
 * （`routes/api/v1/roomTypes.ts` と同じ判断 / docs/DECISIONS.md #055）。
 *
 * ── PDF が失敗しても請求書は残る（§4.1 MUST）──────────
 * ⑦ は Queue への投入だけ。**投入に失敗しても ③〜⑥ は巻き戻さない。**
 * PDF 未生成は `CONFIRMED`（`pdfStorageKey` が null）として表現し、
 * `regenerate-pdf` で作り直せる。
 *
 * ── A 案: 常に AGREED 必須 ──────────────────────────────
 * §10.6 は「双方が AGREED にしないと発行できない**設定が可能**」と
 * 書くが、その設定を持つ列が §2 に無い（OPEN_QUESTIONS #074）。
 * **常に `AGREED` を要求する。** 状態機械
 * （`evaluateBillingPeriodTransition()`）が既にそう動いており、
 * §0.2 の出荷判定「同じ明細を見て相違なく合意できる」とも噛み合う。
 */

import {
  buildInvoiceDraft,
  closedPeriodAsOf,
  counterpartyPropertyScope,
  determineQualifiedInvoice,
  evaluateBillingPeriodTransition,
  fiscalYearOf,
  type BillableTask,
  type InvoiceDraft,
} from "@pk/billing";
import {
  createInvoice,
  findBillingPeriodById,
  findCounterpartyById,
  findInvoiceById,
  findTaxProfile,
  listPricingRules,
  listProperties,
  listRoomTypes,
  listRooms,
  listTasks,
  updateBillingPeriodStatus,
  type Env,
  type TenantContext,
} from "@pk/db";
import { canonicalJson } from "@pk/engine";

import { issueDocumentNumber } from "../document/sequencer.js";
import { sha256HexOfText } from "../evidence/hash.js";
import type { InvoicePdfMessage } from "../../consumers/invoicePdf.js";

/** 発行の結果。**呼び出し側が HTTP の応答を決める。** */
export type IssueInvoiceOutcome =
  | { kind: "ISSUED"; invoiceId: string; documentNo: string; draft: InvoiceDraft }
  /** 既に発行済み。**2 通目を作らない**（§4.3 MUST）。 */
  | { kind: "ALREADY_ISSUED"; invoiceId: string }
  /** 締めが `AGREED` でない・取引先が無い等。呼び出し側が 409 / 404 を選ぶ。 */
  | { kind: "REJECTED"; reason: IssueRejectReason };

export type IssueRejectReason =
  | "PERIOD_NOT_FOUND"
  | "PERIOD_NOT_AGREED"
  | "COUNTERPARTY_NOT_FOUND"
  | "TAX_PROFILE_NOT_FOUND"
  | "LOCK_LOST";

export interface IssueInvoiceInput {
  billingPeriodId: string;
  /** 発行した `membership.id`。**`confirmedById` に残る。** */
  actorId: string;
  /** 発行日（`YYYY-MM-DD`）。呼び出し側が現地時刻から出す。 */
  issueDate: string;
  /** 再清掃を計上するか（OPEN_QUESTIONS #070）。既定は `false`。 */
  chargeRework?: boolean;
}

/**
 * 支払期限（§2.1 の `paymentTermDays`）。
 *
 * **発行日からの日数。** 締め日からではない（請求書を出すのが遅れた
 * ぶん、支払いの猶予まで短くならないようにする）。
 */
export function dueDateOf(issueDate: string, paymentTermDays: number): string {
  const shifted = new Date(`${issueDate}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + paymentTermDays);
  return shifted.toISOString().slice(0, 10);
}

/**
 * 締めの期間に含まれる清掃タスクを集める（§3.1）。
 *
 * **施設の範囲は料金設定から導く**（`counterpartyPropertyScope()` /
 * OPEN_QUESTIONS #071）。除外の判断（`COMPLETED` 以外）は
 * `buildInvoiceDraft()` の中。ここでは絞らずに渡す。
 *
 * ── 客室タイプはタスクに載っていない ────────────────────
 * `cleaningTask` は `roomId` しか持たない（客室タイプは `room` 側）。
 * §3.4 の粒度（施設 × 清掃種別 × 客室タイプ）で畳むために、施設ごとに
 * 客室と客室タイプを 1 回ずつ引いて対応表を作る。**タスク 1 件ごとに
 * 引かない**（明細 300 件で 300 往復になる）。
 *
 * ── `isRework` は常に偽 ─────────────────────────────────
 * 再清掃は**同じタスクに対する巡回**（`reworkCycle` は `taskId` + `round`）で、
 * 別のタスクにはならない。つまり「再清掃のタスク」は存在しない。
 * §3.1 の「再清掃（ReworkCycle）※ 有償設定の場合のみ計上」を満たすには
 * `reworkCycle` を独立の明細（`REWORK` 品目）として起こす必要があるが、
 * その可否を決める**有償設定の列がまだ無い**（OPEN_QUESTIONS #070）。
 * 列ができるまで計上しない。**黙って落としているのではなく、
 * 起こす対象がまだ定義されていない。**
 */
async function collectBillableTasks(
  env: Env,
  ctx: TenantContext,
  input: { propertyIds: readonly string[]; periodFrom: string; periodTo: string },
): Promise<BillableTask[]> {
  const properties = await listProperties(env, ctx, { isActive: true });
  const nameById = new Map(properties.map((property) => [property.id, property.name]));

  const tasks: BillableTask[] = [];
  for (const propertyId of input.propertyIds) {
    const [rows, rooms, roomTypes] = await Promise.all([
      listTasks(env, ctx, {
        propertyId,
        businessDateFrom: input.periodFrom,
        businessDateTo: input.periodTo,
      }),
      listRooms(env, ctx, { propertyId }),
      listRoomTypes(env, ctx, propertyId, {}),
    ]);

    const roomTypeIdByRoomId = new Map(rooms.map((room) => [room.id, room.roomTypeId]));
    const roomTypeNameById = new Map(roomTypes.map((roomType) => [roomType.id, roomType.name]));

    for (const row of rows) {
      const roomTypeId = roomTypeIdByRoomId.get(row.roomId) ?? null;
      tasks.push({
        taskId: row.id,
        propertyId: row.propertyId,
        propertyName: nameById.get(row.propertyId) ?? row.propertyId,
        roomTypeId,
        roomTypeName: roomTypeId === null ? null : (roomTypeNameById.get(roomTypeId) ?? null),
        taskType: row.taskType,
        businessDate: row.businessDate,
        status: row.status,
        isRework: false,
      });
    }
  }
  return tasks;
}

/**
 * 請求書を 1 通発行する（§4.1 の ①〜⑦）。
 *
 * **PDF とメールはここで作らない。** Queue へ投げるところまで。
 */
export async function issueInvoice(
  env: Env,
  ctx: TenantContext,
  input: IssueInvoiceInput,
): Promise<IssueInvoiceOutcome> {
  const period = await findBillingPeriodById(env, ctx, input.billingPeriodId);
  if (period === undefined) return { kind: "REJECTED", reason: "PERIOD_NOT_FOUND" };

  // 既に発行済みなら**それを返す**（§4.3 MUST。2 通目を作らない）。
  if (period.invoiceId !== null) {
    return { kind: "ALREADY_ISSUED", invoiceId: period.invoiceId };
  }

  // A 案: 常に `AGREED` 必須（冒頭の注記）。
  const transition = evaluateBillingPeriodTransition(period.status, "ISSUE_INVOICE");
  if (!transition.allowed) return { kind: "REJECTED", reason: "PERIOD_NOT_AGREED" };

  const [counterparty, taxProfile] = await Promise.all([
    findCounterpartyById(env, ctx, period.counterpartyId),
    findTaxProfile(env, ctx),
  ]);
  if (counterparty === undefined) return { kind: "REJECTED", reason: "COUNTERPARTY_NOT_FOUND" };
  if (taxProfile === undefined) return { kind: "REJECTED", reason: "TAX_PROFILE_NOT_FOUND" };

  // 明細を組む。**採番より先。** 集計に失敗したときに番号を消費しない。
  const pricingRules = await listPricingRules(env, ctx, {
    counterpartyId: period.counterpartyId,
  });
  const scope = counterpartyPropertyScope(pricingRules);
  const propertyIds =
    scope.kind === "ALL_PROPERTIES"
      ? (await listProperties(env, ctx, { isActive: true })).map((property) => property.id)
      : scope.propertyIds;

  const tasks = await collectBillableTasks(env, ctx, {
    propertyIds,
    periodFrom: period.periodFrom,
    periodTo: period.periodTo,
  });

  const draft = buildInvoiceDraft({
    tasks,
    pricingRules,
    taxRoundingMode: counterparty.taxRoundingMode,
    chargeRework: input.chargeRework ?? false,
  });

  // ① 締めを `INVOICED` へロックする。**採番より先**（冒頭の注記）。
  const locked = await updateBillingPeriodStatus(
    env,
    ctx,
    period.id,
    { status: transition.next },
    period.status,
  );
  if (locked === 0) return { kind: "REJECTED", reason: "LOCK_LOST" };

  // ② 採番。**`DocumentSequencer`（DO）経由のみ**（billing.md §5）。
  const issued = await issueDocumentNumber(env, {
    organizationId: ctx.organizationId,
    documentType: "INVOICE",
    fiscalYear: fiscalYearOf(input.issueDate, taxProfile.fiscalYearStartMonth),
  });

  // ④ スナップショットを固定する（billing.md §6）。
  const issuerSnapshot: Record<string, unknown> = {
    legalName: taxProfile.legalName,
    registrationNo: taxProfile.invoiceRegistrationNumber,
    postalCode: taxProfile.postalCode,
    address: taxProfile.address,
    tel: taxProfile.tel,
  };
  const counterpartySnapshot: Record<string, unknown> = {
    legalName: counterparty.legalName,
    postalCode: counterparty.postalCode,
    address1: counterparty.address1,
    address2: counterparty.address2,
    department: counterparty.department,
    contactName: counterparty.contactName,
    billingEmail: counterparty.billingEmail,
    ccEmails: counterparty.ccEmails,
  };

  const dueDate = dueDateOf(input.issueDate, counterparty.paymentTermDays);
  // §1.1 MUST。**発行の瞬間に決めて固定する。** あとからマスタに
  // 登録番号が入っても、この請求書は適格にならない。
  const isQualifiedInvoice = determineQualifiedInvoice(taxProfile.invoiceRegistrationNumber);

  // ⑤ payload のハッシュ。**明細を含む**（§4.1）。
  const payloadSha256 = await sha256HexOfText(
    canonicalJson({
      documentNo: issued.documentNumber,
      issueDate: input.issueDate,
      dueDate,
      periodFrom: period.periodFrom,
      periodTo: period.periodTo,
      subtotalAmount: draft.subtotalAmount,
      taxAmount: draft.taxAmount,
      totalAmount: draft.totalAmount,
      isQualifiedInvoice,
      lines: draft.lines.map((line) => ({
        lineNo: line.lineNo,
        itemCode: line.itemCode,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        amount: line.amount,
        taxRate: line.taxRate,
        isReducedRate: line.isReducedRate,
      })),
      taxSummaries: draft.taxSummaries.map((summary) => ({
        taxRate: summary.taxRate,
        isReducedRate: summary.isReducedRate,
        subtotalAmount: summary.subtotalAmount,
        taxAmount: summary.taxAmount,
        totalAmount: summary.totalAmount,
      })),
    }),
  );

  // ③〜⑥ 1 トランザクション。
  const { invoiceId } = await createInvoice(env, ctx, {
    counterpartyId: period.counterpartyId,
    documentNo: issued.documentNumber,
    issueDate: input.issueDate,
    dueDate,
    periodFrom: period.periodFrom,
    periodTo: period.periodTo,
    counterpartyName: counterparty.legalName,
    subtotalAmount: draft.subtotalAmount,
    taxAmount: draft.taxAmount,
    totalAmount: draft.totalAmount,
    isQualifiedInvoice,
    issuerSnapshot,
    counterpartySnapshot,
    payloadSha256,
    note: null,
    confirmedById: input.actorId,
    lines: draft.lines.map((line) => ({
      lineNo: line.lineNo,
      propertyId: line.propertyId,
      itemCode: line.itemCode,
      description: line.description,
      serviceDateFrom: line.serviceDateFrom,
      serviceDateTo: line.serviceDateTo,
      quantity: line.quantity,
      unit: line.unit,
      unitPrice: line.unitPrice,
      amount: line.amount,
      taxRate: line.taxRate,
      isReducedRate: line.isReducedRate,
      sourceRef: line.sourceRef,
    })),
    taxSummaries: draft.taxSummaries,
    sequence: {
      documentType: "INVOICE",
      fiscalYear: fiscalYearOf(input.issueDate, taxProfile.fiscalYearStartMonth),
      lastNumber: issued.sequence,
    },
  });

  // 締めの行から請求書を指す。**ここが二重発行の最後の砦**（§4.3）。
  await updateBillingPeriodStatus(env, ctx, period.id, { status: "INVOICED", invoiceId }, "INVOICED");

  // ⑦ PDF を Queue へ。**失敗しても巻き戻さない**（§4.1 MUST）。
  await enqueueInvoicePdf(env, ctx, { invoiceId, sealImageKey: taxProfile.sealImageKey });

  return { kind: "ISSUED", invoiceId, documentNo: issued.documentNumber, draft };
}

/**
 * PDF 生成をキューへ投げる（⑦ / §9 の `regenerate-pdf`）。
 *
 * **投入の失敗を呼び出し側へ伝播させない。** 請求書は既に確定して
 * おり、PDF は作り直せる（§4.1 MUST）。ここで例外を投げると、
 * 発行そのものが失敗したように見える。
 */
export async function enqueueInvoicePdf(
  env: Env,
  ctx: TenantContext,
  input: { invoiceId: string; sealImageKey: string | null },
): Promise<boolean> {
  const message: InvoicePdfMessage = {
    kind: "INVOICE_PDF",
    organizationId: ctx.organizationId,
    orgShortId: ctx.orgShortId,
    invoiceId: input.invoiceId,
    sealImageKey: input.sealImageKey,
    // **メッセージが時刻を持つ。** 再送で payload が変わらないようにする。
    requestedAtMs: ctx.now.getTime(),
  };
  try {
    await env.QUEUE_PDF_GENERATION.send(message);
    return true;
  } catch {
    console.error("invoice-pdf-enqueue-failed");
    return false;
  }
}

/**
 * 請求書が発行済みで、送付してよい状態かを確かめる（`resend` の入口）。
 *
 * **`VOIDED` を送らない。** 取り消した請求書を再送すると、取引先は
 * 生きている請求書だと読む（§5 の赤伝で別の文書が出ている）。
 */
export async function findSendableInvoice(env: Env, ctx: TenantContext, invoiceId: string) {
  const invoice = await findInvoiceById(env, ctx, invoiceId);
  if (invoice === undefined) return undefined;
  if (invoice.status === "VOIDED") return undefined;
  return invoice;
}

/** 締め日から「直近に締まった期間」を出す（画面が締めを起こすときに使う）。 */
export { closedPeriodAsOf };
