/**
 * 表示中の施設の解決と切り替え（PK-SPEC-P0 §23.4）。
 *
 * task:  docs/tasks/P0-14.md
 * ルール: .claude/rules/security.md §1 / .claude/rules/architecture.md §2
 *
 * ── 全社サマリー（`"ALL"`）────────────────────────────
 * P0-21 で追加した。**受け取れるのは全社ビューを持つロールだけ**
 * （OWNER / ORG_ADMIN / AUDITOR / VENDOR_ADMIN — §23.1 の表）。
 * それ以外は 403（`ScopeForbiddenError`）。施設 ID の拒否は 404 のまま
 * （INV-31）。理由の違いは packages/contracts/src/session.ts の注記。
 *
 * サマリーの数字は `summary.ts`。ここは「どのスコープを見ているか」だけを持つ。
 *
 * ── セッションの値を信用しない ──────────────────────────
 * `selectedPropertyId` はセッションに入っているが、**認可の根拠にしない。**
 * 一覧は必ず `listProperties()`（第 1 層で `ctx.allowedPropertyIds` に絞られる）
 * から作り、保存された ID がその一覧に無ければ既定施設へ落とす。
 * ロール降格・施設割当の解除が即座に効く形にするため（DECISIONS #020）。
 */

import { ALL_PROPERTIES, type PropertyScopeValue } from "@pk/contracts";
import {
  NotFoundError,
  findPropertyById,
  isOrgWideRole,
  listProperties,
  recordAudit,
  type Env,
  type TenantContext,
} from "@pk/db";

import { setSelectedPropertyId } from "../auth/session.js";

/**
 * 全社サマリーを見る権限が無い。**403 に写す唯一の例外。**
 *
 * `NotFoundError` を使わないのは、`"ALL"` が資源ではないため
 * （packages/contracts/src/session.ts の注記）。
 */
export class ScopeForbiddenError extends Error {
  constructor() {
    super("SCOPE_FORBIDDEN");
    this.name = "ScopeForbiddenError";
  }
}

/**
 * 全社ビューを持つロールか（§23.1 の表）。
 *
 * `isOrgWideRole()` と同じ 3 ロール（OWNER / ORG_ADMIN / AUDITOR）に
 * `VENDOR_ADMIN`（受託範囲内の全社ビューあり）を足す。
 * **`VENDOR_ADMIN` は施設スコープのまま**なので、見えるのは受託施設だけ。
 * 第 1 層が `allowedPropertyIds` で絞るため、ここを緩めても越境しない。
 */
export function hasOrgWideView(ctx: TenantContext): boolean {
  return isOrgWideRole(ctx.role) || ctx.role === "VENDOR_ADMIN";
}

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
 * 表示するスコープを切り替える。
 *
 * **担当外・別組織の施設 ID は `NotFoundError`（404）。** `findPropertyById()` が
 * 越境 ID を DB に行く前に落とし、担当外の施設は 0 件になる。403 を返さない
 * （リソースの存在を示唆するため / architecture.md §2 第 2 層）。
 *
 * **`"ALL"` は全社ビューを持たないロールに `ScopeForbiddenError`（403）。**
 * こちらは資源ではないので存在を示唆しない（§23.4 MUST / §25.1）。
 *
 * 監査ログは施設の切替では書かない（§23.4 — 頻度が高くノイズになる）。
 * **`"ALL"` への切替だけ記録する**（同 §23.4）。
 *
 * @returns 切り替え後のスコープ。
 */
export async function switchProperty(
  env: Env,
  ctx: TenantContext,
  cookieValue: string,
  scope: PropertyScopeValue,
  now: Date,
  /** 監査ログの操作者（membership ID）。`"ALL"` への切替でのみ使う。 */
  actorId: string,
): Promise<PropertyScopeValue> {
  if (scope === ALL_PROPERTIES) {
    if (!hasOrgWideView(ctx)) throw new ScopeForbiddenError();

    const updated = await setSelectedPropertyId(env, cookieValue, ALL_PROPERTIES, now);
    if (updated === null) throw new NotFoundError();

    await recordAudit(env, ctx, {
      actorId,
      action: "session.scopeSwitchedToAll",
      targetType: "session",
      targetId: ALL_PROPERTIES,
    });
    return ALL_PROPERTIES;
  }

  const property = await findPropertyById(env, ctx, scope);
  if (property === undefined) throw new NotFoundError();
  // 無効化された施設へは切り替えさせない。一覧に出ないものを URL で選べると、
  // 「一覧に無い施設が表示中」という説明できない状態が作れる。
  if (!property.isActive) throw new NotFoundError();

  const updated = await setSelectedPropertyId(env, cookieValue, property.id, now);
  // セッションが無効（期限切れ・破棄済み）。切替ではなく入り直しの問題。
  if (updated === null) throw new NotFoundError();

  return property.id;
}

/**
 * セッションに残っているスコープを、いま到達できるものへ解決する。
 *
 * | セッション | ロール | 結果 |
 * |---|---|---|
 * | `"ALL"` | 全社ビューあり | `"ALL"` |
 * | `"ALL"` | 全社ビューなし（降格後） | 既定施設 |
 * | 施設 ID | 一覧にある | その施設 |
 * | 施設 ID | 一覧に無い（権限外・無効化） | 既定施設 |
 *
 * **セッションの値を認可の根拠にしない。** 毎回ロールと一覧から解き直す
 * （DECISIONS #020）。
 */
export function resolveSelectedScope(
  selected: string | undefined,
  ctx: TenantContext,
  properties: readonly SelectableProperty[],
): { scope: PropertyScopeValue | null; property: SelectableProperty | null } {
  if (selected === ALL_PROPERTIES && hasOrgWideView(ctx)) {
    return { scope: ALL_PROPERTIES, property: null };
  }
  const property = resolveSelectedProperty(
    selected === ALL_PROPERTIES ? undefined : selected,
    properties,
  );
  return { scope: property?.id ?? null, property };
}
