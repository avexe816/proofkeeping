/**
 * モジュール有効化の同意（P7-15 / PK-SPEC-P7 §7.3 MUST）。
 *
 * ここは 3 つを見る。
 *
 *   1. 判定そのもの（有効化・無効化・版数の照合）
 *   2. **文書の版数がコードと一致していること**
 *      ずれると「同意済みなのに毎回求められる」か「改訂したのに
 *      同意を求め直さない」のどちらかになる
 *   3. **書き込み経路が生えたのに門を通っていないこと**
 *      有効化の実装（P7-04）は未着手で、今は 0 本。
 *      生えた瞬間に落ちる形にしてある
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MODULE_CONSENT_DOCUMENTS,
  ModuleConsentRequiredError,
  assertModuleConsent,
  requiredConsentFor,
} from "./moduleConsent.js";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

const AUDIT_DOCUMENT = MODULE_CONSENT_DOCUMENTS.AUDIT;

function accepted(overrides: Partial<{ documentPath: string; version: string }> = {}) {
  return {
    documentPath: AUDIT_DOCUMENT?.path ?? "",
    version: AUDIT_DOCUMENT?.version ?? "",
    ...overrides,
  };
}

describe("assertModuleConsent", () => {
  it("AUDIT の有効化は同意が無ければ通らない", () => {
    const error = (() => {
      try {
        assertModuleConsent({ moduleCode: "AUDIT", isEnabled: true, accepted: null });
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(ModuleConsentRequiredError);
    expect((error as ModuleConsentRequiredError).code).toBe("MODULE_CONSENT_REQUIRED");
  });

  it("同意があれば通る", () => {
    expect(() => {
      assertModuleConsent({ moduleCode: "AUDIT", isEnabled: true, accepted: accepted() });
    }).not.toThrow();
  });

  it("別の文書への同意では通らない", () => {
    expect(() => {
      assertModuleConsent({
        moduleCode: "AUDIT",
        isEnabled: true,
        accepted: accepted({ documentPath: "docs/guides/faq.md" }),
      });
    }).toThrow(/MODULE_CONSENT_DOCUMENT_MISMATCH/);
  });

  it("古い版への同意では通らない（改訂したら同意を求め直す）", () => {
    expect(() => {
      assertModuleConsent({
        moduleCode: "AUDIT",
        isEnabled: true,
        accepted: accepted({ version: "v0.9" }),
      });
    }).toThrow(/MODULE_CONSENT_VERSION_MISMATCH/);
  });

  it("**無効化は同意が無くても止めない**", () => {
    expect(() => {
      assertModuleConsent({ moduleCode: "AUDIT", isEnabled: false, accepted: null });
    }).not.toThrow();
  });

  it("同意を要さないモジュールは素通しする", () => {
    for (const moduleCode of ["PLATFORM", "HOUSEKEEPING_CORE", "BILLING", "INTEGRATION"] as const) {
      expect(requiredConsentFor(moduleCode)).toBeNull();
      expect(() => {
        assertModuleConsent({ moduleCode, isEnabled: true, accepted: null });
      }).not.toThrow();
    }
  });

  it("同意を要するのは AUDIT だけ（§7.3 は Audit のみを指す）", () => {
    const required = Object.entries(MODULE_CONSENT_DOCUMENTS)
      .filter(([, document]) => document !== null)
      .map(([code]) => code);
    expect(required).toEqual(["AUDIT"]);
  });
});

describe("同意の対象文書", () => {
  it("差異レポートの読み方が実在する", () => {
    expect(AUDIT_DOCUMENT).not.toBeNull();
    const body = readFileSync(join(ROOT, AUDIT_DOCUMENT?.path ?? ""), "utf8");
    expect(body).toContain("# 差異レポートの読み方");
  });

  it("文書の版数とコードの版数が一致する", () => {
    const body = readFileSync(join(ROOT, AUDIT_DOCUMENT?.path ?? ""), "utf8");
    const match = /^\*\*版\*\*:\s*(v[\d.]+)/m.exec(body);
    expect(match?.[1]).toBe(AUDIT_DOCUMENT?.version);
  });

  it("§7.3 の 7 要点がすべて節として置かれている", () => {
    const body = readFileSync(join(ROOT, AUDIT_DOCUMENT?.path ?? ""), "utf8");
    for (let section = 1; section <= 7; section++) {
      expect(body).toContain(`## ${String(section)}. `);
    }
  });
});

/**
 * 有効化の経路が生えたら、この門を通っていること。
 *
 * **今は書き込みが 0 本なので、この検査は「まだ 0 本である」を固定する。**
 * P7-04 が `module_entitlement` への書き込みを足した時点で、
 * `assertModuleConsent()` を呼ぶまで落ち続ける。
 */
describe("有効化の経路", () => {
  const REPOSITORY_DIR = join(ROOT, "packages", "db", "src", "repositories");

  function sourcesOf(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourcesOf(path);
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".spec.ts")) return [];
      return [path];
    });
  }

  function code(path: string): string {
    return readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
  }

  const writers = sourcesOf(REPOSITORY_DIR).filter((path) =>
    /\.(insert|update|delete)\(\s*moduleEntitlement/.test(code(path)),
  );

  it("`module_entitlement` を書くリポジトリ関数があるなら、同意の門を呼ぶ実装がある", () => {
    if (writers.length === 0) {
      // P7-04 未着手。**この分岐を消さないこと。** 消すと 0 本のあいだ
      // 検査が空振りしていることが読めなくなる。
      expect(writers).toEqual([]);
      return;
    }

    const callers = sourcesOf(join(ROOT, "apps", "web", "src")).filter(
      (path) => !path.endsWith("moduleConsent.ts") && code(path).includes("assertModuleConsent("),
    );
    expect(callers.length).toBeGreaterThan(0);
  });
});
