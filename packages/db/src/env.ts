/**
 * Workers の binding 定義。`apps/web/wrangler.toml` と 1 対 1 で対応する。
 *
 * 仕様: docs/PK-SPEC-P0.md §19.2, §19.10
 * ルール: .claude/rules/architecture.md §1, §5
 *
 * ここに置いてある理由:
 *   architecture.md §1 と §19.3 が `packages/db/src/router.ts` に
 *   `getTenantDb(env: Env, ctx)` を置くと定めている。`packages/*` から
 *   `apps/*` を import することはできないため、Env は db 側に置く。
 *
 * 使うときの MUST:
 *   アプリケーションコードは `env.SHARD_XX` に直接触らない。
 *   シャードの解決は `packages/db/src/router.ts` の `getTenantDb()` のみが行う
 *   （P0-03 で実装。ESLint `no-direct-shard-access` で強制するのは P0-04）。
 */

/** D1 シャードの binding。SHARD_COUNT を超える番号は実行環境に存在しない。 */
export interface ShardBindings {
  SHARD_00: D1Database;
  SHARD_01?: D1Database;
  SHARD_02?: D1Database;
  SHARD_03?: D1Database;
  SHARD_04?: D1Database;
  SHARD_05?: D1Database;
  SHARD_06?: D1Database;
  SHARD_07?: D1Database;
  SHARD_08?: D1Database;
  SHARD_09?: D1Database;
  SHARD_10?: D1Database;
  SHARD_11?: D1Database;
  SHARD_12?: D1Database;
  SHARD_13?: D1Database;
  SHARD_14?: D1Database;
  SHARD_15?: D1Database;
}

/**
 * R2 バケット。
 *
 * キー体系と保持期間は .claude/rules/security.md §4 を参照。
 * 写真の EXIF GPS はクライアントとサーバーの両方で除去してから置くこと。
 */
export interface BucketBindings {
  /** 清掃写真。`photos/{orgId}/{propertyId}/{businessDate}/{taskId}/{photoId}.jpg` */
  PHOTOS: R2Bucket;
  /** 発行済み帳票の PDF。物理削除しない（billing.md §2）。 */
  DOCUMENTS: R2Bucket;
  /** 証跡 ZIP。 */
  EVIDENCE: R2Bucket;
  /** 年次アーカイブの JSONL（PK-SPEC-P0 §19.7）。 */
  ARCHIVE: R2Bucket;
}

/** Workers KV。 */
export interface KvBindings {
  /** セッション実体。Cookie には署名付き ID のみ置く（security.md §2）。 */
  SESSION: KVNamespace;
  /** レート制限のカウンタ（security.md §8）。 */
  RATELIMIT: KVNamespace;
  /** 設定キャッシュ。一括更新・一括削除・TTL 失効の対象。 */
  CONFIG: KVNamespace;
  /** 外部連携の資格情報を暗号化して保持する。DB には平文を置かない（security.md §7）。 */
  CREDENTIALS: KVNamespace;
  /**
   * 組織 → シャードの明示マッピング（`shard:{organizationId}`）専用。
   *
   * MUST: TTL（`expirationTtl` / `expiration`）を設定しない。
   * このキーが失効しても `resolveShard()` はエラーにならず `fnv1a32` の
   * フォールバックに静かに落ちる。移送済みの組織なら以後の読み書きが
   * 移送前のシャードへ向かい、同一テナントのデータが複数シャードに分裂する。
   * この破損は無警告で進行する。
   *
   * 一括操作の対象になる `CONFIG` と同居させない。
   * architecture.md §1 / docs/DECISIONS.md #006 を参照。
   */
  SHARD_MAP: KVNamespace;
}

/**
 * Queue producer。用途は architecture.md §5 / PK-SPEC-P0 §19.10。
 *
 * CPU 50ms を超える処理はリクエストハンドラで実行せず、必ずここへ投げる。
 * メッセージ型は各コンシューマを実装する task が定義するため、現時点では unknown。
 */
export interface QueueBindings {
  /** 日報・請求書・領収書・監査レポートの PDF 生成。 */
  QUEUE_PDF_GENERATION: Queue;
  /** 証跡 ZIP 生成。 */
  QUEUE_EVIDENCE_EXPORT: Queue;
  /** 稼働照合バッチ（P4）。 */
  QUEUE_RECONCILIATION: Queue;
  /** 集計テーブルの更新。再計算方式で冪等に行う（architecture.md §3）。 */
  QUEUE_ROLLUP_UPDATE: Queue;
  /** 消耗基準値の再計算（P3）。 */
  QUEUE_BASELINE_LEARNING: Queue;
  /** メール・LINE 通知。 */
  QUEUE_NOTIFICATION: Queue;
  /** アーカイブ復元。 */
  QUEUE_ARCHIVE_RESTORE: Queue;
}

/**
 * Durable Objects。用途は architecture.md §4 / PK-SPEC-P0 §19.9 の 4 つに限る。
 *
 * **汎用のデータストアとして使わない。** 実装済みのものだけをここへ足すこと。
 * binding だけ先に宣言すると、クラスの無いまま wrangler が起動しなくなる。
 */
export interface DurableObjectBindings {
  /** 請求書・領収書・日報の連番採番（P0-17）。粒度は 組織 × 文書種別 × 年度。 */
  DOCUMENT_SEQUENCER: DurableObjectNamespace;
  /** 検査開始の排他制御（P2-03 / PK-SPEC-P2 §4.2）。粒度はタスク。 */
  INSPECTION_LOCK: DurableObjectNamespace;
  /** 照合バッチの二重起動防止（P4-05 / PK-SPEC-P4 §5.2）。粒度は施設 × 業務日。 */
  RECONCILIATION_LOCK: DurableObjectNamespace;
}

/** wrangler.toml の `[vars]`。値はすべて文字列で渡る。 */
export interface EnvVars {
  ENVIRONMENT: "local" | "preview" | "staging" | "production";
  /** 有効なシャード数。`Number()` で数値化して使う。local / preview は "1"。 */
  SHARD_COUNT: string;
  APP_BASE_URL: string;
  /**
   * 帳票メールの差出人（P5-07 / PK-SPEC-P5 §4.1 の ⑩）。
   *
   * **秘密ではないので `[vars]`。** Resend で検証済みのドメインの
   * アドレスであること。組織ごとに変えられる形にはしていない
   * （§2 に差出人を持つ列が無い / docs/OPEN_QUESTIONS.md #075）。
   */
  RESEND_FROM_ADDRESS: string;
}

/**
 * secret（`wrangler secret put` / ローカルは `.dev.vars`）。
 *
 * wrangler.toml には書かない。ひな形は `apps/web/.dev.vars.example`。
 */
export interface EnvSecrets {
  /** セッション ID の署名鍵。 */
  SESSION_SECRET: string;
  /** Resend の API キー。 */
  RESEND_API_KEY: string;
  /** CREDENTIALS KV に置く資格情報の暗号化鍵。 */
  CREDENTIAL_ENCRYPTION_KEY: string;
  /** Sentry の DSN。採用可否は PK-SPEC-P0 §20 で未決。 */
  SENTRY_DSN: string;
}

/** Worker が受け取る env の全体。 */
export interface Env
  extends ShardBindings,
    BucketBindings,
    KvBindings,
    QueueBindings,
    DurableObjectBindings,
    EnvVars,
    EnvSecrets {}
