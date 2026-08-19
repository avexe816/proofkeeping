# ProofKeeping

清掃記録を、稼働の証跡に。株式会社ステック（stek.ai）

## このファイルの役割

プロジェクト全体で常に有効な最小限のルールのみを記載する。
詳細は `.claude/rules/` と `docs/` を参照すること。**このファイルは 200 行を超えない。**

---

## 1. 作業の進め方（MUST）

1. **必ず `docs/tasks/` の task ファイルを 1 つ選んでから作業を始める。** task ID のない作業をしない。
2. 作業前に必ず **plan mode** で「変更するファイル一覧」「追加する API」「追加するテスト」を提示し、承認を待つ。
3. 1 task = 1 PR = 1 セッション。差分は 800 行以内を目安にする。
4. task に書かれていないことを実装しない。判断が必要になったら `docs/OPEN_QUESTIONS.md` に追記して**作業を止める**。推測で実装しない。
5. コンテキストが 60% を超えたら `docs/PROGRESS.md` に進捗を書き出し、セッションを終了する。
6. task 完了時は必ず `docs/PROGRESS.md` のチェックを更新する。

---

## 2. 技術スタック（変更禁止）

```
実行環境   Cloudflare Workers（Hono）
DB         Cloudflare D1 × 16 シャード
ORM        Drizzle ORM
検証       Zod（packages/contracts が唯一の定義）
UI         Tailwind CSS + shadcn/ui
排他・実時間 Durable Objects
非同期      Cloudflare Queues + Cron Triggers
KV         Workers KV（セッション・レート制限・認証情報）
ストレージ  Cloudflare R2
メール      Resend
PDF        @react-pdf/renderer（Queue コンシューマ内のみ）
CI/CD      GitHub Actions → wrangler deploy
テスト      Vitest（unit）/ Playwright（E2E）
```

**Prisma / Neon / Vercel / PostgreSQL RLS は使わない。** PK-SPEC-P0 v1.0 の記述は無効。

---

## 3. ディレクトリ

```
apps/web/src/
  routes/m/        モバイル（清掃現場）
  routes/app/      PC 管理画面
  routes/api/v1/   REST API
  middleware/      session / tenant / resourceGuard
  consumers/       Queue コンシューマ
packages/
  db/              schema / repositories / router / migrations
  contracts/       Zod スキーマ
  engine/          稼働照合（純粋関数・依存ゼロ）
  billing/         料金計算（純粋関数・依存ゼロ）
  integrations/    外部連携アダプタ
  pdf/             帳票テンプレート
tests/tenant-isolation/   全テーブルの越境テスト
docs/                     仕様・task・進捗
```

---

## 4. 絶対禁止事項（全フェーズ共通）

これらに違反した PR はマージ不可。

### アーキテクチャ
- `env.SHARD_*` に直接アクセスしない。`getTenantDb(env, ctx)` のみ。
- リポジトリ層以外で `drizzle(` を呼ばない。
- `organizationId` をリクエストボディ・クエリ・パスから受け取らない。セッションから解決する。
- テナント横断の JOIN・集計クエリを書かない。集計は rollup テーブルを使う。
- シャード番号を URL・レスポンス・ログに露出しない。
- CPU 50ms 超の処理をリクエストハンドラで実行しない。Queue へ投げる。

### データ
- 宿泊者の氏名・連絡先・パスポート情報を保存するカラムを作らない。
- 発行済み帳票（請求書・領収書・日報・証跡）の DELETE / UPDATE API を作らない。
- `EvidenceSnapshot` を UPDATE / DELETE しない。訂正は新レコード追加。
- 写真の EXIF GPS を保存しない。クライアントとサーバーの両方で除去する。
- 金額計算に浮動小数点を使わない。すべて整数（円）。

### UI・表現
- JSX に日本語を直書きしない。すべて i18n キー経由。
- 「不正」「検知」「監視」「疑わしい」を UI・API・PDF に出さない。
- 個人ランキング・最速ランキング・自動評価を作らない。
- `CLEANER` ロールに差異レポートを見せない（404 を返す。403 は存在を示唆する）。

### 実装手法
- `getUserMedia()` でカメラを実装しない。`input[type=file][capture]` を使う。
- Background Sync API に依存しない。自前の IndexedDB キューを使う。
- Web Push を業務フローの必須要素にしない。
- AI による自動判定・画像判定を実装しない。

---

## 5. 必ず守るコード規約

- TypeScript strict。`any` の新規追加禁止。`unknown` + Zod で絞る。
- API の入出力は `packages/contracts` の Zod スキーマ経由。型の二重定義をしない。
- 状態変更 API は `Idempotency-Key` ヘッダに対応する。
- 破壊的操作には必ず `recordAudit(ctx, {...})` を呼ぶ。
- `packages/engine` と `packages/billing` に DB・fetch・環境変数・`Date.now()` を持ち込まない。現在時刻は `ctx.now` で注入する。
- 権限判定はサーバー側 `assertPermission(ctx, action, target)` で行う。フロントの非表示は権限制御とみなさない。

---

## 6. 詳細ルール

| ファイル | 内容 | 読むべきとき |
|---|---|---|
| `.claude/rules/workflow.md` | **セッション自走・PR 作成・CI 監視・マージ・停止条件** | **すべてのセッション開始時に必読** |
| `.claude/rules/architecture.md` | シャード・テナント分離・ID 採番 | DB・API を触るとき |
| `.claude/rules/security.md` | 権限・個人情報・認証 | 認証認可・写真・ログを触るとき |
| `.claude/rules/ui-writing.md` | UI 文言・現場 UX・i18n | 画面を作るとき |
| `.claude/rules/testing.md` | テスト方針・必須テスト | すべての PR |
| `.claude/rules/billing.md` | インボイス・電帳法・端数処理 | 請求・領収を触るとき |
| `docs/PK-IMPL-CONTRACT.md` | **不変条件 INV-01〜37・データ辞書・権限マトリクス・禁止語** | **すべての PR。第11章は実装前に必読** |

---

## 7. 仕様書

| 文書 | フェーズ | 期間 |
|---|---|---|
| `docs/PK-SPEC-P0.md` v1.2 | 基盤構築 | M1 |
| `docs/PK-SPEC-P1.md` v1.1 | 清掃現場の最小成立 | M2–M3 |
| `docs/PK-SPEC-P2.md` v1.0 | 検査と証跡 | M4 |
| `docs/PK-SPEC-P3.md` v1.0 | 観察記録とベースライン | M5 |
| `docs/PK-SPEC-P4.md` v1.0 | 稼働照合エンジン | M6–M7 |
| `docs/PK-SPEC-P5.md` v1.0 | 請求・領収・多施設 | M8–M9 |
| `docs/PK-SPEC-P6.md` v1.0 | 外部連携と拡張 | M10–M11 |
| `docs/PK-SPEC-P7.md` v1.0 | GA とスケール | M12 |
| `docs/PK-SPEC-P8.md` v1.0 | Workforce と Inventory | GA後3〜6か月 |
| `docs/PK-SPEC-PAY.md` v1.0 | スタッフ支払集計（P8 から先行切り出し） | P5-18 |

### UI 関連（画面を作るときは必読）

| 文書 | 内容 |
|---|---|
| `docs/PK-IMPL-CONTRACT.md` | 実装契約。**仕様書と矛盾した場合はこちらを優先** |
| `docs/PK-SPEC-UI.md` | 清掃員モバイル 16 画面の設計説明書 |
| `docs/PK-SPEC-UI-A01.md` | v3 レイアウト標準（PC 全画面）。既存画面設計に優先する |
| `docs/PK-BIZ-PLAN.md` | 版数構成（Base/Pro/Ent）と課金単位 |
| `ui-prototypes/` | HTML プロトタイプ **55 画面 / 33 ファイル**。**見た目の正はここ** |

- モバイル 16 画面は 1 ファイル 1 画面、PC 36 画面は 1 ファイルに 3〜4 画面を収めている。内訳は `ui-prototypes/README.md` を見ること。
- `ui-prototypes/_archive/` は初期検討版。**実装の参照に使わないこと。**

**仕様の唯一の正は上記。** 本ファイルと矛盾する場合は仕様書を優先し、矛盾自体を `docs/OPEN_QUESTIONS.md` に報告する。

---

## 8. よく使うコマンド

**すべてリポジトリルートで実行する。** script はルートの `package.json` にしかなく、
`apps/web` などで叩くと `Command "..." not found` になる（`pnpm -w <script>` なら
どこからでも通る）。`db:seed` は未配線（OPEN_QUESTIONS #031）。

```bash
pnpm dev                    # wrangler dev（SHARD_COUNT=1）
pnpm db:generate            # Drizzle スキーマ → migration
pnpm db:migrate --env local # ローカル DB へ適用
pnpm db:seed                # シードデータ投入
pnpm test                   # Vitest
pnpm test:isolation         # テナント越境テストのみ
pnpm test:e2e               # Playwright
pnpm lint                   # ESLint（カスタムルール含む）
pnpm typecheck              # tsc --noEmit
pnpm check                  # lint + typecheck + test を一括
```

**PR を出す前に必ず `pnpm check` を通すこと。**

---

## 9. フェーズ着手条件

- **P4 は P3 リリースから 4 週間以上経過**し、観察記録の入力率 95% 以上、ベースラインの 80% が `isReliable` になるまで着手しない。
- **P2 は P1 の現場出荷判定**（自社施設で 2 週間、紙を全廃）を通過するまで着手しない。
- **P7 は新機能を追加しない。** 既存機能の完成度を上げるフェーズ。
- **P8 は P7-17 の GA 判定**（有償顧客 5 社稼働）を通過するまで着手しない。Workforce と Inventory は購入の決定理由ではないため、コア機能を固めてから追加する。
  - **例外（オーナー指示 2026-08-19）**: 支払集計（タスク実績×単価＋調整行→支払明細書。控除は範囲外）は P8 から切り出し、`docs/PK-SPEC-PAY.md` v1.0 の下で **P5-18 として先行実装する**。給与計算・社会保険・年末調整を作らない原則（PK-SPEC-P8 §1.2）は変わらない。
- **`docs/tasks/` に P8 の task ファイルは意図的に存在しない。** P8 の 9 項目は `docs/PROGRESS.md` にチェックボックスだけを置いてあり、GA 判定通過後に task 化する。**GA 判定前に P8 の task ファイルを作成しないこと**（上記の支払集計は P8 の task ではなく P5-18）。
