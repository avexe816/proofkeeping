/**
 * 権限マトリクスと `assertPermission()`。認可の唯一の判定点。
 *
 * task:  docs/tasks/P0-10.md
 * ルール: .claude/rules/security.md §1
 * 決定:  docs/DECISIONS.md #022（拒否は一律 404）/ #023（読み取りは組織全体・書き込みは自施設）
 *
 * ── この層が担うもの ────────────────────────────────────
 * テナント分離の第 1 層（`withTenantScope()`）は「別組織の行を混ぜない」を守る。
 * **同じ組織の中で、そのロールがその操作に到達してよいか**は別の問いで、
 * 第 1 層は何も言わない。ここがそれを決める。
 *
 * 判定は必ずサーバー側で行う。**フロントでのメニュー非表示は UX 上の措置であり、
 * 権限制御とみなさない**（security.md §1）。`can()` はその出し分けのために
 * 用意してあるが、`assertPermission()` を省く理由にはならない。
 *
 * ── P0-10 が実装する範囲 ────────────────────────────────
 * security.md §1 が「絶対に守る境界」として明記した項目と、P0 に実体のある
 * 資源（組織・税務プロファイル・ユーザー・施設）だけ。
 * **PK-IMPL-CONTRACT §4 のビジネス表（単価・契約条件、請求の確定、シフトと割当…）は
 * 転記していない。** あの表は `SITE_LEAD` / `OPS_MANAGER` / `VIEWER` /
 * `PLATFORM_ADMIN` という別語彙で書かれており、7 語への写像が推測になる
 * （OPEN_QUESTIONS #011）。特に §4 の `OWNER` は「自施設・清掃員氏名 ×」で、
 * security.md §1 の `OWNER`（組織全体）とは別概念である。
 * **各画面の権限は、その画面を作る task が `PERMISSION_ACTIONS` に 1 行足す。**
 *
 * ── 明記の無いセルは DENY ───────────────────────────────
 * security.md §1 に根拠が無いセルはすべて `DENY` にしてある。広げるのは
 * 根拠を持つ task の仕事。`repositories/base.ts` の `ORG_WIDE_ROLES` と同じく、
 * **書き忘れが「見えすぎる」方向に壊れない**向きへ既定を倒している。
 */

import { NotFoundError, isOrgWideRole, type Role, type TenantContext } from "@pk/db";

// ────────────────────────────────────────────────────────────
// アクションのレジストリ
// ────────────────────────────────────────────────────────────

/**
 * 権限判定の対象になる操作。**閉じたレジストリ。**
 *
 * `write` は「状態を変える操作か」。`AUDITOR` が書き込みを一切できないこと
 * （security.md §1）を、ロールごとに人手で確かめるのではなく
 * この印から機械的に検査するために持たせている（permission.spec.ts）。
 *
 * ── 追加するときの手順 ──────────────────────────────────
 * ① ここへ 1 行足す ② `PERMISSION_MATRIX` に 7 ロール分のセルを書く
 * （書かなければ**コンパイルエラー**になる）③ 根拠を仕様書か
 * security.md のどこに置いたかをコメントに残す。
 */
export const PERMISSION_ACTIONS = {
  /** 組織の基本情報の閲覧。表示名は全ロールの画面に出る。 */
  "organization.read": { write: false },
  /** 組織設定の変更（security.md §6 の監査対象）。 */
  "organization.write": { write: true },
  /** 税務プロファイル（登録番号・端数処理）の閲覧。 */
  "taxProfile.read": { write: false },
  /** 税務プロファイルの変更（security.md §6 の監査対象）。 */
  "taxProfile.write": { write: true },
  /**
   * ユーザー・所属の閲覧。
   *
   * **施設スコープロールも組織全体を読める**（OPEN_QUESTIONS #016 の回答）。
   * `user` / `membership` は `propertyId` を持たず、`scopeToProperties()` が
   * 掛からない。リポジトリ層は `NO_PROPERTY_SCOPE` のまま変更しない。
   */
  "user.read": { write: false },
  /** 招待・ロール変更・無効化・PIN リセット（security.md §6 の監査対象）。 */
  "user.write": { write: true },
  /** 施設の閲覧。 */
  "property.read": { write: false },
  /** 施設マスタの作成・更新・無効化（security.md §6 の監査対象）。 */
  "property.write": { write: true },
  /**
   * 差異レポート（`/app/audit/*`、`/api/v1/findings`）。
   *
   * P0 に実体は無い。**`CLEANER` / `INSPECTOR` が到達できない**という
   * security.md §1 の絶対境界を、資源より先に固定しておくために置く。
   */
  "finding.read": { write: false },
  /**
   * 忘れ物の保管場所・返却先。**`CLEANER` は見られない**（security.md §1）。
   * 忘れ物そのものの記録とは別の操作。P0 に実体は無い。
   */
  "lostItem.readStorage": { write: false },
  /** 請求情報。**`INSPECTOR` は見られない**（security.md §1）。P0 に実体は無い。 */
  "billing.read": { write: false },
} as const satisfies Record<string, { write: boolean }>;

/** `PERMISSION_ACTIONS` に載っている操作だけを許す型。 */
export type PermissionAction = keyof typeof PERMISSION_ACTIONS;

/** 全アクション。テストと網羅検査のために配列でも持つ。 */
export const PERMISSION_ACTION_LIST = Object.keys(PERMISSION_ACTIONS) as readonly PermissionAction[];

/** 状態を変える操作か。 */
export function isWriteAction(action: PermissionAction): boolean {
  return PERMISSION_ACTIONS[action].write;
}

// ────────────────────────────────────────────────────────────
// スコープと対象
// ────────────────────────────────────────────────────────────

/**
 * マトリクスのセルが取る値。
 *
 * | 値 | 意味 |
 * |---|---|
 * | `DENY` | 常に拒否。404 |
 * | `ORG` | 組織全体。対象を問わず許可 |
 * | `ASSIGNED` | `ctx.allowedPropertyIds` に含まれる施設の資源のみ |
 *
 * **`SELF`（自分の記録のみ）は意図的に持たせていない。** M-11（自分の記録の
 * 閲覧 / security.md §5）が要求するが、P0 に対象の資源が無く、判定に
 * `target.userId` が要る。**その画面を作る task がここに 1 値足すこと。**
 */
export type PermissionScope = "DENY" | "ORG" | "ASSIGNED";

/**
 * 権限の対象。
 *
 * **クライアントが送った `propertyId` をここへ入れてはならない**（INV-32）。
 * 必ず資源そのものから解決した値を渡す（例: `taskId` → その task の
 * `propertyId`）。パス変数を直に流し込むと、`ASSIGNED` の判定が
 * 「自分で申告した施設と自分の担当施設を突き合わせる」だけになり、
 * 何も守らない。
 */
export type PermissionTarget =
  /** 組織全体に属する資源（組織設定・税務プロファイル・ユーザー一覧）。 */
  | { kind: "ORGANIZATION" }
  /** 施設に属する資源。`propertyIds` はサーバー側で解決した値。 */
  | { kind: "PROPERTY"; propertyIds: readonly string[] };

/**
 * 組織全体の資源を表す対象。
 *
 * **第 3 引数を省略可能にしていない。** 省略を許すと「施設で絞るべき資源なのに
 * 対象を書き忘れた」場合と区別がつかず、静かに広い側へ倒れる
 * （`repositories/base.ts` の `NO_PROPERTY_SCOPE` と同じ方針）。
 */
export const ORGANIZATION_TARGET: PermissionTarget = { kind: "ORGANIZATION" };

/** 施設に属する資源の対象を作る。 */
export function propertyTarget(propertyIds: readonly string[]): PermissionTarget {
  return { kind: "PROPERTY", propertyIds };
}

// ────────────────────────────────────────────────────────────
// マトリクス
// ────────────────────────────────────────────────────────────

/**
 * 7 ロール × 全アクションの権限マトリクス。
 *
 * ── 既定値を持たない ────────────────────────────────────
 * 型が `Record<PermissionAction, Record<Role, PermissionScope>>` なので、
 * **セルを 1 つでも書き漏らすとコンパイルが通らない。** 「表に無いロールは
 * とりあえず拒否」のようなフォールバックを実装しないこと。フォールバックが
 * あると、ロールやアクションを足したときに「意図して DENY にした」のか
 * 「書き忘れた」のかがコードから読めなくなる。
 *
 * ── 太字の根拠（security.md §1「絶対に守る境界」）──────
 *   - `CLEANER` / `INSPECTOR` は差異レポートに到達できない → `finding.read`
 *   - `CLEANER` は忘れ物の保管場所・返却先を見られない → `lostItem.readStorage`
 *   - `INSPECTOR` は請求情報を見られない → `billing.read`
 *   - `AUDITOR` は書き込み操作を一切できない → 全 `write` 行
 *   - `VENDOR_ADMIN` は受託外施設を見られない → `ASSIGNED`
 */
export const PERMISSION_MATRIX: Record<PermissionAction, Record<Role, PermissionScope>> = {
  // 組織名は全ロールの画面に出る。個人情報も施設の情報も含まない。
  "organization.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ORG",
    INSPECTOR: "ORG",
    CLEANER: "ORG",
    VENDOR_ADMIN: "ORG",
    AUDITOR: "ORG",
  },
  // 設定画面。`CLEANER` は到達できない（P0-10 完了条件）。
  "organization.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "DENY",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // 登録番号・端数処理は請求の前提。閲覧は組織全体ロールと監査のみ。
  "taxProfile.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "DENY",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "ORG",
  },
  "taxProfile.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "DENY",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // OPEN_QUESTIONS #016 の回答。**読み取りは施設スコープロールも組織全体。**
  // 同僚の表示名・スタッフ番号が見えることを許す判断（DECISIONS #023）。
  "user.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ORG",
    INSPECTOR: "ORG",
    CLEANER: "ORG",
    VENDOR_ADMIN: "ORG",
    AUDITOR: "ORG",
  },
  // **書き込みは自施設のみ。** `PROPERTY_MANAGER` は担当施設に割り当てられた
  // ユーザーだけを触れる。`VENDOR_ADMIN` が自社スタッフを招待できるかは
  // security.md §1 に明記が無いため DENY。広げるのは招待画面を作る task。
  "user.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // `scopeToProperties()` と同じ境界。施設スコープロールは担当施設のみ。
  "property.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "ASSIGNED",
    CLEANER: "ASSIGNED",
    VENDOR_ADMIN: "ASSIGNED",
    AUDITOR: "ORG",
  },
  "property.write": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "DENY",
  },
  // security.md §1: `CLEANER` も `INSPECTOR` も到達できない。404 を返す。
  "finding.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "ASSIGNED",
    AUDITOR: "ORG",
  },
  // security.md §1: `CLEANER` は保管場所・返却先を見られない。
  "lostItem.readStorage": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "ASSIGNED",
    CLEANER: "DENY",
    VENDOR_ADMIN: "ASSIGNED",
    AUDITOR: "ORG",
  },
  // security.md §1: `INSPECTOR` は請求情報を見られない。
  // `VENDOR_ADMIN`（清掃会社）が受託分の請求を見られるかは明記が無く DENY。
  // 広げるのは P5（請求・領収・多施設）の task。
  "billing.read": {
    OWNER: "ORG",
    ORG_ADMIN: "ORG",
    PROPERTY_MANAGER: "ASSIGNED",
    INSPECTOR: "DENY",
    CLEANER: "DENY",
    VENDOR_ADMIN: "DENY",
    AUDITOR: "ORG",
  },
};

// ────────────────────────────────────────────────────────────
// 判定
// ────────────────────────────────────────────────────────────

/** ロールとアクションからスコープを引く。判定そのものは `can()`。 */
export function resolveScope(role: Role, action: PermissionAction): PermissionScope {
  return PERMISSION_MATRIX[action][role];
}

/**
 * 権限があるかを返す。**throw しない。**
 *
 * ナビゲーションの出し分けなど、「無ければ出さない」だけの用途に使う。
 * **これで分岐したからといって `assertPermission()` を省かないこと。**
 * 画面を隠すのは UX 上の措置で、権限制御ではない（security.md §1）。
 */
export function can(
  ctx: TenantContext,
  action: PermissionAction,
  target: PermissionTarget,
): boolean {
  const scope = resolveScope(ctx.role, action);
  if (scope === "DENY") return false;
  if (scope === "ORG") return true;

  // ASSIGNED。組織全体ロールがここへ来ることは無い（マトリクス上 ORG のため）が、
  // 来ても `allowedPropertyIds` は空なので拒否になる。`isOrgWideRole()` を
  // ここで参照しないのは、判定の根拠をマトリクス 1 か所に閉じるため。
  if (target.kind !== "PROPERTY") {
    // 施設で絞れない対象を、施設スコープの権限で通さない。
    return false;
  }
  if (target.propertyIds.length === 0) {
    // 施設が 1 つも紐付かない資源。担当施設に含まれると言えないので拒否。
    // 結果として `PROPERTY_MANAGER` は施設割当を持たないユーザーを作れない。
    // 招待 API は「招待と施設割当を同時に行う」形にすること（P0-10 申し送り）。
    return false;
  }

  const allowed = new Set(ctx.allowedPropertyIds);
  // **部分集合であること。交差ではない。** 担当施設 A と担当外 B にまたがる
  // 資源を交差で許すと、B に対する影響力が生まれる。
  return target.propertyIds.every((propertyId) => allowed.has(propertyId));
}

/**
 * 権限が無ければ `NotFoundError` を投げる。**API ハンドラはこれを呼ぶ。**
 *
 * ── なぜ boolean を返さないのか ─────────────────────────
 * `can()` を主にすると `if (!can(...)) return 404` の**書き忘れが型で通り、
 * 素通りする。** throw なら、呼んでいない経路は「判定が無い」として
 * レビューとテストに残る。失敗の形を「余分に見える」から
 * 「例外が飛ぶ」へ寄せる（`scopeToProperties()` と同じ方針 / DECISIONS #017）。
 *
 * ── 403 ではなく 404 ────────────────────────────────────
 * 投げるのは `@pk/db` の `NotFoundError`。**このファイルで再定義しない**
 * （同名クラスが 2 つあると `instanceof` が片方で外れ、404 のはずが 500 になる /
 * `packages/db/src/errors.ts` の申し送り）。HTTP への写像は
 * `middleware/resourceGuard.ts` が一元的に行う。
 */
export function assertPermission(
  ctx: TenantContext,
  action: PermissionAction,
  target: PermissionTarget,
): void {
  if (!can(ctx, action, target)) throw new NotFoundError();
}

/**
 * 組織全体ロールか（`@pk/db` の再エクスポート）。
 *
 * マトリクスの不変条件テストが参照する。判定そのものには使わない
 * （根拠を `PERMISSION_MATRIX` 1 か所に閉じるため）。
 */
export { isOrgWideRole };
