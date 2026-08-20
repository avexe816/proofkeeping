# セッションの自走ルール

人間の往復を最小にするため、以下は確認を求めずに自分で進めてよい。
逆に「停止条件」に当たったときは必ず止まる。

---

## 1. セッション開始時に必ずやること

```bash
git fetch origin && git checkout main && git pull
git log --oneline -3
grep -c '\[x\]' docs/PROGRESS.md
```

**CONTINUE.md がリポジリルートにある場合は、それを最初に読む。**
内容に従って即座に実装を開始する。報告は不要。

CONTINUE.md が無い場合は通常どおり PROGRESS.md から次の task を決める。

報告フォーマット:

```
main HEAD: <sha> <件名>
完了済: N task
今回やる: P1-07 〜 P1-13（Batch 2: モバイル UI）
```

古い main のスナップショットで作業を始めない。
`git log` の先頭 sha が origin/main と一致しない場合は必ず pull し直す。

---

## 2. 次にやる task の決め方

`docs/PROGRESS.md` の未チェック項目のうち、**依存が満たされている最小番号**の
task を選ぶ。各 task の依存は `docs/tasks/P*-NN.md` の `**依存**:` 行にある。

`（人間が実施）` と書かれた task は自分では実装しない。
その task に到達したら、人間に何をすればよいかを伝えて止まる。
ただし、その task の次に依存されていない task があれば、飛ばして続けてよい。
（例: P4-08 が人間待ち → P4-09 以降に進んでよい）

### task を飛ばす条件

- `（人間が実施）` の task → 飛ばして次へ
- Cloudflare リソース作成が必要で、コード上は binding 宣言だけ → 飛ばして次へ
- 外部 API の接続情報が必要 → 飛ばして次へ

飛ばした task は PROGRESS.md に `⏳ 人間待ち` と書く。

---

## 3. バッチ実行

同じ性質の task をまとめて実装し、**1 バッチ = 1 PR** にする。

| 条件 | 上限 |
|---|---|
| 1 バッチの task 数 | 20 task（Claude Max）|
| 依存関係 | バッチ内で完結するか、既にマージ済であること |
| 差分 | 制限なし。drizzle-kit 生成物を含む |

バッチをまたぐ依存がある場合は分割する。
差分が 800 行を超えてもよい。理由を PR 本文に書けばよい。

### バッチのまとめ方

同じ Phase 内の連続する task をできるだけ多くまとめる。
分割するのは以下の場合のみ:

- 依存が前のバッチにまたがる（例: P5-07 が P5-04 に依存 → 同じバッチに入れる）
- context が 60% に近い

**1 バッチで 1 Phase を完走することを目標にする。**
Phase 全体が context に収まるなら、分割しない。

---

## 4. PR の作成とマージ

**PR 作成 → CI 確認 → マージまでを毎回自分で回す**（人間の指示 2026-08-20
「これからずっと自動的に PR → CI → merge」）。人間の確認を待つのは
下の「自動マージの対象外」に当たるときだけ。

実装完了・`pnpm check` 通過後、**自分で PR を作成する**。

```bash
gh pr create --base main --title "<Phase>-<NN>〜<NN> <日本語の要約>" --body "..."
```

本文は `.github/pull_request_template.md` に従う。

### `gh` が無い環境（Claude Code on the web / 2026-08-20）

**web セッションのコンテナに `gh` は入っていない。** 以下の `gh` コマンドは
そのままでは動かないので、**GitHub MCP ツール**（`mcp__github__*`）か
`curl` ＋ `$GITHUB_TOKEN` に読み替える。やることは同じ。

| したいこと | 代わりに使うもの |
|---|---|
| PR を作る | `mcp__github__create_pull_request` |
| CI を見る | `mcp__github__pull_request_read`（`get_check_runs`）または `curl .../commits/<sha>/check-runs` |
| マージする | `mcp__github__merge_pull_request`（`merge_method: "squash"`） |
| ログを読む | `mcp__github__get_job_logs`（`failed_only: true`） |

**ポーリングは前景の `sleep` でやらない**（ハーネスが拒否する）。
`run_in_background: true` の bash で `for` ループを回し、完了通知を待つ。

**ブランチの削除は 403 になることがある。** web セッションのトークンは
`git/refs` の DELETE を持たないことがあり、`git push origin --delete` も
落ちる。**その場合は残したまま次へ進んでよい**（同じブランチ名で続ける
指示が出ている場合はむしろ好都合。main から `git checkout -B` で作り直す）。

### CI が現れないときは、まず衝突を疑う

**衝突している PR では Actions が起動しない。** `pull_request` の
ワークフローは `refs/pull/<N>/merge`（main と head を合成したコミット）を
checkout するが、**衝突しているとその ref が作れない**ため、
ワークフロー実行そのものが作られない。PR は開けるので、
「CI が永遠に来ない PR」に見える（2026-08-20 / PR #131 で観測。
作成から 45 分 `github-actions` の check-suite が現れず、
`mergeable_state` は `dirty` だった。main を取り込んだ push で即座に走った）。

CI が 5 分待っても現れないときは、この順に確かめる。

1. `pulls/<N>` の **`mergeable_state`**。`dirty` なら衝突。
   §「マージ」の前に main を取り込んで解消する（それが push になり CI も走る）。
2. `commits/<sha>/check-suites` に **`github-actions` のスイートがあるか。**
   無ければ起動していない。`claude` のスイートは CI ではない。

**空コミットで CI を蹴らないこと。** 走らせるために要るのは実際の変更で、
衝突の解消がそれに当たる。押し出す変更が無いのに走らないときは、
止まって人間に報告する。

**並行セッションがいるので衝突は普通に起きる。** PR を作る直前に
`git fetch origin main` して、遅れていたら取り込んでから作ると 1 往復減る。

### CI の監視

PR 作成後、CI の結果を自分で確認する。

**webhook trigger や PR イベントの購読を作成しないこと。**
代わりに `gh pr checks --watch` でポーリングする。
trigger を作ると merge 後の削除で人間に確認ダイアログが出る。

```bash
gh pr checks <PR番号> --watch
```

- **CI が緑** → 次項「マージ」へ進む
- **CI が赤で、原因が自分の変更** → 自分で直して push し、再度確認する
- **CI が赤で、原因が自分の変更以外**（main が元から赤い等）→ 止まって報告する

同じ失敗を 3 回直せなかったら止まる。無限に試さない。

### マージ

CI 9 ジョブすべてが緑、かつ `mergeable: MERGEABLE` のとき、
**自分で squash マージしてブランチを削除する。**
人間の確認を待たない。

```bash
gh pr merge <PR番号> --squash --delete-branch
```

#### ブランチの削除に失敗したとき

`--delete-branch` が落ちても、**まず消えたかどうかを確かめる。**
`git push origin --delete` 系はブランチを消したあとに
`remote end hung up unexpectedly` を返すことがあり、
**失敗に見えて実際は成功している。** 見ずに再試行すると、
「消せなかった」と誤って報告することになる。

```bash
git ls-remote --heads origin <branch-name>   # 出力が空なら消えている
```

本当に残っていたら、API を直接叩く。**順に試す:**

```bash
# 1. gh がある場合:
gh api -X DELETE "repos/avexe816/proofkeeping/git/refs/heads/<branch-name>"

# 2. gh が無い場合: curl で GitHub API を叩く
curl -s -X DELETE \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/avexe816/proofkeeping/git/refs/heads/<branch-name>"
```

両方ダメなら PR 本文に「ブランチ削除失敗: <branch-name>」と書いて続ける。
**他人のブランチ・他の作業中のブランチを消さない。** 消してよいのは
自分がマージし終えた PR の head だけ。

マージ後に main の CI を確認する。

```bash
git checkout main && git pull
gh run list --branch main --limit 1
```

main が赤くなったら、その場で直して PR を出す。放置しない。

### 自動マージの対象外（人間の確認が必要）

以下のときだけ PR を作って止まり、**「マージ待ちです」**と伝える。

- 破壊的スキーマ変更（列削除・型変更）を含む
- 課金が発生する変更（有料プランへのアップグレード等）
- 仕様書どうしが矛盾しており、どちらが正か判断できない

以下は**自動マージしてよい**（PR 本文に記録すればよい）:

- DECISIONS.md への追記
- OPEN_QUESTIONS への新規項目
- 「止まらずに判断したこと」
- 仕様書の軽微な修正（誤字・番号ズレ・矛盾の解消）
- 既存 task の未達項目を閉じる変更

---

## 5. バッチ完了後

マージまで終わったら、次のバッチに**そのまま続けてよい**。
ただし以下のときはセッションを区切って報告する。

- context が 60% を超えた
- 「人間が実施」の task に到達した

**Phase の区切りで止まらないこと。** 依存が満たされていれば
次 Phase へそのまま入ってよい（例: P4 完了 → P5 へ継続）。

区切るときは `docs/PROGRESS.md` を更新してから止まる。

### セッション終了時の引き継ぎファイル

context 60% または時間制限に達したら、**必ず** `CONTINUE.md` を
リポジトリルートに書いて push してから止まる。

```markdown
# CONTINUE

## 最終状態
- main HEAD: <sha>
- 完了: P2-01〜P2-10
- 次: P2-11（検査の差戻しループ）

## 次にやること
1. git fetch origin && git checkout main && git pull
2. docs/tasks/P2-11.md を読む
3. 依存を確認して実装開始

## 申し送り
- OPEN_QUESTIONS #045: ...
- DECISIONS #060: ...
```

新規セッションは**最初に `CONTINUE.md` を読むこと**から始める。
ファイルが存在すれば、内容に従って即座に実装を開始する。
「続けて」と言われた場合も同様。

---

## 6. 停止条件（必ず止まって人間に聞く）

| 状況 | 例 |
|---|---|
| **セッション時間制限が近い** | 残り 30 分を切ったら、CONTINUE.md を書いて push して止まる。続きは新規セッションで。自動的に新規セッションを開始しない。人間の指示があるまで待つ |
| 仕様書に根拠がない設計選択 | ハッシュ関数の選定、状態の追加 |
| 仕様書どうしの矛盾で、どちらが正か判断できない | PK-SPEC と PK-IMPL-CONTRACT が矛盾し、根拠が無い |
| CI が赤で原因が自分の変更以外 | main が元から赤い |
| 同じ CI 失敗を 3 回直せない | |
| 人間の操作が必要 | Cloudflare リソース作成、実機テスト |
| context 60% 超過 | |
| 課金が発生する操作 | 有料プランへの変更、外部 API 契約 |

止まるときは以下を書く。

```
## 判断が必要です
- 何を決める必要があるか
- 選択肢と、それぞれの影響
- 自分の推奨と理由
```

---

## 7. 止まらなくてよいこと

- 実装方針の選択（仕様書に根拠がある場合）
- テストの書き方・粒度
- ファイル分割・命名
- 差分が 800 行を超えること
- リファクタリング（挙動を変えない範囲）
- `docs/PROGRESS.md` のチェック更新
- CI の自分の変更に起因する失敗の修正

---

## 8. 判断を記録する

止まらずに判断したことは、必ず以下に残す。

| 内容 | 記録先 |
|---|---|
| 未解決の問い | `docs/OPEN_QUESTIONS.md` |
| 決定した設計判断 | `docs/DECISIONS.md` |
| task の進捗 | `docs/PROGRESS.md` |

PR 本文に「## 止まらずに判断したこと」の節を設け、
番号を引用して要約する。人間はここだけ読めば追える状態にする。
