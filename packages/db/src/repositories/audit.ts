/**
 * 監査ログの書き込み。**`auditLog` に触ってよい唯一の場所。**
 *
 * task:  docs/tasks/P0-11.md
 * ルール: .claude/rules/security.md §6
 * 契約:  docs/PK-IMPL-CONTRACT.md §2.9（INV-30）
 *
 * ── このモジュールが持たないもの ────────────────────────
 * **更新・削除の関数を作らない**（INV-30 / PK-IMPL-CONTRACT §11.4 は
 * 「`auditLog` の削除（不可）」を設定項目にすることすら禁じている）。
 * `db.update(auditLog)` / `db.delete(auditLog)` がこのリポジトリのどこにも
 * 現れないことは `audit.spec.ts` がソースを走査して固定する。
 *
 * 検索・フィルタ・エクスポートも持たない。監査ログの**閲覧**は
 * 権限（`AUDITOR` / `ORG_ADMIN`）と保持期間の話が絡むため、
 * その画面を作る task が読み取り関数を足すこと。P0-11 は書き込みのみ。
 *
 * ── 呼ぶ場所 ────────────────────────────────────────────
 * リポジトリ層の内側からは呼ばない。**API ハンドラ（ユースケース層）が呼ぶ。**
 * 「施設を作る」と「作ったことを記録する」はトランザクションの単位が違い、
 * リポジトリ関数の中で連鎖させると、呼び出し側が監査の有無を選べなくなる
 * （`repositories/property.ts` の申し送り）。
 */

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { serializeAuditPayload } from "../mask.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { auditLog } from "../schema/audit.js";

/**
 * 監査対象の操作。**閉じたレジストリ。**
 *
 * 出典は security.md §6 の列挙。**あの箇条書き 1 行がここの 1〜数行に対応する。**
 *
 * ── 開いた文字列にしない理由 ────────────────────────────
 * `action` は 5 年残る永続データで、後から表記を揃え直せない。
 * 開いた `string` にすると `user.role_changed` と `user.roleChanged` と
 * `userRoleChanged` が同居し、**監査ログを行動ごとに数えられなくなる。**
 * `ENTITY_PREFIXES` / `PERMISSION_ACTIONS` と同じ方針。
 *
 * ── 追加するときの手順 ──────────────────────────────────
 * ① ここへ 1 行足す ② security.md §6 のどの行が根拠かをコメントに残す。
 * **一度使った文字列を変えないこと。**
 *
 * `requiresReason` は「理由必須」の操作（security.md §6 が明示的に
 * 「理由必須」と書いているもの）。真なら `reason` が無い呼び出しを落とす。
 */
export const AUDIT_ACTIONS = {
  // 組織設定・税務プロファイルの変更
  "organization.updated": { requiresReason: false },
  "taxProfile.updated": { requiresReason: false },
  // 施設・客室マスタの作成・更新・無効化
  "property.created": { requiresReason: false },
  "property.updated": { requiresReason: false },
  "property.deactivated": { requiresReason: false },
  "room.created": { requiresReason: false },
  "room.updated": { requiresReason: false },
  "room.deactivated": { requiresReason: false },
  // ユーザーの招待・ロール変更・無効化・PIN リセット
  "user.invited": { requiresReason: false },
  "user.roleChanged": { requiresReason: false },
  "user.deactivated": { requiresReason: false },
  "user.pinReset": { requiresReason: false },
  // タスクの完了・検査合格・差戻し・一括承認（P1 以降で使う）
  "task.completed": { requiresReason: false },
  // 人員配分の変更（PK-SPEC-P1 §4.2「変更は AuditLog に記録する」）。
  "task.assigned": { requiresReason: false },
  // タスクの取消。security.md §6 の列挙には無いが、CLAUDE.md §5 の
  // 「破壊的操作には必ず recordAudit()」に当たる（取消は当日の作業予定を消す）。
  "task.cancelled": { requiresReason: false },
  // 入室不可。**理由必須**（PK-SPEC-P1 §5.3）。DND / 施錠 / 在室 の別が
  // 残らないと、翌日の再訪の判断ができない。
  "task.blocked": { requiresReason: true },
  "inspection.passed": { requiresReason: false },
  "task.reworkAssigned": { requiresReason: false },
  "task.bulkApproved": { requiresReason: false },
  // 客室ステータスの手動上書き（**理由必須**）
  "room.statusOverridden": { requiresReason: true },
  // 観察記録の事後修正（**理由必須**。事後の書き換えは理由なしに残さない）
  "observation.amended": { requiresReason: true },
  // 表示スコープを全社サマリーへ切り替えた（PK-SPEC-P0 §23.4）。
  // **施設どうしの切替は記録しない。** 頻度が高くノイズになる。
  "session.scopeSwitchedToAll": { requiresReason: false },
  // 差異レポートのステータス変更
  "finding.statusChanged": { requiresReason: false },
  // 帳票の発行・訂正・送付
  "document.issued": { requiresReason: false },
  "document.corrected": { requiresReason: false },
  "document.sent": { requiresReason: false },
  // データエクスポート・証跡 ZIP 出力
  "export.data": { requiresReason: false },
  "export.evidenceZip": { requiresReason: false },
  // エンタイトルメントの変更（P0-12）
  "entitlement.updated": { requiresReason: false },
  // ログイン失敗（5 回目のみ）。**成功を記録しない**（security.md §6 の列挙に無い）
  "auth.loginFailed": { requiresReason: false },
} as const satisfies Record<string, { requiresReason: boolean }>;

/** `AUDIT_ACTIONS` に載っている操作だけを許す型。 */
export type AuditAction = keyof typeof AUDIT_ACTIONS;

/**
 * `recordAudit()` の入力。
 *
 * `organizationId` / `actorRole` / `at` は **`ctx` から入れる。**
 * 引数で受け取らない（リクエストの値が監査ログへ紛れ込む経路を作らない /
 * PK-SPEC-P0 §19.5）。
 */
export interface RecordAuditInput {
  /**
   * 操作者の membership ID。**user ID ではない。**
   * 当時のロールは `ctx.role` から入るため、後でロールを変えても追える。
   */
  actorId: string;
  action: AuditAction;
  /** 対象の種別。`room` / `invoice` など、資源の呼び名。 */
  targetType: string;
  /**
   * 対象の ID。
   *
   * **`assertIdBelongsToTenant()` を掛けていない。** 監査ログの対象は
   * 自己記述 ID とは限らず（セッション ID・外部連携の識別子・組織そのもの）、
   * 形式で落とすと「記録できない操作」が生まれる。越境は
   * `organizationId` の強制注入が塞ぐ（この行は自組織の監査ログにしかならない）。
   */
  targetId?: string | undefined;
  /** 施設スコープの操作なら施設 ID。組織全体の操作は省略。 */
  propertyId?: string | undefined;
  /** 修正前の値。**マスクは `recordAudit()` が行う**（`mask.ts`）。 */
  before?: unknown;
  /** 修正後の値。同上。 */
  after?: unknown;
  /** 理由。`AUDIT_ACTIONS[action].requiresReason` が真なら必須。 */
  reason?: string | undefined;
  /** 操作元 IP。ハンドラだけが知る値なので引数で受け取る。 */
  ip?: string | undefined;
}

/**
 * 監査ログを 1 件書く。
 *
 * `before` / `after` はここでマスクしてから JSON 文字列にする。
 * **パスワードハッシュ・PIN ハッシュを含む行をそのまま渡してよい**
 * （そのために内側でマスクしている / security.md §6）。
 *
 * @throws `AUDIT_REASON_REQUIRED` 理由必須の操作で `reason` が空。
 *   security.md §6 が理由を求める操作は、理由の無い記録に価値がない。
 *   空文字を通すと「理由欄はあるが常に空」という運用に静かに落ちる。
 */
export async function recordAudit(
  env: Env,
  ctx: TenantContext,
  input: RecordAuditInput,
): Promise<void> {
  if (AUDIT_ACTIONS[input.action].requiresReason && (input.reason ?? "").trim() === "") {
    throw new Error("AUDIT_REASON_REQUIRED");
  }
  assertIdBelongsToTenant(input.actorId, ctx);

  const db = await getTenantDb(env, ctx);
  await db.insert(auditLog).values({
    id: generateId(ctx.orgShortId, "audit"),
    organizationId: ctx.organizationId,
    propertyId: input.propertyId ?? null,
    actorId: input.actorId,
    // 操作時点のロール。セッションに焼き込まず毎リクエスト組み立てた値
    // （DECISIONS #020）なので、降格が即座に反映される。
    actorRole: ctx.role,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    before: serializeAuditPayload(input.before),
    after: serializeAuditPayload(input.after),
    reason: input.reason ?? null,
    ip: input.ip ?? null,
    at: ctx.now,
  });
}
