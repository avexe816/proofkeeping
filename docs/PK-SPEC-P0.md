ProofKeeping 製品仕様書
PK-SPEC-P0 — Phase 0「基盤構築」 v1.1 改訂版
文書ID: PK-SPEC-P0
バージョン: v1.1（v1.0 からの破壊的変更を含む）
発行日: 2026-08-10
前版: v1.0（2026-08-10）
ステータス: 確定。v1.0 の §5.3 / §9 を本書で置き換える

0. 本改訂の要旨
0.1 何が変わったか
インフラを Neon PostgreSQL + Prisma + Vercel から フルスタック Cloudflare へ変更する。

領域	v1.0	v1.1
DB	Neon PostgreSQL	Cloudflare D1（16 シャード）
ORM	Prisma	Drizzle ORM
テナント分離	アプリ層 + Postgres RLS	アプリ層 + 物理シャード + CI 越境テスト
実行環境	Vercel	Cloudflare Workers
非同期処理	Vercel Cron	Cloudflare Queues + Cron Triggers
排他制御	DB トランザクション	Durable Objects
セッション	Upstash Redis	Workers KV
ストレージ	Cloudflare R2	Cloudflare R2（変更なし）
0.2 変更理由
容量が主たる理由。 500 テナント想定で日次約 190 万行が発生する。D1 は 1 データベース 10GB が上限であり、この上限は引き上げられない。単一 DB では約 26 日で枯渇するため、シャーディングは選択肢ではなく前提条件となる。

Postgres を採用しても同じ規模ではいずれ分割が必要になる。ならば分散を設計思想に持つ D1 を最初から採るほうが、後戻りが小さい。

副次的な理由:

エッジ読み取り 1〜5ms、コールドスタートほぼゼロ。現場スタッフ 30 名の同時操作に適する。

500 テナントで月額約 $530。RLS 構成とほぼ同等だが、運用要素が少ない。

Workers / D1 / R2 / Queues / DO / KV が単一課金・単一デプロイに収まる。

0.3 失うもの（明示的に受容する）
Postgres RLS が使えない。 DB がクエリの書き漏れを兜底する仕組みは存在しない。

同一シャード内の越境は物理的に防げない。 1 シャードに約 31 テナントが同居する。

テナント横断の JOIN ができない。 集計は別テーブルで持つ。

マイグレーションが 16 回必要。 部分失敗時のバージョン不整合に備える必要がある。

上記を補うため、§19 の三重防御を MUST として課す。

19. シャーディング構成とテナント分離（新設）
19.1 全体構成
text
                    Cloudflare Workers（Hono）
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   Shard Router          Queue Producer       DO Namespace
        │                     │                     │
        v                     v                     v
  D1 SHARD_00..15      PDF / ZIP / 照合      客室状態・検査ロック
        │                     │
        └──────────┬──────────┘
                   v
              R2 Buckets
       photos/ documents/ evidence/ archive/
                   │
              Workers KV
        session / ratelimit / config cache
19.2 シャード数と割当
text
SHARD_COUNT = 16（固定）

shardIndex = fnv1a32(organizationId) % SHARD_COUNT
MUST:

シャード数は 16 で固定する。実行時に増減しない。

全 16 個の binding を wrangler.toml に静的宣言する。動的な D1 作成は行わない。

開発・検証環境では SHARD_COUNT を 1 とし、SHARD_00 のみを使う。同じルーティングコードが動くこと。

text
# wrangler.toml
[[d1_databases]]
binding = "SHARD_00"
database_name = "pk-shard-00"
database_id = "..."

# SHARD_01 〜 SHARD_15 を同様に宣言
容量試算

項目	値
1 シャードあたりテナント数	約 31（500 テナント時）
1 テナント年間データ量	約 100MB
1 シャード想定使用量	約 3.1GB / 年
上限到達までの猶予	約 3 年
3 年以内に年次アーカイブ（§19.7）を運用に乗せることで、恒久的に上限内へ収める。

19.3 シャードルーター
ts
// packages/db/src/router.ts

const SHARD_COUNT = 16;

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function shardIndexOf(organizationId: string): number {
  return fnv1a32(organizationId) % Number(SHARD_COUNT);
}

export function getShardBinding(env: Env, organizationId: string): D1Database {
  const idx = shardIndexOf(organizationId);
  const key = `SHARD_${String(idx).padStart(2, "0")}` as keyof Env;
  const db = env[key] as D1Database | undefined;
  if (!db) throw new Error(`SHARD_BINDING_MISSING:${key}`);
  return db;
}

/// アプリケーションコードが唯一使ってよい入口
export function getTenantDb(env: Env, ctx: TenantContext) {
  return drizzle(getShardBinding(env, ctx.organizationId), { schema });
}
MUST:

アプリケーションコードは getTenantDb() のみを使う。

env.SHARD_* への直接アクセスを ESLint ルール no-direct-shard-access で禁止する。

例外は packages/db/src/router.ts、マイグレーションランナー、シードのみ。

19.4 三重防御（RLS の代替）
Postgres RLS を失う代わりに、以下 3 層をすべて MUST とする。1 つでも欠ければテナント分離は成立しない。

第 1 層 — リポジトリ層の強制注入
すべてのクエリはリポジトリ関数を経由する。リポジトリは TenantContext を必須引数に取り、organizationId 条件を自動付与する。

ts
// packages/db/src/repositories/task.ts
export async function findTasks(
  env: Env,
  ctx: TenantContext,
  filter: TaskFilter
) {
  const db = getTenantDb(env, ctx);
  return db.select().from(tasks).where(
    and(
      eq(tasks.organizationId, ctx.organizationId),   // 常に強制
      scopeToProperties(ctx),                          // 施設スコープロール対応
      ...buildFilter(filter)
    )
  );
}
MUST:

API ハンドラから Drizzle のクエリビルダを直接呼ばない。

リポジトリ以外のファイルで drizzle( を呼ぶことを lint で禁止する。

organizationId の値はセッションからのみ取得する。リクエストボディ・クエリパラメータ・パス変数から採用しない。

第 2 層 — ID の自己記述化
すべての主キーにテナント識別子を埋め込む。

text
形式: {orgShortId}__{entityPrefix}_{ulid}
例:   o7k2m9__task_01JBXQ3ZK8N4P2VYR6

orgShortId    : 組織作成時に採番する 6 桁の英数字（衝突チェック済）
entityPrefix  : task / insp / evd / lost / issue / inv / rcp ...
ulid          : 時系列ソート可能な 26 桁
MUST:

URL やリクエストで ID を受け取ったら、まず orgShortId を抽出しセッションの組織と照合する。

不一致なら DB へ問い合わせる前に 404 を返す（403 は存在を示唆するため使わない）。

この検証は withResourceGuard() ミドルウェアで一元化する。

ts
export function assertIdBelongsToTenant(id: string, ctx: TenantContext) {
  const [orgShortId] = id.split("__");
  if (orgShortId !== ctx.orgShortId) {
    throw new NotFoundError("RESOURCE_NOT_FOUND");
  }
}
第 3 層 — CI での越境テスト
RLS の「実行時に必ず効く」性質を、CI の「マージ前に必ず検証する」で代替する。

MUST: 全テーブルについて以下 4 パターンのテストを用意し、1 件でも失敗したらマージ不可とする。

ts
// tests/tenant-isolation/[table].spec.ts

describe("tenant isolation: cleaningTask", () => {
  it("別組織の ID を指定すると 404", async () => { ... });
  it("別組織のレコードが一覧に混入しない", async () => { ... });
  it("同一シャードに同居する組織のデータが漏れない", async () => { ... });
  it("施設スコープロールが担当外施設を取得できない", async () => { ... });
});
MUST: 第 3 のテストは意図的に同一シャードへ配置した 2 組織で行う。異なるシャードのテナント同士では物理的に到達不能なため、テストとして意味を持たない。

ts
// テスト用: 同一シャードに落ちる組織 ID のペアを事前計算して固定する
export const SAME_SHARD_ORG_PAIR = {
  a: "org_testA_shard07",
  b: "org_testB_shard07",
} as const;
19.5 禁止事項
MUST NOT:

テナント横断の JOIN・集計クエリを書かない。 組織単位のダッシュボードはシャード内で完結する。プラットフォーム全体の統計は §19.6 の集計テーブルを使う。

organizationId 列を省略しない。 物理的にシャード分離されていても全テーブルに保持する。将来の再シャーディングと移行の唯一の手がかりになる。

シャードをまたぐトランザクションを設計しない。 D1 はシャード間の分散トランザクションを提供しない。

organizationId をリクエストから受け取らない。

シャード番号を URL・レスポンス・ログに露出しない。 内部実装の詳細である。

19.6 集計テーブル
組織横断（プラットフォーム運営者向け）および組織内の全施設横断（オーナー向け）の集計は、非同期で維持する専用テーブルで行う。

ts
// 各シャードに配置。組織単位の集計はシャード内で完結する
export const dailyPropertyRollup = sqliteTable("daily_property_rollup", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  propertyId: text("property_id").notNull(),
  businessDate: text("business_date").notNull(),
  totalTasks: integer("total_tasks").notNull().default(0),
  completedTasks: integer("completed_tasks").notNull().default(0),
  reworkTasks: integer("rework_tasks").notNull().default(0),
  totalMinutes: integer("total_minutes").notNull().default(0),
  openIssues: integer("open_issues").notNull().default(0),
  findingsHigh: integer("findings_high").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  uq: uniqueIndex("uq_rollup").on(t.propertyId, t.businessDate),
  idxOrg: index("idx_rollup_org").on(t.organizationId, t.businessDate),
}));
更新は Queue コンシューマが行う。

text
タスク完了 / 検査完了 / 照合完了
  → Queue: rollup-update { organizationId, propertyId, businessDate }
  → コンシューマがシャード内で再集計して UPSERT
MUST: ロールアップは冪等。同じメッセージを複数回処理しても結果が変わらないこと（再計算方式にする。インクリメント方式にしない）。

19.7 年次アーカイブ
シャードの 10GB 上限に到達させないため、以下を年次で実行する。

text
対象: businessDate が 13 か月以上前のレコード
  - cleaningTask / taskTimeLog / taskChecklistResult
  - inspection / inspectionItemResult
  - roomObservation / linenRecord（P3 以降）
  - occupancySnapshot / physicalSignal（P4 以降）

処理:
  1. R2 へ JSONL 形式でエクスポート
     archive/{orgId}/{year}/{table}.jsonl.gz
  2. SHA-256 を計算して archive_manifest テーブルへ記録
  3. D1 から DELETE
  4. VACUUM 相当の処理（D1 の Time Travel 設定に注意）

除外（アーカイブしない）:
  - evidenceSnapshot のハッシュ行（payload は元から R2）
  - auditLog（別途 5 年保持）
  - invoice / receipt（法定保存期間に従う）
  - organization / property / room などマスタ
MUST: アーカイブ済みデータへのアクセス要求があった場合、R2 から復元して閲覧する専用画面を用意する（P7）。削除ではなく退避であることを UI で明示する。

19.8 マイグレーション運用
text
pnpm db:migrate --env production
  → SHARD_00 から SHARD_15 まで順次実行
  → 各シャードの schema_version を記録
  → 1 つでも失敗したら以降を中止し、失敗シャード番号を出力
MUST:

マイグレーションは後方互換のみとする。列の削除・リネーム・型変更を単一リリースで行わない。

破壊的変更は 3 段階で行う。①新列追加 → ②両方書き込み・新列から読む → ③旧列削除（次リリース以降）。

全シャードの schema_version が一致していることを起動時ヘルスチェックで検証する。不一致なら書き込み系 API を 503 にする。

19.9 Durable Objects の用途
以下に限定して使う。汎用データストアとして使わない。

用途	DO 名前空間	インスタンス粒度
検査開始の排他制御	InspectionLock	タスク単位
客室ステータスのリアルタイム配信	PropertyBoard	施設単位
書類番号の採番	DocumentSequencer	組織×文書種別×年度
照合バッチの二重起動防止	ReconciliationLock	施設×業務日
MUST: DocumentSequencer を DO で実装する。請求書・領収書の連番は欠番・重複が許されず、D1 のトランザクションだけでは並列採番を保証できないため。

19.10 Queues の用途
キュー	用途	想定処理時間
pdf-generation	日報・請求書・領収書・監査レポート PDF	5〜30 秒
evidence-export	証跡 ZIP 生成	10〜60 秒
reconciliation	稼働照合バッチ（P4）	施設あたり 5〜20 秒
rollup-update	集計テーブル更新	1 秒未満
baseline-learning	消耗基準値の再計算（P3）	30〜120 秒
notification	メール送信・LINE 通知	1〜3 秒
MUST: CPU 時間が 50ms を超える処理は Workers のリクエストハンドラ内で実行せず、必ず Queue へ投げる。

19.11 コスト前提
500 テナント（1,500 施設・60,000 室）想定の月額。

項目	概算
Workers Paid 基本料	$5
Workers リクエスト超過	約 $24
D1 書き込み行超過	約 $7
D1 ストレージ	約 $30
R2 ストレージ（写真 6 か月保持）	約 $220
R2 Class A 操作	約 $18
Queues	約 $1
Durable Objects	約 $10
合計	約 $315
写真保持期間を 13 か月にすると R2 が約 $450 となり、総額は約 $530 になる。既定保持期間は 6 か月とし、13 か月は上位プランのオプションとする。

5.3 テナント分離（v1.0 を全面置換）
v1.0 §5.3 に記載した Prisma $extends および PostgreSQL RLS の記述はすべて無効とする。本書 §19.3 および §19.4 を正とする。

9. 技術スタック（v1.0 を全面置換）
text
実行環境        : Cloudflare Workers（Hono）
フロント        : Remix on Workers または Next.js on OpenNext
                  ※ 決定は §20 の未決事項
UI              : Tailwind CSS + shadcn/ui + Radix
データ取得      : TanStack Query
検証            : Zod（packages/contracts が唯一の定義）
DB              : Cloudflare D1 × 16 シャード
ORM             : Drizzle ORM
排他・実時間     : Durable Objects
非同期          : Cloudflare Queues + Cron Triggers
セッション・KV   : Workers KV
ストレージ      : Cloudflare R2
メール          : Resend（Workers から HTTP 送信）
PDF             : @react-pdf/renderer（Queue コンシューマ内で実行）
エラー追跡      : Sentry（Cloudflare 対応 SDK）
リポジトリ      : GitHub monorepo（pnpm）
CI/CD           : GitHub Actions → wrangler deploy
9.1 ディレクトリ構成（改訂）
text
proofkeeping/
├─ apps/
│  └─ web/                      Workers エントリ + UI
│     ├─ src/
│     │  ├─ routes/
│     │  │  ├─ m/               モバイル
│     │  │  ├─ app/             PC 管理
│     │  │  └─ api/v1/          REST
│     │  ├─ middleware/
│     │  │  ├─ session.ts
│     │  │  ├─ tenant.ts        TenantContext 構築
│     │  │  └─ resourceGuard.ts ID の自己記述検証
│     │  └─ consumers/          Queue コンシューマ
│     └─ wrangler.toml
├─ packages/
│  ├─ db/
│  │  ├─ src/router.ts          シャードルーター
│  │  ├─ src/schema/            Drizzle スキーマ
│  │  ├─ src/repositories/      唯一のクエリ入口
│  │  └─ migrations/
│  ├─ contracts/                Zod
│  ├─ engine/                   稼働照合（P4）
│  ├─ pdf/                      帳票テンプレート（P2 以降）
│  └─ config/
├─ tests/
│  └─ tenant-isolation/         全テーブル分の越境テスト
└─ docs/
9.2 環境
環境	Workers	D1	備考
production	pk-prod	16 シャード	手動デプロイ
staging	pk-staging	2 シャード	main マージで自動
preview	pk-pr-{n}	1 シャード	PR ごと
local	wrangler dev	1 シャード（miniflare）	シード済み
13. 受け入れ基準（改訂・追加分）
v1.0 §13 に以下を追加する。RLS 関連の項目は削除する。

13.8 シャーディング
SHARD_COUNT = 1 と 16 の両方で全テストが通る

env.SHARD_* への直接アクセスが ESLint で検出される

リポジトリ以外での drizzle( 呼び出しが ESLint で検出される

100 組織を作成し、16 シャードへの分散が均等（最大偏差 ±30% 以内）

同一シャードに配置した 2 組織間で越境が発生しない

ID の orgShortId 不一致時に DB 問い合わせ前に 404 が返る

全 16 シャードのマイグレーションが順次実行され、失敗時に中止する

schema_version 不一致時に書き込み系 API が 503 を返す

13.9 Durable Objects
DocumentSequencer で 500 並列採番しても欠番・重複が出ない

InspectionLock で同時検査開始が 1 件のみ成功する

13.10 Queues
CPU 50ms 超の処理がリクエストハンドラに存在しない（静的検査 + 実測）

Queue メッセージの重複配信で結果が変わらない（冪等性）

20. 未決事項（追加分）
v1.0 §15 に以下を追加する。

フロントエンドフレームワークを Remix on Workers とするか、Next.js を OpenNext で載せるか。Workers 上での安定性と DX を 1 週間で技術検証して決める。

Sentry を使うか、Cloudflare の Workers Observability に寄せるか。

シャード数 16 が将来不足した場合の再シャーディング手順。現状は「1 テナント単位で別シャードへ移送するスクリプト」を想定するが未設計。

アーカイブ済みデータの閲覧 UI を P7 に置くか、需要が出るまで作らないか。

写真の既定保持期間を 6 か月とすることの顧客受容性。清掃会社が請求根拠として 13 か月を求める可能性がある。

21. 改訂履歴
バージョン	日付	変更内容
v1.0	2026-08-10	初版確定
v1.1	2026-08-10	インフラをフルスタック Cloudflare へ変更。§19 シャーディング構成を新設。§5.3 テナント分離と §9 技術スタックを全面置換。RLS 依存を廃止し三重防御へ移行。§13.8〜13.10 を追加。
22. Claude Code 作業指示（v1.1 差分）
text
# ProofKeeping — Phase 0 v1.1

## v1.0 からの変更
- Prisma / Neon / Vercel の記述はすべて無効。
- D1 + Drizzle + Workers で実装する。
- Postgres RLS は使わない。§19.4 の三重防御を実装する。

## 最優先タスク（他より先に着手）
1. packages/db/src/router.ts のシャードルーター
2. リポジトリ層の雛形と ESLint ルール 2 種
3. ID 採番（orgShortId + entityPrefix + ULID）
4. withResourceGuard ミドルウェア
5. tests/tenant-isolation/ の雛形（同一シャード組織ペアを含む）

これらが動く前に業務ロジックを一切書かない。

## 絶対ルール（追加）
- env.SHARD_* に直接アクセスしない。getTenantDb() のみ。
- リポジトリ以外で drizzle() を呼ばない。
- テナント横断の JOIN・集計を書かない。
- organizationId をリクエストから受け取らない。
- シャード番号を外部へ露出しない。
- CPU 50ms 超の処理を Queue へ逃がす。
- 破壊的なマイグレーションを単一リリースで行わない。