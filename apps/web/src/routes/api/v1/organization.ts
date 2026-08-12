/**
 * 組織設定の API（PK-SPEC-P1 §19.4）。
 *
 * ```
 * GET   /api/v1/organization/settings
 * PATCH /api/v1/organization/settings
 * ```
 *
 * task: docs/tasks/P1-22.md
 *
 * ── 1 項目しか置いていない ──────────────────────────────
 * 施設選択画面を挟む閾値（2〜10）だけ。**組織設定の画面（管理画面側）は
 * P1 のどの task にも無い**ので、名称・タイムゾーン・既定言語を
 * 変更する経路は作っていない。足すのはその画面を作る task。
 *
 * ── 監査ログ ────────────────────────────────────────────
 * security.md §6「組織設定・税務プロファイルの変更」。
 * **`before` / `after` を残す。** 現場の起動時の挙動が変わる設定なので、
 * 「いつ誰が変えたか」が分からないと、選択画面が出なくなった理由を追えない。
 */

import {
  organizationSettingsUpdateSchema,
  type OrganizationSettingsResponse,
  type TaskError,
} from "@pk/contracts";
import { findOrganization, recordAudit, updateOrganizationSettings } from "@pk/db";
import { Hono } from "hono";

import { ORGANIZATION_TARGET, assertPermission } from "../../../lib/auth/permission.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const organization = new Hono<AppEnv>();

/** 400。**文言を載せない。** 画面が i18n キーへ写す。 */
function invalidRequest(): TaskError {
  return { error: "INVALID_REQUEST" };
}

organization.get("/settings", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "organization.read", ORGANIZATION_TARGET);

  const row = await findOrganization(c.env, ctx);
  if (row === undefined) return c.notFound();

  const body: OrganizationSettingsResponse = {
    data: { propertySelectionThreshold: row.propertySelectionThreshold },
  };
  return c.json(body);
});

/**
 * 閾値の変更。**`OWNER` / `ORG_ADMIN` のみ**（`organization.write`）。
 *
 * 範囲外（2 未満・10 超）は 400。**丸めない。** 3 を送ったつもりが
 * 11 になっていた場合に、黙って 10 として保存すると気づけない。
 */
organization.patch("/settings", async (c) => {
  const parsed = organizationSettingsUpdateSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "organization.write", ORGANIZATION_TARGET);

  const before = await findOrganization(c.env, ctx);
  if (before === undefined) return c.notFound();

  await updateOrganizationSettings(c.env, ctx, {
    propertySelectionThreshold: parsed.data.propertySelectionThreshold,
  });

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "organization.updated",
    targetType: "organization",
    targetId: ctx.organizationId,
    before: { propertySelectionThreshold: before.propertySelectionThreshold },
    after: { propertySelectionThreshold: parsed.data.propertySelectionThreshold },
    ...(c.req.header("CF-Connecting-IP") === undefined
      ? {}
      : { ip: c.req.header("CF-Connecting-IP") }),
  });

  const body: OrganizationSettingsResponse = {
    data: { propertySelectionThreshold: parsed.data.propertySelectionThreshold },
  };
  return c.json(body);
});

/** JSON を読む。**壊れていたら `null`。** 例外を 500 にしない。 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default organization;
