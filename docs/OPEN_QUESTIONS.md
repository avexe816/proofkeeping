# 未解決事項

Claude Code はここに追記して作業を止める。人間が回答したら「解決済」へ移す。

## 記入テンプレート

```
### #NNN タイトル
- 提起: YYYY-MM-DD / タスクID 実装中
- 内容: 何が判断できないか
- 影響: 影響するタスクID
- 暫定対応: とりあえずどうしたか（あれば）
```

---

## 未回答

### #001 フロントエンドフレームワーク
- 提起: 未着手 / P0-01
- 内容: Remix on Workers とするか、Next.js を OpenNext で載せるか。
- 影響: P0-01, P0-14, 以降の全 UI タスク
- 暫定対応: 1 週間の技術検証で決める
- 補足（2026-08-11 / P0-04 実装中）: **`.tsx` は現在 ESLint で検査できない。**
  `apps/web/tsconfig.json` の `include` が `src/**/*.ts` のみで、`jsx`
  コンパイラオプションもどの tsconfig にも無いため、`.tsx` を置くと
  ルール実行前に parse error になる（`was not found by the project service`）。
  `jsx` の値（`react-jsx` / `preact` / Hono JSX）はフレームワークの決定に
  依存するため P0-04 では決めていない。**最初の `.tsx` を作る P0-14 が、
  tsconfig の `include` と `jsx` を同時に設定すること。** 設定を忘れた場合は
  parse error として即座に現れるので、検査が黙って素通りすることはない。
  `pk/no-literal-string` の検出能力は
  `packages/config/eslint/rules/no-literal-string.spec.js` で担保してある。

### #002 最初に実接続する PMS
- 提起: 未着手 / P6-06
- 内容: 導入顧客が利用している PMS を調査してから決める。想定で作らない。
- 影響: P6-06

### #003 スマートロックの対象機種
- 提起: 未着手 / P6-08
- 内容: 顧客の導入予定機器に依存。
- 影響: P6-08

### #004 写真の既定保持期間
- 提起: 未着手 / P7-10
- 内容: 6 か月が顧客に受容されるか。清掃会社は請求根拠として 13 か月を求める可能性。
- 影響: P7-10, 課金プラン

### #005 1 ユーザーの複数組織所属
- 提起: 未着手 / P0-06
- 内容: 清掃会社の兼務者を想定。Membership の設計上は可能だが UI が未定義。
- 影響: P0-06, P0-14
- 補足（2026-08-11 / P0-06 実装中）: スキーマ上は **`user` を組織スコープにした。**
  組織は 16 シャードへ分散するため、1 行の `user` を複数組織で共有すると
  シャードをまたぐ参照が発生する。同一人物が 2 組織に所属する場合は
  組織ごとに `user` 行と `membership` 行を持つ（データは重複する）。
  この選択の副作用としてメールアドレスの一意性が組織内に閉じ、
  メールログインの経路が塞がる（#014）。UI は依然として未定義。

### #007 `SHARD_MAP` への書き込みと組織のシャード移送手順を持つ task が無い
- 提起: 2026-08-11 / P0-03 実装中
- 内容: `packages/db/src/router.ts` は `SHARD_MAP` を**読むだけ**で実装した。
  `docs/tasks/P0-03.md` の やること が 4 関数（`fnv1a32` / `resolveShard` /
  `getShardBinding` / `getTenantDb`）のみで、書き込みは含まれないため
  （CLAUDE.md §1-4「task に書かれていないことを実装しない」）。
  しかし現状、`shard:{organizationId}` を書く処理を持つ task が
  `docs/tasks/` の P0〜P7 137 件のどこにも無い。`docs/PK-SPEC-P7.md` §4.4
  （テナント移送）の手順 4「ルーティングテーブルを更新」がこれに当たると
  読めるが、対応する P7 の task には書き込みの記述が無い。
- 影響: P7-07（テナント移送）、および移送を要する運用全般。
  書き込みが無くても P0〜P6 は成立する（ハッシュのみで解決できる）ため、
  現時点では実害はない。
- 暫定対応: `router.ts` の冒頭コメントに、書き込みを実装する者が守る MUST
  （TTL 禁止・一括削除禁止・明示マッピング以外のキーを置かない・
  移送完了前に書く）を記載した。書き込み側は `0 <= idx < SHARD_COUNT` の
  検証を行う責任を負う（DECISIONS #007）。

### #008 `getTenantDb()` の同期・非同期が仕様書とルールで食い違う
- 提起: 2026-08-11 / P0-03 実装中
- 内容: `docs/PK-SPEC-P0.md` §19.3 のコード例は `shardIndexOf()` /
  `getShardBinding()` / `getTenantDb()` をすべて**同期**関数として書いており、
  明示マッピングの参照が無い。一方 `.claude/rules/architecture.md` §1 は
  `resolveShard()` が `env.SHARD_MAP.get()` を読む**非同期**関数として書いている。
- 影響: P0-03、および `getTenantDb()` を呼ぶすべてのリポジトリ関数（P0-07 以降）。
- 暫定対応: **非同期を採用した。** `docs/tasks/P0-03.md` の完了条件に
  「KV の明示マッピングがハッシュより優先される」があり、これは KV 読み取りを
  必須にするため、同期では実装できない。CLAUDE.md §7 に従い矛盾をここに報告する。
  結果として `getTenantDb()` は `Promise` を返し、呼び出し側は `await` が要る。
  `docs/PK-SPEC-P0.md` §19.3 のコード例の修正可否は人間の判断を待つ。

### #011 `role` の語彙が実装契約書と他のすべての文書で食い違う
- 提起: 2026-08-11 / P0-06 実装中
- 内容: `docs/PK-IMPL-CONTRACT.md` §2.10 / §4 の権限マトリクスは
  `CLEANER` / `SITE_LEAD` / `OPS_MANAGER` / `OWNER` / `VIEWER` / `PLATFORM_ADMIN`
  の 6 語で書かれている。一方 `.claude/rules/security.md` §1 と
  `docs/PK-SPEC-P0.md` §23.1、P1〜P6 の全仕様書は
  `OWNER` / `ORG_ADMIN` / `PROPERTY_MANAGER` / `INSPECTOR` / `CLEANER` /
  `VENDOR_ADMIN` / `AUDITOR` の 7 語で書かれている。
  CLAUDE.md §7 は「仕様書と矛盾したら実装契約書を優先」と定めるが、
  契約書の 6 語は §2.10 / §4 以外のどこにも現れず、対応表も無い。
  `SITE_LEAD` は `PROPERTY_MANAGER` か `INSPECTOR` か、`OPS_MANAGER` は
  `ORG_ADMIN` か、`VIEWER` は `AUDITOR` か、いずれも推測になる。
- 影響: P0-06（`membership.role`）、P0-10（権限マトリクス）、
  P0-13（越境テスト）、以降の全画面。
- 暫定対応: **7 語を採用した。** 語数が多く分離の境界が細かい方を選べば、
  後から統合はできるが分割はできない。`.claude/rules/security.md` §1 は
  「絶対に守る境界」として `CLEANER` / `INSPECTOR` を区別しており、
  6 語では表現できない。`packages/db/src/schema/user.ts` の `ROLES` に固定し、
  `schema.spec.ts` が並びごと検証している。
  **契約書 §2.10 / §4 を 7 語へ書き換えるか、対応表を追記するかは人間の判断を待つ。**
  §4 の権限マトリクスは P0-10 がそのままテストケースにする予定なので、
  それまでに解決が要る。

### #012 `docs/tasks/P0-06.md` が参照する `PK-SPEC-P0.md §5.2` が存在しない
- 提起: 2026-08-11 / P0-06 実装中
- 内容: P0-06 の task は 仕様 に `docs/PK-SPEC-P0.md §5.2` を挙げているが、
  現物の PK-SPEC-P0.md は v1.2 の差分文書で、§0 / §5.3 / §9 / §13 / §19〜§27 しか
  含まない。§5.2（データモデル）は v1.0 の節番号と思われるが、v1.0 本体が
  リポジトリに無い。**13 テーブルの列定義は仕様のどこにも存在しない。**
  同様に P0-11 の §5.4、P0-12 の §12、P0-16 の §7.2 / §8 も現物に無い。
- 影響: P0-06、P0-11、P0-12、P0-16。
- 暫定対応: `.claude/rules/*`・`docs/PK-IMPL-CONTRACT.md`・PK-SPEC-P0 §23 / §24・
  後続 task（P0-07 / P0-12 / P0-16 / P0-17 / P0-22）の記述から逆算して確定した。
  由来は各スキーマファイルの doc コメントに書いてある。
  **v1.0 本体を取り込むか、task の参照先を書き換えるかは人間の判断を待つ。**

### #013 清掃スタッフのログイン識別子が文書間で食い違う
- 提起: 2026-08-11 / P0-06 実装中
- 内容: `.claude/rules/security.md` §2 と `docs/PK-SPEC-P7.md` §2.4 の
  ログイン案内カードは「施設コード＋スタッフ番号＋PIN 4 桁」。
  一方 `docs/PK-IMPL-CONTRACT.md` §3.1 の画面 01 は「電話番号＋PIN」。
  電話番号を採ると従業員の連絡先を保存することになり、保持する個人情報が増える。
- 影響: P0-06（`user` の列）、P0-09（PIN ログイン）、P1-07（M-01 ログイン画面）。
- 暫定対応: **security.md に従い `staffNumber` を採用し、電話番号の列を作らなかった。**
  保存する個人情報は少ない方へ倒す（security.md §3 の方針）。
  後から列を足すのは非破壊だが、消すのは 3 段階のマイグレーションが要る。
  **P0-09 の着手前に確定させること。**

### #014 メールアドレスから組織を解決する手段が無い
- 提起: 2026-08-11 / P0-06 実装中
- 内容: `user` は組織スコープにした（同一人物が 2 組織に所属する場合は
  組織ごとに行を持つ。OPEN_QUESTIONS #005）。組織は 16 シャードへ分散するため、
  1 行を複数組織で共有するとシャードをまたぐ参照が発生するため。
  結果として **email の一意性は組織内でしか成立せず**、
  「メール＋パスワード」でログインする管理系（security.md §2）は、
  入力されたメールから組織 → シャードを解決する手段を持たない。
  全シャード走査は禁止（architecture.md §3）。
- 影響: P0-08（メール＋パスワード認証）。
- 暫定対応: なし。P0-06 のスキーマだけでは解決できない。
  P0-06 で作った `org_directory`（SHARD_00・DECISIONS #014）と同じ場所に
  `email_directory` を置くのが素直だが、**P0-06 の task に書かれていないため
  実装していない。** 選択肢は
    a. SHARD_00 に email → organizationId のディレクトリを足す
       （メールアドレスのハッシュを鍵にすれば平文を持たずに済む）
    b. ログイン画面で組織を先に選ばせる（UX が落ちる）
    c. メールをグローバル一意にする（1 人 1 組織に制限。#005 と衝突）
  **P0-08 の着手前に決めること。**

### #015 課金モデルが 2 通り併存している
- 提起: 2026-08-11 / P0-06 実装中
- 内容: `docs/PK-SPEC-P7.md` §3.1 はモジュール別の価格
  （Platform ¥4,980 / 組織・月、Housekeeping Core ¥3,980＋¥80/室、
  稼働照合 Audit ¥4,980 / 施設・月 …）で書かれている。
  一方 `docs/PK-BIZ-PLAN.md` §4〜§5 は版数（Base 240 円/室 ・ Pro 420 円/室 ・ Ent）で
  書かれており、「3 段階の機能別プランを採用しない理由」まで記載がある。
  どちらが正か、両立するのか（版数で束ね、内訳がモジュール）が不明。
- 影響: P0-12（エンタイトルメント）、P7-03（トライアル）、P7-04（Stripe 連携）。
- 暫定対応: 契約の単位（`subscription`: 版数・状態・期間）と機能の可否
  （`moduleEntitlement`: モジュール別の on/off）を**別テーブルに分け**、
  どちらのモデルでも表現できる形にした。金額の計算式は持たせていない。
  `moduleCode` は P0-12 の `assertEntitlement(ctx, "AUDIT")` と揃えるため
  PK-SPEC-P7 §3.1 の名前を採った。**価格モデルの確定は P7-04 までに。**

---

## 解決済

### #006 シャード明示マッピングを置く KV binding 名
- 提起: 2026-08-11 / P0-02 実装中
- 回答: 2026-08-11
- 内容: `.claude/rules/architecture.md` §1 の `resolveShard()` のコード例は
  `env.KV.get("shard:{organizationId}")` と binding 名 `KV` を使っている。
  しかし P0-02 の task が作る KV namespace は `SESSION` / `RATELIMIT` /
  `CONFIG` / `CREDENTIALS` の 4 本で、`KV` という namespace は存在しない。
- 影響: P0-03（`resolveShard()` の実装）
- 決定: **専用の namespace `SHARD_MAP` を追加する。** `CONFIG` に相乗りさせない。
  `shard:{organizationId}` が失われても `resolveShard()` はエラーにならず
  `fnv1a32` のフォールバックに落ちるため、同一テナントのデータが複数シャードへ
  無警告で分裂する。`CONFIG` は一括更新・一括削除・TTL 失効の対象であり同居できない。
  `SHARD_MAP` には TTL を設定しない。詳細は `docs/DECISIONS.md` #006。

### #009 `orgShortId` のグローバル一意性をどこで保証するか
- 提起: 2026-08-11 / P0-05 実装中
- 回答: 2026-08-11 / P0-06 で実装
- 決定: **SHARD_00 の `org_directory` テーブルと主キー制約で担保する。**
  `packages/db/src/router.ts` の `getGlobalDb(env)` が SHARD_00 の Drizzle
  インスタンスを返し、`packages/db/src/orgDirectory.ts` が
  `createOrgShortIdTaken()` / `reserveOrgShortId()` を提供する。
  KV namespace は増やさない（`wrangler.toml` は変更していない）。
  詳細と却下した選択肢は `docs/DECISIONS.md` #014。
- 残る注意: テーブル定義は 16 シャードすべてに流し、**実体は SHARD_00 のみ**を使う。
  SHARD_00 にだけ作ると `schema_version` が食い違い、起動時の不一致検出が
  正常時に発火する。組織作成は「採番 → 予約 → 組織本体」の順を守ること。

### #010 P0-06 が作る 13 テーブルの `entityPrefix` が仕様に無い
- 提起: 2026-08-11 / P0-05 実装中
- 回答: 2026-08-11 / P0-06 で実装
- 決定: 閉じたレジストリのまま 13 個を追記した。
  `org` / `tax` / `seq` / `usr` / `mem` / `asgn` / `bldg` / `flr` / `rtyp` /
  `room` / `sub` / `ent` / `audit`。`mem` / `room` は `docs/PK-SPEC-P2.md` の
  記述に合わせ、残りは P0-06 の決定。由来は `docs/DECISIONS.md` #013。
- 残る注意: **ID は永続データなので接頭辞を後から変更できない。**
  `packages/db/src/id.spec.ts` が並びと綴りを固定している。
