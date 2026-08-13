# 実装進捗

最終更新: 2026-08-13（P2-11 / P2-12 完了。忘れ物と設備不具合。`room.saleStatus` を追加）

## 現在のセッション

**追補（`.dev.vars` が無いときの落ち方 / DECISIONS #076）**

`SESSION_SECRET` が空文字だとログインが `INTERNAL_ERROR`（500）で落ち、
原因が応答から読めなかった。最上位の middleware（`/api/health` より前）で
必須 secret を検査し、足りなければ **503 と足りない名前**を返すようにした。
画面には直し方をそのまま出す。**必須は `SESSION_SECRET` だけ**で、
使い始める task が `REQUIRED_SECRETS` へ足す。


```
task: P2-07 / P2-08（Batch: 差戻しと証跡）
状態: 完了。**検査 → 差戻し → 再清掃 → 再検査が 1 周する。**
      証跡は 3 か所（清掃完了・検査確定・再清掃完了）から書かれる。

      P2-07 差戻しと再清掃（M-12）
           engine `reworkStatus.ts`（28 テスト）が状態機械と §4.6 の絞り。
           `GET/POST /api/v1/reworks/:id{,/start,/complete,/waive}`。
           画面 `/m/task/:taskId/rework`。M-02 の REWORK カードから入る。
           権限 `rework.read` / `rework.write` / `rework.waive` を追加。
           **`CLEANER` を許す唯一の検査系アクション**（自分の差戻しだけ）。
      P2-08 EvidenceSnapshot とハッシュ
           engine `evidence.ts`（37 テスト）が canonical JSON と検証。
           `lib/evidence/{hash,record,payload,verify}.ts`（13 テスト）。
           `GET /api/v1/tasks/:taskId/evidence/verify`（§6.3）。
           **リポジトリは INSERT と SELECT だけ**（spec がソースで固定）。

次: **P2-13 M-13 報告画面。** 依存（P2-11 / P2-12）は満たされている。
    **着手前に OPEN_QUESTIONS #051（写真の受け口）を決めること。**
    P2-13 の完了条件は「3 タップ以内で写真撮影まで到達できる」で、
    写真の経路が無いと満たせない。
```

--- 2026-08-13 追記: P2-11 / P2-12（Batch: 忘れ物と設備不具合）---

```
task: P2-11 / P2-12
状態: 完了。**現場が「見つけたもの」と「壊れているもの」を記録できる。**

      P2-11 忘れ物管理
           `schema/report.ts` に 3 表。engine `lostItemRules.ts`（23 テスト）が
           §7.2 の管理番号と §7.3 の期限・警告。
           **期限から状態を導く関数が 1 つも無い**（自動廃棄をしない）。
           `CLEANER` の絞り（自分の登録だけ・保管場所を伏せる）は
           `lib/report/lostItem.ts` に 1 か所。
      P2-12 設備不具合・修繕
           `schema/report.ts` に 3 表。engine `issueRules.ts`（24 テスト）が
           §8.2 の表と §3.6 の状態機械。
           **`room.saleStatus` 列を追加した**（§8.2 が要求。既存列は触っていない）。
           `CRITICAL` だけが客室を止め、解決しても戻さない。
```

権限は 6 アクション（`lostItem.read/write/manage` / `issue.read/write/manage`）。
越境テストは 6 表ぶん 30 ケース。`_template.spec.ts` の `TENANT_TABLES` も更新済み。

--- この Batch で入れていないもの（意図的）---
- **写真の受け口が無い**（OPEN_QUESTIONS #051）。表と `create*Photo()` はある。
  §7.5 / §8.1 の「写真必須」が効いていない。**P2-13 の前に決めること。**
- **施設ごとの忘れ物保持日数の列が無い**（OPEN_QUESTIONS #052）。常に既定。
- **W-09 / W-10（PC の管理画面）が無い。** §12.1 の一覧で、
  P2-11 / P2-12 の完了条件には含まれない。
- **免除（§4.7）の `issueReportId` 実在確認をまだ繋いでいない。**
  `findIssueReportById()` は用意した（P2-07 の DECISIONS #071）。

--- 2026-08-13 追記: P2-09 / P2-10（Batch: 証跡の画面と持ち出し）---

```
task: P2-09 / P2-10
状態: 完了。**証跡を人が読める形にし、書庫として外へ出せるようにした。**

      P2-09 W-06 証跡一覧 / W-07 証跡詳細
           engine `evidenceTimeline.ts`（17 テスト）が §12.3 のタイムライン。
           **証跡の payload からは組まない**（DECISIONS #077）。材料は
           `taskTimeLog` / `inspection` / `reworkCycle`。
           `lib/evidence/photoIntegrity.ts` が §6.3 の**写真の実体照合**
           （R2 のバイト列から取り直す。metadata を信用しない）。
           画面 `/app/p/:id/evidence{,/:taskId}`。API は §14.2 の経路名。
           サイドバーの `nav.cleaningRecords` を READY にして繋いだ。
      P2-10 証跡 ZIP エクスポート
           `lib/zip/store.ts`（18 テスト）が ZIP（STORE）の書き出し。
           **依存を足していない**（DECISIONS #080）。ZIP64 は無い。
           `lib/evidence/bundle.ts`（18 テスト）が §6.5 の構成。`verify.txt` は
           **書庫へ入れた実体から**ハッシュを取る（DECISIONS #079）。
           `consumers/evidenceExport.ts` が R2 と監査ログ（`export.evidenceZip`）。
           **状態の表を作らず R2 の有無で表す**（DECISIONS #078）。
```

**最初の Queue コンシューマが動いた。** `src/index.ts` に `queue()` を足し、
`wrangler.toml` の 4 環境へ `[[queues.consumers]]` を 1 本ずつ宣言した。
**残り 6 キューは未実装のまま**（宣言すると wrangler が起動しない）。
`tests/toolchain/wrangler.spec.ts` の `IMPLEMENTED_CONSUMERS` が
宣言と実装の食い違いを押さえる。**足す task はここへ 1 行足すこと。**

権限は `evidence.export`（`write: true`）を 1 つ足しただけ。**閲覧は
`task.read` のまま**（P2-08 の判断を踏襲）。持ち出しだけを分けてある。

--- この Batch で入れていないもの（意図的）---
- **§12.2 の「清掃チェックリストと写真」の節が無い**（OPEN_QUESTIONS #049）。
  写真はハッシュとしてのみ照合する。並べると担当者ごとの作業内容を
  一覧する面ができる（§1.3）。
- **§6.4 の訂正（`POST /api/v1/evidence/:id/corrections`）が無い**
  （OPEN_QUESTIONS #050）。DB の列は P2-08 が用意済みで、足りないのは
  経路と `ORG_ADMIN` の判定だけ。
- **`AUDITOR` は ZIP を出せない**（OPEN_QUESTIONS #048）。security.md §1 の
  「書き込み操作を一切できない」に沿った既定。運用と合うかは未確認。

--- P2-09 / P2-10 からの申し送り ---
申し送り 1: **`generatedAt` はメッセージが持つ時刻。** コンシューマ内で
            `new Date()` を呼ぶと再送のたびに manifest が変わり、
            testing.md §4 の冪等が崩れる。
申し送り 2: **証跡が 0 件のタスクでも W-07 は開ける。** タイムラインは
            業務の記録から組むので、証跡の書き込みに失敗していても
            作業の流れは追える。
申し送り 3: **写真の実体が無いときは書庫から飛ばす。** 欠けは manifest に
            現れないが、証跡の payload 側に `{ id, sha256 }` が残る。

--- 2026-08-13 追記: 通しで回らなかった原因を直した ---

**清掃タスクの自動生成が本番相当の件数で 1 件も通っていなかった。**
`expandChecklist()` が 60 行 × 11 変数 = 660 変数の文を組んでおり、
**D1 は 1 文 100 変数まで**（`packages/db/src/limits.ts` / DECISIONS #075）。
コメントは「SQLite の 999」を前提に書かれていた。タスクが作れないので
M-08 / M-09 / M-12 のいずれにも到達できていなかった。

同じ誤りが 6 関数にあった（`insertItems`（W-16）/ `listTemplateItems` /
`listChecklistItemsByIds` / `countPhotosByTask`（100 室の盤面）/
`setHousekeepingStatus`（自動生成が全客室を渡す）/ `assignTasks`（W-04 の一括））。
`chunkByParamBudget()` に寄せ、**行数ではなく変数の数で割る**形に統一した。

`repositories/paramBudget.spec.ts` が「並びを受け取る関数へ本番相当の件数を
渡し、送られた全ての文が 100 変数以内」を横断で押さえる。
**並びを受け取る関数を足す task は `CASES` に 1 行足すこと。**

ローカルで通しを確認した（詳細は `docs/tasks/P2-06.md` の追記）。
清掃 → 検査 → 不合格 → 再清掃 → 再検査待ちが 1 周し、証跡 3 件の連鎖が
検証を通り、payload の書き換えと行の抜き取りをそれぞれ検出できている。

--- この Batch で入れていないもの（意図的）--- ※ 打ち消し線の項目は P2-09 / P2-10 で解消
- ~~**W-07 / W-06（証跡の画面）が無い**（P2-09）~~ → P2-09 で実装。
- ~~**証跡 ZIP が無い**（P2-10）~~ → P2-10 で実装。
- ~~**写真の実体（R2）との照合をしていない。**~~ → P2-09 の
  `lib/evidence/photoIntegrity.ts` が実装。不一致は `console.error`（Sentry の
  取り込み先）と監査ログへ。**Sentry の SDK はまだ入っていない。**
- **W-03 の検査 SLA オレンジ表示**（§5.2 の 1 行目）は PC 側なので手付かず。
  規則（`waitStateOf()`）は engine にあるので、W-03 を触る task が使える。

--- P2-07 / P2-08 からの申し送り ---
申し送り 1: **免除の `issueReportId` は形式しか検査していない**（#071）。
            `issueReport` 表は P2-12 の担当。**P2-12 が実在確認を足すこと。**
            それまでは存在しない ID でも免除が通る。
申し送り 2: **証跡の連鎖はタスクごと**（#072）。`taskId` が null の証跡
            （日報 / `DAILY_REPORT`）は毎回先頭になり、**連鎖では守られない。**
            payload ハッシュ単体で足りるかは P2-14 が確かめること。
申し送り 3: **`CLEANING_COMPLETION` は `reworkCount === 0` のときだけ書く**
            （#073）。`reworkCount` の意味を変える task はここも直すこと。
            2 回目以降の `complete` は `REWORK_COMPLETION` になる。
申し送り 4: **`task_photo.sha256` を足したが既存の行は `null`。**
            §6.3 は「アップロード完了時にサーバー側で計算」なので、
            **後から埋めない。** 証跡の payload は `null` を空文字で載せる。
            移行が必要になったら「いつ計算した値か」を別列で持つこと。
申し送り 5: **`recordEvidence()` の payload は関数で渡す**（#074）。
            値で渡すと材料の DB 読み取りが try の外に出て、証跡の失敗が
            業務操作を 500 にする。証跡を書く経路を足す task は必ず関数で。
申し送り 6: **P2-04 / P2-06 の欠陥を 1 つ直した。** `listInspectionItems()` が
            `listTemplateItems()`（`templateId` で絞る）へ**項目 ID**を
            渡しており、M-09 の項目名とセクションが常に空欄だった。
            `listChecklistItemsByIds()` を足して両方直した。

--- P2-05 / P2-06 からの申し送り ---
申し送り 1: **§5.3 の「緊急」が実データでは効かない**（OPEN_QUESTIONS #045）。
            チェックイン予定時刻を持つ列がどこにも無い（`dailyRoomPlan` は
            `hasCheckin` の真偽だけ、`property` に `checkInTime` は無い）。
            規則は engine に実装済みで、`lib/inspection/waiting.ts` が
            `checkInAtMs: null` を渡している。**列ができたら 1 行差す。**
            `hasCheckin` を緊急に読み替えないこと（全件が緊急になる）。
申し送り 2: **担当清掃者の名前を検査画面に出していない**（#046）。
            §11.2 / §11.3 のワイヤーは「清掃: 田中」を描くが、
            プロトタイプ pk-13 の設計意図（判断の前に名前を見せない）を
            採った。API の応答にも `assigneeId` を載せていない。
申し送り 3: **プロトタイプ pk-13 は §11.3 と別物**（#047）。部屋単位の二択で、
            「24 時間後に自動で合格」まで書いてある（§2.3 が禁じている）。
            **実装の参照に使わないこと。** 描き直すか `_archive/` へ移すかは
            人間の判断待ち。
申し送り 4: **検査の記録はオフラインキューに載せていない**（#068）。
            清掃側（M-03 / M-04）とは送り方が違う。圏外では検査を始められず、
            その旨をその場で出す。**同じ画面群だから同じ送り方、としない。**
申し送り 5: **写真は項目の「結果」に紐づく。** 不合格を記録して
            `itemResultId` が返ってからでないとアップロードできない。
            M-09 は不合格を選んだ瞬間に記録を送ることでこの往復を隠している。
            **順序を入れ替えると写真が送れない。**

--- P2-04（検査 API）からの申し送り ---
申し送り 1: ~~**`reworkCycle` は作られるが進まない。**~~
            **→ P2-07 が繋いだ。** `POST /reworks/:id/{start,complete,waive}`。
            タスク側の遷移（`runTransition()`）を先に動かし、そのあと
            差戻しを 1 段進める。**免除はタスクに触らない。**
申し送り 2: **検査項目の行は「答えたときだけ」作られる。** 開始時に既定値
            つきの行を並べていない（並べたら、それが「全 PASS で初期化した
            検査」そのもの）。**`status: null` が「まだ見ていない」。**
申し送り 3: **検査写真に枚数の上限が無い。** 清掃写真は 20 枚
            （`MAX_PHOTOS_PER_TASK`）だが、検査側は仕様に記載が無いので
            置いていない。大きさと形式は同じ。
申し送り 4: **`housekeepingStatusFor()` に `inspectionPass` /
            `inspectionFail` を足した。** 客室ステータスの表は
            `packages/engine/src/roomStatus.ts` の 1 か所のまま。
            検査の着地で客室を動かす経路を別に書かないこと。
申し送り 5: ~~**`EvidenceSnapshot` を書く経路はまだ無い**（P2-08）。~~
            **→ P2-08 が繋いだ。** `lib/inspection/complete.ts` が
            差戻しサイクルを作ったあとに 1 件書く。

--- 検査の要否まわりの申し送り ---
申し送り 1: **`property.inspectionRequired`（P1）と
            `propertyInspectionPolicy.mode`（P2）が併存している。**
            行が無い施設では前者から `ALL` / `NONE` を組み立てる。
            **P2-16 で旧列を落とすときは移行バッチが要る**（OPEN_QUESTIONS
            #044）。移行せずに消すと全施設が既定の `ALL` に落ち、
            全タスクが検査待ちで滞留する。
申し送り 2: **必須検査対象の 5 条件のうち 2 つが `false` 固定。**
            「不具合・忘れ物の報告あり」は表が P2-11 / P2-12、
            「重点客室」は §3 に列そのものが無い（OPEN_QUESTIONS #043）。
            規則は engine に実装済みなので、材料を差すだけで効く。
申し送り 3: **`cleaning_task` に 7 列増えた。** 代役の行を位置で組む spec
            （`tasks.spec.ts` / `inspections.spec.ts` / `reworks.spec.ts` の
            `taskRow()`）は宣言順に合わせること。P2-07 / P2-08 で
            `rework_cycle` と `task_photo` にも 1 列ずつ増えている。
申し送り 4: ~~**`InspectionLock` を使う経路がまだ無い。**~~
            **→ P2-04 が繋いだ。** 呼び出し口は
            `apps/web/src/lib/inspection/lock.ts` の 1 か所。
            **一意制約 `(organizationId, taskId, round)` を外さないこと**
            （DO は速い断り方であって唯一の防波堤ではない）。
申し送り 5: **抽出率の分母は「その日すでに検査対象になった件数」。**
            完了した順に決まるので、その日の総数に対する割合を事前に
            確定できない。`minDailySample` はそのための下限。

--- ローカルで通しの確認をした（P1-24）---
`pnpm dev`（vite + miniflare）で以下を実機の画面として確認した。

  1. `POST /api/v1/dev/seed` → `room_type` を全削除し `room.room_type_id` を NULL に
     （seed を実行していない組織の状態を作る）
  2. W-17 `/app/settings/standard-times` が「客室タイプがまだ登録されていません」
     だけになることを確認（**task が直そうとした症状の再現**）
  3. W-25 で `TWN / ツイン / 2 / 2` を 1 件作成
  4. W-17 に行が出る（2 列 × 既定値の印）／ W-16 の選択肢に出る
  5. `/app/settings/rooms` で 101 号室に付け替え → W-05 のタイプ列が「ツイン」になる
  6. 同じコードでもう 1 件作ると「このコードはこの施設ですでに使われています: TWN」
  7. 1 室割当済みのタイプを無効化しようとすると
     「割り当てられている客室: 1」を出して確認を求める
  8. CSV `901,TWN / 902,XXX / 903,PANTRY` を取込 →
     901 はタイプ付き・902 は未設定で取り込まれ「XXX」が画面に返る・
     903 は `is_sellable = 0`（**PANTRY の既存の扱いは変えていない**）

**注意: これは P1-19 の実機テストではない。** 実端末・手袋・屋外・機内モードは
含まない。ここで見たのは PC 管理画面 4 つの結線だけ。

--- 人間にお願いすること ---
1. **P0-02 Cloudflare リソース作成**（未着手のまま）。実 D1 が 1 本しか無く、
   16 シャードの実測・`my-day` の p95 400ms（§19.6 MUST）が未計測のまま。

--- P1-02 / P1-04 / P1-06 / P0-22 の未達分からの申し送り ---
申し送り 1: **PC 管理画面はリポジトリを直接呼ぶ**（DECISIONS #049）。
            `/api/v1/standard-times` などの API は残してあるが、画面は
            通らない。**そのため `assertPermission()` を loader と action の
            両方で呼ぶ必要がある。** middleware の権限判定に頼れない。
            画面を足す task はこの 1 行を忘れないこと。
申し送り 2: ~~**`roomType` を書く経路が無い。**~~
            **→ P1-24 が解消した。** W-25 `/app/settings/room-types` と
            `/api/v1/room-types` を作り、CSV の `room_type_code` も
            マスタと突き合わせるようにした。`nav.propertySettings` は
            PLANNED のまま（客室タイプは独立項目 `nav.roomTypes` にした
            / DECISIONS #055）。
申し送り 3: **W-16 の「この施設で使用中」は表示中の施設のもの。**
            施設セレクタを切り替えると印の付く先が変わる。組織共通
            テンプレートを見ているつもりで別施設の判定を見ている、
            という読み違いが起こりうる。施設名を見出しに出してある。
申し送り 4: **W-05 は業務日を `?date=` で切り替える。** 翌日ぶんの入力も
            できるが、**開始できるかの判定はしていない**（P1-22 が M-02 で
            やっているような制限は無い）。管理側なので前日夜の入力を
            妨げないため。
申し送り 5: **標準時間の列は `CHECKOUT` / `STAYOVER` の 2 種だけ。**
            `DEEP` / `COMMON_AREA` / `RECHECK` は生成経路が P2 以降。
            **設定できて効き先が無い欄を作らない**（#050）。生成を足す
            task が `EDITABLE_TASK_TYPES` に 1 行足すこと。
申し送り 6: **`OPEN_TASK_STATUSES` は `CLOSED_TASK_STATUSES` の補集合。**
            状態を増やすときは `CLOSED_TASK_STATUSES` を見直すこと。
            列挙を忘れると「未完了」に入る＝件数が多く出る側＝安全側に倒れる。

--- P1-24（客室タイプ管理）からの申し送り ---
申し送り 1: **`room_type.code` は編集できない。** CSV 取込と P6 の
            `externalMapping` が突き合わせる鍵で、変えると過去の取込が
            別のタイプを指す。打ち間違えたら無効化して作り直す。
            画面にも API にも更新経路を置いていない。
申し送り 2: **CSV の突き合わせは大小を無視するが、一意制約は区別する。**
            `twn` と `TWN` は取込では同じものとして解決されるのに、
            `uq_room_type_property_code` は別物として 2 件登録できてしまう。
            その場合 CSV は**先に登録したほう**を選ぶ。制約を
            `COLLATE NOCASE` にするのは破壊的変更なので手を付けていない。
申し送り 3: **客室タイプを無効化しても客室の `roomTypeId` は外れない。**
            標準時間とチェックリストの設定もそのまま残る。新しく選ぶ
            場面に出てこなくなるだけ（§24.5 の向き）。
申し送り 4: **`createFakeD1()` の `meta.changes` の既定を 1 にした**
            （DECISIONS #057）。それまで `undefined` で、
            `result.meta.changes > 0` を見る 14 か所が代役の下では
            **常に false を通っていた。** 代役を触る task は、本物と
            違う分岐へ落ちていないかを疑うこと。
申し送り 5: **`INSERT` は `describeTenantIsolation()` に載せられない。**
            4 パターンのうち 3 つは `where` の形を見るもので、`INSERT` には
            その節が無い。`room_type (create)` は 4 件を直接書いた。
            **書く経路を持つ表を足す task は同じ問題に当たる。**

--- P1-21 からの申し送り ---
申し送り 1: **`dailyRoute` に書き込む経路が無い**（DECISIONS #037）。
            表は空のままなので、移動ブロック・予定時刻・訪問順の指定は
            **コードは動くが現場には出ない。** 施設の並びは常に名前の昇順。
            入力経路を作るのは P8 Workforce。
申し送り 2: **`my-day` の p95 400ms（§19.6 MUST）は未計測。**
            実 D1 が 1 本しか無い（P0-02 待ち）。クエリ本数は施設数に
            依らず 4 本で一定、というところまでしか担保していない。
申し送り 3: **M-02 の「開始する」は施設が変わるときだけ確認を挟む**（#041）。
            同一施設内は 1 タップのまま。P1-23 が M-03 側を作るとき、
            **同じ確認を二重に出さないこと。**
申し送り 4: **`my-day` はサーバー側 loader とクライアント fetch の
            二重取得になっている。** 初回描画は loader、その直後に
            クライアントが `/api/v1/tasks/my-day` を引いてキャッシュする。
            §19.7 MUST（応答全体をキャッシュ）を満たすには、クライアントが
            一度は API を通る必要があるため。**通信 1 往復ぶん無駄がある。**
            気になるなら loader を落として完全にクライアント取得へ寄せるが、
            初回描画が空になる。現場の体感を実機（P1-19）で見てから決めること。
申し送り 5: **`repositories.spec.ts` に `pure` フラグを足した。**
            SQL を発行しない関数（`newPhotoId()`）を組織条件の検査から外す印。
            **登録の網羅からは外していない。** 安易に付けないこと。

--- P1-14〜P1-18 からの申し送り ---
申し送り 1: ~~**`taskPhoto` が `repositories.spec.ts` の検証表に無い。**~~
            **→ P1-21 が解消した。** `taskPhoto` の 7 関数を
            `REPOSITORY_MODULES` と `INVOCATIONS` に登録し、組織条件と
            越境 ID の自動検査が掛かるようにした。
申し送り 2: **客室ステータスは `rollup` と繋がっていない**（OPEN_QUESTIONS #029）。
            `dailyPropertyRollup` はタスク数だけを持ち、客室状態の列が無い。
            施設セレクタのミニバッジ（`property.summary.*`）はいまも
            タスク数を出しており、客室ボードの数字（`board.status.*`）とは
            別物。**同じ画面に並べるときは名前を分けること。**
            対応を決めるのは #029 の担当。
申し送り 3: **W-04 の「出勤スタッフ」は施設に割り当てられた全員。**
            シフトのデータが無いため出勤の判定をしていない（#039）。
            休みの人にも配られうる。P8 の Workforce まではこの形。
申し送り 4: **PC 管理画面の CSS は最小限。** `styles/app.css` の冒頭が
            「ここに部品のスタイルを増やしていかないこと」と書いてあるとおり、
            今回足したのは**仕様が色そのものを要求している 4 状態**と
            それを読むための箱だけ。Tailwind + shadcn/ui の導入は
            DECISIONS #026 のまま未着手で、`pk-page` / `pk-notice` /
            `pk-form` などは P0-22 が置いたクラス名にごく薄い定義を
            当てただけ。**デザインシステムの代わりにしないこと。**
申し送り 5: **モバイルの下部タブは 3 つ**（タスク・客室・実績）。
            プロトタイプ（pk-02）の 4 つ目「検査」は P2（M-08 / M-09）。
            画面ができた task が `routes/m/layout.tsx` の `MOBILE_TABS` に
            1 行足すこと。**到達先の無いタブを置かない。**
申し送り 6: **`/m/board` は施設セレクタを持たない。** セッションで選ばれた
            施設を見る。複数施設を担当する場合の切替は P1-22（施設選択画面）
            の担当。
申し送り 7: **英語カタログは `m.*` と `board.*` まで。** 管理画面のキー
            （`tasks.*` / `nav.*` / `room.*` など）は訳していない。
            §12.1 が「管理画面は日本語のみ」と定めるため意図的。
            `locales.spec.ts` の「en は ja の部分集合」はこの前提で通っている。
申し送り 8: **`housekeepingStatus` の既定は `DIRTY`。** 既存の客室行にも
            マイグレーションで `DIRTY` が入る。**一度も清掃していない客室が
            「未清掃」として盤面に並ぶのは意図。** `READY` を既定にすると、
            分からない状態が「終わっている」側へ倒れる。

--- P1-07〜P1-13 からの申し送り（引き続き有効。解消した 2 件は除いた）---
申し送り 1: **`apps/web/tsconfig.json` の `lib` に DOM がある。** 副作用として
            Worker 側のコードで `document` を触ってもコンパイルが通る
            （実行時に落ちる）。ブラウザ専用 API を loader / API ハンドラへ
            持ち込まないこと。
申し送り 2: **`/api/v1/tasks` の登録順が意味を持つ。** `/:taskId/:action` は
            必ず最後に置くこと。Hono は登録順に照合する。回帰テストは
            `tasks.spec.ts`。
申し送り 3: **写真の削除 API を作っていない。** 必要になった task が
            監査ログとセットで足すこと（INV-27 と同じ向き）。
申し送り 4: **メモだけを保存する API が無い。** M-03 のメモは中断・完了の
            `note` に添えて送っている。
申し送り 5: **機内モードの通し操作（P1-12 の完了条件 1 件）は未検証。**
            実機テスト（P1-19）で確かめ、P1-12 の注記を消すこと。
（P1-07〜P1-13 の申し送り 3「英語カタログ」と 4「下部タブバー」は
 P1-18 / P1-15 / P1-17 で解消した。）

--- P1-01〜P1-06 からの申し送り（引き続き有効）---
申し送り 1: ~~`room.housekeepingStatus` を作っていない~~ → **P1-16 で解消。**
            列を追加し（0004）、`runTransition()` と `generateTasksForProperty()`
            から `housekeepingStatusFor()` 経由で同期している。
            OPEN_QUESTIONS #034 はクローズしてよい。
申し送り 2: **`dailyRoute`（§19.5）を作っていない。** 複数施設の担当
            （P1-21〜23）が使う表で、P1-01 の やること に無い。
            `cleaningTask.sequenceInDay` の列だけは先に入れてある
            （仕様で確定しており、後日の ALTER が無駄になるため）。
申し送り 3: **一覧 API は進捗（checklistDone / checklistTotal）を返さない。**
            タスクごとに実施結果を引くと 100 件で 100 クエリになり、
            §13 の p95 < 300ms を満たせない。M-02 が進捗を出すなら、
            `taskChecklistResult` を業務日でまとめて数える関数を足すこと
            （タスクごとに引く実装にしない）。
申し送り 4: **Cron の使用本数は 1 / 5。** 無料枠は 5 本。
            wrangler.toml の冒頭に本数を書いてある。足す task は数え直すこと。
申し送り 5: バッチは `role: "ORG_ADMIN"` の文脈を組み立てて動く
            （OPEN_QUESTIONS #033）。**監査ログを書くコンシューマを作る
            task は、その前にシステム操作者の表し方を決めること。**
申し送り 6: **写真（`taskPhoto`）は表と読み取りだけ。** アップロードは P1-11。
            `complete` の写真必須判定に使う経路だけが実装済み。
申し送り 7: P1-03 の受け入れ基準「100 室分が 5 秒以内」は**実 DB で未検証。**
            計画の組み立て（純粋関数）は 100 室で検証済みだが、D1 への
            書き込み時間は P0-02 の完了待ち。

--- P0-15〜P0-22 からの申し送り ---
申し送り 1: **`P0-23` は存在しない。** 指示に P0-23 が含まれていたが、
            docs/tasks/ の P0 は P0-22 が最後（CLAUDE.md §7 の「137 件」と一致）。
            P0-23 の task ファイルは作っていない。

申し送り 2: **`main` への直接 push の禁止（P0-19 の完了条件）は未達。**
            branch protection はリポジトリ設定であってワークフローでは表せない。
            GitHub 側で以下を有効にすること（人間の操作）。
              - Require a pull request before merging
              - Require status checks: lint / typecheck / test / test-isolation /
                migrate / forbidden-words / e2e / build

申し送り 3: **`pnpm db:seed` を配線していない**（OPEN_QUESTIONS #031）。
            シードの実体と入口（`runSeed()`）はあるが、node から直接呼べず、
            bindings も無い。P0-02 の完了後に `wrangler dev` から呼べる
            入口を足すこと。

申し送り 4: **Playwright を入れていない**（P0-19）。`pnpm test:e2e` は
            `E2E_BASE_URL` が無ければ未実施で 0、あればシナリオ不在で 1。
            preview が用意できた時点で必ず気付く形にしてある。

申し送り 5: **`schema_version` 不一致で書き込み系 API を 503 にする middleware が
            未実装**（§19.8 / P0-20 の完了条件）。毎リクエストで 16 シャードを
            引けないのでキャッシュ設計が要る。判定の実体（`checkHealth()`）はある。

申し送り 6: **Sentry を入れていない**（OPEN_QUESTIONS #030）。採用可否が
            PK-SPEC-P0 §20 で未決。決まったら `apiErrorHandler()` の 1 か所に
            足すこと。**各所に散らさない。**

申し送り 7: **施設サマリーの 3 数字は rollup の列名のまま返している**
            （OPEN_QUESTIONS #029 / DECISIONS #030）。§23.3 の
            `ready` / `inProgress` / `dirty` は客室状態の数で、rollup が持つのは
            タスクの数。対応が仕様に無い。**客室ステータスを持つ P1 が決めること。**
            P0 の間 rollup は常に空なので表示は変わらない。

申し送り 8: **客室の無効化時に「未完了タスクが N 件あります」を出していない**
            （§24.5 / P0-22 の完了条件）。`cleaningTask` が P1 の表で、
            数える対象が無い。タスクを作る task が足すこと。

申し送り 9: **`"ALL"` の拒否だけ 403 を返す**（DECISIONS #029）。
            語彙は `SCOPE_ERROR_CODES` に閉じてあり、共通の
            `API_ERROR_CODES` には足していない。**この例外を施設 ID へ
            広げないこと。** 施設 ID の拒否は今までどおり 404（INV-31）。

申し送り 10: **署名付き URL で読めるのは `seals/` だけ**（`storage/prefix.ts`）。
            清掃写真をここへ載せないこと。写真は別のキー体系と保持期間を持つ
            （security.md §4）。載せる task が判定と経路を自分で足すこと。
            `/api/v1/files` は **セッションと署名の両方**を要求する
            （`/api/v1/*` に載せてある）。片方を外さないこと。

申し送り 11: **`pnpm dev` は起動する。** 実際に確認した経路:
            `/api/health` は migration 適用前が 503（`schema_version` が
            読めない）、`pnpm db:migrate --env local` 適用後に 200。
            `/` → `/login`（302）、`/app/**` の 5 画面はすべて
            `/login?next=...` へ 302、`/api/v1/**` は未認証で 401。
            **実機（iPhone Safari / Android Chrome）は依然として未確認。**
```

--- P0-11 / P0-12 / P0-13 からの申し送り（継続）---
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
- [x] P0-14 UI シェル
  - UI は **React Router v8 framework mode**（OPEN_QUESTIONS #001 / DECISIONS #026）。
    API（Hono）と画面が 1 つの Worker に同居する。
  - **シェルだけ。** 実在する画面は /login と /app/dashboard（空の器）のみ。
    ナビの他 10 項目は「準備中」で、各画面の task が READY に変える。
  - 施設セレクタは select 1 つ。**状態サマリー・全社サマリー・検索・
    URL の施設 ID は P0-21。**
  - t() は文言カタログの引き当てだけ。**言語の選択と en は P0-15。**
  - 完了条件のうち**実機（iPhone Safari / Android Chrome）は未確認。**
    ローカルではログイン〜施設切替〜ログアウトを通してある。
- [x] P0-15 i18n 基盤
  - 文言は `locales/{ja,en}.json`。`MessageKey` は ja.json のキーから導く。
    **en は部分集合でよい**（欠けたキーは ja へ落ちる。キー名は返さない）。
  - `resolveLocale()` はユーザー属性 → 組織既定 → ja の 3 段のみ。
  - **補間を実装していない。** 7 言語で語順が変わるため（i18n.ts の注記）。
  - 契約 §7.1 の残り 5 言語は `LOCALES` に載せていない。翻訳が揃ってから足す。
- [x] P0-16 事業者・税務マスタ画面
  - `/app/settings/tax`。登録番号は `T` + 数字 13 桁。**検算はしない。**
  - 未設定は誤りではない。入力を強制せず事実として述べるだけ。
  - 角印は R2 + 15 分の署名付き URL。**署名で読めるのは `seals/` だけ。**
- [x] P0-17 DocumentSequencer（Durable Object）
  - 粒度は 組織 × 文書種別 × 年度。**リセット API は作らない**（年度が
    インスタンス名に入っていることがリセットの実装そのもの）。
  - **カウンタは同期で進めてから永続化する。** 欠番は許し、重複は許さない。
  - 番号を戻す API を作らない。500 並列で欠番・重複ゼロを検証済み。
  - wrangler.toml の `[[migrations]] tag = "v1"` を**書き換えないこと。**
- [x] P0-18 seed データ
  - 3 施設 120 室 + 清掃専用 3 室、清掃スタッフ 15 名、管理者 1 名。
  - **PIN は pinSchema → hashPin の順。** ハッシュ化は注入で受ける。
  - 冪等性は決定的 ID と onConflictDoNothing の**両方**で担保。
  - **`pnpm db:seed` は未配線**（OPEN_QUESTIONS #031 / P0-02 待ち）。
- [x] P0-19 CI/CD
  - 8 ジョブを独立させた。`migrate` は drizzle-kit check（実 D1 へ接続しない）。
  - **`main` への直接 push の禁止は未達。** branch protection は人間の操作。
  - preview デプロイは secrets が無ければ何もせず抜ける（P0-02 待ち）。
  - **Playwright は未導入。** e2e は接続先が無い間は未実施で緑。
- [x] P0-20 ヘルスチェックと監視
  - **`GET /api/health` の 1 経路のみ。** 認証を要求しない。
  - 返すのは件数と真偽だけ。**シャード番号を出さない**（spec で押さえてある）。
  - **未達: `schema_version` 不一致での書き込み 503（§19.8）と Sentry。**
    後者は採用可否が未決（OPEN_QUESTIONS #030）。
- [x] P0-21 施設セレクタ
  - `dailyPropertyRollup` を追加。**施設サマリーはここからのみ取る。**
    客室数だけは客室マスタから数える（rollup に室数の列が無い）。
  - 60 秒キャッシュは CONFIG KV。**キーにロールと担当施設を含める。**
  - `"ALL"` は全社ビューを持たないロールに **403**（DECISIONS #029）。
    施設 ID の拒否は 404 のまま。切替の監査ログは `"ALL"` のみ。
  - URL を正としてセッションを更新する。権限外の propertyId は 404。
  - **3 数字は rollup の列名のまま**（OPEN_QUESTIONS #029）。P1 が決める。
- [x] P0-22 客室マスタ 方式A
  - `Room` の 3 カラムは P0-06 の CREATE TABLE に既に入っていた（ALTER 不要）。
  - 範囲一括登録と CSV 取込は純粋関数。**重複判定を持ち込まない**
    （リポジトリ層の onConflictDoNothing が唯一の判定）。
  - 欠番除外は**利用者が明示した番号だけ。** 4 を自動で飛ばさない。
  - `externalMapping` は**定義のみ**（読み書きは P6）。
  - 無効化時の未完了タスク件数の提示（§24.5）は**解消**（DECISIONS #052）。
    件数を提示して確認を求めるところまで。**タスクは取消さない。**

## Phase 1 — 清掃現場の最小成立（M2–M3）

- [x] P1-01 スキーマ: 清掃タスク
- [x] P1-02 標準時間マスタと設定画面 — W-17 は `/app/settings/standard-times`。
      未設定のセルは**既定分数を初期値として表示**する（DECISIONS #050）。
- [x] P1-03 タスク自動生成
- [x] P1-04 W-05 当日の客室状況入力 — W-05 は `/app/p/{id}/plan`。
      「全室アウト清掃として生成」は**確認を 1 段挟む**（§3.4 MUST の逃げ道）。
- [x] P1-05 ステータス遷移 API
- [x] P1-06 チェックリスト定義 — W-16 は `/app/settings/checklists`。
      3 階層を浅い順に並べ、**その施設で実際に効くものに印**を付ける（DECISIONS #051）。
- [x] P1-07 M-01 PIN ログイン画面
- [x] P1-08 M-02 本日のタスク ★最重要画面
- [x] P1-09 M-03 タスク詳細
- [x] P1-10 M-04 チェックリスト
- [x] P1-11 写真アップロード
- [x] P1-12 オフラインキュー — **機内モードの通し操作は P1-19 で検証**
- [x] P1-13 ホーム画面追加バナー
- [x] P1-14 W-04 タスク管理・人員配分
- [x] P1-15 W-03 客室ボード / M-10
- [x] P1-16 客室ステータス同期 — OPEN_QUESTIONS #034 を解消
- [x] P1-17 M-11 自分の実績
- [x] P1-18 多言語（英語）
- [x] P1-19 実機テスト（人間が実施）— **通過**（2026-08-13 報告）。
      testing.md §6 の実機確認を実施した。
- [x] P1-20 現場検証（人間が実施）★出荷判定 — **通過**（2026-08-13 報告）。
      自社施設で 2 週間、紙を全廃して運用した。
      **これにより CLAUDE.md §9 の P2 着手条件が満たされた。**
- [x] P1-21 施設グループ表示
- [x] P1-22 施設選択画面 — 閾値は**当日の担当施設数**と比べる（DECISIONS #043）。
      翌日は選べるが開始できない（同 #042）。**組織設定の画面は無く API のみ**（同 #046）。
- [x] P1-23 施設検証と確認ダイアログ — 確認は**直前に手を付けたタスク**基準へ
      直した（DECISIONS #045。P1-21 の並び順ベースを置き換え）。
      M-11 の施設別内訳は 2 施設以上のときだけ（同 #047）。

## P1 の後・P2 の前

- [x] P1-24 施設設定：客室タイプ管理 — `/app/settings/room-types`（W-25）と
      `/api/v1/room-types`。**独立ルートにした**（DECISIONS #055）。
      客室への付け替えと CSV の `room_type_code` の突き合わせも入れた。
      ローカルで客室タイプを 0 件にしてから 1 件作り、W-17 / W-16 / W-05 が
      使える状態になることを通しで確認した。

## Phase 2 — 検査と証跡（M4）

- [x] P2-01 スキーマ: 検査・証跡
- [x] P2-02 検査ポリシーと抽出ロジック
- [x] P2-03 InspectionLock（Durable Object）
- [x] P2-04 検査 API
- [x] P2-05 M-08 検査待ち一覧
- [x] P2-06 M-09 検査実施
- [x] P2-07 差戻しと再清掃
- [x] P2-08 EvidenceSnapshot とハッシュ
- [x] P2-09 W-07 証跡詳細画面
- [x] P2-10 証跡 ZIP エクスポート
- [x] P2-11 忘れ物管理
- [x] P2-12 設備不具合・修繕
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
