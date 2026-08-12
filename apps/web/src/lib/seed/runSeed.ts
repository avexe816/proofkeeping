/**
 * シードの実行口。**`hashPin()` / `hashPassword()` を束ねるだけ。**
 *
 * task: docs/tasks/P0-18.md
 *
 * 投入の中身は `packages/db/src/seed.ts`（名前は docs/DECISIONS.md #009 が指定）。
 * `packages/*` から `apps/*` を import できないため、ハッシュ化の実装は
 * ここから注入する。**PBKDF2 をシード用に書き直さないこと。**
 *
 * ── 実行の経路がまだ無い ────────────────────────────────
 * `pnpm db:seed` を配線していない。シードは Workers の binding
 * （D1 / KV）を要求し、実在するのは D1 の shard-00 だけ（P0-02 が未完）。
 * bindings が揃った時点で `wrangler dev` から呼べる入口を足すこと。
 * **node から直に叩ける形にはならない**（`apps/web` の相対 import は
 * `.js` 指定子で書かれており、node の型剥がしでは解決できない）。
 */

import { seed, type Env, type SeedCredentials, type SeedResult } from "@pk/db";

import { hashPassword } from "../auth/password.js";
import { hashPin } from "../auth/pin.js";

/**
 * シードを投入する。
 *
 * `credentials.ownerPassword` に既定値を持たない。**シードに固定の
 * パスワードを埋め込むと、そのまま preview 環境に残る。**
 */
export async function runSeed(
  env: Env,
  credentials: SeedCredentials,
  now: Date,
): Promise<SeedResult> {
  return seed(
    env,
    {
      hashPassword: (password) => hashPassword(password),
      hashPin: (pin) => hashPin(pin),
    },
    credentials,
    now,
  );
}
