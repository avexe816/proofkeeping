import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * デプロイ先の環境が**ビルド時に決まる**ことを、CI と手順書の両方で押さえる。
 *
 * ── 何が起きるのか（DECISIONS #192）────────────────────
 * `@cloudflare/vite-plugin` はビルド時に `build/server/wrangler.json` と
 * `.wrangler/deploy/config.json` を書く。以後 `wrangler deploy` は
 * **`wrangler.toml` ではなくそちらを読む**（redirected config）。
 * 環境は `CLOUDFLARE_ENV` で**ビルド時に**選ぶ。
 *
 * **`wrangler deploy --env staging` は効かない。エラーにもならない。**
 * 直前のビルドが焼いた設定がそのまま上がる。環境指定なしでビルドすると
 * top-level（local）が焼かれるので、
 *
 *   - Worker 名が `pk-local`
 *   - D1 が `proofkeeping-shard-00`（**実在する唯一の D1**）
 *   - cron が有効
 *
 * の Worker が Cloudflare 上に出来上がる。**staging を出したつもりで
 * production のデータに繋がる。** 出力を読んでも `--env staging` と
 * 書いてあるので、気づけない。
 *
 * だから「`CLOUDFLARE_ENV` があること」と「焼けた名前を確かめてから
 * deploy すること」を機械的に見る。
 */

const ROOT = join(import.meta.dirname, "..", "..");

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

/** `- name: <見出し>` から次の `- name:` までを 1 ステップとして切り出す。 */
function ciStep(workflow: string, heading: string): string {
  const start = workflow.indexOf(`- name: ${heading}`);
  expect(start, `CI に「${heading}」のステップが無い`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const end = rest.indexOf("- name:");
  return end === -1 ? rest : rest.slice(0, end);
}

const DEPLOY_STEPS = [
  { heading: "preview デプロイ", env: "preview", workerName: "pk-preview" },
  { heading: "staging デプロイ", env: "staging", workerName: "pk-staging" },
] as const;

describe("デプロイ環境の焼き込み", () => {
  it("CI のデプロイステップが CLOUDFLARE_ENV を渡す", () => {
    const workflow = read(".github/workflows/ci.yml");

    for (const step of DEPLOY_STEPS) {
      const body = ciStep(workflow, step.heading);
      expect(body, step.heading).toContain(`CLOUDFLARE_ENV: ${step.env}`);
    }
  });

  it("CI が deploy の前に焼けた Worker 名を確かめる", () => {
    // **`--env` が効かない以上、これが唯一の関門。**
    const workflow = read(".github/workflows/ci.yml");

    for (const step of DEPLOY_STEPS) {
      const body = ciStep(workflow, step.heading);

      expect(body, step.heading).toContain("build/server/wrangler.json");
      expect(body, step.heading).toContain(step.workerName);
      expect(body, step.heading).toMatch(/exit 1/);
    }
  });

  it("CI が deploy に `--env` を渡さない（効かないものを書かない）", () => {
    const workflow = read(".github/workflows/ci.yml");

    for (const step of DEPLOY_STEPS) {
      const body = ciStep(workflow, step.heading);
      expect(body, step.heading).not.toMatch(/wrangler deploy[^\n]*--env/);
    }
  });

  it("手順書の deploy が CLOUDFLARE_ENV 付きで、`--env` を使わない", () => {
    const deploy = read("docs/runbook/deploy.md");
    const lines = deploy.split("\n").filter((line) => line.includes("wrangler deploy"));

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // 説明文（`--env` が効かないことを述べる行）は対象外。実行行だけを見る。
      if (!line.trimStart().startsWith("CLOUDFLARE_ENV=")) continue;
      expect(line).not.toContain("--env");
    }

    // ビルド行も同様。環境指定なしのビルドを deploy 手順に混ぜない。
    const buildLines = deploy
      .split("\n")
      .filter((line) => line.includes("pnpm --filter @pk/web build"));
    for (const line of buildLines) {
      expect(line.trimStart().startsWith("CLOUDFLARE_ENV="), line).toBe(true);
    }
  });
});
