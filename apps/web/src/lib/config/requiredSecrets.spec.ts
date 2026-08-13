/**
 * 必須 secret の検査（P2-06 の追補）。
 *
 * 見ているのは 2 つ。
 *   - 「設定したつもり」（空文字・空白）を**揃っている扱いにしない**
 *   - **値を外へ出さない**（名前と直し方だけ）
 */

import type { Env } from "@pk/db";
import { describe, expect, it } from "vitest";

import {
  REQUIRED_SECRETS,
  missingSecretNames,
  missingSecretsMessage,
} from "./requiredSecrets.js";

/** 揃っている env。 */
function fullEnv(): Partial<Env> {
  return { SESSION_SECRET: "dev-only-session-secret-change-me" };
}

describe("missingSecretNames", () => {
  it("揃っていれば空", () => {
    expect(missingSecretNames(fullEnv())).toEqual([]);
  });

  it("未定義は足りない", () => {
    expect(missingSecretNames({})).toEqual(["SESSION_SECRET"]);
  });

  it("空文字は足りない（`.dev.vars` が無いときの実際の値）", () => {
    expect(missingSecretNames({ SESSION_SECRET: "" })).toEqual(["SESSION_SECRET"]);
  });

  it("空白だけも足りない（HMAC の鍵としては通ってしまう）", () => {
    expect(missingSecretNames({ SESSION_SECRET: "   " })).toEqual(["SESSION_SECRET"]);
  });

  it("文字列でない値も足りない", () => {
    expect(missingSecretNames({ SESSION_SECRET: 0 as unknown as string })).toEqual([
      "SESSION_SECRET",
    ]);
  });

  it("**任意の secret を必須にしていない**（使う task が足す）", () => {
    // `RESEND_API_KEY` / `CREDENTIAL_ENCRYPTION_KEY` / `SENTRY_DSN` が
    // 空でも起動できること。前倒しで必須にすると、その機能を使わない
    // 開発者の環境が理由なく止まる。
    const names = REQUIRED_SECRETS.map((secret) => secret.name);
    expect(names).toEqual(["SESSION_SECRET"]);
    expect(missingSecretNames({ ...fullEnv(), RESEND_API_KEY: "", SENTRY_DSN: "" })).toEqual([]);
  });
});

describe("missingSecretsMessage", () => {
  it("名前と直し方を出す", () => {
    const message = missingSecretsMessage(["SESSION_SECRET"]);
    expect(message).toContain("SESSION_SECRET");
    expect(message).toContain("cp apps/web/.dev.vars.example apps/web/.dev.vars");
    expect(message).toContain("wrangler secret put");
  });

  it("**値を出さない**", () => {
    // 引数に名前しか渡らない形にしてある（値を受け取る口が無い）。
    expect(missingSecretsMessage.length).toBe(1);
    expect(missingSecretsMessage(["SESSION_SECRET"])).not.toContain("change-me");
  });
});
