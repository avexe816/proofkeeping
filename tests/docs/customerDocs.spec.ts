/**
 * 顧客向けドキュメント（PK-SPEC-P7 §7.1 / P7-15）。
 *
 * task:  docs/tasks/P7-15.md
 * ルール: .claude/rules/ui-writing.md §2
 *
 * ── 文書を CI で押さえる理由 ────────────────────────────
 * §7.1 の MUST は「清掃スタッフ向けガイドは **A4 1 枚**に収める」。
 * 1 枚に収まっているかは印刷しないと分からない——ように見えるが、
 * 収まらなくなる原因はほぼ「項目を足した」の 1 つに絞れる。
 * **手順の数と本文の分量に上限を置けば、こぼれる前に落とせる。**
 *
 * 同じ理由で、FAQ の 30 項目・索引の 7 文書・語彙の規則も機械で見る。
 * 文書は放っておくと実装より先に古くなる。
 *
 * ── HTML のコメントを対象にしない ───────────────────────
 * 印刷される紙に出ない。逆に、**なぜその語を避けるのか**を書き残すには
 * コメントしか無い（`forbidden-words-list.js` を `--include` から外して
 * あるのと同じ事情 / .github/workflows/ci.yml）。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FORBIDDEN } from "../../packages/config/eslint/rules/forbidden-words-list.js";
import { PROSE_FORBIDDEN, forbiddenHits, prose } from "./vocabulary.js";

const ROOT = join(import.meta.dirname, "..", "..");
const GUIDES = join(ROOT, "docs", "guides");

function read(name: string): string {
  return readFileSync(join(GUIDES, name), "utf8");
}

/** §7.1 の 7 文書。**API リファレンスだけ docs/ 直下**（P6-15 が置いた）。 */
const DOCUMENTS = [
  { file: "getting-started.md", title: "はじめかたガイド" },
  { file: "cleaner-guide.html", title: "清掃スタッフ向け操作ガイド" },
  { file: "inspector-guide.html", title: "検査担当者向けガイド" },
  { file: "admin-manual.md", title: "管理者マニュアル" },
  { file: "finding-report-reading.md", title: "差異レポートの読み方" },
  { file: "faq.md", title: "よくある質問" },
  { file: "../PK-API.md", title: "公開 API リファレンス" },
] as const;

describe("§7.1 の 7 文書", () => {
  it("7 件ある", () => {
    expect(DOCUMENTS).toHaveLength(7);
  });

  it("すべて実在し、中身が空でない", () => {
    for (const { file } of DOCUMENTS) {
      expect(read(file).trim().length).toBeGreaterThan(200);
    }
  });

  it("索引（README）が 7 件すべてを指している", () => {
    const index = read("README.md");
    for (const { file, title } of DOCUMENTS) {
      expect(index).toContain(`(${file})`);
      expect(index).toContain(title);
    }
  });

  it("docs/guides に索引されていない文書を置いていない", () => {
    const placed = readdirSync(GUIDES).sort();
    const expected = ["README.md", ...DOCUMENTS.map((d) => d.file).filter((f) => !f.startsWith(".."))].sort();
    expect(placed).toEqual(expected);
  });
});

/**
 * A4 1 枚（§7.1 MUST）。
 *
 * 収まりを決めるのは「紙の寸法」「手順の数」「本文の分量」の 3 つ。
 * **3 つとも見る。** 寸法だけだと項目を足したときに素通りする。
 */
describe("印刷用ガイドが A4 1 枚に収まる", () => {
  /** 8 手順 × 2 パネルで組んである。増やすと 2 枚目にこぼれる。 */
  const MAX_STEPS = 8;
  /** 1 枚あたりの本文（タグを除く）の上限。実測 1,000 字弱に対する余裕込み。 */
  const MAX_CHARS_PER_SHEET = 1400;

  function sheets(source: string): string[] {
    return [...prose(source).matchAll(/<section class="sheet"[\s\S]*?<\/section>/g)].map(
      (match) => match[0],
    );
  }

  function textOf(sheet: string): string {
    return sheet
      .replace(/<svg[\s\S]*?<\/svg>/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, "");
  }

  it("清掃スタッフ向けは 1 言語あたり 1 枚（日英で 2 枚）", () => {
    const source = read("cleaner-guide.html");
    const found = sheets(source);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('lang="ja"');
    expect(found[1]).toContain('lang="en"');
  });

  it("検査担当者向けは 1 枚", () => {
    expect(sheets(read("inspector-guide.html"))).toHaveLength(1);
  });

  for (const file of ["cleaner-guide.html", "inspector-guide.html"] as const) {
    it(`${file} は A4・余白なしで刷れる`, () => {
      const source = read(file);
      expect(source).toMatch(/@page\s*\{[^}]*size:\s*A4/);
      expect(source).toMatch(/width:\s*210mm/);
      expect(source).toMatch(/height:\s*297mm/);
    });

    it(`${file} の 1 枚あたりの分量が上限内`, () => {
      for (const sheet of sheets(read(file))) {
        expect(textOf(sheet).length).toBeLessThanOrEqual(MAX_CHARS_PER_SHEET);
        expect([...sheet.matchAll(/<div class="num">/g)]).toHaveLength(MAX_STEPS);
      }
    });
  }

  it("清掃スタッフ向けは日英で同じ手順数（英語版を要約にしない）", () => {
    const [ja, en] = sheets(read("cleaner-guide.html"));
    expect([...(en ?? "").matchAll(/<div class="num">/g)].length).toBe(
      [...(ja ?? "").matchAll(/<div class="num">/g)].length,
    );
  });
});

describe("よくある質問", () => {
  it("30 項目ある（§7.1）", () => {
    const questions = [...read("faq.md").matchAll(/^### Q(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(questions).toHaveLength(30);
    expect(questions).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });
});

/**
 * 語彙（ui-writing.md §2 / DECISIONS #174）。
 *
 * 表の実体は `tests/docs/vocabulary.ts`。**ここに写経しない。**
 * §5.1 のマイクロコピーを混ぜない理由もそちらに書いてある。
 */
describe("顧客向け文書の語彙", () => {
  const FILES = readdirSync(GUIDES).sort();

  for (const file of FILES) {
    it(`${file} に §2 の語を含まない`, () => {
      expect(forbiddenHits(read(file))).toEqual([]);
    });
  }

  it("表は語彙表の部分集合である（写経していない）", () => {
    const canonical = new Set(FORBIDDEN.map(([word]) => word));
    for (const word of Object.keys(PROSE_FORBIDDEN)) {
      expect(canonical.has(word)).toBe(true);
    }
  });
});

describe("差異レポートの読み方", () => {
  const body = read("finding-report-reading.md");

  it("Audit の有効化条件であることを冒頭で明示している（§7.3 MUST）", () => {
    expect(body.slice(0, 800)).toContain("Audit モジュールの利用条件");
  });

  it("人事上の措置に使わないことを書いている", () => {
    expect(body).toContain("人事上の措置に直接使用しないでください");
  });

  it("現場スタッフへの説明のしかたを載せている", () => {
    expect(body).toContain("現場スタッフへの説明方法");
  });
});
