# CONTINUE

## 最終状態
- main HEAD: `c8448ba` P6-01〜P6-04 外部連携の受信側 (#64)
- 完了: **Phase 0〜5 を完走**（P4-08 を除く）＋ **P6-01〜P6-04**。108 task
- 次: **P6-05（マッピングと W-23）**

## 次にやること
1. `git fetch origin && git checkout main && git pull`
2. `docs/tasks/P6-05.md` を読む
3. `docs/PK-SPEC-P6.md` §2.3 / §7.2 と、下の「P6-04 が置いたもの」を読む

## P6-04 が置いたもの（受信する側は通っている）

```
POST /api/v1/integrations/webhook/:integrationId   署名検証・200 即返し
  → QUEUE_RECONCILIATION（kind: "SIGNAL_INGEST"）
    → consumers/signalIngest.ts
      → resolveExternalIds() → physical_signal へ → sync_log
```

**`physical_signal` に初めて書き込む側が入った。** P4 は読むだけだった。

### 覚えておくこと

- **受信口は D1 を 1 度も引かない。** 署名鍵の KV 参照キーは `integrationId`
  （自己記述 ID）から組み立てられる（`credentialRefFor()`）。
  `lookupOrganizationId()` をリクエストハンドラから呼ばない規約を守るため。
  **この経路に DB 呼び出しを足さないこと**（route の spec が `d1Calls` を数えている）。
- **秘密は DB に列を持たない**（DECISIONS #138）。`webhookSecretRef` /
  `secretRef` は KV の参照キー。復号は `lib/integration/credentials.ts` だけ。
  リポジトリ層は KV を触らない。
- **未マッピングは失敗ではない**（§2.3 MUST）。`resolveExternalIds()` は
  引けなかった外部 ID を**落として返す**（例外を投げない）。呼び出し側が
  `recordsSkipped` に数える。全件が未マッピングでも `sync_log` は `PARTIAL`。
- **専用キューを作っていない**（DECISIONS #140）。`pk-reconciliation` に
  相乗りし、`kind` で分ける。8 本目を足すと 4 環境ぶんの Cloudflare リソース
  作成で人手を待つ。
- `packages/integrations` は**型とインターフェースだけ。** 実アダプタは
  P6-06 以降（実接続する PMS が確定してから / §3.2 MUST「想定で作らない」）。

## P6-05 に入る前に

P6-05 の完了条件は 2 つ。

- 部屋番号の自動マッピングができる
- 未マッピングがエラーにならず、可視化される

**リポジトリ関数は P6-04 で既に置いてある。** `upsertExternalMappings()` /
`listExternalMappings()` / `listMappedInternalIds()` /
`countUnmappedExternalIds()` / `deactivateExternalMapping()`。
P6-05 が足すのは**自動マッピングの規則**（§7.2 の「部屋番号が一致するものを
自動対応」）と **W-23 の画面**。

- `upsertExternalMappings()` は**既にある対応に触らない。** 手で直した対応
  （`305 ←→ 0305`）を自動マッピングの再実行が上書きしないため。
  「再実行しても行が増えない」はこれで成り立っている。
- 自動マッピングの照合規則（前ゼロを詰めるか、大文字小文字を無視するか）は
  仕様に無い。**決めたら DECISIONS に残すこと。**
- W-23 の見た目の正は `ui-prototypes/`。`ui-prototypes/README.md` で
  該当ファイルを確かめる。**`_archive/` を参照しない。**
- 画面を作るので `.claude/rules/ui-writing.md` を読む。JSX に日本語を
  直書きしない（`t("key")` 経由）。

## 申し送り

### 人間の作業
1. **`CREDENTIAL_ENCRYPTION_KEY` の設定**（`wrangler secret put`）。
   **32 バイトを base64url で。** 未設定だと資格情報の保存が
   `CREDENTIAL_ENCRYPTION_KEY_MISSING` で落ちる（弱い鍵で暗号化した気に
   ならないよう、黙って通さない設計）。
   生成例: `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`
2. `RESEND_WEBHOOK_SECRET` の設定。**未設定だと webhook は 401。**
3. **実機で 1 通送って Resend の webhook payload を確かめる**
   （OPEN_QUESTIONS #077）。タグとヘッダのどちらが返るか未確認。
4. 和文フォントの配置（P2-14 から継続）。無いと PDF が作られない。
5. **`pk-rollup-update` キューの作成**（4 環境）。宣言は `wrangler.toml` にある。

### P4 の積み残し（人間待ち）
- **P4-08 誤検知率の検証（人間が実施）。** P5 / P6 は技術的に依存しない。

### 未解決の問い（新しい順）
- #086 公開 API の Bearer トークンから組織を解決する手段が無い → 索引を
  `(organizationId, keyHash)` にして P6-12 へ委ねた
- #085 組織全体の連携が重複して作れる（NULL と UNIQUE）→ 列を足さず、
  作成する側で既存を引く方針。P6-14 で決める
- #084 請求状況は税込・施設別収支は税抜 → 見出しに明記。合計は一致しない
- #083 「受託施設」を判定する列（`orgType`）が無い → `VENDOR_PLAN` の契約で絞る
- #082 忘れ物・設備不具合・請求期間の PC 画面が無い → 件数だけでリンク無し
- #081 自社清掃の組織では清掃費用合計を出せない → `null` を返す
- #080 業務日 → タイムスタンプの窓を作る手段が無い → `openIssues` は現在値
- #079 「AGREED 必須の設定」に列が無い → 常に必須のまま
- #078 確認依頼（§6.1 の「ホテル側に通知」）を送る経路が無い → **送っていない**
- #077 Resend の webhook がタグとヘッダのどちらを返すか未確認 → 両方送る
- #076 入金（Payment）を置く表が無い → 全額入金のみ。一部入金は 409
- #002 最初に実接続する PMS（P6-06 の前提）→ **未確定。P6-06 は着手できない**
- #003 スマートロックの対象機種（P6-08）→ 汎用 Webhook で代替できている
- #075〜#063 は P5 以前（CONTINUE の履歴を参照）

### 直近の設計判断
- #140 物理シグナルの取込は `pk-reconciliation` に相乗りする
- #139 外部連携の 7 表に entityPrefix を足す
- #138 外部連携の秘密は DB に列を作らず、KV の参照キーだけを持つ
- #137 時間単価の 85% は組織平均（加重平均）との比。施設どうしを比べない
- #136 締めの金額は集計し直さず、合意の履歴に残る写しを読む
- #135 稼働スタッフは在籍者数で数え、実績から数えない
