/**
 * メール周りの秘密が漏れる口を作らせない（P5-21 / DECISIONS #248）。
 *
 * ── 何を守っているか ────────────────────────────────────
 * SMTP は Resend と違い、**こちらがパスワードを持って接続する。**
 * さらに拒否の応答には**宛先がそのまま echo される**
 * （`550 <someone@example.com> unknown mailbox`）。ログへ流せば個人情報が
 * 残り、監査ログへ入れば消せない記録になる（security.md §3・§6）。
 *
 * ここは `tests/security/initialPin.spec.ts` と同じ形の走査で、
 * **平文を扱ってよいファイルを数える。** 増やすには理由が要る。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIL = join(ROOT, "apps", "web", "src", "lib", "mail");
const WORKFLOW = join(ROOT, ".github", "workflows", "smtp-probe.yml");

function code(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * TypeScript の注記（`//` と `/* … *\/`）を落とす。
 *
 * **説明文を検査対象にしない。** 「`SMTP_PASSWORD` を読まない」と書いた
 * 注記そのものが検出に引っかかるのを避ける。
 */
function withoutTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** `#` で始まる行（注記）を落とす。**説明文を検査対象にしない。** */
function withoutComments(yaml: string): string {
  return yaml
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

describe("メールの層は何も出力しない", () => {
  const files = ["smtp.ts", "mime.ts", "send.ts", "probe.ts"] as const;

  it.each(files)("%s が `console` を呼ばない", (file) => {
    expect(code(join(MAIL, file))).not.toMatch(/console\s*\./);
  });

  it("`smtp.ts` は例外を投げない（接続先やコマンドをスタックに載せない）", () => {
    const source = code(join(MAIL, "smtp.ts"));
    // `throw` は 1 つも無い。失敗は戻り値で表す。
    expect(source).not.toMatch(/^\s*throw /m);
  });

  it("SMTP の応答文字列を戻り値の型に持たせない", () => {
    const source = code(join(MAIL, "smtp.ts"));
    // `SmtpOutcome` が持つのは ok / failedAt / code だけ。
    expect(source).toMatch(/export interface SmtpOutcome \{[\s\S]*?\n\}/);
    const outcome = /export interface SmtpOutcome \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
    expect(outcome).toContain("ok:");
    expect(outcome).toContain("failedAt:");
    expect(outcome).toContain("code:");
    expect(outcome).not.toMatch(/\bmessage\s*:|\btext\s*:|\bresponse\s*:/);
  });
});

describe("SMTP_PASSWORD を扱ってよい場所を数える", () => {
  /**
   * 平文の password が現れてよいファイル。**増やすときは理由を書くこと。**
   *
   *   - `send.ts`  env から読んで `smtp.ts` へ渡す 1 本道
   *   - `smtp.ts`  `AUTH LOGIN` で使う（唯一の使用箇所）
   */
  const ALLOWED = ["apps/web/src/lib/mail/send.ts", "apps/web/src/lib/mail/smtp.ts"];

  it("`env.SMTP_PASSWORD` を読むのは send.ts だけ", () => {
    expect(withoutTsComments(code(join(MAIL, "send.ts")))).toContain("env.SMTP_PASSWORD");
    // `smtp.ts` は env を知らない（`config.password` として受け取るだけ）。
    expect(withoutTsComments(code(join(MAIL, "smtp.ts")))).not.toContain("env.");
    expect(ALLOWED).toHaveLength(2);
  });

  it("**疎通確認は password を受け取らない**（probe.ts / smtpProbe.ts）", () => {
    expect(withoutTsComments(code(join(MAIL, "probe.ts")))).not.toContain("SMTP_PASSWORD");
    const route = code(join(ROOT, "apps", "web", "src", "routes", "api", "v1", "smtpProbe.ts"));
    expect(withoutTsComments(route)).not.toContain("SMTP_PASSWORD");
    // `probeSmtp()` の引数の型からも password を外してある。
    expect(code(join(MAIL, "smtp.ts"))).toMatch(/probeSmtp\(\s*\n?\s*config: Omit<SmtpConfig, "password"/);
  });

  it("疎通確認は `AUTH LOGIN` を実行しない（広告の有無だけを見る）", () => {
    const source = code(join(MAIL, "smtp.ts"));
    // **probeSmtp の本体だけを切り出す**（後ろの sendViaSmtp を含めない）。
    const start = source.indexOf("export async function probeSmtp");
    const probe = source.slice(start, source.indexOf("export interface SmtpSendInput", start));
    expect(probe).not.toContain('write("AUTH LOGIN")');
    expect(probe).toContain('includes("AUTH")');
  });
});

describe("疎通確認の応答（真偽値と段階名だけ）", () => {
  it("host も username も応答文字列も返さない", () => {
    const source = code(join(MAIL, "probe.ts"));
    const report = /export interface SmtpProbeReport \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
    expect(report).toContain("tcp:");
    expect(report).toContain("authAdvertised:");
    expect(report).toContain("failedAt:");
    expect(report).not.toMatch(/host|username|response|text/i);
  });
});

describe("疎通確認の workflow", () => {
  const yaml = withoutComments(readFileSync(WORKFLOW, "utf8"));

  it("**`workflow_dispatch` だけ**で走る", () => {
    expect(yaml).toContain("workflow_dispatch:");
    expect(yaml).not.toMatch(/^\s{2}(push|pull_request|schedule|repository_dispatch):/m);
  });

  it("**`SMTP_PASSWORD` を触らない**（認証を試さないので要らない）", () => {
    expect(yaml).not.toContain("SMTP_PASSWORD");
  });

  it("`set -x` を置かない / summary・artifact に書かない", () => {
    expect(yaml).not.toMatch(/set\s+-[a-z]*x/);
    expect(yaml).not.toContain("GITHUB_STEP_SUMMARY");
    expect(yaml).not.toContain("upload-artifact");
  });

  it("応答を丸ごと出さない（`cat` / `jq .` を置かない）", () => {
    expect(yaml).not.toMatch(/cat\s+\/tmp\/probe\.json/);
    expect(yaml).not.toMatch(/jq\s+-r?\s*'\.'/);
  });

  it("管理鍵をマスクし、値を echo しない", () => {
    expect(yaml).toContain("::add-mask::$probe_token");
    expect(yaml).not.toMatch(/echo\s+"?\$probe_token/);
    expect(yaml).toContain("printf '%s' \"$probe_token\" \\");
  });

  it("鍵を必ず消し、**消えたことを名前で確かめる**（#247 の形）", () => {
    expect(yaml).toContain("wrangler secret delete SMTP_PROBE_TOKEN");
    expect(yaml).toContain("if: always()");
    expect(yaml).not.toMatch(/secret delete[\s\S]{0,120}--force/);
    expect(yaml).toMatch(/grep -q 'SMTP_PROBE_TOKEN'[\s\S]{0,200}exit 1/);
  });

  it("書き込みの権限を持たない", () => {
    expect(yaml).toMatch(/permissions:\s*\n\s*contents: read\s*\n/);
  });

  it("**メールを送る経路を持たない**（宛先の入力が無い）", () => {
    expect(yaml).not.toMatch(/^\s*(to|recipient|email):/m);
    expect(yaml).not.toContain("MAIL FROM");
  });
});

describe("送付ログの状態（#248）", () => {
  const schema = code(join(ROOT, "packages", "db", "src", "schema", "invoice.ts"));

  it("SMTP の 3 状態を持つ", () => {
    for (const status of ["SMTP_ACCEPTED", "SMTP_REJECTED", "DELIVERY_UNCONFIRMED"]) {
      expect(schema).toContain(`"${status}"`);
    }
  });

  it("**既存の状態を消していない**（webhook 時代の記録が残る）", () => {
    for (const status of ["QUEUED", "SENT", "DELIVERED", "BOUNCED", "FAILED"]) {
      expect(schema).toContain(`"${status}"`);
    }
  });

  it("SMTP の経路が `DELIVERED` / `BOUNCED` を立てない（推測しない）", () => {
    const consumer = code(join(ROOT, "apps", "web", "src", "consumers", "notification.ts"));
    // 送信直後に書く状態は SMTP_ACCEPTED / SMTP_REJECTED だけ。
    expect(consumer).toMatch(/status: sent\.ok \? "SMTP_ACCEPTED" : "SMTP_REJECTED"/);
    // `DELIVERED` を書くのは webhook の経路（`handleDeliveryEvent`）だけ。
    const beforeWebhook = consumer.slice(0, consumer.indexOf("handleDeliveryEvent"));
    expect(beforeWebhook).not.toContain('status: "DELIVERED"');
  });
});
