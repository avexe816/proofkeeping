# ProofKeeping 製品仕様書
## PK-SPEC-P3 — Phase 3「観察記録とベースライン」 v1.0

> 文書ID: `PK-SPEC-P3`
> バージョン: **v1.0**
> 対象期間: M5
> タスク数: 13

---

ProofKeeping 製品仕様書
PK-SPEC-P3 — Phase 3「観察記録とベースライン」 v1.0
文書ID: PK-SPEC-P3
バージョン: v1.0
発行日: 2026-08-10
対象期間: M5（4週間）
前提: PK-SPEC-P0 v1.1 / PK-SPEC-P1 v1.0 / PK-SPEC-P2 v1.0

0. 本フェーズの目的
0.1 一行目標
清掃員が入室時に見た「客室の事実」を、判断を挟まず 15 秒で記録し、正常な消耗量の統計（ベースライン）を構築する。

Phase 4 の稼働照合エンジンは、このフェーズで蓄積したデータの上にしか成立しない。P3 の品質が P4 の精度を決める。

0.2 このフェーズで差異検出をしない（MUST）
P3 では観察データを集めるだけで、異常判定を一切行わない。理由は 3 つ。

ベースラインが未成熟な状態で判定すると、誤検知が多発して現場の信頼を失う。

清掃員が「自分の入力が誰かを疑うために使われる」と感じた瞬間、入力が形骸化する。

統計的に意味のある中央値・p90 を出すには、客室タイプ×人数の組み合わせごとに最低 20 サンプルが要る。

MUST: P3 のリリース後、最低 4 週間はデータ蓄積のみを行い、その後に P4 へ進む。

0.3 出荷判定
観察記録の入力率が対象タスクの 95% 以上。

1 タスクあたりの観察入力の中央値所要時間が 20 秒以内。

客室タイプ×人数の主要な組み合わせで 20 サンプル以上が蓄積されている。

ベースライン算出バッチが週次で完走し、中央値と p90 が出力される。

清掃員から「入力が面倒でやめたい」という声が出ていない。

1. 設計原則
1.1 清掃員に判断させない
禁止する設問:

「この部屋は使われましたか？」

「不審な点はありましたか？」

「宿泊人数は何人だと思いますか？」

許可する設問:

「ベッドはいくつ使われていましたか？」（0 / 1 / 2）

「ゴミの量は？」（なし / 少ない / 通常 / 多い）

「使用済みバスタオルは何枚ありましたか？」（数値）

差は「解釈」か「観察」か。清掃員は目に見えたものだけを答える。判定はサーバーが行う。

1.2 15 秒で終わる
観察記録は 1 日 30 室分入力する。1 室 60 秒かかると 1 日 30 分の追加負担になり、必ず形骸化する。

MUST:

全項目に既定値をプリセットする（前回値ではなく、客室タイプ×稼働予定からの推定値）。

既定値のままでよければ 1 タップで確定できる。

入力項目は最大 7 つ。それ以上は増やさない。

数値入力はキーボードを出さない。ステッパーとプリセットボタンで行う。

1.3 入力を強制しない、ただし記録する
観察記録を必須にすると、面倒な日は適当な値を入れられる。それは無記録より有害。

MUST:

「記録しない」を選択できる。理由の選択も求めない。

ただし未記録であること自体を observationSkipped = true として記録する。

未記録率が施設ごとに 20% を超えたら管理画面で警告する。

未記録のタスクは P4 の照合対象から除外する。

1.4 リネンは「枚数」であって「金額」ではない
P3 のリネン記録は稼働照合のための観測値。在庫管理や原価計算は範囲外（P5 以降）。

2. データモデル
2.1 RoomObservation
ts
export const roomObservation = sqliteTable("room_observation", {
  id: text("id").primaryKey(),                    // o7k2m9__obs_01JBX...
  organizationId: text("organization_id").notNull(),
  propertyId: text("property_id").notNull(),
  taskId: text("task_id").notNull(),
  roomId: text("room_id").notNull(),
  roomTypeId: text("room_type_id").notNull(),
  businessDate: text("business_date").notNull(),  // YYYY-MM-DD

  // 入室時の観察（すべて清掃前の状態）
  bedsUsed: integer("beds_used").notNull().default(0),
  trashLevel: text("trash_level").notNull().default("NONE"),  // NONE|LOW|NORMAL|HIGH
  bathTowelUsed: integer("bath_towel_used").notNull().default(0),
  faceTowelUsed: integer("face_towel_used").notNull().default(0),
  handTowelUsed: integer("hand_towel_used").notNull().default(0),
  bathMatUsed: integer("bath_mat_used").notNull().default(0),
  slippersUsed: integer("slippers_used").notNull().default(0),
  cupsUsed: integer("cups_used").notNull().default(0),
  extraFutonUsed: integer("extra_futon_used").notNull().default(0),

  amenitiesUsed: text("amenities_used", { mode: "json" })
    .$type<Record<string, number | boolean>>().notNull().default({}),

  // 補助情報
  note: text("note"),
  inputDurationMs: integer("input_duration_ms"),  // UX 計測用
  usedDefaults: integer("used_defaults", { mode: "boolean" }).notNull().default(false),

  recordedById: text("recorded_by_id").notNull(),
  recordedAt: integer("recorded_at", { mode: "timestamp" }).notNull(),
  clientTs: integer("client_ts", { mode: "timestamp" }),
  deviceInfo: text("device_info", { mode: "json" }),
}, (t) => ({
  uqTask: uniqueIndex("uq_obs_task").on(t.taskId),
  idxRoom: index("idx_obs_room_date").on(t.roomId, t.businessDate),
  idxBaseline: index("idx_obs_baseline").on(t.propertyId, t.roomTypeId, t.businessDate),
}));
MUST: @@unique(taskId) により 1 タスク 1 観察。上書き更新は許可するが、変更履歴を observationRevision に残す。

2.2 ObservationRevision
ts
export const observationRevision = sqliteTable("observation_revision", {
  id: text("id").primaryKey(),
  observationId: text("observation_id").notNull(),
  revision: integer("revision").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),  // 変更前の全内容
  changedById: text("changed_by_id").notNull(),
  changedAt: integer("changed_at", { mode: "timestamp" }).notNull(),
  reason: text("reason"),
}, (t) => ({
  uq: uniqueIndex("uq_obs_rev").on(t.observationId, t.revision),
}));
MUST: 観察記録の事後修正は PROPERTY_MANAGER 以上のみ。理由必須。P4 の照合では最新値を使うが、差異詳細画面では修正履歴も表示する。

2.3 LinenRecord
ts
export const linenRecord = sqliteTable("linen_record", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  propertyId: text("property_id").notNull(),
  taskId: text("task_id").notNull(),
  roomId: text("room_id").notNull(),
  businessDate: text("business_date").notNull(),
  itemCode: text("item_code").notNull(),      // §2.5 参照
  collectedQty: integer("collected_qty").notNull().default(0),
  suppliedQty: integer("supplied_qty").notNull().default(0),
  damagedQty: integer("damaged_qty").notNull().default(0),
  stainedQty: integer("stained_qty").notNull().default(0),
  note: text("note"),
  recordedById: text("recorded_by_id").notNull(),
  recordedAt: integer("recorded_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  uq: uniqueIndex("uq_linen").on(t.taskId, t.itemCode),
  idxDate: index("idx_linen_date").on(t.propertyId, t.businessDate),
}));
2.4 ConsumptionBaseline
ts
export const consumptionBaseline = sqliteTable("consumption_baseline", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  propertyId: text("property_id").notNull(),
  roomTypeId: text("room_type_id").notNull(),
  guestCount: integer("guest_count").notNull(),    // 0,1,2,3...
  taskType: text("task_type").notNull(),           // CHECKOUT | STAYOVER
  itemCode: text("item_code").notNull(),

  sampleSize: integer("sample_size").notNull(),
  medianQty: real("median_qty").notNull(),
  p10Qty: real("p10_qty").notNull(),
  p90Qty: real("p90_qty").notNull(),
  maxQty: real("max_qty").notNull(),
  stdDev: real("std_dev").notNull(),

  isReliable: integer("is_reliable", { mode: "boolean" }).notNull().default(false),
  computedFrom: text("computed_from").notNull(),   // 集計期間の開始日
  computedTo: text("computed_to").notNull(),
  manualOverride: real("manual_override"),         // 管理者が上書きした p90
  overrideReason: text("override_reason"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  uq: uniqueIndex("uq_baseline").on(
    t.propertyId, t.roomTypeId, t.guestCount, t.taskType, t.itemCode
  ),
}));
MUST: sampleSize < 20 の場合 isReliable = false とし、P4 のルール評価から除外する。

2.5 品目コード
text
リネン
  SHEET_SINGLE     シングルシーツ
  SHEET_DOUBLE     ダブルシーツ
  DUVET_COVER      デュベカバー
  PILLOW_CASE      枕カバー
  BATH_TOWEL       バスタオル
  FACE_TOWEL       フェイスタオル
  HAND_TOWEL       ハンドタオル
  BATH_MAT         バスマット
  YUKATA           館内着・浴衣
  EXTRA_FUTON      追加布団          ← 2026-08-22 追記（DECISIONS #252）

アメニティ
  TOOTHBRUSH       歯ブラシ
  RAZOR            カミソリ
  SHAMPOO          シャンプー（個包装）
  CONDITIONER      コンディショナー
  BODY_SOAP        ボディソープ
  HAIR_BRUSH       ヘアブラシ
  COTTON_SET       綿棒・コットン
  SLIPPERS         スリッパ
  BOTTLED_WATER    ミネラルウォーター
  TEA_BAG          お茶・コーヒー
  CUP              コップ            ← 2026-08-22 追記（DECISIONS #252）
MUST: 品目は施設ごとに有効・無効を設定できる。使わない品目を入力画面に出さない。

2026-08-22 追記（DECISIONS #252）: EXTRA_FUTON と CUP を足した。
`roomObservation` は当初から `extra_futon_used` / `cups_used` の列を持ち、
値も記録されていたが、この一覧に対応するコードが無いためベースラインの
集計キー（§5.2）に載せられなかった。値は **専用の列から拾う**（SLIPPERS と
同じ形で、`amenitiesUsed` の JSON は経由しない）。列は migration 0012 以降
ずっと記録されているので、**過去のぶんも次回の集計から標本になる。**

2.6 施設別の観察設定
ts
export const observationConfig = sqliteTable("observation_config", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  propertyId: text("property_id").notNull().unique(),

  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  requireBeds: integer("require_beds", { mode: "boolean" }).notNull().default(true),
  requireTrash: integer("require_trash", { mode: "boolean" }).notNull().default(true),
  requireTowels: integer("require_towels", { mode: "boolean" }).notNull().default(true),
  requireAmenities: integer("require_amenities", { mode: "boolean" }).notNull().default(false),
  requireLinen: integer("require_linen", { mode: "boolean" }).notNull().default(false),

  enabledItemCodes: text("enabled_item_codes", { mode: "json" })
    .$type<string[]>().notNull().default([]),

  skipWarnThreshold: integer("skip_warn_threshold").notNull().default(20),  // %
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});
2.7 CleaningTask への追加
ts
observationSkipped: integer("observation_skipped", { mode: "boolean" })
  .notNull().default(false),
observationRecordedAt: integer("observation_recorded_at", { mode: "timestamp" }),
3. 観察記録の入力フロー
3.1 タイミング
text
タスク開始（start）
  ↓
【入室直後】観察記録を入力  ← ここ
  ↓
清掃作業
  ↓
チェックリスト
  ↓
【退室前】リネン枚数を入力  ← ここ
  ↓
完了
MUST: 観察記録は「清掃前」の状態を記録するため、start の直後に表示する。清掃後に入力させると値が変わってしまい、データとして無意味になる。

3.2 開始時の強制表示
start を押した直後、観察記録画面を全画面で表示する。

text
┌──────────────────────────────────────┐
│ 302号室  入室時の記録                 │
│                                       │
│ 清掃を始める前に、部屋の状態を          │
│ 記録してください（15秒）               │
│                                       │
│                    [ 記録する ]       │
│                    [ 今回は記録しない ] │
└──────────────────────────────────────┘
MUST: 「今回は記録しない」を必ず用意する。押した場合は observationSkipped = true を記録し、清掃画面へ進む。

3.3 既定値の推定
DailyRoomPlan と客室タイプから既定値を推定してプリセットする。

ts
function estimateDefaults(plan: DailyRoomPlan, roomType: RoomType) {
  if (!plan.hasCheckout && !plan.isStayover) {
    // 空室想定
    return { bedsUsed: 0, trashLevel: "NONE", bathTowelUsed: 0, ... };
  }
  const guests = plan.guestCount || roomType.standardCapacity;
  return {
    bedsUsed: Math.min(guests, roomType.bedCount),
    trashLevel: "NORMAL",
    bathTowelUsed: guests,
    faceTowelUsed: guests,
    bathMatUsed: 1,
    ...
  };
}
MUST: 既定値のまま確定した場合 usedDefaults = true を記録する。この比率が 90% を超える施設は、入力が形骸化している可能性があるため管理画面で警告する。

4. モバイル画面
4.1 M-05 入室時の記録
text
┌──────────────────────────────────────┐
│ ← 302号室  入室時の記録        1/2    │
├──────────────────────────────────────┤
│ ベッドの使用                          │
│  ┌────┐ ┌────┐ ┌────┐                │
│  │ 0台 │ │ 1台 │ │ 2台 │  ← 大きめの  │
│  └────┘ └━━━━┘ └────┘     選択ボタン  │
├──────────────────────────────────────┤
│ ゴミの量                              │
│  ┌────┐┌────┐┌────┐┌────┐            │
│  │なし││少ない││通常││多い│            │
│  └────┘└────┘└━━━━┘└────┘            │
├──────────────────────────────────────┤
│ 使用済みタオル                        │
│  バスタオル    [－]  2  [＋]          │
│  フェイス      [－]  2  [＋]          │
│  バスマット    [－]  1  [＋]          │
├──────────────────────────────────────┤
│                                       │
│  [        この内容で記録する        ] │
│                                       │
│  [ 詳しく入力する（アメニティ等） ]   │
└──────────────────────────────────────┘
要件

ボタンは 56px 以上。手袋対応。

数値はステッパーのみ。キーボードを出さない。

既定値は選択済み状態で表示する。

「この内容で記録する」を押すまで 1 タップで完了できる。

画面表示から確定までの時間を inputDurationMs に記録する。

4.2 M-05b 詳細入力（任意）
text
┌──────────────────────────────────────┐
│ ← 302号室  詳しく記録         2/2     │
├──────────────────────────────────────┤
│ アメニティの使用                      │
│  歯ブラシ      [－]  2  [＋]          │
│  シャンプー類  [ 使用あり ]           │
│  スリッパ      [－]  2  [＋]          │
│  ミネラル水    [－]  0  [＋]          │
├──────────────────────────────────────┤
│ その他                                │
│  グラス使用    [－]  2  [＋]          │
│  追加布団      [－]  0  [＋]          │
├──────────────────────────────────────┤
│ 備考（任意）                          │
│ [                                  ]  │
├──────────────────────────────────────┤
│  [           記録する            ]    │
└──────────────────────────────────────┘
4.3 M-06 リネン枚数
退室前、チェックリスト完了後に表示する。施設設定で requireLinen = false なら表示しない。

text
┌──────────────────────────────────────┐
│ ← 302号室  リネン                     │
├──────────────────────────────────────┤
│ 回収した枚数                          │
│  シーツ        [－]  2  [＋]          │
│  デュベカバー  [－]  2  [＋]          │
│  枕カバー      [－]  4  [＋]          │
│  バスタオル    [－]  2  [＋]          │
├──────────────────────────────────────┤
│ 破損・汚損があれば                    │
│  [ 破損を報告 ]  [ 汚損を報告 ]       │
├──────────────────────────────────────┤
│  [           記録する            ]    │
└──────────────────────────────────────┘
MUST: 破損・汚損を報告した場合、写真 1 枚を求める。これは P5 の請求（弁償・追加費用）の根拠になる。

4.4 UI で使ってはいけない表現
使わない	使う
不審な点	気づいたこと
異常	通常と違う点
疑わしい	—
チェック（監視の意味で）	記録
報告義務	記録のお願い
5. ベースライン算出
5.1 実行タイミング
text
毎週日曜 03:00 JST
  → Queue: baseline-learning
  → 施設ごとに順次処理
5.2 アルゴリズム
ts
// packages/engine/src/baseline.ts

export function computeBaseline(
  observations: ObservationSample[],
  opts: { minSampleSize: number; windowDays: number }
): BaselineResult[] {
  // 1. 除外
  const clean = observations.filter(o =>
    !o.hasFinding &&           // P4 で差異が付いた日は除外
    !o.observationSkipped &&
    !o.isOutlier               // §5.3
  );

  // 2. グルーピング
  const groups = groupBy(clean, o =>
    `${o.propertyId}|${o.roomTypeId}|${o.guestCount}|${o.taskType}|${o.itemCode}`
  );

  // 3. 統計量
  return Object.entries(groups).map(([key, samples]) => {
    const values = samples.map(s => s.qty).sort((a, b) => a - b);
    return {
      key,
      sampleSize: values.length,
      medianQty: percentile(values, 50),
      p10Qty: percentile(values, 10),
      p90Qty: percentile(values, 90),
      maxQty: values[values.length - 1],
      stdDev: standardDeviation(values),
      isReliable: values.length >= opts.minSampleSize,
    };
  });
}
5.3 外れ値の除外
text
以下を集計対象から除外する:
  - 値が 0 かつ bedsUsed > 0（明らかな入力漏れ）
      ただし下の 2 条件を満たすときだけ（2026-08-22 追記 / DECISIONS #252）
  - 値が中央値の 5 倍を超える（誤入力の可能性）
  - inputDurationMs < 3000（3秒未満での確定は精度が疑わしい）
  - 同一スタッフが同日に 10 件以上まったく同じ値を入力（連打の可能性）
MUST: 除外した件数を baselineExclusionLog に記録し、管理画面で確認できるようにする。除外率が 15% を超える施設は入力品質に問題があるため警告する。

2026-08-22 追記（DECISIONS #252）: 除外ルール①（値が 0 かつ bedsUsed > 0）は
**次の 2 条件を両方満たす標本にだけ当てる。**

  1. 品目が次の 3 種のいずれか（宿泊があれば必ず消費される）
       DUVET_COVER / PILLOW_CASE / BATH_TOWEL
  2. 清掃種別が CHECKOUT（退室清掃）

MUST: 上記以外の 0 を除外しない。

理由: 全品目・全清掃種別に当てると、**正常な 0 まで母数から消えて
ベースラインが実態より高く出る。** その結果 P4 の照合は差異を見逃す側へ
倒れる（過検知ではない）。

  - アメニティ・追加布団（EXTRA_FUTON）は「泊まったが使わなかった」が
    正常な観察で、0 を入力漏れとして扱えない。
  - 滞在中清掃（STAYOVER）ではリネンを交換しない運用があり、回収 0 が
    正常。除外すると母数が「交換した回」だけになる。
  - シーツ（SHEET_SINGLE / SHEET_DOUBLE）はベッドの種類に依存し、
    片方は 0 が正常。
  - FACE_TOWEL は用意されても客が使わないことがあり、0 が正常でありうる。
    実データで 0 の出方を見てから判断する（docs/tasks/P4-08.md）。

注意（未解決）: 滞在中清掃で「交換しなかった 0」と「交換したのに記録漏れの
0」はデータ上まったく区別できない。上の回避で偏りは防げるが、STAYOVER の
リネン系の差異は CHECKOUT より確信度が構造的に低い
（docs/OPEN_QUESTIONS.md #119）。

5.4 集計ウィンドウ
text
既定: 直近 90 日
最小: 30 日
最大: 180 日

季節性がある施設（リゾート等）は 365 日を選択可能。
5.5 手動上書き
ORG_ADMIN はベースラインの p90 を手動で上書きできる。

理由必須。

上書き値は次回の自動算出で消えない。

解除するまで固定される。

manualOverride が設定されている場合、管理画面に明示する。

6. PC 管理画面
6.1 追加画面
ID	パス	画面	ロール
W-19	/app/p/[id]/observations	観察記録一覧	P_MANAGER 以上
W-20	/app/settings/observation	観察項目の設定	ORG_ADMIN
W-21	/app/settings/baseline	ベースライン確認・上書き	ORG_ADMIN
W-22	/app/p/[id]/data-quality	データ品質ダッシュボード	ORG_ADMIN
6.2 W-21 ベースライン確認
text
サンプルホテル東京  ベースライン
集計期間: 2026/06/15 〜 2026/09/12（90日）
最終更新: 2026/09/15 03:12

客室タイプ: [ ツイン ▾ ]  人数: [ 2名 ▾ ]  種別: [ アウト清掃 ▾ ]

品目           サンプル  中央値   p10    p90    最大   信頼性
バスタオル        142     2.0     2.0    3.0    5.0    ○
フェイスタオル    142     2.0     2.0    2.0    4.0    ○
バスマット        142     1.0     1.0    1.0    2.0    ○
歯ブラシ           98     2.0     0.0    2.0    4.0    ○
スリッパ           98     2.0     2.0    2.0    2.0    ○
ミネラル水         41     0.0     0.0    2.0    2.0    ○
追加布団            8     0.0     0.0    0.0    1.0    ×  ← 20件未満
p90 の列は編集可能（手動上書き）。

信頼性 × の行はグレー表示し、「P4 の照合では使用されません」と注記する。

6.3 W-22 データ品質ダッシュボード
text
観察記録の品質  2026年9月

入力率              94.2%   ✓ 目標 95%
既定値のまま確定    61.3%   ✓ 警告 90%
平均入力時間        12.4秒  ✓ 目標 20秒以内
外れ値除外率         3.1%   ✓ 警告 15%
未記録率             5.8%   ✓ 警告 20%

スタッフ別の入力率
  田中 (08)        98%   ████████████████████
  佐藤 (03)        96%   ███████████████████
  Nguyen (11)      87%   █████████████████     ← 要フォロー

ベースライン成熟度
  客室タイプ×人数の組み合わせ    12 / 15 が信頼可能
  未成熟: ツイン×3名、和室×4名、和室×5名
MUST: スタッフ別の入力率は「フォローが必要な人を見つける」ために表示する。評価には使わない旨を画面に明記する。

7. API
text
PUT    /api/v1/tasks/:id/observation        冪等。上書き可
POST   /api/v1/tasks/:id/observation/skip   記録しない
GET    /api/v1/tasks/:id/observation
PATCH  /api/v1/observations/:id             事後修正（理由必須）
GET    /api/v1/observations?propertyId=&from=&to=

PUT    /api/v1/tasks/:id/linen              配列で一括
GET    /api/v1/tasks/:id/linen

GET    /api/v1/baselines?propertyId=&roomTypeId=&guestCount=
PATCH  /api/v1/baselines/:id/override       手動上書き
POST   /api/v1/baselines/recompute          手動再計算（Queue へ）

GET    /api/v1/data-quality?propertyId=&month=
MUST: PUT /observation は Idempotency-Key に対応し、オフラインキューからの再送で二重登録しない。

8. オフライン対応
観察記録とリネン記録は P1 のオフラインキューに乗せる。

API	オフライン
PUT /tasks/:id/observation	○
POST /tasks/:id/observation/skip	○
PUT /tasks/:id/linen	○
PATCH /observations/:id	× （管理操作）
MUST: 観察記録は start の直後に入力するため、オフライン時も必ずローカルに保存し、後から送信する。ここで記録が失われると P4 が成立しない。

9. 受け入れ基準
9.1 入力
start 直後に観察画面が全画面表示される

既定値が客室タイプと稼働予定から推定される

1 タップで確定でき、所要時間が中央値 20 秒以内

「今回は記録しない」で observationSkipped = true が記録される

数値入力でキーボードが出ない

手袋着用で全ボタンが押せる

機内モードで入力し、復帰後に送信される

9.2 データ
1 タスクに 1 観察のみ（重複不可）

事後修正で observationRevision に旧値が残る

usedDefaults が正しく記録される

inputDurationMs が記録される

施設設定で無効化した品目が画面に出ない

9.3 ベースライン
週次バッチが全施設で完走する

sampleSize < 20 で isReliable = false になる

外れ値の除外ルール 4 種が機能する

除外件数が baselineExclusionLog に記録される

手動上書きが次回バッチで消えない

同じ入力から同じ統計量が算出される（決定性）

9.4 品質
W-22 の全指標が算出される

入力率 20% 未満の施設に警告が出る

既定値率 90% 超の施設に警告が出る

スタッフ別入力率に「評価には使わない」注記がある

9.5 現場
清掃員 3 名が説明 3 分以内で入力できる

4 週間の運用で入力率 95% 以上を維持

「面倒だからやめたい」という声が出ていない

主要な客室タイプ×人数で 20 サンプル以上蓄積

10. リスクと対策
リスク	影響	対策
入力が形骸化する	P4 が成立しない	既定値率を監視。90% 超で施設に介入
面倒で入力率が落ちる	データ不足	15 秒設計。スキップ可。強制しない
監視されていると感じる	現場の反発	判断させない設問設計。用語ガイドライン
客室タイプが多すぎてサンプルが分散	ベースライン未成熟	類似タイプのグルーピング機能（P4 で検討）
季節変動を吸収できない	誤検知増加	ウィンドウを 90〜365 日で可変に
清掃員が値を推測で入れる	精度低下	3 秒未満の確定を外れ値として除外
11. 改訂履歴
バージョン	日付	変更内容
v1.0	2026-08-10	初版確定
12. 未決事項
客室タイプが 10 種類以上ある施設で、ベースラインのグルーピングをどう扱うか。

連泊 2 日目以降の観察を毎日取るか、退室時のみとするか。現状は滞在清掃時も取る前提。

リネン記録を清掃員が入力するか、リネン回収担当が別途入力するか。

アメニティの「使用あり／なし」と「個数」のどちらを既定とするか。品目により異なる。

ベースラインを施設単位でなく組織単位で共有する選択肢を設けるか（新規施設の立ち上げ時に有用）。

13. Claude Code 作業指示
text
# ProofKeeping — Phase 3

## 前提
- 仕様の唯一の正は docs/PK-SPEC-P3.md（v1.0）。
- P2 の出荷判定を通過していること。
- P4 の差異検出を先取りしない。P3 は「集めるだけ」。

## 実装順序
1. §2 DB migration（全 16 シャード）
2. §3 既定値推定ロジック
3. §4.1 M-05 観察記録画面（最優先。UX が命）
4. §4.2 M-05b 詳細入力
5. §8 オフライン対応
6. §4.3 M-06 リネン
7. §5 ベースライン算出（packages/engine/baseline.ts）
8. §6 管理画面 4 本

## P3 固有の絶対ルール
- 清掃員に「判断」を求める設問を作らない。
- 「不審」「異常」「疑い」という語を UI に出さない。
- 観察記録を必須にしない。スキップを必ず用意する。
- 数値入力にキーボードを出さない。
- 入力項目を 7 つ以上にしない。
- P3 では一切の異常判定・アラートを出さない。
- ベースラインを sampleSize < 20 で信頼可能としない。
- packages/engine/baseline.ts に DB・fetch を持ち込まない（純粋関数）。

## テスト必須
- 既定値推定の正しさ（空室・稼働・連泊の 3 パターン）
- 1 タスク 1 観察の一意制約
- オフライン送信後の冪等性
- ベースライン算出の決定性（同入力→同出力）
- 外れ値除外ルール 4 種
- 手動上書きの永続性
