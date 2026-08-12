/**
 * 表示中の施設の解決と切り替え（PK-SPEC-P0 §23.4）。
 *
 * task:  docs/tasks/P0-14.md
 * ルール: .claude/rules/security.md §1 / .claude/rules/architecture.md §2
 *
 * ── P0-14 が持つ範囲 ────────────────────────────────────
 * 「切り替えがセッションに残り、リロード後も維持される」までを持つ。
 * **状態サマリーの 3 数字・全社サマリー（`"ALL"`）・9 施設以上の検索は
 * P0-21 の担当**で、ここには無い。`"ALL"` を受け取る口も開けていない。
 *
 * ── セッションの値を信用しない ──────────────────────────
 * `selectedPropertyId` はセッションに入っているが、**認可の根拠にしない。**
 * 一覧は必ず `listProperties()`（第 1 層で `ctx.allowedPropertyIds` に絞られる）
 * から作り、保存された ID がその一覧に無ければ既定施設へ落とす。
 * ロール降格・施設割当の解除が即座に効く形にするため（DECISIONS #020）。
 */

import {
  NotFoundError,
  findPropertyById,
  listProperties,
  type Env,
  type TenantContext,
} from "@pk/db";

import { setSelectedPropertyId } from "../auth/session.js";

/** 画面が施設について知る必要のある最小の形。 */
export interface SelectableProperty {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
}

/**
 * 施設の並び順。`sortOrder` → `code` の順。
 *
 * **既定施設は「並べた先頭」と定義する。** 一覧の表示順と既定が別の規則だと、
 * 「上から 1 つ目が選ばれていない」状態が生まれて説明できなくなる。
 */
export function sortProperties(
  properties: readonly SelectableProperty[],
): readonly SelectableProperty[] {
  return [...properties].sort(
    (a, b) => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
}

/**
 * 表示する施設を決める。**純粋関数。**
 *
 * | セッションの値 | 結果 |
 * |---|---|
 * | 一覧にある | その施設 |
 * | 一覧に無い（権限から外れた・無効化された） | 既定施設 |
 * | 未選択 | 既定施設 |
 * | 一覧が空 | `null`（表示できる施設が無い） |
 */
export function resolveSelectedProperty(
  selectedPropertyId: string | undefined,
  properties: readonly SelectableProperty[],
): SelectableProperty | null {
  const sorted = sortProperties(properties);
  if (selectedPropertyId !== undefined) {
    const found = sorted.find((property) => property.id === selectedPropertyId);
    if (found !== undefined) return found;
  }
  return sorted[0] ?? null;
}

/**
 * 表示できる施設の一覧。無効化済みは除く。
 *
 * 施設スコープロール（CLEANER / INSPECTOR / PROPERTY_MANAGER / VENDOR_ADMIN）には
 * `listProperties()` が担当施設だけを返す（第 1 層）。ここで絞り直さない。
 */
export async function listSelectableProperties(
  env: Env,
  ctx: TenantContext,
): Promise<readonly SelectableProperty[]> {
  const rows = await listProperties(env, ctx, { isActive: true });
  return sortProperties(
    rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      sortOrder: row.sortOrder,
    })),
  );
}

/**
 * 表示する施設を切り替える。
 *
 * **担当外・別組織の施設 ID は `NotFoundError`。** `findPropertyById()` が
 * 越境 ID を DB に行く前に落とし、担当外の施設は 0 件になる。403 を返さない
 * （リソースの存在を示唆するため / architecture.md §2 第 2 層）。
 *
 * 監査ログは書かない（§23.4 — 頻度が高くノイズになる）。
 * **`"ALL"` への切替は記録が要る。実装する P0-21 が `recordAudit()` を足すこと。**
 *
 * @returns 切り替え後の施設 ID。
 */
export async function switchProperty(
  env: Env,
  ctx: TenantContext,
  cookieValue: string,
  propertyId: string,
  now: Date,
): Promise<string> {
  const property = await findPropertyById(env, ctx, propertyId);
  if (property === undefined) throw new NotFoundError();
  // 無効化された施設へは切り替えさせない。一覧に出ないものを URL で選べると、
  // 「一覧に無い施設が表示中」という説明できない状態が作れる。
  if (!property.isActive) throw new NotFoundError();

  const updated = await setSelectedPropertyId(env, cookieValue, property.id, now);
  // セッションが無効（期限切れ・破棄済み）。切替ではなく入り直しの問題。
  if (updated === null) throw new NotFoundError();

  return property.id;
}
