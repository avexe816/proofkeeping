import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * P0-01 で敷いたツールチェーンの構成そのものを検証する。
 *
 * 目的は「後続の task が土台を崩していないこと」を CI で機械的に押さえること。
 * 業務ロジックのテストではない。
 */

const ROOT = join(import.meta.dirname, "..", "..");

/** packages/ 配下に存在すべきパッケージ（CLAUDE.md §3 / docs/tasks/P0-01.md）。 */
const PACKAGES = ["billing", "config", "contracts", "db", "engine", "integrations", "pdf"] as const;

/** CLAUDE.md §3 で「純粋関数・依存ゼロ」と定めたパッケージ。 */
const DEPENDENCY_FREE_PACKAGES = ["engine", "billing"] as const;

/**
 * ルート package.json に定義してよい script（実体のあるものだけ）。
 *
 * `check` は上記 3 つの合成であり、CLAUDE.md §8 が PR 前必須と定めているため含む。
 * `dev` は wrangler.toml ができた P0-02 で追加した。
 * `db:generate` / `db:migrate` はスキーマとランナーができた P0-06 で追加した。
 */
const EXPECTED_ROOT_SCRIPTS = [
  "dev",
  "db:generate",
  "db:migrate",
  "typecheck",
  "lint",
  "test",
  "test:isolation",
  "check",
] as const;

/** 実体がないため未定義の script。担当 task が追加する。 */
const DEFERRED_ROOT_SCRIPTS = ["db:seed", "test:e2e"] as const;

interface PackageJson {
  name?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
}

interface TsConfig {
  extends?: string;
  compilerOptions?: Record<string, unknown>;
}

function readText(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function readPackageJson(relativePath: string): PackageJson {
  return JSON.parse(readText(relativePath)) as PackageJson;
}

function readTsConfig(relativePath: string): TsConfig {
  return JSON.parse(readText(relativePath)) as TsConfig;
}

/** ワークスペースに属する全パッケージのディレクトリ（ルートは含まない）。 */
const WORKSPACE_DIRS = [...PACKAGES.map((name) => `packages/${name}`), "apps/web"];

describe("P0-01 ツールチェーン構成", () => {
  it("pnpm-workspace.yaml が apps/* と packages/* を含む", () => {
    const workspace = readText("pnpm-workspace.yaml");

    expect(workspace).toContain("apps/*");
    expect(workspace).toContain("packages/*");
  });

  it("packages/ 配下に 7 パッケージが存在する", () => {
    for (const name of PACKAGES) {
      const pkg = readPackageJson(`packages/${name}/package.json`);
      expect(pkg.name).toBe(`@pk/${name}`);
    }

    expect(PACKAGES).toHaveLength(7);
  });

  it("全ワークスペースパッケージが @pk/ 名前空間かつ private である", () => {
    for (const dir of WORKSPACE_DIRS) {
      const pkg = readPackageJson(`${dir}/package.json`);

      expect(pkg.name, dir).toMatch(/^@pk\//);
      expect(pkg.private, dir).toBe(true);
    }
  });

  it("各パッケージの tsconfig が @pk/config の設定を extends する", () => {
    for (const dir of WORKSPACE_DIRS) {
      if (dir === "packages/config") continue; // 設定の提供元自身は extends しない

      const tsconfig = readTsConfig(`${dir}/tsconfig.json`);
      expect(tsconfig.extends, dir).toMatch(/^@pk\/config\/tsconfig\//);
    }
  });

  it("strict 設定が packages/config/tsconfig/base.json に集約されている", () => {
    const base = readTsConfig("packages/config/tsconfig/base.json");

    expect(base.compilerOptions?.["strict"]).toBe(true);
    expect(base.compilerOptions?.["noUncheckedIndexedAccess"]).toBe(true);
  });

  it("ルートの script が実体のあるものだけである", () => {
    const root = readPackageJson("package.json");
    const scripts = Object.keys(root.scripts ?? {});

    expect(scripts.slice().sort()).toEqual([...EXPECTED_ROOT_SCRIPTS].sort());

    // 実体のない script を置くと「通った」のか「未実装」なのかが区別できなくなる。
    for (const deferred of DEFERRED_ROOT_SCRIPTS) {
      expect(scripts, deferred).not.toContain(deferred);
    }
  });

  it("engine と billing が dependencies を持たない", () => {
    for (const name of DEPENDENCY_FREE_PACKAGES) {
      const pkg = readPackageJson(`packages/${name}/package.json`);
      expect(pkg.dependencies, name).toBeUndefined();
    }
  });
});
