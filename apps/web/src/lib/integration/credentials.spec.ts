/**
 * 資格情報の暗号化保管（P6-02 / PK-SPEC-P6 §2.1）。
 *
 * ルール: .claude/rules/security.md §7
 * 仕様の受け入れ基準: §8.5「認証情報が KV に暗号化保存され、DB に平文がない」
 *
 * ── 見ているもの ────────────────────────────────────────
 *   **KV に置かれた値に平文が現れない**
 *   往復（暗号化 → 復号）で元に戻る
 *   **TTL を付けない**（失効すると連携が静かに壊れる）
 *   参照キーの越境は `NotFoundError`（KV を引く前に落ちる）
 *   暗号文を別のキーへ移し替えても復号できない（AAD）
 *   鍵が違えば `null`（例外にしない）
 *   鍵が未設定・長さ違いなら保存そのものを失敗させる
 */

import { NotFoundError, type Env } from "@pk/db";
import { describe, expect, it } from "vitest";

import {
  assertCredentialRefBelongsToTenant,
  credentialRefFor,
  deleteCredential,
  getCredential,
  putCredential,
} from "./credentials.js";

const ORG = { orgShortId: "a1b2c3", now: new Date("2026-09-10T02:00:00.000Z") };
const OTHER_ORG = { orgShortId: "z9y8x7", now: ORG.now };
const INTEGRATION_ID = "a1b2c3__intg_01JBXQ3ZK8N4P2VYR6ABCDEFGH";
const OTHER_INTEGRATION_ID = "z9y8x7__intg_01JBXQ3ZK8N4P2VYR6ABCDEFGH";

/** 32 バイトの鍵（base64url）。 */
const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";

/** 記録つきの偽 KV。**`put` の第 3 引数（TTL）を見るために持つ。** */
function fakeKv(): {
  namespace: KVNamespace;
  store: Map<string, string>;
  puts: { key: string; options: unknown }[];
  deletes: string[];
} {
  const store = new Map<string, string>();
  const puts: { key: string; options: unknown }[] = [];
  const deletes: string[] = [];
  const namespace = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string, options?: unknown) => {
      store.set(key, value);
      puts.push({ key, options });
      return Promise.resolve();
    },
    delete: (key: string) => {
      store.delete(key);
      deletes.push(key);
      return Promise.resolve();
    },
  } as unknown as KVNamespace;
  return { namespace, store, puts, deletes };
}

function envWith(kv: ReturnType<typeof fakeKv>, key: string = KEY): Env {
  return { CREDENTIALS: kv.namespace, CREDENTIAL_ENCRYPTION_KEY: key } as unknown as Env;
}

describe("credentialRefFor（参照キー）", () => {
  it("組織と連携と枠を含む", () => {
    expect(credentialRefFor(ORG, INTEGRATION_ID, "WEBHOOK")).toBe(
      `cred:a1b2c3:${INTEGRATION_ID}:WEBHOOK`,
    );
  });

  it("別組織の連携 ID では組み立てられない", () => {
    expect(() => credentialRefFor(ORG, OTHER_INTEGRATION_ID, "API")).toThrow(NotFoundError);
  });
});

describe("assertCredentialRefBelongsToTenant（第 2 層と同じ考え方）", () => {
  it("自組織の参照キーは通る", () => {
    expect(() => {
      assertCredentialRefBelongsToTenant(`cred:a1b2c3:${INTEGRATION_ID}:API`, ORG);
    }).not.toThrow();
  });

  it("**別組織の参照キーは 404**（403 にしない）", () => {
    expect(() => {
      assertCredentialRefBelongsToTenant(`cred:z9y8x7:${OTHER_INTEGRATION_ID}:API`, ORG);
    }).toThrow(NotFoundError);
  });

  it("組織部だけ書き換えた参照キーを通さない", () => {
    // `cred:a1b2c3:z9y8x7__intg_...` のような細工。**両方を見る。**
    expect(() => {
      assertCredentialRefBelongsToTenant(`cred:a1b2c3:${OTHER_INTEGRATION_ID}:API`, ORG);
    }).toThrow(NotFoundError);
  });

  it("形が違う参照キーを通さない", () => {
    for (const ref of [
      "",
      "cred:a1b2c3",
      `cred:a1b2c3:${INTEGRATION_ID}`,
      `cred:a1b2c3:${INTEGRATION_ID}:OTHER`,
      `sess:a1b2c3:${INTEGRATION_ID}:API`,
    ]) {
      expect(() => {
        assertCredentialRefBelongsToTenant(ref, ORG);
      }, ref).toThrow(NotFoundError);
    }
  });
});

describe("putCredential / getCredential（security.md §7）", () => {
  it("往復して元に戻る", async () => {
    const kv = fakeKv();
    const env = envWith(kv);
    const ref = credentialRefFor(ORG, INTEGRATION_ID, "API");

    await putCredential(env, ORG, ref, { apiKey: "sk_live_secret", tenant: "hotel-1" });
    expect(await getCredential(env, ORG, ref)).toEqual({
      apiKey: "sk_live_secret",
      tenant: "hotel-1",
    });
  });

  it("**KV に置かれた値に平文が現れない**", async () => {
    const kv = fakeKv();
    const env = envWith(kv);
    const ref = credentialRefFor(ORG, INTEGRATION_ID, "API");

    await putCredential(env, ORG, ref, { apiKey: "sk_live_secret" });

    const stored = kv.store.get(ref) ?? "";
    expect(stored).not.toContain("sk_live_secret");
    expect(stored).not.toContain("apiKey");
    expect(stored.startsWith("pkenc$v1$")).toBe(true);
  });

  it("**TTL を付けない**（失効すると連携が静かに壊れる）", async () => {
    const kv = fakeKv();
    const env = envWith(kv);
    const ref = credentialRefFor(ORG, INTEGRATION_ID, "WEBHOOK");

    await putCredential(env, ORG, ref, { secret: "shared" });

    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0]?.options).toBeUndefined();
  });

  it("無い鍵は `null`", async () => {
    const kv = fakeKv();
    const ref = credentialRefFor(ORG, INTEGRATION_ID, "WEBHOOK");
    expect(await getCredential(envWith(kv), ORG, ref)).toBeNull();
  });

  it("別組織の参照キーは KV を引く前に落ちる", async () => {
    const kv = fakeKv();
    const env = envWith(kv);
    const ref = `cred:z9y8x7:${OTHER_INTEGRATION_ID}:API`;

    await expect(getCredential(env, ORG, ref)).rejects.toBeInstanceOf(NotFoundError);
    // **KV へ行っていないこと。** 行っていたら他組織の値が読める。
    expect(kv.store.size).toBe(0);
  });

  it("**暗号文を別のキーへ移し替えても復号できない**（AAD に参照キー）", async () => {
    const kv = fakeKv();
    const env = envWith(kv);
    const ownRef = credentialRefFor(ORG, INTEGRATION_ID, "API");
    const otherRef = credentialRefFor(OTHER_ORG, OTHER_INTEGRATION_ID, "API");

    await putCredential(env, ORG, ownRef, { apiKey: "sk_live_secret" });
    // KV の値だけを別組織のキーへコピーする（KV への書き込み権限を得た想定）。
    kv.store.set(otherRef, kv.store.get(ownRef) ?? "");

    expect(await getCredential(env, OTHER_ORG, otherRef)).toBeNull();
  });

  it("鍵が違えば `null`（例外にしない）", async () => {
    const kv = fakeKv();
    const ref = credentialRefFor(ORG, INTEGRATION_ID, "API");
    await putCredential(envWith(kv), ORG, ref, { apiKey: "sk_live_secret" });

    const otherKey = "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA";
    expect(await getCredential(envWith(kv, otherKey), ORG, ref)).toBeNull();
  });

  it("壊れた封筒は `null`", async () => {
    const kv = fakeKv();
    const env = envWith(kv);
    const ref = credentialRefFor(ORG, INTEGRATION_ID, "API");
    for (const broken of ["", "plain-text", "pkenc$v1$", "pkenc$v1$aaa$bbb$ccc", "pkenc$v2$a$b"]) {
      kv.store.set(ref, broken);
      expect(await getCredential(env, ORG, ref), broken).toBeNull();
    }
  });

  it("**鍵が未設定なら保存そのものを失敗させる**（弱い鍵で暗号化した気にならない）", async () => {
    const kv = fakeKv();
    const ref = credentialRefFor(ORG, INTEGRATION_ID, "API");
    await expect(putCredential(envWith(kv, ""), ORG, ref, { apiKey: "x" })).rejects.toThrow(
      "CREDENTIAL_ENCRYPTION_KEY_MISSING",
    );
    expect(kv.store.size).toBe(0);
  });

  it("鍵の長さが違えば保存を失敗させる", async () => {
    const kv = fakeKv();
    const ref = credentialRefFor(ORG, INTEGRATION_ID, "API");
    await expect(putCredential(envWith(kv, "c2hvcnQ"), ORG, ref, { apiKey: "x" })).rejects.toThrow(
      "CREDENTIAL_ENCRYPTION_KEY_INVALID",
    );
  });

  it("上書きが更新になる", async () => {
    const kv = fakeKv();
    const env = envWith(kv);
    const ref = credentialRefFor(ORG, INTEGRATION_ID, "API");

    await putCredential(env, ORG, ref, { apiKey: "old" });
    await putCredential(env, ORG, ref, { apiKey: "new" });

    expect(await getCredential(env, ORG, ref)).toEqual({ apiKey: "new" });
    expect(kv.store.size).toBe(1);
  });

  it("消せる。**消したあとは `null`**", async () => {
    const kv = fakeKv();
    const env = envWith(kv);
    const ref = credentialRefFor(ORG, INTEGRATION_ID, "API");

    await putCredential(env, ORG, ref, { apiKey: "x" });
    await deleteCredential(env, ORG, ref);

    expect(kv.deletes).toEqual([ref]);
    expect(await getCredential(env, ORG, ref)).toBeNull();
  });

  it("別組織の参照キーでは消せない", async () => {
    const kv = fakeKv();
    const env = envWith(kv);
    await expect(
      deleteCredential(env, ORG, `cred:z9y8x7:${OTHER_INTEGRATION_ID}:API`),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(kv.deletes).toEqual([]);
  });
});
