# ProofKeeping 製品仕様書
## PK-SPEC-P8 — Phase 8「Workforce と Inventory」 v1.3

> **貼り付け先**: `docs/PK-SPEC-P8.md`（新規ファイル）
> **同時に更新**: `docs/PK-SPEC-P0.md` §0.1 の文書一覧に P8 を追加
>
> 文書ID: `PK-SPEC-P8`
> バージョン: **v1.3**
> 発行日: 2026-08-10
> 対象期間: GA 後 3〜6 か月（M15–M18 相当）
> 前提: `PK-SPEC-P0 v1.2` 〜 `P7 v1.0`、および GA 判定（P7-17）の通過

---

## 0. 本フェーズの位置づけ

### 0.1 これは「後から足す」フェーズ

Workforce と Inventory は清掃会社から要望が出る機能だが、**購入の決定理由ではない。**

顧客が ProofKeeping を買う理由は「証跡」と「請求の対账」である。シフト表と在庫管理は今も Excel で回っている。したがってコア機能が固まる前にこれを作ると、価値の薄い機能で工数を消費することになる。

**MUST**: P7 の GA 判定を通過し、有償顧客 5 社が稼働してから着手する。

### 0.2 単価引き上げの材料として使う

| モジュール | 価格（税別） | 単位 |
|---|---:|---|
| Workforce | ¥4,980 ＋ ¥300/人 | 組織・月 |
| Inventory | ¥3,980 ＋ ¥500/施設 | 組織・月 |

34 名・12 施設の清掃会社なら Workforce ¥15,180、Inventory ¥9,980。合計で月 ¥25,160 の上乗せになる。

### 0.3 出荷判定

**Workforce**
1. 在留資格の期限アラートが 90/60/30 日前に発火する。
2. 週間シフトから自動配分（P1-14）が出勤者を自動取得する。
3. スタッフ台帳から個人を特定する評価指標が出力されない。

**Inventory**
1. リネン 4 セットの内訳が実在庫と一致する（棚卸で検証）。
2. 発注点を下回った品目が一覧で提示される。
3. 自動発注は行わず、必ず人の承認を経る。

---

## 1. Workforce モジュール

### 1.1 スコープ

| # | 機能 | 章 |
|---|---|---|
| 1 | スタッフ台帳 | §1.3 |
| 2 | 在留資格の期限管理 | §1.4 |
| 3 | 週間シフト | §1.5 |
| 4 | 出勤打刻 | §1.6 |
| 5 | 研修・スキル管理 | §1.7 |

### 1.2 設計原則

**MUST**:
- 労務管理システムを作らない。**控除計算（社会保険・源泉徴収・年末調整）は範囲外。**
  支給総額の基礎までの**支払集計は `docs/PK-SPEC-PAY.md` v1.0 が定め、P5-18 として先行提供する**
  （2026-08-19 改訂 / オーナー指示。給与計算そのものを作らない原則は変わらない）。
- 打刻データを法定帳簿として扱わない。作業実績の把握が目的であることを明示する。
- 個人を序列化する指標を出力しない（P2 §1.3 の原則を継承）。
- 在留資格の判定を自動化しない。期限の通知に限定する。

### 1.3 スタッフ台帳

`Membership`（P0）を拡張せず、別テーブルとして持つ。Workforce を購入しない顧客に不要なカラムを持たせないため。

```ts
export const staffProfile = sqliteTable("staff_profile", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  membershipId: text("membership_id").notNull().unique(),

  // 基本
  displayName: text("display_name").notNull(),
  displayNameKana: text("display_name_kana"),
  staffNumber: text("staff_number").notNull(),

  // 雇用
  employmentType: text("employment_type").notNull(),
  // FULL_TIME | PART_TIME | DISPATCH | CONTRACTOR
  hiredOn: text("hired_on"),                    // YYYY-MM-DD
  resignedOn: text("resigned_on"),
  status: text("status").notNull().default("ACTIVE"), // ACTIVE | ON_LEAVE | RESIGNED

  // 単価（請求原価の算出に使う）
  hourlyRate: integer("hourly_rate"),           // 円
  perRoomRate: integer("per_room_rate"),        // 円（1室単価契約の場合）

  // 対応能力
  languages: text("languages", { mode: "json" }).$type<string[]>().notNull().default([]),
  // ["ja","en","vi","id","my","zh"]
  skills: text("skills", { mode: "json" }).$type<string[]>().notNull().default([]),
  // ["CHECKOUT","STAYOVER","DEEP","COMMON_AREA","INSPECTION"]

  // 健康・研修
  healthCheckedOn: text("health_checked_on"),
  trainingCompletedOn: text("training_completed_on"),

  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  idx: index("idx_staff_org").on(t.organizationId, t.status),
}));
```

**MUST**:
- 氏名は表示名のみを保持する。本籍・住所・生年月日・マイナンバー・口座情報を保存しない。
- `hourlyRate` / `perRoomRate` は `PROPERTY_MANAGER` には見せない。`ORG_ADMIN` 以上のみ。
- スタッフ本人は自分のプロフィールを閲覧できるが、単価は見えない設定を既定とする。

### 1.4 在留資格の期限管理

日本のビルクリーニング分野では特定技能 1 号の通算在留期間に上限があり、期限管理を誤ると事業者側のリスクになる。

```ts
export const residencyRecord = sqliteTable("residency_record", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  staffProfileId: text("staff_profile_id").notNull(),

  statusType: text("status_type").notNull(),
  // SPECIFIED_SKILLED_1 | SPECIFIED_SKILLED_2 | TRAINING_EMPLOYMENT
  // | PERMANENT | SPOUSE | STUDENT_PART_TIME | OTHER | NOT_APPLICABLE
  statusLabel: text("status_label"),            // 表示用の任意ラベル
  expiresOn: text("expires_on"),                // YYYY-MM-DD
  renewalAppliedOn: text("renewal_applied_on"),
  workPermitRequired: integer("work_permit_required", { mode: "boolean" })
    .notNull().default(false),                  // 資格外活動許可の要否
  weeklyHourLimit: integer("weekly_hour_limit"), // 留学生等の上限時間

  note: text("note"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  updatedById: text("updated_by_id").notNull(),
}, (t) => ({
  idxExp: index("idx_residency_exp").on(t.organizationId, t.expiresOn),
}));
```

**アラート**

```
毎日 07:00 JST のバッチで判定

expiresOn - today = 90日 → 情報（画面のみ）
                    60日 → 警告（画面 ＋ メール）
                    30日 → 緊急（画面 ＋ メール ＋ 毎日再通知）
                     0日 → 期限切れ（該当スタッフへのタスク配分を停止）
```

画面表示:

```
⚠ 在留資格の期限が近いスタッフ 2名

Nguyen (11) · 特定技能1号 · 2026/11/30 まで（残り112日）
Aung  (17) · 特定技能1号 · 2027/02/15 まで（残り189日）
```

**MUST**:
- 期限切れ時、そのスタッフへの新規タスク配分を自動停止する。既存の未完了タスクは残す（現場を止めないため）。
- 停止解除は `ORG_ADMIN` 以上が `expiresOn` を更新した場合のみ。手動での解除ボタンを作らない。
- **在留資格の種類から就労可否を自動判定しない。** 制度は変わるため、システムは期限の通知に限定する。判断は事業者が行う旨を画面に明示する。
- `residencyRecord` の閲覧は `ORG_ADMIN` と `OWNER` のみ。`PROPERTY_MANAGER` には「期限確認が必要なスタッフがいます」の件数のみ表示する。

**保存期間（P8-11 / オーナー判断 2026-08-22。境界と原子性は同日の hotfix / DECISIONS #268）**

> **在留資格の記録は、従業員の退職日から 3 年の保存期間が満了した翌日以降に物理削除する。**

- **起算日は従業員の退職日**（`staffPayProfile.resignedOn`）。在留期限でも、記録を作った日でもない。
- **満了日当日は削除しない。翌日以降のバッチから対象にする。** 民法 140 条（初日不算入）で数えると
  3 年の満了は当日の終了時で、07:00 JST のバッチで当日に消すと期間が満了していない。
  例: 2023-08-20 退職 → 満了 2026-08-20 → **2026-08-21 の回から**削除対象。
- **応当する日が無いときは、その月の末日を満了日とする**（民法 143 条 2 項）。
  例: 2024-02-29 退職 → 満了 **2027-02-28** → 2027-03-01 の回から削除対象。翌月 1 日へ送らない。
- **暦として存在しない退職日は削除対象にしない**（`2023-02-30` / `2023-00-15` など）。
  形が `YYYY-MM-DD` でも暦に無い値は判定の材料にならない。物理削除は取り返しがつかないので、
  判定できない入力は消さない側へ倒す。
- **退職日が不明な記録は自動削除しない。** 判定の材料が無いものを、経過日数の推測で消さない。
- **在職中の記録は、在留期限が切れていても削除しない。** 期限切れは配分停止の理由であって、削除の理由ではない。
- 削除は毎日 07:00 JST のバッチ（上のアラートと同じ回）で行い、**3 回実行しても結果が変わらない**。
- **DELETE と監査ログは同じ D1 `batch()` で原子的に実行する。** どちらかが失敗したら両方を巻き戻す。
  「消えたのに記録が無い」状態を作ってはならない。
- 削除の実行を `residency.deleted` として監査ログに残す。**0 件でも残す。**
  - **件数は、その瞬間に DB に実在した削除対象行数**。アプリケーション側が数えた候補数ではない。
  - D1 の束縛変数の上限で対象が塊に分かれた場合、**監査ログは塊ごとに 1 行**になる。
    **合計が実際の削除総数**になること。
  - **監査ログに氏名・種別・期限・更新申請日・退職日・スタッフ ID・対象 ID の一覧・その hash を載せない**
    （残すのは件数のみ）。監査ログが「消したはずの情報」の控えになってはならない。
- **保存期間を設定で変えられるようにしない**（PK-IMPL-CONTRACT §11.4）。変更にはリリースを要する。

根拠: 労働者名簿等の法定保存期間は退職日起算で 5 年、ただし経過措置により当分の間は 3 年
（労働基準法 109 条・143 条）。**経過措置が終わって 5 年になったら、この節と実装の定数を版上げする。**

**画面への固定表示（MUST・編集不可）**

> 在留資格に関する判断は、出入国在留管理庁の定めおよび最新の運用に従い、事業者様の責任で行ってください。本機能は期限の管理を支援するものであり、就労可否を判定するものではありません。

### 1.5 週間シフト

```ts
export const shiftPlan = sqliteTable("shift_plan", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  staffProfileId: text("staff_profile_id").notNull(),
  businessDate: text("business_date").notNull(),

  shiftType: text("shift_type").notNull(),
  // WORK | OFF | PAID_LEAVE | SICK | TRAINING
  propertyId: text("property_id"),              // WORK のとき必須
  startAt: text("start_at"),                    // "09:00"
  endAt: text("end_at"),                        // "17:00"
  breakMinutes: integer("break_minutes").notNull().default(60),
  note: text("note"),

  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  uq: uniqueIndex("uq_shift").on(t.staffProfileId, t.businessDate),
  idx: index("idx_shift_date").on(t.organizationId, t.businessDate),
}));
```

画面:

```
週間シフト（8/10 - 8/16）        [ 前週 ] [ 次週 ] [ 複製 ]

              月    火    水    木    金    土    日
田中 (08)     東京  東京   休   東京  東京  東京   休
Nguyen (11)   東京  横浜  横浜   休   東京  東京  東京
Sari (14)     横浜  横浜  大阪  大阪   休   横浜  横浜
Aung (17)     大阪  大阪  大阪   休   大阪  大阪   休

必要人数     8/8   8/8   7/8   6/8   8/8   9/8   7/8
                          ↑不足        ↑不足  ↑過剰
```

**MUST**:
- 前週のシフトを複製できること。清掃会社は固定シフトが多い。
- 必要人数を当日のタスク総標準時間から自動算出し、不足・過剰を提示する。
- シフト未登録でも P1-14 の自動配分は動作すること。その場合は従来の手動選択にフォールバックする。

### 1.6 出勤打刻

```ts
export const attendance = sqliteTable("attendance", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  staffProfileId: text("staff_profile_id").notNull(),
  businessDate: text("business_date").notNull(),
  propertyId: text("property_id").notNull(),

  clockInAt: integer("clock_in_at", { mode: "timestamp" }),
  clockOutAt: integer("clock_out_at", { mode: "timestamp" }),
  breakMinutes: integer("break_minutes"),
  workedMinutes: integer("worked_minutes"),
  source: text("source").notNull().default("APP"),  // APP | MANUAL
  correctedById: text("corrected_by_id"),
  correctionReason: text("correction_reason"),
}, (t) => ({
  uq: uniqueIndex("uq_att").on(t.staffProfileId, t.businessDate, t.propertyId),
}));
```

モバイル M-02 の上部にボタンを 1 つ追加する。

```
┌──────────────────────────────────────┐
│ 本日のタスク 19件                     │
│ [        🕐 出勤する         ]        │
└──────────────────────────────────────┘
```

**MUST**:
- 出勤せずにタスクを開始することを禁止しない。警告も出さない。打刻は補助機能。
- GPS による打刻を実装しない（P1 §7 の GPS 非保存方針と矛盾するため）。
- 打刻の修正は `PROPERTY_MANAGER` 以上のみ。理由必須。`AuditLog` に記録。
- 「これは勤怠の法定記録ではありません」を設定画面に明示する。

### 1.7 スキルと研修

- `staffProfile.skills` に基づき、P1-14 の自動配分で対応不可の作業を割り当てない。
- `trainingCompletedOn` が未設定のスタッフは「新人」として扱い、P2 §2.2 の必須検査対象にする。
- 研修修了から 30 日間は新人扱いを継続する。

---

## 2. Inventory モジュール

### 2.1 スコープ

| # | 機能 | 章 |
|---|---|---|
| 1 | リネン 4 セット管理 | §2.3 |
| 2 | 消耗品の在庫と発注点 | §2.4 |
| 3 | 棚卸 | §2.5 |
| 4 | 発注 | §2.6 |

### 2.2 設計原則

**MUST**:
- 会計上の棚卸資産管理を目的としない。欠品防止が目的。
- 自動発注を行わない。発注は必ず人の承認を経る。
- P3 の `linenRecord`（回収枚数）を在庫の増減に自動反映しない。§2.3 の理由を参照。

### 2.3 リネン 4 セット管理

日本の宿泊業のリネン運用は「使用中・洗濯中・予備」の 3 セットが最低線、繁忙期を含めると「緊急予備」を加えた 4 セットが安定運用の目安とされる。

```ts
export const linenStock = sqliteTable("linen_stock", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  propertyId: text("property_id").notNull(),
  itemCode: text("item_code").notNull(),        // P3 §2.5 の品目コードを流用

  totalOwned: integer("total_owned").notNull().default(0),
  inUse: integer("in_use").notNull().default(0),
  washing: integer("washing").notNull().default(0),
  spare: integer("spare").notNull().default(0),
  emergency: integer("emergency").notNull().default(0),
  damaged: integer("damaged").notNull().default(0),

  reorderPoint: integer("reorder_point").notNull().default(0),
  targetSets: integer("target_sets").notNull().default(4),

  lastCountedOn: text("last_counted_on"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  uq: uniqueIndex("uq_linen_stock").on(t.propertyId, t.itemCode),
}));
```

画面:

```
リネン在庫 — サンプルホテル東京
4セット運用（使用中・洗濯中・予備・緊急予備）

品目          総保有  使用中  洗濯中  予備  緊急予備  発注点  状態
シーツ          240     96     72     48     24      40    適正
デュベカバー    240     96     78     42     24      40    適正
枕カバー        480    192    144     96     48      80    適正
バスタオル      300    120    114     18     48      30    発注 ⚠
バスマット      180     60     54     42     24      30    適正
```

**MUST — 在庫を自動更新しない理由**

P3 の `linenRecord` は「その客室から何枚回収したか」の観測値であり、以下が把握できない。

- リネン業者への引き渡し枚数
- 業者から納品された枚数
- 洗濯中に廃棄された枚数
- 施設間で融通した枚数

したがって在庫の正は**棚卸（§2.5）**とし、`linenRecord` は「日次消費量の推定」にのみ使う。

```
推定予備枚数 = 前回棚卸の予備 - (棚卸後の累計回収 - 納品) 
※ あくまで推定値。画面に「推定」と明示する。
```

### 2.4 消耗品の在庫と発注点

消耗品は「定位置・適正数・発注点・最大在庫」の 4 要素で管理する。

```ts
export const supplyStock = sqliteTable("supply_stock", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  propertyId: text("property_id").notNull(),
  itemCode: text("item_code").notNull(),

  location: text("location").notNull(),         // "3Fパントリー" "中央倉庫"
  currentQty: integer("current_qty").notNull().default(0),
  targetQty: integer("target_qty").notNull().default(0),
  reorderPoint: integer("reorder_point").notNull().default(0),
  maxQty: integer("max_qty"),
  unitCost: integer("unit_cost"),               // 円

  dailyUsageAvg: real("daily_usage_avg"),       // P3 の observation から算出
  daysRemaining: integer("days_remaining"),     // 自動計算

  lastCountedOn: text("last_counted_on"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  uq: uniqueIndex("uq_supply").on(t.propertyId, t.itemCode, t.location),
  idxLow: index("idx_supply_low").on(t.organizationId, t.reorderPoint),
}));
```

**MUST**:
- `dailyUsageAvg` は P3 の `roomObservation.amenitiesUsed` から週次で算出する。手入力も可。
- `daysRemaining = currentQty / dailyUsageAvg` を表示し、7 日未満で警告する。
- 発注点を下回った品目を管理画面のトップに集約表示する。

### 2.5 棚卸

```ts
export const stockCount = sqliteTable("stock_count", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  propertyId: text("property_id").notNull(),
  countedOn: text("counted_on").notNull(),
  countType: text("count_type").notNull(),      // LINEN | SUPPLY | BOTH
  status: text("status").notNull(),             // DRAFT | CONFIRMED
  countedById: text("counted_by_id").notNull(),
  confirmedById: text("confirmed_by_id"),
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const stockCountLine = sqliteTable("stock_count_line", {
  id: text("id").primaryKey(),
  stockCountId: text("stock_count_id").notNull(),
  itemCode: text("item_code").notNull(),
  location: text("location"),
  systemQty: integer("system_qty").notNull(),   // 棚卸前のシステム値
  countedQty: integer("counted_qty").notNull(), // 実測値
  diffQty: integer("diff_qty").notNull(),
  reason: text("reason"),                       // 差異の理由
}, (t) => ({
  uq: uniqueIndex("uq_count_line").on(t.stockCountId, t.itemCode, t.location),
}));
```

**MUST**:
- 棚卸は `DRAFT` で作成し、`CONFIRMED` で在庫に反映する。
- 差異が `systemQty` の 20% を超える品目には理由入力を必須にする。
- 確定した棚卸は編集できない。訂正は新しい棚卸で行う。
- モバイルから入力できること。パントリーで数えながら入力する。

### 2.6 発注

```ts
export const purchaseOrder = sqliteTable("purchase_order", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  propertyId: text("property_id"),
  supplierId: text("supplier_id"),
  documentNo: text("document_no").notNull(),    // PO-2026-0012
  status: text("status").notNull(),
  // DRAFT | APPROVED | ORDERED | PARTIALLY_RECEIVED | RECEIVED | CANCELLED
  orderedOn: text("ordered_on"),
  expectedOn: text("expected_on"),
  receivedOn: text("received_on"),
  totalAmount: integer("total_amount"),
  approvedById: text("approved_by_id"),
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
```

**MUST**:
- 発注点を下回った品目から発注案を自動生成するが、**自動送信しない。** 必ず `ORG_ADMIN` の承認を経る。
- 納品時は分納に対応する。
- 発注番号は `DocumentSequencer`（P0 §19.9）を使う。`PO` を `DocType` に追加する。
- 発注書 PDF は P5 のテンプレート機構を流用する。

---

## 3. 権限

| 操作 | OWNER | ORG_ADMIN | P_MANAGER | INSPECTOR | CLEANER | VENDOR_ADMIN |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| スタッフ台帳の閲覧 | ○ | ○ | △ | × | 自分のみ | ○ |
| 単価の閲覧 | ○ | ○ | × | × | × | ○ |
| 在留資格の閲覧 | ○ | ○ | 件数のみ | × | 自分のみ | **×** |
| 在留資格の編集 | **×** | ○ | × | × | × | **×** |
| シフト作成 | ○ | ○ | ○ | × | × | ○ |
| シフト閲覧 | ○ | ○ | ○ | 自分のみ | 自分のみ | ○ |
| 打刻 | — | — | ○ | ○ | ○ | — |
| 打刻の修正 | ○ | ○ | ○ | × | × | ○ |
| 在庫の閲覧 | ○ | ○ | ○ | ○ | × | ○ |
| 棚卸の入力 | ○ | ○ | ○ | ○ | × | ○ |
| 棚卸の確定 | ○ | ○ | ○ | × | × | ○ |
| 発注の承認 | ○ | ○ | × | × | × | ○ |

△ = 担当施設のスタッフのみ、かつ単価と在留資格を除く。

**在留資格の行は v1.1 で版上げした**（2026-08-22 / DECISIONS #261）。

- `VENDOR_ADMIN` を `○` → **`×`**。受託先の従業員は自組織の従業員ではなく、
  在留期限の管理義務も負わない。清掃会社が自社スタッフを見る場合、その人は
  その組織の `OWNER` / `ORG_ADMIN` として入る。
- 編集の `OWNER` を `○` → **`×`**。閲覧だけを広げ、記録の書き換えは
  運営管理者に集める（INV-08 v2 は「閲覧」だけを定める）。
- `CLEANER 自分のみ` は**実装が追いついていない**（現在は `DENY`）。
  本人が自分の在留資格を見る経路は M-11 の課題として `docs/tasks/P8-12.md` に起票。

---

## 4. 受け入れ基準

### 4.1 Workforce

- [ ] スタッフ台帳に住所・生年月日・マイナンバー・口座のカラムが存在しない
- [ ] `hourlyRate` が `PROPERTY_MANAGER` に見えない
- [ ] 在留資格の期限アラートが 90/60/30 日で段階的に発火する
- [ ] 期限切れで新規タスク配分が停止する
- [ ] 期限切れでも既存の未完了タスクが残る
- [ ] 手動での停止解除ボタンが存在しない
- [ ] 在留資格の種類から就労可否を判定していない
- [ ] 免責文が編集できない
- [ ] `residencyRecord` が `PROPERTY_MANAGER` に見えない（件数のみ）
- [ ] 前週シフトの複製ができる
- [ ] 必要人数がタスク総標準時間から算出される
- [ ] シフト未登録でも自動配分が動作する
- [ ] 打刻せずにタスクを開始できる（警告も出ない）
- [ ] GPS を取得していない
- [ ] 打刻修正が理由付きで `AuditLog` に残る
- [ ] 個人を序列化する指標が出力されない
- [ ] スキル未対応の作業が自動配分されない
- [ ] 研修未修了者が必須検査対象になる

### 4.2 Inventory

- [ ] `linenRecord` が在庫を自動更新していない
- [ ] 推定値に「推定」と明示されている
- [ ] 発注点を下回った品目がトップに集約表示される
- [ ] `daysRemaining` が 7 日未満で警告が出る
- [ ] 棚卸が `DRAFT` → `CONFIRMED` の 2 段階
- [ ] 差異 20% 超で理由入力が必須
- [ ] 確定した棚卸が編集できない
- [ ] モバイルから棚卸を入力できる
- [ ] 発注が自動送信されない
- [ ] 発注番号が `DocumentSequencer` 経由で採番される
- [ ] 分納に対応している

---

## 5. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| 労務管理システムと誤解される | 法務リスク | 「法定記録ではない」を明示。給与計算を作らない |
| 在留資格の判定を任されてしまう | 重大な法務リスク | 期限通知に限定。免責文を編集不可で固定 |
| 在庫が実態と合わなくなる | 機能不信 | 棚卸を正とし、自動更新しない。推定と明示 |
| 自動発注で過剰在庫 | 顧客の損失 | 自動送信しない。必ず承認を経る |
| 打刻を強制して現場が止まる | 定着失敗 | 打刻なしでもタスク開始可。警告も出さない |
| スタッフ個人情報の過剰保持 | 漏洩リスク | 表示名のみ。住所・生年月日等を保存しない |
| コア機能より先に着手 | 工数の浪費 | GA 判定通過を着手条件とする（§0.1） |

---

## 6. 未決事項

1. 打刻を勤怠システムへ連携する需要があるか。ジョブカン等との CSV 連携で足りるか。
2. リネン業者への発注を Inventory から直接行うか、CSV 出力に留めるか。
3. 施設間のリネン融通を記録する必要があるか。清掃会社が複数施設を受託している場合に発生する。
4. 在留資格の種類マスタを制度改正に合わせて更新する運用を誰が持つか。
5. スキルを何段階で持つか。現状は「対応可否」の2値だが、「習熟度」を求められる可能性。

---

## 7. Claude Code 作業指示

```markdown
# ProofKeeping — Phase 8

## 前提
- 仕様の唯一の正は docs/PK-SPEC-P8.md（v1.0）。
- **P7-17 の GA 判定を通過していること。** 未通過なら着手しない。
- Workforce → Inventory の順に実装する。同時に進めない。

## 実装順序
### Workforce（GA後3か月）
1. §1.3 staffProfile
2. §1.4 residencyRecord とアラートバッチ
3. §1.5 shiftPlan と週間シフト画面
4. §1.7 スキル連携（P1-14 の自動配分へ反映）
5. §1.6 attendance（最後。優先度が最も低い）

### Inventory（GA後6か月）
6. §2.3 linenStock
7. §2.4 supplyStock と発注点アラート
8. §2.5 stockCount（モバイル対応）
9. §2.6 purchaseOrder

## P8 固有の絶対ルール
- 給与計算・社会保険・年末調整を実装しない。
- スタッフの住所・生年月日・マイナンバー・口座情報のカラムを作らない。
- 在留資格の種類から就労可否を自動判定しない。期限通知のみ。
- 在留資格の免責文を編集可能にしない。
- 期限切れの停止を手動解除できる実装にしない（expiresOn 更新のみ）。
- 打刻を必須にしない。打刻なしでのタスク開始を妨げない。
- GPS を取得しない。
- linenRecord から在庫を自動更新しない。
- 自動発注・自動送信を実装しない。
- 確定した棚卸を編集できる実装にしない。
- 個人を序列化する指標を出力しない（P2 §1.3 を継承）。

## テスト必須
- 在留資格アラートの 90/60/30/0 日境界
- 期限切れ時の配分停止と既存タスクの保持
- シフト未登録時の自動配分フォールバック
- 棚卸の差異 20% 超での理由必須
- DocumentSequencer での PO 採番（500 並列）
- 全新規テーブルのテナント越境
- 権限マトリクス §3 の全セル
```

---

## 8. 改訂履歴

| バージョン | 日付 | 変更内容 |
|---|---|---|
| v1.0 | 2026-08-10 | 初版確定。Workforce（スタッフ台帳・在留資格・シフト・打刻・スキル）と Inventory（リネン4セット・消耗品・棚卸・発注）を定義 |
| v1.1 | 2026-08-22 | §3 の在留資格の行を版上げ。`VENDOR_ADMIN` を `○` → `×`（受託先の従業員は自組織の従業員ではない）、編集の `OWNER` を `○` → `×`（閲覧だけを広げる）。INV-08 v2 との整合（DECISIONS #261 / OPEN_QUESTIONS #110 決着） |
| v1.2 | 2026-08-22 | §1.4 に**保存期間**を追加。「在留資格の記録は、従業員の退職日から 3 年が経過した時点で物理削除する」（オーナー判断 / P8-11 / DECISIONS #266）。起算・除外条件・監査ログに値を載せない旨・設定不可を明記 |
| v1.3 | 2026-08-22 | §1.4 の保存期間を hotfix（DECISIONS #268）。削除の境界を**満了日の翌日以降**へ（民法 140 条・143 条 2 項）。**暦として存在しない退職日は削除対象にしない**。**DELETE と監査ログを同じ D1 `batch()` で原子的に**実行し、監査ログの件数は**DB に実在した行数**（候補数ではない）とする旨を明記 |
