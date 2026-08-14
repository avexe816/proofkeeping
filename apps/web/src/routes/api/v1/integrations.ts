/**
 * 連携の再接続（PK-SPEC-P6 §3.4 / P6-07）。
 *
 * ```
 * POST /api/v1/integrations/:integrationId/reconnect
 * ```
 *
 * task:  docs/tasks/P6-07.md
 * ルール: .claude/rules/security.md §1・§6
 *
 * ── なぜこの口だけ先に置くのか ──────────────────────────
 * §3.4 は「5 回連続失敗で `status = ERROR`、自動同期を停止」と
 * 「**手動で再接続テストに成功したら `ACTIVE` に戻る**」を対で定めている。
 * 前半だけを実装すると、**一度 `ERROR` になった連携が二度と戻らない。**
 * 開ける仕組みだけがあって閉じる仕組みが無い状態を残さないため、
 * 閉じる口をここへ置いた。
 *
 * ── 「再接続テスト」がまだ本当のテストではない ──────────
 * 本来は `adapter.testConnection()` を呼び、通ったら `ACTIVE` に戻す。
 * **登録済みのアダプタが 1 つも無い**（実接続する PMS が未確定 /
 * §11 の未決事項 1、P6-06 は人間待ち）。汎用 Webhook（`api-generic`）は
 * PUSH で、こちらから叩ける相手がそもそも居ない。
 *
 * そのため今この口が行うのは「人が意図して閉じた」ことの記録と状態の
 * 復帰まで。**自動では戻さない**という §3.4 の性質は保たれている。
 * アダプタが入ったら、`reactivateIntegration()` の手前に
 * `testConnection()` を挟むだけで本来の形になる
 * （docs/DECISIONS.md #145 / docs/OPEN_QUESTIONS.md #088）。
 *
 * ── W-13 のボタンはまだ無い ─────────────────────────────
 * 連携設定（§7.1）は P6-14。それまではこの口を直接叩く。
 */

import {
  findIntegrationById,
  reactivateIntegration,
  recordAudit,
  type IntegrationStatus,
} from "@pk/db";
import { Hono } from "hono";

import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const integrations = new Hono<AppEnv>();

/**
 * サーキットブレーカーを閉じる（§3.4）。
 *
 * **`SUSPENDED` は戻さない。** 利用者が明示的に止めた状態を、
 * 「エラーから復帰する」操作で動かさない。止めた本人が再開の操作を
 * するのが筋で、その口は W-13（P6-14）が持つ。
 */
integrations.post("/:integrationId/reconnect", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "integration.write", propertyTarget([]));

  const integrationId = c.req.param("integrationId");
  // **越境 ID は `findIntegrationById()` が `NotFoundError` を投げる**
  // （第 2 層 / 403 を返さない）。
  const integration = await findIntegrationById(c.env, ctx, integrationId);
  if (integration === undefined) return c.notFound();

  if (integration.status === "SUSPENDED") {
    return c.json({ error: "INTEGRATION_SUSPENDED" as const }, 409);
  }

  const before: IntegrationStatus = integration.status;
  await reactivateIntegration(c.env, ctx, integrationId);

  // security.md §6「組織設定の変更」。**自動同期を再開させる操作を残す。**
  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "integration.statusChanged",
    targetType: "integration",
    targetId: integrationId,
    ...(integration.propertyId === null ? {} : { propertyId: integration.propertyId }),
    before: { status: before, consecutiveFailures: integration.consecutiveFailures },
    after: { status: "ACTIVE", consecutiveFailures: 0 },
  });

  return c.json({ status: "ACTIVE" as const });
});

export default integrations;
