/**
 * 品目コードの語彙が食い違わないこと（DECISIONS #252）。
 *
 * ── なぜ `apps/web` に在るか ─────────────────────────────
 * 突き合わせる 3 つ（`@pk/db` / `@pk/contracts` / `@pk/engine`）を同時に
 * 読めるのはここだけ。**`packages/engine` は依存ゼロ**（CLAUDE.md §5）で
 * `@pk/db` を読めず、`packages/db` は `@pk/engine` に依存しない。
 *
 * ── 何を守っているか ────────────────────────────────────
 * 1. `ITEM_CODES` は **`packages/db` と `packages/contracts` に二重定義**
 *    されている。片方だけに足すと**黙って食い違い**、保存はできるのに
 *    契約が弾く（またはその逆）状態になる。
 * 2. `OBSERVATION_ITEM_COLUMNS` は観察記録の列を品目コードへ写す。
 *    **語彙に無いコードを書くと、集計側の `vocabulary` に弾かれて
 *    黙って標本が消える**（`baselineSamples.ts` の `push()`）。
 * 3. W-20 は `ITEM_CODES` を全件トグルに並べ、M-05b / M-06 は
 *    `m.obs.item.{code}` を引く。**鍵が無いと画面に出せない。**
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AMENITY_ITEM_CODES as CONTRACT_AMENITY_ITEM_CODES,
  ITEM_CODES as CONTRACT_ITEM_CODES,
  LINEN_ITEM_CODES as CONTRACT_LINEN_ITEM_CODES,
} from "@pk/contracts";
import { AMENITY_ITEM_CODES, ITEM_CODES, LINEN_ITEM_CODES } from "@pk/db";
import { ALWAYS_CONSUMED_ITEM_CODES, OBSERVATION_ITEM_COLUMNS } from "@pk/engine";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

describe("品目コードの語彙", () => {
  it("**`packages/db` と `packages/contracts` が一致する**（並びも）", () => {
    expect([...CONTRACT_LINEN_ITEM_CODES]).toEqual([...LINEN_ITEM_CODES]);
    expect([...CONTRACT_AMENITY_ITEM_CODES]).toEqual([...AMENITY_ITEM_CODES]);
    expect([...CONTRACT_ITEM_CODES]).toEqual([...ITEM_CODES]);
  });

  it("重複が無い", () => {
    expect(new Set(ITEM_CODES).size).toBe(ITEM_CODES.length);
  });

  it("`CUP` はアメニティ、`EXTRA_FUTON` はリネン（#061 の解決）", () => {
    expect(AMENITY_ITEM_CODES as readonly string[]).toContain("CUP");
    expect(LINEN_ITEM_CODES as readonly string[]).toContain("EXTRA_FUTON");
  });
});

describe("観察記録の列 → 品目コードの写像", () => {
  it("**写像の itemCode はすべて語彙に在る**（綴り違いで標本が消えない）", () => {
    for (const mapping of OBSERVATION_ITEM_COLUMNS) {
      expect(ITEM_CODES as readonly string[], mapping.itemCode).toContain(mapping.itemCode);
    }
  });

  it("`cupsUsed` / `extraFutonUsed` が写像を持つ（#061 の解決）", () => {
    const byColumn = new Map(OBSERVATION_ITEM_COLUMNS.map((m) => [m.column, m.itemCode]));
    expect(byColumn.get("cupsUsed")).toBe("CUP");
    expect(byColumn.get("extraFutonUsed")).toBe("EXTRA_FUTON");
  });
});

describe("除外ルール①の一覧（#058）", () => {
  it("**綴りがすべて語彙に在る**", () => {
    for (const code of ALWAYS_CONSUMED_ITEM_CODES) {
      expect(ITEM_CODES as readonly string[], code).toContain(code);
    }
  });

  it("**`EXTRA_FUTON` は一覧に入っていない**（0 が通常の状態）", () => {
    expect(ALWAYS_CONSUMED_ITEM_CODES as readonly string[]).not.toContain("EXTRA_FUTON");
  });

  it("**`FACE_TOWEL` も入っていない**（P4-08 で 0 の出方を見てから判断する）", () => {
    expect(ALWAYS_CONSUMED_ITEM_CODES as readonly string[]).not.toContain("FACE_TOWEL");
  });

  it("アメニティは 1 種も入っていない", () => {
    for (const code of AMENITY_ITEM_CODES) {
      expect(ALWAYS_CONSUMED_ITEM_CODES as readonly string[], code).not.toContain(code);
    }
  });
});

describe("i18n", () => {
  const ja = JSON.parse(
    readFileSync(join(ROOT, "apps", "web", "src", "locales", "ja.json"), "utf8"),
  ) as Record<string, string>;

  it("**すべての品目コードに `m.obs.item.*` がある**（M-05b / M-06）", () => {
    for (const code of ITEM_CODES) {
      expect(ja[`m.obs.item.${code}`], code).toBeTruthy();
    }
  });

  it("**すべての品目コードに `obs.item.*` がある**（W-20 / W-22）", () => {
    for (const code of ITEM_CODES) {
      expect(ja[`obs.item.${code}`], code).toBeTruthy();
    }
  });
});
