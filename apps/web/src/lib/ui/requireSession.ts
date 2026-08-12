/**
 * 画面側の認証・テナント文脈の組み立て。
 *
 * task:  docs/tasks/P0-14.md
 * ルール: .claude/rules/security.md §1, §2 / .claude/rules/architecture.md §2
 * 決定:  docs/DECISIONS.md #020（セッションに認可情報を焼き込まない）
 *
 * ── middleware（API 側）と何が違うのか ──────────────────
 * 組み立てる `TenantContext` は同じで、**失敗したときの返し方だけが違う。**
 *
 *   API   … 401 の JSON（`middleware/session.ts` の `unauthenticated()`）
 *   画面  … `/login` へ 302
 *
 * 判定そのものは同じ関数（`readSession()` / `findMembershipByUserId()` /
 * `listAssignedPropertyIds()`）を通す。**画面側で緩い判定を作らないこと。**
 *
 * ── 毎リクエスト DB を引く ──────────────────────────────
 * `role` と `allowedPropertyIds` はセッションに入っていない（DECISIONS #020）。
 * 画面でもキャッシュしない。ロール降格・施設割当の解除が次のリクエストで効く。
 */

import {
  findMembershipByUserId,
  isOrgWideRole,
  listAssignedPropertyIds,
  NotFoundError,
  type Env,
  type ShardContext,
  type TenantContext,
} from "@pk/db";
import { redirect } from "react-router";

import { readSessionCookie } from "../auth/cookie.js";
import { readSession, type SessionRecord } from "../auth/session.js";

/** ログイン画面のパス。**ここ 1 か所で持つ。** */
export const LOGIN_PATH = "/login";

/** ログイン後に既定で開く画面。 */
export const HOME_PATH = "/app/dashboard";

/** 画面が必要とする文脈一式。 */
export interface AppContext {
  session: SessionRecord;
  tenant: TenantContext;
  /** 署名付き Cookie の値。施設の切替（セッションの書き換え）に要る。 */
  cookieValue: string;
}

/** `Cookie` ヘッダから署名付きセッション Cookie を取り出す。 */
function cookieValueOf(request: Request): string | null {
  return readSessionCookie(request.headers.get("Cookie"));
}

/**
 * ログイン画面へ戻す `Response`（302）を作る。
 *
 * 戻り先を `next` に載せる。**同一オリジンのパスだけを載せる**
 * （絶対 URL を素通しすると、ログイン後に外部サイトへ飛ばせる）。
 */
export function redirectToLogin(request: Request): Response {
  const url = new URL(request.url);
  const next = `${url.pathname}${url.search}`;
  // ログイン画面自身へ戻る `next` は意味が無い。
  if (next === LOGIN_PATH || next.startsWith(`${LOGIN_PATH}?`)) return redirect(LOGIN_PATH);
  return redirect(`${LOGIN_PATH}?next=${encodeURIComponent(next)}`);
}

/**
 * `next` として受け取った値を安全なパスへ正規化する。
 *
 * **`//host` や `https://…` を通さない。** 通すとログイン直後に
 * 外部サイトへ遷移させられる（オープンリダイレクト）。
 */
export function safeNextPath(next: string | null): string {
  if (next === null || next === "") return HOME_PATH;
  if (!next.startsWith("/")) return HOME_PATH;
  if (next.startsWith("//")) return HOME_PATH;
  return next;
}

/**
 * セッションがあれば返す。無ければ `null`。**リダイレクトしない。**
 *
 * ログイン画面が「すでに入っているか」を見るために使う。
 */
export async function readOptionalSession(
  env: Env,
  request: Request,
  now: Date,
): Promise<SessionRecord | null> {
  const cookieValue = cookieValueOf(request);
  if (cookieValue === null) return null;
  return readSession(env, cookieValue, now);
}

/**
 * 認証必須の画面で使う。文脈を組み立てられなければ `/login` へ 302 を **throw** する。
 *
 * loader / action の中から呼ぶこと。React Router は throw された `Response` を
 * そのまま応答として使う。
 */
export async function requireAppContext(
  env: Env,
  request: Request,
  now: Date,
): Promise<AppContext> {
  const cookieValue = cookieValueOf(request);
  if (cookieValue === null) throw redirectToLogin(request);

  const session = await readSession(env, cookieValue, now);
  if (session === null) throw redirectToLogin(request);

  const shardCtx: ShardContext = {
    organizationId: session.organizationId,
    orgShortId: session.orgShortId,
  };

  let membership;
  try {
    membership = await findMembershipByUserId(env, shardCtx, session.userId);
  } catch (error) {
    // セッションの中身が壊れている。資源の 404 ではなく、入り直せば直る失敗。
    if (error instanceof NotFoundError) throw redirectToLogin(request);
    throw error;
  }

  // 所属が無い / 無効化された / 作り直された（招待し直し等）。
  // middleware（`tenant.ts`）と同じ 3 条件。片方だけ緩めない。
  if (membership === undefined) throw redirectToLogin(request);
  if (!membership.isActive) throw redirectToLogin(request);
  if (membership.id !== session.membershipId) throw redirectToLogin(request);

  const allowedPropertyIds = isOrgWideRole(membership.role)
    ? []
    : await listAssignedPropertyIds(env, shardCtx, membership.id);

  const tenant: TenantContext = {
    organizationId: shardCtx.organizationId,
    orgShortId: shardCtx.orgShortId,
    role: membership.role,
    allowedPropertyIds,
    now,
  };

  return { session, tenant, cookieValue };
}
