# 決定事項ログ（ADR）

重要な技術判断をここに記録する。後から「なぜこうしたか」を追えるようにする。

## 記入テンプレート

```
## #NNN タイトル
- 日付: YYYY-MM-DD
- 状態: 採用 | 却下 | 保留 | 差し替え済（#NNN へ）
- 背景:
- 選択肢:
- 決定:
- 理由:
- 影響:
```

---

## #001 インフラをフルスタック Cloudflare にする
- 日付: 2026-08-10
- 状態: 採用
- 背景: 当初は Neon PostgreSQL + Prisma + Vercel + RLS を想定していた。
- 選択肢:
  1. Neon PostgreSQL + RLS
  2. Cloudflare D1 × 16 シャード
  3. アプリ層フィルタのみ
- 決定: 2 を採用。
- 理由: 500 テナント想定で日次約 190 万行が発生し、D1 の 1 データベース 10GB 上限
  （引き上げ不可）に約 26 日で到達する。Postgres でもいずれ分割が必要になるため、
  分散を設計思想に持つ D1 を最初から採る。エッジ読み取り 1〜5ms、
  コールドスタートほぼゼロも現場 30 名同時操作に適する。
- 影響: PK-SPEC-P0 v1.1 へ改訂。RLS を失う代わりに三重防御（§19.4）を導入。

## #002 外部タイムスタンプを導入しない
- 日付: 2026-08-10
- 状態: 採用
- 背景: 電子帳簿保存法の「真実性の確保」を満たす必要がある。
- 選択肢:
  1. 外部タイムスタンプサービスを契約
  2. 訂正・削除の履歴が残るシステムとして構成
- 決定: 2 を採用。
- 理由: 発行済み帳票を物理削除せず、訂正を赤伝＋再発行に限定し、
  全操作を監査ログに残せば要件を満たせる。外部サービスの契約と運用コストを回避できる。
- 影響: 帳票・証跡の DELETE / UPDATE API を作らないことが全フェーズの制約になる。

## #003 清掃員に差異レポートを見せない
- 日付: 2026-08-10
- 状態: 採用
- 背景: 稼働照合の結果を誰に見せるか。
- 決定: `CLEANER` と `INSPECTOR` には一切見せない。404 を返す。
- 理由: 清掃員が「自分の入力が誰かを疑うために使われる」と感じた瞬間、
  観察記録の入力が形骸化し、P4 のデータ基盤ごと崩れる。
- 影響: 権限マトリクス、P3 の設問設計、P4 の画面、P6 の通知すべてに波及。

## #004 実体のない script を package.json に定義しない
- 日付: 2026-08-11
- 状態: 採用
- 背景: P0-01 で root package.json を作る際、CLAUDE.md §8 のコマンド一覧をすべて並べるか迷った。
- 決定: 実際に通るものだけを定義する。P0-01 時点では `typecheck` / `lint` / `test` / `test:isolation`、
  およびその合成である `check` の 5 つ。
- 理由: 定義だけあって中身が空だと、通ったのか未実装なのかが区別できなくなる。
  `check` は実体のある 3 つの合成であり、CLAUDE.md §8 が PR 前必須と定めているため定義する。
- 影響: CLAUDE.md §8 のコマンド一覧のうち `dev` / `db:generate` / `db:migrate` / `db:seed` / `test:e2e`
  は目標形として扱い、**各 task が実体と同時に script を追加する**
  （`dev` は P0-02、`db:generate` / `db:migrate` は P0-06、`db:seed` は P0-18、
  `test:e2e` は Playwright 導入時）。定義だけして中身が空の状態を作らない。
  この規約は `tests/toolchain/workspace.spec.ts` で機械的に検査する。

## #005 UI フレームワークの決定を P0-14 まで保留する
- 日付: 2026-08-11
- 状態: 保留
- 背景: P0-01 で `apps/web` の雛形を作る際、Remix on Workers か Next.js + OpenNext かを選ぶ必要があった。
- 選択肢:
  1. P0-01 で Remix on Workers を採用する
  2. P0-01 で Next.js + OpenNext を採用する
  3. 決定を保留し、フレームワーク非依存の雛形にとどめる
- 決定: 3 を採用。`apps/web` は Hono の Worker エントリのみとし、UI フレームワークを選定しない。
- 理由: PK-SPEC-P0 §20 が「Workers 上での安定性と DX を 1 週間で技術検証して決める」としており、
  検証前に決めない。CLAUDE.md §1.4 の「推測で実装しない」にも従う。
- 影響: OPEN_QUESTIONS #001 は未解決のまま維持する。決定は P0-14（UI シェル）で行う。
  それまで `apps/web/src/index.ts` は Hono インスタンスを生成して `export default` するだけに保つ。

## #006 シャード明示マッピングを専用 KV namespace `SHARD_MAP` に置く
- 日付: 2026-08-11
- 採番の訂正: 本項は当初 `#004`（P0-02）として起票したが、`#004 実体のない script を
  package.json に定義しない`（P0-01）と番号が重複していた。P0-03 で `#006` へ改番し、
  参照元（`packages/db/src/env.ts`、`docs/tasks/P0-02.md`、`docs/PK-SPEC-P7.md` §4.4、
  `docs/PROGRESS.md`、`docs/OPEN_QUESTIONS.md` #006）も同時に更新した。
- 状態: 採用
- 背景: `resolveShard()` は `shard:{organizationId}` を KV から読み、
  無ければ `fnv1a32(organizationId) % SHARD_COUNT` にフォールバックする。
  P0-02 で KV namespace を宣言するにあたり、このキーの置き場所を決める必要があった。
  `.claude/rules/architecture.md` §1 のコード例は binding 名 `KV` を使っていたが、
  その名前の namespace は設計上どこにも存在しなかった（OPEN_QUESTIONS #006）。
- 選択肢:
  1. 設定キャッシュ用の `CONFIG` に相乗りさせる
  2. 専用 namespace `SHARD_MAP` を追加する
- 決定: 2 を採用。あわせて `SHARD_MAP` への TTL 付き書き込みを禁止する。
- 理由: 明示マッピングの喪失は例外にならない。`resolveShard()` は静かに
  ハッシュのフォールバックへ落ちるため、別シャードへ移送済みの組織では
  以後の読み書きが移送前のシャードへ向かい、**同一テナントのデータが
  複数シャードに分裂する。しかもこの破損は無警告で進行し、
  越境テストにも引っかからない**（テナント分離は破れていないため）。
  `CONFIG` は設計上、一括更新・一括削除・TTL 失効の対象であり、
  そこに置けば運用中の正当なキャッシュ破棄が上記の破損を引き起こす。
  失われてはならないデータと、失われてよいキャッシュを同じストアに置かない。
- 影響: `wrangler.toml` の全 4 環境に `SHARD_MAP` を宣言。
  `packages/db/src/env.ts` の `KvBindings` に追加。
  `.claude/rules/architecture.md` §1 に TTL 禁止を MUST として明記。
  P0-03 の `resolveShard()` は `env.SHARD_MAP` を読む。
  組織のシャード移送手順（未設計・PK-SPEC-P0 §20）は `SHARD_MAP` の
  書き込みを移送完了の前段に置くこと。
- `docs/PK-SPEC-P7.md` §4.4（テナント移送）の `resolveShard()` のコード例も
  同じコミットで `env.SHARD_MAP` に修正済み。仕様書は本ログの決定に優先されるため、
  古い例を残すと P7-07 がそのまま実装して今回塞いだ経路が復活する。
  同 §4.4 の手順 4「ルーティングテーブルを更新」は `SHARD_MAP` への書き込みを指す。

## #007 シャード解決が曖昧なとき、フォールバックせず例外にする
- 日付: 2026-08-11
- 状態: 採用
- 背景: P0-03 で `resolveShard()` を実装するにあたり、`SHARD_MAP` の値が
  読めたが妥当でない場合（数値でない・負数・`SHARD_COUNT` 以上）と、
  `env.SHARD_COUNT` 自体が不正な場合（`"abc"` → NaN、`"0"` → `x % 0` が NaN）の
  扱いを決める必要があった。
- 選択肢:
  1. 不正値を無視して `fnv1a32` のハッシュ結果へフォールバックする
  2. 範囲内に clamp する
  3. 例外を投げ、そのリクエストを失敗させる
- 決定: 3 を採用。`SHARD_COUNT_INVALID` / `SHARD_MAP_INVALID` /
  `SHARD_INDEX_OUT_OF_RANGE` を投げる。フォールバックも clamp もしない。
- 理由: 1 と 2 は誤ったシャードへ静かに読み書きを向ける。#006 と同じ破損で、
  移送済み組織なら以後のデータが移送前のシャードへ入り、**同一テナントの
  データが複数シャードに分裂する。無警告で進行し、テナント越境テストにも
  引っかからない**（分離自体は破れていないため）。壊れたデータを黙って
  作り続けるより、そのリクエストを落として気づける方がよい。
  可用性より破損回避を優先する。
- 影響: `SHARD_MAP` の値を書く側（移送手順、OPEN_QUESTIONS #007）は、
  書き込み前に `0 <= idx < SHARD_COUNT` を検証する責任を負う。
  本番の値（例: 7）をそのまま `SHARD_COUNT=1` のローカルへ持ち込むと
  即座に失敗するが、これは意図した挙動。
  例外メッセージの一部はシャード番号を含む（`SHARD_BINDING_MISSING:SHARD_07`。
  文言は PK-SPEC-P0 §19.3 が定めたもの）。architecture.md §1 の
  「シャード番号を露出しない」に従い、**HTTP レスポンス・外部ログへ
  そのまま出さないこと**を呼び出し側（P0-20）の責務とする。

## #008 ハッシュ分散の判定を 1600 組織で行う
- 日付: 2026-08-11
- 状態: 採用
- 背景: `docs/tasks/P0-03.md` の完了条件が「100 組織を生成し、16 シャードへの
  分散が均等（最大偏差 ±30% 以内）」だった。
- 選択肢:
  1. 100 組織のまま ±30% を判定する
  2. 判定件数を 1600 に増やして ±30% を判定する
  3. 100 組織のまま、判定を「全 16 シャードに 1 件以上」に緩める
- 決定: 2 を採用。あわせて 3 も別テストとして残す。
- 理由: 1 は一様ハッシュでは統計的に達成不能。100 組織・16 シャードでは
  1 シャードあたり平均 6.25 件・標準偏差 ≈2.4 に対し、±30% の許容幅は
  ±1.9 件（4.38〜8.13 件）しかない。実測でも -84%〜+108% になり、
  ハッシュの品質と無関係に落ちる。この条件を残すと「テストが通らないので
  ハッシュを差し替える」という最悪の対処を誘発する（#006 / #007 の破損に直結）。
  1600 組織なら平均 100 件・許容幅 ±30 件となり、実測 -13%〜+21% で
  分散の良否を意味のある形で判定できる。
- 影響: `docs/tasks/P0-03.md` の完了条件を書き換えた。
  `packages/db/src/router.spec.ts` は 1600 組織で ±30% を判定し、
  100 組織では「全 16 シャードに 1 件以上（分岐の網羅）」を判定する。
  判定用の組織 ID は線形合同法で決定的に生成する。CI が確率的に落ちないこと、
  および将来ハッシュを変更した際に必ず気づけることを両立させるため。

## #009 カスタム ESLint ルールの実装形式と allowlist の範囲
- 日付: 2026-08-11
- 状態: 採用
- 背景: P0-04 で `no-direct-shard-access` / `no-raw-drizzle` を実装するにあたり、
  (a) ESLint 上のどの形式で書くか、(b) 例外ファイルをどこに持たせるか、
  (c) `no-raw-drizzle` の例外にリポジトリ層を含めるか、を決める必要があった。
  (c) は仕様の記述がズレている。`docs/PK-SPEC-P0.md` §19.4 は
  「リポジトリ以外のファイルで `drizzle(` を呼ぶことを lint で禁止する」と書き、
  同 §19.3 は例外を「router.ts、マイグレーションランナー、シードのみ」と列挙している。
- 選択肢:
  1. `no-restricted-syntax` のセレクタで済ませる
  2. rule object を書き、plugin オブジェクトにまとめて flat config へ `plugins` 登録する
  3. 新規 workspace package `packages/eslint-plugin-pk` を切る
- 決定: **2 を採用。** 実体は `packages/config/eslint/rules/*.js`、
  束ねるのが `packages/config/eslint/plugin.js`、有効化が同 `base.js`。
  例外リストは**ルール側の既定値**として持ち、flat config の `files` override では持たない。
  `no-raw-drizzle` の例外は §19.3 の 3 ファイルのみとし、**リポジトリ層は含めない。**
- 理由:
  1 は却下。CLAUDE.md §4 と `.claude/rules/architecture.md` §1 がルールを固有名で
  参照しているため、名前の付かない実装では違反メッセージからも docs からも辿れない。
  ファイル単位の allowlist とユニットテストも持てない。
  3 は却下。`packages/config/eslint/base.js` が既に置き場所を指定しており、
  package を増やす必要がない。
  例外をルール側に置くのは、`files` override に散らすと「例外ファイルで警告が出ない」
  という P0-04 の完了条件を RuleTester で検証できなくなるため。
  (c) で狭い方を採ったのは、P0-07 のリポジトリが `getTenantDb()` から db を
  受け取る設計であり `drizzle(` を呼ぶ必要がないから。含めても穴が広がるだけで
  得がない。リポジトリ側で必要になったら lint が止め、設計の誤りに気づける。
- 影響:
  **allowlist に書いたパスのうち 2 つはまだ存在しない。**
  `packages/db/src/migrate.ts`（マイグレーションランナー。P0-06 が作る）と
  `packages/db/src/seed.ts`（P0-18 が作る）。**この 2 つの task は
  このファイル名を使うこと。** 別名で作った場合は lint がその場で落ちるので、
  黙って例外が外れることはない。
  適用範囲の与え方はルールの性質で分けた。アーキ 2 本はリポジトリ全域が禁止で
  例外が数ファイルなのでルール側の allowlist、文言 2 本（`no-literal-string` /
  `no-forbidden-words`）は適用対象がファイルの種類なので flat config の `files`。
  `no-forbidden-words` を全 TS に当てないのは、`docs/PK-IMPL-CONTRACT.md` §5.1 の
  禁止語に「エラー」「失敗」「異常」が含まれ、`throw new Error` 周りの通常の
  コードまで落ちるため。§5.1 自身が対象を「UI文言」と限定している。

## #010 `orgShortId` に Crockford Base32 を使わず独自 alphabet を定義する
- 日付: 2026-08-11
- 状態: 採用
- 背景: P0-05 の完了条件が「紛らわしい文字（O/0, I/1）を除外」を求めている。
  短い ID の標準としては Crockford Base32 が第一候補になる。
- 選択肢:
  1. Crockford Base32（`0123456789ABCDEFGHJKMNPQRSTVWXYZ`）をそのまま使う
  2. 独自 alphabet を定義する
- 決定: **2 を採用。** `ORG_SHORT_ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"`
  （小文字 31 文字。`0` `1` `i` `l` `o` を除外）。
- 理由: Crockford は `0` と `1` を alphabet に**残したうえで**、
  `O→0` `I,L→1` を**デコード時に**吸収する規格である。`orgShortId` は
  数値へデコードせず不透明なラベルとして URL・ログ・口頭伝達に載るだけなので、
  この吸収機構の恩恵が無い。`0` / `1` を残すこと自体が完了条件に反する。
  `l`（小文字エル）は task の文面には無いが `1` と紛らわしいため併せて外した
  （要求より厳しい方向なので条件は満たす）。
  母音の除外（意図しない単語の生成防止）は task に無いため行わない。
- 影響: 31⁶ = 887,503,681。10,000 組織で誕生日衝突が約 5.6% 起きるため
  **衝突チェックが必須**になる（OPEN_QUESTIONS #009）。
  ULID 側は規格どおり Crockford Base32（大文字）を使う。
  **alphabet が 2 つあるのは意図的であり、「重複しているから統一する」整理をしないこと。**
  併せて、**検証**は `[0-9a-z]{6}` と生成 alphabet より緩くしてある。仕様書中の
  例 `o7k2m9` は `o` を含み生成器では作れず、検証を揃えると仕様の例が
  「不正形式」になるため。照合は完全一致なので分離の強度は落ちない。

## #011 ULID を独自実装し、単調増加カウンタを必須にする
- 日付: 2026-08-11
- 状態: 採用
- 背景: P0-05 の完了条件「ULID 部分が時系列ソート可能」を Workers 上で満たす必要がある。
  npm の `ulid` パッケージ（3.0.2）が利用可能。
- 選択肢:
  1. `ulid` パッケージを依存に追加する
  2. `packages/db/src/id.ts` に約 50 行で実装する
- 決定: **2 を採用。単調増加ファクトリ（`createUlidFactory()`）として実装する。**
  タイムスタンプは `Date.now()`。`performance.now()` は Unix epoch 起点ではなく、
  ULID の 48bit ミリ秒フィールドに入れる値として意味を成さないため使わない。
- 理由: **Cloudflare Workers は I/O の合間に時計を進めない。** `Date.now()` は
  直近の I/O 時点の値で固定される。1 リクエスト内でタスクを一括生成すると
  全件のタイムスタンプが同一になり、ランダム部が独立なら並び順は乱数任せになって
  完了条件を満たさない。したがって同一ミリ秒ではランダム部を +1 する
  （ULID 規格の単調生成）実装が必須になる。Crockford の alphabet は ASCII 昇順なので
  +1 した値の base32 表現は辞書順でも増加し、**生成順 = 辞書順**が保たれる。
  依存を足さないのは、時計と乱数の注入口をテスト用に持たせたい
  （時計凍結下の 10 万件を決定的に検証する）ことと、供給網を増やさないため。
- 影響: 時計が巻き戻ったときは**例外にせず**直前のタイムスタンプに張り付けて +1 する。
  `packages/db/src/router.ts` の「曖昧なら必ず落とす」方針をここへ適用しない。
  シャード解決の誤りと違い、数ミリ秒古い時刻を載せてもデータ破損に繋がらない一方、
  ID 生成が落ちると全書き込みが停止するため。例外を投げるのは
  同一ミリ秒に 2⁸⁰ 件生成した場合（`ULID_RANDOMNESS_EXHAUSTED`）のみで、到達不能。

## #012 `NotFoundError` を `packages/db/src/errors.ts` に置く
- 日付: 2026-08-11
- 状態: 採用
- 背景: `docs/PK-SPEC-P0.md` §19.4 の `assertIdBelongsToTenant()` は
  `throw new NotFoundError("RESOURCE_NOT_FOUND")` と書かれているが、
  `NotFoundError` の実体はリポジトリのどこにも無く、**定義を所有する task も無い**
  （P0-07 はリポジトリ層の雛形、P0-10 は `resourceGuard.ts`、
  P0-20 はヘルスチェックと Sentry。エラー階層を作る task が 137 件に存在しない）。
- 選択肢:
  1. P0-05 で最小限のクラスだけ定義する
  2. `assertIdBelongsToTenant()` を boolean 返却にし、投げるのは P0-10 に任せる
  3. エラー階層一式（HTTP ステータス写像を含む）をここで作る
- 決定: **1 を採用。** `Error` を継承し `code` を持つだけのマーカークラス。
- 理由: 2 は仕様の契約（`assert` 系が投げる）を変えてしまい、
  戻り値を無視した呼び出しが素通りする。分離の第 2 層でそれは許容できない。
  3 は task に書かれていない範囲（CLAUDE.md §1-4）。HTTP ステータスへの写像は
  `packages/db` の責務ではない（db は Hono を知らない）。
- 影響: 404 への写像は P0-10 の `resourceGuard.ts` が行う。
  **後続 task はこのクラスを再定義せず、再エクスポートで取り込むこと。**
  同名クラスが 2 つあると `instanceof` が片方で外れ、越境時に 404 のはずが
  500 になる。この注意は `errors.ts` の冒頭コメントにも書いてある。
  併せて `assertIdBelongsToTenant()` は**形式不正でも越境と同じ
  `NotFoundError` を投げる**。区別すると「形式は正しいが他組織」と「そもそも不正」が
  呼び分けられ、403 と同じくリソースの存在を示唆するため。

## #013 P0-06 の 13 テーブルの `entityPrefix` を決める
- 日付: 2026-08-11
- 状態: 採用
- 背景: `ENTITY_PREFIXES` には仕様書に定義のある 11 個しか無く、P0-06 が作る
  13 テーブル分の接頭辞が仕様のどこにも書かれていなかった（OPEN_QUESTIONS #010）。
- 選択肢:
  1. `[a-z]+` の開いた検証にして、テーブルごとに好きな接頭辞を使う
  2. 閉じたレジストリのまま 13 個を追記する
- 決定: **2 を採用。** 追記したのは
  `org` / `tax` / `seq` / `usr` / `mem` / `asgn` / `bldg` / `flr` / `rtyp` /
  `room` / `sub` / `ent` / `audit`（`prop` は既存）。
- 理由: `mem` と `room` は `docs/PK-SPEC-P2.md` の記述（`"cleanerId": "mem_xxx"` /
  `"roomId": "room_302"`）に合わせた。説明用の JSON であり定義ではないが、
  仕様書に現れる唯一の綴りをわざわざ外す理由がない。残る 11 個は本 task の決定。
  開いた検証にしなかったのは、`prop` / `property`、`insp` / `inspection` の
  表記揺れが増えると統一できなくなるため（P0-05 の判断を踏襲）。
- 影響: **ID は永続データなので、一度使った接頭辞は変更できない。**
  `packages/db/src/id.spec.ts` が並びと綴りごと固定している。
  新テーブルを足す task は `ENTITY_PREFIXES` へ追記し、ここに由来を残すこと。

## #014 `orgShortId` の全局一意を SHARD_00 の `org_directory` で担保する
- 日付: 2026-08-11
- 状態: 採用
- 背景: `orgShortId` は 31 文字 6 桁で 31⁶ ≈ 8.9 億通りしかなく、1 万組織で
  誕生日衝突が約 5.6% 起きる。衝突すると 2 組織の ID が
  `assertIdBelongsToTenant()` を相互に通過し、**テナント分離の第 2 層が破れる。**
  組織は 16 シャードへ分散するため、単一シャードの UNIQUE では担保できない
  （OPEN_QUESTIONS #009）。
- 選択肢:
  1. 専用 KV namespace（`ORG_DIRECTORY`）に `orgshort:{orgShortId}` を置く
  2. Durable Object で採番を直列化する
  3. **SHARD_00 に `org_directory` テーブルを作り、主キー制約で担保する**
- 決定: **3 を採用。** `packages/db/src/router.ts` に `getGlobalDb(env)` を追加し、
  SHARD_00 の Drizzle インスタンスを返す。`wrangler.toml` は変更しない。
- 理由: 1 は KV namespace の新設（`wrangler.toml` の 4 環境すべてに宣言）が要り、
  さらに KV は結果整合なので「読んで無ければ書く」の競合を DB ほど強く塞げない。
  D1 の主キー制約なら、競合した 2 リクエストのうち後発は必ず失敗する。
  2 は `.claude/rules/architecture.md` §4 が DO の用途を 4 つに限定しており、
  ルール改訂が要る。3 は既存のリソースだけで完結し、`router.ts` が既に
  `no-direct-shard-access` の allowlist にあるため新しい例外も増えない。
- 影響:
  - **テーブル定義は 16 シャードすべてに流す。** SHARD_00 にだけ作ると
    `schema_version` がシャード間で食い違い、起動時の不一致検出
    （PK-SPEC-P0 §19.8）が正常時に発火して書き込み系 API が 503 になる。
    実体として読み書きするのは SHARD_00 のみ。
  - `getGlobalDb()` が返す DB のスキーマは `schema/global.ts` **だけ**。
    テナント表をこの経路から引くコードは型が通らない。
    これが `getTenantDb()` の迂回路になると、シャード分離とテナント分離が
    同時に無効化されるため、型で塞いでいる。
  - 組織作成は「① 採番 → ② `reserveOrgShortId()` → ③ 組織本体を自シャードへ」の順。
    シャードをまたぐトランザクションは張れない（architecture.md §1）ので
    ③ が失敗すると予約行が孤児として残るが、これは「使われない 6 桁が 1 つ減る」
    だけで破損ではない。逆順にすると衝突を許す方向へ倒れる。
  - `org_directory` に業務データを足さないこと。足した瞬間に
    「テナント横断の集計を書かない」（architecture.md §3）が崩れる。

## #015 マイグレーションを自前のランナーで 16 シャードへ適用する
- 日付: 2026-08-11
- 状態: 採用
- 背景: PK-SPEC-P0 §19.8 は「SHARD_00 から順次実行 / 各シャードの `schema_version` を
  記録 / 1 つでも失敗したら以降を中止し失敗シャード番号を出力」を MUST としている。
- 選択肢:
  1. `wrangler d1 migrations apply` を 16 回呼ぶ
  2. `drizzle-kit migrate` を使う
  3. 生成は drizzle-kit、適用は自前のランナー（`packages/db/src/migrate.ts`）
- 決定: **3 を採用。**
- 理由: 1 は適用済みの記録が wrangler 側の `d1_migrations` に入り、
  §19.8 が求める `schema_version` と二重管理になる。checksum も持たない。
  2 は Workers ランタイム上で D1 binding を要求し、CLI から 16 シャードを
  順に回す用途に合わない。3 なら「未適用の検出」「checksum 不一致の検出」
  「シャード間の不一致の検出」を 1 つのコマンド（`--check`）で満たせる。
- 影響:
  - `schema_version` は drizzle-kit の生成物に**含めない。** 最初の migration を
    適用する前に読む必要があるため、ランナーが `CREATE TABLE IF NOT EXISTS` で作る。
    DDL の正は `migrate.ts` の `SCHEMA_VERSION_DDL`、型定義は `schema/meta.ts`。
    **両者を同じ形に保つこと。**
  - `migrate.ts` に I/O を持ち込まない。`packages/db` は Workers の型で検査するため
    node 型を持てない。`node:fs` / `node:child_process` はアダプタ
    `scripts/db-migrate.ts` が持ち、ランナーへ関数として注入する。
    結果として適用計画の全分岐をテストから決定的に検証できる。
  - `wrangler d1 execute` はプレースホルダを取れないため、`schema_version` への
    INSERT は文字列連結になる。tag は `^[0-9]{4}_[a-z0-9_]+$`、checksum は
    `^[0-9a-f]{64}$` で形を閉じてから連結する。
  - CI の `migrate` ジョブ（P0-19）は `pnpm db:migrate --env <env> --check` を使う。

## #016 テナント文脈を `ShardContext` と `TenantContext` の 2 段に分ける
- 日付: 2026-08-11
- 状態: 採用
- 背景: P0-07 のリポジトリ層は `scopeToProperties()` のために
  `role` と `allowedPropertyIds` を必要とする。しかし `allowedPropertyIds` は
  `membership` と `property_assignment` を引かなければ作れない。
  その 2 つを引く関数まで完全な `TenantContext` を要求すると、
  認証（P0-08 / P0-10）が文脈を組み立てられない（循環する）。
- 選択肢:
  1. `role` / `allowedPropertyIds` を optional にする
  2. 文脈を作る間だけ「偽の」文脈（OWNER 相当）を渡す
  3. シャード解決に必要な最小限（`ShardContext`）を切り出し、
     `TenantContext` がそれを継承する
- 決定: **3 を採用。**
- 理由: 1 は「未設定」と「担当施設ゼロ」が同じ形（undefined / 空）になり、
  施設スコープの絞り込みが黙って外れる経路を作る。この失敗は例外にならず
  「余分に見える」形で現れるため検知が遅れる。2 は論外で、偽の文脈が
  そのまま業務クエリへ流れた瞬間に第 1 層が無効になる。
  3 なら**型がブートストラップ経路と業務経路を分ける。**
  業務リポジトリに `ShardContext` を渡すとコンパイルが通らない。
- 影響:
  - `ShardContext` で足りるのは `findMembershipByUserId` と
    `listAssignedPropertyIds` の 2 つだけ。**増やさないこと。**
    施設スコープが掛からない経路が広がる。
    `repositories.spec.ts` が 2 つに固定し、`withOrganizationScope()` の
    呼び出し元が `user.ts` だけであることをソース走査で確認している。
  - `getTenantDb()` / `assertIdBelongsToTenant()` の引数は `ShardContext` へ緩めた。
    `TenantContext` は部分型なので既存の呼び出しは変わらない。
  - `TenantContext` に `now: Date` を持たせた。`createdAt` / `updatedAt` は
    これを使い、リポジトリ層で `Date.now()` を呼ばない（CLAUDE.md §5）。

## #017 施設スコープの絞り込みを `undefined` で表現しない
- 日付: 2026-08-11
- 状態: 採用
- 背景: `architecture.md` §2 の例では `scopeToProperties(ctx)` が
  `and()` の引数として並ぶ。drizzle の `and()` は `undefined` を黙って捨てるため、
  「絞り込み不要」を `undefined` で表すと、実装の誤りで `undefined` が返った瞬間に
  **条件が消えて全施設が見える。**
- 選択肢:
  1. 絞り込み不要なら `undefined` を返す（素直な実装）
  2. 常に `SQL` を返す全域関数にし、不要なら恒真（`1 = 1`）を返す
- 決定: **2 を採用。**
- 理由: 1 の失敗は例外ではなく「余分に見える」形で現れ、テストの無い経路では
  気づけない。可用性より破損回避を優先する方針（#007）と同じ。
- 影響:
  - **担当施設が空（`allowedPropertyIds: []`）の施設スコープロールは恒偽
    （`1 = 0`）＝ 0 件。**「制限なし」ではない。割当前のユーザーに
    全施設が見えることを防ぐ。`base.spec.ts` が 4 ロール分を固定している。
  - `drizzle` の `inArray(col, [])` の挙動（バージョンにより例外／`false`）に
    依存しない。空配列はライブラリへ渡す前に分岐する。
  - 組織全体ロールの判定は `ORG_WIDE_ROLES` の**列挙側**に置く。
    ここに無いロールは施設スコープ扱いになるため、`ROLES` にロールが増えても
    「見えすぎる」方向には壊れない。
