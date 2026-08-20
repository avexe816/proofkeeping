/**
 * 運営画面の門（PF-01）。loader / action の最初に呼ぶ。
 *
 * task: docs/tasks/PF-01.md（完了条件「テナント用セッションで到達すると 404」）
 * 決定: docs/DECISIONS.md #220
 *
 * ── ログインへ送らず 404 を返す ──────────────────────────
 * テナント面の `requireSession()` は `/login?next=…` へ戻すが、運営面は
 * **404**（完了条件）。運営面が在ることを、持っていない相手に教えない。
 * 入口は `/plat/login` の 1 本だけで、**そこは門を通さない。**
 *
 * ── テナントの Cookie を読まない ────────────────────────
 * 読むのは `pk_plat_session` だけ。テナントのセッションしか持たない
 * 相手は「セッションが無い」と同じ扱いで 404 になる。**`pk_session` を
 * 見に行かない**のは #220 の分離そのもの（見た時点で運営面がテナント面の
 * 名前を知ることになる）。
 *
 * ── 毎リクエスト状態を引き直す ──────────────────────────
 * セッションに表示名も状態も焼き込まない（#020 と同じ向き）。
 * 無効化（`SUSPENDED`）は最長 12 時間待たずに効く。
 */

import { findPlatformOperatorById, type Env } from "@pk/db";

import { readPlatformSession, readPlatformSessionCookie } from "./session.js";

/** 画面に渡す運営担当者。**`passwordHash` を含めない。** */
export interface PlatformContext {
  operatorId: string;
  displayName: string;
  email: string;
}

/** 404。**理由を持たせない**（存在しないページと区別できないようにする）。 */
function notFound(): Response {
  return new Response(null, { status: 404 });
}

/**
 * 運営のセッションを要求する。無ければ 404 を投げる。
 *
 * @throws {Response} 404（セッションが無い・切れた・担当者が無効）
 */
export async function requirePlatformOperator(
  env: Env,
  request: Request,
  now: Date,
): Promise<PlatformContext> {
  const cookieValue = readPlatformSessionCookie(request.headers.get("Cookie"));
  const session = await readPlatformSession(env, cookieValue, now);
  if (session === null) throw notFound();

  const operator = await findPlatformOperatorById(env, session.operatorId);
  if (operator === null || operator.status !== "ACTIVE") throw notFound();

  return {
    operatorId: operator.id,
    displayName: operator.displayName,
    email: operator.email,
  };
}
