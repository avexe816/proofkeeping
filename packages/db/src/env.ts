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
  /**
   * 組織 → シャードの明示マッピング（`shard:{organizationId}`）と設定キャッシュ。
   *
   * architecture.md §1 のコード例は binding 名 `KV` を使っているが、
   * その名前の namespace は存在しない。docs/OPEN_QUESTIONS.md #006 を参照。
   */
  CONFIG: KVNamespace;
  /** 外部連携の資格情報を暗号化して保持する。DB には平文を置かない（security.md §7）。 */
  CREDENTIALS: KVNamespace;
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

/** wrangler.toml の `[vars]`。値はすべて文字列で渡る。 */
export interface EnvVars {
  ENVIRONMENT: "local" | "preview" | "staging" | "production";
  /** 有効なシャード数。`Number()` で数値化して使う。local / preview は "1"。 */
  SHARD_COUNT: string;
  APP_BASE_URL: string;
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
  extends ShardBindings, BucketBindings, KvBindings, QueueBindings, EnvVars, EnvSecrets {}
