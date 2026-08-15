/**
 * モジュールを**有効化する**ときに求める同意（PK-SPEC-P7 §7.3 MUST）。
 *
 * task:  docs/tasks/P7-15.md
 * 文書:  docs/guides/finding-report-reading.md
 * 決定:  docs/DECISIONS.md #173
 *
 * ── なぜ「同意」を型で持つのか ──────────────────────────
 * §7.3 MUST は「Audit モジュールを有効化する際、この文書への同意を
 * 求める」。差異レポートは**使い方を誤ると人の評価に転用できる**機能で、
 * 読み方の文書はその誤用を止める唯一の仕掛けになっている。
 * 「画面にリンクを置く」で済ませると、押されたかどうかが残らない。
 *
 * ── まだ呼び出し側が無い ────────────────────────────────
 * `module_entitlement` への**書き込みは 1 本も実装されていない**
 * （有効化・無効化は P7-04 の担当。CLAUDE.md §9 の着手条件により未着手）。
 * ここは、その 1 本が生えたときに**必ず通る門**として先に置いてある。
 * 登録漏れは `moduleConsent.spec.ts` が走査して落とす。
 *
 * **`isModuleEnabled()` 側に同意判定を持ち込まないこと。** 読み取りのたびに
 * 同意を見ると、同意の記録が失われた組織で差異レポートが黙って空になる。
 * 同意は「有効化という操作」の条件であって、契約の内容ではない。
 *
 * ── `assertEntitlement()` との関係 ──────────────────────
 *   assertPermission   そのロールがその操作に到達してよいか        → 404
 *   assertEntitlement  組織がそのモジュールを契約しているか        → 402
 *   assertModuleConsent 有効化するとき、読み方の文書に同意したか   → 409
 *
 * **同意は最後に見る。** 権限の無い相手に「同意が必要です」と答えると、
 * その組織の契約状況が読めてしまう（`entitlement.ts` の順序と同じ理由）。
 */

import type { ModuleCode } from "@pk/db";

/** 同意の対象になる文書。**版数はリポジトリ内の文書と一致させる。** */
export interface ConsentDocument {
  /** リポジトリルートからの相対パス。顧客向けの公開先もこの文書。 */
  readonly path: string;
  /** 文書の見出し直下に書いてある版数（`**版**: v1.0`）。 */
  readonly version: string;
}

/** 利用者が「読んで同意した」と申告した内容。 */
export interface AcceptedConsent {
  readonly documentPath: string;
  readonly version: string;
}

/**
 * モジュールごとの同意要件。**`Record` で全モジュールを並べる。**
 *
 * `Partial` や `Set` にしないのは、モジュールを足したときに
 * 「同意が要るか」を必ず 1 回考えさせるため。`null` は
 * 「考えた上で要らない」を意味する。
 */
export const MODULE_CONSENT_DOCUMENTS: Readonly<Record<ModuleCode, ConsentDocument | null>> = {
  PLATFORM: null,
  HOUSEKEEPING_CORE: null,
  // §7.3 MUST。**ここだけが同意を要する。**
  AUDIT: { path: "docs/guides/finding-report-reading.md", version: "v1.0" },
  BILLING: null,
  VENDOR_PLAN: null,
  INTEGRATION: null,
};

/**
 * 同意が満たされていないことを表す。呼び出し側は **409** に写像する。
 *
 * 404（権限）でも 402（契約）でもない。**操作の前提が欠けている**状態で、
 * 利用者が読んで同意すれば解消する。402 に混ぜると「買えば使える」と
 * 読めてしまい、文書を読まずに購入導線へ流れる。
 *
 * **`resourceGuard.ts` の `apiErrorHandler()` にはまだ登録していない。**
 * 有効化の経路を作る task（P7-04）が、その経路と一緒に写像を足すこと。
 */
export class ModuleConsentRequiredError extends Error {
  readonly code: string;
  readonly document: ConsentDocument;

  constructor(code: string, document: ConsentDocument) {
    super(code);
    this.name = "ModuleConsentRequiredError";
    this.code = code;
    this.document = document;
  }
}

/** そのモジュールの有効化に同意が要るか。要らなければ `null`。 */
export function requiredConsentFor(moduleCode: ModuleCode): ConsentDocument | null {
  return MODULE_CONSENT_DOCUMENTS[moduleCode];
}

export interface ModuleConsentInput {
  readonly moduleCode: ModuleCode;
  /** **有効化のときだけ同意を求める。** 無効化は止めない。 */
  readonly isEnabled: boolean;
  /** 利用者の申告。同意していなければ `null`。 */
  readonly accepted: AcceptedConsent | null;
}

/**
 * 有効化に必要な同意が揃っていなければ投げる。
 *
 * ── 版数を照合する ──────────────────────────────────────
 * 文書を改訂したら、**同じ組織にもう一度同意を求める。** 読み方が変わる
 * 改訂（確信度の意味・解決コードの追加）を、既に同意済みの組織へ黙って
 * 適用しないため。改訂のたびに `MODULE_CONSENT_DOCUMENTS` の版数を上げる。
 *
 * ── 無効化を止めない ────────────────────────────────────
 * 「同意していないので止められない」は、§7.3 の目的（誤用を止める）の
 * 逆を向く。無効化は常に通す。
 */
export function assertModuleConsent(input: ModuleConsentInput): void {
  const required = requiredConsentFor(input.moduleCode);
  if (required === null) return;
  if (!input.isEnabled) return;

  if (input.accepted === null) {
    throw new ModuleConsentRequiredError("MODULE_CONSENT_REQUIRED", required);
  }
  if (input.accepted.documentPath !== required.path) {
    throw new ModuleConsentRequiredError("MODULE_CONSENT_DOCUMENT_MISMATCH", required);
  }
  if (input.accepted.version !== required.version) {
    throw new ModuleConsentRequiredError("MODULE_CONSENT_VERSION_MISMATCH", required);
  }
}
