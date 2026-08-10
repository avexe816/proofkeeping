# ProofKeeping 製品仕様書
## PK-SPEC-P4 — Phase 4「稼働照合エンジン」 v1.0

> 文書ID: `PK-SPEC-P4`
> バージョン: **v1.0**
> 対象期間: M6–M7
> タスク数: 15

---

ProofKeeping 製品仕様書
PK-SPEC-P4 — Phase 4「稼働照合エンジン」 v1.0
文書ID: PK-SPEC-P4
バージョン: v1.0
発行日: 2026-08-10
対象期間: M6–M7（8週間）
前提: PK-SPEC-P0 v1.1 / P1 v1.0 / P2 v1.0 / P3 v1.0

0. 本フェーズの目的
0.1 一行目標
記録上の稼働（PMS）、現場の観察（清掃）、物理的な痕跡（施錠等）の 3 系統を毎日突き合わせ、説明のつかない差異だけを抽出する。

これが ProofKeeping の存在理由であり、他社の清掃管理アプリが構造的に提供できない価値。

0.2 着手の前提条件（MUST）
以下をすべて満たすまで着手しない。

P3 リリースから 4 週間以上経過している

対象施設で観察記録の入力率が 95% 以上

主要な客室タイプ×人数の組み合わせの 80% 以上で isReliable = true

既定値のまま確定した割合が 90% 未満

0.3 出荷判定
実データ 4 週間分で誤検知率 30% 未満。

手動確認との突合で重要度 HIGH の見逃しがゼロ。

同一入力で 2 回実行しても差異が重複生成されない。

稼働記録が未連携の施設でもバッチが完走する。

差異詳細画面に 3 系統の根拠がすべて表示される。

CLEANER ロールが差異画面に一切アクセスできない。

1. 設計原則
1.1 「検知」ではなく「照合」
ProofKeeping は不正を認定しない。記録と事実の差異を提示するだけで、原因の判断は人間が行う。

差異の原因には以下が含まれる。

設備の不具合（センサー誤作動、施錠記録の欠落）

業務手順上の例外（点検、内覧、業者立入）

記録漏れ・入力ミス

システム連携のタイムラグ

そして、意図的な記録の回避

MUST: UI・レポート・API のいずれにおいても、差異を「不正」と断定する表現を使わない。

1.2 3 系統がそろわなくても動く
利用可能な系統	動作
A + B + C	全ルール有効。確信度が最も高い
A + B	物理信号系ルール（R002）をスキップ
B のみ	R006 のみ動作。「記録がない清掃」を検出
A のみ	何も検出しない（現場データがないため）
1.3 確信度を必ず示す
すべての差異に 0〜100 の confidence を付す。単一シグナルの検出を高確信度として扱わない。

1.4 誤検知の学習
「誤検知」として閉じられた差異は、同一条件での再検出時に重要度を下げる。同じ指摘を繰り返して信頼を失うことを防ぐ。

2. データモデル
2.1 OccupancySnapshot
ts
export const occupancySnapshot = sqliteTable("occupancy_snapshot", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  propertyId: text("property_id").notNull(),
  roomId: text("room_id").notNull(),
  businessDate: text("business_date").notNull(),

  source: text("source").notNull(),          // PMS_API | CSV_IMPORT | MANUAL
  isOccupied: integer("is_occupied", { mode: "boolean" }).notNull(),
  guestCount: integer("guest_count").notNull().default(0),
  adultCount: integer("adult_count").notNull().default(0),
  childCount: integer("child_count").notNull().default(0),
  reservationRef: text("reservation_ref"),   // 予約番号のみ。氏名は保持しない
  channelCode: text("channel_code"),         // OTA / DIRECT / WALK_IN
  checkInAt: integer("check_in_at", { mode: "timestamp" }),
  checkOutAt: integer("check_out_at", { mode: "timestamp" }),
  isStayover: integer("is_stayover", { mode: "boolean" }).notNull().default(false),
  nightsTotal: integer("nights_total"),
  nightIndex: integer("night_index"),        // 何泊目か
  ratePlanCode: text("rate_plan_code"),
  isComplimentary: integer("is_complimentary", { mode: "boolean" }).notNull().default(false),
  isHouseUse: integer("is_house_use", { mode: "boolean" }).notNull().default(false),

  rawPayload: text("raw_payload", { mode: "json" }),
  importedAt: integer("imported_at", { mode: "timestamp" }).notNull(),
  importedById: text("imported_by_id"),
}, (t) => ({
  uq: uniqueIndex("uq_occ").on(t.roomId, t.businessDate, t.source),
  idx: index("idx_occ_prop_date").on(t.propertyId, t.businessDate),
}));
MUST: 宿泊者の氏名・連絡先・パスポート情報を保存しない。照合には人数と予約参照番号のみで足りる。

2.2 PhysicalSignal
ts
export const physicalSignal = sqliteTable("physical_signal", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  propertyId: text("property_id").notNull(),
  roomId: text("room_id").notNull(),
  businessDate: text("business_date").notNull(),

  signalType: text("signal_type").notNull(),
  // DOOR_UNLOCK | DOOR_OPEN | KEY_ISSUE | POWER_ON | WIFI_JOIN
  // | SELF_CHECKIN | SAFE_USE | MINIBAR_SENSOR
  occurredAt: integer("occurred_at", { mode: "timestamp" }).notNull(),
  actorType: text("actor_type"),
  // GUEST_KEY | STAFF_KEY | MASTER_KEY | MOBILE_KEY | UNKNOWN
  actorRef: text("actor_ref"),
  deviceId: text("device_id"),
  rawPayload: text("raw_payload", { mode: "json" }),
  receivedAt: integer("received_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  idx: index("idx_sig_room_date").on(t.roomId, t.businessDate, t.signalType),
  idxTime: index("idx_sig_time").on(t.propertyId, t.occurredAt),
}));
2.3 RoomAccessLog（正当な入室の記録）
誤検知を減らすため、業務上の入室を事前・事後に登録できるようにする。

ts
export const roomAccessLog = sqliteTable("room_access_log", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  propertyId: text("property_id").notNull(),
  roomId: text("room_id").notNull(),
  businessDate: text("business_date").notNull(),
  purpose: text("purpose").notNull(),
  // INSPECTION | MAINTENANCE | VENDOR_VISIT | SHOWING | TRAINING | OTHER
  enteredAt: integer("entered_at", { mode: "timestamp" }).notNull(),
  exitedAt: integer("exited_at", { mode: "timestamp" }),
  actorId: text("actor_id"),
  actorName: text("actor_name"),
  note: text("note"),
  registeredById: text("registered_by_id").notNull(),
  registeredAt: integer("registered_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  idx: index("idx_access").on(t.roomId, t.businessDate),
}));
2.4 ReconciliationRun
ts
export const reconciliationRun = sqliteTable("reconciliation_run", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  propertyId: text("property_id").notNull(),
  businessDate: text("business_date").notNull(),
  engineVersion: text("engine_version").notNull(),
  rulesetHash: text("ruleset_hash").notNull(),

  status: text("status").notNull(),      // RUNNING | COMPLETED | FAILED | SKIPPED
  roomsEvaluated: integer("rooms_evaluated").notNull().default(0),
  rulesEvaluated: integer("rules_evaluated").notNull().default(0),
  findingsCreated: integer("findings_created").notNull().default(0),
  findingsSuppressed: integer("findings_suppressed").notNull().default(0),

  availableSources: text("available_sources", { mode: "json" })
    .$type<string[]>().notNull(),        // ["occupancy","observation","signal"]
  skipReason: text("skip_reason"),
  errorMessage: text("error_message"),

  startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
}, (t) => ({
  uq: uniqueIndex("uq_run").on(t.propertyId, t.businessDate, t.engineVersion),
}));
2.5 AuditFinding
ts
export const auditFinding = sqliteTable("audit_finding", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  runId: text("run_id").notNull(),
  propertyId: text("property_id").notNull(),
  roomId: text("room_id").notNull(),
  businessDate: text("business_date").notNull(),

  ruleCode: text("rule_code").notNull(),
  ruleVersion: text("rule_version").notNull(),
  severity: text("severity").notNull(),        // HIGH | MEDIUM | LOW
  confidence: integer("confidence").notNull(), // 0-100
  title: text("title").notNull(),
  summary: text("summary").notNull(),

  evidence: text("evidence", { mode: "json" }).notNull(),
  matchedSignals: text("matched_signals", { mode: "json" }).$type<string[]>().notNull(),

  status: text("status").notNull().default("OPEN"),
  // OPEN | REVIEWING | RESOLVED | FALSE_POSITIVE | SUPPRESSED
  assignedToId: text("assigned_to_id"),
  resolvedById: text("resolved_by_id"),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  resolutionCode: text("resolution_code"),
  resolutionNote: text("resolution_note"),

  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  uq: uniqueIndex("uq_finding").on(t.roomId, t.businessDate, t.ruleCode),
  idxStatus: index("idx_finding_status").on(t.propertyId, t.status, t.severity),
  idxDate: index("idx_finding_date").on(t.organizationId, t.businessDate),
}));
2.6 DetectionFeedback
ts
export const detectionFeedback = sqliteTable("detection_feedback", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  propertyId: text("property_id").notNull(),
  roomId: text("room_id"),
  ruleCode: text("rule_code").notNull(),
  outcome: text("outcome").notNull(),   // TRUE_POSITIVE | FALSE_POSITIVE
  reasonCode: text("reason_code"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  idx: index("idx_feedback").on(t.propertyId, t.ruleCode, t.createdAt),
}));
2.7 RuleConfig
ts
export const ruleConfig = sqliteTable("rule_config", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  propertyId: text("property_id"),      // null = 組織既定
  ruleCode: text("rule_code").notNull(),
  isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
  severityOverride: text("severity_override"),
  thresholds: text("thresholds", { mode: "json" }).notNull().default({}),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  uq: uniqueIndex("uq_rule_cfg").on(t.organizationId, t.propertyId, t.ruleCode),
}));
3. 検出ルール
3.1 ルール一覧
コード	名称（UI表示）	重要度	必要系統
R001	稼働記録のない使用痕跡	HIGH	A + B
R002	施錠解除と稼働記録の不一致	HIGH	A + C
R003	人数とリネン消費の相違	MEDIUM	A + B + baseline
R004	退室日と清掃日の相違	MEDIUM	A + B
R005	連泊記録と現場の相違	MEDIUM	A + B
R006	稼働記録なしの清掃発生	MEDIUM	B
R007	ベッド数と人数の相違	LOW	A + B
R008	アメニティ消費の異常	LOW	B + baseline
R009	リネン回収数の不足	LOW	B + baseline
R010	客室ステータスの手動上書き頻発	MEDIUM	AuditLog
R011	清掃時間の著しい短さ	LOW	task
R012	写真未添付での完了	LOW	task
R013	深夜帯の施錠解除	MEDIUM	C
R014	稼働記録の事後変更	MEDIUM	A
3.2 R001 — 稼働記録のない使用痕跡
ts
export const R001: Rule = {
  code: "R001",
  version: "1.0",
  title: "稼働記録のない使用痕跡",
  requires: ["occupancy", "observation"],

  evaluate(ctx: RuleContext): FindingDraft | null {
    const { occupancy, observation, room, accessLogs } = ctx;

    if (!occupancy || occupancy.isOccupied) return null;
    if (occupancy.isHouseUse || occupancy.isComplimentary) return null;
    if (!observation || observation.skipped) return null;
    if (room.saleStatus === "MAINTENANCE" || room.saleStatus === "OUT_OF_ORDER") return null;
    if (accessLogs.length > 0) return null;   // 正当な入室が登録済み

    const signals: string[] = [];
    if (observation.bedsUsed >= 1) signals.push("BEDS_USED");
    if (observation.trashLevel === "NORMAL" || observation.trashLevel === "HIGH")
      signals.push("TRASH_PRESENT");
    if (observation.bathTowelUsed >= 1) signals.push("TOWEL_USED");
    if (observation.bathMatUsed >= 1) signals.push("BATHMAT_USED");
    if (hasAnyAmenityUsed(observation.amenitiesUsed)) signals.push("AMENITY_USED");

    if (signals.length === 0) return null;

    const confidence = Math.min(95, 35 + signals.length * 15);
    const severity = signals.length >= 3 ? "HIGH"
                   : signals.length >= 2 ? "HIGH"
                   : "MEDIUM";

    return {
      ruleCode: "R001",
      severity,
      confidence,
      title: `${room.number} 号室：稼働記録のない使用痕跡`,
      summary: `稼働記録では空室ですが、清掃時に ${signals.length} 種類の使用痕跡が記録されています。`,
      matchedSignals: signals,
      evidence: {
        occupancy: {
          isOccupied: false,
          source: occupancy.source,
          reservationRef: occupancy.reservationRef,
          importedAt: occupancy.importedAt,
        },
        observation: {
          bedsUsed: observation.bedsUsed,
          trashLevel: observation.trashLevel,
          bathTowelUsed: observation.bathTowelUsed,
          bathMatUsed: observation.bathMatUsed,
          amenitiesUsed: observation.amenitiesUsed,
          recordedAt: observation.recordedAt,
          recordedBy: observation.recordedById,
          usedDefaults: observation.usedDefaults,
        },
        room: { number: room.number, saleStatus: room.saleStatus },
      },
    };
  },
};
MUST: usedDefaults = true の観察記録に基づく R001 は confidence を 20 減じる。既定値のまま確定された記録は実観察の確度が低い。

3.3 R002 — 施錠解除と稼働記録の不一致
text
条件:
  occupancy.isOccupied = false
  かつ GUEST_KEY / MOBILE_KEY による DOOR_UNLOCK が 2 回以上
  かつ その時刻に RoomAccessLog がない
  かつ STAFF_KEY / MASTER_KEY のみではない

確信度:
  base 50
  + 解錠回数が 4 回以上なら +20
  + 深夜帯（0:00-5:00）を含むなら +15
  + 観察でも使用痕跡があるなら +25（R001 と同時発生）
MUST: R001 と R002 が同一客室・同一業務日で同時に発生した場合、2 件を別々に出さず、R002 に統合して matchedSignals に両方の根拠を含める。

3.4 R003 — 人数とリネン消費の相違
text
条件:
  baseline.isReliable = true
  かつ observation.bathTowelUsed > baseline.p90 + 1
  かつ occupancy.guestCount が記録されている

確信度:
  base 40
  + 超過幅が p90 の 1.5 倍以上なら +25
  + 複数品目で同時に超過なら +20
  + 連泊でないなら +10
MUST: 連泊の場合、前日分の未回収が混在しうるため確信度を下げる。

3.5 R004 — 退室日と清掃日の相違
text
条件:
  occupancy.checkOutAt が存在
  かつ アウト清掃が checkOutAt の翌営業日以降に実施
  かつ その間に他の稼働記録がない
3.6 R005 — 連泊記録と現場の相違
text
条件:
  occupancy.isStayover = true
  かつ observation.bedsUsed = 0
  かつ observation.trashLevel = NONE
  かつ 上記が 2 日連続
3.7 R006 — 稼働記録なしの清掃発生
text
条件:
  当該日の OccupancySnapshot が 1 件も存在しない
  かつ CleaningTask が完了している
  かつ 施設の occupancyLinked = true

用途: 連携の欠落・取込漏れの検出
3.8 R010 — 客室ステータスの手動上書き頻発
text
条件:
  同一ユーザーが直近 7 日で 5 回以上 READY への手動上書きを実施

確信度: 固定 60
重要度: MEDIUM

注記: これは個人を指摘するものではなく、運用手順の問題を示す可能性が高い
MUST: R010 の差異詳細画面には「業務手順の見直しが必要な可能性があります」という文言を必ず併記する。

3.9 R013 — 深夜帯の施錠解除
text
条件:
  0:00-5:00 に GUEST_KEY による DOOR_UNLOCK
  かつ occupancy.isOccupied = false
  かつ RoomAccessLog なし
3.10 R014 — 稼働記録の事後変更
text
条件:
  同一 (roomId, businessDate) の OccupancySnapshot が
  清掃完了後に isOccupied = true → false へ変更された

用途: PMS 側での記録取消の検出
4. 抑制と除外
4.1 自動抑制（Findings を生成しない）
客室が MAINTENANCE / OUT_OF_ORDER

RoomAccessLog に該当時間帯の入室記録がある

occupancy.isHouseUse または isComplimentary

施設の occupancyLinked = false（A 系統を要するルール）

開業・導入から 30 日以内（baseline 未成熟なルール）

ruleConfig.isEnabled = false

4.2 重要度の自動引き下げ
条件	調整
同一客室・同一ルールで直近 30 日に 3 回以上 FALSE_POSITIVE	重要度 -1 段階
観察記録が usedDefaults = true	confidence -20
baseline の sampleSize が 20〜40	confidence -10
施設の運用開始から 60 日以内	confidence -10
4.3 抑制の記録
抑制した場合も reconciliationRun.findingsSuppressed にカウントし、管理画面で「抑制された差異 N 件」を確認できるようにする。沈黙させるのではなく、抑制したことを可視化する。

5. 実行
5.1 スケジュール
text
毎日 02:00 JST（施設の日締め時刻 + 21 時間）
  → Cron Trigger
  → 施設ごとに Queue: reconciliation へ投入
  → コンシューマが 1 施設ずつ処理
5.2 二重起動防止
Durable Object ReconciliationLock（施設×業務日）で排他する。

5.3 処理フロー
text
1. availableSources を判定
2. 対象客室を取得（当日タスクがある、または稼働記録がある客室）
3. 各客室について 3 系統のデータをロード
4. ruleConfig を適用してルールセットを構築
5. 各ルールを評価
6. 抑制ルールを適用
7. 既存の Finding と突合（uq により冪等）
8. 新規 Finding を INSERT
9. rollup-update を Queue へ
10. ReconciliationRun を COMPLETED に
MUST: 同じ (propertyId, businessDate, engineVersion) で再実行した場合、既存 Finding を削除せず、差分のみを追加する。ステータスが変更済みの Finding は保護する。

5.4 手動実行
OWNER / ORG_ADMIN は任意の施設・日付で再実行できる。

過去 90 日まで遡及可能。

再実行時は engineVersion が同じなら差分のみ、異なるなら新しい Run として記録。

6. 画面
6.1 W-06 差異レポート一覧
text
差異レポート        [ 全施設 ▾ ] [ 未対応 ▾ ] [ 2026年9月 ▾ ]

未対応 12 ・ 確認中 3 ・ 解決済 28 ・ 誤検知 9

重要度 日付    施設      部屋  内容                    確信度 状態
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 高   09/09  ホテルA   302  稼働記録のない使用痕跡    80%  未対応
 高   09/07  ホテルB  1105  施錠解除と記録の不一致    85%  確認中
 中   09/09  ホテルA   208  人数とリネン消費の相違    55%  未対応
 中   09/08  ホテルA   410  退室日と清掃日の相違      60%  解決済
 低   09/09  ホテルC   502  タオル消費が基準超過      40%  誤検知

抑制された差異 4 件  [ 表示する ]
6.2 W-07 差異詳細
text
302号室  2026年9月9日
稼働記録のない使用痕跡                    確信度 80%  重要度 高

━━━ 3 系統の記録 ━━━━━━━━━━━━━━━━━━━━━━━━

① 稼働記録（PMS / CSV取込 09/10 02:14）
   稼働状態    空室
   予約番号    なし
   人数        0名

② 現場観察（清掃 田中 / 09/09 10:22 記録）
   ベッド使用  1台        ← 検出根拠
   ゴミの量    通常       ← 検出根拠
   バスタオル  2枚        ← 検出根拠
   バスマット  1枚        ← 検出根拠
   入力時間    18秒（既定値からの変更あり）

③ 物理信号
   データなし（スマートロック未連携）

━━━ 参考情報 ━━━━━━━━━━━━━━━━━━━━━━━━━━

清掃写真     [3枚を表示]
入室記録     登録なし
客室状態     販売可
前後の稼働   09/08 空室 / 09/10 稼働（2名）

━━━ 対応 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

状態  [ 未対応 ▾ ]
理由  [                                    ]
      [ 保存 ]

対応履歴
  09/10 08:30  自動検出
MUST: 3 系統を必ず並列表示する。1 系統でも欠けている場合は「データなし」と明示する。

6.3 解決コード
text
RESOLVED の場合:
  OPERATIONAL_EXCEPTION   業務上の例外（点検・内覧等）
  RECORD_MISSING          記録漏れ。PMS 側を修正済
  SYSTEM_DELAY            連携遅延
  EQUIPMENT_ISSUE         設備の不具合
  PROCESS_IMPROVED        手順を見直した
  CONFIRMED_DISCREPANCY   差異を確認し、社内で対応
  OTHER                   その他（理由必須）

FALSE_POSITIVE の場合:
  RULE_TOO_SENSITIVE      検出条件が厳しすぎる
  BASELINE_INACCURATE     基準値が実態と合わない
  DATA_ERROR              元データの誤り
  OTHER
MUST: CONFIRMED_DISCREPANCY を選んでも、システムは「不正」という語を使わない。

6.4 権限
操作	OWNER	ORG_ADMIN	AUDITOR	P_MANAGER	INSPECTOR	CLEANER
差異一覧の閲覧	○	○	○	△	×	×
差異詳細の閲覧	○	○	○	△	×	×
状態の変更	○	○	×	×	×	×
ルール設定	○	○	×	×	×	×
手動再実行	○	○	×	×	×	×
エクスポート	○	○	○	×	×	×
△ = 担当施設のみ、かつ組織設定で許可された場合のみ。既定は不可。

MUST: CLEANER と INSPECTOR は /app/audit/* にアクセスすると 404 を返す（403 は存在を示唆する）。

7. 月次監査レポート
7.1 内容
text
ProofKeeping 稼働照合レポート
施設: サンプルホテル東京
対象期間: 2026年9月1日 〜 9月30日
エンジンバージョン: 1.0 / ルールセット a3f9c2

1. サマリー
   評価対象客室日数        1,800
   利用可能な記録系統      稼働記録 / 現場観察
   検出された差異            18件
     重要度 高                3件
     重要度 中                7件
     重要度 低                8件
   抑制された差異             6件
   解決済                    12件
   誤検知                     4件
   未対応                     2件

2. 重要度別の推移（12か月）

3. 重要度 高 の全件詳細

4. 未対応項目一覧

5. ルール別の検出件数と誤検知率

6. 免責事項
7.2 免責事項（MUST・全文固定）
本レポートは、清掃現場の記録と稼働記録の差異を機械的に抽出したものであり、特定の個人による不正行為を認定するものではありません。差異には、設備の不具合、記録の遅延や漏れ、業務手順上の例外、システム連携のタイムラグなど、多様な原因が含まれます。本レポートの内容を根拠として人事上の措置を行う場合は、必ず個別の事実確認を実施してください。

MUST: この文言を削除・編集できない実装にする。

8. API
text
POST   /api/v1/occupancy/import/csv
POST   /api/v1/occupancy/snapshots
GET    /api/v1/occupancy?propertyId=&businessDate=
POST   /api/v1/signals
POST   /api/v1/room-access-logs
GET    /api/v1/room-access-logs?propertyId=&businessDate=

POST   /api/v1/reconciliation/run
GET    /api/v1/reconciliation/runs?propertyId=&from=&to=
GET    /api/v1/findings?propertyId=&status=&severity=&from=&to=
GET    /api/v1/findings/:id
PATCH  /api/v1/findings/:id
GET    /api/v1/findings/export?format=csv|pdf
GET    /api/v1/rule-configs?propertyId=
PATCH  /api/v1/rule-configs/:id
POST   /api/v1/reports/audit/monthly
8.1 CSV 取込フォーマット
text
room_number,business_date,is_occupied,guest_count,reservation_ref,check_in_at,check_out_at,is_stayover,night_index,nights_total,is_house_use
302,2026-09-09,false,0,,,,false,,,false
303,2026-09-09,true,2,RSV-8891,2026-09-09T15:20:00+09:00,,false,1,3,false
MUST: 取込は (propertyId, businessDate, source) 単位で冪等。再取込時は上書きし、差分を AuditLog に記録する。

9. 実装構造
text
packages/engine/
├─ src/
│  ├─ index.ts              evaluate(context) -> FindingDraft[]
│  ├─ types.ts
│  ├─ rules/
│  │  ├─ R001.ts ... R014.ts
│  │  └─ registry.ts
│  ├─ suppression.ts
│  ├─ confidence.ts
│  └─ baseline.ts           （P3 から継続）
└─ tests/
   └─ rules/R001.spec.ts ...
MUST: packages/engine は DB・fetch・環境変数・日時の現在値に一切依存しない純粋関数群とする。現在時刻が必要な場合は ctx.now として注入する。

10. 受け入れ基準
10.1 エンジン
全 14 ルールに正例・負例のテストが各 5 件以上ある

同じ入力から同じ出力が得られる（決定性）

packages/engine が DB・fetch に依存していない

稼働記録がない施設でバッチが完走する

観察記録がない客室でエラーにならない

10.2 冪等性
同じ Run を 3 回実行しても Finding が重複しない

ステータス変更済みの Finding が再実行で上書きされない

CSV を 3 回取込んでも OccupancySnapshot が重複しない

10.3 抑制
MAINTENANCE 客室で Finding が生成されない

RoomAccessLog がある場合に抑制される

抑制件数が Run に記録され、画面で確認できる

FALSE_POSITIVE 3 回で重要度が下がる

10.4 精度
実データ 4 週間で誤検知率 30% 未満

手動確認との突合で HIGH の見逃しゼロ

usedDefaults の観察に基づく Finding の confidence が 20 低い

10.5 権限・表現
CLEANER が /app/audit/* で 404 になる

INSPECTOR が Finding API で 404 になる

UI・API・PDF に「不正」という語が存在しない（grep で検証）

月次レポートの免責文が編集不可

10.6 性能
100 施設 5,000 室の照合が 10 分以内

1 施設 100 室が 20 秒以内

差異一覧 API が p95 400ms 未満

11. リスクと対策
リスク	影響	対策
誤検知が多く信頼を失う	解約	導入後 4 週間は HIGH のみ通知。段階的に開放
「不正検知ツール」と誤解される	現場の反発・炎上	用語ガイドライン。免責文。CLEANER に非公開
清掃員が入力を歪める	データ汚染	差異画面を清掃員に見せない。P3 の設問設計
PMS 連携がなく A 系統が欠ける	価値半減	B のみでも R006 が動く。CSV 取込を簡単に
顧客が人事措置に使う	法務リスク	免責文を必須表示。利用規約に明記
ルール調整が属人化	保守困難	ruleConfig で施設別に調整。engine は不変
12. 改訂履歴
バージョン	日付	変更内容
v1.0	2026-08-10	初版確定
13. 未決事項
HIGH の差異をリアルタイム通知するか、日次まとめのみとするか。

誤検知率が 30% を超えた場合、どのルールから無効化するか。

R010 の対象に INSPECTOR の一括承認を含めるか。

顧客が独自ルールを定義できるようにするか（v2 以降）。

差異レポートを清掃会社（VENDOR）に共有する機能を設けるか。現状は非共有。

14. Claude Code 作業指示
text
# ProofKeeping — Phase 4

## 前提
- 仕様の唯一の正は docs/PK-SPEC-P4.md（v1.0）。
- §0.2 の着手条件を満たしていること。満たさなければ着手しない。
- P5 の請求機能を先取りしない。

## 実装順序
1. §2 DB migration
2. §8.1 CSV 取込と OccupancySnapshot
3. packages/engine の骨格（types / registry / index）
4. R001 / R006 の 2 ルールのみ実装 → 実データで検証
5. 誤検知率を確認してから R003 / R004 / R005 を追加
6. §5 バッチと ReconciliationLock
7. §6 W-06 / W-07 画面
8. §4 抑制ロジック
9. 残りのルール
10. §7 月次レポート PDF

## P4 固有の絶対ルール
- packages/engine に DB・fetch・環境変数・Date.now() を持ち込まない。
- 「不正」「検知」「監視」「疑わしい」を UI・API・PDF に出さない。
- CLEANER / INSPECTOR に差異情報を一切見せない（404 を返す）。
- 単一シグナルで confidence 80 以上を出さない。
- 3 系統のうち欠けているものを「データなし」と明示する。
- 月次レポートの免責文を編集可能にしない。
- 宿泊者の氏名・連絡先を OccupancySnapshot に保存しない。
- 抑制した差異を握りつぶさず、件数を可視化する。

## テスト必須
- 全ルールの正例・負例
- 3 回再実行での冪等性
- 抑制ルール全種
- CLEANER / INSPECTOR の 404
- grep による禁止語検査を CI に組み込む
