# ProofKeeping UI プロトタイプ索引

全 55 画面の HTML プロトタイプ。ブラウザで直接開いて操作できます（サーバ不要）。

**上位文書**

- `docs/PK-SPEC-UI.md` — 清掃員モバイル 16 画面の設計説明書
- `docs/PK-SPEC-UI-A01.md` — v3 レイアウト標準（PC 全画面に適用）
- `docs/PK-IMPL-CONTRACT.md` — 実装契約（不変条件 INV-01〜37・データ辞書・権限マトリクス）
- `docs/PK-BIZ-PLAN.md` — 版数構成（Base / Pro / Ent）と価格設計

## 読む順序

1. `pk-v3-layout-standard.html` — PC 画面の骨格。施設セレクタとユーザーメニューの位置を確認
2. `mobile/pk-01` 〜 `pk-16` — 現場の全フロー
3. `owner/` → `ops/` → `platform/` — 管理画面
4. `pk-plan-compare-base-pro.html` — Base / Pro の機能差

## 第1批 清掃員モバイル（16 画面・1 ファイル 1 画面）

`mobile/`

| # | ファイル | 画面 |
|---|---|---|
| 01 | `pk-01-pin-login.html` | ログイン（7言語切替を常設） |
| 02 | `pk-02-today-tasks.html` | 本日のタスク（施設グループ・5段カウンタ） |
| 03 | `pk-03-property-picker.html` | 施設選択（4施設以上の担当時） |
| 04 | `pk-04-property-change.html` | 施設変更の確認 |
| 05 | `pk-05-task-detail.html` | タスク詳細 |
| 06 | `pk-06-entry-record.html` | 入室時の記録（全アイコン・15秒） |
| 07 | `pk-07-detail-record.html` | 詳細記録（任意） |
| 08 | `pk-08-checklist.html` | チェックリスト（3値入力・📷必須表示） |
| 09 | `pk-09-photo.html` | 写真の撮影（GPS非保存を明示） |
| 10 | `pk-10-linen.html` | リネン記録 |
| 11 | `pk-11-completion.html` | 完了確認 |
| 12 | `pk-12-pause-block.html` | 中断と入室不可 |
| 13 | `pk-13-inspection.html` | 検査画面（結果入力まで担当者名を出さない） |
| 14 | `pk-14-personal-stats.html` | 個人実績（比較・順位なし） |
| 15 | `pk-15-language.html` | 言語と表示設定 |
| 16 | `pk-16-offline.html` | オフライン状態 |

## 第2批 ホテル・オーナー PC（12 画面・4 ファイル）

`owner/` — v3 レイアウト適用済み

| ファイル | 収録画面 |
|---|---|
| `pkown-v3-A-login-daily.html` | 01 ログイン / 02 ダッシュボード / 03 客室ボード |
| `pkown-v3-B-findings-records.html` | 04 稼働の差異 / 05 差異の詳細 / 06 清掃記録 |
| `pkown-v3-C-inspection-linen-report.html` | 07 検査・再清掃 / 08 リネン消費 / 09 月次レポート |
| `pkown-v3-D-billing-settings-perm.html` | 10 契約と請求 / 11 施設設定 / 12 権限と監査 |

## 第3批 清掃会社 PC（12 画面・3 ファイル）

`ops/`

| ファイル | 収録画面 |
|---|---|
| `pkops-A-daily-quality.html` | 01 ダッシュボード / 02 シフトと割当 / 03 進捗モニタ / 04 検査キュー |
| `pkops-B-records-staff.html` | 05 稼働の差異 / 06 清掃記録 / 07 スタッフ管理 / 08 研修と資格 |
| `pkops-C-materials-billing-config.html` | 09 リネン・備品 / 10 請求管理 / 11 施設・手順設定 / 12 権限と監査 |

## 第4批 プラットフォーム運営 PC（9 画面・3 ファイル）

`platform/`

| ファイル | 収録画面 |
|---|---|
| `pkplat-A-status-tenants.html` | 01 サービス稼働 / 02 テナント管理 / 03 利用状況 |
| `pkplat-B-p4-engine.html` | 04 ルール管理 / 05 精度モニタ / 06 検証と再学習 |
| `pkplat-C-support-announce.html` | 07 問い合わせ / 08 不具合と要望 / 09 お知らせ配信 |

**未収録**: 10 契約と収益 / 11 監査と法令 / 12 システム設定（`pkplat-D`）は未アップロード。内容は `docs/PK-BIZ-PLAN.md` と `docs/PK-IMPL-CONTRACT.md` 第 11 章で代替可能。

## 共通

| ファイル | 内容 |
|---|---|
| `pk-v3-layout-standard.html` | v3 レイアウト参照実装。topbar 58px / サイドバー 214px / 施設セレクタは topbar 左 |
| `pk-plan-compare-base-pro.html` | Base / Pro 比較（清掃会社ダッシュボードで対比） |
| `_tokens/base.json` | モバイル共通 CSS トークン |
| `_tokens/pc.json` | PC 共通 CSS トークン |

## `_archive/`

初期検討版。**実装の参照には使わないこと。**

| ファイル | 内容 |
|---|---|
| `pk-ui-templates-v1.html` | 5テンプレート比較（初期案） |
| `pk-ui-templates-v2.html` | 3ロール × 6言語（v3 以前） |
| `pk-ui-v3-property-switch.html` | 施設切替の初期検討版 |
| `prototype-1of4-mobile.html` | 第1批の統合版（個別16ファイルが正） |

## 実装時の注意

`docs/PK-IMPL-CONTRACT.md` 第 11 章「生成時のアンチパターン」を実装前に必ず読むこと。プロトタイプの見た目より、不変条件 INV-01〜37 が優先されます。
