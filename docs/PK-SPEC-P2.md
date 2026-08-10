# ProofKeeping 製品仕様書
## PK-SPEC-P2 — Phase 2「検査と証跡」 v1.0

> 文書ID: `PK-SPEC-P2`
> バージョン: **v1.0**
> 対象期間: M4
> タスク数: 17

---

ProofKeeping 製品仕様書
PK-SPEC-P2 — Phase 2「検査と証跡」 v1.0
清掃記録を、稼働の証跡に。

提供元: 株式会社ステック（stek.ai）
文書ID: PK-SPEC-P2
バージョン: v1.0
発行日: 2026-08-10
対象期間: M4（4週間）
前提文書: PK-SPEC-P0 v1.0 / PK-SPEC-P1 v1.0
ステータス: 確定（P1 の現場出荷判定後に着手可）

0. 本フェーズの目的
0.1 一行目標
清掃完了を「自己申告」ではなく、検査・写真・時刻・差戻し履歴を伴う、後から説明可能な証跡に変える。

P1 は「現場を止めずにタスクを回す」フェーズだった。P2 では、その記録に次の問いへ答えられる品質を持たせる。

誰が清掃したか。

いつ開始し、いつ完了したか。

誰が、何を確認したか。

不備があった場合、何が理由で、誰に差し戻されたか。

再清掃後に改善されたか。

写真が後から差し替えられていないか。

その日の清掃実績として施設と清掃会社の双方が確認できるか。

0.2 Phase 2 の出荷判定
以下をすべて満たした場合にのみ P3 へ進む。

検査対象タスクの 100% に検査担当者、検査時刻、判定、項目別結果が残る。

差戻しから再清掃、再検査までの履歴を 1 画面で追跡できる。

発行済み日報 PDF の内容と生成元データをハッシュで照合できる。

忘れ物・設備不具合を写真付きで報告し、担当者へ引き渡せる。

stek 自社受託施設で 2 週間、口頭・LINE・紙による検査指示を使わずに運用できる。

0.3 In Scope
#	機能	対応章
1	正式な検査フロー	§2–§5
2	項目別合否・差戻し・再清掃	§4–§5
3	証跡スナップショットと改ざん検知	§6
4	忘れ物管理	§7
5	設備不具合・修繕依頼	§8
6	日次実績・日報 PDF	§9
7	作業時間・再清掃率・検査合格率	§10
8	モバイル検査画面	§11
9	PC 証跡・日報・報告管理画面	§12
10	P1 暫定機能の廃止・移行	§13
0.4 Out of Scope
入室時の客室使用状況、タオル・リネン枚数（P3）

PMS 記録との照合・差異検出（P4）

請求書・領収書・清掃単価（P5）

警察への電子届出、配送会社 API、修繕業者発注（将来）

AI 画像判定、顔認識、従業員評価ランキング

1. 設計原則
1.1 検査は清掃者と分離する
原則として清掃担当者本人は自分のタスクを検査できない。

PROPERTY_MANAGER が緊急時に自己検査を許可する場合、理由入力を必須とし、inspection.self_approved を監査ログへ記録する。

自己検査は月次レポートで別集計する。

1.2 差戻しは人ではなく項目に紐づける
禁止する表現:

「清掃が雑」

「担当者が悪い」

「やり直し」だけの自由記述

必須の構造:

text
不合格項目: 浴室 > 鏡
理由コード: WATER_SPOT
指示: 鏡の右下に水滴跡があります
写真: 1枚
再清掃期限: 14:30
1.3 証跡と人事評価を分離する
ProofKeeping の作業時間・合格率・差戻し件数は、清掃品質と業務改善のためのデータである。

MUST:

個人ランキングを作らない。

作業時間だけを基準に「速い／遅い」を表示しない。

自動的な懲戒・査定判定を行わない。

利用目的を「清掃業務の進捗、品質確認、請求根拠、内部統制」としてスタッフに通知する。

1.4 写真は必要最小限
客室写真には宿泊客の私物や個人を識別できる情報が写る可能性がある。従業員・宿泊客の顔写真は個人情報となり得るため、利用目的とアクセス範囲を限定する。[web:204][web:205][web:206]

MUST:

人物が写った写真はアップロード前に警告し、原則撮り直す。

パスポート、氏名、住所、クレジットカード、予約票、PC 画面を撮影しない。

忘れ物写真を除き、宿泊客の私物を意図的に撮影しない。

GPS EXIF を P1 と同様にクライアント・サーバー双方で削除する。

写真 URL は署名付きで 15 分のみ有効。

2. 検査モデル
2.1 施設ごとの検査方式
Property に以下を追加する。

text
enum InspectionMode {
  ALL         // 全室検査
  SAMPLE      // 一部抽出
  NONE        // 検査なし（直接完了）
}

model PropertyInspectionPolicy {
  id                    String         @id @default(cuid())
  organizationId        String
  propertyId            String         @unique
  mode                   InspectionMode @default(ALL)
  sampleRate             Int            @default(100) // 0-100%
  minDailySample         Int            @default(3)
  alwaysInspectCheckin   Boolean        @default(true)
  alwaysInspectRework    Boolean        @default(true)
  selfInspectionAllowed Boolean        @default(false)
  autoAssignInspector    Boolean        @default(true)
  inspectionSlaMinutes   Int            @default(20)
  updatedAt              DateTime       @updatedAt
}
2.2 抽出検査
SAMPLE の場合、以下は必ず検査対象とする。

当日チェックインがある客室。

前回差戻しとなったタスク。

新人スタッフ（運用開始から 30 日未満）が担当したタスク。

設備不具合または忘れ物報告があるタスク。

施設が「重点客室」として指定した客室。

残りから sampleRate に達するまでランダム抽出する。抽出はタスク生成時ではなく、清掃完了時に決定する。

MUST: ランダム抽出はサーバー側で行い、清掃担当者には清掃完了前に対象かどうかを見せない。

2.3 検査省略時
NONE または SAMPLE の非抽出タスクは、清掃完了時に COMPLETED へ移行する。

inspectionSkipped = true と省略理由 POLICY_NONE / NOT_SAMPLED を保存する。

「検査なし」を「検査合格」として集計しない。

3. データモデル
3.1 P1 スキーマの変更
text
model CleaningTask {
  // P1 から継続する既存フィールドは省略

  inspectionRequired Boolean   @default(false)
  inspectionSkipped  Boolean   @default(false)
  inspectionSkipReason InspectionSkipReason?
  inspectorId        String?
  inspectedAt        DateTime?
  inspectionResult   InspectionResult?
  currentInspectionRound Int   @default(0)

  inspections        Inspection[]
  issues             IssueReport[]
  lostItems          LostItem[]
  evidenceSnapshots  EvidenceSnapshot[]
}

enum InspectionSkipReason {
  POLICY_NONE
  NOT_SAMPLED
  EMERGENCY_OVERRIDE
}

enum InspectionResult {
  PASS
  FAIL
}
3.2 Inspection
text
model Inspection {
  id             String   @id @default(cuid())
  organizationId String
  propertyId     String
  taskId         String
  round          Int      // 1, 2, 3...
  inspectorId    String
  result         InspectionResult
  startedAt      DateTime
  completedAt    DateTime
  durationSeconds Int
  selfApproved   Boolean  @default(false)
  overrideReason String?
  generalNote    String?
  clientTs       DateTime?
  createdAt      DateTime @default(now())

  itemResults    InspectionItemResult[]

  @@unique([taskId, round])
  @@index([propertyId, completedAt])
  @@index([inspectorId, completedAt])
}
3.3 InspectionItemResult
text
enum InspectionItemStatus {
  PASS
  FAIL
  NOT_APPLICABLE
}

enum DefectCode {
  DUST
  HAIR
  STAIN
  ODOR
  WATER_SPOT
  MISSING_AMENITY
  LINEN_WRINKLE
  BED_MAKING
  TRASH_REMAINING
  EQUIPMENT_NOT_RESET
  DAMAGE
  OTHER
}

model InspectionItemResult {
  id             String   @id @default(cuid())
  inspectionId   String
  checklistItemId String
  status         InspectionItemStatus
  defectCode     DefectCode?
  note           String?
  reworkRequired Boolean  @default(false)
  reworkDueAt    DateTime?
  createdAt      DateTime @default(now())

  photos         InspectionPhoto[]

  @@unique([inspectionId, checklistItemId])
  @@index([inspectionId, status])
}

model InspectionPhoto {
  id             String   @id @default(cuid())
  itemResultId   String
  storageKey     String
  sha256         String
  width          Int
  height         Int
  fileSize       Int
  capturedAt     DateTime?
  uploadedById   String
  uploadedAt     DateTime @default(now())
  clientId       String   @unique
}
3.4 ReworkCycle
text
enum ReworkStatus {
  OPEN
  IN_PROGRESS
  RESOLVED
  WAIVED
}

model ReworkCycle {
  id             String   @id @default(cuid())
  organizationId String
  propertyId     String
  taskId         String
  inspectionId   String
  round          Int
  assignedToId   String
  status         ReworkStatus @default(OPEN)
  reasonSummary  String
  dueAt          DateTime?
  startedAt      DateTime?
  completedAt    DateTime?
  waivedById     String?
  waivedReason   String?
  createdAt      DateTime @default(now())

  @@unique([taskId, round])
  @@index([assignedToId, status])
}
3.5 忘れ物
text
enum LostItemCategory {
  VALUABLE       // 財布、現金、カード、鍵、スマートフォン等
  ELECTRONICS
  CLOTHING
  BAG
  MEDICINE
  FOOD
  DOCUMENT
  OTHER
}

enum LostItemStatus {
  FOUND
  STORED
  REPORTED_TO_POLICE
  RETURN_PENDING
  RETURNED
  DISPOSED
  TRANSFERRED
}

model LostItem {
  id             String   @id @default(cuid())
  organizationId String
  propertyId     String
  taskId         String?
  roomId         String
  businessDate   DateTime @db.Date
  managementNo   String   @unique
  category       LostItemCategory
  description    String
  foundAt        DateTime
  foundById      String
  foundLocation  String
  status         LostItemStatus @default(FOUND)
  storageLocation String?
  policeReportNo String?
  policeReportedAt DateTime?
  ownerContactedAt DateTime?
  returnedAt     DateTime?
  disposedAt     DateTime?
  disposalReason String?
  retentionDueAt DateTime?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  photos         LostItemPhoto[]
  histories      LostItemHistory[]

  @@index([propertyId, status, foundAt])
  @@index([retentionDueAt, status])
}

model LostItemPhoto {
  id           String   @id @default(cuid())
  lostItemId   String
  storageKey   String
  sha256       String
  uploadedAt   DateTime @default(now())
  uploadedById String
}

model LostItemHistory {
  id           String   @id @default(cuid())
  lostItemId   String
  fromStatus   LostItemStatus?
  toStatus     LostItemStatus
  actorId      String
  note         String?
  occurredAt   DateTime @default(now())

  @@index([lostItemId, occurredAt])
}
3.6 不具合・修繕
text
enum IssueCategory {
  CLEANING
  PLUMBING
  ELECTRICAL
  HVAC
  FURNITURE
  AMENITY
  SAFETY
  OTHER
}

enum IssueSeverity {
  LOW
  MEDIUM
  HIGH
  CRITICAL
}

enum IssueStatus {
  OPEN
  ACKNOWLEDGED
  IN_PROGRESS
  RESOLVED
  CLOSED
  WONT_FIX
}

model IssueReport {
  id             String   @id @default(cuid())
  organizationId String
  propertyId     String
  taskId         String?
  roomId         String
  category       IssueCategory
  severity       IssueSeverity
  title          String
  description    String
  status         IssueStatus @default(OPEN)
  reportedById   String
  assignedToId   String?
  reportedAt     DateTime @default(now())
  acknowledgedAt DateTime?
  resolvedAt     DateTime?
  resolutionNote String?
  roomBlocked    Boolean  @default(false)

  photos         IssuePhoto[]
  histories      IssueHistory[]

  @@index([propertyId, status, severity])
  @@index([roomId, status])
}

model IssuePhoto {
  id           String   @id @default(cuid())
  issueId      String
  storageKey   String
  sha256       String
  uploadedAt   DateTime @default(now())
  uploadedById String
}

model IssueHistory {
  id           String   @id @default(cuid())
  issueId      String
  fromStatus   IssueStatus?
  toStatus     IssueStatus
  actorId      String
  note         String?
  occurredAt   DateTime @default(now())
}
3.7 証跡スナップショット
text
enum EvidenceType {
  CLEANING_COMPLETION
  INSPECTION_PASS
  INSPECTION_FAIL
  REWORK_COMPLETION
  DAILY_REPORT
}

model EvidenceSnapshot {
  id             String   @id @default(cuid())
  organizationId String
  propertyId     String
  taskId         String?
  businessDate   DateTime @db.Date
  evidenceType   EvidenceType
  schemaVersion  String
  payload        Json     // 正規化済み JSON
  payloadSha256  String
  previousHash   String?  // 同一タスク内の前スナップショット
  chainHash      String   // sha256(previousHash + payloadSha256)
  createdAt      DateTime @default(now())
  createdById    String?

  @@index([taskId, createdAt])
  @@index([propertyId, businessDate, evidenceType])
}
MUST: EvidenceSnapshot は INSERT のみ。UPDATE / DELETE API を作らない。DB 権限でもアプリユーザーの UPDATE / DELETE を禁止する。

4. 検査フロー
4.1 状態遷移
P1 の暫定一括承認を廃止し、以下へ切り替える。

text
IN_PROGRESS
   │ cleaner.complete
   v
AWAITING_INSPECTION
   │
   ├ inspector.pass ──────────────> COMPLETED
   │                                room = READY
   │
   └ inspector.fail ──> REWORK
                         │ cleaner.rework_start
                         v
                    IN_PROGRESS
                         │ cleaner.complete
                         v
                    AWAITING_INSPECTION
                         │ round + 1
                         └ pass / fail ...
4.2 検査開始
検査担当者が AWAITING_INSPECTION のタスクを開き「検査を開始」を押す。

Inspection.round = task.currentInspectionRound + 1

startedAt = server time

他の検査者による同時開始を排他制御する。

既に別の検査者が開始している場合は INSPECTION_ALREADY_STARTED を返す。

4.3 検査項目
検査項目は、清掃実施時に使った TaskChecklistResult のスナップショットを基に生成する。

各項目で選択可能:

合格

不合格

対象外

不合格の場合は以下が必須:

defectCode

コメント 1～200 文字

写真 1 枚以上

再清掃の要否

MUST: 1 項目でも FAIL があれば検査全体は FAIL。検査者が全体だけ PASS に上書きできない。

4.4 検査合格
検査合格時に 1 トランザクションで実行する。

Inspection.result = PASS

CleaningTask.status = COMPLETED

CleaningTask.inspectionResult = PASS

Room.housekeepingStatus = READY

INSPECTION_PASS の EvidenceSnapshot を生成

task.inspection.pass を AuditLog に記録

4.5 検査不合格
Inspection.result = FAIL

CleaningTask.status = REWORK

CleaningTask.reworkCount += 1

ReworkCycle を生成

Room.housekeepingStatus = DIRTY

INSPECTION_FAIL の EvidenceSnapshot を生成

担当清掃者の M-02 上部へ差戻しタスクを優先表示

4.6 再清掃
清掃者は差戻し項目だけを表示できる。

元のチェックリスト結果は変更しない。

再清掃で行った操作、写真、時刻は ReworkCycle と次回検査へ紐づける。

再清掃完了後は再度 AWAITING_INSPECTION。

4.7 Waive（免除）
設備故障等で清掃者が改善できない項目は PROPERTY_MANAGER 以上が免除できる。

理由必須。

関連する IssueReport 必須。

ReworkCycle.status = WAIVED。

免除後に客室を READY にするか BLOCKED にするか選択させる。

rework.waived を監査ログへ記録。

5. 検査担当者の割当
5.1 自動割当
autoAssignInspector = true の場合:

同一施設へ割当済みの INSPECTOR と PROPERTY_MANAGER を取得。

当日の未完了検査件数が少ない順に並べる。

自分が清掃担当者であるタスクを除外。

ラウンドロビンで割り当てる。

5.2 SLA
inspectionSlaMinutes を超えて未着手の場合:

W-03 客室ボードをオレンジ表示。

M-08 検査待ち一覧の上部へ移動。

P2 ではプッシュ通知しない。画面内通知のみ。

5.3 緊急優先度
当日チェックイン予定時刻まで 30 分未満のタスクは 緊急 として最上位表示する。

text
緊急度 = checkInAt - 現在時刻
P1 の DailyRoomPlan にチェックイン時刻がない場合、施設既定の Property.checkInTime を使う。

6. 証跡と改ざん検知
6.1 証跡の考え方
ProofKeeping は外部の法的タイムスタンプを P2 では導入しない。ただし、後からデータが書き換えられたかを検出できるよう、イベントごとの正規化 JSON と SHA-256 ハッシュを保存する。

6.2 正規化 payload
キーを辞書順に並べ、日時を ISO 8601 UTC、数値を整数へ統一した JSON を作る。

json
{
  "businessDate": "2026-09-10",
  "cleanerId": "mem_xxx",
  "completedAt": "2026-09-10T04:25:31.000Z",
  "photos": [
    { "id": "ph_1", "sha256": "..." }
  ],
  "roomId": "room_302",
  "taskId": "task_xxx",
  "taskType": "CHECKOUT",
  "timeLogs": [ ... ],
  "templateVersion": 2
}
ts
payloadSha256 = sha256(canonicalJson(payload));
chainHash = sha256((previousHash ?? "GENESIS") + payloadSha256);
6.3 写真ハッシュ
アップロード完了時にサーバー側でバイナリの SHA-256 を計算。

DB の sha256 と R2 object metadata の双方へ保存。

証跡閲覧時に任意で再計算できる「整合性を確認」操作を提供。

不一致時は画面へ赤い警告を表示し、Sentry と監査ログへ記録する。

6.4 証跡の訂正
証跡自体は編集しない。誤入力訂正は新しいスナップショットを追加する。

text
元: CLEANING_COMPLETION #1
訂正イベント: correction.create
新: CLEANING_COMPLETION #2（correctsSnapshotId = #1）
P2 では EvidenceSnapshot に以下を追加する。

text
correctsSnapshotId String?
correctionReason   String?
訂正できるのは ORG_ADMIN のみ。理由必須。元スナップショットは残す。

6.5 証跡バンドル
1 タスクの証跡を ZIP でエクスポートできる。

text
PK-20260910-HTLA-302.zip
├─ manifest.json
├─ cleaning-completion.json
├─ inspection-round-1.json
├─ rework-round-1.json（存在する場合）
├─ inspection-round-2.json（存在する場合）
├─ photos/
│  ├─ cleaning-001.jpg
│  └─ inspection-001.jpg
└─ verify.txt（各ファイルの SHA-256 一覧）
MUST: ZIP 生成も evidence.export として監査ログへ記録する。

7. 忘れ物管理
7.1 運用フロー
text
発見
 → その場で写真・カテゴリ・場所を登録
 → 管理番号を自動採番
 → 指定保管場所へ移動
 → 施設責任者が「保管済」に更新
 → 必要に応じて警察届出
 → 返却 / 移管 / 廃棄
宿泊施設の拾得物は遺失物法に基づく運用が必要であり、警察へ届けた物品の保管期間は原則 3 か月。施設占有者には拾得物を受け取ってから 1 週間以内の届出が求められるとされる。[web:207][web:208][web:210][web:214]

ProofKeeping は法的判断を自動化せず、期限管理と記録を支援する。

7.2 管理番号
text
LNF-{施設コード}-{YYYYMMDD}-{4桁連番}
例: LNF-HTLA-20260910-0003
7.3 カテゴリ別の既定処理
カテゴリ	既定の保持期限	警告
貴重品	7 日以内に警察届出を促す	発見直後から赤
電子機器・書類・薬	7 日以内に責任者判断	オレンジ
衣類・バッグ・その他	施設設定（既定 90 日）	期限 7 日前
食品	施設設定（既定 当日）	即時
MUST: 「自動廃棄」はしない。期限が来ても責任者の明示操作が必要。

7.4 権限
CLEANER: 登録と自分が登録した内容の閲覧。保管場所や返却先は閲覧不可。

INSPECTOR: 施設内の一覧閲覧、保管済への更新。

PROPERTY_MANAGER 以上: 全操作。

宿泊者の氏名・住所・電話番号は ProofKeeping に保存しない。連絡は PMS 側で行い、ProofKeeping には ownerContactedAt のみ記録する。

7.5 写真
忘れ物全体が分かる写真 1 枚を必須。

クレジットカード番号、身分証番号、住所等が写る場合はマスキングしてから登録する。

現金の場合、金額は description へ自由記述せず、責任者に直接引き渡し、カテゴリを VALUABLE とする。

8. 設備不具合・修繕依頼
8.1 報告
清掃中または検査中に不具合を発見した場合、3 タップ以内で報告できる。

必須:

カテゴリ

重要度

タイトル（定型候補あり）

写真 1 枚以上（安全上撮影困難な場合を除く）

8.2 重要度
重要度	定義	客室への影響
LOW	見た目・軽微な劣化	販売可
MEDIUM	設備の一部が使えない	責任者判断
HIGH	主要設備が使えない	原則 BLOCKED
CRITICAL	漏水・漏電・火災・負傷リスク	即時 OUT_OF_ORDER
MUST: CRITICAL 登録時は確認画面を出し、確定後に Room.saleStatus = OUT_OF_ORDER、housekeepingStatus = BLOCKED へ自動変更する。

8.3 解決
RESOLVED へ変更する際は解決内容と写真を任意登録。

客室を AVAILABLE / READY に戻すのは PROPERTY_MANAGER 以上のみ。

不具合を閉じても客室状態は自動復旧しない。明示操作が必要。

9. 日次実績と日報 PDF
9.1 日報の目的
清掃会社が「何室を、誰が、いつ完了したか」を施設へ提出する。

ホテルが清掃実績と検査結果を確認する。

P5 の請求明細の元データになる。

9.2 日報内容
text
ProofKeeping 清掃実績日報
施設: サンプルホテル東京
業務日: 2026年9月10日
生成日時: 2026年9月11日 05:10 JST
文書番号: RPT-2026-0042

サマリー
  対象タスク       52件
  完了             50件
  未完了            2件
  検査対象         50件
  初回合格         44件
  差戻し            6件
  再清掃後合格      6件
  自己検査          0件

明細
  部屋 / 種別 / 担当 / 開始 / 完了 / 実作業分 / 検査者 / 結果 / 再清掃

未完了・入室不可
  部屋 / 理由 / 現在状態 / 対応者

不具合・忘れ物
  管理番号 / 部屋 / 種類 / 状態

文書ハッシュ
  SHA-256: xxxxx
9.3 生成タイミング
毎日、施設の businessDayCutoff の 10 分後に自動生成。

PROPERTY_MANAGER 以上が手動再生成可能。

再生成は同じ文書番号を上書きしない。revision = 2 として新しい PDF を生成し、旧版を保持する。

9.4 DailyReport
text
model DailyReport {
  id             String   @id @default(cuid())
  organizationId String
  propertyId     String
  businessDate   DateTime @db.Date
  documentNo     String
  revision       Int      @default(1)
  storageKey     String
  payloadSha256  String
  pdfSha256      String
  totalTasks     Int
  completedTasks Int
  failedFirstInspection Int
  openIssues     Int
  openLostItems  Int
  generatedAt    DateTime @default(now())
  generatedById  String?
  supersedesId   String?

  @@unique([propertyId, businessDate, revision])
  @@index([propertyId, businessDate])
}
9.5 PDF 保存
text
documents/{orgId}/{propertyId}/daily-reports/{YYYY}/{MM}/{documentNo}-r{revision}.pdf
発行済み PDF は削除・上書き不可。

DocumentSequence の REPORT を使用。

PDF の SHA-256 を DB と R2 metadata に保存。

9.6 送付
P2 では1 クリック送付を実装しない（P5）。以下のみ。

PDF ダウンロード。

管理画面での閲覧。

署名付き URL の一時発行。

10. 指標
10.1 施設向け指標
指標	計算
完了率	COMPLETED / 対象タスク
初回検査合格率	round 1 PASS / 検査対象
再清掃率	reworkCount ≥ 1 / 検査対象
平均検査待ち時間	Inspection.startedAt - CleaningTask.completedAt
平均実作業時間	actualMinutes の平均（種別・客室タイプ別）
SLA 超過率	検査待ち > inspectionSlaMinutes / 検査対象
自己検査率	selfApproved / 検査対象
10.2 表示しない指標
個人別順位。

最速・最遅ランキング。

「生産性スコア」のような単一評価。

AI による従業員評価。

10.3 最小母数
個人単位の指標は、対象期間に 20 タスク未満の場合は表示しない。少数データで誤解を招かないため。

11. モバイル画面
11.1 追加画面
ID	パス	画面	主ロール
M-08	/m/inspect	検査待ち一覧	INSPECTOR
M-09	/m/inspect/[taskId]	検査実施	INSPECTOR
M-12	/m/rework/[taskId]	再清掃	CLEANER
M-13	/m/report/new	不具合・忘れ物報告	CLEANER
M-14	/m/lost-found	忘れ物一覧	INSPECTOR以上
M-15	/m/issues	不具合一覧	INSPECTOR以上
11.2 M-08 検査待ち一覧
text
┌──────────────────────────────────────┐
│ 検査待ち                     8件  🔄  │
├──────────────────────────────────────┤
│ 🔴 302  チェックインまで 18分          │
│    清掃: 田中 / 完了 14:02             │
│                         [ 検査する ]   │
├──────────────────────────────────────┤
│ 🟠 305  待ち時間 24分（目安20分）      │
│    清掃: Nguyen / 完了 13:48           │
│                         [ 検査する ]   │
├──────────────────────────────────────┤
│    401  待ち時間 6分                   │
│    清掃: 佐藤 / 完了 14:06             │
│                         [ 検査する ]   │
└──────────────────────────────────────┘
並び順:

チェックインまで 30 分未満。

SLA 超過。

再検査。

完了時刻の古い順。

11.3 M-09 検査実施
text
302号室  検査 Round 1
清掃: 田中 / 14:02完了 / 写真3枚

▼ ベッドまわり
  シーツ・カバー類             [○] [×] [—]
  枕カバー                     [○] [×] [—]
  ベッドメイキング             [○] [×] [—]

▼ 浴室
  鏡                           [○] [×] [—]
    × 選択時:
      理由 [ 水滴跡 ▾ ]
      指示 [右下に水滴跡があります]
      [ 写真を撮る ]
      [✓] 再清掃が必要

[ 検査を完了する ]
MUST:

画面初期値をすべて PASS にしない。未選択から始める。

「全て合格」を置かない。

不合格項目だけを次の再清掃画面に表示する。

11.4 M-12 再清掃
text
302号室  再清掃 1回目
期限 14:30

浴室 > 鏡
  水滴跡
  「右下に水滴跡があります」
  [検査写真]

[ 再清掃を開始 ]

完了後
  [ 写真を撮る ]
  [ 再清掃を完了 ]
11.5 M-13 報告
最初に 2 択を出す。

text
何を報告しますか？

[ 忘れ物 ]       [ 設備・清掃の不具合 ]
入力は 3 タップ以内で写真撮影まで到達できること。

12. PC 管理画面
12.1 追加・変更画面
ID	パス	画面
W-03	/app/p/[id]/board	検査待ち・再清掃を追加
W-06	/app/p/[id]/evidence	証跡一覧
W-07	/app/p/[id]/evidence/[taskId]	タスク証跡詳細
W-08	/app/p/[id]/reports/daily	日報一覧
W-09	/app/p/[id]/lost-found	忘れ物管理
W-10	/app/p/[id]/issues	不具合管理
W-18	/app/settings/inspection	検査ポリシー
12.2 W-07 証跡詳細
表示順:

タスク概要（施設、部屋、業務日、担当者、状態）。

タイムライン。

清掃チェックリストと写真。

検査 Round 1。

差戻し・再清掃。

検査 Round 2 以降。

不具合・忘れ物。

証跡ハッシュと「整合性を確認」。

「証跡を ZIP 出力」。

12.3 タイムライン例
text
13:12  清掃開始        田中
13:35  一時中断        リネン待ち
13:42  清掃再開        田中
14:02  清掃完了        田中
14:08  検査開始        佐藤
14:12  検査不合格      浴室・鏡 / 水滴跡
14:15  再清掃開始      田中
14:19  再清掃完了      田中
14:22  再検査開始      佐藤
14:24  検査合格        客室 READY
13. P1 からの移行
13.1 廃止する暫定機能
P1 の以下を P2 リリース時に削除する。

W-03 の「一括で検査済にする」。

Property.inspectionRequired 単独フラグ。

代わりに PropertyInspectionPolicy.mode を使う。

13.2 データ移行
sql
-- P1 の inspectionRequired を P2 policy へ移行
INSERT INTO "PropertyInspectionPolicy" (...)
SELECT
  gen_random_cuid(),
  "organizationId",
  "id",
  CASE WHEN "inspectionRequired" = true THEN 'ALL' ELSE 'NONE' END,
  CASE WHEN "inspectionRequired" = true THEN 100 ELSE 0 END,
  ...
FROM "Property";
13.3 既存タスク
P2 リリース前に AWAITING_INSPECTION のタスクは施設責任者が処理してから移行する。

残存がある場合は EMERGENCY_OVERRIDE として完了させ、監査ログに記録する。

過去の COMPLETED タスクへ後付けで Inspection を作らない。

14. API
14.1 検査
text
GET    /api/v1/inspections/waiting?propertyId=&businessDate=
POST   /api/v1/tasks/:id/inspection/start
PUT    /api/v1/inspections/:id/items
POST   /api/v1/inspections/:id/photos
POST   /api/v1/inspections/:id/complete
POST   /api/v1/reworks/:id/start
POST   /api/v1/reworks/:id/complete
POST   /api/v1/reworks/:id/waive
全状態変更 API に Idempotency-Key 必須。

14.2 証跡
text
GET    /api/v1/evidence?propertyId=&businessDate=&roomId=
GET    /api/v1/evidence/tasks/:taskId
POST   /api/v1/evidence/:id/verify
POST   /api/v1/evidence/tasks/:taskId/export
POST   /api/v1/evidence/:id/corrections
14.3 忘れ物・不具合
text
POST   /api/v1/lost-items
GET    /api/v1/lost-items
GET    /api/v1/lost-items/:id
PATCH  /api/v1/lost-items/:id/status
POST   /api/v1/lost-items/:id/photos

POST   /api/v1/issues
GET    /api/v1/issues
GET    /api/v1/issues/:id
PATCH  /api/v1/issues/:id/status
POST   /api/v1/issues/:id/photos
POST   /api/v1/issues/:id/resolve
14.4 日報
text
GET    /api/v1/reports/daily?propertyId=&from=&to=
GET    /api/v1/reports/daily/:id
POST   /api/v1/reports/daily/generate
POST   /api/v1/reports/daily/:id/regenerate
GET    /api/v1/reports/daily/:id/download
15. 非機能要件
項目	要件
検査一覧 API	p95 < 300ms（100件）
検査完了処理	p95 < 800ms（証跡生成含む）
証跡詳細	p95 < 1秒（写真本体除く）
日報 PDF	100室で 30秒以内
ZIP 証跡出力	20写真で 60秒以内、非同期ジョブ
改ざん検証	1タスク 5秒以内
忘れ物保持期限バッチ	毎日 06:00 JST
16. 受け入れ基準
16.1 検査
清掃担当者本人が自分のタスクを検査できない

自己検査の例外は理由と監査ログが必須

1 項目でも FAIL があれば全体を PASS にできない

FAIL 項目に理由・コメント・写真がないと完了できない

差戻し → 再清掃 → 再検査の履歴が欠落なく残る

検査合格前に客室が READY にならない

SAMPLE の抽出対象が清掃完了前にスタッフへ見えない

16.2 証跡
清掃完了、検査 PASS / FAIL、再清掃ごとにスナップショットが生成される

同じ入力から同じ SHA-256 が生成される

写真をテスト用に差し替えると整合性検証が失敗する

EvidenceSnapshot をアプリ権限で UPDATE / DELETE できない

訂正後も元スナップショットが残る

ZIP 内の verify.txt で全ファイルを検証できる

16.3 忘れ物・不具合
忘れ物に管理番号が重複なく採番される

期限到来でも自動廃棄されない

CLEANER に保管場所・返却情報が見えない

CRITICAL 不具合で客室が OUT_OF_ORDER / BLOCKED になる

不具合解決だけでは客室が自動復旧しない

16.4 日報
日報が日締め 10 分後に自動生成される

PDF の集計値と DB 明細が一致する

再生成で旧版が上書きされない

PDF と payload の SHA-256 が保存される

発行済み日報を削除できない

16.5 現場検証
検査担当 2 名が説明 10 分以内で検査を完了できる

清掃者が差戻し理由を口頭確認せず理解できる

stek 自社施設で 2 週間、検査の紙・LINE・口頭指示を使わない

期間中の差戻しの 95% 以上が期限内に再清掃される

システム起因で READY が遅れ、チェックインに影響した件数が 0

16.6 セキュリティ
他組織の inspection / evidence / lost-item / issue ID は 403

署名付き写真 URL は 15 分後に失効する

EXIF GPS が保存されていない

ストレージ内の原画像に GPS が残っていない

Evidence ZIP の出力が監査ログへ残る

17. 実装順序（4週間）
Week 1 — 検査コア
DB migration

検査ポリシー

検査開始・項目入力・PASS / FAIL API

M-08 / M-09

P1 暫定一括承認の移行準備

Week 2 — 差戻しと証跡
ReworkCycle

M-12 再清掃

EvidenceSnapshot / canonical JSON / SHA-256

W-07 証跡タイムライン

写真ハッシュ・整合性確認

Week 3 — 忘れ物・不具合
LostItem / IssueReport

M-13 / M-14 / M-15

W-09 / W-10

期限バッチと CRITICAL 客室制御

Week 4 — 日報と現場移行
DailyReport / PDF

W-08

証跡 ZIP

P1 暫定機能の削除

実機・負荷・現場受け入れテスト

18. リスクと対策
リスク	影響	対策
検査がボトルネックになる	READY 遅延	SAMPLE モード、SLA、緊急順表示
検査者が全項目を形式的に PASS	証跡価値低下	全項目未選択開始、「全部合格」禁止、個別時刻保持
差戻しが人間関係を悪化させる	定着失敗	項目・理由コード中心、人への評価表現禁止
写真に個人情報が写る	漏洩	撮影ガイド、アクセス制限、短時間署名 URL、GPS 除去
忘れ物の法的判断を誤る	法務リスク	自動処分しない、期限は警告のみ、施設規程を優先
ハッシュを「法的証明」と誤認	過大説明	「改ざん検知補助」と表記し、法的タイムスタンプと称さない
日報の数値が締め後に変わる	信頼低下	版管理、上書き禁止、訂正理由と旧版保持
19. 改訂履歴
バージョン	日付	変更内容	変更者
v1.0	2026-08-10	初版確定。正式検査、差戻し、証跡ハッシュ、忘れ物、不具合、日報を定義。	PdM
20. 未決事項
SAMPLE 検査の既定率を 30% とするか、初期顧客は全室検査に限定するか。

忘れ物の警察届出を誰の責任範囲とするか。ProofKeeping は期限通知に限定する前提。

証跡 ZIP を顧客へ提供する機能を標準プランに含めるか、Audit モジュールに限定するか。

日報 PDF に清掃スタッフ氏名を出すか、スタッフ番号だけにするか。

清掃会社とホテルの双方が同じ日報を「確認済」にする承認機能を P2 に前倒しするか。現状は P5 の請求照合で実装予定。

不具合の CRITICAL 自動判定をカテゴリで固定するか、報告者の選択に委ねるか。

21. Claude Code 作業指示
text
# ProofKeeping — Phase 2

## 前提
- 仕様の唯一の正は docs/PK-SPEC-P2.md（v1.0）。
- P1 の現場出荷判定を通過していること。
- P3 以降の観察記録・稼働照合・請求書を先取りしない。

## 実装順序
1. §3 の DB migration
2. §2 の検査ポリシーと抽出ロジック
3. §4 検査 API と M-08 / M-09
4. §4.5–§4.7 差戻し・再清掃と M-12
5. §6 EvidenceSnapshot とハッシュ検証
6. §7–§8 忘れ物・不具合
7. §9 日報 PDF
8. §13 P1 暫定機能の移行・削除
9. §16 の全テスト

## P2 固有の絶対ルール
- 清掃者本人の自己検査を既定で禁止する。
- 検査項目を全 PASS で初期化しない。
- 「全て合格」ボタンを作らない。
- FAIL に理由コード・コメント・写真がなければ完了させない。
- EvidenceSnapshot の UPDATE / DELETE API を作らない。
- ハッシュを法的タイムスタンプと表現しない。
- 発行済み日報 PDF を上書き・削除しない。
- 忘れ物を自動廃棄しない。
- CLEANER に忘れ物の保管場所・返却先を見せない。
- 人物、パスポート、クレジットカード等の撮影を促す UI を作らない。
- 個人ランキング・最速ランキングを作らない。

## テスト必須
- 同時検査開始の排他制御
- FAIL 項目から全体 FAIL への集約
- 2 回以上の再清掃ラウンド
- Evidence chainHash の再現性と改ざん検出
- 日報の版管理と旧版保持
- CRITICAL 不具合時の客室ブロック
- 全新規モデルのテナント越境