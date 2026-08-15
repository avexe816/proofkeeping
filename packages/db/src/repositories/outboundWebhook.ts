/**
 * 送信 Webhook（`outboundWebhook`）のリポジトリ（PK-SPEC-P6 §6.4 / P6-13）。
 *
 * task: docs/tasks/P6-13.md
 * ルール: .claude/rules/security.md §7
 *
 * ── 署名鍵を返さない ────────────────────────────────────
 * 返すのは `secretRef`（`CREDENTIALS` KV の参照キー）まで。**復号は
 * `apps/web/src/lib/integration/credentials.ts` の仕事**で、この層は
 * KV を触らない（`integration.ts` と同じ / DECISIONS #138）。
 *
 * ── 無効化しても行を消さない ────────────────────────────
 * 5 回失敗した宛先は `isActive = false` になるが行は残る（§6.4 MUST）。
 * **どこへ何を送っていたかを事後に辿れる状態を保つ。**
 */

import { and, eq, sql } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { outboundWebhook, type OutboundWebhookEvent } from "../schema/integration.js";

import { NO_PROPERTY_SCOPE, withTenantScope } from "./base.js";

/** `createOutboundWebhook()` の入力。**署名鍵そのものを受け取らない。** */
export interface CreateOutboundWebhookInput {
  url: string;
  /** `CREDENTIALS` KV の参照キー。値そのものではない。 */
  secretRef: string;
  events: readonly OutboundWebhookEvent[];
}

/** 宛先を作る。**初期状態は有効。** */
export async function createOutboundWebhook(
  env: Env,
  ctx: TenantContext,
  input: CreateOutboundWebhookInput,
) {
  const db = await getTenantDb(env, ctx);
  const row = {
    id: generateId(ctx.orgShortId, "owh"),
    organizationId: ctx.organizationId,
    url: input.url,
    secretRef: input.secretRef,
    events: [...input.events],
    isActive: true,
    failureCount: 0,
    lastDeliveryAt: null,
    createdAt: ctx.now,
  };
  await db.insert(outboundWebhook).values(row);
  return row;
}

/** 宛先の一覧（管理画面）。**無効化したものも返す。** */
export async function listOutboundWebhooks(env: Env, ctx: TenantContext) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(outboundWebhook)
    .where(withTenantScope(outboundWebhook, ctx, NO_PROPERTY_SCOPE))
    .orderBy(outboundWebhook.createdAt, outboundWebhook.id);
}

/**
 * 配信対象の宛先（§6.4）。**有効なものだけ。**
 *
 * **イベントでの絞り込みをここで行わない。** `events` は JSON 列で、
 * SQLite の JSON 関数に頼ると索引が効かないうえ、`task.*` のような
 * 部分一致を書ける形になってしまう。**判定は `subscribesTo()`**
 * （`@pk/integrations`。完全一致だけ）で、呼び出し側が回す。
 * 1 組織の宛先は多くて数件なので、全件読んで絞って差し支えない。
 */
export async function listActiveOutboundWebhooks(env: Env, ctx: TenantContext) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(outboundWebhook)
    .where(
      withTenantScope(
        outboundWebhook,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(outboundWebhook.isActive, true),
      ),
    )
    .orderBy(outboundWebhook.createdAt, outboundWebhook.id);
}

/** 宛先 1 件。**無ければ `undefined`**（越境 ID は先に `NotFoundError`）。 */
export async function findOutboundWebhookById(
  env: Env,
  ctx: TenantContext,
  webhookId: string,
) {
  assertIdBelongsToTenant(webhookId, ctx);
  const db = await getTenantDb(env, ctx);
  const [row] = await db
    .select()
    .from(outboundWebhook)
    .where(
      withTenantScope(outboundWebhook, ctx, NO_PROPERTY_SCOPE, eq(outboundWebhook.id, webhookId)),
    )
    .limit(1);
  return row;
}

/**
 * 配信の成功を記録する。**失敗回数を 0 に戻す。**
 *
 * 戻さないと、断続的に失敗する宛先が数日で 5 回に達して止まる。
 * 数えているのは**連続**失敗（§6.4 の `failureCount` は
 * `integration.consecutiveFailures` と同じ性格）。
 */
export async function markOutboundDelivered(
  env: Env,
  ctx: TenantContext,
  webhookId: string,
): Promise<void> {
  assertIdBelongsToTenant(webhookId, ctx);
  const db = await getTenantDb(env, ctx);
  await db
    .update(outboundWebhook)
    .set({ failureCount: 0, lastDeliveryAt: ctx.now })
    .where(
      withTenantScope(outboundWebhook, ctx, NO_PROPERTY_SCOPE, eq(outboundWebhook.id, webhookId)),
    );
}

/**
 * 配信の失敗を数える。**`isActive` をここで動かさない。**
 *
 * 5 回で止める判断は `shouldDisableOutbound()`（`@pk/integrations`）で、
 * この関数は数えるところまで（`markIntegrationSynced()` と同じ分担）。
 *
 * 冪等ではない（呼ぶたびに数が動く）。**1 回の配信につき 1 回だけ呼ぶこと。**
 */
export async function markOutboundFailed(
  env: Env,
  ctx: TenantContext,
  webhookId: string,
): Promise<void> {
  assertIdBelongsToTenant(webhookId, ctx);
  const db = await getTenantDb(env, ctx);
  await db
    .update(outboundWebhook)
    .set({
      failureCount: sql`${outboundWebhook.failureCount} + 1`,
      lastDeliveryAt: ctx.now,
    })
    .where(
      withTenantScope(outboundWebhook, ctx, NO_PROPERTY_SCOPE, eq(outboundWebhook.id, webhookId)),
    );
}

/**
 * 宛先を無効化する（§6.4 MUST の「5 回失敗で無効化」）。**行は消さない。**
 *
 * **既に無効なものは触らない**（`and` の条件）。何度呼んでも
 * 「最初に止めた」状態が保たれる。
 */
export async function deactivateOutboundWebhook(
  env: Env,
  ctx: TenantContext,
  webhookId: string,
): Promise<void> {
  assertIdBelongsToTenant(webhookId, ctx);
  const db = await getTenantDb(env, ctx);
  await db
    .update(outboundWebhook)
    .set({ isActive: false })
    .where(
      withTenantScope(
        outboundWebhook,
        ctx,
        NO_PROPERTY_SCOPE,
        and(eq(outboundWebhook.id, webhookId), eq(outboundWebhook.isActive, true)),
      ),
    );
}

/**
 * 宛先を有効に戻す（人の操作）。**自動では戻さない。**
 *
 * 相手のサーバーが直ったかどうかはこちらから確かめられない。
 * `reactivateIntegration()` と同じ考え方（DECISIONS #145）。
 */
export async function reactivateOutboundWebhook(
  env: Env,
  ctx: TenantContext,
  webhookId: string,
): Promise<void> {
  assertIdBelongsToTenant(webhookId, ctx);
  const db = await getTenantDb(env, ctx);
  await db
    .update(outboundWebhook)
    .set({ isActive: true, failureCount: 0 })
    .where(
      withTenantScope(outboundWebhook, ctx, NO_PROPERTY_SCOPE, eq(outboundWebhook.id, webhookId)),
    );
}
