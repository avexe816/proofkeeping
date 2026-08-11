import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";

/**
 * P0-02 で敷いた wrangler.toml の構成そのものを検証する。
 *
 * wrangler は [env.*] が top-level の binding を継承しないため、環境を 1 つ増やすたびに
 * D1 / R2 / KV / Queue を丸ごと書き写すことになる。写し漏れは `wrangler deploy` して
 * 初めて分かるので、ここで機械的に押さえる。業務ロジックのテストではない。
 */

const ROOT = join(import.meta.dirname, "..", "..");

/** 実在する唯一の D1（docs/tasks/P0-02.md）。 */
const SHARD_00_DATABASE_ID = "547d200a-6f86-41a9-b262-484329d44c59";

const ACCOUNT_ID = "6c8b5b6228c4021c651755d1c5fb53d6";

const R2_BINDINGS = ["PHOTOS", "DOCUMENTS", "EVIDENCE", "ARCHIVE"] as const;

const KV_BINDINGS = ["SESSION", "RATELIMIT", "CONFIG", "CREDENTIALS", "SHARD_MAP"] as const;

/** architecture.md §5 の 7 キュー。 */
const QUEUE_BINDINGS = [
  "QUEUE_PDF_GENERATION",
  "QUEUE_EVIDENCE_EXPORT",
  "QUEUE_RECONCILIATION",
  "QUEUE_ROLLUP_UPDATE",
  "QUEUE_BASELINE_LEARNING",
  "QUEUE_NOTIFICATION",
  "QUEUE_ARCHIVE_RESTORE",
] as const;

/** wrangler.toml に絶対に現れてはいけない名前。secret は `wrangler secret put` で入れる。 */
const SECRET_NAMES = [
  "SESSION_SECRET",
  "RESEND_API_KEY",
  "CREDENTIAL_ENCRYPTION_KEY",
  "SENTRY_DSN",
] as const;

interface D1Entry {
  binding: string;
  database_name: string;
  database_id: string;
}

interface R2Entry {
  binding: string;
  bucket_name: string;
}

interface KvEntry {
  binding: string;
  id: string;
}

interface QueueProducerEntry {
  binding: string;
  queue: string;
}

interface EnvSection {
  name?: string;
  vars?: Record<string, string>;
  d1_databases?: D1Entry[];
  r2_buckets?: R2Entry[];
  kv_namespaces?: KvEntry[];
  queues?: { producers?: QueueProducerEntry[]; consumers?: unknown[] };
  durable_objects?: unknown;
  migrations?: unknown;
}

interface WranglerConfig extends EnvSection {
  main?: string;
  compatibility_date?: string;
  account_id?: string;
  env?: Record<string, EnvSection>;
}

const RAW = readFileSync(join(ROOT, "apps/web/wrangler.toml"), "utf8");
const CONFIG = parse(RAW) as unknown as WranglerConfig;

function envSection(name: string): EnvSection {
  const section = CONFIG.env?.[name];
  if (!section) throw new Error(`[env.${name}] が wrangler.toml に無い`);
  return section;
}

/**
 * PK-SPEC-P0 §9.2 の 4 環境。local は top-level（環境ブロックを持たない）。
 * `shards` は宣言されているべき D1 binding の本数。
 */
const ENVIRONMENTS: ReadonlyArray<{ label: string; section: EnvSection; shards: number }> = [
  { label: "local", section: CONFIG, shards: 1 },
  { label: "preview", section: envSection("preview"), shards: 1 },
  { label: "staging", section: envSection("staging"), shards: 2 },
  { label: "production", section: envSection("production"), shards: 16 },
];

function shardBindingNames(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `SHARD_${String(i).padStart(2, "0")}`);
}

describe("P0-02 wrangler.toml の構成", () => {
  it("エントリポイントと account_id が設定されている", () => {
    expect(CONFIG.main).toBe("src/index.ts");
    expect(CONFIG.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(CONFIG.account_id).toBe(ACCOUNT_ID);
  });

  it("PK-SPEC-P0 §9.2 の 4 環境が揃っている", () => {
    expect(Object.keys(CONFIG.env ?? {}).sort()).toEqual(["preview", "production", "staging"]);
    // local は top-level。vars を持つことで環境として成立している。
    expect(CONFIG.vars?.["ENVIRONMENT"]).toBe("local");
  });

  describe.each(ENVIRONMENTS)("$label", ({ label, section, shards }) => {
    it("D1 binding が SHARD_00 から連番で並ぶ", () => {
      const bindings = (section.d1_databases ?? []).map((entry) => entry.binding);

      // toEqual なので本数・順序・重複なしを同時に見ている。
      expect(bindings).toEqual(shardBindingNames(shards));
    });

    it("D1 binding の本数と vars.SHARD_COUNT が一致する", () => {
      // ここがずれるとルーターが存在しない binding を引き、SHARD_BINDING_MISSING になる。
      expect(section.vars?.["SHARD_COUNT"]).toBe(String(shards));
    });

    it("全シャードが database_name と database_id を持つ", () => {
      for (const entry of section.d1_databases ?? []) {
        expect(entry.database_name, entry.binding).toMatch(
          /^proofkeeping-shard-\d{2}(-staging|-preview)?$/,
        );
        expect(entry.database_id, entry.binding).not.toBe("");
      }
    });

    it("vars に ENVIRONMENT と APP_BASE_URL がある", () => {
      expect(section.vars?.["ENVIRONMENT"]).toBe(label);
      expect(section.vars?.["APP_BASE_URL"]).toBeTypeOf("string");
    });

    it("R2 バケット 4 本が揃う", () => {
      const bindings = (section.r2_buckets ?? []).map((entry) => entry.binding);
      expect(bindings.sort()).toEqual([...R2_BINDINGS].sort());
    });

    it("KV namespace 5 本が揃い、id が binding ごとに一意である", () => {
      const entries = section.kv_namespaces ?? [];

      expect(entries.map((entry) => entry.binding).sort()).toEqual([...KV_BINDINGS].sort());

      // 同じ id を共有すると miniflare のローカルストアが 1 つに混ざる。
      // SHARD_MAP が CONFIG と同じストアに載ると、CONFIG の一括削除で
      // 明示マッピングが消え、テナントのデータが複数シャードに分裂する。
      const ids = entries.map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("SHARD_MAP が CONFIG とは別の namespace として宣言されている", () => {
      const entries = section.kv_namespaces ?? [];
      const shardMap = entries.find((entry) => entry.binding === "SHARD_MAP");
      const config = entries.find((entry) => entry.binding === "CONFIG");

      expect(shardMap?.id, label).toBeTypeOf("string");
      expect(shardMap?.id, label).not.toBe(config?.id);
    });

    it("Queue producer 7 本が揃う", () => {
      const bindings = (section.queues?.producers ?? []).map((entry) => entry.binding);
      expect(bindings.sort()).toEqual([...QUEUE_BINDINGS].sort());
    });

    it("vars に secret 名が混ざっていない", () => {
      for (const secret of SECRET_NAMES) {
        expect(Object.keys(section.vars ?? {}), secret).not.toContain(secret);
      }
    });
  });

  it("production に 16 シャードすべてが宣言されている", () => {
    const production = envSection("production");
    const bindings = (production.d1_databases ?? []).map((entry) => entry.binding);

    expect(bindings).toHaveLength(16);
    expect(bindings.at(-1)).toBe("SHARD_15");
  });

  it("実在する shard-00 の database_id が local と production に入っている", () => {
    for (const label of ["local", "production"] as const) {
      const section = label === "local" ? CONFIG : envSection(label);
      const shard00 = (section.d1_databases ?? []).find((entry) => entry.binding === "SHARD_00");

      expect(shard00?.database_name, label).toBe("proofkeeping-shard-00");
      expect(shard00?.database_id, label).toBe(SHARD_00_DATABASE_ID);
    }
  });

  it("未作成リソースのプレースホルダがパス安全で一意に識別できる", () => {
    // miniflare は KV の id と D1 の database_id を .wrangler/state 配下の
    // ディレクトリ名に使う。空白・コロン・引用符が入るとローカル起動が壊れる。
    const ids = ENVIRONMENTS.flatMap(({ section }) => [
      ...(section.d1_databases ?? []).map((entry) => entry.database_id),
      ...(section.kv_namespaces ?? []).map((entry) => entry.id),
    ]);
    const placeholders = ids.filter((id) => id.startsWith("TODO"));

    // 実 ID が入っているのは shard-00 の 2 本だけ。残りはすべて未作成。
    expect(placeholders).toHaveLength(ids.length - 2);
    for (const placeholder of placeholders) {
      expect(placeholder).toMatch(/^TODO-P0-02-[^\s:"]+$/);
    }
  });

  it("実装のない Queue コンシューマ・Durable Object を宣言していない", () => {
    // 宣言だけ先に置くと queue() ハンドラや DO クラスが無いまま wrangler が起動しない。
    for (const { label, section } of ENVIRONMENTS) {
      expect(section.queues?.consumers, label).toBeUndefined();
      expect(section.durable_objects, label).toBeUndefined();
      expect(section.migrations, label).toBeUndefined();
    }
  });
});
