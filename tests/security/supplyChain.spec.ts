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

/**
 * YAML のコメントを落とした CI。
 *
 * **注記を検査対象にしない。** 「`zricethezav` は使わない」と**書いた注記**が
 * 「`zricethezav` を使っている」と読まれてしまう。
 */
const CI_CODE = CI.split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");
const GITLEAKS_CONFIG = readFileSync(join(ROOT, ".gitleaks.toml"), "utf8");

/**
 * `jobs:` 直下の 1 ジョブぶんを切り出す。
 *
 * **ジョブ名で探さない。** gitleaks は独立ジョブだった頃と違い、いまは
 * `test` ジョブの 1 ステップ（DECISIONS #185 で 9 本を 3 本へまとめた）。
 * **中身で探せば、また組み替えても壊れない。**
 */
function jobBlockContaining(needle: string): string {
  const jobsAt = CI_CODE.indexOf("\njobs:");
  const body = CI_CODE.slice(jobsAt);
  // 2 スペース字下げの `名前:` がジョブの始まり。
  const starts = [...body.matchAll(/\n {2}[a-z][a-z0-9-]*:\n/g)].map((m) => m.index);
  for (let i = 0; i < starts.length; i++) {
    const block = body.slice(starts[i], starts[i + 1] ?? body.length);
    if (block.includes(needle)) return block;
  }
  return "";
}

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
  it("CI で実際に動いている", () => {
    // **`CI_CODE`（注記を落としたもの）で見る。** 以前は `CI` に対して
    // "gitleaks detect" を探しており、**注記の文言で通っていた。**
    // コマンドを消しても緑になる検査だったので、実体を見る形へ直した。
    expect(CI_CODE).toContain("ghcr.io/gitleaks/gitleaks:v");
    expect(CI_CODE).toContain("detect --source /repo");
  });

  it("**見つかったら落ちる**（`--exit-code 1`）", () => {
    // 報告するだけのジョブにすると、鍵が push された状態で main が進む。
    expect(CI).toContain("--exit-code 1");
  });

  it("**公式 action を使わない**（API 権限に依存させない / DECISIONS #170）", () => {
    // `gitleaks-action` は PR のコミット一覧を GitHub API から引くため、
    // 既定の `GITHUB_TOKEN` の権限では 403 で落ちる。
    expect(CI_CODE).not.toContain("gitleaks/gitleaks-action");
  });
  it("設定を読ませている", () => {
    expect(CI).toContain(".gitleaks.toml");
  });

  it("**版を固定している**（`:latest` を使わない / DECISIONS #172）", () => {
    // `:latest` だと、ルール一式が更新された日に「昨日まで緑だった main」が
    // 赤くなる。赤を見たときに自分の変更かルールの更新かを切り分けられない。
    expect(CI_CODE).toMatch(/GITLEAKS_VERSION:\s*"\d+\.\d+\.\d+"/);
    expect(CI_CODE).not.toContain("gitleaks:latest");
  });

  it("**公式の配布名を使う**（`zricethezav/...` は旧い名前）", () => {
    expect(CI_CODE).toContain("ghcr.io/gitleaks/gitleaks");
    expect(CI_CODE).not.toContain("zricethezav/");
  });

  it("**見つかった場所がログに出る**（`--verbose`。値は `--redact` で伏せる）", () => {
    // これが無いと、赤くなったときに手元で再現するまで場所が分からない。
    expect(CI).toContain("--verbose");
    expect(CI).toContain("--redact");
  });
});

/**
 * 許可リストの形（DECISIONS #171）。
 *
 * **ここが緩むと検査が意味を失う。** 「spec に書けば通る」形にすると、
 * 実際の鍵を spec に置いた事故を検出できなくなる。
 */
describe("§6.1 gitleaks の許可リスト", () => {
  it("既定のルール一式を使う（独自ルールだけにしない）", () => {
    expect(GITLEAKS_CONFIG).toContain("useDefault = true");
  });

  it("**経路ごと除外しない。** 許すのは値そのものだけ", () => {
    // `paths` / `files` / `commits` で丸ごと除外する形を作らせない。
    // 「テストに置けば通る」ことになる。
    expect(GITLEAKS_CONFIG).not.toMatch(/^\s*paths\s*=/m);
    expect(GITLEAKS_CONFIG).not.toMatch(/^\s*files\s*=/m);
    expect(GITLEAKS_CONFIG).not.toMatch(/^\s*commits\s*=/m);
    expect(GITLEAKS_CONFIG).toMatch(/^\s*regexes\s*=/m);
  });

  it("**許可した値すべてに注記が付いている**", () => {
    // 「なぜ本物ではないと言えるか」を書かせる。書けないものは
    // 許可ではなく、鍵を回すべきもの。
    const marker = "'''";
    const lines = GITLEAKS_CONFIG.split("\n");
    const allowed = lines
      .map((line, index) => ({ line: line.trim(), index }))
      .filter(({ line }) => line.startsWith(marker));
    expect(allowed.length).toBeGreaterThan(0);
    for (const { line, index } of allowed) {
      const previous = lines[index - 1]?.trim() ?? "";
      expect(previous.startsWith("#"), `注記が無い: ${line}`).toBe(true);
    }
  });

  it("**履歴全体を走査する**（`fetch-depth: 0`）", () => {
    // 既定の浅い clone だと直近 1 コミットしか見えず、
    // 過去に混入した鍵を見逃す。
    //
    // **gitleaks を動かすジョブの塊を切り出して見る。** ファイル全体へ
    // 部分一致を掛けると、別のジョブの `fetch-depth` を拾ってしまう。
    // ジョブ名では探さない（9 本 → 3 本でステップへ移った / DECISIONS #185）。
    const job = jobBlockContaining("ghcr.io/gitleaks/gitleaks:v");
    expect(job).not.toBe("");
    expect(job).toContain("fetch-depth: 0");
  });
});
