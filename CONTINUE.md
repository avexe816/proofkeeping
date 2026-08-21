# CONTINUE

## 2026-08-21 の追記 その 2（**この節が最新**）

### いまどこ

**PF-17 → PF-16 まで実装した。** PF-16 は PR を出して止めてある
（人間の指示「merge はしない」）。

| 事実 | 状態 |
|---|---|
| PR #162（PF-17） | **main へ squash merge 済み** |
| migration **0034** | **staging の両 shard に適用済み** |
| `TWO_FACTOR_ENCRYPTION_KEY` | **staging に登録済み** |
| `schema_version` | 両 shard で 0000〜0034 の 35 本一致 |
| `/api/health` | ok / `schemaVersionConsistent = true` |
| `secrets-and-seed` | **再実行していない**（`SESSION_SECRET` は回していない） |
| PF-16 | **実装済み・PR 作成済み・未マージ** |
| migration **0035**（PF-16） | **staging 未適用**（マージ後に当てる） |
| staging の運営担当者 | **まだ 0 名**（この PR では作っていない） |

### PF-16 のマージ後にやること（**この順で**）

```
1. staging へ migration 0035 を当てる
   staging-bootstrap.yml / phase=migrate / confirm=CREATE
   （--check で 0035 だけが未適用であることを先に見る）
2. RESEND_API_KEY が staging に登録済みかを確かめる
   （wrangler secret list の名前だけ。**無いと開通そのものが断られる**）
3. platform-bootstrap.yml を実行して 1 人目を開通する
   environment=staging / email / display_name / confirm=BOOTSTRAP
   → 本人のメールにリンク（30 分・1 回限り）
   → パスワード設定 → TOTP 登録 → 復旧コード保管 → /plat/status
4. /plat/usage を含む既存 /plat 画面を目視確認する
   （CONTINUE の前の節「ログイン後の『未計測』表示」がここで見られる）
5. PF-06 へ進む
```

**手順の全文は `docs/runbook/platform-bootstrap.md`。**
§8 に「失敗したときに再実行の前に確かめること」がある。

**やらないこと**（前の節の決定を引き継ぐ）:
`secrets-and-seed` の再実行 / `SESSION_SECRET` の回転 / 暫定 operator の作成。

### PF-16 の申し送り

- **開通の口は既定で閉じている。** `PLATFORM_BOOTSTRAP_TOKEN` が
  登録されているときだけ開き、workflow が実行のたびに作って**必ず消す**。
  実行後に `wrangler secret list` へ名前が残っていたら手で消すこと
  （runbook §9）。
- **開通リンクはメール 1 通だけ。** 応答にも監査ログにもログにも出ない。
  `RESEND_API_KEY` の無い環境では**券すら作らずに断る**（`DELIVERY_UNAVAILABLE`）。
- **1 人目の保証は DB 側。** `INSERT ... WHERE NOT EXISTS` の 1 文。
  発行時の件数検査は早く断るためだけで、保証ではない。
- **2 人目以降はこの経路から作れない。** PF-14 の招待待ち（未実装）。
- 実装の判断は **DECISIONS #245**、作業ログは `docs/tasks/PF-16.md`。

### 未解決事項（**この区間で足したもの**）

- **OPEN_QUESTIONS #116 — `staging-bootstrap.yml` の `db-status` が
  「表の数」を両 shard で 0 と出す。** 表は実在する（`/api/health` は ok、
  `schemaVersionConsistent=true`、35 本一致）ので**数え方の側の不具合**。
  **PF-16 には含めていない**（人間の指示）。**別 task として
  `docs/tasks/PF-18.md` を起票済み。** 読み取り専用の phase なので実害は無いが、
  「表が無い」と読み違えて `reset-db` を押さないこと。
  直るまで、表の有無は `pnpm db:migrate --env staging --check` で確かめる。

---

## 2026-08-21 の追記（この節は古い）

### 実装順の決定（人間の指示 2026-08-21）

**PF-17 → PF-16 → staging で最初の operator を開通 →
/plat/usage を含む既存 /plat 画面の目視確認 → PF-06。**
あわせて以下を**行わない**と決定済み:
`secrets-and-seed` の再実行 / `SESSION_SECRET` の回転 / 暫定 operator の作成。

### 事実の訂正（下の節の記載を上書きする）

1. **staging の `platform_operator` は、既存の workflow 実行履歴上、
   未作成と判断**（2026-08-21）。`secrets-and-seed` の最終実行は
   運営担当者シードの実装より前で、以後シードは流れていない。
   **DB を直接照会した結果ではない**（そのための口が無い — 次項）。
2. **件数を直接確認する既存の読み取り専用 phase は無い。**
   `staging-bootstrap.yml` の `check` / `db-status` / `smoke` は
   `platform_operator` の件数を出さない。
3. 下の「PF-01 の申し送り」に、`operator@seed.invalid` が**現在 staging に
   存在するように読める記載**があったが、存在は確認されていない
   （1 のとおり「実行履歴上、未作成と判断」が正。該当行は訂正済み）。
4. **`/plat/usage` の未ログイン 404 は確認済み。**
5. **ログイン後の「未計測」表示と既存 /plat 画面の目視確認は
   PF-16 完了後に行う**（staging に operator が居ないため、先に開通が要る）。
6. **運営面のログイン・bootstrap の runbook は PF-16 で追加する。**

### PF-17 の申し送り

- migration **0034**（`platform_operator` の 2FA 4 列 /
  `platform_recovery_code` 新設）。**staging へは未適用。**
  PF-16 の開通より前に当てること（このセッションは staging / production への
  dispatch 禁止の指示により実行していない）。
- **`TWO_FACTOR_ENCRYPTION_KEY`（TOTP secret の暗号化鍵）も staging 未登録。**
  `staging-bootstrap.yml` の新 phase **`secret-2fa`**（confirm: CREATE）が
  この鍵 1 つだけを登録して再デプロイする（**`secrets-and-seed` を再実行
  しないこと** — SESSION_SECRET が回る）。**0034 と併せて PF-16 開通の前提。**
  レビュー反映の詳細（原子的なステップ消費・secret の AES-GCM 暗号化）は
  DECISIONS #244。
- 運営セッションはレコード v2（`PASSWORD_ONLY` 10 分 / `COMPLETE` 12 時間）。
  **v1 の札は無効。** 現時点で影響する利用者は居ない（上記 1）。
- シードで作る operator は TOTP 未登録のまま。**初回ログインで登録を通るのが正**
  （PF-16 の完了条件とも整合）。
- 実装パラメータの判断は DECISIONS #243、作業ログは `docs/tasks/PF-17.md`。

---

## 2026-08-20 の追記 その 3（この節は古い）

### 最終状態

- main HEAD: `8dba393 PF-04: テナント管理（画面 02） (#151)`
  （**必ず `git log` で確かめ直すこと。** 並行セッションの PR も入る）
- マージ済み（この節のぶん）: **#147** PF-02 → **#149** PF-03（一部）→
  **#151** PF-04。並行セッションの **#146 / #148 / #150**（見た目の整え）も入っている
- staging には **migration 0032 まで適用済み**（PF-02 の 2 表）
- **レビュー待ちなし。CI は緑。**

### 完了とステータス

| task | 状態 |
|---|---|
| P8-01〜P8-10 | 完了（5 task） |
| PF-01 基盤 | 完了 |
| PF-02 スナップショット | 完了（migration 0032 / staging 適用済み） |
| PF-03 サービス稼働 | **⏳ 人間待ち**（下記） |
| PF-04 テナント管理 | 完了 |
| PF-05〜PF-14 | 未着手 |

### 人間に決めてほしいこと（**これが最優先**）

1. **OPEN_QUESTIONS #114 — 運営画面の指標をどこから採るか。**
   PF-03 の 8 指標（稼働率・p95・エラー率・リクエスト量・同期キュー・
   同期の失敗・写真ストレージ・事象履歴）は**計測そのものが無い。**
   案 1（Workers Analytics Engine / **課金が発生**）・案 2（自前で D1 に
   溜める / 推奨）・案 3（画面から落とす）。**PF-05 のいくつかも同じ壁。**
2. **OPEN_QUESTIONS #115 — メンテナンス時間帯が 1 時間ずれている。**
   PF-03 の逐語注記 02:00〜04:00 / PF-14 の既定 03:00〜04:00。どちらかが正。
3. **本番の運営担当者 1 人目をどう作るか**（PF-01 の申し送り）。
   シードは local / staging だけ。招待画面は PF-14 待ち。
4. **2FA の方式**（OPEN_QUESTIONS #109）。列だけ置いてある。

**1〜4 のどれも PF-05 以降の着手を止めない。**

### 次にやること: **PF-05 利用状況**（下調べ済み）

`docs/tasks/PF-05.md`。**画面の主役（記録の品質の表）は今あるもので作れる。**

| 指標 | 出す元 | どうするか |
|---|---|---|
| 記録された清掃 / 記録の完備率 | ✓ スナップショット | そのまま |
| 品質の表（テナント別） | ✓ スナップショット + `judgeTenantQuality()` | **下位から並べる**（完了条件） |
| 検出された差異 | ✓ `dailyPropertyRollup.findingsHigh` | **スナップショットに 1 列足す** |
| 写真 | `taskPhoto` はあるが件数の口が無い | 口を足して**スナップショットに 1 列** |
| 言語の利用割合 | ✓ `user.locale` | **スナップショットに内訳を 1 列**（JSON） |
| アクティブ端末 / ストレージと通信 | **無い** | **列ごと置かない**（#114 と同じ扱い） |
| 記録数の推移（6 か月） | スナップショットを月でまとめる | **PF-02 が動き出した日より前は出ない。** 画面にそう書く |

つまり **migration 0033 で `platform_tenant_snapshot` に 3 列足す**のが本体。
後方互換の列追加なので `consumers/tenantSnapshot.ts` に数え方を足すだけ。
**マージ後に staging へ 0033 を当てること。**

逐語の注記 2 つ（判定の 3 指標 / 日本語利用者 6.9%）は PF-05.md にある。
**「6.9%」は実測が出るまで数字として出さない**（言語の表が実データで
出せるようになったら、その表が答えになる）。

### 並行セッションと 3 回連続でぶつかっている

**#146 / #148 / #150 が同じファイルに触っている。** 毎回ぶつかるのは
`apps/web/src/locales/ja.json` と `docs/PROGRESS.md`、そして
`docs/DECISIONS.md` の**番号**。

- **PR を作る直前に `git fetch origin main` する。**
- DECISIONS の番号は**取られていたら振り直す**（#146 が #231 を先に使ったので
  PF-02 の 2 件を #232 / #233 へ動かした）。参照している task ファイルと
  PROGRESS も一緒に直すこと。
- `ja.json` の衝突は**両方のキーを残す**（消さない）。

### この区間で足した決定

- **#232** テナントのスナップショットはキューも cron も新設せず相乗り
  （`pk-rollup-update` に `kind` で / 発火は 02:00 JST の回）
- **#233** スナップショットは測った値だけを持ち、判定も割合も保存しない
  （閾値は PF-14 の「運用（変更可）」から来るので焼き込まない）
- **#230** 運営面の門は 404、テナント面は `/login` へ戻す（非対称は意図的）

### 積み残し

- **OPEN_QUESTIONS #111**: `payout` の 16 関数が `REPOSITORY_MODULES` に
  未登録で、組織条件の自動検査を受けていない。**次のバッチで登録する。**
  （PF-02 で新しい 2 関数を足したとき、この検査が未登録を捕まえた。効いている。）

---

## 2026-08-20 の追記 その 2（この節は古い）

### 最終状態

- main HEAD: `262d5b4 PF-01（2/2）: 運営画面のシェル・ナビ・ログインのルート (#144)`
  （**必ず `git log` で確かめ直すこと。** 並行セッションの PR も入る）
- main の CI は 3 本とも緑。**レビュー待ちなし。**
- マージ済み（この節のぶん）: **#142** P8-10 研修と資格（Workforce 完走）→
  **#143** PF-01（1/2）データ面と認証（**並行セッション**）→
  **#144** PF-01（2/2）画面。
- **P8 は 5 task すべて完了。PF-01 も完了。**

### 並行セッションとぶつかった（2 回目）

**#143 は別セッションが PF-01 の前半を実装してマージしたもの。** こちらも
同じ範囲を書いていたが、**マージ済みのほうを正として破棄し、向こうの
`lib/platform/*` と `repositories/platform.ts` の上に画面だけを載せ直した**
（DECISIONS #229 で P8-04 のときに採った扱いと同じ）。

**PR を作る直前に `git fetch origin main` すること。** 45 分の作業が
やり直しになる。

### 次にやること: **PF-02**（PF-03〜PF-14 が全部これに依存する）

`docs/tasks/PF-02.md`。**設計の下調べは済んでいる。以下をそのまま使ってよい。**

#### 使えるものの在り処（調査済み）

| 要る数字 | 出どころ |
|---|---|
| 施設数 | `property`（`repositories/property.ts`） |
| 客室数・課金対象室数 | `countRooms()` / `countSellableRoomsByProperty()`（`room.ts`） |
| スタッフ数 | `membership`（有効なもの） |
| 完備率の分母 | `dailyPropertyRollup.completedTasks` を施設ぶん合計する |
| 完備率の分子 | `observation` の行数（`businessDate` で絞る） |
| 既定値のまま比率 | `observation.usedDefaults`（boolean 列） |
| 入力所要時間の中央値 | `observation.inputDurationMs`（null あり） |
| 未記録 | `cleaningTask.observationSkipped` |
| プラン・契約日・試用期限・状態 | `subscription`（`plan` / `status` / `trialEndsAt` / `createdAt`）|

`SUBSCRIPTION_PLANS = ["BASE","PRO","ENT"]` /
`SUBSCRIPTION_STATUSES = ["TRIAL","ACTIVE","PAST_DUE","CANCELED"]`。

#### 決めておいた設計（そのまま進めてよい）

1. **キューを新設しない。** `pk-rollup-update` に `kind: "TENANT_SNAPSHOT"` で
   相乗りさせる（`RollupUpdateMessage` が既に `kind` を持っている /
   DECISIONS #140・#160 の判断と同じ）。Cloudflare のリソース作成を
   人間に待たせない。dispatch は `apps/web/src/index.ts` の
   `batch.queue.startsWith("pk-rollup-update")` を `kind` で 2 分割する。
2. **cron を新設しない。** 02:00 JST の fallthrough に
   `dispatchTenantSnapshot()` を 1 本足す（写真の保持期限・照合と同じ相乗り）。
   **新しい cron 式を足すときは fallthrough より前に分岐を置くこと**
   （忘れると 02:00 のタスク生成がその時刻にも走る）。
3. **判定を保存しない。** スナップショットには**測った値だけ**を入れ、
   「要支援」「注意」は**読むときに**閾値と突き合わせて出す。閾値は
   PF-14 の「運用（変更可）」から来るので、焼き込むと値を変えた瞬間に
   過去の行と食い違う。
4. **閾値の置き場所。** PF-14 の 5 項目だけを持つ表を SHARD_00 に作り
   （`platform_operation_setting`）、既定値は 1 つのモジュールに置く。
   **PF-02 が読むのは 2 つだけ**（入力所要時間の基準 10 秒 / 既定値のまま
   比率 70%）。**完備率 90% は PF-14 の 5 項目に無いのでコード上の定数**
   （プロトタイプが上限 — 編集できる項目を勝手に増やさない）。
   書き込み（申請・承認 2 名）は PF-14 の担当。
5. **2-of-3 の判定は純粋関数**にして `packages/engine` へ
   （`assignment.ts` / `inspectionSampling.ts` と同じ置き場）。
   正例・負例を 5 件ずつ（testing.md §3）。逐語:
   > 判定は3指標の組み合わせです。完備率90%未満・既定値70%超・入力時間10秒未満のうち2つ以上該当で「要支援」とします。
6. 割合は**整数で持つ**（basis point。98.2% → 9820）。浮動小数点を使わない。
7. 表は `platform_tenant_snapshot`（`organizationId` × `businessDate` で一意）。
   **`orgShortId` を主キーにしない・シャード番号の列を持たない。**
   **全 16 シャードに定義を流す**（`schema_version` の一致検査のため /
   `schema/platform.ts` 冒頭の注記）。

#### 手順

```bash
git fetch origin && git checkout main && git pull
# 1. packages/db/src/schema/platform.ts に 2 表を足す
# 2. pnpm db:generate（0032 になるはず。**必ず同じ PR に入れる**）
# 3. repositories/platform.ts に upsert / list / 設定の読み取りを足す
# 4. packages/engine に 2-of-3 の純粋関数
# 5. apps/web/src/consumers/tenantSnapshot.ts と dispatch
# 6. index.ts の queue 分岐と 02:00 の fallthrough に配線
# 7. pnpm check → PR → CI → squash merge
# 8. マージ後に staging へ migration を当てる（下の「staging」を見ること）
```

**マージ後の staging 反映**（0032 を当てる）:
`mcp__github__actions_run_trigger` に
`workflow_id: "staging-bootstrap.yml"`、inputs `{"phase":"migrate","confirm":"CREATE"}`。
**`resource_id` ではなく `workflow_id`。** コンテナから Cloudflare へは直接届かない。

### PF-01 の申し送り

- **運営担当者を作る画面がまだ無い。** シードのコードは local / staging の
  `POST /api/v1/dev/seed` で `operator@seed.invalid` を 1 名**作れる**が、
  **staging では既存の workflow 実行履歴上、未作成と判断**（2026-08-21 訂正。
  シード実装より前の実行しか無い。DB の直接照会結果ではない）。
  本番の 1 人目は bootstrap（PF-16 / DECISIONS #240）で作る。
- 2FA は列だけ（OPEN_QUESTIONS #109）。方式が決まったら
  `lib/platform/login.ts` と `routes/plat/login.tsx` の 2 か所に入る。
- ナビ 12 項目のうちルートが在るのは `/plat/status` だけ。**残り 11 本は
  グレーのまま**で、PF-03〜PF-14 が 1 つずつリンクに変える
  （`routes/plat/layout.tsx` の `PLAT_NAV` と `apps/web/src/routes.ts`）。
- `/plat/*` は未ログインで **404**、`/app/*` は `/login` へ戻す
  （DECISIONS #230 / OPEN_QUESTIONS #113 決着）。**この非対称は意図的。**

### 積み残し（PF に着手する前でも後でもよい）

- **OPEN_QUESTIONS #111**: `payout` の 16 関数が `REPOSITORY_MODULES` に
  入っておらず、組織条件の自動検査を受けていない。**次のバッチで登録する。**

---

## 2026-08-20 の追記（この節が最新）

### 最終状態

- main HEAD: `d708e2b P8-02: 在留資格を記録する口を入れる (#134)`
  （**必ず `git log` で確かめ直すこと。** 別セッションの PR も入る）
- **マージ済み**: **#129** 通知の鈴・ダークモード → **#130** P8 / PF 起票 →
  **#132** P8-01 スタッフ台帳 → **#134** P8-02 在留資格の記録。
  別セッションの **#131**（稼働の差異の見た目 / DECISIONS #224）も入っている
- **レビュー待ち**: なし

### いま何が起きたか

オーナー指示（2026-08-20）で **2 つの制約が解除された**（DECISIONS #219）。

1. CLAUDE.md §9「GA 判定前に P8 の task ファイルを作成しないこと」
2. 差分台帳のプラットフォーム運営 12 画面 🚫（テナント / 契約 / 課金の除外）

**P7-17 の GA 判定そのものは残る。** 解除したのは順序の制約だけ。
2 原則（**プロトタイプが上限**／**簡素化は必須**）は P8 とプラットフォームにも
そのまま効かせる。**下の 2026-08-16 節にある「P8 の前倒し禁止は不変」は
この指示で無効になった。**

**プロトタイプ差分台帳の 55 画面はすべて閉じた**（#129 で通知の鈴と
ダークモードが入り、⬜ が無くなった）。ダークモードに切替ボタンは無い —
プロトタイプの `🌙` はデモ用の外枠にあり製品の画面には無いので、
端末の設定（`prefers-color-scheme`）に従うだけにした。

### 次にやること

```bash
git fetch origin && git checkout main && git pull
git log --oneline -3
```

#### 1. P8-03 / P8-04 / P8-10（P8-02 は完了した）

`docs/tasks/` にある。**週間シフトのグリッドも必要人数の行も作らない**
（プロトタイプ 02 にあるのは日次の割当表と出勤者数の棒グラフ 1 本だけ）。
**出勤打刻（P8-05）と Inventory（P8-06〜09）は作らない**（DECISIONS #221）。
出勤済みは「その日にタスクを 1 件以上開始した人数」で数える。

#### 2. プラットフォーム運営（PF-01〜PF-14）

`docs/tasks/PF-*.md`。**PF-01（基盤）→ PF-02（スナップショット）が
他の 12 画面をすべてブロックする**ので、この 2 つから。

- 運営面は **SHARD_00 の `platform_*`** に置き、テナント面と交わらせない
  （DECISIONS #220）。運営側は `getTenantDb()` を呼ばず、
  テナント側は `platform_*` を読まない
- **`Role` に `PLATFORM_ADMIN` を足さない**（足すと運営担当者がどこかの
  テナントの構成員になる）
- 認証はメール＋パスワード（**2FA は入れない** / OPEN_QUESTIONS #109）
- **Stripe を入れない。** PF-12 は価格の台帳と集計だけ（DECISIONS #222）
- 個人情報への一時アクセスは INV-10 どおり（理由・**承認 2 名**・
  **最長 4 時間**・記録は削除不可）

### 申し送り

- **OPEN_QUESTIONS #108** 課金モデルが仕様（モジュール別）とプロトタイプ
  （版数 × 客室数 ＋ 最低利用料）で食い違う → **プロトタイプ側を採った**
- **OPEN_QUESTIONS #109** 運営の 2FA 方式が仕様に無い → 列だけ置く
- **OPEN_QUESTIONS #110** 在留資格を読めるロールが仕様（`OWNER ○`）と
  INV-08（運営管理者のみ）で食い違う → **INV-08 を採った**
- **OPEN_QUESTIONS #111** `payout` の 16 関数が `REPOSITORY_MODULES` に
  未登録で、組織条件の自動検査を受けていない（P5-18 からの持ち越し）。
  **次の P8 バッチで登録するのを推奨。** 併せて
  「ディレクトリのファイルが全部載っているか」のテストを足すと
  載せ忘れ自体が塞がる
- **DECISIONS #223** スタッフ台帳は `staff_pay_profile` に列を足す形。
  **`staff_profile` を新設しないこと。**
- **`P7-04`（Stripe 連携）は中止。** PF-12 が引き取る（DECISIONS #222）。
  「`module_entitlement` への書き込みが 1 本も無い」（申し送り オ）は
  PF-12 で解ける
- ブランチの削除がこの環境から通らない（proxy が 403 / `git push --delete` は
  hangup）。**マージ済みのブランチが remote に残る。** 消せないだけで
  実害は無い（`git ls-remote` で確認済み）
- Cloudflare へはこのコンテナから到達できない。staging の操作は
  `.github/workflows/staging-bootstrap.yml` を dispatch する

---

## 2026-08-16 夜の追記

**前節の「次」3 件はすべて完了・マージ済み**（PR #106 / #107 / #108。各 CI 緑、
マージ後の main も緑）。

- **① 月次レポート（owner 09）**: `/app/p/:id/report`。集計は
  `packages/engine/monthlyReport.ts`（純粋関数）。**確定・採番・PDF を
  持たない**（DECISIONS #196。印刷はブラウザ / #184 と同じ）。門は
  `finding.read`。既定の対象月は前月。
- **② ダッシュボード（owner 02）**: 気づきカード（未確認の差異を確信度順
  5 件）と「本日の動き」（**監査ログから現場操作 8 種だけ** /
  DECISIONS #197。イベント表を新設していない）。台帳 02 は ✅。
- **③ モバイル 7 言語**: `locales/{zh-CN,vi,id,my,ne}.json`（各 351 キー・
  機械翻訳）。ログイン画面に 7 言語切替を常設（`?lang=` のみ。Cookie /
  Accept-Language を読まない）。`m.locale.*` は**どのカタログでも訳さない**
  （常に自言語表記）。`my` / `ne` は行高 1.2 倍（DECISIONS #198）。
  **翻訳の対象はモバイルのキーだけ。** 管理画面のキーを訳さないこと。

**プロトタイプ差分台帳の ⬜ / 🔧 はモバイル 02（5 段カウンタの内訳簡略）、
横断の通知の鈴・ダークモード（低優先）だけになった。**

- **staging 稼働中**: https://pk-staging.ukh816-account.workers.dev/login
  （seed01 / 0001 / testpass-01）。main への push で自動反映。
- **開発の正**: `docs/PROTOTYPE_GAP.md`（2 原則: プロトタイプ上限・簡素化必須）
  と DECISIONS #195。P8 の前倒し禁止は不変。
- **次**: Claude が着手できる新規 task は無い（下の人間待ちのとおり）。
  再開の起点は「人間の作業」の表。Dependabot の PR は DECISIONS #187 の
  手順で処理する。

## 2026-08-16 昼の記録（参考）

- **完了**: P7-18 検査キュー / P7-19 進捗モニタ（リネン列含む）/
  P7-20 監査ログ閲覧 / スタイル v3 統一（PR #99〜#104）。

## 最終状態

- 完了: **126 task**（P7-02 完了）
- **Claude が着手できる task は残っていない。** P7 の残り 7 件は
  **すべて人間待ち**（外部サービスの契約・実測・外部監査・GA 判定）。
- **P8 の task ファイルを作らないこと**（GA 判定を通過するまで / CLAUDE.md §9）。

## 次にやること

**新しい task は無い。** 人間の作業（下の表）が 1 つでも片付いたら、
その task から再開する。

**task が無い間も Dependabot の PR は溜まる。** P7-13 で設置したので、
週次で出てくる。処理の仕方は DECISIONS #187 に書いた。要点は 2 つ。

- **「CI が緑」を根拠にしない。** 破壊的変更を 1 件ずつ読み、このリポジトリが
  使っているトリガと入力に当たるかを確かめる。fork PR や npm publish のように
  **まだ通っていない経路**の破壊的変更は、緑では検出できない。
- **`ci.yml` を触る PR は隣接行で衝突する。** 1 本マージすると残りが `dirty` に
  なるので、`@dependabot rebase` で 1 本ずつ通す。反応が無ければ
  ブランチ更新（`update_pull_request_branch`）を直接かける。

```bash
git fetch origin && git checkout main && git pull
```

## staging 環境（2026-08-16 / 稼働中）

**構築は完了した。URL は https://pk-staging.ukh816-account.workers.dev/login**

| 項目 | 値 |
|---|---|
| Worker | `pk-staging`（`workers_dev = true` で URL 固定） |
| アカウント | Ukh816 Account |
| D1 | `proofkeeping-shard-00-staging` / `-01-staging`（SHARD_COUNT=2） |
| 自動デプロイ | **main への push で走る**（`.github/workflows/ci.yml`） |
| テスト用 | 組織 `seed01` / スタッフ番号 `0001` / パスワード `testpass-01` |
| 現場用 | スタッフ番号 `1001`〜`1015` / PIN は `packages/db/src/seed.ts` |

**運用は `.github/workflows/staging-bootstrap.yml`（手動実行）で行う。**
Actions から phase を選んで押す。**手元の端末も Cloudflare の認証も要らない。**

| phase | 何をするか | 合言葉 |
|---|---|---|
| `check` | 18 資源の有無を出す。**何も変更しない** | 不要 |
| `db-status` | D1 の中身と /api/health を読む。**何も変更しない** | 不要 |
| `smoke` | ログインして画面と API まで通す。**何も変更しない** | 不要 |
| `mark-applied` | 表はあるのに記録が空のときに記録だけ書く | `MARK-APPLIED` |
| `resources` | D1/KV/R2/Queue を作り ID の PR を出す | `CREATE` |
| `reset-db` | staging の D1 を空にする。**1 行でもあれば中止** | `RESET-STAGING-DB` |
| `secrets-and-seed` | migration → 秘密 → 再デプロイ → シード | `CREATE` |

### この構築で見つけて直した不具合（すべて「実行するまで分からない」類）

1. **`wrangler deploy --env` は効かない**（DECISIONS #192）。環境はビルド時に
   `CLOUDFLARE_ENV` で決まる。放置していれば `pk-local` 設定の Worker が
   **production の D1 に繋がって**上がっていた。
2. **`pnpm db:migrate` が全環境で落ちていた。** 先頭が `--` の SQL で
   wrangler の引数解析が壊れる。CI は `drizzle-kit check` しか行わないため未検出。
3. **大きな SQL は `--command` で渡せない。** `--remote` が受け取れず、
   初回マイグレーションが落ちる。**local（miniflare）は通るので手元では再現しない。**
   `--file` へ変更した。
4. **`CLOUDFLARE_ACCOUNT_ID`（GitHub Secret）に空白か引用符が混ざっている。**
   `wrangler r2 bucket list` だけが落ちる。ワークフロー側で除去しているが、
   **secret 自体を直すことを勧める。**

### 残っていること

- `[env.preview]` の資源は未作成（`TODO-P0-02-未作成-PREVIEW-*`）。
  **CI は TODO が残っている間 preview デプロイを試みない**ので赤くならない。
- production の D1 は shard-00 だけが実在。01〜15 は未作成。

| task | 要るもの |
|---|---|
| P7-04 Stripe 連携 | **Stripe の API キー** |
| P7-05 解約とエクスポート | P7-04 に依存 |
| P7-12 負荷試験 | 検証環境（16 シャード＋シード）と分散した負荷生成。`pnpm loadtest` |
| P7-13 セキュリティ再検証 | **外部ペネトレーションテスト 1 回**（3/4 は完了済み） |
| P7-14 復旧訓練 | **RUNBOOK が揃っているので実施できる** |
| P7-16 の残り | P7-14 と同時に「手順書だけで対応できたか」を確かめる |
| P7-17 GA 判定 | 有償顧客 5 社の稼働ほか |
| P6-06 PMS アダプタ 1 社 | 実接続する PMS の確定と接続情報（**未確定のまま飛ばしている**） |
| P6-10 Web Push | VAPID 鍵 3 つ（`wrangler secret put`）。**人間が設定中** |
| P6-11 LINE 通知 | チャネルとアクセストークン。方式は (a) Messaging API で確定 |

## 直近で処理した Dependabot の PR（2026-08-15）

| PR | 更新 | 結果 |
|---|---|---|
| #77 | actions/checkout 4 → 7 | マージ済み |
| #79 | actions/setup-node 4 → 7 | マージ済み |
| #78 | pnpm/action-setup 4 → 6 | マージ済み（rebase 1 回） |
| #80 | dev-dependencies 2 件 | マージ済み（ブランチ更新 1 回） |

**#80 だけ扱いが違った理由。** この PR の CI は 9 ジョブ構成だった頃
（#89 のマージ前）に走っており、**検証済みのツリーが古かった。**
lockfile を触る PR は、古いツリーで緑でも今のツリーで緑とは限らない。
ブランチを更新して 3 ジョブ構成で走り直させてからマージした。

**`pnpm/action-setup` には後継 `pnpm/setup` がある**（v6 の README が案内）。
今回は乗り換えていない。判断するときは DECISIONS #187 を見ること。

## 今回置いたもの（P7-02 現場掲示用の案内）

| ファイル | 役割 |
|---|---|
| `apps/web/src/lib/qr/gf.ts` | GF(256) と Reed-Solomon（**純粋・依存ゼロ**） |
| `apps/web/src/lib/qr/encode.ts` | バイトモード・誤り訂正 M・版 1〜10 |
| `apps/web/src/lib/staff/register.ts` | 登録の実装 1 本（API と画面が共有） |
| `apps/web/src/routes/app/staff.tsx` | `/app/settings/staff`。登録 → 案内カード |
| `apps/web/src/styles/app.css` | `.pk-card` と `@media print` |
| `apps/web/src/styles/printLayout.spec.ts` | A4・改ページ・印刷対象の固定 |
| `tests/security/initialPin.spec.ts` | **PIN の経路を走査で固定** |

### 覚えておくこと

- **PIN が現れるのは `action` の戻り値だけ。** `loader` へ渡さない
  （GET は URL にも履歴にも残る）。**画面を再読込すると案内は消える。
  消えるのが正しい。** 控え損ねたら PIN リセットでやり直す。
- **`initialPin.spec.ts` が経路を数えている。** 平文の PIN を扱ってよい
  ファイルは 3 つだけで、**増やすには理由を 1 行書く必要がある。**
  Queue・`console`・R2・監査ログへの口が生えると落ちる。
- **QR に PIN も組織 ID も入れない。** 載せるのはログイン URL 1 本。
  紙を写真に撮られても PIN は写らない（文字の側は写るが、それは
  §2.4 が求める掲示物そのもの）。
- **QR の実装に依存を足していない。** `lib/qr` は DOM も fetch も
  `Date.now()` も触らない純粋なコードで、`packages/pdf` を汚さない。
- **`encode.spec.ts` は独立した読み取り器を持っている。** 符号化器の
  途中結果を使わず、行列だけから文字列を復元する。**`internals` に
  符号化の途中結果を足さないこと。** 足すと検証にならなくなる。
- **走査の順序で 1 つ踏んだ。** 6 列目（タイミングパターン）を避けるとき
  **列そのものをずらす**（`if (right === 6) right = 5;`）。一時変数で
  逃がすと以降の列の対が 1 つずれ、**4 列目を 2 度書いて 0 列目を書かない。**
  訪問の総数は変わらないので `freeModuleCount()` の検算を素通りする。
- **版 11 以降を実装していない。** 版 10-M で 213 バイト入り、ログイン URL は
  100 バイトに届かない。足すときは版情報の BCH と整列パターンの中心を
  必ず既知値と突き合わせること。
- **`orgShortId` を印字する**（DECISIONS #186）。§2.4 の図の「施設コード」は
  ログインの入力欄に存在しない。**図の版上げが要る**（下の一覧）。
- **登録の実装は `lib/staff/register.ts` の 1 本。** API（`users.ts`）は
  そこへ委ねている。`accessMatrix.spec.ts` に**委任**の仕組みを足してあり、
  **委任先が `assertPermission()` を呼ぶことをテストが追いかける。**
  免除ではない。
- **管理者のメール招待は未実装**（OPEN_QUESTIONS #101）。受けるのは
  `FIELD_STAFF_ROLES` の 2 つだけ。**推測でトークンの寿命を決めないこと。**
- **施設の作成画面はまだ無い**（#103 の残り半分）。`STEPS_WITHOUT_SCREEN` は
  `property` の 1 つだけになった。

## 申し送り

### 人間の作業

1. **Stripe の API キー**（P7-04 / P7-05 の前提）。
2. **VAPID 鍵の生成と設定**（P6-10 の前提）。**設定中。**
3. **LINE 公式アカウントのチャネル発行とアクセストークンの設定**（P6-11）。
4. **最初に実接続する PMS を確定する**（P6-06 の前提）。
5. **スマートロックの対象機種を確定する。**
6. `RESEND_WEBHOOK_SECRET` の設定。未設定だと 401。
7. 実機で 1 通送って Resend の webhook payload を確かめる（#077）。
8. **和文フォントの配置**（P2-14 から継続）。無いと PDF が 1 枚も作られない。
9. **`pk-rollup-update` キューの作成**（4 環境）。
10. **`pk-archive-restore` キューの作成**（4 環境）。P7-08 / P7-09 / P7-10 が使う。
11. **`ARCHIVE` R2 バケットの作成**（4 環境）。
12. **外部ペネトレーションテストを 1 回実施**（P7-13 / §6.1）。**GA 判定の前提。**
13. **§6.1 のうちコードでは満たせない項目。** 社内規程・プライバシーポリシーと
    利用規約の法務レビュー・DPA 雛形。**GA チェックリスト（§10）に入る。**
14. **負荷試験の実測**（P7-12 / §4.2 MUST）。**GA 判定（P7-17）の前提。**
15. **復旧訓練の実施**（P7-14）。`docs/runbook/recovery.md` §5 に結果を書く。
    **同時に P7-16 の完了条件 2 も確かめる**（手順書だけで対応できたか）。
16. **`docs/runbook/oncall.md` の連絡先を埋める。** GA 判定の前提。
17. **`docs/guides/getting-started.md` §1 の書き換え**（OPEN_QUESTIONS #100）。
    今は「当社が行います」と書いてある。
18. **案内カードを 1 枚実際に印刷し、現場の端末で QR を読む。**
    符号化は 122 件の spec で押さえてあるが、**紙とカメラの組み合わせは
    測っていない。** 45mm 角で読めるかを 1 回だけ確かめる。

### 仕様の版上げ（P7 完了後にまとめて / 人間の指示）

- §2.4 の図の「施設コード HTLA」→ **「組織 ID」**（DECISIONS #186）
- §4.3 「シャード使用率を管理者向けダッシュボードで常時表示」→ CLI 止まり（#157）
- §19.7 の 9 表 → 実際に退避できるのは 5 表（OPEN_QUESTIONS #096）
- §19.7 の手順 3・4（DELETE / VACUUM）→ 別工程（DECISIONS #159）
- §7.3 の要点 1 の文言（「不正の証拠」）→ 禁止語を含む（DECISIONS #174）

### 積み残し（人間待ち）

- **P4-08 誤検知率の検証（人間が実施）。**
- **P6-06 PMS アダプタ 1 社。**

### 未解決の問い（新しい順）

- #105 ログイン案内カードの出力形式 → **解決済**（印刷用 HTML / #184）
- #104 「読み取り専用」の例外がどこまで許されるか → 優先度 1 だけ通した
- #103 施設の作成画面とスタッフの登録画面が無い → **半分解決**（P7-02 で
  スタッフの登録画面を置いた。**施設の作成画面は依然として無い**）
- #102 §2.4 の「PIN 初回は 0000」→ **解決済**（§2.4 v1.1 で「発行された 4 桁」）
- #101 管理者のメール招待の経路が仕様に無い → 現場スタッフだけを実装
- #100 申込み〜組織作成の経路が無い → 「当社が行います」と書いた
- #099 モジュール有効化の同意をどこに記録するか → 判定だけ置いた（P7-04 が決める）
- #098 写真の保持期間を延長する画面と API が仕様に無い → 列と検証だけ
- #097 写真の保持期限の通知イベントが §5.1 に無い → 11 件目として足した
- #096 §19.7 の 9 表のうち 4 表は `businessDate` を持たない → 5 表だけ退避
- #095 シャード監視の「ダッシュボード」をどこへ出すか → CLI 止まり
- #094 送信 Webhook を管理する画面と API が仕様に無い → 配信側だけ実装
- #093 送信 Webhook の停止を知らせるイベントが §5.1 に無い → `integration.error`
- #092 `/rooms` に対応するスコープが §6.2 に無い → `tasks:read` に寄せた
- #091 通知が届いたかを事後に追えない → 当面は運用で受ける
- #090 取引先（組織の外）への通知の宛先を引く経路が無い → 送っていない
- #089 アプリ内通知を貯める表が無い → `IN_APP` は既存の画面が正
- #088「再接続テスト」が実際には接続していない → 状態の復帰と記録だけ
- #087 未マッピングの外部 ID を個別に出せない → 件数のみ
- #086 Bearer トークンから組織を解決する手段が無い → P6-12 が決めた
- #085 `propertyId = null` の連携は `uq_integration` が効かない → 作成側で防ぐ
- #084 請求状況は税込・施設別収支は税抜 → 見出しに明記
- #083「受託施設」を判定する列（`orgType`）が無い → `VENDOR_PLAN` の契約で絞る
- #082〜#063 は P5 以前（DECISIONS / CONTINUE の履歴を参照）

### 直近の設計判断

- #186 案内カードに印字するのは「施設コード」ではなく「組織 ID」
- #185 CI を 9 ジョブから 3 ジョブへまとめる（無料枠が尽きたため / **人間の指示**）
- #184 ログイン案内カードは PDF をやめて印刷用 HTML にする（**人間の判断**）
- #183 読み取り専用でも優先度 1 の書き込みは通す
- #182 読み取り専用は middleware 1 か所で見る
- #181 ウィザードは既存の画面へ送り出す。同じフォームを 2 つ置かない
- #180 ウィザードの進行は表にせず `organization` の JSON 1 列で持つ
- #179 `organization.orgType` は記録するだけで、機能の出し分けに使わない
- #178 現場スタッフの登録は 3 表を 1 関数で作る
- #177 初期 PIN はサーバーが発行し、応答で 1 回だけ返す
- #176 P7-01 の依存「P6 完了」は着手を止めない（残り 3 件は接続情報待ち）
- #175 RUNBOOK は P7-14（復旧訓練）より先に書く
- #174 禁止語の規則を顧客向け文書にも当てる（否定形でも使わない）
- #173 同意は「有効化という操作」の条件として置き、契約の判定に混ぜない
- #172 検査ツールの版を固定する（`:latest` を使わない）
- #171 gitleaks の許可は「値そのもの」だけ。経路ごと除外しない
- #170 gitleaks は公式 action ではなく CLI を直接動かす
- #169 負荷試験はハーネスを置き、実測は人間が行う
