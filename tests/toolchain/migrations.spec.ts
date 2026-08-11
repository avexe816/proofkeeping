import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 生成済みマイグレーション（P0-06）の形を検証する。
 *
 * `packages/db/src/migrate.spec.ts` は適用ロジックを見る。ここは
 * 「drizzle-kit の出力がランナーの前提を満たしているか」を見る。
 * ここが崩れると `pnpm db:migrate` は実行するまで気づけない。
 */

const ROOT = join(import.meta.dirname, "..", "..");
const MIGRATIONS_DIR = join(ROOT, "packages", "db", "migrations");

/** ランナーの `TAG_PATTERN` と同じ形。SQL へ文字列連結するため形を閉じている。 */
const TAG_PATTERN = /^[0-9]{4}_[a-z0-9_]+$/;

/** 初回マイグレーションで作られる表。schema_version はランナーが作るので含まない。 */
const EXPECTED_TABLES = [
  "audit_log",
  "building",
  "document_sequence",
  "floor",
  "membership",
  "module_entitlement",
  "org_directory",
  "organization",
  "organization_tax_profile",
  "property",
  "property_assignment",
  "room",
  "room_type",
  "subscription",
  "user",
] as const;

interface Journal {
  entries: Array<{ idx: number; tag: string }>;
}

function readJournal(): Journal {
  return JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as Journal;
}

function readSql(tag: string): string {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
}

describe("P0-06 マイグレーション", () => {
  it("journal の全 tag に対応する .sql がある", () => {
    const files = new Set(readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")));

    for (const entry of readJournal().entries) {
      expect(files.has(`${entry.tag}.sql`), entry.tag).toBe(true);
    }
    // 逆向き: journal に載っていない .sql を置くと、適用されないまま残る。
    expect(files.size).toBe(readJournal().entries.length);
  });

  it("全 tag がランナーの受け付ける形である", () => {
    for (const entry of readJournal().entries) {
      expect(entry.tag).toMatch(TAG_PATTERN);
    }
  });

  it("journal の idx が 0 から連番である", () => {
    const entries = readJournal().entries;

    expect(entries.map((entry) => entry.idx)).toEqual(entries.map((_, index) => index));
  });

  it("初回マイグレーションが 15 テーブルすべてを作る", () => {
    const sql = readSql("0000_p0_initial");

    for (const table of EXPECTED_TABLES) {
      expect(sql, table).toContain(`CREATE TABLE \`${table}\``);
    }
    expect(sql.match(/CREATE TABLE/g)?.length).toBe(EXPECTED_TABLES.length);
  });

  it("schema_version を生成物に含めない", () => {
    // ランナーが CREATE TABLE IF NOT EXISTS で作る。ここに含めると衝突する
    // （packages/db/src/schema/meta.ts の注記）。
    expect(readSql("0000_p0_initial")).not.toContain("`schema_version`");
  });

  it("全業務テーブルに organization_id 列がある", () => {
    // PK-SPEC-P0 §19.5。org_directory は全局テーブルなので対象外。
    const sql = readSql("0000_p0_initial");
    const statements = sql.split("CREATE TABLE").slice(1);

    for (const statement of statements) {
      const name = /^ `?([a-z_]+)`?/.exec(statement)?.[1] ?? statement.slice(0, 20);
      if (name === "org_directory") continue;

      expect(statement, name).toContain("`organization_id` text NOT NULL");
    }
  });

  it("破壊的な文を含まない", () => {
    // architecture.md §6: 後方互換のみ。列の削除・リネーム・型変更を
    // 単一リリースで行わない。DROP / RENAME が現れたら 3 段階手順の検討が要る。
    for (const entry of readJournal().entries) {
      const sql = readSql(entry.tag);

      expect(sql, entry.tag).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
      expect(sql, entry.tag).not.toMatch(/\bRENAME\s+(TO|COLUMN)\b/i);
    }
  });
});
