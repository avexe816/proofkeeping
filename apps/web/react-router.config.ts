import type { Config } from "@react-router/dev/config";

/**
 * React Router（framework mode）の設定。
 *
 * task:  docs/tasks/P0-14.md
 * 決定:  docs/DECISIONS.md #026（UI フレームワーク）
 *
 * ── appDirectory を src にする理由 ──────────────────────
 * CLAUDE.md §3 がディレクトリを `apps/web/src/routes/...` と定めている。
 * 既定の `app/` を使うと、Hono の API（`src/routes/api/v1/`）と UI が
 * 別の木に分かれ、規約と食い違う。
 *
 * ── ルートはファイル規約で拾わない ──────────────────────
 * `src/routes.ts` で明示的に列挙する（`@react-router/fs-routes` を使わない）。
 * ファイル規約にすると `src/routes/api/v1/*.ts`（Hono のハンドラ）まで
 * UI のルートとして拾われる。
 */
export default {
  appDirectory: "src",
  ssr: true,
} satisfies Config;
