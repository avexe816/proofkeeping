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
   * 運営面（`/plat/*`）で第 2 要素を要求するか（PF-19 / DECISIONS #250）。
   *
   * **既定は要求する。** `"false"` にできるのは production 以外だけで、
   * production は値を読まずに常に要求する（`lib/platform/twoFactorPolicy.ts`）。
   * 空・未設定・綴り違いはすべて「要求する」に倒れる。
   *
   * **2FA の実装・表・列は消していない。** 切っているのは
   * 「誰に `COMPLETE` の札を出すか」だけで、門（`COMPLETE` を要求すること）は
   * そのまま。再有効化の手順は `docs/runbook/platform-bootstrap.md` §10。
   */
  PLATFORM_2FA_REQUIRED: string;
  /**
   * 帳票メールの差出人（P5-07 / PK-SPEC-P5 §4.1 の ⑩）。
   *
   * **秘密ではないので `[vars]`。** Resend で検証済みのドメインの
   * アドレスであること。組織ごとに変えられる形にはしていない
   * （§2 に差出人を持つ列が無い / docs/OPEN_QUESTIONS.md #075）。
   */
  RESEND_FROM_ADDRESS: string;

  // ── メール送信（Lark Mail SMTP / P5-21・DECISIONS #248）──────
  //
  // **秘密は `SMTP_PASSWORD` だけ。** ホスト・ポート・利用者名・差出人は
  // 秘密ではないので `[vars]` に置く。**wrangler.toml を読めば
  // staging と production の向き先が分かる**形にして、取り違えを早く見つける。

  /** SMTP のホスト名（Lark Mail）。 */
  SMTP_HOST: string;
  /** SMTP のポート。**465 が第一候補**（implicit TLS）。文字列で持つ。 */
  SMTP_PORT: string;
  /**
   * TLS の掛け方。`implicit`（465）か `starttls`（587）。
   *
   * **未設定は `implicit`。** 465 が使えないと分かったときだけ
   * `starttls` へ倒す（**25 番は使わない**）。
   */
  SMTP_SECURE: string;
  /** SMTP の利用者名。Lark はメールアドレスをそのまま使う。 */
  SMTP_USERNAME: string;
  /**
   * 差出人（`From` ヘッダ）。`ProofKeeping <noreply@stek.ai>` の形。
   *
   * **提供者名を含めない名前にしてある** — 次に乗り換えるとき、
   * 名前を変えずに値だけ差し替えられる（`RESEND_FROM_ADDRESS` の反省）。
   */
  MAIL_FROM: string;
}

/**
 * secret（`wrangler secret put` / ローカルは `.dev.vars`）。
 *
 * wrangler.toml には書かない。ひな形は `apps/web/.dev.vars.example`。
 */
export interface EnvSecrets {
  /** セッション ID の署名鍵。 */
  SESSION_SECRET: string;
  /** Resend の API キー。**移行中のみ残す**（P5-21 / 削除は別途判断）。 */
  RESEND_API_KEY: string;
  /**
   * Lark Mail の SMTP authorization password（P5-21 / DECISIONS #248）。
   *
   * **メール送信で使う唯一の秘密。** `lib/mail/send.ts` から
   * `lib/mail/smtp.ts` へ渡る 1 本道だけで使い、**ログにも監査ログにも
   * 応答にも出さない**（`tests/security/mailSecrets.spec.ts` が走査）。
   *
   * `REQUIRED_SECRETS` には**入れない** — 無くて壊れるのはメールだけで、
   * 必須にすると鍵を置くまで全リクエストが 503 になる。
   * **未設定なら送信そのものを行わない**（`canSendMail()`）。
   */
  SMTP_PASSWORD: string;
  /**
   * SMTP の疎通確認（`POST /api/v1/dev/smtp-probe`）を開ける鍵。
   *
   * **置かなければ 404。** workflow（`.github/workflows/smtp-probe.yml`）が
   * 実行のたびに作って登録し、**終わったら消す**（PF-16 の管理鍵と同じ形 /
   * DECISIONS #247）。
   */
  SMTP_PROBE_TOKEN: string;
  /**
   * 送信経路の確認（`POST /api/v1/dev/smtp-send-test`）を開ける鍵（P5-23）。
   *
   * **置かなければ 404。** workflow（`.github/workflows/smtp-send-test.yml`）が
   * 実行のたびに作って登録し、**終わったら消す**（#247 の形）。
   *
   * `SMTP_PROBE_TOKEN` と分けてあるのは、**片方が開いたままでも
   * もう片方は開かない**ようにするため。疎通確認はメールを送らないが、
   * こちらは実際に 1 通送る。
   */
  SMTP_SEND_TEST_TOKEN: string;
  /**
   * Resend の webhook 署名鍵（P5-10 / security.md §7）。
   *
   * Svix 形式（`whsec_` + base64）。**署名の検証を必須にする**ので、
   * 未設定なら webhook は 401 を返す（検証を素通りさせない）。
   */
  RESEND_WEBHOOK_SECRET: string;
  /** CREDENTIALS KV に置く資格情報の暗号化鍵。 */
  CREDENTIAL_ENCRYPTION_KEY: string;
  /**
   * 運営担当者の TOTP secret の暗号化鍵（PF-17 / DECISIONS #244）。
   *
   * base64url の 32 バイト（AES-256-GCM）。**SESSION_SECRET を流用しない** —
   * 鍵は用途ごとに分け、片方の交代・流出がもう片方を巻き込まない形にする。
   * 使うのは `apps/web/src/lib/platform/totpSecretBox.ts` だけ。
   */
  TWO_FACTOR_ENCRYPTION_KEY: string;
  /** Sentry の DSN。採用可否は PK-SPEC-P0 §20 で未決。 */
  SENTRY_DSN: string;
  /**
   * staging でシード投入を許すための鍵（DECISIONS #189）。
   *
   * **これを置いた環境だけが `POST /api/v1/dev/seed` を受ける。**
   * 置かなければ staging でも 404 のままで、production と preview は
   * 鍵の有無に関わらず 404（環境名で先に落とす）。
   *
   * **staging 以外へ置かないこと。** 置いても経路は開かないが、
   * 「開くつもりで置いた」ことが後から読めなくなる。
   */
  STAGING_SEED_TOKEN: string;
  /**
   * 運営担当者の初期開通を開ける管理鍵（PF-16 / DECISIONS #245）。
   *
   * **これが置かれている環境だけが `POST /api/v1/platform/bootstrap` を
   * 受ける。** 置かなければ 404 のままで、**既定は閉じている。**
   *
   * `STAGING_SEED_TOKEN` と違い、**production にも置いてよい** —
   * 本番の 1 人目を作るための経路だから。ただし置きっぱなしにしない:
   * `platform-bootstrap.yml` が実行のたびに作って登録し、**終わったら消す。**
   * 手で登録した場合も、開通を確かめたら消すこと（runbook §6）。
   *
   * **`REQUIRED_SECRETS` に入れない。** 無くて閉じるのが正しい状態で、
   * 必須にすると鍵を置くまで全リクエストが 503 になる。
   */
  PLATFORM_BOOTSTRAP_TOKEN: string;
}

/**
 * 静的アセット（`[assets]` / `build/client`）。
 *
 * ── 何のために binding を持つのか ───────────────────────
 * 画面の配信そのものは binding を使わない（Worker より前に配られる）。
 * ここで要るのは **Queue コンシューマから和文書体を読む**ため
 * （`apps/web/src/lib/report/font.ts` / DECISIONS #256）。
 * **アセットはスクリプトの容量に数えられない。** 書体をスクリプトへ
 * 同梱すると無料枠の 3 MiB を超えてデプロイが通らない。
 *
 * **秘密を置かないこと。** アセットは認証なしで配信される
 * （`wrangler.toml` の `[assets]` の注記）。
 */
export interface AssetBindings {
  ASSETS: Fetcher;
}

/** Worker が受け取る env の全体。 */
export interface Env
  extends ShardBindings,
    BucketBindings,
    KvBindings,
    QueueBindings,
    DurableObjectBindings,
    AssetBindings,
    EnvVars,
    EnvSecrets {}
