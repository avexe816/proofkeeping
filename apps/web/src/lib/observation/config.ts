/**
 * 施設ごとの観察設定の解決（PK-SPEC-P3 §2.6 / §2.5 MUST）。
 *
 * task: docs/tasks/P3-11.md
 *
 * ── 未設定でも画面が出る ────────────────────────────────
 * `observationConfig` の行が無い施設のほうが普通（設定していない）。
 * **そこで M-05 を出さない選択をしない。** 出さなければ P4 のデータが
 * 貯まらず、P3 の目的（§0.1）が達成できない。既定はスキーマの
 * `.default()` と同じ値で、ここに 1 箇所だけ持つ。
 *
 * ── 有効な品目の既定 ────────────────────────────────────
 * `enabledItemCodes` の DB 既定は空配列。**空を「全品目」と読み替えない。**
 * §2.5 MUST は「使わない品目を入力画面に出さない」で、既定を全品目に
 * すると設定していない施設に 19 品目が並ぶ（§1.2 の 15 秒が壊れる）。
 * 施設が明示した品目だけを出し、未設定なら M-05b の品目欄は空になる。
 */

import { ITEM_CODES, type ItemCodeValue, type ObservationConfig } from "@pk/contracts";
import { findObservationConfig, type Env, type TenantContext } from "@pk/db";

/** 施設が何も設定していないときの値（§2.6 のスキーマ既定と同じ）。 */
export function defaultObservationConfig(propertyId: string): ObservationConfig {
  return {
    propertyId,
    enabled: true,
    requireBeds: true,
    requireTrash: true,
    requireTowels: true,
    requireAmenities: false,
    requireLinen: false,
    enabledItemCodes: [],
    skipWarnThreshold: 20,
  };
}

/** 施設の観察設定。**行が無ければ既定**（上の注記）。 */
export async function resolveObservationConfig(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
): Promise<ObservationConfig> {
  const row = await findObservationConfig(env, ctx, propertyId);
  if (row === undefined) return defaultObservationConfig(propertyId);

  return {
    propertyId,
    enabled: row.enabled,
    requireBeds: row.requireBeds,
    requireTrash: row.requireTrash,
    requireTowels: row.requireTowels,
    requireAmenities: row.requireAmenities,
    requireLinen: row.requireLinen,
    // 保存済みの JSON に、後から消えたコードが残っていることがある。
    // **語彙に無いコードを画面へ出さない。**
    enabledItemCodes: row.enabledItemCodes.filter(isItemCode),
    skipWarnThreshold: row.skipWarnThreshold,
  };
}

/** 語彙にある品目コードか。 */
export function isItemCode(value: string): value is ItemCodeValue {
  return (ITEM_CODES as readonly string[]).includes(value);
}
