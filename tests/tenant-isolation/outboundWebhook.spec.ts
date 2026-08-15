/**
 * tenant isolation: outbound_webhook
 *
 * task:  docs/tasks/P6-13.md
 * ルール: .claude/rules/testing.md §2
 *
 * ── この表が効く理由 ────────────────────────────────────
 * **他組織の行が 1 件混ざると、自社のイベントが他社のサーバーへ飛ぶ。**
 * 本文は ID までしか載せない（`consumers/outboundWebhook.ts`）が、
 * 「いつ請求書を出したか」「いつ差異が立ったか」はそれ自体が
 * 取引の情報で、外へ出てよいものではない。
 *
 * 逆向きも同じで、他社の宛先を自社の画面から無効化できると、
 * 動いている連携を止められる。
 *
 * ── 施設スコープが掛からない ────────────────────────────
 * `outbound_webhook` は `propertyId` 列を持たない（§6.4）。宛先は
 * 組織に 1 つ以上あり、施設で分けない。よって第 4 パターンは
 * `propertyColumn: null` として扱う。
 */

import { findOutboundWebhookById, listOutboundWebhooks } from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

describeTenantIsolation({
  table: "outbound_webhook",
  list: (env, ctx) => listOutboundWebhooks(env, ctx),
  findById: (env, ctx, id) => findOutboundWebhookById(env, ctx, id),
  entityPrefix: "owh",
  propertyColumn: null,
});
