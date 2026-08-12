# 実装進捗

最終更新: 2026-08-12（P0-11 / P0-12 / P0-13 完了）

## 現在のセッション

```
task: P0-11 監査ログ基盤 / P0-12 エンタイトルメント基盤 / P0-13 テナント越境テスト基盤
状態: 3 件とも完了。**いずれも枠組みのみ。詳細は後続 task が足す。**
      P0-11: recordAudit() と AUDIT_ACTIONS レジストリ。**書き込みだけ。**
             マスクは書き込み経路の内側（packages/db/src/mask.ts）。
             INV-30（削除できない）は audit.spec.ts がソース走査で固定。
             P0-08 の申し送り B（失敗 5 回目の監査ログ）を消化した。
      P0-12: isModuleEnabled() と assertEntitlement()。未購入は 402。
             DECISIONS #024（402 を作る判断と、判定の順序）。
      P0-13: 4 パターンの共通スイート＋カバー範囲のレジストリ。
             DECISIONS #025（Workers 型の別プログラムとして検査する）。
      テスト 95 件を追加し、pnpm check（lint + typecheck + test 689 件 / skip 2）が通る。
次: P0-14 UI シェル。着手前に OPEN_QUESTIONS #001（UI フレームワークと
    tsconfig の jsx 設定）の判断が要る。**P0-02 は依然として未完。**
申し送り ア: **assertPermission() の失敗を監査ログに書いていない**（P0-10 の宿題への回答）。
            security.md §6 の列挙に無く、書くと全 404 が記録されて量が読めない。
            **拒否の記録が要るなら「特定の資源に対する拒否」を選んで足すこと。**
            全件を機械的に記録する形に戻さない。
申し送り イ: **ログイン成功を監査ログに書いていない。** §6 の列挙は「失敗（5 回目のみ）」
            だけ。成功を毎回書くと監査ログがログインで埋まる。
            audit.spec.ts が `auth.loginSucceeded` の不在を固定している。
申し送り ウ: **PIN ログインの失敗は監査ログを書かない。** P0-09 の申し送り甲のとおり
            PIN のロックアウト自体が未実装で、失敗回数を数えていないため。
            **列を分けるところから設計する task が、監査ログも同時に足すこと。**
申し送り エ: **監査ログの読み取り関数が無い。** 画面を作る task が足す。
            そのとき `AUDITOR` / `ORG_ADMIN` の権限（PERMISSION_ACTIONS に 1 行）と
            保持期間 5 年の扱いを同時に決めること。
申し送り オ: **エンタイトルメントの書き込み（有効化・無効化）が無い。** P7-04 の担当。
            足すときは `entitlement.updated` の監査ログとセットにすること（§6）。
申し送り カ: **施設単位の行で「無効」を表現できない。** 判定は OR で
            「1 行でも isEnabled が真なら許可」（schema/billing.ts の P0-06 決定）。
            施設ごとに止める必要が出たら、行の意味を変えず
            「組織単位の行を消して施設単位で列挙する」運用にすること。
申し送り キ: **越境テストは 15 表中 4 表のみ。** 残りは
            tests/tenant-isolation/_template.spec.ts の `UNCOVERED_TABLES` に
            理由付きで宣言してある。**表を読み書きする task が spec を足して
            その行を消す。** 宣言も spec も無い表があるとテストが落ちる。
申し送り ク: **越境テストは実 D1 ではなく発行 SQL を見ている**（P0-02 が未完）。
            実 DB に 2 組織を同居させた実測は P0-02 の完了後。差し替えるのは
            isolation-suite.ts だけで済む形にしてある。
申し送り ケ: **`pnpm test:isolation` は P0-01 から 1 件も拾っていなかった。**
            `vitest run --dir` が include の基準ディレクトリを移すため、
            ルート基準の `tests/**/*.spec.ts` と噛み合っていなかった。
            `--passWithNoTests` が付いていたので緑のままだった。**CI のジョブが
            緑であることと、テストが走っていることは別**（他のジョブでも確認すること）。
申し送り コ: **tests/fixtures/ に import を持ち込まないこと。** ルート tsconfig が
            node 型で検査するため、`@pk/db` を引くと壊れる（DECISIONS #025）。
```

--- P0-10 からの申し送り（継続）---
```
task: P0-10 認可: 権限マトリクス
状態: 完了。**権限チェックの枠組みだけを作った。個別画面の権限設定は各 task が行う。**
      OPEN_QUESTIONS #016 を解決（DECISIONS #023）。**施設列を持たない表
      （user / membership / organization / organizationTaxProfile）は
      読み取りを組織全体に開き、書き込みだけを自施設に絞る。**
      この回答は既存のリポジトリ層をそのまま追認したので、`NO_PROPERTY_SCOPE` は無変更。
      拒否は一律 404（DECISIONS #022）。**403 を返す経路をコードベースに作っていない。**
      task の完了条件「設定画面で 403」は 404 へ改訂した（INV-31 / security.md §1 が
      404 を要求しており、両立しないため）。
      追加したのは apps/web/src/middleware/{context,session,tenant,resourceGuard,index}.ts と
      apps/web/src/lib/auth/permission.ts、packages/contracts/src/error.ts。
      packages/db は 1 行も変えていない（NotFoundError も Role も既存を使う）。
      テスト 67 件を追加し、pnpm check（lint + typecheck + test 594 件）が通る。
次: （P0-11 で消化済み。recordAudit() は packages/db/src/repositories/audit.ts。
    assertPermission() の失敗は**引き続き記録していない**。上の申し送り ア を読むこと。）
申し送り a: **PK-IMPL-CONTRACT §4 の権限マトリクスを転記していない。**
            OPEN_QUESTIONS #011（role 語彙の食い違い）が未解決のため。
            §4 は 6 語（SITE_LEAD / OPS_MANAGER / VIEWER / PLATFORM_ADMIN）で書かれ、
            **§4 の OWNER は「自施設・清掃員氏名 ×」で security.md §1 の OWNER
            （組織全体）とは別概念。** 取り違えると逆向きの実装になる。
            画面を作る task は PERMISSION_ACTIONS に 1 行足す形で進めること。
申し送り b: **security.md §1 に明記の無いセルはすべて DENY に倒してある。**
            例: VENDOR_ADMIN の user.write / billing.read。
            広げるのは根拠を持つ task の仕事（P5 の請求、招待画面など）。
            base.ts の ORG_WIDE_ROLES と同じく、書き忘れが「見えすぎる」方向へ壊れない向き。
申し送り c: **SELF スコープ（自分の記録のみ）を実装していない。** M-11（security.md §5 が
            要求する本人の記録閲覧）に要るが、対象の資源が P0 に無く、判定に
            target.userId が要る。**その画面を作る task が PermissionScope に 1 値足すこと。**
申し送り d: **Hono では `await next()` を try で囲んでも下流の例外を捕まえられない。**
            Hono が各ハンドラを内側で try/catch し onError を適用してから上流へ戻すため。
            middleware で写像すると 404 のはずが 500 になる。**app.onError() /
            app.notFound() に登録すること。** 実装中にこれで 1 度落とした。
申し送り e: **`c.req.param()` は `app.use("*")` の middleware から呼ぶと空になる。**
            マッチしたルートに紐づくため。withResourceGuard はパスを `/` で割って
            自己記述 ID の形をした区切りを見る。**ルート変数に依存する実装へ戻さないこと。**
申し送り e2: **`app.route()` は子アプリの notFoundHandler を引き継がない**
            （errorHandler は保つ）。apiNotFoundHandler() は最上位の app に
            置いてある。**子アプリ側へ移すと未定義経路だけ Hono 既定のテキスト
            404 に戻り、応答の形の違いで経路の実装有無が読める。**
申し送り f: **ASSIGNED は部分集合で判定する（交差ではない）。** 帰結として
            PROPERTY_MANAGER は施設割当を持たないユーザーを作れない。
            招待 API は「招待と施設割当を同時に行う」形にすること。
申し送り g: **認証済みリクエストごとに D1 読み取りが 1〜2 回増える**
            （findMembershipByUserId + 施設スコープロールなら listAssignedPropertyIds）。
            DECISIONS #020 のとおりキャッシュを入れていない。入れるなら
            「ロール降格・施設割当の解除が即時に効く」ことを別途保証してから。
```

--- P0-09 からの申し送り（継続）---
```
task: P0-09 認証: PIN ログイン
状態: 完了。**ただし完了条件 2 件が未達**（下の申し送り甲・乙）。
      OPEN_QUESTIONS #017 を解決した。**bcryptjs は導入せず、PIN も PBKDF2-SHA256 に
      揃え、反復回数だけ 50,000 へ下げた**（実測 9.6ms。パスワードは 210,000 回で 37.8ms）。
      4 桁 PIN は候補が 10,000 通りしかなく、どちらの反復回数でも総当たりは現実的な
      時間で終わる。KDF の強度差が防御の成否を分けない一方、反復回数は現場系ログインの
      応答時間に直に乗る（DECISIONS #021）。security.md §2 の PIN 行を同じ PR で改訂した。
      PBKDF2 の機構は password.ts から pbkdf2.ts へ抽出し、パスワードと PIN で共有する。
      password.ts の公開名は 7 つとも不変で、password.spec.ts / login.spec.ts は無変更。
      セッション 16 時間・Cookie 署名・レート制限 20 req/分/IP は P0-08 のものを
      そのまま使い、session.ts / cookie.ts / rateLimit.ts は 1 行も変えていない。
      テスト 106 件を追加し、pnpm check（lint + typecheck + test 527 件）が通る。
次: （P0-10 で消化済み。セッションの authMethod で 12 時間 / 16 時間を判別できる。
    role は入っていない。）
申し送り甲: **PIN のロックアウト（5 回失敗で 15 分）は実装していない。** task の
            完了条件だが今回のスコープ外。総当たりを止めているのは 20 req/分/IP のみ。
            `failedLoginCount` 列を**パスワードと共有している**ため、中途半端に数えると
            「PIN の失敗でパスワードがロックされる」が起きる。**実装するなら列を
            分けるところから設計すること。** pinLogin.ts に理由付きのコメントを残した。
            なお既に掛かっている lockedUntil は尊重する（管理者のロックを迂回させない）。
申し送り乙: **PIN の初回変更強制も未達。** 変更画面が P1 以降で、強制する先が無い。
            /auth/pin-login の応答に pinMustChange を載せるところまで。
            **現時点では true を無視しても業務が通ってしまう。**
申し送り丙: **hashPin() を直接呼ぶと pinSchema（連番・ゾロ目の拒否）を迂回できる。**
            setPassword.ts に相当する setUserPin() を作っていない。PIN を書き込む
            経路を追加するときは必ず pinSchema を先に通すこと。P0-18 の seed も同様。
申し送り丁: **反復回数を引き上げるときは PIN_PBKDF2_PARAMS と pinLogin.ts の
            DUMMY_PIN_HASH を同時に直す。** 片方だけだと、存在しない利用者への応答
            だけが遅く（速く）なり、timing でアカウントの存在が読める。
            login.ts の DUMMY_PASSWORD_HASH（210,000 回）と共用しないのも同じ理由。
申し送り戊: **解析を許す反復回数の上限（MAX_PARSEABLE_ITERATIONS = 840,000）は
            パスワードと PIN で共通。** 方式ごとに iterations × 4 にすると、
            pin_hash に強いパラメータのハッシュが入った瞬間に「解析できない → 不一致」へ
            倒れ、正しい PIN で締め出される。上限は CPU の安全弁であって方式の識別子ではない。
```

--- P0-08 からの申し送り（継続）---
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
            → **P0-10 で消化済み**（apps/web/src/middleware/{session,tenant}.ts）。
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
            → **解決済（DECISIONS #023）。読み取りは組織全体・書き込みは自施設のみ。
            listUsers は現状のままでよい。** user.read は 7 ロールすべてに ORG。
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
            → #014 / #016 は解決済。**#011 は未解決のまま。** P0-10 は
            PK-IMPL-CONTRACT §4 のビジネス表を実装対象から外すことで回避した。
            §4 を実装対象にする task が現れたら、その前に判断が要る。
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
  - 実装したのは管理系 5 ロールのパスワードのみ。現場系の PIN は P0-09（完了）。
  - 失敗 5 回目の監査ログは **P0-11 で実装済み**。パスワード変更 API は P0 に task が無く未実装
    （関数 setUserPassword() として提供）。
- [x] P0-09 認証: PIN ログイン
  - OPEN_QUESTIONS #017 を解決。**bcryptjs は導入せず、PIN も PBKDF2-SHA256。
    反復回数のみ 50,000 へ下げた**（DECISIONS #021）。security.md §2 を改訂済み。
    PBKDF2 の機構は `apps/web/src/lib/auth/pbkdf2.ts` へ抽出し、パスワードと共有する。
  - **完了条件 2 件が未達。** ① 5 回失敗で 15 分ロック（`failedLoginCount` 列を
    パスワードと共有しているため、列を分けるところから設計が要る）
    ② 初回変更の強制（変更画面が P1 以降。応答に `pinMustChange` を返すまで）。
  - `setUserPin()` を作っていないため、`hashPin()` を直接呼ぶと `pinSchema`
    （連番・ゾロ目の拒否）を迂回できる。PIN を書き込む経路は必ず先に検証すること。
- [x] P0-10 認可: 権限マトリクス
  - **枠組みのみ。** `PERMISSION_ACTIONS` は 11 件で、security.md §1 の
    「絶対に守る境界」と P0 に実体のある資源に限る。**PK-IMPL-CONTRACT §4 の
    ビジネス表は転記していない**（OPEN_QUESTIONS #011 が未解決のため）。
    各画面の権限は、その画面を作る task が 1 行足す。
  - OPEN_QUESTIONS #016 を解決（DECISIONS #023）。**読み取りは組織全体・
    書き込みは自施設のみ。** リポジトリ層（`NO_PROPERTY_SCOPE`）は無変更。
  - 拒否は一律 404（DECISIONS #022）。**403 を返す経路が無い。**
    task の完了条件にあった「設定画面で 403」は 404 へ改訂した。
  - `finding.read` / `lostItem.readStorage` / `billing.read` は**対応する資源も
    API もまだ無い。** 境界だけ先に固定してある（P0-13 が掴めるように）。
- [x] P0-11 監査ログ基盤
  - **書き込みのみ。** 読み取り・検索・エクスポートは画面を作る task が足す。
  - PIN ログインの失敗と assertPermission() の拒否は記録していない（申し送り ア・ウ）。
- [x] P0-12 エンタイトルメント基盤
  - **判定のみ。** 契約の作成・変更（subscription の書き込み）は P7-04。
- [x] P0-13 テナント越境テスト基盤 ★最優先
  - **枠組みと 4 表のみ。** 残り 11 表は _template.spec.ts の UNCOVERED_TABLES に
    理由付きで宣言してある。表を読み書きする task が spec を足して行を消す。
  - 実 D1 での実測は P0-02 の完了後（現在は発行 SQL を見ている）。
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
