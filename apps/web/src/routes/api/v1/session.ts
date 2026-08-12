import { switchPropertyRequestSchema, type ApiErrorCode, type AuthErrorCode } from "@pk/contracts";
import { Hono } from "hono";

import { readSessionCookie } from "../../../lib/auth/cookie.js";
import { switchProperty } from "../../../lib/property/selection.js";
import { getNow, getTenant, type AppEnv } from "../../../middleware/index.js";

/**
 * 表示中の施設の切り替え（PK-SPEC-P0 §23.4）。
 *
 *   POST /api/v1/auth/switch-property   { propertyId }
 *
 * task: docs/tasks/P0-14.md
 *
 * ── 画面と同じ関数を呼ぶ ────────────────────────────────
 * 判定の実体は `lib/property/selection.ts` の `switchProperty()`。
 * 画面（`routes/app/switchProperty.ts`）もこれを呼ぶ。**API と画面で
 * 別々の判定を書かない。**
 *
 * ── 応答 ────────────────────────────────────────────────
 *   200 `{ propertyId }`     切り替えた
 *   400 `INVALID_REQUEST`    入力の形が違う（`"ALL"` を含む — P0-21 まで）
 *   401                      セッションが無い（middleware が返す）
 *   404 `RESOURCE_NOT_FOUND` 担当外・別組織・無効化済み（`onError` が写像）
 *
 * **403 を返さない。** 担当外の施設に 403 を返すと、その施設が存在することを
 * 教えることになる（architecture.md §2 第 2 層）。
 *
 * ── Idempotency-Key を要求していない ────────────────────
 * CLAUDE.md §5 は状態変更 API に `Idempotency-Key` 対応を求めるが、
 * この操作は**同じ入力を何度送っても結果が同じ**（セッションの 1 フィールドを
 * その値にする）。採番も課金も伴わない。二重送信で壊れるものが無いため、
 * キーの記録という別の状態を増やさない。
 */
const session = new Hono<AppEnv>();

/**
 * 入力の形の誤りは `/login` と同じ `INVALID_REQUEST`（`AuthErrorCode`）で返す。
 * この経路は `/api/v1/auth/*` に属し、隣の認証 API と語彙を揃える。
 * middleware が返す共通コード（`UNAUTHENTICATED` など）は `ApiErrorCode`。
 */
function errorBody<T extends ApiErrorCode | AuthErrorCode>(code: T): { error: T } {
  return { error: code };
}

session.post("/switch-property", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = switchPropertyRequestSchema.safeParse(body);
  if (!parsed.success) return c.json(errorBody("INVALID_REQUEST"), 400);

  // middleware を通っているのでセッションは必ずある。Cookie の値そのものは
  // 文脈に載っていない（載せる必要があるのはこの経路だけ）ため読み直す。
  const cookieValue = readSessionCookie(c.req.header("Cookie") ?? null);
  if (cookieValue === null) return c.json(errorBody("UNAUTHENTICATED"), 401);

  const propertyId = await switchProperty(
    c.env,
    getTenant(c),
    cookieValue,
    parsed.data.propertyId,
    getNow(c),
  );

  return c.json({ propertyId });
});

export default session;
