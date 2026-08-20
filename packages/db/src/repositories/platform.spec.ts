/**
 * プラットフォーム運営の分離を機械的に押さえる（PF-01 / DECISIONS #220）。
 *
 * ここが見るのは**集合が交わっていないこと**だけ。
 *
 *   1. 運営面のリポジトリが `getTenantDb()` を呼んでいない
 *   2. テナント面のリポジトリが `platform_*` を読んでいない
 *   3. `platform_audit_log` に UPDATE / DELETE が無い（INV-30 と同じ扱い）
 *
 * **どれか 1 つでも破れると #220 の前提が崩れる。** 運営画面はテナント横断で、
 * 交わりを許した瞬間に architecture.md §3（横断の集計を書かない）か
 * security.md §2（全シャード走査の禁止）のどちらかを破る経路ができる。
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** コメントを落としたリポジトリの実装（走査の誤検出を避ける）。 */
function repositorySources(): { file: string; code: string }[] {
  const directory = dirname(fileURLToPath(import.meta.url));
  return readdirSync(directory)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
    .map((file) => ({
      file,
      code: readFileSync(join(directory, file), "utf8")
        .split("\n")
        .filter((line) => {
          const trimmed = line.trimStart();
          return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
        })
        .join("\n"),
    }));
}

describe("運営面とテナント面を交わらせない（DECISIONS #220）", () => {
  it("運営面のリポジトリが getTenantDb() を呼ばない", () => {
    const platform = repositorySources().filter(({ file }) => file === "platform.ts");
    expect(platform).toHaveLength(1);
    expect(platform.filter(({ code }) => /getTenantDb\s*\(/.test(code))).toEqual([]);
  });

  it("運営面のリポジトリが TenantContext を受け取らない", () => {
    // テナントの文脈を受け取ると、そこから組織 ID が入り込む。
    // 運営担当者はどの組織にも属さない（#220 の 3）。
    const platform = repositorySources().filter(({ file }) => file === "platform.ts");
    expect(platform.filter(({ code }) => /TenantContext/.test(code))).toEqual([]);
  });

  it("テナント面のリポジトリが platform_* を読まない", () => {
    const offenders = repositorySources().filter(
      ({ file, code }) =>
        file !== "platform.ts" &&
        (/platformOperator\b/.test(code) ||
          /platformAuditLog\b/.test(code) ||
          /getPlatformDb\s*\(/.test(code)),
    );
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });
});

describe("運営の操作記録は足すだけ（INV-30 と同じ扱い）", () => {
  it("platform_audit_log を UPDATE / DELETE するリポジトリ関数が無い", () => {
    const offenders = repositorySources().filter(
      ({ code }) =>
        /\.update\(\s*platformAuditLog/.test(code) || /\.delete\(\s*platformAuditLog/.test(code),
    );
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  it("platform_audit_log を対象にした SQL の update / delete が無い", () => {
    const offenders = repositorySources().filter(({ code }) =>
      /(update|delete\s+from)\s+["`']?platform_audit_log/i.test(code),
    );
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });
});
