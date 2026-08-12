/**
 * `assertEntitlement()`。契約していないモジュールへの到達を止める唯一の判定点。
 *
 * task: docs/tasks/P0-12.md
 * 仕様: docs/PK-SPEC-P7.md §3.1
 *
 * ── `assertPermission()` との関係 ────────────────────────
 * 別々の問いに答える。**両方を通す。**
 *
 *   assertPermission   そのロールがその操作に到達してよいか   → 404
 *   assertEntitlement  組織がそのモジュールを契約しているか   → 402
 *
 * **必ず権限（404）を先に判定する。** 逆にすると、担当外施設に対して
 * 「契約していない」と答えることになり、402 が施設の存在を示唆する
 * （`packages/db/src/errors.ts` の `PaymentRequiredError`）。
 *
 * ── boolean を返す関数を置いていない ────────────────────
 * `assertPermission()` には `can()` を用意した（ナビゲーションの出し分けに要る）。
 * こちらは throw のみ。画面の出し分けが必要になったら、判定を 1 か所に閉じたまま
 * 「契約済みモジュールの一覧」を返す読み取りを足すこと。`isModuleEnabled()` を
 * 画面から直接呼ぶ形にすると、判定の呼び忘れが型で通るようになる。
 */

import {
  PaymentRequiredError,
  isModuleEnabled,
  type Env,
  type ModuleCode,
  type TenantContext,
} from "@pk/db";

/**
 * モジュールを契約していなければ `PaymentRequiredError` を投げる。
 *
 * `resourceGuard.ts` の `apiErrorHandler()` が 402 に写像する。
 *
 * @param propertyId 施設に紐づく操作ならその施設 ID。組織全体の操作は `null`。
 *   **省略可能にしていない**（`isModuleEnabled()` と同じ理由）。
 *   クライアントが送った値をそのまま渡さないこと。資源から解決した値を渡す（INV-32）。
 */
export async function assertEntitlement(
  env: Env,
  ctx: TenantContext,
  moduleCode: ModuleCode,
  propertyId: string | null,
): Promise<void> {
  if (!(await isModuleEnabled(env, ctx, moduleCode, propertyId))) {
    throw new PaymentRequiredError();
  }
}
