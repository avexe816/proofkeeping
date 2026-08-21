/**
 * 社内向け運用文書（PK-SPEC-P7 §7.2 / P7-16）。
 *
 * task:  docs/tasks/P7-16.md
 * ルール: .claude/rules/ui-writing.md §2
 *
 * ── 何を機械で見るか ────────────────────────────────────
 * 手順書の**正しさ**は機械で見られない。見られるのは
 * 「§7.2 の 7 文書が揃っているか」「電子帳簿保存法の備付け要件に
 * 答えているか」「実装に無いものを『ある』と書いていないか」の 3 つ。
 *
 * **3 つ目が重要。** 手順書が実態より進んでいると、障害の最中に
 * 嘘を読むことになる。参照先のコマンド・スクリプトが実在することを
 * 突き合わせる。
 *
 * 完了条件のもう 1 つ（「障害対応手順で実際に対応できた」）は
 * **人が確かめる**（P7-14 の復旧訓練と同じ性質）。ここでは見ない。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { forbiddenHits } from "./vocabulary.js";

const ROOT = join(import.meta.dirname, "..", "..");
const RUNBOOK = join(ROOT, "docs", "runbook");

function read(name: string): string {
  return readFileSync(join(RUNBOOK, name), "utf8");
}

/** §7.2 の 7 文書。 */
const DOCUMENTS = [
  { file: "system-overview.md", title: "システム概要書" },
  { file: "architecture.md", title: "アーキテクチャ図" },
  { file: "incident-response.md", title: "障害対応手順" },
  { file: "shard-move.md", title: "シャード移送手順" },
  { file: "recovery.md", title: "復旧手順" },
  { file: "deploy.md", title: "デプロイ手順" },
  { file: "oncall.md", title: "オンコール体制" },
] as const;

/**
 * §7.2 の 7 文書には無いが、`docs/runbook` に置く手順書。
 *
 * **7 文書の枠を増やさない。** §7.2 が数えているのは「GA の完了条件と
 * しての 7 文書」で、後から生えた個別の手順をそこへ混ぜると、
 * 完了条件が実装の都合で動く。索引と禁止語の検査は同じように当てる。
 */
const EXTRA_DOCUMENTS = [
  { file: "platform-bootstrap.md", title: "運営担当者の初期開通" },
  { file: "smtp.md", title: "メール送信（Lark Mail SMTP）" },
] as const;

describe("§7.2 の 7 文書", () => {
  it("7 件ある", () => {
    expect(DOCUMENTS).toHaveLength(7);
  });

  it("すべて実在し、中身が空でない", () => {
    for (const { file } of DOCUMENTS) {
      expect(read(file).trim().length).toBeGreaterThan(500);
    }
  });

  it("索引（README）が 7 件すべてを指している", () => {
    const index = read("README.md");
    for (const { file, title } of DOCUMENTS) {
      expect(index).toContain(`(${file})`);
      expect(index).toContain(title);
    }
  });

  it("docs/runbook に索引されていない文書を置いていない", () => {
    const placed = readdirSync(RUNBOOK).sort();
    expect(placed).toEqual(
      [
        "README.md",
        ...DOCUMENTS.map((d) => d.file),
        ...EXTRA_DOCUMENTS.map((d) => d.file),
      ].sort(),
    );
  });
});

describe("§7.2 の枠外の手順書（索引と検査は同じに当てる）", () => {
  it("すべて実在し、中身が空でない", () => {
    for (const { file } of EXTRA_DOCUMENTS) {
      expect(read(file).trim().length).toBeGreaterThan(500);
    }
  });

  it("索引（README）が指している", () => {
    const index = read("README.md");
    for (const { file, title } of EXTRA_DOCUMENTS) {
      expect(index).toContain(`(${file})`);
      expect(index).toContain(title);
    }
  });
});

/**
 * 電子帳簿保存法の備付け要件（完了条件 1）。
 *
 * 求められるのは 4 種（システム概要書 / システム仕様書 / 操作説明書 /
 * 事務処理マニュアル）。**4 種すべての所在が本書から辿れること**を見る。
 */
describe("システム概要書が備付け要件に答えている", () => {
  const body = read("system-overview.md");

  it("備付け 4 書類の対応表がある", () => {
    for (const kind of [
      "システム概要書",
      "システム仕様書",
      "操作説明書",
      "事務処理マニュアル",
    ]) {
      expect(body).toContain(kind);
    }
  });

  it("対応表が指す文書が実在する", () => {
    const referenced = [
      ["docs", "PK-SPEC-P0.md"],
      ["docs", "PK-IMPL-CONTRACT.md"],
      ["docs", "guides", "admin-manual.md"],
      ["docs", "guides", "getting-started.md"],
      ["docs", "PK-API.md"],
      ["docs", "runbook", "architecture.md"],
    ];
    for (const parts of referenced) {
      expect(readFileSync(join(ROOT, ...parts), "utf8").length).toBeGreaterThan(0);
    }
  });

  it("真実性の確保（訂正・削除の履歴が残る方式）を書いている", () => {
    expect(body).toContain("訂正・削除の履歴が残るシステム");
    expect(body).toContain("外部タイムスタンプは導入していない");
  });

  it("可視性の確保（3 項目での検索）を書いている", () => {
    for (const column of ["issueDate", "totalAmount", "counterpartyName"]) {
      expect(body).toContain(column);
    }
  });

  it("事務手続（入力・訂正・保存期間・障害時）の節がある", () => {
    for (const heading of [
      "### 5.2 入力の手続",
      "### 5.3 訂正・削除の手続",
      "### 5.4 保存期間",
      "### 5.5 障害時の取扱い",
    ]) {
      expect(body).toContain(heading);
    }
  });
});

/**
 * 手順書が実装より先に進んでいないこと。
 *
 * **参照するコマンドが実在すること**を package.json と突き合わせる。
 * 存在しない `pnpm` script を手順書に書くと、障害の最中に詰まる。
 */
describe("手順書が実在するものだけを指している", () => {
  const scripts = Object.keys(
    (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, unknown> })
      .scripts,
  );

  const REFERENCED = ["db:migrate", "shards:usage", "shards:move"] as const;

  it("手順書が使う pnpm script がすべて定義されている", () => {
    for (const name of REFERENCED) {
      expect(scripts).toContain(name);
    }
  });

  for (const name of REFERENCED) {
    it(`\`pnpm ${name}\` を指す手順書がある`, () => {
      const mentioned = readdirSync(RUNBOOK).some((file) => read(file).includes(`pnpm ${name}`));
      expect(mentioned).toBe(true);
    });
  }

  it("移送手順が §4.4 の 6 手順すべてに触れている", () => {
    const body = read("shard-move.md");
    for (const step of ["①", "②", "③", "④", "⑤", "⑥"]) {
      expect(body).toContain(step);
    }
  });

  it("復旧手順が D1 Time Travel と R2 バージョニングの両方を扱う", () => {
    const body = read("recovery.md");
    expect(body).toContain("Time Travel");
    expect(body).toContain("バージョニング");
    expect(body).toContain("RPO");
    expect(body).toContain("RTO");
  });

  it("**まだ無いもの**を「ある」と書いていない（未整備の一覧がある）", () => {
    expect(read("deploy.md")).toContain("## 7. まだ整っていないこと");
  });

  it("実在しない連絡先を書いていない（枠は未記入のまま）", () => {
    expect(read("oncall.md")).toContain("（未記入）");
  });
});

describe("障害対応手順", () => {
  const body = read("incident-response.md");

  it("症状から入る構成になっている", () => {
    expect(body).toContain("## 2. 症状別");
  });

  it("縮退運転の優先度 7 段を載せている（§5.2）", () => {
    for (const priority of [1, 2, 3, 4, 5, 6, 7]) {
      expect(body).toContain(`| ${String(priority)} |`);
    }
  });

  it("schemaVersion 不一致を 4xx で塞がないよう注意している", () => {
    expect(body).toContain("4xx で塞がないこと");
  });

  it("優先度と応答目標（§8.2）を載せている", () => {
    for (const level of ["P1", "P2", "P3", "P4"]) {
      expect(body).toContain(`| ${level} |`);
    }
  });
});

describe("運用文書の語彙", () => {
  for (const file of readdirSync(RUNBOOK).sort()) {
    it(`${file} に §2 の語を含まない`, () => {
      expect(forbiddenHits(read(file))).toEqual([]);
    });
  }
});
