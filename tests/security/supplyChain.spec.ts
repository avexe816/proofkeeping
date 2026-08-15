/**
 * 依存の脆弱性スキャンと秘密情報の検査（PK-SPEC-P7 §6.1 / P7-13）。
 *
 * task: docs/tasks/P7-13.md
 *
 * ── 「動いている」を設定で確かめる ──────────────────────
 * 完了条件は「Dependabot / gitleaks が**動いている**」。実際に動くのは
 * GitHub 側だが、**設定が消えていないこと**はここで固定できる。
 * 設定を消す変更が CI を通らないようにしておく。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

const DEPENDABOT = readFileSync(join(ROOT, ".github", "dependabot.yml"), "utf8");
const CI = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

describe("§6.1 Dependabot", () => {
  it("npm と GitHub Actions の両方を見る", () => {
    expect(DEPENDABOT).toContain("package-ecosystem: npm");
    expect(DEPENDABOT).toContain("package-ecosystem: github-actions");
  });

  it("**major を自動で上げない**（技術スタックは CLAUDE.md §2 で固定）", () => {
    expect(DEPENDABOT).toContain("version-update:semver-major");
  });
});

describe("§6.1 gitleaks", () => {
  it("CI のジョブとして在る", () => {
    expect(CI).toContain("gitleaks:");
    expect(CI).toContain("gitleaks detect");
  });

  it("**見つかったら落ちる**（`--exit-code 1`）", () => {
    // 報告するだけのジョブにすると、鍵が push された状態で main が進む。
    expect(CI).toContain("--exit-code 1");
  });

  it("**公式 action を使わない**（API 権限に依存させない / DECISIONS #170）", () => {
    // `gitleaks-action` は PR のコミット一覧を GitHub API から引くため、
    // 既定の `GITHUB_TOKEN` の権限では 403 で落ちる。
    expect(CI).not.toContain("gitleaks/gitleaks-action");
  });

  it("**履歴全体を走査する**（`fetch-depth: 0`）", () => {
    // 既定の浅い clone だと直近 1 コミットしか見えず、
    // 過去に混入した鍵を見逃す。
    //
    // **`gitleaks:` から次のジョブまでを切り出して見る。** ファイル全体に
    // 対して部分一致を掛けると、別のジョブの `fetch-depth` を拾ってしまう。
    const start = CI.indexOf("gitleaks:");
    const rest = CI.slice(start);
    const nextJob = /\n {2}[a-z][a-z0-9-]*:\n/.exec(rest.slice("gitleaks:".length));
    const job = nextJob === null ? rest : rest.slice(0, "gitleaks:".length + nextJob.index);
    expect(job).toContain("fetch-depth: 0");
  });
});
