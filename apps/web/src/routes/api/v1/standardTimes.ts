/**
 * 標準時間マスタの API（W-17 / PK-SPEC-P1 §3.1・§10.1）。
 *
 * ```
 * GET /api/v1/standard-times?propertyId=
 * PUT /api/v1/standard-times
 * ```
 *
 * task: docs/tasks/P1-02.md
 *
 * ── 既定分数との関係 ────────────────────────────────────
 * §3.1 の既定分数（アウト清掃 40 分・滞在清掃 20 分…）は
 * `packages/engine` の定数。**ここで設定された値が優先される。**
 * 設定が無い組み合わせは既定分数のまま動く（設定を必須にしない）。
 */

import {
  standardTimeUpsertRequestSchema,
  type StandardTimeListResponse,
  type TaskError,
} from "@pk/contracts";
import { listStandardTimes, recordAudit, upsertStandardTimes } from "@pk/db";
import { Hono } from "hono";

import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const standardTimes = new Hono<AppEnv>();

function invalidRequest(): TaskError {
  return { error: "INVALID_REQUEST" };
}

standardTimes.get("/", async (c) => {
  const ctx = getTenant(c);
  const propertyId = c.req.query("propertyId");
  if (propertyId === undefined) return c.json(invalidRequest(), 400);

  assertPermission(ctx, "standardTime.read", propertyTarget([propertyId]));

  const rows = await listStandardTimes(c.env, ctx, propertyId);
  const body: StandardTimeListResponse = {
    propertyId,
    data: rows.map((row) => ({
      roomTypeId: row.roomTypeId,
      taskType: row.taskType,
      minutes: row.minutes,
    })),
  };
  return c.json(body);
});

/**
 * まとめて設定する。
 *
 * **マスタの変更なので監査ログを残す**（security.md §6 の
 * 「施設・客室マスタの作成・更新」に相当する。標準時間は請求の根拠
 * （P5 の 1 室あたり原価）に効く）。
 */
standardTimes.put("/", async (c) => {
  const body = standardTimeUpsertRequestSchema.safeParse(await readJson(c.req.raw));
  if (!body.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "standardTime.write", propertyTarget([body.data.propertyId]));

  const before = await listStandardTimes(c.env, ctx, body.data.propertyId);
  const applied = await upsertStandardTimes(
    c.env,
    ctx,
    body.data.propertyId,
    body.data.entries,
  );

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    // 施設に紐づくマスタの更新。`property.updated` を使う
    // （`AUDIT_ACTIONS` は閉じたレジストリで、標準時間専用の行は
    //  security.md §6 に根拠が無いため足していない）。
    action: "property.updated",
    targetType: "standardTime",
    targetId: body.data.propertyId,
    propertyId: body.data.propertyId,
    before: before.map((row) => ({
      roomTypeId: row.roomTypeId,
      taskType: row.taskType,
      minutes: row.minutes,
    })),
    after: body.data.entries,
    ...(c.req.header("CF-Connecting-IP") === undefined
      ? {}
      : { ip: c.req.header("CF-Connecting-IP") }),
  });

  return c.json({ propertyId: body.data.propertyId, applied });
});

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default standardTimes;
