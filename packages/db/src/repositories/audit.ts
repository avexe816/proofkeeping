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

import { eq, gte, inArray, lte } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { serializeAuditPayload } from "../mask.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { auditLog } from "../schema/audit.js";

import { withTenantScope } from "./base.js";

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
  // タスクの完了・検査合格・差戻し（P1 以降で使う）
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
  // 検査不合格（PK-SPEC-P2 §4.5）。security.md §6 の「差戻し」に当たる。
  // `task.reworkAssigned`（差戻しの割当）と分けてあるのは、免除（§4.7）で
  // 差戻しが割り当たらない経路があるため。
  "inspection.failed": { requiresReason: false },
  // 清掃担当者本人による検査（PK-SPEC-P2 §4.2 の例外）。**理由必須。**
  // security.md §1「緊急時の例外は理由必須＋監査ログ」がここに対応する。
  "inspection.selfApproved": { requiresReason: true },
  "task.reworkAssigned": { requiresReason: false },
  // 再清掃の完了（PK-SPEC-P2 §4.6）。security.md §6 の「差戻し」に当たる。
  // **`task.completed` と別に残す。** タスクの完了は「作業が終わった」で、
  // これは「差し戻された項目が片付いた」。§10.1 の差戻し件数はこちらを数える。
  "rework.resolved": { requiresReason: false },
  // 免除（同 §4.7）。**理由必須。** §4.7 が「理由必須」と明記している。
  // 関連する IssueReport は `after` に入れる（列は `waivedIssueId`）。
  "rework.waived": { requiresReason: true },
  /**
   * 検査待ちで残ったタスクを、検査せずに閉じた（PK-SPEC-P2 §13.3）。**理由必須。**
   *
   * **`task.bulkApproved`（一括承認）はここから消えた**（同 §13.1 / P2-16）。
   * security.md §6 の列挙に「一括承認」の語は残っているが、操作そのものが
   * P2 リリースで廃止された。**一度使った文字列を変えない**という上の規則の
   * 例外に見えるが、`task.bulkApproved` は**一度も書き込まれていない**
   * （P1 に到達経路が無かった）。既存の監査ログに現れない値なので消せる。
   */
  "inspection.emergencyOverride": { requiresReason: true },
  // 客室ステータスの手動上書き（**理由必須**）
  "room.statusOverridden": { requiresReason: true },
  // 観察記録の事後修正（**理由必須**。事後の書き換えは理由なしに残さない）
  "observation.amended": { requiresReason: true },
  // 表示スコープを全社サマリーへ切り替えた（PK-SPEC-P0 §23.4）。
  // **施設どうしの切替は記録しない。** 頻度が高くノイズになる。
  "session.scopeSwitchedToAll": { requiresReason: false },
  // 差異レポートのステータス変更
  "finding.statusChanged": { requiresReason: false },
  /**
   * 取引先マスタの登録・更新・無効化（P5-02 / PK-SPEC-P5 §2.1）。
   *
   * security.md §6 の列挙に「取引先」の行は無いが、CLAUDE.md §5 の
   * 「破壊的操作には必ず `recordAudit()`」に当たる。**請求書の宛先と
   * 端数処理方式がここで決まる。** 送付先メールが黙って書き換わると、
   * 請求書が別の宛先へ届く。`property.created` に相乗りさせないのは、
   * 施設と取引先が別の資源で、監査時に区別できないと追えないため。
   */
  "counterparty.created": { requiresReason: false },
  "counterparty.updated": { requiresReason: false },
  /**
   * 料金設定の登録・期間終了（P5-03 / 同 §2.2）。
   *
   * **単価は請求金額の根拠そのもの。** 誰がいつその単価を入れたかが
   * 残らないと、金額の争いを事後に解けない（§11「料金設定の抜けで
   * 請求漏れ」）。更新の口は無く、値上げは行の追加なので
   * `pricingRule.created` と `pricingRule.closed` の 2 つで足りる。
   */
  "pricingRule.created": { requiresReason: false },
  "pricingRule.closed": { requiresReason: false },
  /**
   * 月次締めの状態変更（PK-SPEC-P5 §6.1 / P5-05）。
   *
   * security.md §6 の列挙には無いが、CLAUDE.md §5 の「破壊的操作には
   * 必ず `recordAudit()`」に当たる。締めの状態は**請求書を出せるか
   * どうかを決める**（`AGREED` でなければ発行できない / §6.1）ので、
   * 誰がいつ進めたかが残らないと §6.2 MUST の「言った・言わない」を
   * 発生させない仕組みが成り立たない。
   *
   * 差戻しのコメントはここに入れない。**コメントと修正履歴は
   * 双方合意フロー（P5-12）が専用の表に持つ**（§6.2 MUST）。
   */
  "billingPeriod.statusChanged": { requiresReason: false },
  // 帳票の発行・訂正・送付
  "document.issued": { requiresReason: false },
  /**
   * 帳票の訂正（PK-SPEC-P5 §5.2 の 2「訂正理由を入力（必須）」）。
   *
   * **理由必須にした**（P5-09）。security.md §6 の列挙は「帳票の発行・
   * 訂正・送付」とだけ書くが、§5.2 が理由を必須と定めている。
   * 発行済みの帳票を取り消した記録に理由が無いと、電帳法の
   * 「訂正・削除の履歴が残るシステム」（billing.md §2）が成り立たない。
   */
  "document.corrected": { requiresReason: true },
  "document.sent": { requiresReason: false },
  /**
   * 稼働記録の取込（PK-SPEC-P4 §8.1 MUST「再取込時は上書きし、差分を
   * AuditLog に記録する」）。
   *
   * security.md §6 の列挙には無いが、CLAUDE.md §5 の「破壊的操作には必ず
   * `recordAudit()`」に当たる。**再取込は既存の稼働記録を上書きする**ので、
   * 差異の根拠が黙って書き換わる経路になりうる。`after` に件数と
   * 変わった項目を載せる。
   */
  "occupancy.imported": { requiresReason: false },
  /**
   * 外部 ID と客室の対応の作成・無効化（PK-SPEC-P6 §2.3 / P6-05）。
   *
   * security.md §6 の列挙には無いが、CLAUDE.md §5 の「破壊的操作には必ず
   * `recordAudit()`」に当たる。**対応を 1 行間違えると、302 号室の稼働記録が
   * 303 号室に入る。** 取り違えた記録は差異レポートと請求の両方へ流れ、
   * 事後に「いつからそうなっていたか」を対応表そのものからは辿れない
   * （`external_mapping` は無効化しても行を残すが、いつ有効だったかは
   * `createdAt` しか持たない）。
   */
  "integrationMapping.updated": { requiresReason: false },
  /**
   * 連携の状態変更（PK-SPEC-P6 §3.4 / P6-07）。
   *
   * サーキットブレーカーを人が閉じる操作（`ERROR` → `ACTIVE`）。
   * **自動同期を再開させる操作**で、原因が直っていないのに閉じると
   * 5 回失敗してまた開く。誰がいつ閉じたかが残らないと、
   * その往復が運用の判断だったのか誤操作だったのか読めない。
   */
  "integration.statusChanged": { requiresReason: false },
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

// ────────────────────────────────────────────────────────────
// 読み取り（PK-SPEC-P4 §3.8 / §3.10）
// ────────────────────────────────────────────────────────────

/** `listAuditLogs()` の絞り込み。**操作種別と期間を必ず絞る。** */
export interface AuditLogFilter {
  propertyId: string;
  /** `AUDIT_ACTIONS` の値。複数指定できる。 */
  actions: readonly AuditAction[];
  /** この時刻以降（含む）。 */
  from: Date;
  /** この時刻以前（含む）。 */
  to: Date;
  limit?: number | undefined;
}

/**
 * 監査ログを読む（R010 / R014 の根拠）。
 *
 * ── 汎用の監査ログ閲覧ではない ──────────────────────────
 * 照合が「客室ステータスの手動上書き」（§3.8）と「稼働記録の事後変更」
 * （§3.10）を数えるための口。**期間と操作種別を必須にしてある**ので、
 * 「全部読む」呼び出しが書けない。監査ログの閲覧画面（権限と監査 / P7）は
 * 別の絞り込みが要るはずで、そのときにこの関数を広げないこと。
 *
 * ── 消す関数を作らない ──────────────────────────────────
 * `db.delete(auditLog)` を書かない（INV-30）。監査ログは追記のみ。
 *
 * **古い順。** §3.8 は回数を数えるだけだが、§3.10 は「清掃完了より後」を
 * 見るので時刻の並びに意味がある。
 */
export async function listAuditLogs(env: Env, ctx: TenantContext, filter: AuditLogFilter) {
  assertIdBelongsToTenant(filter.propertyId, ctx);
  if (filter.actions.length === 0) return [];

  const db = await getTenantDb(env, ctx);
  return db
    .select({
      id: auditLog.id,
      propertyId: auditLog.propertyId,
      actorId: auditLog.actorId,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      before: auditLog.before,
      after: auditLog.after,
      at: auditLog.at,
    })
    .from(auditLog)
    .where(
      withTenantScope(
        auditLog,
        ctx,
        auditLog.propertyId,
        eq(auditLog.propertyId, filter.propertyId),
        inArray(auditLog.action, [...filter.actions]),
        gte(auditLog.at, filter.from),
        lte(auditLog.at, filter.to),
      ),
    )
    .orderBy(auditLog.at, auditLog.id)
    .limit(filter.limit ?? 1000);
}
