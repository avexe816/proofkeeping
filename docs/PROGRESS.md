# 実装進捗

最終更新: 2026-08-11（P0-08 完了）

## 現在のセッション

```
task: P0-08 認証: orgShortId + スタッフ番号 + パスワード
状態: 完了。ログイン識別子を 3 フィールド（orgShortId + スタッフ番号 + 認証情報）に確定し、
      OPEN_QUESTIONS #014 を解決した（DECISIONS #018）。組織の解決は既存の
      lookupOrganizationId()（SHARD_00 の org_directory）で足り、email_directory は作っていない。
      パスワードのハッシュは PBKDF2-SHA256 210,000 回へ変更（DECISIONS #019）。
      bcrypt は Workers に純 JS 実装しか無く、cost 12 で 1 回 344ms（実測）で
      CLAUDE.md §4 の CPU 予算を守れないため。security.md §2 を同じ PR で改訂した。
      セッションは KV（sess:）+ 署名付き pk_session Cookie。識別情報のみを保存し、
      role / allowedPropertyIds は焼き込まない（DECISIONS #020）。
      テスト 138 件を追加し、pnpm check（lint + typecheck + test 421 件）が通る。
次: P0-09 認証: PIN ログイン。着手前に OPEN_QUESTIONS #017（PIN のハッシュ方式）の判断が要る。
申し送り A: **ShardContext を取ってよい関数が 2 → 4 に増えた。**
            findUserByStaffNumber / recordLoginAttempt を足した（認証成立前に動くため）。
            repositories.spec.ts が 4 つに固定している。**これ以上増やさないこと。**
            ログイン後に動く関数は必ず TenantContext を要求する。
申し送り B: **ログイン失敗 5 回目の監査ログ（security.md §6）は書いていない。**
            recordAudit() が P0-11 で未実装のため。P0-11 は
            apps/web/src/lib/auth/login.ts の registerFailure() にコメントで
            置いた箇所へ追記すること。
申し送り C: **user.staff_number は全ロールで必須になった。** 列は後方互換のため
            null 許容のままだが、認証経路が null を弾く。P0-18 の seed と
            将来の招待画面は**必ずスタッフ番号を採番すること。**
申し送り D: パスワード設定は setUserPassword()（apps/web/src/lib/auth/setPassword.ts）を通す。
            リポジトリの setPasswordHash() を直接呼ぶと、10 文字ポリシーと
            直近 3 世代の再利用禁止が両方外れる。
申し送り E: セッション middleware（Cookie → TenantContext）は **P0-10 の所有**。
            P0-08 は readSession() が識別情報を返すところまで。
            TenantContext は findMembershipByUserId + listAssignedPropertyIds から毎回組み立てる。
申し送り F: レート制限（KV RATELIMIT）は固定窓で**厳密ではない**。
            KV の read-modify-write が原子的でないため、同時到着で上限を数回超えうる。
            厳密化には DO が要るが architecture.md §4 が 4 用途に限定している。
            個別アカウントの保護はロック（10 回で 30 分）が担う。
--- P0-07 からの申し送り（継続）---
task: P0-07 リポジトリ層の雛形
状態: 完了。packages/db/src/repositories/ に base / organization / user / property / room を
      実装した。全クエリの where は withTenantScope() が組み立て、
      organizationId 条件と施設スコープを必ず載せる。TenantContext に
      role / allowedPropertyIds / now を追加し、シャード解決だけに要る最小限を
      ShardContext として切り出した（DECISIONS #016）。
      テスト 47 件を追加し、pnpm check（lint + typecheck + test 270 件）が通る。
次: （P0-08 で消化済み）
申し送り 1: **リポジトリ関数を追加したら repositories.spec.ts の INVOCATIONS に
            1 行足すこと。** モジュールの export を走査しているため、登録が無い関数が
            あるとテストが落ちる。登録すれば「organization_id 条件つきの SQL を発行する」
            「越境 ID で DB へ触れずに NotFoundError」が自動で掛かる。
申し送り 2: **ShardContext を取ってよいのは認証ブートストラップの関数だけ。**
            findMembershipByUserId / listAssignedPropertyIds。増やすと施設スコープの
            掛からない経路が広がる（DECISIONS #016）。
            P0-08 / P0-10 はこの 2 つから TenantContext を組み立てること。
            → **P0-08 で 4 つに増えた。上の申し送り A を読むこと。**
申し送り 3: **allowedPropertyIds の空配列は「全施設」ではなく「0 件」。**
            scopeToProperties() が恒偽（1 = 0）を返す（DECISIONS #017）。
            セッション構築側で「割当が無いから空にしておく」と書くと、
            そのユーザーは何も見えなくなる。それが正しい挙動。
申し送り 4: 組織全体ロールの列挙は base.ts の ORG_WIDE_ROLES（OWNER / ORG_ADMIN /
            AUDITOR）。**ここに無いロールは施設スコープ扱いになる。** ROLES に
            ロールを足すときは、組織全体で見せるなら必ずここへ追記すること。
申し送り 5: getTenantDb() / assertIdBelongsToTenant() の引数型を ShardContext へ
            緩めた。TenantContext は部分型なので既存の呼び出しは変わらない。
            router.spec.ts / id.spec.ts の型注釈も ShardContext へ揃えてある。
申し送り 6: **listUsers に施設の絞り込みは掛けていない（OPEN_QUESTIONS #016）。**
            user / membership は propertyId を持たない。清掃スタッフが組織の
            ユーザー一覧を取れてよいかは security.md に記述が無い。
            到達可否は P0-10 の assertPermission() が判定する前提。**P0-10 の着手前に判断が要る。**
申し送り 7: 越境テスト（tests/tenant-isolation/）は P0-13 の所有。P0-07 では作っていない。
            リポジトリ層のテストは packages/db/src/repositories/*.spec.ts にある。
            P0-13 は packages/db/src/test-support/fake-d1.ts を再利用できる。
--- P0-06 からの申し送り（継続）---
申し送り 8: P0-18 は シードを packages/db/src/seed.ts という名前で作ること。
            別名にすると allowlist から外れて lint が落ちる（DECISIONS #009）。
            seed / fixture に仕様書の例 `o7k2m9` を literal で書かないこと（DECISIONS #010）。
申し送り 9: .tsx は現在 ESLint で検査できない。apps/web/tsconfig.json の include が
            src/**/*.ts のみで jsx オプションもどこにも無いため、置くと parse error に
            なる。P0-14 が include と jsx を同時に設定すること（OPEN_QUESTIONS #001）。
申し送り 10: **文書間の食い違いは 6 件（OPEN_QUESTIONS #011〜#016）。**
            #011（role の語彙）と #016 は P0-10 の着手前、#013（PIN ログインの識別子）は
            P0-09 の着手前、#014（メールから組織を解決する手段）は P0-08 の着手前に
            人間の判断が要る。暫定の選択で進めてある。
ブロッカー: P0-02 が未完のまま。実在する Cloudflare リソースは D1 の
            proofkeeping-shard-00 のみで、R2 / KV / Queue と残り 15 シャードは未作成。
            そのため pnpm dev による実環境での起動確認は P0-03〜P0-06 でも行えていない。
            P0-06 の完了条件「16 シャードすべてに適用できる」は**未達**。
            ローカル 1 シャードでの実測と、注入した代役による分岐の検証まで。
            **P0-02 の完了後に 16 本での適用を確認すること。**
```

補足: UI フレームワーク（OPEN_QUESTIONS #001）は未決のまま。`apps/web` は Hono のみ。
シャード明示マッピングは専用 KV namespace `SHARD_MAP` に置く（DECISIONS #006 / OPEN_QUESTIONS #006 解決済）。

## Phase 0 — 基盤構築（M1）

- [x] P0-01 monorepo とツールチェーン
- [ ] P0-02 Cloudflare リソース作成
  - 宣言と型は実装済み。ローカル（`SHARD_COUNT=1`）は成立する構成になっている。
    実在するリソースは D1 `proofkeeping-shard-00` のみのため、完了条件
    「production で 16 シャードすべてに接続できる」は未達成。
    R2 / KV / Queue と残り 15 シャードを作成し `database_id` を差し替えた後にチェックする。
- [x] P0-03 シャードルーター ★最優先
  - `SHARD_MAP` は読み取りのみ実装。書き込み（組織の移送）を持つ task が
    どこにも無いことを OPEN_QUESTIONS #007 に記載した。
    ハッシュのみで解決できるため P0〜P6 の進行に支障はない。
- [x] P0-04 ESLint カスタムルール ★最優先
  - allowlist に書いた `packages/db/src/migrate.ts`（P0-06）と
    `packages/db/src/seed.ts`（P0-18）はまだ存在しない。この名前で作ること。
  - `no-literal-string` は `.tsx` が 1 件も無いため実ファイルには当たっていない。
    tsconfig の `jsx` 設定は P0-14 の責務（OPEN_QUESTIONS #001）。
- [x] P0-05 ID 採番 ★最優先
  - `ENTITY_PREFIXES` は仕様に定義のある 11 個のみ（task/insp/evd/obs/lost/issue/
    inv/rcp/find/run/prop）。P0-06 の 13 テーブル分は未定義（OPEN_QUESTIONS #010）。
  - `generateOrgShortId(isTaken)` の衝突チェックは依存注入。グローバル一意性を
    どこで保証するかは未決（OPEN_QUESTIONS #009）。P0-06 が実装する。
  - ULID は `ulid` パッケージを使わず独自実装。Workers は I/O の合間に時計を
    進めないため、単調増加カウンタが無いと一括生成の順序が崩れる（DECISIONS #011）。
- [x] P0-06 スキーマ: 組織・ユーザー・施設 ★最優先
  - 完了条件「マイグレーションが 16 シャードすべてに適用できる」は**未達**。
    P0-02 が未完で実在する D1 が 1 本しかない。ローカル（SHARD_COUNT=1）で
    生成・適用・冪等性・不一致検出まで実測し、16 シャードの順次適用と失敗時の
    中止は `packages/db/src/migrate.spec.ts` の代役で検証している。
  - `room` の `isSellable` / `sourceType` / `externalRoomId` は追加済み。
    **P0-22 は ALTER TABLE ではなく画面と取込ロジックから始めてよい。**
  - 文書間の食い違いを OPEN_QUESTIONS #011〜#015 に起票した。
- [x] P0-07 リポジトリ層の雛形
  - `withTenantScope()` が `organizationId` 条件と施設スコープを必ず載せる。
    全リポジトリ関数の発行 SQL を `repositories.spec.ts` が表駆動で検証し、
    **未登録の関数があると落ちる**（追加したら `INVOCATIONS` へ 1 行足す）。
  - `TenantContext` に `role` / `allowedPropertyIds` / `now` を追加。
    シャード解決だけに要る最小限は `ShardContext`（DECISIONS #016）。
  - **担当施設が空の施設スコープロールは 0 件**（全件ではない / DECISIONS #017）。
  - 実 D1 ではなく SQL を記録する代役で検証している（P0-02 が未完のため）。
    実 DB に対する越境の実測は P0-13 の担当。
- [x] P0-08 認証: orgShortId + スタッフ番号 + パスワード
  - ログイン識別子からメールを外した（DECISIONS #018 / OPEN_QUESTIONS #014 解決）。
    ハッシュは PBKDF2-SHA256 210,000 回（DECISIONS #019）。security.md §2 を改訂済み。
  - 実装したのは管理系 5 ロールのパスワードのみ。現場系の PIN は P0-09。
  - 失敗 5 回目の監査ログは P0-11 待ち。パスワード変更 API は P0 に task が無く未実装
    （関数 setUserPassword() として提供）。
- [ ] P0-09 認証: PIN ログイン
  - **着手前に OPEN_QUESTIONS #017（PIN のハッシュ方式）の判断が要る。**
    security.md §2 の PIN 行は bcrypt cost 10 のまま据え置いてある。
- [ ] P0-10 認可: 権限マトリクス
- [ ] P0-11 監査ログ基盤
- [ ] P0-12 エンタイトルメント基盤
- [ ] P0-13 テナント越境テスト基盤 ★最優先
- [ ] P0-14 UI シェル
- [ ] P0-15 i18n 基盤
- [ ] P0-16 事業者・税務マスタ画面
- [ ] P0-17 DocumentSequencer（Durable Object）
- [ ] P0-18 seed データ
- [ ] P0-19 CI/CD
- [ ] P0-20 ヘルスチェックと監視
- [ ] P0-21 施設セレクタ
- [ ] P0-22 客室マスタ 方式A

## Phase 1 — 清掃現場の最小成立（M2–M3）

- [ ] P1-01 スキーマ: 清掃タスク
- [ ] P1-02 標準時間マスタと設定画面
- [ ] P1-03 タスク自動生成
- [ ] P1-04 W-05 当日の客室状況入力
- [ ] P1-05 ステータス遷移 API
- [ ] P1-06 チェックリスト定義
- [ ] P1-07 M-01 PIN ログイン画面
- [ ] P1-08 M-02 本日のタスク ★最重要画面
- [ ] P1-09 M-03 タスク詳細
- [ ] P1-10 M-04 チェックリスト
- [ ] P1-11 写真アップロード
- [ ] P1-12 オフラインキュー
- [ ] P1-13 ホーム画面追加バナー
- [ ] P1-14 W-04 タスク管理・人員配分
- [ ] P1-15 W-03 客室ボード / M-10
- [ ] P1-16 客室ステータス同期
- [ ] P1-17 M-11 自分の実績
- [ ] P1-18 多言語（英語）
- [ ] P1-19 実機テスト（人間が実施）
- [ ] P1-20 現場検証（人間が実施）★出荷判定
- [ ] P1-21 施設グループ表示
- [ ] P1-22 施設選択画面
- [ ] P1-23 施設検証と確認ダイアログ

## Phase 2 — 検査と証跡（M4）

- [ ] P2-01 スキーマ: 検査・証跡
- [ ] P2-02 検査ポリシーと抽出ロジック
- [ ] P2-03 InspectionLock（Durable Object）
- [ ] P2-04 検査 API
- [ ] P2-05 M-08 検査待ち一覧
- [ ] P2-06 M-09 検査実施
- [ ] P2-07 差戻しと再清掃
- [ ] P2-08 EvidenceSnapshot とハッシュ
- [ ] P2-09 W-07 証跡詳細画面
- [ ] P2-10 証跡 ZIP エクスポート
- [ ] P2-11 忘れ物管理
- [ ] P2-12 設備不具合・修繕
- [ ] P2-13 M-13 報告画面
- [ ] P2-14 日報 PDF
- [ ] P2-15 指標算出
- [ ] P2-16 P1 暫定機能の移行・削除
- [ ] P2-17 現場検証（人間が実施）★出荷判定

## Phase 3 — 観察記録とベースライン（M5）

- [ ] P3-01 スキーマ: 観察・リネン・ベースライン
- [ ] P3-02 既定値の推定ロジック
- [ ] P3-03 M-05 入室時の記録 ★UX が最重要
- [ ] P3-04 M-05b 詳細入力
- [ ] P3-05 観察記録のオフライン対応
- [ ] P3-06 M-06 リネン枚数
- [ ] P3-07 観察記録の事後修正
- [ ] P3-08 ベースライン算出エンジン
- [ ] P3-09 ベースライン週次バッチ
- [ ] P3-10 W-21 ベースライン確認・上書き
- [ ] P3-11 W-20 観察項目の設定
- [ ] P3-12 W-22 データ品質ダッシュボード
- [ ] P3-13 データ蓄積期間（人間が実施）★P4 の前提

## Phase 4 — 稼働照合エンジン（M6–M7）

- [ ] P4-01 スキーマ: 照合
- [ ] P4-02 CSV 取込
- [ ] P4-03 エンジン骨格
- [ ] P4-04 R001 / R006 実装 ★まず 2 つだけ
- [ ] P4-05 ReconciliationLock と照合バッチ
- [ ] P4-06 W-06 差異レポート一覧
- [ ] P4-07 W-07 差異詳細
- [ ] P4-08 誤検知率の検証（人間が実施）
- [ ] P4-09 抑制ロジック
- [ ] P4-10 RoomAccessLog
- [ ] P4-11 R003 / R004 / R005 実装
- [ ] P4-12 R007 〜 R014 実装
- [ ] P4-13 W-25 ルール設定
- [ ] P4-14 月次監査レポート PDF
- [ ] P4-15 禁止語の CI 検査

## Phase 5 — 請求・領収・多施設（M8–M9）

- [ ] P5-01 スキーマ: 請求・領収
- [ ] P5-02 取引先マスタ
- [ ] P5-03 料金設定
- [ ] P5-04 集計と料金計算エンジン
- [ ] P5-05 月次締めと集計バッチ
- [ ] P5-06 請求書 PDF テンプレート
- [ ] P5-07 請求書の 1 クリック発行 ★中核機能
- [ ] P5-08 領収書 PDF と 1 クリック発行
- [ ] P5-09 訂正・赤伝
- [ ] P5-10 送付ログと bounce 処理
- [ ] P5-11 検索機能（電帳法対応）
- [ ] P5-12 双方合意フロー
- [ ] P5-13 証跡へのドリルダウン ★差別化の核心
- [ ] P5-14 W-02 組織ダッシュボード
- [ ] P5-15 清掃会社プラン画面

## Phase 6 — 外部連携と拡張（M10–M11）

- [ ] P6-01 スキーマ: 連携
- [ ] P6-02 認証情報の暗号化保管
- [ ] P6-03 アダプタ共通インターフェース
- [ ] P6-04 汎用 Webhook 受信口
- [ ] P6-05 マッピングと W-23
- [ ] P6-06 PMS アダプタ 1 社
- [ ] P6-07 リトライとサーキットブレーカー
- [ ] P6-08 スタッフキー除外と R002 検証
- [ ] P6-09 通知基盤（IN_APP → EMAIL）
- [ ] P6-10 Web Push
- [ ] P6-11 LINE 通知
- [ ] P6-12 API キーと公開 API
- [ ] P6-13 送信 Webhook
- [ ] P6-14 W-13 連携設定 / W-24 同期ログ
- [ ] P6-15 API ドキュメント

## Phase 7 — GA とスケール（M12）

- [ ] P7-01 セットアップウィザード
- [ ] P7-02 ログイン案内カード PDF
- [ ] P7-03 トライアル管理
- [ ] P7-04 Stripe 連携
- [ ] P7-05 解約とエクスポート
- [ ] P7-06 シャード監視ダッシュボード
- [ ] P7-07 テナント移送
- [ ] P7-08 アーカイブとバッチ
- [ ] P7-09 アーカイブ閲覧
- [ ] P7-10 R2 保持期間管理
- [ ] P7-11 縮退運転の検証
- [ ] P7-12 負荷試験
- [ ] P7-13 セキュリティ再検証
- [ ] P7-14 復旧訓練（人間が実施）
- [ ] P7-15 顧客向けドキュメント
- [ ] P7-16 RUNBOOK
- [ ] P7-17 GA 判定（人間が実施）

## Phase 8 — Workforce と Inventory（GA後3〜6か月）

**P7-17 の GA 判定を通過するまで着手しない。**

### Workforce（GA後3か月）
- [ ] P8-01 staffProfile スタッフ台帳
- [ ] P8-02 residencyRecord と期限アラート
- [ ] P8-03 shiftPlan と週間シフト画面
- [ ] P8-04 スキル連携（P1-14 の自動配分へ反映）
- [ ] P8-05 attendance 出勤打刻

### Inventory（GA後6か月）
- [ ] P8-06 linenStock リネン4セット管理
- [ ] P8-07 supplyStock と発注点アラート
- [ ] P8-08 stockCount 棚卸（モバイル対応）
- [ ] P8-09 purchaseOrder 発注

## 決定事項

（DECISIONS.md を参照）

## 未解決

（OPEN_QUESTIONS.md を参照）
