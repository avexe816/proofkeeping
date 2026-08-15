/**
 * 組織と税務プロファイルのリポジトリ。
 *
 * task: docs/tasks/P0-07.md
 * ルール: .claude/rules/architecture.md §2 / .claude/rules/billing.md §1
 *
 * ── 引数に組織 ID を取らない ────────────────────────────
 * 「どの組織か」は常に `ctx` が持つ。リクエストから組織 ID を受け取らない
 * （PK-SPEC-P0 §19.5）。そのため `findOrganization()` は自組織しか返せない。
 *
 * `organization` は `id === organizationId` なので、施設の次元を持たない。
 * `NO_PROPERTY_SCOPE` を明示する。
 */

import type { Env } from "../env.js";
import { generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import {
  organization,
  organizationTaxProfile,
  type OrgType,
} from "../schema/organization.js";

import { NO_PROPERTY_SCOPE, withTenantScope } from "./base.js";

/** 自組織。存在しなければ `undefined`（呼び出し側が 404 に写像する）。 */
export async function findOrganization(env: Env, ctx: TenantContext) {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(organization)
    .where(withTenantScope(organization, ctx, NO_PROPERTY_SCOPE))
    .limit(1);
  return rows[0];
}

/**
 * 適格請求書の発行元情報（billing.md §1）。
 *
 * 未登録なら `undefined`。**その場合に既定値を返さないこと。**
 * 登録番号の有無は「適格請求書ではありません」の表示に直結する（同 §1）。
 */
export async function findTaxProfile(env: Env, ctx: TenantContext) {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(organizationTaxProfile)
    .where(withTenantScope(organizationTaxProfile, ctx, NO_PROPERTY_SCOPE))
    .limit(1);
  return rows[0];
}

/**
 * 組織設定を更新する（PK-SPEC-P1 §19.4 / P1-22）。
 *
 * **無ければ作らない。** 組織そのものは登録の時点で存在する
 * （`organization` が無い状態は「別組織のセッションで来た」等の異常で、
 * ここで作ると壊れた行が増える）。存在の確認は呼び出し側が
 * `findOrganization()` で行い、無ければ 404 に写す。
 *
 * 値の範囲（2〜10）は `packages/contracts` が検証する。ここは受け取った値を
 * そのまま書く。**監査ログ（`organization.updated`）は呼び出し側が書く**
 * （P0-07 の方針）。
 */
export async function updateOrganizationSettings(
  env: Env,
  ctx: TenantContext,
  input: { propertySelectionThreshold: number },
): Promise<void> {
  const db = await getTenantDb(env, ctx);
  await db
    .update(organization)
    .set({ propertySelectionThreshold: input.propertySelectionThreshold, updatedAt: ctx.now })
    .where(withTenantScope(organization, ctx, NO_PROPERTY_SCOPE));
}

/**
 * セットアップウィザードの Step 1 と進行状態を書く（P7-01 / §2.3）。
 *
 * ── なぜ `updateOrganizationSettings()` と分けるのか ────
 * あちらは「組織の設定画面（W-14）が触る値」で、ここは
 * **ウィザードだけが触る値。** 1 つにまとめると、設定画面が
 * 進行状態を巻き戻せる形になる（`undefined` の扱いを間違えたときに、
 * 気づけない形で壊れる）。
 *
 * **渡された項目だけを書く。** `undefined` は「触らない」。
 * `orgType` は `null`（未回答へ戻す）を許す。
 *
 * 監査ログ（`organization.updated`）は呼び出し側が書く（P0-07 の方針）。
 */
export async function updateOrganizationSetup(
  env: Env,
  ctx: TenantContext,
  input: {
    name?: string | undefined;
    orgType?: OrgType | null | undefined;
    /** `setupStateSchema` を通した JSON 文字列。**この層は中身を見ない。** */
    setupState?: string | undefined;
  },
): Promise<void> {
  const db = await getTenantDb(env, ctx);
  await db
    .update(organization)
    .set({
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.orgType === undefined ? {} : { orgType: input.orgType }),
      ...(input.setupState === undefined ? {} : { setupState: input.setupState }),
      updatedAt: ctx.now,
    })
    .where(withTenantScope(organization, ctx, NO_PROPERTY_SCOPE));
}

/** `updateTaxProfile()` の入力。ID・組織・時刻は受け取らない。 */
export interface UpdateTaxProfileInput {
  legalName: string;
  /** `T` + 13 桁。未取得なら `null`。**空文字を入れない。** */
  invoiceRegistrationNumber: string | null;
  defaultTaxRoundingMode: "FLOOR" | "CEIL" | "ROUND";
  postalCode?: string | null | undefined;
  address?: string | null | undefined;
  tel?: string | null | undefined;
  fiscalYearStartMonth: number;
  /** 角印画像の R2 キー。**画像そのものを DB に入れない。** */
  sealImageKey?: string | null | undefined;
}

/**
 * 税務プロファイルを更新する。**無ければ作る。**
 *
 * task: docs/tasks/P0-16.md
 * ルール: .claude/rules/billing.md §1
 *
 * ── 発行済み帳票は変わらない ────────────────────────────
 * この表は現在値のマスタで、帳票には発行時のスナップショットが載る
 * （billing.md §6）。**ここを直しても過去の請求書は変わらない。**
 *
 * 監査ログ（`taxProfile.updated`）は呼び出し側が書く（P0-07 の方針）。
 */
export async function updateTaxProfile(
  env: Env,
  ctx: TenantContext,
  input: UpdateTaxProfileInput,
): Promise<void> {
  const db = await getTenantDb(env, ctx);
  const values = {
    legalName: input.legalName,
    invoiceRegistrationNumber: input.invoiceRegistrationNumber,
    defaultTaxRoundingMode: input.defaultTaxRoundingMode,
    postalCode: input.postalCode ?? null,
    address: input.address ?? null,
    tel: input.tel ?? null,
    fiscalYearStartMonth: input.fiscalYearStartMonth,
    ...(input.sealImageKey === undefined ? {} : { sealImageKey: input.sealImageKey }),
    updatedAt: ctx.now,
  };

  await db
    .insert(organizationTaxProfile)
    .values({
      id: generateId(ctx.orgShortId, "tax"),
      organizationId: ctx.organizationId,
      createdAt: ctx.now,
      ...values,
    })
    // 組織あたり 1 行（`uq_tax_profile_org`）。2 回目以降は更新になる。
    .onConflictDoUpdate({ target: organizationTaxProfile.organizationId, set: values });
}
