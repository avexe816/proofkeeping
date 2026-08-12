/**
 * ID の自己記述検証と、拒否の HTTP への一元写像。
 *
 * task:  docs/tasks/P0-10.md
 * 仕様:  docs/PK-SPEC-P0.md §19.4 第2層（「`withResourceGuard()` で一元化する」）
 * ルール: .claude/rules/architecture.md §1 / §2
 * 決定:  docs/DECISIONS.md #022
 *
 * ここには 3 つの部品がある。役割が違うので分けてある。
 *
 *   apiErrorHandler()   `app.onError()` へ渡す。`NotFoundError` → 404、
 *                       `PaymentRequiredError` → 402、他 → 500
 *   apiNotFoundHandler()`app.notFound()` へ渡す。未定義の経路も同じ 404 の形
 *   withResourceGuard() tenant の後。パス中の ID を DB 問い合わせ前に照合
 *
 * ── 例外を middleware で受け取れない ────────────────────
 * Hono は各ハンドラの呼び出しを内側で try/catch し、**`onError` を適用してから**
 * 上流の middleware へ戻る。`await next()` を try で囲んでも下流の例外は捕まらない
 * （素通りしたように見えて、既に 500 の応答に変わっている）。よって写像は
 * middleware ではなく `onError` に置く。`app.route()` で合成しても、
 * Hono が子アプリの `errorHandler` を保って包み直すため効き続ける。
 *
 * ── 403 を作らない ──────────────────────────────────────
 * 権限が無い・担当外施設・別テナントの ID は**すべて 404。**
 * 403 は資源の存在を示唆する（architecture.md §2 第2層 / INV-31）。
 * **このファイルに 403 を足さないこと。**
 */

import type { ApiErrorCode } from "@pk/contracts";
import { NotFoundError, PaymentRequiredError, assertIdBelongsToTenant } from "@pk/db";
import type { Context, ErrorHandler, MiddlewareHandler, NotFoundHandler } from "hono";

import { ContextMissingError, type AppEnv } from "./context.js";

/** 自己記述 ID の区切り（`{orgShortId}__{entityPrefix}_{ulid}`）。 */
const ID_SEPARATOR = "__";

/** 404 の応答。 */
function notFound(c: Context<AppEnv>): Response {
  const body: { error: ApiErrorCode } = { error: "RESOURCE_NOT_FOUND" };
  return c.json(body, 404);
}

/**
 * 402 の応答（P0-12）。**契約していないモジュールだけに使う。**
 *
 * どのモジュールが不足しているかを本体に載せない。購入導線は画面が
 * 組織の契約内容から組み立てる（`assertEntitlement()` の doc）。
 */
function paymentRequired(c: Context<AppEnv>): Response {
  const body: { error: ApiErrorCode } = { error: "PAYMENT_REQUIRED" };
  return c.json(body, 402);
}

/** 500 の応答。**内訳を載せない。** */
function internalError(c: Context<AppEnv>): Response {
  const body: { error: ApiErrorCode } = { error: "INTERNAL_ERROR" };
  return c.json(body, 500);
}

/**
 * ログに出してよい形へ落とす。
 *
 * `SHARD_BINDING_MISSING:SHARD_07` や `SHARD_MAP_INVALID:{organizationId}` は
 * **`:` の右にシャード番号や組織 ID を含む。** architecture.md §1 は
 * 「シャード番号を URL・レスポンス・**ログ**に露出しない」と定めるため、
 * 左側だけを残す。形が想定と違うものは中身ごと捨てる。
 *
 * Hono 既定のエラーハンドラは例外をそのまま `console.error` する。
 * **だから既定のままにせず、必ず `apiErrorHandler()` を登録する。**
 */
export function sanitizeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "UNEXPECTED_ERROR";
  const head = error.message.split(":")[0] ?? "";
  return /^[A-Z][A-Z0-9_]*$/.test(head) ? head : "UNEXPECTED_ERROR";
}

/**
 * `app.onError()` へ渡す写像。
 *
 * `NotFoundError` はテナント越境・権限の拒否・資源の不在のすべてで投げられる。
 * 呼び出し側がどれであったかを応答から区別できてはならないので、
 * ここで 1 種類の 404 に潰す。
 *
 * それ以外の例外は 500。**メッセージを応答にもログにも素通しさせない。**
 * Sentry への送出など、より丁寧な報告は P0-20 の責務。
 */
export function apiErrorHandler(): ErrorHandler<AppEnv> {
  return (error, c) => {
    // 順序に意味がある。**404 を先に見る。** 権限で拒否された資源に対して
    // 402 を返すと、契約状況を通じて資源の存在が読める（P0-12 / errors.ts）。
    if (error instanceof NotFoundError) return notFound(c);
    if (error instanceof PaymentRequiredError) return paymentRequired(c);
    console.error(sanitizeErrorCode(error));
    return internalError(c);
  };
}

/**
 * `app.notFound()` へ渡す写像。
 *
 * **定義されていない経路も、権限で拒否された経路と同じ応答にする。**
 * 片方が Hono 既定のテキスト 404、片方が JSON だと、その差だけで
 * 「その URL は実装されている」と分かってしまう。
 */
export function apiNotFoundHandler(): NotFoundHandler<AppEnv> {
  return (c) => notFound(c);
}

/**
 * パス中の ID がセッションの組織のものかを、**DB へ問い合わせる前に**照合する。
 *
 * ── ルート変数ではなくパスの区切りを見る理由 ────────────
 * `c.req.param()` は**マッチしたルート**に紐づく。`app.use("*")` で
 * 取り付けた middleware から呼ぶと、middleware 自身の経路（`*`）には
 * 変数が無いため空になる。ここで見落とすと第 2 層の前半が丸ごと効かない。
 * パスを `/` で割り、**自己記述 ID の形（`__` を含む）をした区切りすべて**を
 * 見る。ルート定義の書き方に依存しない。
 *
 * ── これで全部ではない ──────────────────────────────────
 * ここは早期に落とすための網であって、**唯一の防御ではない。**
 * リクエストボディやクエリに含まれる ID は見ていない。
 * リポジトリ関数側の `assertIdBelongsToTenant()` が二重に見ているので、
 * そちらを外さないこと（第 2 層は 2 か所で効く）。
 */
export function withResourceGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const tenant = c.get("tenant");
    // tenant middleware より前に置かれた配線の誤り。
    if (tenant === undefined) throw new ContextMissingError("TENANT");

    for (const segment of c.req.path.split("/")) {
      const decoded = decodeSegment(segment);
      if (decoded === null || !decoded.includes(ID_SEPARATOR)) continue;
      // 不一致なら NotFoundError。`onError` が 404 に写す。
      assertIdBelongsToTenant(decoded, tenant);
    }

    await next();
    return;
  };
}

/**
 * パスの区切りを復号する。壊れた百分率符号化は `null`（照合の対象外）。
 *
 * 復号してから見るのは、`%5F%5F` と書けば `__` の検査をすり抜けられるため。
 */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
