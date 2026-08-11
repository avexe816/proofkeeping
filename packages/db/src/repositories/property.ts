/**
 * 施設のリポジトリ。
 *
 * task: docs/tasks/P0-07.md
 * ルール: .claude/rules/architecture.md §2 / .claude/rules/security.md §1
 *
 * ── 施設スコープの絞り込み列 ────────────────────────────
 * この表だけは `property.id` で絞る（他の表は `propertyId`）。
 * 施設スコープロール（PROPERTY_MANAGER / INSPECTOR / CLEANER / VENDOR_ADMIN）は
 * `ctx.allowedPropertyIds` に無い施設を**一覧でも単体でも取得できない。**
 */

import { eq } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { property } from "../schema/property.js";

import { withTenantScope } from "./base.js";

/** `listProperties()` の絞り込み。 */
export interface PropertyFilter {
  /** 無効化済みを除くなら `true`。既定は全件。 */
  isActive?: boolean | undefined;
}

/** 施設一覧。施設スコープロールには担当施設だけが返る。 */
export async function listProperties(env: Env, ctx: TenantContext, filter: PropertyFilter = {}) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(property)
    .where(
      withTenantScope(
        property,
        ctx,
        property.id,
        filter.isActive === undefined ? undefined : eq(property.isActive, filter.isActive),
      ),
    );
}

/**
 * 施設 1 件。
 *
 * 越境 ID は DB へ行く前に `NotFoundError`。担当外の施設 ID（同一組織）は
 * 条件に一致せず 0 件になる。**どちらも 404 に写像すること。**
 * 403 を返すとリソースの存在を示唆する（architecture.md §2 第 2 層）。
 */
export async function findPropertyById(env: Env, ctx: TenantContext, propertyId: string) {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(property)
    .where(withTenantScope(property, ctx, property.id, eq(property.id, propertyId)))
    .limit(1);
  return rows[0];
}

/**
 * 施設コードから 1 件。清掃スタッフのログイン（P0-09）が施設コードを使う。
 *
 * `code` は組織内で unique（`uq_property_org_code`）。
 */
export async function findPropertyByCode(env: Env, ctx: TenantContext, code: string) {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(property)
    .where(withTenantScope(property, ctx, property.id, eq(property.code, code)))
    .limit(1);
  return rows[0];
}

/** `createProperty()` の入力。ID・組織・時刻はここでは受け取らない。 */
export interface CreatePropertyInput {
  code: string;
  name: string;
  postalCode?: string | undefined;
  address?: string | undefined;
  /** 未指定なら列の既定（Asia/Tokyo）。 */
  timezone?: string | undefined;
  /** 日締め時刻 `HH:MM`。未指定なら列の既定（05:00 / architecture.md §7）。 */
  dayCutoffTime?: string | undefined;
  sortOrder?: number | undefined;
}

/**
 * 施設を作る。
 *
 * `id` は `generateId(ctx.orgShortId, "prop")`、`organizationId` と時刻は `ctx` から入れる。
 * **これらを入力から受け取らない**（PK-SPEC-P0 §19.5 / CLAUDE.md §5）。
 *
 * 監査ログ（`recordAudit`）はこの層では呼ばない。P0-11 が基盤を作り、
 * 呼ぶのは API ハンドラ側（トランザクションの単位が違うため）。
 */
export async function createProperty(env: Env, ctx: TenantContext, input: CreatePropertyInput) {
  const db = await getTenantDb(env, ctx);
  const row = {
    id: generateId(ctx.orgShortId, "prop"),
    organizationId: ctx.organizationId,
    code: input.code,
    name: input.name,
    postalCode: input.postalCode ?? null,
    address: input.address ?? null,
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    ...(input.dayCutoffTime === undefined ? {} : { dayCutoffTime: input.dayCutoffTime }),
    ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  await db.insert(property).values(row);
  return row;
}
