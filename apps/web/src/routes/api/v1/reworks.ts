/**
 * 差戻し・再清掃の API（PK-SPEC-P2 §4.6 / §4.7 / §14.1）。
 *
 * ```
 * GET  /api/v1/reworks/:reworkCycleId
 * POST /api/v1/reworks/:reworkCycleId/start      再清掃を開始
 * POST /api/v1/reworks/:reworkCycleId/complete   再清掃を完了
 * POST /api/v1/reworks/:reworkCycleId/waive      免除（P_MANAGER 以上）
 * ```
 *
 * task: docs/tasks/P2-07.md
 *
 * ── 一覧の口を作らない ──────────────────────────────────
 * `GET /reworks?...` を置いていない。差戻しは**タスクから辿るもの**で、
 * M-02 の一覧に `REWORK` のタスクが出て、そこから 1 件に入る（§4.5 の
 * 「担当清掃者の M-02 上部へ差戻しタスクを優先表示」）。差戻しだけの
 * 一覧を作ると「差し戻された部屋の一覧」＝担当者ごとの差戻し件数を
 * 並べる画面へ育つ余地が出る（§1.3 / INV-07 が禁じる方向）。
 * 管理側の集計は §10.1 の rollup を使う。
 *
 * ── `Idempotency-Key` ───────────────────────────────────
 * §14.1 は「全状態変更 API に必須」。タスク側の遷移がヘッダの鍵を
 * `taskTimeLog` で弾き、差戻し側は `status = from` の条件で 1 回だけ通る。
 * **鍵の記録表を増やしていない**（DECISIONS #065 と同じ判断）。
 */

import {
  reworkActionRequestSchema,
  reworkWaiveRequestSchema,
  type ReworkDetailResponse,
  type ReworkError,
} from "@pk/contracts";
import { findReworkCycleById, findRoomById, findTaskById } from "@pk/db";
import { Hono, type Context } from "hono";

import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import { advanceReworkUseCase } from "../../../lib/rework/advance.js";
import { assertReworkVisible, listReworkItems, toRework } from "../../../lib/rework/detail.js";
import { getNow, getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const reworks = new Hono<AppEnv>();

/** 400。**文言を載せない。** 画面が i18n キーへ写す。 */
function invalidRequest(): ReworkError {
  return { error: "INVALID_REQUEST" };
}

/** 差戻し 1 件（M-12 が読む）。**差し戻された項目だけを添える**（§4.6）。 */
reworks.get("/:reworkCycleId", async (c) => {
  const ctx = getTenant(c);
  const row = await findReworkCycleById(c.env, ctx, c.req.param("reworkCycleId"));
  if (row === undefined) return c.notFound();

  const task = await findTaskById(c.env, ctx, row.taskId);
  if (task === undefined) return c.notFound();
  // 施設は**資源から解決した値**を使う（INV-32）。
  assertPermission(ctx, "rework.read", propertyTarget([task.propertyId]));
  // **`CLEANER` は自分の差戻しだけ**（§4.6）。他人のものは 404。
  assertReworkVisible(ctx, row, getSession(c).membershipId);

  const room = await findRoomById(c.env, ctx, task.roomId);
  const body: ReworkDetailResponse = {
    data: toRework(row, {
      businessDate: task.businessDate,
      roomNumber: room?.roomNumber ?? "",
    }),
    items: await listReworkItems(c.env, ctx, row, getNow(c)),
    taskStatus: task.status,
  };
  return c.json(body);
});

/** 再清掃の開始（§4.6）。**タスクを `IN_PROGRESS` へ動かす。** */
reworks.post("/:reworkCycleId/start", (c) => runAction(c, c.req.param("reworkCycleId"), "start"));

/** 再清掃の完了（§4.6）。**タスクは再度 `AWAITING_INSPECTION` へ。** */
reworks.post("/:reworkCycleId/complete", (c) =>
  runAction(c, c.req.param("reworkCycleId"), "complete"),
);

/**
 * 免除（§4.7）。**`PROPERTY_MANAGER` 以上。**
 *
 * 理由・関連する不具合報告・免除後の客室の扱いを 3 つとも要求する。
 * 形式が足りなければ 400、業務上の必須が欠けていれば 409
 * （`REASON_REQUIRED` / `ISSUE_REPORT_REQUIRED`）。
 */
reworks.post("/:reworkCycleId/waive", async (c) => {
  const body = reworkWaiveRequestSchema.safeParse(await readJson(c.req.raw));
  if (!body.success) return c.json(invalidRequest(), 400);

  const outcome = await advanceReworkUseCase(c.env, getTenant(c), {
    reworkCycleId: c.req.param("reworkCycleId"),
    action: "waive",
    actorId: getSession(c).membershipId,
    waive: {
      reason: body.data.reason,
      issueReportId: body.data.issueReportId,
      roomOutcome: body.data.roomOutcome,
    },
    ...(body.data.clientTs === undefined ? {} : { clientTs: body.data.clientTs }),
    ...requestMeta(c),
  });

  if (outcome.kind === "REJECTED") {
    return c.json({ error: outcome.error } satisfies ReworkError, 409);
  }
  return c.json(outcome.body);
});

/**
 * 開始・完了の共通処理。**本体は `clientTs` だけ。**
 *
 * `reworkCycleId` を引数で受けているのは、`Context<AppEnv>`（経路の型を
 * 持たない形）だと `c.req.param()` が `string | undefined` になるため。
 * 経路側で取り出して渡す。
 */
async function runAction(
  c: Context<AppEnv>,
  reworkCycleId: string,
  action: "start" | "complete",
): Promise<Response> {
  const body = reworkActionRequestSchema.safeParse((await readJson(c.req.raw)) ?? {});
  if (!body.success) return c.json(invalidRequest(), 400);

  const outcome = await advanceReworkUseCase(c.env, getTenant(c), {
    reworkCycleId,
    action,
    actorId: getSession(c).membershipId,
    ...(body.data.clientTs === undefined ? {} : { clientTs: body.data.clientTs }),
    ...requestMeta(c),
  });

  if (outcome.kind === "REJECTED") {
    return c.json({ error: outcome.error } satisfies ReworkError, 409);
  }
  return c.json(outcome.body);
}

/** `Idempotency-Key`（§14.1）と発信元 IP。**無いキーを `undefined` のまま渡す。** */
function requestMeta(c: Context<AppEnv>): { idempotencyKey?: string; ip?: string } {
  const key = c.req.header("Idempotency-Key");
  const ip = c.req.header("CF-Connecting-IP");
  return {
    ...(key === undefined ? {} : { idempotencyKey: key }),
    ...(ip === undefined ? {} : { ip }),
  };
}

/** JSON を読む。**壊れていたら `null`。** 例外を 500 にしない。 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default reworks;
