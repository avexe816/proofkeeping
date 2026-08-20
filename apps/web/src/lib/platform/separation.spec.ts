/**
 * 運営面とテナント面の分離（PF-01 / DECISIONS #220）。
 *
 * task: docs/tasks/PF-01.md
 * 契約: docs/PK-IMPL-CONTRACT.md INV-10
 *
 * ── なぜソースを読むのか ────────────────────────────────
 * 確かめたいのは「**この経路が存在しないこと**」で、実行しても現れない
 * （`routes/app/staffScreen.spec.ts` / `repositories/platform.spec.ts` と
 * 同じ作り）。`repositories/platform.spec.ts` が DB 層を見ているので、
 * ここは **`apps/web` 側の両方向**を見る。
 *
 *   1. 運営面（`lib/platform` / `routes/plat`）がテナントの DB・文脈・
 *      セッションに触れていない
 *   2. テナント面（`routes/app` / `routes/m` / `routes/api` / `consumers` /
 *      `lib` / `middleware`）が `platform_*` に触れていない
 *
 * 「テナントのセッションで `/plat/*` に入れない」ことは、Cookie 名と
 * KV の接頭辞が交わらないこと（下の 2 件）＋ `requirePlatformOperator()` が
 * `pk_plat_session` しか読まないことで成立する。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "../auth/cookie.js";

import { PLATFORM_SESSION_COOKIE_NAME, readPlatformSessionCookie } from "./session.js";

const SRC_ROOT = join(import.meta.dirname, "..", "..");

/** ディレクトリ以下の実装ソース（`.spec` を除く `.ts` / `.tsx`）を列挙する。 */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(path));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.spec\.tsx?$/.test(entry.name)) continue;
    found.push(path);
  }
  return found;
}

/**
 * コメントを落とす。**禁止事項を説明した doc コメント自体が検査に
 * 引っ掛かる**ため（`staffScreen.spec.ts` の `CODE` と同じ理由）。
 */
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return (
        !trimmed.startsWith("*") &&
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("/*") &&
        !trimmed.startsWith("{/*")
      );
    })
    .join("\n");
}

function sourcesUnder(...dirs: readonly string[]): { path: string; code: string }[] {
  return dirs
    .flatMap((dir) => walk(join(SRC_ROOT, dir)))
    .map((path) => ({ path, code: stripComments(readFileSync(path, "utf8")) }));
}

/** 運営面の全ソース。 */
const PLATFORM_SOURCES = sourcesUnder("lib/platform", "routes/plat");

/** テナント面の全ソース。`lib/platform` は運営面なので除く。 */
const TENANT_SOURCES = sourcesUnder(
  "routes/app",
  "routes/m",
  "routes/api",
  "consumers",
  "lib",
  "middleware",
).filter((entry) => !entry.path.includes(join("lib", "platform")));

describe("運営面とテナント面の分離（#220）", () => {
  it("運営面がテナントの DB・文脈・セッションに触れていない", () => {
    expect(PLATFORM_SOURCES.length).toBeGreaterThan(0);
    for (const { path, code } of PLATFORM_SOURCES) {
      for (const forbidden of [
        "getTenantDb",
        "resolveShard",
        "TenantContext",
        "requireSession",
        "assertPermission",
        "recordAudit(",
        // **`SESSION_COOKIE_NAME` は見ない。** `PLATFORM_SESSION_COOKIE_NAME` が
        // 部分一致してしまう。Cookie 名そのもの（`pk_session`）で見る。
        "pk_session",
      ]) {
        expect(code, `${path} が ${forbidden} に触れている`).not.toContain(forbidden);
      }
    }
  });

  it("テナント面が運営の表・セッションに触れていない", () => {
    expect(TENANT_SOURCES.length).toBeGreaterThan(0);
    for (const { path, code } of TENANT_SOURCES) {
      for (const forbidden of [
        "getPlatformDb",
        "platformOperator",
        "platformAuditLog",
        "recordPlatformAudit",
        "requirePlatformOperator",
        "pk_plat_session",
      ]) {
        expect(code, `${path} が ${forbidden} に触れている`).not.toContain(forbidden);
      }
    }
  });

  it("Cookie 名が交わらない", () => {
    expect(PLATFORM_SESSION_COOKIE_NAME).toBe("pk_plat_session");
    expect(PLATFORM_SESSION_COOKIE_NAME).not.toBe(SESSION_COOKIE_NAME);
  });

  it("テナントの Cookie だけを持つ要求は運営面で「セッションが無い」", () => {
    // `pk_session` しか無い Cookie ヘッダ → 運営面では未ログイン（= 404）。
    expect(readPlatformSessionCookie(`${SESSION_COOKIE_NAME}=abc.def`)).toBeNull();
    expect(readPlatformSessionCookie(null)).toBeNull();
  });
});
