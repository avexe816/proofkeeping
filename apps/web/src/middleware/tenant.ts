/**
 * テナント middleware。`SessionRecord` から `TenantContext` を組み立てる。
 *
 * task:  docs/tasks/P0-10.md
 * ルール: .claude/rules/architecture.md §2 第1層 / .claude/rules/security.md §1
 * 決定:  docs/DECISIONS.md #016（文脈を 2 段に分ける）/ #020（焼き込まない）
 *
 * ── 毎リクエスト DB を引く ──────────────────────────────
 * `role` と `allowedPropertyIds` をセッションに焼き込まない（DECISIONS #020）。
 * 焼き込むと、ロール降格・施設割当の解除が最長 12 時間（現場系は 16 時間）
 * 反映されず、その間ずっと権限が広い側に残る。**キャッシュも入れない。**
 * 入れるなら「解除が即時に効く」ことを別の仕組みで保証してからにすること。
 *
 * ── 組織 ID はセッションからしか来ない ──────────────────
 * リクエストのボディ・クエリ・パス変数から `organizationId` を採らない
 * （CLAUDE.md §4 / PK-SPEC-P0 §19.4）。この middleware が唯一の供給源。
 *
 * ── 文脈が作れないときは 401 ────────────────────────────
 * 所属が無い・無効・セッションと食い違う場合は 404 ではなく 401。
 * 「資源が無い」のではなく「誰として扱えばよいか決まらない」状態であり、
 * 入り直せば直る種類の失敗だから。現場で復帰操作を選べるようにする。
 */

import {
  NotFoundError,
  findMembershipByUserId,
  isOrgWideRole,
  listAssignedPropertyIds,
  type Env,
  type ShardContext,
  type TenantContext,
} from "@pk/db";
import type { MiddlewareHandler } from "hono";

import { ContextMissingError, type AppEnv } from "./context.js";
import { unauthenticated } from "./session.js";

/**
 * DB への 2 つの入口。**テストで差し替えるためだけに注入できる。**
 * 本番経路で渡さないこと（`createSession` の `randomBytes` と同じ扱い）。
 */
export interface TenantDeps {
  findMembershipByUserId: (
    env: Env,
    ctx: ShardContext,
    userId: string,
  ) => Promise<
    | {
        id: string;
        role: TenantContext["role"];
        isActive: boolean;
        /** 発注元ロールの取引先（P5-16）。他ロールは null。 */
        counterpartyId?: string | null;
      }
    | undefined
  >;
  listAssignedPropertyIds: (env: Env, ctx: ShardContext, membershipId: string) => Promise<string[]>;
}

const DEFAULT_DEPS: TenantDeps = { findMembershipByUserId, listAssignedPropertyIds };

/** `findMembershipByUserId()` が返す最小の形。 */
type MembershipRow = Awaited<ReturnType<TenantDeps["findMembershipByUserId"]>>;

/**
 * `TenantContext` を組み立てて文脈に載せる。
 *
 * 手順:
 *   1. セッションから `organizationId` / `orgShortId` / `userId` を取る
 *   2. `membership` を引き、有効でセッションと一致することを確かめる
 *   3. 施設スコープロールなら `property_assignment` から担当施設を引く
 *   4. `TenantContext` を文脈へ
 */
export function tenantMiddleware(deps: TenantDeps = DEFAULT_DEPS): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = c.get("session");
    const now = c.get("now");
    // session middleware より前に置かれた配線の誤り。利用者の誤りではない。
    if (session === undefined) throw new ContextMissingError("SESSION");
    if (now === undefined) throw new ContextMissingError("NOW");

    const shardCtx: ShardContext = {
      organizationId: session.organizationId,
      orgShortId: session.orgShortId,
    };

    let membership: MembershipRow;
    try {
      membership = await deps.findMembershipByUserId(c.env, shardCtx, session.userId);
    } catch (error) {
      // `assertIdBelongsToTenant()` が投げる。セッションの中身が壊れている
      // ということなので、資源の 404 ではなく文脈が作れない 401 として扱う。
      // 署名鍵なしにこの状態は作れないため、通常は到達しない。
      if (error instanceof NotFoundError) return unauthenticated(c);
      throw error;
    }

    if (membership === undefined) return unauthenticated(c);
    // 無効化された所属。ログイン済みでも、その場で通さない。
    if (!membership.isActive) return unauthenticated(c);
    // 所属が作り直された（招待し直し等）。古いセッションを使い回させない。
    if (membership.id !== session.membershipId) return unauthenticated(c);

    // 組織全体ロールは `scopeToProperties()` がこの値を参照しない。
    // 引かないぶん D1 の往復が 1 回減る。**空配列は「全施設」ではない**ので、
    // 施設スコープロールで同じ短絡をしてはならない。
    const allowedPropertyIds = isOrgWideRole(membership.role)
      ? []
      : await deps.listAssignedPropertyIds(c.env, shardCtx, membership.id);

    const tenant: TenantContext = {
      organizationId: shardCtx.organizationId,
      orgShortId: shardCtx.orgShortId,
      role: membership.role,
      allowedPropertyIds,
      // 発注元ロールだけが取引先スコープを持つ（P5-16）。他ロールで
      // `counterpartyId` が残っていても載せない（絞りの根拠は role が持つ）。
      counterpartyId:
        membership.role === "CLIENT_VIEWER" ? (membership.counterpartyId ?? null) : null,
      now,
    };
    c.set("tenant", tenant);

    await next();
    return;
  };
}
