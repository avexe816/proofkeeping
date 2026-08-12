/**
 * `pnpm test:e2e` の実体。
 *
 * task:  docs/tasks/P0-19.md
 * ルール: .claude/rules/testing.md §1
 *
 * ── なぜ Playwright を入れていないのか ──────────────────
 * E2E は preview 環境に対して走らせる（testing.md §1「preview 環境」）。
 * その preview は **P0-02 が未完で存在しない。** 実在する Cloudflare
 * リソースは D1 の shard-00 だけで、KV も R2 も Queue も未作成のため、
 * デプロイした Worker はログイン画面すら開けない。
 *
 * **接続先の無いブラウザテストを書いても、書いた本人にも通らない。**
 * ここでは「E2E ジョブの席」だけを確保し、接続先が与えられたときに
 * 落ちる形にしてある。
 *
 * ── 挙動 ────────────────────────────────────────────────
 *   E2E_BASE_URL が無い   … 未実施と表示して 0 で抜ける（CI は緑）
 *   E2E_BASE_URL が有る   … シナリオが未実装なので 1 で落ちる
 *
 * 後者があるのは、**preview が用意できたのに気付かず素通しする**のを
 * 防ぐため。URL を渡した人は必ず「まだ書かれていない」と知る。
 */

const baseUrl = process.env["E2E_BASE_URL"];

if (baseUrl === undefined || baseUrl === "") {
  console.log("e2e: 未実施。E2E_BASE_URL が未設定（preview 環境は P0-02 の完了後）。");
  process.exit(0);
}

console.error(
  `e2e: 接続先 ${baseUrl} が指定されましたが、シナリオが 1 件もありません。\n` +
    "Playwright の導入とシナリオの追加を行ってください（docs/PROGRESS.md の申し送り）。",
);
process.exit(1);
