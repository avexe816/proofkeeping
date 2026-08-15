# テストルール

すべての PR でこれを読む。

## 1. PR の必須条件

```bash
pnpm check   # lint + typecheck + test
```
これが通らない PR は出さない。

CI の必須ジョブは **3 本**。**3 本とも並列**で走る。

| ジョブ | 中で走る検査（この順） |
|---|---|
| `lint-typecheck` | `lint`（ESLint カスタムルール含む）→ `typecheck`（tsc --noEmit） |
| `test` | 禁止語の grep 2 種 → `migrate`（未適用マイグレーションの検出）→ `gitleaks`（秘密情報）→ `test:isolation`（テナント越境）→ `test`（Vitest） |
| `build-e2e` | `build` → `e2e`（Playwright、preview 環境）→ preview デプロイ（PR のみ） |

**検査の中身は 9 ジョブだった頃と同じ。** まとめたのは、private リポジトリで
Actions の無料枠が尽き、**1 本ごとの checkout + pnpm install に分の大半を
食われていた**ため（2026-08-15 / DECISIONS #185）。

**ジョブ内は速い検査を先に置く。** 禁止語で落ちるのに Vitest の 2 分を
待たされる形にしない。**3 本の間に `needs:` を書かない**（直列にすると
壁時計が 3 倍になり、分も増える）。

## 2. テナント越境テスト（最重要）

全テーブルについて 4 パターンを用意する。

```ts
// tests/tenant-isolation/{table}.spec.ts
describe("tenant isolation: {table}", () => {
  it("別組織の ID を指定すると 404", async () => {});
  it("別組織のレコードが一覧に混入しない", async () => {});
  it("同一シャードに同居する組織のデータが漏れない", async () => {});
  it("施設スコープロールが担当外施設を取得できない", async () => {});
});
```

**第 3 のテストは必ず「同一シャードに落ちる組織ペア」で行う。**
異なるシャードでは物理的に到達不能なため、テストとして意味を持たない。

```ts
// tests/fixtures/shard-pairs.ts
export const SAME_SHARD_ORG_PAIR = {
  a: "org_testA_shard07",
  b: "org_testB_shard07",
} as const;
```

## 3. 純粋関数のテスト

`packages/engine` と `packages/billing` は DB・fetch・環境変数に依存しない。
**すべてのルール・計算に正例と負例を最低 5 件ずつ。**

## 4. 冪等性テスト

以下は「3 回実行しても結果が変わらない」ことを必ず検証する。

- タスク自動生成 / 稼働照合バッチ / CSV 取込
- Queue コンシューマ全般 / rollup 更新
- オフラインキューの再送 / 帳票の発行（Idempotency-Key）

## 5. 並列テスト

- `DocumentSequencer` で 500 並列採番 → 欠番・重複ゼロ
- `InspectionLock` で同時検査開始 → 1 件のみ成功

## 6. 実機テスト（自動化不可・人間が行う）

- iPhone SE（小画面）で破綻しない
- iPhone 14 Safari で全操作可能
- Android Chrome で全操作可能
- 手袋着用で全ボタンがタップできる
- 屋外の明るい場所で画面が読める
- 機内モードで一連の操作 → 復帰後に自動送信

## 7. カバレッジ目標

| 対象 | 目標 |
|---|---|
| `packages/engine` | 95% |
| `packages/billing` | 95% |
| `packages/db/repositories` | 90% |
| API ハンドラ | 80% |
| UI コンポーネント | 60% |
