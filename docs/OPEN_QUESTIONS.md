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

### #009 `orgShortId` のグローバル一意性をどこで保証するか
- 提起: 2026-08-11 / P0-05 実装中
- 内容: `orgShortId` は 6 桁・31 文字 alphabet で 31⁶ = 約 8.9 億通りしかなく、
  10,000 組織で誕生日衝突の確率が約 5.6%、100,000 組織なら実質確実に衝突する。
  **衝突チェックは必須**だが、組織レコードは 16 シャードへ分散するため
  **単一シャードの UNIQUE 制約ではグローバル一意性を担保できない。**
  全シャード横断のクエリは禁止（architecture.md §3）、`SHARD_MAP` は明示
  マッピング専用で相乗り禁止（同 §1 / DECISIONS #006）。どこに一意性の
  レジストリを置くかは仕様のどこにも記述が無い。
  考えられる置き場所（いずれも要判断）:
    a. 専用 KV namespace（例 `ORG_DIRECTORY`）に `orgshort:{orgShortId}` を置く。
       TTL 禁止・一括削除禁止の運用が `SHARD_MAP` と同様に必要になる。
    b. Durable Object で採番を直列化する（`DocumentSequencer` と同じ発想）。
    c. `orgShortId` を `organizationId` から決定的に導出し、衝突時のみ
       明示レコードを置く。
- 影響: P0-06（組織テーブルと組織作成 API）。P0-05 の成果物は影響を受けない。
- 暫定対応: `generateOrgShortId(isTaken, options?)` の第 1 引数を
  **必須の依存注入**にした。`packages/db` からは DB も KV も見ない。
  既定値を与えて「未指定なら無チェック」にすると、チェック忘れが静かに通り、
  同一 `orgShortId` を持つ 2 組織が `assertIdBelongsToTenant()` を相互に
  通過してテナント分離が破れるため、呼び出し側に必ず書かせる形にしてある。
  **`isTaken` を実装する P0-06 が、この問いへの回答を必要とする。**

### #010 P0-06 が作る 13 テーブルの `entityPrefix` が仕様に無い
- 提起: 2026-08-11 / P0-05 実装中
- 内容: 仕様書・ルールを全文検索した結果、`entityPrefix` として定義があるのは
  **11 個だけ**だった。
    - `task` / `insp` / `evd` / `lost` / `issue` / `inv` / `rcp`
      … `docs/PK-SPEC-P0.md` §19.4
    - `obs` / `find` / `run` … `.claude/rules/architecture.md` §2
      （`obs` の実例は `docs/PK-SPEC-P3.md` の schema コメント）
    - `prop` … `docs/PK-SPEC-P0.md` §23.3 と `docs/PK-SPEC-P1.md` の
      レスポンス例 `o7k2m9__prop_A`
  一方 P0-06 が作るのは organization / organizationTaxProfile /
  documentSequence / user / membership / propertyAssignment / building /
  floor / roomType / room / subscription / moduleEntitlement / auditLog の
  13 テーブルで、**どれも接頭辞が決まっていない。**
  なお `docs/PK-SPEC-P2.md` §642-648 に `"cleanerId": "mem_xxx"` /
  `"roomId": "room_302"` という記述があり、`mem` / `room` が意図されていた
  可能性はあるが、これらは ID 形式に従っていない説明用 JSON であり定義とは
  みなさなかった。
- 影響: P0-06 以降のすべてのテーブル。ID は永続データなので後から変更できない。
- 暫定対応: `packages/db/src/id.ts` の `ENTITY_PREFIXES` を
  **仕様に定義のある 11 個だけの閉じたレジストリ**にした。推測で追加していない
  （CLAUDE.md §1-4）。P0-06 は不足分を決めてここへ追記し、由来を
  `docs/DECISIONS.md` に残すこと。開いた検証（`[a-z]+` を通す）にしなかったのは、
  `prop` / `property`、`insp` / `inspection` の表記揺れが増えると統一できなくなるため。

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
