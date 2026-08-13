/**
 * 観察記録の事後修正（PK-SPEC-P3 §2.2 MUST / P3-07）。
 *
 * task:  docs/tasks/P3-07.md
 * ルール: .claude/rules/security.md §6（監査ログ）
 *
 * ── 3 つとも欠かせない ──────────────────────────────────
 *   ① `PROPERTY_MANAGER` 以上（`observation.amend`）
 *   ② 理由必須（契約の `observationAmendRequestSchema` が空文字を弾く）
 *   ③ 旧値が `observationRevision` に残る（`amendObservation()`）
 *
 * ── なぜ監査ログまで要るのか ────────────────────────────
 * 履歴（`observationRevision`）は「値がどう変わったか」で、監査ログは
 * 「誰がいつ何をしたか」。security.md §6 は「観察記録の事後修正」を
 * 監査対象に挙げており、`AUDIT_ACTIONS` の `observation.amended` は
 * **理由必須**として登録済み。P4 の照合が事後修正後の値を使う以上、
 * 値を動かせる操作の痕跡を 2 か所に残す。
 */

import type { ObservationAmendRequest } from "@pk/contracts";
import {
  amendObservation,
  findObservationById,
  listObservationRevisions,
  recordAudit,
  type Env,
  type TenantContext,
} from "@pk/db";

import { assertPermission, propertyTarget } from "../auth/permission.js";

import { toObservation } from "./record.js";

/** 事後修正の結果。**見つからない場合は呼び出し側が 404 にする。** */
export type AmendOutcome =
  | { kind: "AMENDED"; observation: ReturnType<typeof toObservation> }
  | { kind: "NOT_FOUND" };

/**
 * 観察記録を修正する。
 *
 * 施設は**資源から解決した値**を権限判定に使う（INV-32）。別組織・担当外の
 * ID は `findObservationById()` が 404 相当（`undefined`）を返す。
 */
export async function amendObservationUseCase(
  env: Env,
  ctx: TenantContext,
  input: {
    observationId: string;
    actorId: string;
    body: ObservationAmendRequest;
    ip?: string | undefined;
  },
): Promise<AmendOutcome> {
  const before = await findObservationById(env, ctx, input.observationId);
  if (before === undefined) return { kind: "NOT_FOUND" };

  assertPermission(ctx, "observation.amend", propertyTarget([before.propertyId]));

  const result = await amendObservation(env, ctx, {
    observationId: before.id,
    bedsUsed: input.body.bedsUsed,
    trashLevel: input.body.trashLevel,
    bathTowelUsed: input.body.bathTowelUsed,
    faceTowelUsed: input.body.faceTowelUsed,
    handTowelUsed: input.body.handTowelUsed,
    bathMatUsed: input.body.bathMatUsed,
    slippersUsed: input.body.slippersUsed,
    cupsUsed: input.body.cupsUsed,
    extraFutonUsed: input.body.extraFutonUsed,
    amenitiesUsed: input.body.amenitiesUsed,
    note: input.body.note ?? null,
    changedById: input.actorId,
    reason: input.body.reason,
  });
  if (!result.applied) return { kind: "NOT_FOUND" };

  const after = await findObservationById(env, ctx, before.id);
  if (after === undefined) return { kind: "NOT_FOUND" };
  const revisions = await listObservationRevisions(env, ctx, before.id);

  await recordAudit(env, ctx, {
    actorId: input.actorId,
    action: "observation.amended",
    targetType: "roomObservation",
    targetId: before.id,
    propertyId: before.propertyId,
    reason: input.body.reason,
    // **数だけを載せる。** 記録者・端末情報は監査の対象ではなく、
    // ここに写すと「誰の入力を誰が直したか」の一覧が作れてしまう
    // （security.md §5 の「個人単位の評価」に近づく）。
    before: countsOf(before),
    after: countsOf(after),
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  });

  return { kind: "AMENDED", observation: toObservation(after, revisions.length) };
}

/** 監査ログの `before` / `after` に載せる値。 */
function countsOf(row: NonNullable<Awaited<ReturnType<typeof findObservationById>>>): {
  [key: string]: unknown;
} {
  return {
    bedsUsed: row.bedsUsed,
    trashLevel: row.trashLevel,
    bathTowelUsed: row.bathTowelUsed,
    faceTowelUsed: row.faceTowelUsed,
    handTowelUsed: row.handTowelUsed,
    bathMatUsed: row.bathMatUsed,
    slippersUsed: row.slippersUsed,
    cupsUsed: row.cupsUsed,
    extraFutonUsed: row.extraFutonUsed,
    amenitiesUsed: row.amenitiesUsed,
    note: row.note,
  };
}
