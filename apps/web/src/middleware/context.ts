/**
 * リクエスト文脈の型と取り出し口。
 *
 * task:  docs/tasks/P0-10.md
 * 仕様:  docs/PK-SPEC-P0.md §19.4
 *
 * ── 3 つの変数を optional で宣言している理由 ────────────
 * `session` / `tenant` は middleware が走るまで**本当に存在しない。**
 * Hono の `Variables` を必須で宣言すると `c.get("tenant")` が常に
 * `TenantContext` 型になり、**middleware を通していないルートでも
 * 型検査が通ってしまう。** 配線の誤りは実行時に `undefined` として現れ、
 * その時点では「テナントの絞り込みが無いクエリ」が既に組み上がっている。
 * optional にして、取り出しを下のヘルパへ強制する。
 */

import type { Env, TenantContext } from "@pk/db";
import type { Context } from "hono";

import type { SessionRecord } from "../lib/auth/session.js";

export interface AppVariables {
  /**
   * このリクエストの現在時刻。**`new Date()` を呼ぶのは session middleware だけ。**
   * 同一リクエスト内で時刻がずれると、監査ログと業務日の境界が食い違う。
   */
  now?: Date;
  /** KV から読んだセッション。識別情報のみ（DECISIONS #020）。 */
  session?: SessionRecord;
  /** 毎リクエスト組み立てたテナント文脈。リポジトリ関数へ渡す唯一の値。 */
  tenant?: TenantContext;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };

/**
 * 文脈が組み上がっていないまま参照されたことを表す。
 *
 * **これは利用者の誤りではなく配線の誤り**なので、404 でも 401 でもなく
 * 500 に写す（`resourceGuard.ts`）。コードは `:` を含めず、そのまま
 * ログの識別子として使える形にしてある。
 */
export class ContextMissingError extends Error {
  constructor(name: string) {
    super(`CONTEXT_MISSING_${name}`);
    this.name = "ContextMissingError";
  }
}

/** 現在時刻を取り出す。session middleware より後でのみ使える。 */
export function getNow(c: Context<AppEnv>): Date {
  const now = c.get("now");
  if (now === undefined) throw new ContextMissingError("NOW");
  return now;
}

/** セッションを取り出す。session middleware より後でのみ使える。 */
export function getSession(c: Context<AppEnv>): SessionRecord {
  const session = c.get("session");
  if (session === undefined) throw new ContextMissingError("SESSION");
  return session;
}

/**
 * テナント文脈を取り出す。tenant middleware より後でのみ使える。
 *
 * **API ハンドラはリポジトリ関数へこの値を渡す。** リクエストのボディ・
 * クエリ・パス変数から `organizationId` を組み立てないこと
 * （CLAUDE.md §4 / PK-SPEC-P0 §19.4 第1層）。
 */
export function getTenant(c: Context<AppEnv>): TenantContext {
  const tenant = c.get("tenant");
  if (tenant === undefined) throw new ContextMissingError("TENANT");
  return tenant;
}
