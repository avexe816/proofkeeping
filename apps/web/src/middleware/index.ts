/**
 * middleware の入口。**順序をここ 1 か所で固定する。**
 *
 * task: docs/tasks/P0-10.md
 * 仕様: docs/PK-SPEC-P0.md §19.4
 *
 * ── 順序が意味を持つ ────────────────────────────────────
 *   1. sessionMiddleware   Cookie → `SessionRecord`（無ければ 401 で打ち切り）
 *   2. tenantMiddleware    `SessionRecord` → `TenantContext`（毎リクエスト DB）
 *   3. withResourceGuard   パス中の ID を照合（`ctx.orgShortId` が要る）
 *
 * 3 が 2 より前だと `tenant` がまだ無い。個別のルートで順番を組み直さず、
 * 必ずこの関数を使うこと。
 *
 * 例外の写像（`onError`）は順序を持たず、アプリ単位で 1 つだけ有効になる。
 * **middleware では代用できない**理由は `resourceGuard.ts` の冒頭を読むこと。
 *
 * ── `notFound` はここで登録しない ───────────────────────
 * Hono は `app.route()` で合成するとき、子アプリの `errorHandler` は保つが
 * **`notFoundHandler` は引き継がない**（実測。親の既定が使われ、
 * `404 Not Found` というテキストが返る）。ここで登録しても、合成された
 * 瞬間に黙って効かなくなる。`apiNotFoundHandler()` は**最上位のアプリへ
 * 直接**登録すること（`apps/web/src/index.ts`）。
 */

import type { Hono } from "hono";

import type { AppEnv } from "./context.js";
import { apiErrorHandler, withResourceGuard } from "./resourceGuard.js";
import { sessionMiddleware } from "./session.js";
import { tenantMiddleware, type TenantDeps } from "./tenant.js";

export {
  ContextMissingError,
  getNow,
  getSession,
  getTenant,
  type AppEnv,
  type AppVariables,
} from "./context.js";
export {
  apiErrorHandler,
  apiNotFoundHandler,
  sanitizeErrorCode,
  withResourceGuard,
} from "./resourceGuard.js";
export { sessionMiddleware, unauthenticated } from "./session.js";
export { tenantMiddleware, type TenantDeps } from "./tenant.js";

/**
 * 認証を要求するアプリへ middleware を固定順で取り付ける。
 *
 * **認証 API（`/api/v1/auth`）へ付けないこと。** セッションを作る経路が
 * セッションを要求すると入口が無くなる。
 *
 * @param deps テスト専用。**本番経路で渡さない。**
 */
export function useTenantMiddleware(app: Hono<AppEnv>, deps?: TenantDeps): void {
  app.onError(apiErrorHandler());
  app.use("*", sessionMiddleware());
  app.use("*", deps === undefined ? tenantMiddleware() : tenantMiddleware(deps));
  app.use("*", withResourceGuard());
}
