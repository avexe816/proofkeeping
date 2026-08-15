import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * RUNBOOK に書いてあるコマンドが「そのまま貼れば通る」ことを機械的に押さえる。
 *
 * ── なぜ要るのか ────────────────────────────────────────
 * 運用 CLI（`db:migrate` / `shards:usage` / `shards:move`）は**ルートの
 * package.json にしかない。** `apps/web` で叩くと pnpm はそのパッケージを
 * 探しに行き、こう落ちる。
 *
 *   ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "db:migrate" not found
 *
 * **「script が無い」と読めるが、実際には居る場所が違うだけ。** 手順書は
 * 節をまたいで `cd` の状態が残るため、`cd apps/web` した節の直後に
 * ルートの script を書くと、読者は必ずこれを踏む（実際に踏まれた）。
 * 逆に `wrangler` は apps/web でしか通らない（`wrangler.toml` の位置と、
 * ルートに wrangler が入っていないこと）。**方向が逆の 2 つが同じ文書に居る。**
 *
 * 人間が読んで気づける類の誤りではないので、テストで押さえる。
 */

const ROOT = join(import.meta.dirname, "..", "..");
const RUNBOOK_DIR = join(ROOT, "docs", "runbook");

/** ルートへ戻る唯一の書き方。**表記を 1 つに絞ることで検出できる。** */
const RETURN_TO_ROOT = 'cd "$(git rev-parse --show-toplevel)"';

/** script 名ではない pnpm のサブコマンド。 */
const PNPM_SUBCOMMANDS = new Set([
  "add",
  "audit",
  "config",
  "create",
  "deploy",
  "dlx",
  "env",
  "exec",
  "fetch",
  "i",
  "init",
  "install",
  "licenses",
  "link",
  "list",
  "outdated",
  "patch",
  "prune",
  "publish",
  "rebuild",
  "remove",
  "setup",
  "store",
  "update",
  "why",
]);

interface PnpmInvocation {
  /** ルートの script を指しているとき、その名前。 */
  script: string | null;
  /** `-w` / `--workspace-root` が付いているか。付いていれば cwd を問わない。 */
  fromAnywhere: boolean;
}

/**
 * 1 行を pnpm の呼び出しとして読む。pnpm 以外の行と、
 * `--filter` 付き（対象パッケージで走るため cwd を問わない）は null を返す。
 */
function readPnpmInvocation(line: string): PnpmInvocation | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== "pnpm") return null;

  let index = 1;
  let fromAnywhere = false;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) break;
    if (token === "-w" || token === "--workspace-root") {
      fromAnywhere = true;
      index += 1;
      continue;
    }
    // `--filter <pkg>` はそのパッケージのディレクトリで走る。ルートの script ではない。
    if (token === "--filter" || token === "-F") return null;
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }

  const head = tokens[index];
  if (head === undefined) return null;
  if (head === "run") return { script: tokens[index + 1] ?? null, fromAnywhere };
  if (PNPM_SUBCOMMANDS.has(head)) return null;
  return { script: head, fromAnywhere };
}

/** ```bash のコードブロックの中身だけを、文書の順に 1 本に繋いで返す。 */
function bashLines(markdown: string): string[] {
  const lines = markdown.split("\n");
  const collected: string[] = [];
  let inside = false;

  for (const line of lines) {
    if (line.startsWith("```")) {
      inside = line.startsWith("```bash");
      continue;
    }
    if (inside) collected.push(line);
  }

  return collected;
}

/** インラインコード（`...`）の中身。散文に書かれたコマンドを拾う。 */
function inlineCode(markdown: string): string[] {
  return [...markdown.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "");
}

function runbookFiles(): string[] {
  return readdirSync(RUNBOOK_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort();
}

const ROOT_SCRIPTS = new Set(
  Object.keys(
    (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    }).scripts ?? {},
  ),
);

describe("RUNBOOK のコマンド", () => {
  it("pnpm の script が実在する（未配線の script を手順書に書かない）", () => {
    for (const file of runbookFiles()) {
      const markdown = readFileSync(join(RUNBOOK_DIR, file), "utf8");

      for (const command of [...bashLines(markdown), ...inlineCode(markdown)]) {
        const invocation = readPnpmInvocation(command);
        if (invocation?.script == null) continue;

        expect(ROOT_SCRIPTS, `${file}: ${command}`).toContain(invocation.script);
      }
    }
  });

  it("ルートの script を apps/web に居るまま叩かせない", () => {
    for (const file of runbookFiles()) {
      const markdown = readFileSync(join(RUNBOOK_DIR, file), "utf8");
      // コードブロックをまたいで cd の状態は残る。読者の端末と同じに追う。
      let cwd = "root";

      for (const line of bashLines(markdown)) {
        const trimmed = line.trim();

        if (trimmed.startsWith(RETURN_TO_ROOT)) {
          cwd = "root";
          continue;
        }
        const changed = /^cd\s+(\S+)/.exec(trimmed);
        if (changed?.[1] !== undefined) {
          cwd = changed[1];
          continue;
        }

        const invocation = readPnpmInvocation(trimmed);
        if (invocation?.script == null || invocation.fromAnywhere) continue;

        expect(cwd, `${file}: 「${trimmed}」の直前に ${RETURN_TO_ROOT} が要る`).toBe("root");
      }
    }
  });

  it("wrangler をルートに居るまま叩かせない", () => {
    for (const file of runbookFiles()) {
      const markdown = readFileSync(join(RUNBOOK_DIR, file), "utf8");
      let cwd = "root";

      for (const line of bashLines(markdown)) {
        const trimmed = line.trim();

        if (trimmed.startsWith(RETURN_TO_ROOT)) {
          cwd = "root";
          continue;
        }
        const changed = /^cd\s+(\S+)/.exec(trimmed);
        if (changed?.[1] !== undefined) {
          cwd = changed[1];
          continue;
        }

        // ルートに wrangler は入っておらず、`wrangler.toml` も apps/web にある。
        if (!/^wrangler\s/.test(trimmed)) continue;

        expect(cwd, `${file}: 「${trimmed}」は apps/web でしか通らない`).toBe("apps/web");
      }
    }
  });
});
