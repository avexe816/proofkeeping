# メール送信（Lark Mail SMTP）

task: `docs/tasks/P5-21.md` / 決定: `docs/DECISIONS.md` #248

ProofKeeping のメールはすべて **Lark Mail の SMTP** で送る。
差出人は `ProofKeeping <noreply@stek.ai>` の 1 つだけ。

## 1. 設定の在り処

**秘密は `SMTP_PASSWORD` だけ。** それ以外は `apps/web/wrangler.toml` の
`[env.*.vars]` にあり、読めば向き先が分かる。

| 名前 | 種別 | 既定 |
|---|---|---|
| `SMTP_PASSWORD` | **secret** | `wrangler secret put SMTP_PASSWORD --env <env>` |
| `SMTP_HOST` | vars | `smtp.larksuite.com` |
| `SMTP_PORT` | vars | `465` |
| `SMTP_SECURE` | vars | `implicit`（465）。587 を使うときだけ `starttls` |
| `SMTP_USERNAME` | vars | `noreply@stek.ai` |
| `MAIL_FROM` | vars | `ProofKeeping <noreply@stek.ai>` |

**`SMTP_PASSWORD` が無ければ 1 通も送らない。** 環境名では分岐しないので、
鍵を置かないことが即座に「送らない」を意味する。

**25 番は使わない**（Cloudflare が塞いでいる）。

## 2. 疎通確認（**メールを送らない**）

Actions から `smtp-probe` を実行する。合言葉は `PROBE`。

```
environment: staging | production
confirm:     PROBE
```

確かめるのは接続・TLS・greeting・`EHLO`・`AUTH` の広告まで。
**`AUTH LOGIN` は実行しない**（失敗回数を Lark 側へ溜めない。
この経路は `SMTP_PASSWORD` を読まない）。

出るのは 5 つの真偽値と、失敗した段階名だけ。**ホスト名・利用者名・
サーバーの応答全文は出ない。**

| 失敗した段階 | 見るところ |
|---|---|
| `CONNECT` | **Cloudflare から 465 へ出られていない。** ここで止まったら送信の実装へ進まない |
| `TLS` | 465 で TLS が張れない。Lark 側で 465 が閉じている可能性 → `SMTP_SECURE=starttls` + `SMTP_PORT=587` を検討 |
| `EHLO` | 接続はできたが SMTP として応答しない。host を確かめる |
| `AUTH` | `AUTH` が広告されない。Lark の SMTP が有効か確かめる |

## 3. 送信経路の確認（**1 通だけ送る**）

`smtp-probe` で分かるのは `AUTH` が広告されているかまで。**認証が通るか・
受理されるかは、実際に 1 通送るまで分からない。**

**開通（`platform-bootstrap`）で試さないこと。** あちらは 1 人目専用で
押し直せない。認証が確かめられていない段階で使うと、失敗したときに券だけが
消える。確認は**押し直してよいこちら**で行う。

前提として `SMTP_PASSWORD` が対象環境に登録されていること（人が
`wrangler secret put` で入れる。**workflow は触らない**）。

Actions から `smtp-send-test` を実行する。合言葉は `SENDTEST`。

```
environment: staging | production
to:          確認メールの宛先（1 件だけ。自分が受け取れるアドレス）
confirm:     SENDTEST
```

送るのは**固定の日本語 1 通**（`lib/mail/sendTest.ts`）。リンクも token も
顧客のデータも入っていない。件名・本文は入力で変えられない。

出るのは 3 つだけ。**宛先も応答の全文も出ない。**

| 値 | 意味 |
|---|---|
| `accepted` | `true` なら Lark が `DATA` を受理した |
| `failedAt` | 失敗した段階（`DISABLED` / `MIME` / `CONNECT` … `DATA`） |
| `code` | SMTP の応答コード（3 桁）。読めなければ `none` |

| 失敗した段階 | 見るところ |
|---|---|
| `DISABLED` | **`SMTP_PASSWORD` が未登録。** 送信は試みていない |
| `MIME` | 宛先の形が壊れている（改行が混ざった等） |
| `CONNECT` / `TLS` | §2 の表と同じ |
| `AUTH`（535 等） | 認証が通らない。Lark の SMTP パスワードを確かめる |
| `MAIL_FROM`（550 等） | 差出人が拒否された。`MAIL_FROM` と `SMTP_USERNAME` の不一致を疑う |
| `RCPT_TO`（550 等） | 宛先が拒否された。宛先を確かめる |
| `DATA` | 受理されなかった。本文ではなく送信量の制限を疑う |

**`accepted: true` でも「届いた」とは限らない**（§4）。

宛先はログでは伏せる（`::add-mask::`）が、**`workflow_dispatch` の入力
そのものは GitHub が実行の記録に残す。** リポジトリを見られる人には
見えるので、**確認には運用者自身のアドレスを使う。**

## 4. 送信で分かること・分からないこと

SMTP で分かるのは **Lark が `DATA` を受理したか**まで。

| 状態 | 意味 |
|---|---|
| `SMTP_ACCEPTED` | Lark が受理した |
| `SMTP_REJECTED` | 受理されなかった（接続・認証・宛先・本文のいずれか） |
| `DELIVERY_UNCONFIRMED` | 最終配信・バウンス・開封は**未確認** |

**届いたかどうかは分からない。** `DELIVERED` / `BOUNCED` / `openedAt` は
webhook を戻す後続 task（`docs/tasks/P5-22.md` / OPEN_QUESTIONS #118）まで
立たない。**推測で埋めないこと。**

## 5. 実行後に残ってはいけないもの

```bash
cd apps/web
wrangler secret list --env <env> | grep -E 'SMTP_PROBE_TOKEN|SMTP_SEND_TEST_TOKEN'
```

workflow は `if: always()` で削除し、**名前が消えたことまで確かめて**
赤／緑を決める（DECISIONS #247）。runner が落ちた場合は残るので、
名前が出たら手で消して再デプロイする。

```bash
wrangler secret delete SMTP_PROBE_TOKEN --env <env>      # 疎通確認の鍵
wrangler secret delete SMTP_SEND_TEST_TOKEN --env <env>  # 送信確認の鍵
CLOUDFLARE_ENV=<env> pnpm build
wrangler deploy
```

**`--force` を付けないこと**（`wrangler secret delete` にその引数は無い）。

## 6. 出してはいけないもの

- **SMTP のパスワード** — 会話・コード・PR・ログのどこにも書かない
- **宛先・メール本文・開通リンク（token）** — ログにも監査ログにも出さない
- **SMTP サーバーの応答全文** — 拒否のとき宛先が echo される
  （`550 <someone@example.com> unknown mailbox`）

実装側は `lib/mail/*` が `console` を持たず、戻り値も成否・段階名・
3 桁コードまでに畳んである。走査は `tests/security/mailSecrets.spec.ts`。

## 7. 送れないときに確かめる順序

1. `SMTP_PASSWORD` が対象環境に登録されているか（`wrangler secret list` の**名前だけ**）
2. `smtp-probe` を実行して、どの段階で止まるかを見る
3. 通っていたら `smtp-send-test` を自分宛に実行し、`failedAt` と `code` を見る
4. Lark 側で `noreply@stek.ai` の SMTP が有効か、**外部ドメイン宛に送れるか**
5. `wrangler.toml` の `MAIL_FROM` と `SMTP_USERNAME` が一致しているか
   （Lark は差出人の詐称を拒否する）
