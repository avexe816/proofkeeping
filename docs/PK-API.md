# ProofKeeping 公開 API

> 対象: PK-SPEC-P6 §6 / task P6-15
> 版: v1.0（2026-08-15）

顧客のシステムから ProofKeeping へ稼働記録・物理信号を入れ、清掃タスクや
差異レポートを読むための API です。**この 1 ファイルだけで接続できること**を
目標にしています（§0.2 の出荷判定「顧客が自力で接続できる」）。

---

## 1. 使いはじめる

### 1.1 キーを発行する

ProofKeeping の管理画面にオーナーまたは運営管理者でログインし、
API キーを発行します。

```
POST /api/v1/api-keys
Content-Type: application/json

{
  "name": "自社 PMS からの連携",
  "scopes": ["occupancy:write", "tasks:read"],
  "propertyIds": null,
  "expiresAt": null
}
```

応答（**201。`token` はこの 1 回しか返りません**）:

```json
{
  "apiKeyId": "o7k2m9__akey_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
  "name": "自社 PMS からの連携",
  "keyPrefix": "pk_live_o7k2m9",
  "scopes": ["occupancy:write", "tasks:read"],
  "propertyIds": null,
  "expiresAt": null,
  "token": "pk_live_o7k2m9_7QK3XZ2M9P4VYR6ABCDEFG"
}
```

> **`token` を控えてください。** 再表示する API も画面もありません。
> 紛失したら失効させて作り直します。仕様上の要求です（§6.1 MUST）。

`propertyIds` は 3 通りの意味があります。**取り違えないでください。**

| 値 | 意味 |
|---|---|
| `null` | 組織のすべての施設 |
| `["o7k2m9__prop_..."]` | その施設だけ |
| `[]` | **1 件も見えない**（実質、無効なキー） |

### 1.2 リクエストに付ける

```
Authorization: Bearer pk_live_o7k2m9_7QK3XZ2M9P4VYR6ABCDEFG
```

`Bearer` 以外の方式は受け付けません。

### 1.3 失効させる

```
DELETE /api/v1/api-keys/{apiKeyId}
```

失効したキーは即座に使えなくなります。**行は消えません**（誰がいつ作って
いつ失効させたかが監査ログと合わせて残ります）。

---

## 2. スコープ

キーに与えたスコープの範囲でだけ呼べます。**足りないと 403** です。

| スコープ | できること |
|---|---|
| `occupancy:write` | 稼働記録の投入と参照 |
| `signals:write` | 物理信号の投入 |
| `tasks:read` | 清掃タスクと客室の参照 |
| `findings:read` | 差異レポートの参照 |
| `reports:read` | 日報の参照 |
| `invoices:read` | 請求書の参照 |
| `webhooks:manage` | 送信 Webhook 設定の管理 |

**ワイルドカード（`occupancy:*` など）はありません。** 完全一致だけです。
スコープが増えても、既存のキーの権限は広がりません。

---

## 3. エンドポイント

すべて `https://<あなたの ProofKeeping>/api/v1/public` の下です。

### 3.1 客室の一覧 — `GET /rooms`

**ここから始めてください。** 以降の投入で使う `roomId` を配ります。

```
GET /public/rooms?propertyId=o7k2m9__prop_...
```

```json
{
  "data": [
    {
      "roomId": "o7k2m9__room_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
      "propertyId": "o7k2m9__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
      "roomNumber": "302",
      "roomTypeId": "o7k2m9__rtyp_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
      "isSellable": true
    }
  ]
}
```

必要スコープ: `tasks:read`

> **公開 API は ProofKeeping の ID で客室を指します。** そちらの部屋番号を
> そのまま送る口ではありません。番号での対応付けが必要な場合は、
> 汎用 Webhook（§5）とマッピング設定を使ってください。

### 3.2 稼働記録の投入 — `POST /occupancy/snapshots`

```json
{
  "propertyId": "o7k2m9__prop_...",
  "businessDate": "2026-09-09",
  "entries": [
    {
      "roomId": "o7k2m9__room_...",
      "isOccupied": true,
      "guestCount": 2,
      "adultCount": 2,
      "childCount": 0,
      "reservationRef": "RSV-8891",
      "channelCode": "OTA",
      "checkInAt": "2026-09-09T15:10:00+09:00",
      "checkOutAt": null,
      "isStayover": false,
      "nightsTotal": 2,
      "nightIndex": 1,
      "isComplimentary": false,
      "isHouseUse": false
    }
  ]
}
```

応答:

```json
{
  "businessDate": "2026-09-09",
  "source": "PMS_API",
  "inserted": 1,
  "updated": 0,
  "unchanged": 0
}
```

必要スコープ: `occupancy:write` ／ 上限 60 req/分

**同じ業務日へ入れ直すと上書きされます。** 差分は監査ログに残ります。

> **宿泊者の氏名・連絡先・住所・パスポート番号・カード情報を送らないでください。**
> 受け取る欄がありません。ProofKeeping はそれらを一切保存しません。
> 照合に必要なのは人数と予約参照番号だけです。

`businessDate` は施設の日締め時刻（既定 05:00 Asia/Tokyo）を基準にした
業務日です。カレンダー日ではありません。

### 3.3 物理信号の投入 — `POST /signals`

スマートロックの解錠などを入れます。

```json
{
  "events": [
    {
      "roomId": "o7k2m9__room_...",
      "type": "DOOR_UNLOCK",
      "occurredAt": "2026-09-09T22:14:33+09:00",
      "actorType": "GUEST_KEY",
      "actorRef": "card-8891",
      "deviceId": "LOCK-302"
    }
  ]
}
```

```json
{ "received": 1, "applied": 1, "duplicate": 0, "skipped": 0 }
```

必要スコープ: `signals:write` ／ 上限 300 req/分

- `type`: `DOOR_UNLOCK` / `DOOR_OPEN` / `KEY_ISSUE` / `POWER_ON` / `WIFI_JOIN` /
  `SELF_CHECKIN` / `SAFE_USE` / `MINIBAR_SENSOR`
- `actorType`: `GUEST_KEY` / `STAFF_KEY` / `MASTER_KEY` / `MOBILE_KEY` / `UNKNOWN`

> **`actorType` が分からないときは省いてください。** 推測して
> `GUEST_KEY` を入れないでください。省かれた場合は「取得できていない」
> として扱い、照合の確信度を下げます。埋めてしまうと、その区別が失われます。

同じ `(deviceId, type, occurredAt)` は重複として弾かれます。
**同じ本文を 3 回送っても記録は増えません。**

`roomId` が分からない、または対象外の施設の場合は `skipped` に数えます。
**エラーにはなりません。**

### 3.4 清掃タスクの参照 — `GET /tasks`

```
GET /public/tasks?propertyId=...&businessDate=2026-09-09&limit=100
```

```json
{
  "data": [
    {
      "taskId": "o7k2m9__task_...",
      "propertyId": "o7k2m9__prop_...",
      "roomId": "o7k2m9__room_...",
      "businessDate": "2026-09-09",
      "taskType": "CHECKOUT",
      "status": "COMPLETED",
      "startedAt": "2026-09-09T10:00:00.000Z",
      "completedAt": "2026-09-09T10:40:00.000Z"
    }
  ]
}
```

必要スコープ: `tasks:read`

> **担当者は返しません。** 誰が何件やったかを外部から集計できる形にしない
> ためです。

### 3.5 差異レポートの参照 — `GET /findings`

```
GET /public/findings?propertyId=...&from=2026-09-01&to=2026-09-30
```

```json
{
  "data": [
    {
      "findingId": "o7k2m9__find_...",
      "propertyId": "o7k2m9__prop_...",
      "roomId": "o7k2m9__room_...",
      "businessDate": "2026-09-09",
      "ruleCode": "R002",
      "severity": "HIGH",
      "confidence": 70,
      "status": "OPEN",
      "title": "302 号室：施錠解除と稼働記録の不一致"
    }
  ]
}
```

必要スコープ: `findings:read`

> **これは不正の認定ではありません。** 3 系統の記録が食い違っている、という
> 事実だけを示します。`confidence` は根拠の強さで、100 でも断定ではありません。

### 3.6 日報の参照 — `GET /reports/daily`

```
GET /public/reports/daily?propertyId=...&from=2026-09-01&to=2026-09-30
```

必要スコープ: `reports:read`。PDF そのものは返しません（`reportId` で
管理画面から取得します）。

### 3.7 請求書の参照 — `GET /invoices`

必要スコープ: `invoices:read`。金額は**整数（円）**です。小数はありません。

### 3.8 稼働記録の参照 — `GET /occupancy`

```
GET /public/occupancy?propertyId=...&businessDate=2026-09-09
```

必要スコープ: `occupancy:write`（投入した値の確認用）。

---

## 4. エラーと制限

| 状態 | 意味 |
|---|---|
| `400 INVALID_REQUEST` | 本文またはクエリの形が違う |
| `401 UNAUTHORIZED` | キーが無い・形が違う・失効・期限切れ |
| `403 FORBIDDEN` | 認証は通ったがスコープが足りない |
| `404` | 対象が無い、またはキーの施設の範囲外 |
| `429 RATE_LIMITED` | 上限超過。`Retry-After`（秒）を見て待つ |

> **401 は理由を区別しません。** キーが存在しないのか失効したのかを
> 応答から読み取ることはできません。生きているキーを探索されないための
> 意図的な設計です。

**施設の範囲外は 404 です**（403 ではありません）。403 を返すと、その施設が
存在することを伝えてしまうためです。

### レート制限

| 対象 | 上限 |
|---|---|
| 公開 API 全般 | 600 req/分/キー |
| `POST /occupancy/snapshots` | 60 req/分/キー |
| `POST /signals` | 300 req/分/キー |

上限は**キーごと**です。窓は 1 分です。

---

## 5. 送信 Webhook（ProofKeeping → あなた）

ProofKeeping 側で起きたことを受け取れます。管理画面で URL と署名鍵を登録します。

配信されるイベント:

```
room.status_changed / task.completed / inspection.failed
issue.created / finding.created / invoice.issued
```

本文:

```json
{
  "eventId": "invoice.issued:o7k2m9__inv_...",
  "event": "invoice.issued",
  "occurredAt": "2026-09-10T02:00:00.000Z",
  "targetId": "o7k2m9__inv_...",
  "propertyId": null
}
```

**ID までしか載せません。** 詳細は `targetId` で上の API を引いてください。
そちらはスコープで守られています。

### 署名の検証

```
X-PK-Signature: sha256=<16 進>
X-PK-Timestamp: 1757462400
```

署名は **`HMAC-SHA256(secret, "{timestamp}.{生の本文}")` の 16 進**です。

```js
const expected = "sha256=" + hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
// 一致しなければ 401 を返してください。
```

**必ず検証してください。** また、`X-PK-Timestamp` が現在時刻から 5 分以上
ずれていたら拒否してください（リプレイ対策）。

### 再送

2xx 以外はすべて失敗として扱い、**1 分 → 5 分 → 30 分 → 2 時間 → 6 時間**の
順に最大 5 回再送します。**5 回失敗すると、その宛先への配信を止め**、
管理者へ通知します。再開は管理画面から行います。

- **3xx は成功に数えません。** リダイレクト先へ署名付きの本文を送らないためです。
- 再送では `eventId` と署名が変わりません。**受け取る側で `eventId` による
  重複排除を行ってください。**

---

## 6. スマートロックの汎用 Webhook（あなた → ProofKeeping）

API キーではなく署名で守られた、機器からの受信専用の口です。
ProofKeeping の `roomId` ではなく**機器の ID**で送れます（管理画面の
マッピング設定で客室に対応付けます）。

```
POST /api/v1/integrations/webhook/{integrationId}
X-PK-Signature: sha256=<16 進>
X-PK-Timestamp: 1757462400

{ "events": [ { "deviceId": "LOCK-302", "type": "DOOR_UNLOCK",
                "occurredAt": "2026-09-09T22:14:33+09:00" } ] }
```

署名の作り方は §5 と同じです。応答は `{"received": true}` で、**件数は
返しません**（処理は非同期のため）。結果は管理画面の同期ログで確認します。

対応付けのない機器 ID は**エラーにならず**スキップとして数えます。

---

## 7. よくある詰まりどころ

**Q. `token` を無くしました。**
再表示はできません。失効させて作り直してください。

**Q. 403 が返ります。**
キーのスコープを確認してください。認証は通っています。

**Q. 施設を絞ったキーで 404 が返ります。**
その施設がキーの `propertyIds` に入っていません。範囲外は 404 です。

**Q. `POST /signals` が `skipped` ばかりになります。**
`roomId` が ProofKeeping の ID になっているか確認してください。
そちらの部屋番号ではありません。`GET /rooms` で取れます。

**Q. 稼働記録を入れたのに差異が出ません。**
差異は夜間のバッチで判定します。手動実行は管理画面から行えます。
また、記録が 1 系統しかない日は判定できるルールが限られます。

**Q. 連携が止まっても清掃業務は動きますか。**
動きます。稼働記録が未取得という状態になるだけで、清掃タスクの生成・
検査・請求は止まりません。CSV からの取込もいつでも使えます。

---

## 8. 改訂履歴

| 版 | 日付 | 変更内容 |
|---|---|---|
| v1.0 | 2026-08-15 | 初版（P6-15） |
