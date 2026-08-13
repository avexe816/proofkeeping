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
import { propertyInspectionPolicy } from "../schema/inspection.js";
import { property, roomType } from "../schema/property.js";

import { withTenantScope } from "./base.js";
import { legacyPolicyValues } from "./inspectionPolicy.js";

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

/** `listRoomTypes()` の絞り込み。 */
export interface RoomTypeFilter {
  /**
   * 無効化済みの扱い。**既定は `true`（有効なものだけ）。**
   *
   * 既定を「全件」にしない。W-05 / W-16 / W-17 は運用で使う画面で、
   * 無効化した客室タイプが選択肢に戻ってくると、無効化した意味が消える。
   * 全件が要るのは設定画面（W-25）だけなので、そちらに `undefined` を書かせる。
   */
  isActive?: boolean | undefined;
}

/**
 * 施設の客室タイプ。`sortOrder` の昇順。
 *
 * W-05（部屋ごとのタイプ名）・W-16（客室タイプ別テンプレート）・
 * W-17（客室タイプ × 清掃種別の表）が使う。**3 画面とも客室タイプを
 * 名前で示す必要があるのに、列挙する関数が無かった。**
 *
 * 既定では無効化済み（`isActive = false`）を返さない。過去のタスクは
 * `standardMinutes` を自分で持っているので、設定の画面から消えても
 * 実施済みの記録は変わらない（PK-SPEC-P0 §24.5）。
 *
 * 設定画面（P1-24 / `/app/settings/room-types`）は `{ isActive: undefined }`
 * を渡して無効化済みも並べる。**無効化を取り消す経路が無いと、
 * 打ち間違えた 1 件が二度と直せない。**
 */
export async function listRoomTypes(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  filter: RoomTypeFilter = { isActive: true },
) {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(roomType)
    .where(
      withTenantScope(
        roomType,
        ctx,
        roomType.propertyId,
        eq(roomType.propertyId, propertyId),
        filter.isActive === undefined ? undefined : eq(roomType.isActive, filter.isActive),
      ),
    )
    .orderBy(roomType.sortOrder);
}

/**
 * 客室タイプ 1 件。越境 ID は DB へ行く前に `NotFoundError`（→ 404）。
 *
 * **無効化済みも返す。** 設定画面が「無効化を取り消す」ために引く。
 */
export async function findRoomTypeById(env: Env, ctx: TenantContext, roomTypeId: string) {
  assertIdBelongsToTenant(roomTypeId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(roomType)
    .where(withTenantScope(roomType, ctx, roomType.propertyId, eq(roomType.id, roomTypeId)))
    .limit(1);
  return rows[0];
}

/** `createRoomType()` の入力。ID・組織・時刻はここでは受け取らない。 */
export interface CreateRoomTypeInput {
  propertyId: string;
  /** 施設内で一意（`uq_room_type_property_code`）。 */
  code: string;
  name: string;
  bedCount?: number | undefined;
  capacity?: number | undefined;
  sortOrder?: number | undefined;
}

/** `createRoomType()` の結果。**重複はエラーにしない。** */
export interface CreateRoomTypeResult {
  /** 作れたら `true`。既存のコードとぶつかったら `false`。 */
  created: boolean;
  /** 採番した ID。`created = false` のときは使われていない。 */
  id: string;
}

/**
 * 客室タイプを作る。
 *
 * **既存のコードとぶつかってもエラーにしない**（`createRooms()` と同じ形）。
 * 呼び出し側が `created = false` を見て画面に伝える。例外にすると、
 * 二重送信のたびに 500 を返すことになる（`Idempotency-Key` を保存せずに
 * 再送を吸収できるのはこの形のため / CLAUDE.md §5）。
 *
 * 監査ログはこの層では呼ばない（P0-07 の方針）。
 */
export async function createRoomType(
  env: Env,
  ctx: TenantContext,
  input: CreateRoomTypeInput,
): Promise<CreateRoomTypeResult> {
  assertIdBelongsToTenant(input.propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  const id = generateId(ctx.orgShortId, "rtyp");
  const result = await db
    .insert(roomType)
    .values({
      id,
      organizationId: ctx.organizationId,
      propertyId: input.propertyId,
      code: input.code,
      name: input.name,
      bedCount: input.bedCount ?? null,
      capacity: input.capacity ?? null,
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .onConflictDoNothing();

  return { created: result.meta.changes > 0, id };
}

/**
 * `updateRoomType()` の入力。**`code` と `propertyId` は変えない。**
 *
 * `code` は CSV 取込（`room_type_code`）と外部連携（P6 の `externalMapping`）が
 * 突き合わせる鍵で、後から変えると過去の取込が別のタイプを指す。
 * 打ち間違えたら無効化して作り直す。
 */
export interface UpdateRoomTypeInput {
  name?: string | undefined;
  bedCount?: number | null | undefined;
  capacity?: number | null | undefined;
  sortOrder?: number | undefined;
  /** 無効化。**`true` へ戻す経路も残す**（誤操作の取り消し）。 */
  isActive?: boolean | undefined;
}

/** 客室タイプを更新する。**物理削除の関数は無い**（CLAUDE.md §4）。 */
export async function updateRoomType(
  env: Env,
  ctx: TenantContext,
  roomTypeId: string,
  input: UpdateRoomTypeInput,
): Promise<void> {
  assertIdBelongsToTenant(roomTypeId, ctx);
  const db = await getTenantDb(env, ctx);
  await db
    .update(roomType)
    .set({
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.bedCount === undefined ? {} : { bedCount: input.bedCount }),
      ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      updatedAt: ctx.now,
    })
    .where(withTenantScope(roomType, ctx, roomType.propertyId, eq(roomType.id, roomTypeId)));
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
  /**
   * 検査を要求するか。未指定なら `false`（列の既定 / PK-SPEC-P1 §5.2）。
   *
   * **`propertyInspectionPolicy` の行もこの値から作られる**（下記）。
   * 検査方式そのもの（`SAMPLE` の抽出率など）はここで受け取らない。
   * 設定は W-02 から `upsertInspectionPolicy()` で行う。
   */
  inspectionRequired?: boolean | undefined;
}

/**
 * 施設を作る。**検査方式の行も一緒に作る。**
 *
 * `id` は `generateId(ctx.orgShortId, "prop")`、`organizationId` と時刻は `ctx` から入れる。
 * **これらを入力から受け取らない**（PK-SPEC-P0 §19.5 / CLAUDE.md §5）。
 *
 * ── 旧列と新表の両方へ書く（P2-16 / architecture.md §6 の②）─
 * `property.inspectionRequired` は次リリースで消える列だが、消えるまでは
 * **新しく作った施設でも 2 つが食い違わない**ようにする。片方だけ書くと、
 * 移行済みの施設（両方ある）と新設の施設（片方だけ）で読み方が変わり、
 * 旧列を落とす③の判断材料が濁る。
 *
 * 検査方式の行を作らない選択もあり得たが、**行が無い施設が生まれ続けると
 * 移行が終わらない。** 0011 のマイグレーションが埋めた「行がある」状態を
 * ここで保つ。
 *
 * 監査ログ（`recordAudit`）はこの層では呼ばない。P0-11 が基盤を作り、
 * 呼ぶのは API ハンドラ側（トランザクションの単位が違うため）。
 */
export async function createProperty(env: Env, ctx: TenantContext, input: CreatePropertyInput) {
  const db = await getTenantDb(env, ctx);
  const inspectionRequired = input.inspectionRequired ?? false;
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
    inspectionRequired,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  await db.insert(property).values(row);
  await db.insert(propertyInspectionPolicy).values({
    id: generateId(ctx.orgShortId, "ipol"),
    organizationId: ctx.organizationId,
    propertyId: row.id,
    ...legacyPolicyValues(inspectionRequired),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  return row;
}
