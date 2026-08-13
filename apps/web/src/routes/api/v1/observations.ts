/**
 * 観察記録の API（PK-SPEC-P3 §7）。**タスクに紐づかない 2 本だけ。**
 *
 * ```
 * GET   /api/v1/observations?propertyId=&from=&to=   一覧（W-19）
 * PATCH /api/v1/observations/:observationId          事後修正（理由必須）
 * ```
 *
 * task: docs/tasks/P3-07.md
 *
 * ── 記録そのものはタスク側にある ────────────────────────
 * `PUT /tasks/:id/observation` と `POST /tasks/:id/observation/skip` は
 * `routes/api/v1/tasks.ts`。§7 の経路をそのまま写している。
 *
 * ── 削除の口が無い ──────────────────────────────────────
 * `DELETE` を作らない。観察は P4 の照合の土台で、消えると差異の根拠が
 * 無くなる（§0.1）。訂正は `PATCH`（旧値が `observationRevision` に残る）。
 *
 * ── オフラインに載せない ────────────────────────────────
 * §8 の表は `PATCH /observations/:id` を「×（管理操作）」としている。
 * 画面（W-19）は通常の fetch で送る。**キューに積まないこと。**
 */

import {
  observationAmendRequestSchema,
  type ObservationError,
  type ObservationListResponse,
} from "@pk/contracts";
import { listObservationRevisions, listObservations } from "@pk/db";
import { Hono } from "hono";

import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import { amendObservationUseCase } from "../../../lib/observation/amend.js";
import { toObservation } from "../../../lib/observation/record.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const observations = new Hono<AppEnv>();

/** 400。**文言を載せない。** 画面が i18n キーへ写す。 */
function invalidRequest(): ObservationError {
  return { error: "INVALID_REQUEST" };
}

/**
 * 一覧（W-19 / §6.1）。
 *
 * **担当者で絞るクエリを受け付けない。** 「誰の観察記録か」で並べる画面は
 * 個人の比較になる（security.md §5 / INV-07）。施設と業務日でだけ引く。
 */
observations.get("/", async (c) => {
  const ctx = getTenant(c);
  const propertyId = c.req.query("propertyId");
  const from = c.req.query("from");
  const to = c.req.query("to");

  for (const value of [from, to]) {
    if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return c.json(invalidRequest(), 400);
    }
  }

  assertPermission(
    ctx,
    "observation.read",
    propertyId === undefined
      ? propertyTarget(ctx.allowedPropertyIds)
      : propertyTarget([propertyId]),
  );

  const rows = await listObservations(c.env, ctx, { propertyId, from, to });
  const body: ObservationListResponse = {
    data: await Promise.all(
      rows.map(async (row) =>
        toObservation(row, (await listObservationRevisions(c.env, ctx, row.id)).length),
      ),
    ),
  };
  return c.json(body);
});

/**
 * 事後修正（§2.2 MUST / P3-07）。**`PROPERTY_MANAGER` 以上・理由必須。**
 *
 * 理由が空・形式が違えば 400。権限が無い・別組織・担当外は 404
 * （`assertPermission()` が `NotFoundError` を投げる / INV-31）。
 */
observations.patch("/:observationId", async (c) => {
  const body = observationAmendRequestSchema.safeParse(await readJson(c.req.raw));
  if (!body.success) return c.json(invalidRequest(), 400);

  const outcome = await amendObservationUseCase(c.env, getTenant(c), {
    observationId: c.req.param("observationId"),
    actorId: getSession(c).membershipId,
    body: body.data,
    ip: c.req.header("CF-Connecting-IP"),
  });
  if (outcome.kind === "NOT_FOUND") return c.notFound();

  return c.json({ data: outcome.observation, unchanged: false });
});

/** JSON を読む。**壊れていたら `null`。** 例外を 500 にしない。 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default observations;
