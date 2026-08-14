/**
 * tenant isolation: counterparty / pricing_rule / invoice / invoice_line /
 *                   invoice_tax_summary / receipt / document_delivery /
 *                   billing_period
 *
 * task:  docs/tasks/P5-01.md
 * ルール: .claude/rules/testing.md §2 / .claude/rules/billing.md §2
 *
 * **請求書が 1 通でも混ざれば、他社の売上が自社の帳簿に載る。** 差異
 * （P4）や観察（P3）より結果が直接的で、電子帳簿保存法の記録としても
 * 壊れる。第 3 パターン（同一シャードの組織ペア）が効いているのはここ。
 *
 * ── 施設スコープを掛けていない ──────────────────────────
 * 8 表とも `withOrganizationScope()` を使っている。請求は**組織の会計**で、
 * 施設スコープロール（`PROPERTY_MANAGER` など）が自分の施設ぶんだけ見る
 * ものではない（§6.4 の権限表も請求は `billing.read` で別に絞る）。
 * したがって第 4 パターン（施設スコープ）は成立しない。
 * **`propertyColumn: null` を明示する**（`organization.spec.ts` と同じ形。
 * 省略ではなく明示にしてあるのは、「書き忘れた」と区別するため）。
 */

import {
  findBillingPeriodById,
  findCounterpartyById,
  findDocumentDeliveryById,
  findInvoiceById,
  findPricingRuleById,
  findReceiptById,
  listBillingPeriods,
  listCounterparties,
  listDocumentDeliveries,
  listInvoiceLines,
  listInvoiceTaxSummaries,
  listInvoices,
  listPricingRules,
  listReceipts,
  type TenantContext,
} from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

/**
 * その文脈の組織に属する ID。**別組織の ID を渡すと第 2 層が先に落とす。**
 *
 * 理由は `occupancy.spec.ts` の同名関数と同じ。
 */
function ownId(ctx: TenantContext, prefix: string): string {
  return `${ctx.orgShortId}__${prefix}_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
}

describeTenantIsolation({
  table: "counterparty",
  list: (env, ctx) => listCounterparties(env, ctx),
  findById: (env, ctx, id) => findCounterpartyById(env, ctx, id),
  entityPrefix: "cp",
  propertyColumn: null,
});

describeTenantIsolation({
  table: "pricing_rule",
  list: (env, ctx) => listPricingRules(env, ctx, { counterpartyId: ownId(ctx, "cp") }),
  findById: (env, ctx, id) => findPricingRuleById(env, ctx, id),
  entityPrefix: "prc",
  propertyColumn: null,
});

describeTenantIsolation({
  table: "invoice",
  list: (env, ctx) => listInvoices(env, ctx, { counterpartyId: ownId(ctx, "cp") }),
  findById: (env, ctx, id) => findInvoiceById(env, ctx, id),
  entityPrefix: "inv",
  propertyColumn: null,
});

describeTenantIsolation({
  table: "invoice_line",
  list: (env, ctx) => listInvoiceLines(env, ctx, ownId(ctx, "inv")),
  entityPrefix: "invl",
  propertyColumn: null,
});

describeTenantIsolation({
  table: "invoice_tax_summary",
  list: (env, ctx) => listInvoiceTaxSummaries(env, ctx, ownId(ctx, "inv")),
  entityPrefix: "invt",
  propertyColumn: null,
});

describeTenantIsolation({
  table: "receipt",
  list: (env, ctx) => listReceipts(env, ctx, { counterpartyId: ownId(ctx, "cp") }),
  findById: (env, ctx, id) => findReceiptById(env, ctx, id),
  entityPrefix: "rcp",
  propertyColumn: null,
});

describeTenantIsolation({
  table: "document_delivery",
  list: (env, ctx) =>
    listDocumentDeliveries(env, ctx, { docType: "INVOICE", documentId: ownId(ctx, "inv") }),
  findById: (env, ctx, id) => findDocumentDeliveryById(env, ctx, id),
  entityPrefix: "dlv",
  propertyColumn: null,
});

describeTenantIsolation({
  table: "billing_period",
  list: (env, ctx) => listBillingPeriods(env, ctx, { counterpartyId: ownId(ctx, "cp") }),
  findById: (env, ctx, id) => findBillingPeriodById(env, ctx, id),
  entityPrefix: "bper",
  propertyColumn: null,
});
