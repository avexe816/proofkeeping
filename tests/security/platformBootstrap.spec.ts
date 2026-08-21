/**
 * 初期開通の秘密が外へ出る経路を増やしていないことの検査（PF-16）。
 *
 * task:  docs/tasks/PF-16.md
 * ルール: .claude/rules/security.md §6・§7
 * 決定:  docs/DECISIONS.md #240・#245
 *
 * ── なぜソースを走査するのか ────────────────────────────
 * PF-16 の完了条件は「**token・パスワード・2FA secret・復旧コードが
 * ログにも監査ログの `detail` にも出ない**」。これは 1 本の関数の
 * 振る舞いではなく**経路が生えていないこと**なので、実行時のテストでは
 * 押さえきれない（`initialPin.spec.ts` と同じ作り）。
 *
 * 「開通リンクを summary に出す 1 行」「token を console へ出す 1 行」を
 * 足した PR が、ここで落ちる状態にしておく。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const WEB = join(ROOT, "apps", "web", "src");
const WORKFLOW = join(ROOT, ".github", "workflows", "platform-bootstrap.yml");

/** ブロックコメント・行コメントを落とす。**注記を検査対象にしない。** */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function relative(path: string): string {
  return path.slice(WEB.length + 1).replaceAll("\\", "/");
}

const SOURCES = walk(WEB).filter((path) => !/\.spec\.tsx?$/.test(path));

/**
 * 平文の開通 token を扱ってよいファイルと、**その理由。**
 *
 * `Record` にしてあるのは、**追加に必ず一文を書かせる**ため
 * （`initialPin.spec.ts` と同じ向き）。ここに 1 行足すということは、
 * token が通る経路を 1 本増やすということ。
 */
const TOKEN_BEARING_FILES: Readonly<Record<string, string>> = {
  "lib/platform/bootstrap.ts":
    "発行 → ハッシュ → 保存 → リンク組み立て。**保存するのはハッシュだけ。**",
  "lib/platform/bootstrapMail.ts": "受け渡しの 1 本道。リンクは本文にだけ現れる。",
  "routes/plat/bootstrap.tsx": "開通の画面。URL の `:token` を受けて消費する。",
};

/** 平文の token を持ち出しうる呼び出し。**この 4 つが「外」への口。** */
const EXFILTRATION = [
  { pattern: /\bQUEUE_[A-Z_]+\s*\.\s*send\b/, label: "Queue への送信" },
  { pattern: /\bconsole\s*\.\s*(log|info|warn|debug)\b/, label: "ログ出力" },
  { pattern: /\b[A-Z_]*BUCKET[A-Z_]*\s*\.\s*put\b/, label: "R2 への書き出し" },
  { pattern: /\brecordPlatformAudit\s*\(/, label: "監査ログ（直接）" },
] as const;

describe("開通 token の経路（PF-16 の要件 10）", () => {
  it("平文の token を扱うファイルが許可した 3 つだけ", () => {
    const bearing = SOURCES.filter((path) => {
      const source = code(path);
      return /\bbuildBootstrapLink\b|\bfindBootstrapInvitation\b|\bactivatePlatformBootstrap\b|\bsendBootstrapLink\b/.test(
        source,
      );
    }).map(relative);
    expect(bearing.sort()).toEqual(Object.keys(TOKEN_BEARING_FILES).sort());
  });

  it.each(Object.keys(TOKEN_BEARING_FILES))(
    "%s が Queue・ログ・R2・監査ログへ直接渡さない",
    (relativePath) => {
      const source = code(join(WEB, relativePath));
      for (const { pattern, label } of EXFILTRATION) {
        expect(pattern.test(source), `${relativePath} に ${label}`).toBe(false);
      }
    },
  );

  it("監査ログの呼び出しに token・パスワード・リンクを載せない", () => {
    const source = code(join(WEB, "lib", "platform", "bootstrap.ts"));
    // `auditQuietly()` を包んだ `audit(...)` の呼び出しを全部見る。
    const calls = [...source.matchAll(/\baudit\(\s*"[^"]+"[\s\S]*?\);/g)];
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) {
      expect(/\btoken\b(?!Id)/i.test(call[0]), `token: ${call[0]}`).toBe(false);
      expect(/\bpassword\b/i.test(call[0]), `password: ${call[0]}`).toBe(false);
      expect(/\blink\b/i.test(call[0]), `link: ${call[0]}`).toBe(false);
      expect(/\bemail\b/i.test(call[0]), `email: ${call[0]}`).toBe(false);
    }
  });

  it("開通の応答に token を含める口が無い（API 側）", () => {
    const source = code(join(WEB, "routes", "api", "v1", "platformBootstrap.ts"));
    // 返してよいのは `ok` と `expiresAt`、そして `error` だけ。
    expect(source).not.toMatch(/\btoken\b\s*:/);
    expect(source).not.toMatch(/buildBootstrapLink/);
  });

  it("開通画面の loader が token を戻り値に載せない", () => {
    const source = code(join(WEB, "routes", "plat", "bootstrap.tsx"));
    const loader = /export async function loader[\s\S]*?\nexport async function action/.exec(source);
    expect(loader, "loader が見つからない").not.toBeNull();
    // 戻す型に token を持たせない（HTML に載ったまま残る）。
    expect(source).toMatch(/interface BootstrapPageData \{\s*email: string;\s*displayName: string;/);
    expect(/return \{[^}]*token/.test(loader?.[0] ?? "")).toBe(false);
  });

  it("パスワードの平文を保存する口が無い（ハッシュ化を経由する）", () => {
    const source = code(join(WEB, "lib", "platform", "bootstrap.ts"));
    expect(source).toContain("hashPassword(");
    // `passwordHash:` に渡るのは `hashPassword()` の結果だけ。
    expect(source).toMatch(/passwordHash: await hashPassword\(/);
  });
});

describe("bootstrap の workflow（要件: ログ・summary・artifact へ出さない）", () => {
  const yaml = readFileSync(WORKFLOW, "utf8");
  /** `#` で始まる行（注記）を落とす。**説明文を検査対象にしない。** */
  const steps = yaml
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  it("**`workflow_dispatch` だけ**で走る（自動実行の経路を作らない / 要件 1）", () => {
    expect(steps).toContain("workflow_dispatch:");
    expect(steps).not.toMatch(/^\s{2}(push|pull_request|schedule|repository_dispatch):/m);
  });

  it("summary にも artifact にも書かない", () => {
    expect(steps).not.toContain("GITHUB_STEP_SUMMARY");
    expect(steps).not.toContain("upload-artifact");
  });

  it("応答を丸ごと出さない（`cat` / `jq .` を置かない）", () => {
    expect(steps).not.toMatch(/cat\s+\/tmp\/bootstrap\.json/);
    expect(steps).not.toMatch(/jq\s+-r?\s*'\.'/);
  });

  it("管理鍵をマスクし、値を echo しない", () => {
    expect(steps).toContain("::add-mask::$bootstrap_token");
    expect(steps).not.toMatch(/echo\s+"?\$bootstrap_token/);
    // **標準入力から渡す**（引数に置くと `ps` に出る）。
    expect(steps).toContain("printf '%s' \"$bootstrap_token\" \\");
  });

  it("**鍵を必ず消す**（失敗しても消す）", () => {
    expect(steps).toContain("wrangler secret delete PLATFORM_BOOTSTRAP_TOKEN");
    expect(steps).toContain("if: always()");
  });

  // ── cleanup の取りこぼしを塞ぐ（2026-08-21 / DECISIONS #247）──
  //
  // 初版は `--force`（存在しない引数）を渡し、失敗を `|| true` で
  // 握りつぶしていた。**削除は 1 度も走らないままステップが緑になり、
  // 管理鍵が staging に残った。** 同じ形が戻らないようにここで固定する。

  it("`wrangler secret delete` に `--force` を渡さない（存在しない引数）", () => {
    expect(steps).not.toMatch(/secret delete[\s\S]{0,120}--force/);
  });

  it("削除の失敗を握りつぶさない（`|| true` を付けない）", () => {
    const deleteBlock = steps.slice(steps.indexOf("wrangler secret delete PLATFORM_BOOTSTRAP_TOKEN"));
    // 削除コマンドと、続く 1 行（改行継続の `--env …`）に `|| true` が無いこと。
    expect(deleteBlock.split("\n").slice(0, 3).join("\n")).not.toContain("|| true");
  });

  it("**消えたことを名前で確かめる**（一覧に残っていたら赤にする）", () => {
    expect(steps).toContain("wrangler secret list --env");
    expect(steps).toMatch(/grep -q 'PLATFORM_BOOTSTRAP_TOKEN'[\s\S]{0,200}exit 1/);
  });

  it("確認は staging / production のどちらでも同じに働く（環境を焼き込まない）", () => {
    // 削除も一覧も `inputs.environment` を使う。**片方だけ固定値にしない。**
    const cleanup = steps.slice(steps.indexOf("wrangler secret delete PLATFORM_BOOTSTRAP_TOKEN"));
    expect(cleanup).toContain('--env "${{ inputs.environment }}"');
    expect(cleanup).not.toMatch(/--env\s+"?(staging|production)"?[\s\n]/);
  });

  it("`set -x` を置かない（鍵が展開されて残る）", () => {
    expect(steps).not.toMatch(/set\s+-[a-z]*x/);
  });

  it("パスワードも復旧コードも受け取らない（本人がブラウザで決める）", () => {
    expect(steps).not.toMatch(/password/i);
    expect(steps).not.toMatch(/recovery/i);
    expect(steps).not.toMatch(/totp/i);
  });

  it("書き込みの権限を持たない", () => {
    expect(steps).toMatch(/permissions:\s*\n\s*contents: read\s*\n/);
  });
});

describe("既存のシード経路を広げていない", () => {
  it("production seed を開ける変更が入っていない", () => {
    const source = code(join(WEB, "routes", "api", "v1", "dev.ts"));
    expect(source).toContain('if (env.ENVIRONMENT !== "staging") return false;');
    expect(source).not.toMatch(/ENVIRONMENT === "production"/);
  });

  it("開通の経路が seed を呼ばない", () => {
    for (const path of ["lib/platform/bootstrap.ts", "routes/api/v1/platformBootstrap.ts"]) {
      expect(code(join(WEB, path))).not.toMatch(/runSeed|\bseed\b/);
    }
  });
});
