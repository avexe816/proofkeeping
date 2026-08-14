/**
 * 稼働記録（A 系統）のリポジトリ（PK-SPEC-P4 §2.1 / §8.1）。
 *
 * task: docs/tasks/P4-02.md
 *
 * ── 宿泊者の情報を書く口が無い ──────────────────────────
 * 入力の型に氏名・連絡先・住所・パスポート・カードの欄が 1 つも無い
 * （§2.1 MUST / security.md §3）。`rawPayload` に外部の生データを入れる
 * 経路はあるが、**マスクは呼び出し側の責務**（同期ログの `rawSample` と
 * 同じ扱い）。ここでは中身を見ない。
 *
 * ── 消す関数を作らない ──────────────────────────────────
 * `db.delete(occupancySnapshot)` を書かない。稼働記録は照合の根拠で、
 * 消えると差異の説明がつかなくなる。誤った取込は**同じ `source` で
 * 取り込み直す**（`upsertOccupancySnapshots()` が上書きする）。
 * `repositories.spec.ts` がソースを走査して固定する。
 *
 * ── 冪等 ────────────────────────────────────────────────
 * `(organizationId, roomId, businessDate, source)` が一意（`uq_occ`）。
 * **内容が同じ行には書き込みそのものを行わない。** 3 回取込んでも
 * 行が増えないだけでなく、`importedAt` も動かない（§10.2）。
 *
 * ── 取込元をまたいで潰さない ────────────────────────────
 * `source` が違えば別の行（DECISIONS #106）。PMS 連携と CSV 取込が
 * 食い違っていることは、それ自体が読み取れる状態で残す。
 * **この関数は自分の `source` の行だけを触る。**
 */

import { eq, gte, lte } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import {
  occupancySnapshot,
  type OccupancyChannelCode,
  type OccupancySource,
} from "../schema/reconciliation.js";

import { withTenantScope } from "./base.js";

/**
 * 1 客室ぶんの稼働記録。**`propertyId` / `businessDate` / `source` は
 * 並び全体で 1 つなので、呼び出し側が `UpsertOccupancyParams` で渡す。**
 */
export interface OccupancySnapshotInput {
  roomId: string;
  isOccupied: boolean;
  guestCount: number;
  adultCount: number;
  childCount: number;
  /** 予約番号のみ。**予約者名を入れないこと**（§2.1 MUST）。 */
  reservationRef: string | null;
  channelCode: OccupancyChannelCode | null;
  checkInAt: number | null;
  checkOutAt: number | null;
  isStayover: boolean;
  nightsTotal: number | null;
  nightIndex: number | null;
  ratePlanCode: string | null;
  isComplimentary: boolean;
  isHouseUse: boolean;
  /** 取込元の生データ。**個人情報は呼び出し側でマスク済みであること。** */
  rawPayload: Record<string, unknown> | null;
}

/** 取込の宛先。 */
export interface UpsertOccupancyParams {
  propertyId: string;
  businessDate: string;
  source: OccupancySource;
  /** 取込を実行した `membership.id`。自動取込なら `null`。 */
  importedById: string | null;
}

/** 変わった 1 項目。**監査ログに載る形**（§8.1 MUST「差分を AuditLog に記録」）。 */
export interface OccupancyFieldChange {
  roomId: string;
  field: string;
  before: unknown;
  after: unknown;
}

/** 取込の結果。 */
export interface UpsertOccupancyResult {
  inserted: number;
  updated: number;
  /** 内容が同じで書き込まなかった件数。**再取込がここに寄る。** */
  unchanged: number;
  /** 変わった項目。`changesTruncated` が真なら途中まで。 */
  changes: OccupancyFieldChange[];
  changesTruncated: boolean;
}

/**
 * 監査ログに載せる差分の上限。
 *
 * **監査ログは消せない永続データ**（security.md §6 / INV-30）。5,000 室の
 * 施設で全室が変わると 1 行が数十 KB になり、監査ログの閲覧そのものが
 * 重くなる。件数（`inserted` / `updated`）は必ず残るので、内訳は上限まで。
 */
export const MAX_AUDIT_CHANGES = 100;

/** 差分を取る列。**`importedAt` / `importedById` は比較しない**（取り込むたびに変わる）。 */
const COMPARED_FIELDS = [
  "isOccupied",
  "guestCount",
  "adultCount",
  "childCount",
  "reservationRef",
  "channelCode",
  "checkInAt",
  "checkOutAt",
  "isStayover",
  "nightsTotal",
  "nightIndex",
  "ratePlanCode",
  "isComplimentary",
  "isHouseUse",
] as const satisfies readonly (keyof OccupancySnapshotInput)[];

/** 既存行のうち比較に使う形。 */
type ComparedRow = Pick<OccupancySnapshotInput, (typeof COMPARED_FIELDS)[number]>;

/** 時刻は `Date` で返るので、比較の前に epoch へ揃える。 */
function toMillis(value: Date | number | null): number | null {
  if (value === null) return null;
  return value instanceof Date ? value.getTime() : value;
}

/**
 * 稼働記録を取り込む。**同じ `(roomId, businessDate, source)` は上書き。**
 *
 * @returns 挿入・更新・据え置きの件数と、変わった項目。
 *   呼び出し側はこれを `recordAudit()` の `after` に載せる。
 */
export async function upsertOccupancySnapshots(
  env: Env,
  ctx: TenantContext,
  params: UpsertOccupancyParams,
  inputs: readonly OccupancySnapshotInput[],
): Promise<UpsertOccupancyResult> {
  assertIdBelongsToTenant(params.propertyId, ctx);
  for (const input of inputs) assertIdBelongsToTenant(input.roomId, ctx);

  const db = await getTenantDb(env, ctx);

  // 既存行を 1 回で読む。**取込元をまたがない**（`source` で絞る）。
  // **比較に使う列だけを選ぶ。** `rawPayload` は差分の対象外で、
  // 取り込むたびに丸ごと運ぶ意味が無い（100 室ぶんの生データになる）。
  const existingRows = await db
    .select({
      id: occupancySnapshot.id,
      roomId: occupancySnapshot.roomId,
      isOccupied: occupancySnapshot.isOccupied,
      guestCount: occupancySnapshot.guestCount,
      adultCount: occupancySnapshot.adultCount,
      childCount: occupancySnapshot.childCount,
      reservationRef: occupancySnapshot.reservationRef,
      channelCode: occupancySnapshot.channelCode,
      checkInAt: occupancySnapshot.checkInAt,
      checkOutAt: occupancySnapshot.checkOutAt,
      isStayover: occupancySnapshot.isStayover,
      nightsTotal: occupancySnapshot.nightsTotal,
      nightIndex: occupancySnapshot.nightIndex,
      ratePlanCode: occupancySnapshot.ratePlanCode,
      isComplimentary: occupancySnapshot.isComplimentary,
      isHouseUse: occupancySnapshot.isHouseUse,
    })
    .from(occupancySnapshot)
    .where(
      withTenantScope(
        occupancySnapshot,
        ctx,
        occupancySnapshot.propertyId,
        eq(occupancySnapshot.propertyId, params.propertyId),
        eq(occupancySnapshot.businessDate, params.businessDate),
        eq(occupancySnapshot.source, params.source),
      ),
    );

  const existingByRoom = new Map(existingRows.map((row) => [row.roomId, row]));

  const result: UpsertOccupancyResult = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    changes: [],
    changesTruncated: false,
  };

  for (const input of inputs) {
    const existing = existingByRoom.get(input.roomId);

    if (existing === undefined) {
      await db.insert(occupancySnapshot).values({
        id: generateId(ctx.orgShortId, "occ"),
        organizationId: ctx.organizationId,
        propertyId: params.propertyId,
        roomId: input.roomId,
        businessDate: params.businessDate,
        source: params.source,
        isOccupied: input.isOccupied,
        guestCount: input.guestCount,
        adultCount: input.adultCount,
        childCount: input.childCount,
        reservationRef: input.reservationRef,
        channelCode: input.channelCode,
        checkInAt: input.checkInAt === null ? null : new Date(input.checkInAt),
        checkOutAt: input.checkOutAt === null ? null : new Date(input.checkOutAt),
        isStayover: input.isStayover,
        nightsTotal: input.nightsTotal,
        nightIndex: input.nightIndex,
        ratePlanCode: input.ratePlanCode,
        isComplimentary: input.isComplimentary,
        isHouseUse: input.isHouseUse,
        rawPayload: input.rawPayload,
        importedAt: ctx.now,
        importedById: params.importedById,
      });
      result.inserted += 1;
      continue;
    }

    const before: ComparedRow = {
      isOccupied: existing.isOccupied,
      guestCount: existing.guestCount,
      adultCount: existing.adultCount,
      childCount: existing.childCount,
      reservationRef: existing.reservationRef,
      channelCode: existing.channelCode,
      checkInAt: toMillis(existing.checkInAt),
      checkOutAt: toMillis(existing.checkOutAt),
      isStayover: existing.isStayover,
      nightsTotal: existing.nightsTotal,
      nightIndex: existing.nightIndex,
      ratePlanCode: existing.ratePlanCode,
      isComplimentary: existing.isComplimentary,
      isHouseUse: existing.isHouseUse,
    };

    const changed = COMPARED_FIELDS.filter((field) => before[field] !== input[field]);

    if (changed.length === 0) {
      // **書き込まない。** 再取込で `importedAt` すら動かさない（§10.2）。
      result.unchanged += 1;
      continue;
    }

    for (const field of changed) {
      if (result.changes.length >= MAX_AUDIT_CHANGES) {
        result.changesTruncated = true;
        break;
      }
      result.changes.push({ roomId: input.roomId, field, before: before[field], after: input[field] });
    }

    await db
      .update(occupancySnapshot)
      .set({
        isOccupied: input.isOccupied,
        guestCount: input.guestCount,
        adultCount: input.adultCount,
        childCount: input.childCount,
        reservationRef: input.reservationRef,
        channelCode: input.channelCode,
        checkInAt: input.checkInAt === null ? null : new Date(input.checkInAt),
        checkOutAt: input.checkOutAt === null ? null : new Date(input.checkOutAt),
        isStayover: input.isStayover,
        nightsTotal: input.nightsTotal,
        nightIndex: input.nightIndex,
        ratePlanCode: input.ratePlanCode,
        isComplimentary: input.isComplimentary,
        isHouseUse: input.isHouseUse,
        rawPayload: input.rawPayload,
        importedAt: ctx.now,
        importedById: params.importedById,
      })
      .where(
        withTenantScope(
          occupancySnapshot,
          ctx,
          occupancySnapshot.propertyId,
          eq(occupancySnapshot.id, existing.id),
        ),
      );
    result.updated += 1;
  }

  return result;
}

/** `listOccupancySnapshots()` の絞り込み。 */
export interface OccupancyFilter {
  propertyId: string;
  businessDate: string;
  /** 省略すると全取込元。食い違いを見るときはこれを省く。 */
  source?: OccupancySource | undefined;
}

/**
 * 稼働記録を引く。
 *
 * **`rawPayload` を返さない。** 外部の生データは取込の検証用で、画面にも
 * 照合にも要らない。返すと個人情報がマスク漏れのまま外へ出る経路になる
 * （security.md §3）。
 */
export async function listOccupancySnapshots(
  env: Env,
  ctx: TenantContext,
  filter: OccupancyFilter,
) {
  assertIdBelongsToTenant(filter.propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  return db
    .select({
      id: occupancySnapshot.id,
      propertyId: occupancySnapshot.propertyId,
      roomId: occupancySnapshot.roomId,
      businessDate: occupancySnapshot.businessDate,
      source: occupancySnapshot.source,
      isOccupied: occupancySnapshot.isOccupied,
      guestCount: occupancySnapshot.guestCount,
      adultCount: occupancySnapshot.adultCount,
      childCount: occupancySnapshot.childCount,
      reservationRef: occupancySnapshot.reservationRef,
      channelCode: occupancySnapshot.channelCode,
      checkInAt: occupancySnapshot.checkInAt,
      checkOutAt: occupancySnapshot.checkOutAt,
      isStayover: occupancySnapshot.isStayover,
      nightsTotal: occupancySnapshot.nightsTotal,
      nightIndex: occupancySnapshot.nightIndex,
      ratePlanCode: occupancySnapshot.ratePlanCode,
      isComplimentary: occupancySnapshot.isComplimentary,
      isHouseUse: occupancySnapshot.isHouseUse,
      importedAt: occupancySnapshot.importedAt,
      importedById: occupancySnapshot.importedById,
    })
    .from(occupancySnapshot)
    .where(
      withTenantScope(
        occupancySnapshot,
        ctx,
        occupancySnapshot.propertyId,
        eq(occupancySnapshot.propertyId, filter.propertyId),
        eq(occupancySnapshot.businessDate, filter.businessDate),
        filter.source === undefined ? undefined : eq(occupancySnapshot.source, filter.source),
      ),
    );
}

/**
 * 1 件だけ引く。**越境テストの「別組織の ID を指定すると 404」の口。**
 *
 * `assertIdBelongsToTenant()` が形式で落とし、`withTenantScope()` が
 * 同一シャードの同居組織を落とす（architecture.md §2 第1層・第2層）。
 */
export async function findOccupancySnapshotById(
  env: Env,
  ctx: TenantContext,
  snapshotId: string,
) {
  assertIdBelongsToTenant(snapshotId, ctx);
  const db = await getTenantDb(env, ctx);

  const rows = await db
    .select()
    .from(occupancySnapshot)
    .where(
      withTenantScope(
        occupancySnapshot,
        ctx,
        occupancySnapshot.propertyId,
        eq(occupancySnapshot.id, snapshotId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * その施設に稼働記録が届いているか（PK-SPEC-P4 §4.1 の `occupancyLinked`）。
 *
 * ── 列ではなく事実から導く ──────────────────────────────
 * `property` に `occupancyLinked` の列は無い（OPEN_QUESTIONS #063）。
 * **「稼働記録の連携がある」＝「稼働記録が実際に届いている」**と読み、
 * 直近の窓に 1 行でもあるかで判定する（DECISIONS #110）。列を足して
 * 既定 `false` にすると、管理画面から切り替える経路（W-13 は P6）が
 * 出来るまで照合が 1 件も動かない。
 *
 * ── 窓を取る理由 ────────────────────────────────────────
 * **当日だけを見ない。** 当日の取込が丸ごと落ちた日に「連携なし」と
 * 読んでしまうと、まさにそれを拾うための R006（§3.7）が黙る。
 *
 * @param from 窓の始まり（業務日 `YYYY-MM-DD`・含む）。
 * @param to   窓の終わり（同・含む）。
 */
export async function hasOccupancySnapshotsInRange(
  env: Env,
  ctx: TenantContext,
  filter: { propertyId: string; from: string; to: string },
): Promise<boolean> {
  assertIdBelongsToTenant(filter.propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  const rows = await db
    .select({ id: occupancySnapshot.id })
    .from(occupancySnapshot)
    .where(
      withTenantScope(
        occupancySnapshot,
        ctx,
        occupancySnapshot.propertyId,
        eq(occupancySnapshot.propertyId, filter.propertyId),
        gte(occupancySnapshot.businessDate, filter.from),
        lte(occupancySnapshot.businessDate, filter.to),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * 期間ぶんの稼働記録（R004 / PK-SPEC-P4 §3.5）。
 *
 * ── `listOccupancySnapshots()` と分けてある ──────────────
 * あちらは 1 業務日ぶんで、照合の主経路が使う。こちらは
 * 「退室から清掃までの間に稼働があったか」を見るためだけの口で、
 * **返す列を 4 つに絞ってある**（判定に要るのはこれだけ）。
 * 同じ関数に `from` / `to` を足すと、主経路が誤って期間で読む形になりうる。
 *
 * **取込元で畳まない。** 1 つでも「稼働していた」記録があれば、
 * その日は空室ではない（R004 は「他の稼働記録がない」ことを条件にする）。
 */
export async function listOccupancyInRange(
  env: Env,
  ctx: TenantContext,
  filter: { propertyId: string; from: string; to: string; limit?: number | undefined },
) {
  assertIdBelongsToTenant(filter.propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  return db
    .select({
      roomId: occupancySnapshot.roomId,
      businessDate: occupancySnapshot.businessDate,
      isOccupied: occupancySnapshot.isOccupied,
      source: occupancySnapshot.source,
    })
    .from(occupancySnapshot)
    .where(
      withTenantScope(
        occupancySnapshot,
        ctx,
        occupancySnapshot.propertyId,
        eq(occupancySnapshot.propertyId, filter.propertyId),
        gte(occupancySnapshot.businessDate, filter.from),
        lte(occupancySnapshot.businessDate, filter.to),
      ),
    )
    .orderBy(occupancySnapshot.businessDate, occupancySnapshot.roomId)
    .limit(filter.limit ?? 2000);
}
