/**
 * 初期 PIN がサーバーの外へ出る経路を増やしていないことの検査
 * （PK-SPEC-P7 §2.4 v1.1 / P7-02）。
 *
 * task:  docs/tasks/P7-02.md
 * ルール: .claude/rules/security.md §2 / §6
 * 決定:  docs/DECISIONS.md #177 / #184
 *
 * ── なぜソースを走査するのか ────────────────────────────
 * §2.4 v1.1 の完了条件は「**PIN が Queue・DB・ログ・生成ファイルに
 * 残らない**（走査で確かめる）」。これは 1 本の関数の振る舞いではなく
 * **経路が生えていないこと**なので、実行時のテストでは押さえられない。
 * 「PIN を Queue へ投げる 1 行」を足した PR がここで落ちる状態にしておく。
 *
 * PDF をやめて印刷用 HTML にしたのは、まさにこの性質を保つため
 * （Queue へ投げると PIN をメッセージに載せることになる / DECISIONS #184）。
 * **その判断を、実装が後から崩せないように固定する。**
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const WEB = join(ROOT, "apps", "web", "src");

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

/**
 * 平文の初期 PIN を扱ってよいファイルと、**その理由。**
 *
 * `Set` ではなく `Record` にしてあるのは、**追加に必ず一文を書かせる**ため
 * （`accessMatrix.spec.ts` と同じ向き）。ここに 1 行足すということは、
 * PIN が通る経路を 1 本増やすということ。
 */
const PIN_BEARING_FILES: Readonly<Record<string, string>> = {
  "lib/auth/pin.ts": "PIN の発行とハッシュ化そのもの。平文はここで作られる。",
  "lib/staff/register.ts": "発行 → ハッシュ → 保存 → 戻り値。**保存するのはハッシュだけ。**",
  "routes/app/staff.tsx": "登録画面。`action` の戻り値としてだけ現れる（DECISIONS #184）。",
};

/**
 * PIN の値が**通り抜ける**ファイル。上の 3 つに加えて登録 API を含む。
 *
 * `users.ts` は `registerFieldStaff()` の戻り値をそのまま応答にするので
 * `initialPin` という語を書かないが、**値は通っている。** 語で拾えない
 * ぶん、ここに明示して同じ検査を当てる。
 */
const PIN_CARRYING_FILES: readonly string[] = [
  ...Object.keys(PIN_BEARING_FILES),
  "routes/api/v1/users.ts",
];

/** 平文の PIN を持ち出しうる呼び出し。**この 4 つが「外」への口。** */
const EXFILTRATION = [
  { pattern: /\bQUEUE_[A-Z_]+\s*\.\s*send\b/, label: "Queue への送信" },
  { pattern: /\bconsole\s*\.\s*(log|info|warn|error|debug)\b/, label: "ログ出力" },
  { pattern: /\bR2_[A-Z_]*\s*\.\s*put\b|\bBUCKET\s*\.\s*put\b/, label: "R2 への書き出し" },
  { pattern: /\brecordAudit\s*\(/, label: "監査ログ" },
] as const;

const SOURCES = walk(WEB).filter((path) => !/\.spec\.tsx?$/.test(path));

function relative(path: string): string {
  return path.slice(WEB.length + 1).replaceAll("\\", "/");
}

describe("初期 PIN の経路（PK-SPEC-P7 §2.4 v1.1）", () => {
  it("平文の PIN を扱うファイルが許可した 4 つだけ", () => {
    const bearing = SOURCES.filter((path) =>
      /\binitialPin\b|\bgenerateInitialPin\b/.test(code(path)),
    ).map(relative);
    expect(bearing.sort()).toEqual(Object.keys(PIN_BEARING_FILES).sort());
  });

  /**
   * **PIN を持つファイルから「外」への口が生えていないこと。**
   *
   * `register.ts` の `recordAudit()` だけは例外で、そこは
   * 別の検査（下の「監査ログに PIN を載せない」）が中身を見る。
   */
  it.each(PIN_CARRYING_FILES.filter((path) => path !== "lib/staff/register.ts"))(
    "%s が Queue・ログ・R2・監査ログへ渡さない",
    (relativePath) => {
      const source = code(join(WEB, relativePath));
      for (const { pattern, label } of EXFILTRATION) {
        expect(pattern.test(source), `${relativePath} に ${label}`).toBe(false);
      }
    },
  );

  it("`register.ts` は監査ログ以外の口を持たない", () => {
    const source = code(join(WEB, "lib", "staff", "register.ts"));
    for (const { pattern, label } of EXFILTRATION) {
      if (label === "監査ログ") continue;
      expect(pattern.test(source), label).toBe(false);
    }
  });

  /**
   * 監査ログの `after` に PIN もハッシュも入れない（security.md §6）。
   * **`recordAudit()` の呼び出しの中に `pin` という語が現れないこと。**
   */
  it("監査ログに PIN もハッシュも載せない", () => {
    const source = code(join(WEB, "lib", "staff", "register.ts"));
    const call = /recordAudit\s*\([\s\S]*?\n {2}\}\)/.exec(source);
    expect(call, "recordAudit の呼び出しが見つからない").not.toBeNull();
    expect(/pin/i.test(call?.[0] ?? "")).toBe(false);
  });

  /**
   * **`loader` に PIN を通さない。**
   *
   * `loader` は GET で、URL にも履歴にも残る。PIN が現れてよいのは
   * `action` の戻り値だけ（DECISIONS #184 / P7-02 実装計画 2）。
   */
  it("登録画面の loader が PIN に触れない", () => {
    const source = code(join(WEB, "routes", "app", "staff.tsx"));
    const loader = /export async function loader[\s\S]*?\nexport async function action/.exec(source);
    expect(loader, "loader が見つからない").not.toBeNull();
    expect(/pin/i.test(loader?.[0] ?? "")).toBe(false);
  });

  /**
   * **QR に載せるのはログイン URL 1 本だけ。**
   * PIN を QR に入れると、紙を写真に撮られた時点で持ち出せてしまう。
   */
  it("QR に渡すのがログイン URL だけ", () => {
    const source = code(join(WEB, "routes", "app", "staff.tsx"));
    const calls = [...source.matchAll(/encodeQr\(([^)]*)\)/g)].map((match) => match[1]?.trim());
    expect(calls).toEqual(["card.loginUrl"]);
  });
});

describe("案内カードを Queue で作らない（DECISIONS #184）", () => {
  /**
   * `pk-pdf-generation` は日報・請求書・領収書・監査レポートだけを通す。
   * **案内カードの種別を足していないこと。**
   */
  // `pk-pdf-generation` を処理するのはこの 3 つ（`index.ts` の振り分け）。
  const PDF_CONSUMERS = ["dailyReport.ts", "auditReport.ts", "invoicePdf.ts"];

  it.each(PDF_CONSUMERS)("%s に案内カードの種別が無い", (name) => {
    const consumer = code(join(WEB, "consumers", name));
    for (const word of ["loginCard", "staffCard", "LOGIN_CARD", "STAFF_CARD", "initialPin"]) {
      expect(consumer.includes(word), word).toBe(false);
    }
  });

  /**
   * **PIN を持つファイルから PDF 生成キューへ送っていない。**
   * §2.4 初版の「PDF を Queue で作る」へ戻す変更がここで落ちる。
   */
  it.each(PIN_CARRYING_FILES)("%s が PDF 生成キューへ送らない", (relativePath) => {
    expect(code(join(WEB, relativePath)).includes("QUEUE_PDF_GENERATION")).toBe(false);
  });

  it("`packages/pdf` が QR を持ち込んでいない", () => {
    const pdfSources = walk(join(ROOT, "packages", "pdf", "src"));
    for (const path of pdfSources) {
      expect(/\bqr\b/i.test(code(path)), path).toBe(false);
    }
  });
});
