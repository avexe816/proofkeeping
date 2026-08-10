# ProofKeeping 製品仕様書
## PK-SPEC-P6 — Phase 6「外部連携と拡張」 v1.0

> 文書ID: `PK-SPEC-P6`
> バージョン: **v1.0**
> 対象期間: M10–M11
> タスク数: 15

---

ProofKeeping 製品仕様書
PK-SPEC-P6 — Phase 6「外部連携と拡張」 v1.0
文書ID: PK-SPEC-P6
バージョン: v1.0
発行日: 2026-08-10
対象期間: M10–M11（8週間）
前提: PK-SPEC-P0 v1.1 〜 P5 v1.0

0. 本フェーズの目的
0.1 一行目標
手動 CSV 取込を自動連携に置き換え、稼働照合の 3 系統目（物理信号）を実データで稼働させる。

P4 まではデータ入力が人手に依存していた。P6 でそれを外し、ProofKeeping を「毎朝勝手に結果が出ている」システムにする。

0.2 出荷判定
PMS 1 社と実接続し、稼働記録が毎日自動取込される。

スマートロック 1 機種と実接続し、R002 / R013 が実データで動く。

連携失敗時に管理画面で検知でき、手動 CSV へフォールバックできる。

公開 API のドキュメントが整備され、顧客が自力で接続できる。

通知が業務フローの必須要素になっていない。

1. 設計原則
1.1 アダプタ層で吸収する
エンジンとアプリケーションは連携先を一切知らない。

text
外部システム
    ↓（各社固有の形式）
Adapter（連携先ごとに 1 つ）
    ↓（正規化された共通型）
OccupancySnapshot / PhysicalSignal
    ↓
Engine
MUST: 連携先固有の分岐をアダプタ層の外に書かない。if (vendor === "xxx") がアダプタ以外に出現したら設計ミス。

1.2 連携は落ちる前提で作る
外部 API は必ず落ちる。落ちたときに ProofKeeping 全体が止まってはならない。

MUST:

連携失敗はエラーではなく「その日の稼働記録が未取得」という状態として扱う。

照合バッチは A 系統が欠けても B 系統だけで完走する。

手動 CSV 取込を常に有効なままにしておく。連携があっても無効化しない。

1.3 通知は補助機能
iOS の Web Push はホーム画面に追加された PWA でのみ動作し、Safari のタブでは受信できない。ユーザーが手動で追加する必要があり、自動的なインストールプロンプトは出せない。

MUST: 通知が届かなくても全業務が成立する設計を維持する。P1 で定めた「画面を開けば分かる」原則を崩さない。

2. データモデル
2.1 連携設定
ts
export const integration = sqliteTable("integration", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  propertyId: text("property_id"),        // null = 組織全体
  kind: text("kind").notNull(),
  // PMS | SMART_LOCK | SELF_CHECKIN | ACCOUNTING | MESSAGING
  vendorCode: text("vendor_code").notNull(),
  displayName: text("display_name").notNull(),

  status: text("status").notNull().default("INACTIVE"),
  // INACTIVE | CONNECTING | ACTIVE | ERROR | SUSPENDED

  config: text("config", { mode: "json" }).notNull().default({}),
  credentialRef: text("credential_ref"),  // KV のキー。値は暗号化して保管

  syncMode: text("sync_mode").notNull().default("PULL"),  // PULL | PUSH | BOTH
  syncCron: text("sync_cron"),            // PULL の場合
  webhookSecret: text("webhook_secret"),  // PUSH の場合

  lastSyncAt: integer("last_sync_at", { mode: "timestamp" }),
  lastSuccessAt: integer("last_success_at", { mode: "timestamp" }),
  lastErrorAt: integer("last_error_at", { mode: "timestamp" }),
  lastErrorMessage: text("last_error_message"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),

  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  uq: uniqueIndex("uq_integration").on(t.organizationId, t.propertyId, t.kind, t.vendorCode),
}));
MUST: API キー・パスワードを config に平文で保存しない。Workers KV に暗号化して保管し、credentialRef でのみ参照する。

2.2 同期ログ
ts
export const syncLog = sqliteTable("sync_log", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  integrationId: text("integration_id").notNull(),
  direction: text("direction").notNull(),   // INBOUND | OUTBOUND
  trigger: text("trigger").notNull(),       // CRON | WEBHOOK | MANUAL | RETRY
  targetDate: text("target_date"),

  status: text("status").notNull(),         // SUCCESS | PARTIAL | FAILED
  recordsReceived: integer("records_received").notNull().default(0),
  recordsApplied: integer("records_applied").notNull().default(0),
  recordsSkipped: integer("records_skipped").notNull().default(0),
  recordsFailed: integer("records_failed").notNull().default(0),

  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  rawSample: text("raw_sample", { mode: "json" }),  // 先頭 3 件のみ。デバッグ用

  startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
  durationMs: integer("duration_ms"),
}, (t) => ({
  idx: index("idx_sync").on(t.integrationId, t.startedAt),
}));
MUST: rawSample に宿泊者の氏名・連絡先が含まれる可能性がある場合、マスキングしてから保存する。保持期間は 7 日。

2.3 マッピング
外部システムの客室番号と ProofKeeping の客室を対応付ける。

ts
export const externalMapping = sqliteTable("external_mapping", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  integrationId: text("integration_id").notNull(),
  entityType: text("entity_type").notNull(),   // ROOM | ROOM_TYPE | PROPERTY
  internalId: text("internal_id").notNull(),
  externalId: text("external_id").notNull(),
  externalLabel: text("external_label"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  uqInt: uniqueIndex("uq_map_int").on(t.integrationId, t.entityType, t.internalId),
  uqExt: uniqueIndex("uq_map_ext").on(t.integrationId, t.entityType, t.externalId),
}));
MUST: マッピング未設定の外部 ID を受信した場合、エラーにせず recordsSkipped としてカウントし、管理画面に「未マッピングの客室 N 件」として提示する。

2.4 通知購読
ts
export const pushSubscription = sqliteTable("push_subscription", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  membershipId: text("membership_id").notNull(),
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  isStandalone: integer("is_standalone", { mode: "boolean" }).notNull().default(false),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  failureCount: integer("failure_count").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  uq: uniqueIndex("uq_push").on(t.membershipId, t.endpoint),
}));
2.5 通知設定
ts
export const notificationPreference = sqliteTable("notification_preference", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  membershipId: text("membership_id").notNull(),
  eventCode: text("event_code").notNull(),
  channels: text("channels", { mode: "json" }).$type<string[]>().notNull().default([]),
  // ["IN_APP","PUSH","EMAIL","LINE"]
  quietHoursFrom: text("quiet_hours_from"),   // "22:00"
  quietHoursTo: text("quiet_hours_to"),       // "07:00"
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  uq: uniqueIndex("uq_notif_pref").on(t.membershipId, t.eventCode),
}));
3. PMS 連携
3.1 共通インターフェース
ts
// packages/integrations/core/types.ts

export interface OccupancyAdapter {
  readonly vendorCode: string;
  readonly capabilities: {
    pull: boolean;
    push: boolean;
    historicalDays: number;
    providesGuestCount: boolean;
    providesCheckInTime: boolean;
    providesStayover: boolean;
  };

  testConnection(config: AdapterConfig): Promise<TestResult>;
  listRooms(config: AdapterConfig): Promise<ExternalRoom[]>;
  fetchOccupancy(
    config: AdapterConfig,
    params: { businessDate: string }
  ): Promise<NormalizedOccupancy[]>;
  parseWebhook?(body: unknown, headers: Headers): Promise<NormalizedOccupancy[]>;
}

export type NormalizedOccupancy = {
  externalRoomId: string;
  businessDate: string;
  isOccupied: boolean;
  guestCount: number;
  adultCount?: number;
  childCount?: number;
  reservationRef?: string;
  channelCode?: string;
  checkInAt?: string;
  checkOutAt?: string;
  isStayover?: boolean;
  nightIndex?: number;
  nightsTotal?: number;
  isHouseUse?: boolean;
  isComplimentary?: boolean;
  raw: unknown;
};
3.2 実装するアダプタ
優先	vendorCode	方式	備考
P0	csv-generic	手動	P4 で実装済。常に有効
P0	api-generic	PUSH	顧客が自前で POST する汎用口
P1	実接続 1 社	PULL または PUSH	導入顧客の利用 PMS に合わせて決定
P2	追加 1 社	—	需要次第
MUST: 最初の 1 社は「実際に導入する顧客が使っている PMS」を選ぶ。想定で作らない。

3.3 取込処理
text
1. Integration を取得し、status = ACTIVE を確認
2. 認証情報を KV から復号
3. adapter.fetchOccupancy({ businessDate })
4. externalMapping で外部客室ID → 内部roomId へ変換
5. 未マッピングは skip としてカウント
6. OccupancySnapshot へ UPSERT（source = PMS_API）
7. SyncLog を記録
8. 失敗時は consecutiveFailures をインクリメント
3.4 リトライとサーキットブレーカー
text
失敗時のリトライ: 5分後、15分後、60分後（最大 3 回）
consecutiveFailures >= 5 → status = ERROR、自動同期を停止
                        → 管理画面に警告、メール通知
手動で再接続テストに成功したら status = ACTIVE に戻る
MUST: ERROR 状態でも照合バッチは実行する。A 系統なしのモードで動作する。

3.5 タイムラグの扱い
PMS の記録が確定するまで時間がかかる場合がある。

text
既定: 業務日の翌日 01:00 に取込
オプション: 翌日 01:00 と 09:00 の 2 回取込（再取込は上書き）
MUST: 再取込で値が変わった場合、差分を AuditLog に記録し、既に生成済みの Finding があれば R014（稼働記録の事後変更）の対象とする。

4. スマートロック連携
4.1 共通インターフェース
ts
export interface SignalAdapter {
  readonly vendorCode: string;
  readonly signalTypes: SignalType[];

  testConnection(config: AdapterConfig): Promise<TestResult>;
  listDevices(config: AdapterConfig): Promise<ExternalDevice[]>;
  fetchEvents?(
    config: AdapterConfig,
    params: { from: string; to: string }
  ): Promise<NormalizedSignal[]>;
  parseWebhook?(body: unknown, headers: Headers): Promise<NormalizedSignal[]>;
  verifySignature?(body: string, headers: Headers, secret: string): boolean;
}

export type NormalizedSignal = {
  externalDeviceId: string;
  signalType: SignalType;
  occurredAt: string;         // ISO 8601
  actorType?: "GUEST_KEY" | "STAFF_KEY" | "MASTER_KEY" | "MOBILE_KEY" | "UNKNOWN";
  actorRef?: string;
  raw: unknown;
};
4.2 汎用 Webhook 受信口
特定機種に依存しない受信口を用意し、顧客が自前で変換して送れるようにする。

text
POST /api/v1/integrations/webhook/:integrationId

Headers:
  X-PK-Signature: sha256=...    HMAC-SHA256（webhookSecret で検証）
  X-PK-Timestamp: 1757462400

Body:
{
  "events": [
    {
      "deviceId": "LOCK-302",
      "type": "DOOR_UNLOCK",
      "occurredAt": "2026-09-09T22:14:33+09:00",
      "actorType": "GUEST_KEY",
      "actorRef": "card-8891"
    }
  ]
}
MUST:

署名検証を必須にする。検証失敗は 401。

タイムスタンプが 5 分以上ずれていたら拒否（リプレイ攻撃対策）。

同一イベントの重複受信を (deviceId, type, occurredAt) で排除する。

レスポンスは 200 を即返し、処理は Queue へ。外部システムを待たせない。

4.3 actorType の判定
多くのロックは「誰が開けたか」を返さない。その場合の扱い。

text
actorType が取得できない場合:
  - UNKNOWN として保存する
  - R002 / R013 の confidence を 25 減じる
  - 差異詳細画面に「鍵の種別は取得できていません」と明示する
MUST: 不明な情報を推測で埋めない。「わからない」を「わからない」として記録する。

4.4 スタッフキーの除外
清掃スタッフの入室は正常な業務。除外できるようにする。

text
方法1: actorType = STAFF_KEY / MASTER_KEY を自動除外
方法2: 清掃タスクの start / complete 時刻の前後 10 分以内の解錠を除外
方法3: externalMapping でスタッフカードIDを登録し、照合時に除外
MUST: 方法 2 を既定とする。actorType が取得できない機種でも機能するため。

5. 通知
5.1 イベント一覧
eventCode	内容	既定チャネル	対象ロール
task.rework_assigned	差戻しが割り当てられた	IN_APP	CLEANER
inspection.sla_exceeded	検査待ちが SLA 超過	IN_APP	P_MANAGER
room.urgent	チェックインまで 30 分未満で未清掃	IN_APP, PUSH	P_MANAGER
issue.critical	CRITICAL の不具合が報告された	IN_APP, PUSH, EMAIL	P_MANAGER
finding.high	重要度 HIGH の差異が検出された	EMAIL	OWNER, ORG_ADMIN
integration.error	連携が 5 回連続失敗	EMAIL	ORG_ADMIN
invoice.sent	請求書が送付された	EMAIL	ORG_ADMIN
invoice.overdue	支払期限を超過	EMAIL	ORG_ADMIN
period.review_requested	月次明細の確認依頼	EMAIL	取引先
lostitem.retention_due	忘れ物の保管期限が近い	IN_APP, EMAIL	P_MANAGER
MUST: CLEANER 向けの通知は task.rework_assigned のみ。それ以外を清掃スタッフに送らない。

5.2 Web Push の制約と実装
text
条件:
  - iOS 16.4 以降
  - ホーム画面に追加された PWA であること
  - display: standalone
  - ユーザーが明示的に許可していること

上記を満たさない場合、PUSH チャネルは自動的に IN_APP へフォールバックする。
MUST:

購読登録時に isStandalone を判定して記録する。

3 回連続で送信失敗した購読は無効化する。

通知が届かないことを前提に、必ず画面内でも同じ情報を提示する。

5.3 静音時間
text
既定: 22:00 - 07:00 は PUSH / LINE を送らない
例外: issue.critical のみ静音時間を無視する
5.4 LINE 通知
日本の宿泊業では LINE が実質的な業務連絡手段になっていることが多い。

text
方式: LINE 公式アカウント（Messaging API）
対象: P_MANAGER 以上の管理者のみ
内容: 件名と 1 行要約＋ProofKeeping へのリンク
MUST: LINE に個人情報・詳細な差異内容を含めない。「確認が必要な項目があります」＋リンクのみ。

6. 公開 API
6.1 認証
text
Authorization: Bearer pk_live_xxxxxxxxxxxx
ts
export const apiKey = sqliteTable("api_key", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  keyPrefix: text("key_prefix").notNull(),   // pk_live_abcd（表示用）
  keyHash: text("key_hash").notNull(),       // 全体の SHA-256
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
  propertyIds: text("property_ids", { mode: "json" }).$type<string[] | null>(),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
  createdById: text("created_by_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
MUST: キーは作成時に 1 回だけ全体を表示する。以後はハッシュのみ保持し、再表示しない。

6.2 スコープ
text
occupancy:write     稼働記録の投入
signals:write       物理信号の投入
tasks:read          清掃タスクの参照
findings:read       差異レポートの参照
reports:read        レポートの参照
invoices:read       請求書の参照
webhooks:manage     Webhook 設定の管理
6.3 公開エンドポイント
text
POST   /api/v1/public/occupancy/snapshots
POST   /api/v1/public/signals
GET    /api/v1/public/tasks
GET    /api/v1/public/rooms
GET    /api/v1/public/findings
GET    /api/v1/public/reports/daily
GET    /api/v1/public/invoices
6.4 送信 Webhook
ProofKeeping から外部へイベントを通知する。

ts
export const outboundWebhook = sqliteTable("outbound_webhook", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  events: text("events", { mode: "json" }).$type<string[]>().notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  failureCount: integer("failure_count").notNull().default(0),
  lastDeliveryAt: integer("last_delivery_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
配信イベント:

text
room.status_changed
task.completed
inspection.failed
issue.created
finding.created
invoice.issued
MUST: 配信は最大 5 回リトライ（1分, 5分, 30分, 2時間, 6時間）。5 回失敗で無効化し、管理者に通知する。

6.5 レート制限
対象	制限
公開 API 全般	600 req / 分 / キー
occupancy/snapshots	60 req / 分 / キー
signals	300 req / 分 / キー
Webhook 受信	1200 req / 分 / integration
7. 管理画面
7.1 W-13 連携設定
text
外部連携

━━━ 稼働記録 ━━━━━━━━━━━━━━━━━━━━━━━

CSV 取込                              常時有効
  最終取込 2026/09/10 08:14（手動）

○○PMS                                  接続中
  最終同期 2026/09/10 01:02  成功
  対象施設 ホテル東京、イン大阪
  未マッピング客室 0件
                      [ 設定 ] [ 今すぐ同期 ]

━━━ 物理信号 ━━━━━━━━━━━━━━━━━━━━━━

汎用 Webhook                            接続中
  最終受信 2026/09/10 08:22
  本日の受信 1,284件
  未マッピングデバイス 2件  ← 要対応
                      [ 設定 ] [ 受信ログ ]

━━━ 通知 ━━━━━━━━━━━━━━━━━━━━━━━━

LINE 公式アカウント                      未接続
                                  [ 接続する ]
7.2 W-23 マッピング設定
text
○○PMS  客室マッピング

自動マッピング: 部屋番号が一致するものを自動対応  [ 実行 ]

ProofKeeping        外部システム         状態
302  ツイン    ←→  302                  ○
303  シングル  ←→  303                  ○
305  ダブル    ←→  0305                 ○（手動設定）
—                  9001                 ✕ 未マッピング
601  ツイン    ←→  —                    ✕ 未マッピング
7.3 W-24 同期ログ
text
同期ログ  ○○PMS

日時              種別    対象日      結果    受信/適用/скип/失敗
09/10 01:02      定期    09/09      成功     120 / 120 / 0 / 0
09/09 01:01      定期    09/08      部分     120 / 118 / 2 / 0
09/08 01:03      定期    09/07      失敗       0 /   0 / 0 / 0
                                    タイムアウト（30秒）
8. 受け入れ基準
8.1 PMS 連携
実 PMS 1 社と接続し、毎日自動取込される

未マッピング客室がスキップとしてカウントされる

5 回連続失敗で ERROR になり、通知される

ERROR 状態でも照合バッチが完走する

手動 CSV 取込が常に使える

再取込で値が変わったら AuditLog に記録される

8.2 スマートロック
Webhook の署名検証が機能する

5 分以上古いタイムスタンプを拒否する

重複イベントが排除される

200 を即返し、処理が非同期になっている

清掃タスクの前後 10 分の解錠が除外される

actorType 不明時に confidence が下がる

R002 / R013 が実データで動作する

8.3 通知
Push 未許可でも全業務が成立する

iOS でホーム画面未追加の場合に IN_APP へフォールバックする

3 回失敗した購読が無効化される

静音時間が機能する（critical を除く）

CLEANER に rework 以外の通知が届かない

LINE に詳細内容が含まれない

8.4 公開 API
API キーが作成時のみ全体表示される

スコープ外のエンドポイントで 403 になる

propertyIds 制限が機能する

レート制限が機能する

送信 Webhook が 5 回リトライして無効化される

API ドキュメントが公開されている

8.5 セキュリティ
認証情報が KV に暗号化保存され、DB に平文がない

rawSample に個人情報が含まれない

他組織の integrationId で Webhook を投げると 404

アダプタ固有の分岐が packages/integrations 外にない

9. リスクと対策
リスク	影響	対策
PMS 側が API を提供していない	連携不可	CSV 取込を常に維持。汎用 PUSH 口を用意
連携が止まって気づかない	照合の空白	5 回失敗で通知。画面に最終同期時刻を常時表示
客室番号の表記ゆれ	マッピング失敗	自動マッピング＋手動修正 UI。未マッピングを可視化
ロックが actorType を返さない	R002 の精度低下	清掃時刻による除外を既定に。confidence を下げる
Push が届かず業務が滞る	現場混乱	通知を必須要素にしない。画面内表示を維持
API キー漏洩	情報流出	スコープ制限、施設制限、有効期限、失効機能
Webhook のリプレイ攻撃	偽データ混入	署名検証＋タイムスタンプ検証＋重複排除
10. 改訂履歴
バージョン	日付	変更内容
v1.0	2026-08-10	初版確定
11. 未決事項
最初に実接続する PMS を確定する。導入顧客の利用状況を調査してから決める。

スマートロックの対象機種。顧客の導入予定機器に依存。

会計ソフト連携（freee / MF）を P6 に含めるか、P7 以降か。

送信 Webhook の需要があるか。顧客が本当に使うかを確認してから作る案もある。

LINE 連携を LINE 公式アカウントで行うか、LINE WORKS を対象にするか。

12. Claude Code 作業指示
text
# ProofKeeping — Phase 6

## 前提
- 仕様の唯一の正は docs/PK-SPEC-P6.md（v1.0）。
- P4 の照合エンジンが安定稼働していること。
- 実接続する PMS・ロック機種が確定していること。未確定なら汎用口のみ作る。

## 実装順序
1. §2 DB migration
2. §3.1 アダプタ共通インターフェース
3. §4.2 汎用 Webhook 受信口（署名検証・重複排除）
4. §2.3 マッピングと W-23
5. 実 PMS アダプタ 1 社
6. §3.4 リトライとサーキットブレーカー
7. §4.4 スタッフキー除外と R002 の実データ検証
8. §5 通知（IN_APP → EMAIL → PUSH の順）
9. §6 公開 API と API キー
10. §6.4 送信 Webhook
11. §7 管理画面

## P6 固有の絶対ルール
- 連携先固有の分岐を packages/integrations の外に書かない。
- 認証情報を DB に平文保存しない。KV に暗号化して保管する。
- 連携失敗でシステム全体を止めない。A 系統なしで照合を完走させる。
- 手動 CSV 取込を無効化しない。常にフォールバックを残す。
- 通知を業務フローの必須要素にしない。
- CLEANER に rework 以外の通知を送らない。
- LINE に個人情報・差異の詳細を含めない。
- Webhook は署名とタイムスタンプを必ず検証する。
- 不明な情報を推測で埋めない。UNKNOWN のまま保存する。
- API キーを再表示できる実装にしない。

## テスト必須
- Webhook の署名検証（正・誤・期限切れ）
- 重複イベントの排除
- 5 回失敗でのサーキットブレーカー
- ERROR 状態での照合バッチ完走
- スコープ外アクセスの 403
- 他組織の integrationId での 404
- Push 未許可時の IN_APP フォールバック