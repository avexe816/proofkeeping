ProofKeeping 製品仕様書
PK-SPEC-P1 — Phase 1「清掃現場の最小成立」 v1.0
清掃記録を、稼働の証跡に。

提供元: 株式会社ステック（stek.ai）
文書ID: PK-SPEC-P1
バージョン: v1.1
発行日: 2026-08-10
対象期間: M2–M3（8週間）
前提文書: PK-SPEC-P0 v1.0（完了済であること）
ステータス: 確定（Phase 0 完了後に着手可）

0. 本フェーズの目的
0.1 一行目標
stek 自社受託の 1 施設で、2 週間連続、紙の清掃リストを一切使わずに運用できる状態にする。

これが達成できなければ Phase 2 に進まない。機能を増やすのではなく、現場が使い続けられるかだけを判定基準にする。

0.2 このフェーズで作るもの
text
清掃タスクの自動生成
  ↓
施設責任者が人員を配分
  ↓
清掃スタッフがスマホで「開始 → 記録 → 完了」
  ↓
客室ステータスがリアルタイムに更新
  ↓
フロントが「どの部屋が今売れるか」を画面で見る
0.3 このフェーズで作らないもの
検査・差戻し（P2）

客室状況の観察記録（P3）

稼働照合・差異レポート（P4）

請求書・領収書（P5）

外部 PMS 連携（P6）

Web Push 通知（P6）

MUST: 上記を先取り実装しない。特に「観察記録」は P3 の中核であり、P1 で中途半端に作ると設計が崩れる。

0.4 Phase 0 からの引き継ぎ確認
着手前に以下を確認する。1 つでも未達なら Phase 0 に戻る。

withTenant() によるテナント分離が動作し、越境テストが CI に入っている

7 ロールの認証・認可が動作している

PIN ログインが動作し、ロック・解除ができる

recordAudit() が使える状態にある

seed で 3 施設 120 室・清掃スタッフ 15 名が投入できる

R2 へのアップロードと署名付き URL 発行が動作している

1. スコープ
1.1 In Scope
#	項目	対応章
1	清掃タスクのデータモデル	§2
2	タスク自動生成バッチ	§3
3	人員配分（自動＋手動）	§4
4	タスクステータス遷移	§5
5	チェックリスト定義と実施	§6
6	写真の撮影・アップロード	§7
7	オフラインキュー	§8
8	モバイル画面 6 本	§9
9	PC 管理画面 3 本	§10
10	客室ステータスの同期	§11
11	多言語（日英）	§12
1.2 Out of Scope
検査フロー（AWAITING_INSPECTION は状態としては作るが、検査画面は P2）

不具合・忘れ物報告（P2）

リネン枚数入力（P3）

実績レポート・日報 PDF（P2）

1室原価の算出（P2）

2. データモデル
2.1 追加スキーマ
text
// ============================================================
// 清掃タスク
// ============================================================

enum TaskType {
  CHECKOUT      // アウト清掃
  STAYOVER      // 滞在清掃
  DEEP          // 定期・特別清掃
  COMMON_AREA   // 共用部清掃
  RECHECK       // 空室点検
}

enum TaskStatus {
  CREATED               // 未割当
  ASSIGNED              // 割当済・未着手
  IN_PROGRESS           // 作業中
  PAUSED                // 中断中
  AWAITING_INSPECTION   // 検査待ち（P2 で使用）
  REWORK                // 差戻し（P2 で使用）
  COMPLETED             // 完了
  BLOCKED               // 入室不可
  CANCELLED             // 取消
}

model CleaningTask {
  id              String     @id @default(cuid())
  organizationId  String
  propertyId      String
  roomId          String
  businessDate    DateTime   @db.Date
  taskType        TaskType
  status          TaskStatus @default(CREATED)
  priority        Int        @default(50)   // 小さいほど優先
  assigneeId      String?                   // Membership.id
  standardMinutes Int
  actualMinutes   Int?
  reworkCount     Int        @default(0)
  sourceType      SourceType @default(AUTO)
  note            String?
  blockedReason   String?
  shortId         String     @unique         // URL 直リンク用 8桁

  assignedAt      DateTime?
  startedAt       DateTime?
  completedAt     DateTime?
  cancelledAt     DateTime?
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt

  checklistResults TaskChecklistResult[]
  photos           TaskPhoto[]
  timeLogs         TaskTimeLog[]

  @@unique([roomId, businessDate, taskType])
  @@index([propertyId, businessDate, status])
  @@index([assigneeId, businessDate, status])
  @@index([organizationId, businessDate])
}

enum SourceType {
  AUTO      // バッチ自動生成
  MANUAL    // 手動作成
  REGENERATED // 再生成
}

/// 作業時間の実測ログ。開始・中断・再開・完了をすべて記録する
model TaskTimeLog {
  id        String   @id @default(cuid())
  taskId    String
  event     TimeEvent
  occurredAt DateTime
  actorId   String
  reason    String?   // 中断理由
  clientTs  DateTime? // 端末側のタイムスタンプ（オフライン時の参考値）

  @@index([taskId, occurredAt])
}

enum TimeEvent {
  START
  PAUSE
  RESUME
  COMPLETE
  BLOCK
  UNBLOCK
}

// ============================================================
// チェックリスト
// ============================================================

model ChecklistTemplate {
  id             String   @id @default(cuid())
  organizationId String
  propertyId     String?  // null = 組織共通
  roomTypeId     String?  // null = 全客室タイプ
  taskType       TaskType
  name           String
  isActive       Boolean  @default(true)
  version        Int      @default(1)
  createdAt      DateTime @default(now())

  items          ChecklistItem[]

  @@index([propertyId, taskType, isActive])
}

model ChecklistItem {
  id           String   @id @default(cuid())
  templateId   String
  section      String   // "ベッドまわり" "浴室" "アメニティ"
  labels       Json     // { "ja": "シーツを交換した", "en": "Changed sheets" }
  isRequired   Boolean  @default(true)
  photoRequired Boolean @default(false)
  sortOrder    Int      @default(0)

  @@index([templateId, sortOrder])
}

model TaskChecklistResult {
  id          String   @id @default(cuid())
  taskId      String
  itemId      String
  templateVersion Int   // 実施時点のテンプレートバージョンを固定
  isChecked   Boolean  @default(false)
  skipReason  String?
  checkedAt   DateTime?
  checkedById String?

  @@unique([taskId, itemId])
  @@index([taskId])
}

// ============================================================
// 写真
// ============================================================

enum PhotoKind {
  BEFORE      // 作業前
  AFTER       // 作業後
  CHECKLIST   // チェックリスト項目に紐づく
  OTHER
}

model TaskPhoto {
  id           String    @id @default(cuid())
  taskId       String
  checklistItemId String?
  kind         PhotoKind @default(AFTER)
  storageKey   String    // R2 のキー
  width        Int
  height       Int
  fileSize     Int
  capturedAt   DateTime? // EXIF から取得（GPS は除去済）
  uploadedAt   DateTime  @default(now())
  uploadedById String
  clientId     String    @unique  // 端末側で採番。冪等性の担保に使う

  @@index([taskId, kind])
}

// ============================================================
// 標準時間マスタ
// ============================================================

model StandardTime {
  id         String   @id @default(cuid())
  propertyId String
  roomTypeId String
  taskType   TaskType
  minutes    Int
  updatedAt  DateTime @updatedAt

  @@unique([propertyId, roomTypeId, taskType])
}

// ============================================================
// 稼働予定の簡易入力（P4 の OccupancySnapshot とは別物）
// ============================================================

/// P1 では PMS 連携がないため、施設側が当日の客室状況を入力する簡易テーブル。
/// P4 で OccupancySnapshot に統合する。
model DailyRoomPlan {
  id           String   @id @default(cuid())
  propertyId   String
  roomId       String
  businessDate DateTime @db.Date
  hasCheckout  Boolean  @default(false)
  hasCheckin   Boolean  @default(false)
  isStayover   Boolean  @default(false)
  guestCount   Int      @default(0)
  declineClean Boolean  @default(false)  // 清掃辞退
  source       String   @default("MANUAL") // MANUAL | CSV
  updatedAt    DateTime @updatedAt

  @@unique([roomId, businessDate])
  @@index([propertyId, businessDate])
}
2.2 設計上の重要な決定
タスクの一意制約

text
@@unique([roomId, businessDate, taskType])
同一客室・同一業務日・同一種別のタスクは 1 件しか作らない。バッチの二重実行やリトライで重複が生まれるのを構造的に防ぐ。

テンプレートのバージョン固定

TaskChecklistResult.templateVersion に実施時点のバージョンを保存する。後からテンプレートを変更しても、過去の実施記録の意味が変わらない。これは P4 の証跡としての価値を守るために必須。

時間の実測はイベントログで持つ

actualMinutes はキャッシュに過ぎない。真実は TaskTimeLog にある。中断を挟んだ場合も正確に計算できるようにする。

text
actualMinutes = Σ(RESUME/START → PAUSE/COMPLETE の各区間)
3. タスク自動生成
3.1 生成ルール
DailyRoomPlan の状態	生成するタスク	優先度	既定分数
checkout ○ / checkin ○	CHECKOUT	10	40
checkout ○ / checkin ×	CHECKOUT	40	40
stayover ○ / declineClean ×	STAYOVER	60	20
stayover ○ / declineClean ○	生成しない	—	—
空室 3 日以上	RECHECK	80	10
客室が MAINTENANCE / OUT_OF_ORDER	生成しない	—	—
共用部（別途定義）	COMMON_AREA	70	施設設定
既定分数は StandardTime に該当レコードがあればそちらを優先する。

業界の目安: アウト清掃 30〜45 分、滞在清掃 20〜30 分が一般的なベンチマークとされる。既定値はこの範囲内に置き、施設ごとに実測で調整させる。

3.2 実行タイミング
text
02:00  日次バッチ（Vercel Cron）
       └ 全アクティブ施設について翌業務日のタスクを生成

随時   施設責任者が手動で「タスクを再生成」を実行可能
       └ 既存タスクは維持し、不足分のみ追加する（差分生成）
MUST: 再生成は冪等であること。既に IN_PROGRESS 以降のタスクには一切触れない。

3.3 差分生成のアルゴリズム
ts
// packages/scheduler/generate.ts
async function generateTasks(propertyId: string, businessDate: Date) {
  const plans = await getDailyRoomPlans(propertyId, businessDate);
  const existing = await getTasks(propertyId, businessDate);

  for (const plan of plans) {
    const desired = determineTaskType(plan);        // §3.1
    if (!desired) continue;

    const found = existing.find(
      t => t.roomId === plan.roomId && t.taskType === desired.type
    );

    if (!found) {
      await createTask({ ...desired, sourceType: "AUTO" });
      continue;
    }

    // 着手済みには触れない
    if (["IN_PROGRESS","PAUSED","AWAITING_INSPECTION","COMPLETED","REWORK"]
        .includes(found.status)) continue;

    // 未着手なら優先度と標準時間だけ更新
    await updateTask(found.id, {
      priority: desired.priority,
      standardMinutes: desired.standardMinutes,
    });
  }

  // 計画から消えた未着手タスクは取消
  await cancelOrphanedTasks(propertyId, businessDate, plans);
}
3.4 DailyRoomPlan の入力方法
P1 では PMS 連携がないため、施設側が入力する。3 つの手段を用意する。

CSV 取込（推奨）— 前日夜に PMS から出力したデータを貼り付ける

画面での一括入力 — 客室一覧にチェックボックスを並べる

未入力でも動く — 全室 CHECKOUT として生成し、現場で不要分を取消

MUST: 3 番目の逃げ道を必ず用意する。導入初日から完璧なデータ入力を求めると、現場が紙に戻る。

CSV フォーマット:

text
room_number,business_date,has_checkout,has_checkin,is_stayover,guest_count,decline_clean
302,2026-09-01,true,true,false,2,false
305,2026-09-01,false,false,true,1,false
4. 人員配分
4.1 自動配分
text
入力: 当日のタスク一覧、出勤スタッフ一覧
出力: 各タスクへの assigneeId

アルゴリズム（v1 は単純に保つ）
1. タスクを priority 昇順、次に floor → room number 昇順で並べる
2. 出勤スタッフを担当フロアの希望順に並べる
3. ラウンドロビンで割り当てる
4. 1人あたりの合計標準時間が上限（既定 420 分）を超えたら次の人へ
5. 割り当てきれなかったタスクは CREATED のまま残す
MUST: 自動配分は提案であり、施設責任者が確定操作をするまで反映しない。プレビュー画面で確認してから適用する。

4.2 手動配分
W-04 タスク管理画面でドラッグ＆ドロップ、または一括選択して担当者を変更する。

変更は即座に反映され、対象スタッフの画面に次回更新時に現れる。

IN_PROGRESS のタスクの担当変更は警告を出す（作業中の引き継ぎ）。

変更は AuditLog に記録する。

4.3 負荷の可視化
text
田中 (08)   ████████████░░░  12件 / 480分  ⚠ 上限超過
佐藤 (03)   ████████░░░░░░░   8件 / 320分
Nguyen (11) ██████░░░░░░░░░   6件 / 240分
未割当                        3件 / 120分
5. ステータス遷移
5.1 状態機械
text
CREATED ──assign──> ASSIGNED ──start──> IN_PROGRESS
   │                    │                    │
   │                    │          ┌─────────┼─────────┐
   │                    │       pause     complete   block
   │                    │          │         │         │
   │                    │          v         v         v
   │                    │       PAUSED   AWAITING_  BLOCKED
   │                    │          │      INSPECTION   │
   │                    │       resume        │      unblock
   │                    │          │          │         │
   │                    │          └──────────┼─────────┘
   │                    │                     │
   │                    │      （P2 で検査を実装するまでは
   │                    │        AWAITING_INSPECTION に入ったら
   │                    │        施設設定に応じて即 COMPLETED）
   │                    │                     v
   │                    │                 COMPLETED
   │                    │
   └────cancel──────────┴────cancel────> CANCELLED
5.2 P1 での検査の扱い
Phase 1 では検査画面を作らない。そのため:

Property.inspectionRequired = false の場合 → complete で直接 COMPLETED へ

Property.inspectionRequired = true の場合 → AWAITING_INSPECTION で停止し、施設責任者が W-03 画面から一括で「検査済にする」を実行できる

MUST: 一括承認を行った場合、AuditLog に task.bulk_approve として記録する。P2 で正式な検査フローが入ったら、この暫定機能は削除する。

5.3 遷移の制約
操作	実行可能なロール	前提条件
assign	P_MANAGER 以上、VENDOR_ADMIN	status = CREATED / ASSIGNED
start	担当者本人、P_MANAGER 以上	status = ASSIGNED / PAUSED / REWORK
pause	担当者本人	status = IN_PROGRESS、理由必須
complete	担当者本人、P_MANAGER 以上	必須チェック項目がすべて完了
block	担当者本人	理由必須（DND / 施錠 / 在室 等）
cancel	P_MANAGER 以上	status ∈ CREATED / ASSIGNED / BLOCKED
MUST: complete の際、isRequired = true のチェック項目に未完了があれば拒否する。エラーコード CHECKLIST_INCOMPLETE と未完了項目の一覧を返す。

MUST: photoRequired = true の項目に写真が紐づいていなければ complete を拒否する。エラーコード PHOTO_REQUIRED。

6. チェックリスト
6.1 テンプレートの階層
text
組織共通テンプレート（propertyId = null）
      ↓ 上書き
施設別テンプレート（roomTypeId = null）
      ↓ 上書き
客室タイプ別テンプレート
タスク生成時に最も具体的なテンプレートを 1 つ選び、そのスナップショットを TaskChecklistResult として展開する。

6.2 既定テンプレート（seed で投入）
アウト清掃（CHECKOUT）

text
【ベッドまわり】
□ シーツ・カバー類を交換した           必須
□ 枕カバーを交換した                   必須
□ ベッドメイキングを完了した           必須 / 写真
【浴室】
□ 浴槽・シャワーを洗浄した             必須
□ 洗面台・鏡を清掃した                 必須
□ トイレを洗浄・消毒した               必須
□ 浴室の水滴を拭き上げた               必須 / 写真
【客室】
□ 床を清掃した                         必須
□ ゴミを回収した                       必須
□ 什器・スイッチ類を拭いた             必須
□ 窓・鏡を清掃した                     任意
【アメニティ・備品】
□ タオル類を補充した                   必須
□ アメニティを補充した                 必須
□ 備品の破損がないことを確認した       必須
【最終確認】
□ 忘れ物がないことを確認した           必須
□ 空調・照明を設定した                 必須
□ 客室全体を撮影した                   必須 / 写真
滞在清掃（STAYOVER）

text
【ベッドまわり】
□ ベッドを整えた                       必須
□ シーツを交換した（3泊目のみ）        任意
【浴室】
□ 浴室を清掃した                       必須
□ タオル類を交換した                   必須
【客室】
□ ゴミを回収した                       必須
□ 床を清掃した                         必須
【最終確認】
□ お客様の私物に触れていない           必須
□ 客室全体を撮影した                   必須 / 写真
6.3 表示要件
セクション単位で折りたたみ可能。

「すべてチェック」ボタンを置かない。1 項目ずつタップさせる。

チェック時刻を個別に記録する（checkedAt）。連打で全項目が同一秒になっている場合、P4 で品質指標として扱える。

任意項目を飛ばす場合は理由を選択させる（skipReason）。

7. 写真
7.1 撮影方式（MUST）
getUserMedia() を使わない。iOS の PWA モードでカメラアクセスに既知の不具合があるため、標準のファイル入力を使う。

xml
<input
  type="file"
  accept="image/*"
  capture="environment"
  multiple
  hidden
/>
7.2 クライアント処理
text
撮影
 → EXIF から撮影時刻を抽出、GPS 情報を除去
 → canvas でリサイズ（長辺 1600px、JPEG quality 0.7）
 → clientId (uuid) を採番
 → オンライン: 即アップロード
   オフライン: IndexedDB に Blob を保存してキューに追加
MUST: GPS 情報はアップロード前にクライアント側で除去する。サーバー側でも二重に除去する。従業員の位置情報を扱わない方針を徹底する。

7.3 制限
項目	値
1 タスクあたり枚数	最大 20 枚
1 枚のサイズ（リサイズ後）	500KB 以下
受け付ける MIME	image/jpeg, image/png, image/heic
HEIC の扱い	クライアントで JPEG に変換
7.4 保存
text
R2 キー:
  photos/{orgId}/{propertyId}/{businessDate}/{taskId}/{photoId}.jpg

閲覧:
  15 分有効の署名付き URL を都度発行
保持期間の既定は 13 か月。組織ごとに 3〜36 か月で設定可能（設定 UI は P2）。

サムネイル生成は行わない（v1）。一覧では loading="lazy" と幅制限で対応する。

7.5 冪等性
TaskPhoto.clientId に一意制約を張る。同じ clientId で再送された場合は既存レコードを返し、R2 への二重書き込みを行わない。

8. オフライン対応
8.1 前提となる制約（MUST 理解）
iOS では以下が使えない、または信頼できない。

Background Sync API が使えない。 送信失敗したデータを後から自動再送する仕組みが存在しない。

script-writable storage の 7 日間上限がある。 Safari のタブで開いている場合、7 日間ユーザー操作がないと IndexedDB・LocalStorage・Service Worker の登録が削除される。ただしこの eviction はホーム画面に追加された PWA には適用されない。

ストレージ容量が不定。 iOS Safari のオリジンあたり容量は概ね 1GB 程度とされるが、環境により変動する。

したがって設計方針は以下とする。

IndexedDB を一時的な送信バッファとしてのみ使う。永続的なデータストアとして扱わない。

キューは 1 勤務（16 時間）以内に必ず送信される前提で設計する。

未送信データが 24 時間以上残っている場合、画面に赤い警告を出す。

ホーム画面追加を推奨するが、必須にしない。追加していない端末でも当日中に送信されれば問題ない。

8.2 送信キューの実装
ts
// lib/offline/queue.ts

type QueuedRequest = {
  id: string;              // uuid = Idempotency-Key
  url: string;
  method: "POST" | "PUT" | "PATCH";
  body: unknown;
  blobRef?: string;        // 写真の場合、IndexedDB 内の Blob キー
  createdAt: number;
  attempts: number;
  lastError?: string;
  requiresManualRetry: boolean;
};
flush のトリガー

text
1. window の "online" イベント
2. document の visibilitychange → visible
3. 画面上部「未送信 N件」バーのタップ
4. 30 秒ごとのポーリング（オンライン時のみ）
5. タスク完了操作の直後
送信ルール

直列送信（並列にしない）。順序が意味を持つため。

指数バックオフ: 1s, 2s, 4s, 8s, 16s。

5 回失敗で requiresManualRetry = true にし、赤バッジで表示する。

409（既に処理済）は成功として扱い、キューから削除する。

8.3 楽観的更新
オフラインで「完了」を押した場合:

UI 上は即座に完了扱いにする。

送信待ちであることを小さいアイコンで示す。

サーバーが拒否した場合、該当タスクを赤バッジで復帰させ、理由を表示する。

MUST: 「送信中です、お待ちください」で現場を止めない。清掃員は次の部屋へ移動できなければならない。

8.4 対象 API
API	オフライン対応
start / pause / resume / complete / block	○
チェックリストの更新	○
写真アップロード	○
タスク一覧の取得	△（直近の取得結果をキャッシュ表示）
ログイン	×
タスク生成・人員配分	×
8.5 ホーム画面追加の案内
iOS Safari のタブで開いている場合のみ、以下のバナーを表示する。

text
┌────────────────────────────────────────┐
│ ホーム画面に追加すると、より安定して      │
│ ご利用いただけます。                     │
│ 共有ボタン → 「ホーム画面に追加」        │
│                      [ 方法を見る ] [×] │
└────────────────────────────────────────┘
MUST: 1 回閉じたら 30 日間再表示しない。必須ではないことを明示する。

9. モバイル画面
9.1 画面一覧
ID	パス	画面名	ロール
M-01	/m/login	PIN ログイン	CLEANER
M-02	/m/today	本日のタスク	CLEANER
M-03	/m/task/[id]	タスク詳細	CLEANER
M-04	/m/task/[id]/checklist	チェックリスト	CLEANER
M-10	/m/board	客室ボード	P_MANAGER
M-11	/m/me	自分の実績・設定	全員
—	/t/[shortId]	タスク直リンク	CLEANER
9.2 M-02 本日のタスク
text
┌──────────────────────────────────────┐
│ ⚠ オフライン ・ 未送信 3件      [送信] │  ← 該当時のみ
├──────────────────────────────────────┤
│ サンプルホテル東京   8/10(月)    🔄    │
│ 未着手 6 ・ 作業中 1 ・ 完了 12        │
├──────────────────────────────────────┤
│ [ すべて ][ 未着手 ][ 作業中 ][ 完了 ] │
├──────────────────────────────────────┤
│ ● 305  滞在清掃            作業中 12分│
│   ダブル / 1名                        │
│                        [ 続きから ]   │
├──────────────────────────────────────┤
│   302  アウト清掃            未着手   │
│   ツイン / 2名 / 目安 40分            │
│                        [ 開始する ]   │
├──────────────────────────────────────┤
│   303  アウト清掃            未着手   │
│   シングル / 1名 / 目安 30分          │
│                        [ 開始する ]   │
└──────────────────────────────────────┘
要件

並び順: 作業中 → 差戻し → 未着手（priority 昇順）→ 入室不可 → 完了

「開始する」は 1 タップで即開始。確認ダイアログを挟まない。

タップ領域は最小 48×48px。手袋着用を前提とする。

フォント最小 16px。屋内の暗所でも読める配色。

30 秒ごとに自動更新。手動更新ボタンも置く。

プルダウンでの更新（pull-to-refresh）にも対応する。

9.3 M-03 タスク詳細
text
┌──────────────────────────────────────┐
│ ← 302号室                            │
│   アウト清掃 / ツイン / 2名            │
│   目安 40分 ・ 経過 00:23             │
├──────────────────────────────────────┤
│ [   チェックリスト  12/16   ]  →      │
├──────────────────────────────────────┤
│ 写真 (3/20)                           │
│ ┌────┐┌────┐┌────┐┌────┐            │
│ │ 📷 ││    ││    ││ ＋ │            │
│ └────┘└────┘└────┘└────┘            │
├──────────────────────────────────────┤
│ メモ                                  │
│ [                                  ]  │
├──────────────────────────────────────┤
│  [ 中断する ]  [ 入室できない ]        │
│                                       │
│  [        完了する        ]           │
└──────────────────────────────────────┘
要件

経過時間は 1 秒ごとに更新。標準時間を超えたらオレンジ、1.5 倍でグレー（赤にしない。急かす表現は避ける）。

「完了する」は必須項目未完了時は非活性にし、何が足りないかを直下に表示する。

「入室できない」は理由を選択式で入力させる（DND / 在室 / 施錠 / その他）。

9.4 M-04 チェックリスト
text
┌──────────────────────────────────────┐
│ ← 302号室 チェックリスト     12/16    │
├──────────────────────────────────────┤
│ ▼ ベッドまわり                  3/3   │
│   ☑ シーツ・カバー類を交換した        │
│   ☑ 枕カバーを交換した                │
│   ☑ ベッドメイキングを完了した 📷1    │
├──────────────────────────────────────┤
│ ▼ 浴室                          3/4   │
│   ☑ 浴槽・シャワーを洗浄した          │
│   ☑ 洗面台・鏡を清掃した              │
│   ☑ トイレを洗浄・消毒した            │
│   ☐ 浴室の水滴を拭き上げた 📷必要     │
├──────────────────────────────────────┤
│ ▶ 客室                          4/4   │
│ ▶ アメニティ・備品              2/3   │
│ ▶ 最終確認                      0/3   │
└──────────────────────────────────────┘
要件

完了したセクションは自動で折りたたむ。

写真必須の項目はタップすると直接カメラが起動する。

チェックはローカルに即反映し、送信は非同期。

9.5 M-10 客室ボード（施設責任者向け）
text
┌──────────────────────────────────────┐
│ サンプルホテル東京  8/10(月)     🔄   │
│ 清掃済 32 ・ 作業中 4 ・ 未清掃 8      │
├──────────────────────────────────────┤
│ 3F                                    │
│ ┌───┐┌───┐┌───┐┌───┐┌───┐┌───┐      │
│ │301││302││303││305││306││307│      │
│ │ ✓ ││ ⟳ ││ ─ ││ ✓ ││ ✓ ││ ⊘ │      │
│ └───┘└───┘└───┘└───┘└───┘└───┘      │
│ 4F                                    │
│ ┌───┐┌───┐┌───┐┌───┐                │
│ │401││402││403││405│                │
│ │ ✓ ││ ✓ ││ ⟳ ││ ─ │                │
│ └───┘└───┘└───┘└───┘                │
├──────────────────────────────────────┤
│ ✓清掃済 ⟳作業中 ─未清掃 ⊘入室不可     │
└──────────────────────────────────────┘
タップすると担当者・経過時間・写真枚数を表示する。

9.6 M-11 自分の実績
text
本日の実績
  完了       12件
  作業中      1件
  合計作業時間 5時間20分
  平均       26分/室

今週
  完了       58件
  平均       28分/室
MUST: 他人との比較・ランキングを表示しない。競争を煽ると品質が落ちる。

10. PC 管理画面
10.1 画面一覧
ID	パス	画面名	ロール
W-03	/app/p/[id]/board	客室ボード	P_MANAGER 以上
W-04	/app/p/[id]/tasks	タスク管理・人員配分	P_MANAGER 以上
W-05	/app/p/[id]/plan	当日の客室状況入力	P_MANAGER 以上
W-16	/app/settings/checklists	チェックリスト定義	ORG_ADMIN
W-17	/app/settings/standard-times	標準時間設定	ORG_ADMIN
10.2 W-04 タスク管理
text
2026/08/10(月)  サンプルホテル東京    [ タスクを再生成 ] [ 自動配分 ]

┌─────────────┬──────────────────────────────────────────┐
│ スタッフ      │ 割当タスク                                │
├─────────────┼──────────────────────────────────────────┤
│ 田中 (08)    │ 302 305 306 308 310 312 315 318          │
│ 8件 / 320分  │                                          │
├─────────────┼──────────────────────────────────────────┤
│ 佐藤 (03)    │ 401 402 403 405 407                      │
│ 5件 / 200分  │                                          │
├─────────────┼──────────────────────────────────────────┤
│ Nguyen (11)  │ 501 502 503                              │
│ 3件 / 120分  │                                          │
├─────────────┼──────────────────────────────────────────┤
│ 未割当       │ 601 602 603                          ⚠   │
│ 3件 / 120分  │                                          │
└─────────────┴──────────────────────────────────────────┘
部屋番号をドラッグして担当者間で移動できる。

一括選択して担当者を変更できる。

「自動配分」は必ずプレビューを挟む。

10.3 W-05 当日の客室状況入力
text
2026/08/11(火)  [ CSVを取込 ] [ 全室アウト清掃として生成 ]

部屋   タイプ    OUT  IN  連泊  人数  清掃辞退
302   ツイン    ☑    ☑   ☐    [2]     ☐
303   シングル  ☐    ☐   ☑    [1]     ☐
305   ダブル    ☑    ☐   ☐    [0]     ☐
MUST: 「全室アウト清掃として生成」を必ず用意する。データ入力を諦めても運用できる逃げ道が必要。

11. 客室ステータス同期
11.1 連動ルール
タスクの状態変化	Room.housekeepingStatus
タスク生成時	DIRTY
start	IN_PROGRESS
pause	IN_PROGRESS（変えない）
complete かつ検査不要	READY
complete かつ検査必要	INSPECTING
一括承認	READY
block	BLOCKED
cancel	変更しない
MUST: READY になるのは検査完了後のみ。検査不要設定の施設でも、その設定自体を AuditLog に残す。

11.2 手動上書き
施設責任者は客室ステータスを手動で変更できる。ただし:

理由の入力を必須にする。

AuditLog に room.status.override として記録する。

この記録は P4 の検出ルール R010（手動上書きの頻発）で使う。 P1 の時点で確実に記録しておく。

12. 多言語
12.1 対応範囲
言語	モバイル	PC 管理
日本語	○	○
英語	○	×
管理画面は日本語のみ。P1 では英語化しない。

12.2 チェックリストの多言語
ChecklistItem.labels に JSON で保持する。

json
{
  "ja": "浴室の水滴を拭き上げた",
  "en": "Wiped down bathroom surfaces"
}
未翻訳の場合は日本語を表示し、項目名の横に「日本語のみ」と小さく示す。

12.3 言語切替
ユーザー属性として保存し、ログイン直後から適用する。

M-11 の設定画面から変更できる。

ブラウザの言語設定は参照しない（共用端末で誤動作するため）。

13. 非機能要件
項目	要件
M-02 初回表示	4G で 2 秒以内に操作可能
タスク一覧 API	p95 < 300ms（100 件時）
写真 1 枚アップロード	4G で 3 秒以内
タスク生成バッチ	1 施設 100 室を 5 秒以内
同時操作	1 施設 30 名の同時操作に耐える
オフライン耐性	16 時間分の操作をキューに保持できる
端末	iOS Safari 16.4+ / Android Chrome 最新 2 版
14. 受け入れ基準
14.1 機能
100 室分のタスクが 5 秒以内に生成される

タスク生成を 3 回連続実行しても重複が発生しない

着手済みタスクが再生成で書き換わらない

必須チェック未完了で complete が拒否される

写真必須項目に写真がないと complete が拒否される

中断を 3 回挟んでも actualMinutes が正しく計算される

客室ステータスがタスクと連動して変化する

手動上書きが理由付きで監査ログに残る

14.2 オフライン
機内モードで「開始 → 写真3枚 → チェック16項目 → 完了」ができる

オンライン復帰後、上記がすべて自動送信される

同じ完了操作を 3 回送信しても actualMinutes が変わらない

未送信件数がバーに正しく表示される

5 回失敗したリクエストが赤バッジで表示される

14.3 実機
iPhone SE（小画面）で全画面が破綻しない

iPhone 14 Safari で全操作ができる

Android Chrome で全操作ができる

手袋を着けた状態で全ボタンがタップできる

屋外の明るい場所で画面が読める

14.4 現場検証（最重要）
清掃スタッフ 3 名が、説明 5 分以内で初回タスクを完了できる

外国籍スタッフ 1 名が英語表示で完了できる

stek 自社受託 1 施設で 2 週間連続、紙の清掃リストを使わずに運用できた

上記期間中、システム起因で清掃が止まった回数が 0 回

現場から「紙に戻したい」という要望が出ていない

14.5 テナント分離
他組織のタスク ID を直接指定して 403 になる

担当外施設のタスクが一覧に出ない

他人のタスクを start できない（P_MANAGER 除く）

/t/[shortId] で他組織のタスクにアクセスできない

15. リスクと対策
リスク	影響	対策
現場が紙に戻る	フェーズ失敗	導入初週は紙と併用し、2 週目から完全移行。責任者が毎日 5 分ヒアリング
電波が届かない客室がある	記録漏れ	オフラインキュー。加えて施設ごとに電波状況を事前調査
端末のバッテリー切れ	作業中断	施設にモバイルバッテリーを常備。セッション 16 時間で再ログイン不要に
写真アップロードが遅い	作業効率低下	リサイズを徹底。Wi-Fi 環境の確認。最悪は後追い送信
個人端末を使わせられない	導入不可	施設に共用端末を配備する前提で提案。1 施設 3 台程度
iOS のストレージ削除	キュー消失	1 勤務内に送信される設計。24 時間超過で警告。ホーム画面追加を推奨
チェックリストが長すぎる	形骸化	16 項目を上限の目安とする。導入時に施設と一緒に削る
16. 改訂履歴
バージョン	日付	変更内容	変更者
v1.0	2026-08-10	初版確定。	PdM
17. 未決事項
共用部清掃のタスク単位をどう定義するか（フロア単位 / エリア単位 / 施設単位）。

連泊時のシーツ交換周期を施設ごとに設定可能にするか。3 泊ごとを既定とする施設もある。

清掃スタッフの出勤情報をどこから取るか。P1 では手動選択とするが、勤怠連携の要否を確認。

共用端末を複数人で使い回す場合、ログアウトの運用をどうするか。

写真の保持期間を施設ごとに変える必要があるか。現状は組織単位。

18. Claude Code 作業指示

# PK-SPEC-P1 v1.1 追記分

> **貼り付け先**: `docs/PK-SPEC-P1.md` の末尾（§18 の後）
> **同時に修正**: 文書冒頭のバージョン表記を `v1.0` → `v1.1` に変更
> **前提**: v1.0 の内容はそのまま有効。本追記は「複数施設を担当する清掃員」への対応

---

## 19. 複数施設を担当する清掃員への対応（新設）

### 19.1 前提となる実態

清掃会社のスタッフは 1 日で 2〜3 施設を回ることがある。

```
09:00-13:00  サンプルホテル東京   12室
13:00-13:25  移動
13:30-17:00  ビジネスH横浜        7室
```

v1.0 の M-02 は単一施設を前提としていた。これを拡張する。

### 19.2 設計原則（MUST）

**清掃員に「施設を切り替える」という概念を持たせない。**

理由:
- 現場は 1 日の動線を「今日はどこを何室やるか」として把握している。
- 「切替」を要求すると、切替を忘れて別施設のタスクを開始する誤操作が起きる。
- 外国籍スタッフに「施設切替」という抽象操作を教える負担が大きい。

したがって既定は**施設ごとにグループ化した単一リスト**とする。

### 19.3 M-02 の拡張 — 施設グループ表示

```
┌──────────────────────────────────────┐
│ 本日のタスク 19件                     │
│ 8/10(月) · Nguyen (11)                │
│ ┌──────────────────────────────────┐ │
│ │ 🏢 2施設を担当              ▾    │ │
│ └──────────────────────────────────┘ │
├──────────────────────────────────────┤
│ [ すべて 19 ][ 未着手 6 ][ 完了 12 ] │
├──────────────────────────────────────┤
│ ╔══════════════════════════════════╗ │
│ ║ 🏨 サンプルホテル東京      12件  ║ │
│ ╚══════════════════════════════════╝ │
│  305  滞在清掃 · 3F      作業中12分   │
│       [      続きから  →      ]       │
│  302  アウト清掃 · 3F · 40分          │
│       [      ▶ 開始する      ]       │
├──────────────────────────────────────┤
│ ┌ 🚃 移動 · 約25分        14:30 → ┐  │
│ └──────────────────────────────────┘  │
│ ╔══════════════════════════════════╗ │
│ ║ 🏨 ビジネスH横浜            7件  ║ │
│ ╚══════════════════════════════════╝ │
│  208  アウト清掃 · 2F · 35分          │
│       [      ▶ 開始する      ]       │
└──────────────────────────────────────┘
```

**MUST**:
- 施設グループヘッダは濃色（`--brand`）の帯とし、施設名と件数を表示する。
- 施設間に移動ブロックを挟む。移動時間はシフト設定から取得する。未設定なら「移動」のみ表示し時間を出さない。
- 並び順は「本日の担当順」。同一施設内は v1.0 §9.2 の順序（作業中 → 差戻し → 未着手 → 入室不可 → 完了）に従う。
- 施設グループは折りたためること。完了した施設は自動で折りたたむ。
- フィルタ（すべて / 未着手 / 完了）は全施設をまたいで適用する。

### 19.4 担当施設が 4 以上の場合

グループ表示ではスクロールが長くなりすぎるため、起動時に施設選択画面を挟む。

```
┌──────────────────────────────────────┐
│ どの施設から始めますか？              │
│ 8/10(月) · Sari (14) · 3施設          │
├──────────────────────────────────────┤
│ ┌──────────────────────────────────┐ │
│ │ 🏨 ビジネスH横浜                 │ │
│ │    2F · 現在ここ            11   │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ 🏨 サンプルイン大阪              │ │
│ │    3F · 15:00 から           7   │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ 🏨 サンプル旅館京都              │ │
│ │    明日 8/11                 5   │ │
│ └──────────────────────────────────┘ │
│   施設を選ぶと、その施設のタスクだけ  │
│   表示されます                        │
│ [      ▶ 選んだ施設で開始      ]     │
└──────────────────────────────────────┘
```

**MUST**:
- 閾値は 4 施設。組織設定で 2〜10 の範囲で変更できる。
- 選択後も上部の「🏢 N施設を担当」から他施設へ移動できる。
- 翌日以降のタスクは選択できるが、開始はできない（表示のみ）。
- 選択した施設をセッションに保存し、当日中は再表示しない。

### 19.5 スキーマへの追加

```ts
// CleaningTask に追加
sequenceInDay: integer("sequence_in_day"),   // 担当者の当日訪問順（1,2,3...）

// 新規テーブル: 当日の施設訪問順と移動時間
export const dailyRoute = sqliteTable("daily_route", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  membershipId: text("membership_id").notNull(),
  businessDate: text("business_date").notNull(),
  sequence: integer("sequence").notNull(),        // 1, 2, 3...
  propertyId: text("property_id").notNull(),
  plannedStartAt: text("planned_start_at"),       // "09:00"
  plannedEndAt: text("planned_end_at"),           // "13:00"
  travelMinutes: integer("travel_minutes"),       // 次の施設への移動時間
  actualStartAt: integer("actual_start_at", { mode: "timestamp" }),
  actualEndAt: integer("actual_end_at", { mode: "timestamp" }),
}, (t) => ({
  uq: uniqueIndex("uq_route").on(t.membershipId, t.businessDate, t.sequence),
  idx: index("idx_route_date").on(t.organizationId, t.businessDate),
}));
```

**MUST**: `dailyRoute` が未登録でもタスク一覧は動作すること。その場合は施設名の昇順でグループ化し、移動ブロックを表示しない。

### 19.6 API の変更

```
GET /api/v1/tasks/my-day?businessDate=2026-08-10
```

v1.0 の `GET /api/v1/tasks?propertyId=...` は残す（管理画面用）。
清掃員のモバイル画面は `my-day` を使う。

```jsonc
{
  "data": {
    "businessDate": "2026-08-10",
    "propertyCount": 2,
    "totalTasks": 19,
    "summary": { "todo": 6, "inProgress": 1, "rework": 1, "done": 12 },
    "groups": [
      {
        "sequence": 1,
        "property": { "id":"o7k2m9__prop_A", "code":"HTLA", "name":"サンプルホテル東京" },
        "plannedStartAt": "09:00",
        "plannedEndAt": "13:00",
        "travelMinutesToNext": 25,
        "taskCount": 12,
        "tasks": [ /* v1.0 のタスク形式 */ ]
      },
      {
        "sequence": 2,
        "property": { "id":"o7k2m9__prop_C", "code":"BHYK", "name":"ビジネスH横浜" },
        "plannedStartAt": "13:30",
        "taskCount": 7,
        "tasks": [ /* ... */ ]
      }
    ]
  }
}
```

**MUST**:
- 1 リクエストで全施設分を返す。施設ごとに API を呼ばない。
- 全施設が同一シャード内にあることを前提とする（同一組織のため成立する）。
- レスポンスは p95 400ms 未満（3 施設 30 タスク時）。

### 19.7 オフライン対応

**MUST**:
- `my-day` のレスポンス全体を IndexedDB にキャッシュする。施設単位ではなく 1 日単位。
- オフライン時は最後に取得した `my-day` を表示する。取得時刻を画面上部に明示する。
- 施設をまたいでも送信キューは 1 本。施設ごとにキューを分けない。
- 送信時は各タスクの `propertyId` をサーバー側で検証する。クライアントから送られた値を信用しない。

### 19.8 タスク開始時の施設検証（MUST）

複数施設が同一画面に並ぶため、誤って別施設のタスクを開始するリスクがある。

```
サーバー側の検証:
1. taskId から propertyId を解決
2. その propertyId が membership.allowedPropertyIds に含まれるか
3. 含まれなければ 404（403 ではない）
```

さらに UI 側で以下を行う。

**MUST**:
- タスク詳細画面（M-03）の上部に施設名を常時表示する。部屋番号だけを表示しない。
- 前のタスクと異なる施設のタスクを開始する場合、施設名を含む確認を 1 回だけ出す。

```
┌──────────────────────────────────────┐
│ 施設が変わります                      │
│                                       │
│ サンプルホテル東京                    │
│        ↓                              │
│ ビジネスH横浜  208号室                │
│                                       │
│ [ キャンセル ]  [ 開始する ]          │
└──────────────────────────────────────┘
```

同一施設内の連続タスクでは確認を出さない（v1.0 §9.2 の「1 タップで開始」を維持）。

### 19.9 M-11 実績の施設別内訳

```
本日
  完了          12件
  作業時間      5時間20分
  平均          26分/室

施設別（今月）
  🏨 サンプルホテル東京    218件
  🏨 ビジネスH横浜          96件
  合計                     314件

この記録は業務改善のためのものです。
個人の評価には使用されません。
```

**MUST**: v1.0 §9.6 の原則を維持する。他人との比較・ランキングを表示しない。施設別内訳も自分の分のみ。

---

## 20. 受け入れ基準（追加分）

- [ ] 2 施設担当時、施設グループヘッダ付きの単一リストが表示される
- [ ] 施設間に移動ブロックが表示される（`dailyRoute` 設定時）
- [ ] `dailyRoute` 未登録でもタスク一覧が動作する
- [ ] 完了した施設グループが自動で折りたたまれる
- [ ] フィルタが全施設をまたいで適用される
- [ ] 4 施設以上で起動時に施設選択画面が出る
- [ ] 閾値が組織設定で変更できる
- [ ] 翌日以降のタスクが表示のみで開始できない
- [ ] `my-day` が 1 リクエストで全施設分を返す
- [ ] `my-day` の p95 が 400ms 未満（3 施設 30 タスク）
- [ ] オフライン時に最後の `my-day` が表示され、取得時刻が明示される
- [ ] 送信キューが施設をまたいで 1 本になっている
- [ ] 担当外施設の `taskId` で `start` すると 404
- [ ] M-03 の上部に施設名が常時表示される
- [ ] 施設が変わるタスクの開始時に確認が 1 回出る
- [ ] 同一施設内の連続タスクでは確認が出ない
- [ ] M-11 に施設別内訳が表示され、他人との比較がない

---

## 21. 実装順序への追加

v1.0 §18 の実装順序を以下のように変更する。

```
5. §9 モバイル画面
   5-1. M-01 ログイン
   5-2. M-02 本日のタスク（単一施設）      ← v1.0
   5-3. M-03 タスク詳細
   5-4. M-04 チェックリスト
   5-5. §19.3 施設グループ表示             ← 追加
   5-6. §19.4 施設選択画面                 ← 追加
   5-7. §19.8 施設検証と確認ダイアログ      ← 追加
```

**MUST**: 5-2 で単一施設版を先に完成させ、現場で 1 施設の運用を確認してから 5-5 へ進む。最初から複数施設対応を作ると、単純なケースが動く前に複雑さが入り込む。

---

## 22. Claude Code 追加指示

```markdown
## P1 v1.1 で追加された作業

新規タスク:
- P1-21 施設グループ表示（§19.3）
- P1-22 施設選択画面（§19.4）
- P1-23 施設検証と確認ダイアログ（§19.8）

## P1 v1.1 固有の絶対ルール
- 清掃員に「施設を切り替える」UI を作らない。グループ表示が既定。
- 施設ごとに API を呼ばない。my-day で 1 リクエスト。
- 送信キューを施設ごとに分けない。1 日 1 本。
- 担当外施設の taskId には 404 を返す（403 ではない）。
- 同一施設内の連続タスクに確認ダイアログを出さない。
- M-03 の上部から施設名を消さない。
- M-11 の施設別内訳に他人のデータを混ぜない。
- dailyRoute 未登録でも動作すること。移動ブロックを必須にしない。

## テスト必須
- 1 施設 / 2 施設 / 4 施設の 3 パターン
- dailyRoute あり / なし
- 機内モードで複数施設のタスクを完了 → 復帰後の送信
- 担当外施設の taskId での start（404 になること）
- 施設変更時の確認ダイアログが 1 回だけ出ること
```

---

## 23. 改訂履歴（追記）

| バージョン | 日付 | 変更内容 |
|---|---|---|
| v1.0 | 2026-08-10 | 初版確定 |
| v1.1 | 2026-08-10 | §19 複数施設を担当する清掃員への対応を新設。`dailyRoute` テーブルと `my-day` API を追加。タスク P1-21 〜 P1-23 を追加 |



# ProofKeeping — Phase 1

## 前提
- 仕様の唯一の正は docs/PK-SPEC-P1.md（v1.0）。
- Phase 0 が完了していること。未完了なら着手しない。
- P2 以降の機能（検査画面・観察記録・照合・PDF）を先取りしない。

## 実装順序（この順番を守る）
1. §2 データモデル + migration
2. §3 タスク自動生成バッチ
3. §5 ステータス遷移 API
4. §6 チェックリスト
5. §9 モバイル画面（M-01, M-02, M-03, M-04）
6. §7 写真アップロード
7. §8 オフラインキュー
8. §10 PC 管理画面（W-05 → W-04 → W-03）
9. §11 客室ステータス同期
10. §12 多言語（en）

## 絶対ルール（P0 から継続）
- prisma.* の直接呼び出し禁止。withTenant() を使う。
- クライアント由来の organizationId / propertyId を信用しない。
- UI 文字列は i18n キー経由。JSX に日本語を直書きしない。
- 権限判定はサーバー側 assertPermission()。
- 破壊的操作には recordAudit()。
- 宿泊者の氏名・連絡先・パスポート情報のカラムを作らない。

## P1 固有の禁止事項
- getUserMedia() でカメラを実装しない。input[capture] を使う。
- Background Sync API に依存しない。自前キューを使う。
- 写真の EXIF GPS を保存しない。クライアントとサーバーの両方で除去する。
- M-11 に他人との比較・ランキングを表示しない。
- チェックリストに「すべてチェック」ボタンを置かない。
- 経過時間の超過表示に赤を使わない。

## テスト必須項目
- タスク生成の冪等性（3 回連続実行）
- 中断を挟んだ actualMinutes の計算
- complete の必須チェック検証
- 写真の clientId による冪等性
- オフラインキューの直列送信と再送
- テナント越境（タスク・写真・shortId）
