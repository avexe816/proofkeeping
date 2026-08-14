/**
 * 請求・領収のリポジトリ（PK-SPEC-P5 §2）。
 *
 * task:  docs/tasks/P5-01.md
 * ルール: .claude/rules/billing.md §1〜§6
 *
 * ── P5-01 は読み取りだけ ────────────────────────────────
 * この task はスキーマと越境テストが範囲。**発行・訂正・送付の書き込みは
 * P5-07 以降**（発行は §4.1 の 10 手順で、採番・スナップショット・
 * ハッシュ・Queue が絡む）。ここに `createInvoice()` を先回りして
 * 置かないこと。手順の一部だけが実装された状態が生まれる。
 *
 * 例外は取引先と料金設定（`upsertCounterparty()` / `insertPricingRule()`）で、
 * これはマスタなので P5-02 / P5-03 が使う。
 *
 * ── 消す関数を作らない（billing.md §2 / INV-30）─────────
 * `db.delete(invoice)` も `db.delete(receipt)` も書かない。
 * 発行済み帳票の物理削除は API・DB 権限の両方で禁止。
 * 訂正は赤伝（マイナス伝票）＋再発行（§5）。
 * `repositories.spec.ts` がソースを走査して固定する。
 *
 * ── 金額を書き換える関数を作らない ──────────────────────
 * `invoice` の更新は `status` と送付・入金の時刻まで。
 * **`totalAmount` / `subtotalAmount` / `taxAmount` を引数に取る更新関数を
 * 足さないこと。** 金額が変わるのは赤伝を切って作り直したとき。
 */

import { and, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { TAX_ROUNDING_MODES } from "../schema/organization.js";
import {
  billingPeriod,
  counterparty,
  documentDelivery,
  invoice,
  invoiceLine,
  invoiceTaxSummary,
  pricingRule,
  receipt,
  type BillingPeriodStatus,
  type DeliveryDocType,
  type InvoiceItemCode,
  type InvoiceStatus,
  type ReceiptStatus,
} from "../schema/invoice.js";

import { NO_PROPERTY_SCOPE, withTenantScope } from "./base.js";

// ────────────────────────────────────────────────────────────
// 取引先（§2.1）
// ────────────────────────────────────────────────────────────

/** `listCounterparties()` の絞り込み。 */
export interface CounterpartyFilter {
  /** 無効化済みを除くなら `true`。既定は全件。 */
  isActive?: boolean | undefined;
}

/**
 * 取引先の一覧。
 *
 * **施設スコープで絞らない。** 取引先は組織のマスタで `propertyId` を
 * 持たない（`pricingRule` が施設との対応を持つ）。`withTenantScope()` の
 * 第 3 引数に `NO_PROPERTY_SCOPE` を明示する。**省略できない形にしてある**
 * のは「施設で絞るべき表なのに書き忘れた」と区別するため（base.ts の注記）。
 *
 * 施設スコープロールが請求に**到達してよいか**は権限の問題で、
 * この層の責務ではない（`billing.read` / security.md §1）。
 */
export async function listCounterparties(
  env: Env,
  ctx: TenantContext,
  filter: CounterpartyFilter = {},
) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(counterparty)
    .where(
      withTenantScope(
        counterparty,
        ctx,
        NO_PROPERTY_SCOPE,
        filter.isActive === undefined ? undefined : eq(counterparty.isActive, filter.isActive),
      ),
    )
    .orderBy(counterparty.code);
}

/** 1 件。**越境 ID は DB へ行く前に `NotFoundError`（→ 404）。** */
export async function findCounterpartyById(env: Env, ctx: TenantContext, counterpartyId: string) {
  assertIdBelongsToTenant(counterpartyId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(counterparty)
    .where(withTenantScope(counterparty, ctx, NO_PROPERTY_SCOPE, eq(counterparty.id, counterpartyId)))
    .limit(1);
  return rows[0];
}

/** `upsertCounterparty()` の入力。**`code` が組織内で一意**（`uq_cp`）。 */
export interface UpsertCounterpartyInput {
  code: string;
  legalName: string;
  displayName: string | null;
  /** 適格請求書発行事業者の登録番号（billing.md §1）。未設定なら `null`。 */
  invoiceRegistrationNo: string | null;
  postalCode: string | null;
  address1: string | null;
  address2: string | null;
  department: string | null;
  contactName: string | null;
  billingEmail: string;
  ccEmails: string[];
  closingDay: number;
  paymentTermDays: number;
  taxRoundingMode: (typeof TAX_ROUNDING_MODES)[number];
  isActive: boolean;
}

/**
 * 取引先を作るか更新する（P5-02）。
 *
 * **物理削除しない。** 取引を終えた相手は `isActive = false`
 * （過去の請求書が参照している / PK-SPEC-P0 §24.4 と同じ方針）。
 *
 * @returns 作ったか更新したか。呼び出し側が監査ログの内容を決める。
 */
export async function upsertCounterparty(
  env: Env,
  ctx: TenantContext,
  input: UpsertCounterpartyInput,
): Promise<{ id: string; created: boolean }> {
  const db = await getTenantDb(env, ctx);

  const existing = await db
    .select({ id: counterparty.id })
    .from(counterparty)
    .where(
      and(eq(counterparty.organizationId, ctx.organizationId), eq(counterparty.code, input.code)),
    )
    .limit(1);

  const found = existing[0];
  if (found !== undefined) {
    await db
      .update(counterparty)
      .set({
        legalName: input.legalName,
        displayName: input.displayName,
        invoiceRegistrationNo: input.invoiceRegistrationNo,
        postalCode: input.postalCode,
        address1: input.address1,
        address2: input.address2,
        department: input.department,
        contactName: input.contactName,
        billingEmail: input.billingEmail,
        ccEmails: input.ccEmails,
        closingDay: input.closingDay,
        paymentTermDays: input.paymentTermDays,
        taxRoundingMode: input.taxRoundingMode,
        isActive: input.isActive,
        updatedAt: ctx.now,
      })
      .where(
        and(eq(counterparty.organizationId, ctx.organizationId), eq(counterparty.id, found.id)),
      );
    return { id: found.id, created: false };
  }

  const id = generateId(ctx.orgShortId, "cp");
  await db.insert(counterparty).values({
    id,
    organizationId: ctx.organizationId,
    ...input,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  return { id, created: true };
}

/**
 * `updateCounterparty()` の入力（P5-02）。
 *
 * **`code` を含めない。** 組織内で一意の鍵（`uq_cp`）で、料金設定と
 * 過去の締めがこの取引先を指している。付け替えは新しい取引先を作る操作。
 * `updateRoomType()` が `code` を受けないのと同じ理由。
 */
export type UpdateCounterpartyInput = {
  [K in keyof Omit<UpsertCounterpartyInput, "code">]?: UpsertCounterpartyInput[K] | undefined;
};

/**
 * 取引先を更新する（P5-02 / `PATCH /api/v1/counterparties/:id`）。
 *
 * **物理削除の口を作らない**（CLAUDE.md §4）。取引を終えた相手は
 * `isActive = false`。過去の請求書は `counterpartySnapshot` を持つので
 * 中身が変わっても壊れないが、行そのものは残す。
 *
 * @returns 更新した行があったか。無ければ呼び出し側が 404 を返す。
 */
export async function updateCounterparty(
  env: Env,
  ctx: TenantContext,
  counterpartyId: string,
  input: UpdateCounterpartyInput,
): Promise<boolean> {
  assertIdBelongsToTenant(counterpartyId, ctx);
  const db = await getTenantDb(env, ctx);

  const result = await db
    .update(counterparty)
    .set({ ...input, updatedAt: ctx.now })
    .where(
      and(
        eq(counterparty.organizationId, ctx.organizationId),
        eq(counterparty.id, counterpartyId),
      ),
    )
    .returning({ id: counterparty.id });

  return result.length > 0;
}

// ────────────────────────────────────────────────────────────
// 料金設定（§2.2）
// ────────────────────────────────────────────────────────────

/** `listPricingRules()` の絞り込み。 */
export interface PricingRuleFilter {
  counterpartyId?: string | undefined;
  propertyId?: string | undefined;
  itemCode?: InvoiceItemCode | undefined;
  /** この業務日に有効な行だけ（`validFrom <= date <= validTo`）。 */
  effectiveOn?: string | undefined;
}

/**
 * 料金設定の一覧（§2.2）。
 *
 * **畳まない。** どの行が勝つか（§3.2 の 5 段階）を決めるのは
 * `packages/billing` の純粋関数（P5-03 / P5-04）。ここで 1 件に絞ると、
 * 「該当が無い」のか「複数あって選んだ」のかが読めなくなる。
 *
 * **施設の次元は `filter.propertyId` で受ける。** `pricingRule.propertyId` は
 * `null`（取引先の全施設）を取りうる列で、`scopeToProperties()` を掛けると
 * その行が担当施設ロールから消える。`NO_PROPERTY_SCOPE` にしたうえで、
 * 呼び出し側が渡した施設で `IS NULL OR = ?` を組む。
 */
export async function listPricingRules(
  env: Env,
  ctx: TenantContext,
  filter: PricingRuleFilter = {},
) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(pricingRule)
    .where(
      withTenantScope(
        pricingRule,
        ctx,
        NO_PROPERTY_SCOPE,
        filter.counterpartyId === undefined
          ? undefined
          : eq(pricingRule.counterpartyId, filter.counterpartyId),
        filter.propertyId === undefined
          ? undefined
          : or(isNull(pricingRule.propertyId), eq(pricingRule.propertyId, filter.propertyId)),
        filter.itemCode === undefined ? undefined : eq(pricingRule.itemCode, filter.itemCode),
        filter.effectiveOn === undefined
          ? undefined
          : and(
              lte(pricingRule.validFrom, filter.effectiveOn),
              or(isNull(pricingRule.validTo), gte(pricingRule.validTo, filter.effectiveOn)),
            ),
      ),
    )
    // **`priority` は小さいほうが勝つ**（§3.2 / docs/DECISIONS.md #122）。
    // 一覧の先頭が「競合したときに採られる行」になるよう昇順にする。
    .orderBy(pricingRule.priority, desc(pricingRule.validFrom), pricingRule.id);
}

/** 1 件。**越境 ID は DB へ行く前に `NotFoundError`。** */
export async function findPricingRuleById(env: Env, ctx: TenantContext, pricingRuleId: string) {
  assertIdBelongsToTenant(pricingRuleId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(pricingRule)
    .where(withTenantScope(pricingRule, ctx, NO_PROPERTY_SCOPE, eq(pricingRule.id, pricingRuleId)))
    .limit(1);
  return rows[0];
}

/** `insertPricingRule()` の入力。 */
export interface InsertPricingRuleInput {
  counterpartyId: string;
  propertyId: string | null;
  roomTypeId: string | null;
  taskType: string | null;
  itemCode: InvoiceItemCode;
  unitPrice: number;
  taxRate: number;
  isReducedRate: boolean;
  validFrom: string;
  validTo: string | null;
  priority: number;
}

/**
 * 料金設定を 1 件足す（P5-03）。
 *
 * **更新する関数が無い。** §2.2 は `validFrom` / `validTo` を持つので、
 * **値上げは行の追加**で表す。既存の行を書き換えると、過去の請求書の
 * 根拠（当時いくらだったか）が変わる。終了するときは `validTo` を
 * 入れた新しい行ではなく、`closePricingRule()`（P5-03 が足す）で
 * 期間を閉じること。
 */
export async function insertPricingRule(
  env: Env,
  ctx: TenantContext,
  input: InsertPricingRuleInput,
): Promise<string> {
  assertIdBelongsToTenant(input.counterpartyId, ctx);
  if (input.propertyId !== null) assertIdBelongsToTenant(input.propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  const id = generateId(ctx.orgShortId, "prc");
  await db.insert(pricingRule).values({
    id,
    organizationId: ctx.organizationId,
    ...input,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  return id;
}

/**
 * 料金設定の適用期間を閉じる（P5-03 / `PATCH /api/v1/pricing-rules/:id`）。
 *
 * **`validTo` しか触らない。** 単価・税率・対象を書き換える口を作らない
 * （`insertPricingRule()` の注記）。値上げは行の追加で表し、古い行はここで
 * 閉じる。既存の行の単価を書き換えると、過去の請求書の根拠が変わる。
 *
 * `validTo` は**その日まで有効**（`isEffectiveOn()` が両端を含む）。
 *
 * @returns 更新した行があったか。無ければ呼び出し側が 404 を返す。
 */
export async function closePricingRule(
  env: Env,
  ctx: TenantContext,
  pricingRuleId: string,
  validTo: string,
): Promise<boolean> {
  assertIdBelongsToTenant(pricingRuleId, ctx);
  const db = await getTenantDb(env, ctx);

  const result = await db
    .update(pricingRule)
    .set({ validTo, updatedAt: ctx.now })
    .where(
      and(eq(pricingRule.organizationId, ctx.organizationId), eq(pricingRule.id, pricingRuleId)),
    )
    .returning({ id: pricingRule.id });

  return result.length > 0;
}

// ────────────────────────────────────────────────────────────
// 請求書（§2.3〜§2.5）— 読み取りのみ（発行は P5-07）
// ────────────────────────────────────────────────────────────

/**
 * `listInvoices()` の絞り込み。
 *
 * **電子帳簿保存法の検索 3 項目**（§1.2 MUST）が全部ここにある。
 * 取引年月日（`issueDateFrom` / `issueDateTo`）・取引金額
 * （`amountFrom` / `amountTo`）・取引先（`counterpartyId`）。
 * **この 3 つを外さないこと**（P5-11 の検索画面が使う）。
 */
export interface InvoiceFilter {
  counterpartyId?: string | undefined;
  status?: readonly InvoiceStatus[] | undefined;
  issueDateFrom?: string | undefined;
  issueDateTo?: string | undefined;
  amountFrom?: number | undefined;
  amountTo?: number | undefined;
  limit?: number | undefined;
}

/** 請求書の一覧。**発行日が新しい順。** */
export async function listInvoices(env: Env, ctx: TenantContext, filter: InvoiceFilter = {}) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(invoice)
    .where(
      withTenantScope(
        invoice,
        ctx,
        NO_PROPERTY_SCOPE,
        filter.counterpartyId === undefined
          ? undefined
          : eq(invoice.counterpartyId, filter.counterpartyId),
        filter.status === undefined ? undefined : inArray(invoice.status, [...filter.status]),
        filter.issueDateFrom === undefined
          ? undefined
          : gte(invoice.issueDate, filter.issueDateFrom),
        filter.issueDateTo === undefined ? undefined : lte(invoice.issueDate, filter.issueDateTo),
        filter.amountFrom === undefined ? undefined : gte(invoice.totalAmount, filter.amountFrom),
        filter.amountTo === undefined ? undefined : lte(invoice.totalAmount, filter.amountTo),
      ),
    )
    .orderBy(desc(invoice.issueDate), desc(invoice.documentNo))
    .limit(filter.limit ?? 200);
}

/** 1 件。**越境 ID は DB へ行く前に `NotFoundError`。** */
export async function findInvoiceById(env: Env, ctx: TenantContext, invoiceId: string) {
  assertIdBelongsToTenant(invoiceId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(invoice)
    .where(withTenantScope(invoice, ctx, NO_PROPERTY_SCOPE, eq(invoice.id, invoiceId)))
    .limit(1);
  return rows[0];
}

/** 明細（§2.4）。**行番号順。** */
export async function listInvoiceLines(env: Env, ctx: TenantContext, invoiceId: string) {
  assertIdBelongsToTenant(invoiceId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(invoiceLine)
    .where(withTenantScope(invoiceLine, ctx, NO_PROPERTY_SCOPE, eq(invoiceLine.invoiceId, invoiceId)))
    .orderBy(invoiceLine.lineNo);
}

/** 税区分サマリー（§2.5）。**税率ごとに 1 行。** */
export async function listInvoiceTaxSummaries(env: Env, ctx: TenantContext, invoiceId: string) {
  assertIdBelongsToTenant(invoiceId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(invoiceTaxSummary)
    .where(
      withTenantScope(invoiceTaxSummary, ctx, NO_PROPERTY_SCOPE, eq(invoiceTaxSummary.invoiceId, invoiceId)),
    )
    .orderBy(desc(invoiceTaxSummary.taxRate));
}

// ────────────────────────────────────────────────────────────
// 領収書（§2.6）— 読み取りのみ（発行は P5-08）
// ────────────────────────────────────────────────────────────

/** `listReceipts()` の絞り込み。**検索 3 項目は請求書と同じ。** */
export interface ReceiptFilter {
  counterpartyId?: string | undefined;
  invoiceId?: string | undefined;
  status?: readonly ReceiptStatus[] | undefined;
  issueDateFrom?: string | undefined;
  issueDateTo?: string | undefined;
  amountFrom?: number | undefined;
  amountTo?: number | undefined;
  limit?: number | undefined;
}

/** 領収書の一覧。**発行日が新しい順。** */
export async function listReceipts(env: Env, ctx: TenantContext, filter: ReceiptFilter = {}) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(receipt)
    .where(
      withTenantScope(
        receipt,
        ctx,
        NO_PROPERTY_SCOPE,
        filter.counterpartyId === undefined
          ? undefined
          : eq(receipt.counterpartyId, filter.counterpartyId),
        filter.invoiceId === undefined ? undefined : eq(receipt.invoiceId, filter.invoiceId),
        filter.status === undefined ? undefined : inArray(receipt.status, [...filter.status]),
        filter.issueDateFrom === undefined
          ? undefined
          : gte(receipt.issueDate, filter.issueDateFrom),
        filter.issueDateTo === undefined ? undefined : lte(receipt.issueDate, filter.issueDateTo),
        filter.amountFrom === undefined ? undefined : gte(receipt.totalAmount, filter.amountFrom),
        filter.amountTo === undefined ? undefined : lte(receipt.totalAmount, filter.amountTo),
      ),
    )
    .orderBy(desc(receipt.issueDate), desc(receipt.documentNo))
    .limit(filter.limit ?? 200);
}

/** 1 件。**越境 ID は DB へ行く前に `NotFoundError`。** */
export async function findReceiptById(env: Env, ctx: TenantContext, receiptId: string) {
  assertIdBelongsToTenant(receiptId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(receipt)
    .where(withTenantScope(receipt, ctx, NO_PROPERTY_SCOPE, eq(receipt.id, receiptId)))
    .limit(1);
  return rows[0];
}

// ────────────────────────────────────────────────────────────
// 送付ログ（§2.7）— 読み取りのみ（送付は P5-10）
// ────────────────────────────────────────────────────────────

/** 文書 1 通ぶんの送付履歴。**古い順**（送った順に読む）。 */
export async function listDocumentDeliveries(
  env: Env,
  ctx: TenantContext,
  filter: { docType: DeliveryDocType; documentId: string },
) {
  assertIdBelongsToTenant(filter.documentId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(documentDelivery)
    .where(
      withTenantScope(
        documentDelivery,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(documentDelivery.docType, filter.docType),
        eq(documentDelivery.documentId, filter.documentId),
      ),
    )
    .orderBy(documentDelivery.queuedAt, documentDelivery.id);
}

/** 1 件。**越境 ID は DB へ行く前に `NotFoundError`。** */
export async function findDocumentDeliveryById(env: Env, ctx: TenantContext, deliveryId: string) {
  assertIdBelongsToTenant(deliveryId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(documentDelivery)
    .where(withTenantScope(documentDelivery, ctx, NO_PROPERTY_SCOPE, eq(documentDelivery.id, deliveryId)))
    .limit(1);
  return rows[0];
}

// ────────────────────────────────────────────────────────────
// 月次締め（§2.8）— 読み取りのみ（締めは P5-05）
// ────────────────────────────────────────────────────────────

/** `listBillingPeriods()` の絞り込み。 */
export interface BillingPeriodFilter {
  counterpartyId?: string | undefined;
  status?: readonly BillingPeriodStatus[] | undefined;
  /** 期間の終わりがこの日以降。 */
  periodToFrom?: string | undefined;
  limit?: number | undefined;
}

/** 月次締めの一覧。**期間の新しい順。** */
export async function listBillingPeriods(
  env: Env,
  ctx: TenantContext,
  filter: BillingPeriodFilter = {},
) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(billingPeriod)
    .where(
      withTenantScope(
        billingPeriod,
        ctx,
        NO_PROPERTY_SCOPE,
        filter.counterpartyId === undefined
          ? undefined
          : eq(billingPeriod.counterpartyId, filter.counterpartyId),
        filter.status === undefined ? undefined : inArray(billingPeriod.status, [...filter.status]),
        filter.periodToFrom === undefined
          ? undefined
          : gte(billingPeriod.periodTo, filter.periodToFrom),
      ),
    )
    .orderBy(desc(billingPeriod.periodTo), billingPeriod.counterpartyId)
    .limit(filter.limit ?? 200);
}

/** 1 件。**越境 ID は DB へ行く前に `NotFoundError`。** */
export async function findBillingPeriodById(env: Env, ctx: TenantContext, periodId: string) {
  assertIdBelongsToTenant(periodId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(billingPeriod)
    .where(withTenantScope(billingPeriod, ctx, NO_PROPERTY_SCOPE, eq(billingPeriod.id, periodId)))
    .limit(1);
  return rows[0];
}

/**
 * 月次締めの行を用意する（P5-05 / §6.1 の `OPEN`）。**冪等。**
 *
 * 毎月 1 日 04:00 のバッチは、同じ月に 2 回走っても 2 行作ってはならない
 * （testing.md §4）。`uq_period`（組織 × 取引先 × 期間）で 1 行に定まる
 * ので、**既にあれば何もせず既存の ID を返す。**
 *
 * **状態を書き換えない。** 既に `REVIEWING` 以降へ進んでいる期間を
 * `OPEN` へ戻さない。進めるのは `updateBillingPeriodStatus()` の仕事で、
 * そちらが状態機械（`evaluateBillingPeriodTransition()`）を通す。
 */
export async function ensureBillingPeriod(
  env: Env,
  ctx: TenantContext,
  input: { counterpartyId: string; periodFrom: string; periodTo: string },
): Promise<{ id: string; created: boolean }> {
  assertIdBelongsToTenant(input.counterpartyId, ctx);
  const db = await getTenantDb(env, ctx);

  const existing = await db
    .select({ id: billingPeriod.id })
    .from(billingPeriod)
    .where(
      and(
        eq(billingPeriod.organizationId, ctx.organizationId),
        eq(billingPeriod.counterpartyId, input.counterpartyId),
        eq(billingPeriod.periodFrom, input.periodFrom),
        eq(billingPeriod.periodTo, input.periodTo),
      ),
    )
    .limit(1);

  const found = existing[0];
  if (found !== undefined) return { id: found.id, created: false };

  const id = generateId(ctx.orgShortId, "bper");
  await db.insert(billingPeriod).values({
    id,
    organizationId: ctx.organizationId,
    counterpartyId: input.counterpartyId,
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    status: "OPEN",
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  return { id, created: true };
}

/** `updateBillingPeriodStatus()` の入力。**状態と、その状態に伴う時刻だけ。** */
export interface UpdateBillingPeriodStatusInput {
  status: BillingPeriodStatus;
  /** 集計した時刻（`OPEN → REVIEWING`）。 */
  aggregatedAt?: Date | undefined;
  /** 合意した時刻（`REVIEWING → AGREED`）。差戻しでは `null` へ戻す。 */
  agreedAt?: Date | null | undefined;
  agreedByCounterparty?: boolean | undefined;
  /** 発行した請求書（`AGREED → INVOICED`）。P5-07 が渡す。 */
  invoiceId?: string | undefined;
}

/**
 * 月次締めの状態を進める（P5-05 / §6.1）。
 *
 * **遷移してよいかはここで判定しない。** `@pk/billing` の
 * `evaluateBillingPeriodTransition()` が決め、呼び出し側が通す。
 * リポジトリ層に状態機械を置くと、同じ判断が DB の近くと純粋関数の
 * 両方に生まれる（`cleaningTask.ts` の `evaluateTransition()` と同じ扱い）。
 *
 * **金額の列を持たない。** §2.8 に小計・税額の列は無く、金額は
 * 都度 `buildInvoiceDraft()` が出す（docs/DECISIONS.md #124）。
 * ここに合計を書き込む関数を足さないこと。
 *
 * @returns 更新した行数。0 なら別のリクエストが先に進めている。
 */
export async function updateBillingPeriodStatus(
  env: Env,
  ctx: TenantContext,
  periodId: string,
  input: UpdateBillingPeriodStatusInput,
  /** 楽観ロック。**この状態のときだけ進める。** 二重実行で 2 回進まない。 */
  expectedStatus: BillingPeriodStatus,
): Promise<number> {
  assertIdBelongsToTenant(periodId, ctx);
  if (input.invoiceId !== undefined) assertIdBelongsToTenant(input.invoiceId, ctx);
  const db = await getTenantDb(env, ctx);

  const result = await db
    .update(billingPeriod)
    .set({
      status: input.status,
      ...(input.aggregatedAt === undefined ? {} : { aggregatedAt: input.aggregatedAt }),
      ...(input.agreedAt === undefined ? {} : { agreedAt: input.agreedAt }),
      ...(input.agreedByCounterparty === undefined
        ? {}
        : { agreedByCounterparty: input.agreedByCounterparty }),
      ...(input.invoiceId === undefined ? {} : { invoiceId: input.invoiceId }),
      updatedAt: ctx.now,
    })
    .where(
      and(
        eq(billingPeriod.organizationId, ctx.organizationId),
        eq(billingPeriod.id, periodId),
        eq(billingPeriod.status, expectedStatus),
      ),
    );

  return result.meta.changes;
}
