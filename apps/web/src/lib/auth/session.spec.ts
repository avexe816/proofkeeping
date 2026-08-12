/**
 * セッションの発行・読み出し・破棄（P0-08）。
 */

import type { Env } from "@pk/db";
import { describe, expect, it } from "vitest";

import { verifySignedSessionId } from "./cookie.js";
import {
  SESSION_TTL_SECONDS,
  createSession,
  deleteSession,
  readSession,
  setSelectedPropertyId,
  type SessionRecord,
} from "./session.js";
import { createFakeKv, type FakeKv } from "./test-support/fake-kv.js";

const SECRET = "test-session-secret-not-used-anywhere-else";
const NOW = new Date("2026-08-11T09:00:00.000Z");

const INPUT = {
  userId: "a1b2c3__usr_01JBXQ3ZK8N4P2VYR60000",
  organizationId: "org_test_alpha",
  orgShortId: "a1b2c3",
  membershipId: "a1b2c3__mem_01JBXQ3ZK8N4P2VYR60000",
  authMethod: "PASSWORD",
  now: NOW,
} as const;

function setup(): { env: Env; kv: FakeKv } {
  const kv = createFakeKv();
  return {
    env: { SESSION: kv.namespace, SESSION_SECRET: SECRET } as unknown as Env,
    kv,
  };
}

/** KV に 1 件だけ入っている前提で、そのキーと値を取り出す。 */
function onlyEntry(kv: FakeKv): { key: string; record: SessionRecord } {
  const entries = [...kv.store.entries()];
  expect(entries).toHaveLength(1);
  const [key, stored] = entries[0] ?? ["", { value: "", expirationTtl: undefined }];
  return { key, record: JSON.parse(stored.value) as SessionRecord };
}

describe("発行", () => {
  it("KV へ sess: 接頭辞で保存する", async () => {
    const { env, kv } = setup();
    await createSession(env, INPUT);
    expect(onlyEntry(kv).key.startsWith("sess:")).toBe(true);
  });

  it("識別情報だけを保存する（role / allowedPropertyIds を焼き込まない）", async () => {
    // DECISIONS #020。増やすとロール降格が最長 12 時間反映されない。
    const { env, kv } = setup();
    await createSession(env, INPUT);
    expect(Object.keys(onlyEntry(kv).record).sort()).toEqual([
      "authMethod",
      "expiresAt",
      "issuedAt",
      "membershipId",
      "orgShortId",
      "organizationId",
      "userId",
      "v",
    ]);
  });

  it("パスワード認証の期限は 12 時間", async () => {
    const { env, kv } = setup();
    const created = await createSession(env, INPUT);
    const { record } = onlyEntry(kv);
    expect(SESSION_TTL_SECONDS.PASSWORD).toBe(12 * 60 * 60);
    expect(record.expiresAt - record.issuedAt).toBe(SESSION_TTL_SECONDS.PASSWORD * 1000);
    expect(created.maxAgeSeconds).toBe(SESSION_TTL_SECONDS.PASSWORD);
  });

  it("PIN 認証の期限は 16 時間（1 勤務）", async () => {
    const { env, kv } = setup();
    await createSession(env, { ...INPUT, authMethod: "PIN" });
    const { record } = onlyEntry(kv);
    expect(SESSION_TTL_SECONDS.PIN).toBe(16 * 60 * 60);
    expect(record.expiresAt - record.issuedAt).toBe(SESSION_TTL_SECONDS.PIN * 1000);
  });

  it("KV にも同じ期限を expirationTtl として渡す", async () => {
    // 実体の掃除は KV 側、判定はレコード側。二重に効かせる。
    const { env, kv } = setup();
    await createSession(env, INPUT);
    const stored = [...kv.store.values()][0];
    expect(stored?.expirationTtl).toBe(SESSION_TTL_SECONDS.PASSWORD);
  });

  it("Cookie の値は署名付きで、生のセッション ID をそのまま出さない", async () => {
    const { env, kv } = setup();
    const created = await createSession(env, INPUT);
    const sessionId = onlyEntry(kv).key.slice("sess:".length);
    expect(created.cookieValue).not.toBe(sessionId);
    await expect(verifySignedSessionId(created.cookieValue, SECRET)).resolves.toBe(sessionId);
  });

  it("毎回違うセッション ID を採番する", async () => {
    const { env, kv } = setup();
    await createSession(env, INPUT);
    await createSession(env, INPUT);
    expect(kv.store.size).toBe(2);
  });
});

describe("読み出し", () => {
  it("発行直後は読める", async () => {
    const { env } = setup();
    const created = await createSession(env, INPUT);
    const record = await readSession(env, created.cookieValue, NOW);
    expect(record?.userId).toBe(INPUT.userId);
    expect(record?.membershipId).toBe(INPUT.membershipId);
  });

  it("期限を 1 ミリ秒でも過ぎていれば null で、KV からも消す", async () => {
    // KV の expirationTtl は結果整合で遅れうる。読み出し側でも落とす。
    const { env, kv } = setup();
    const created = await createSession(env, INPUT);
    const expiredAt = new Date(NOW.getTime() + SESSION_TTL_SECONDS.PASSWORD * 1000);
    await expect(readSession(env, created.cookieValue, expiredAt)).resolves.toBeNull();
    expect(kv.store.size).toBe(0);
  });

  it("期限の直前は読める", async () => {
    const { env } = setup();
    const created = await createSession(env, INPUT);
    const justBefore = new Date(NOW.getTime() + SESSION_TTL_SECONDS.PASSWORD * 1000 - 1);
    await expect(readSession(env, created.cookieValue, justBefore)).resolves.not.toBeNull();
  });

  it("署名が合わない値は KV を引かずに null", async () => {
    const { env, kv } = setup();
    const created = await createSession(env, INPUT);
    const tampered = `x${created.cookieValue}`;
    await expect(readSession(env, tampered, NOW)).resolves.toBeNull();
    // 総当たりを KV へ通さない。
    expect(kv.deleted).toEqual([]);
  });

  it("KV に無ければ null", async () => {
    const { env, kv } = setup();
    const created = await createSession(env, INPUT);
    kv.store.clear();
    await expect(readSession(env, created.cookieValue, NOW)).resolves.toBeNull();
  });

  it.each([
    ["JSON でない", "壊れた値"],
    ["版が違う", '{"v":2,"userId":"u","organizationId":"o","orgShortId":"a1b2c3","membershipId":"m","authMethod":"PASSWORD","issuedAt":0,"expiresAt":9999999999999}'],
    ["認証方式が未知", '{"v":1,"userId":"u","organizationId":"o","orgShortId":"a1b2c3","membershipId":"m","authMethod":"SSO","issuedAt":0,"expiresAt":9999999999999}'],
    ["userId が空", '{"v":1,"userId":"","organizationId":"o","orgShortId":"a1b2c3","membershipId":"m","authMethod":"PASSWORD","issuedAt":0,"expiresAt":9999999999999}'],
    ["期限が数値でない", '{"v":1,"userId":"u","organizationId":"o","orgShortId":"a1b2c3","membershipId":"m","authMethod":"PASSWORD","issuedAt":0,"expiresAt":"never"}'],
  ])("KV の中身が壊れている（%s）と null で、消す", async (_label, raw) => {
    // KV を無検査で信用しない。
    const { env, kv } = setup();
    const created = await createSession(env, INPUT);
    const key = onlyEntry(kv).key;
    kv.seed(key, raw);
    await expect(readSession(env, created.cookieValue, NOW)).resolves.toBeNull();
    expect(kv.store.has(key)).toBe(false);
  });
});

describe("表示中の施設（P0-14）", () => {
  const PROPERTY_A = "a1b2c3__prop_01JBXQ3ZK8N4P2VYR60000";
  const PROPERTY_B = "a1b2c3__prop_01JBXQ3ZK8N4P2VYR60001";

  it("記録した施設が読み出しで戻る", async () => {
    const { env } = setup();
    const created = await createSession(env, INPUT);

    await setSelectedPropertyId(env, created.cookieValue, PROPERTY_A, NOW);

    const record = await readSession(env, created.cookieValue, NOW);
    expect(record?.selectedPropertyId).toBe(PROPERTY_A);
  });

  it("上書きできる", async () => {
    const { env } = setup();
    const created = await createSession(env, INPUT);

    await setSelectedPropertyId(env, created.cookieValue, PROPERTY_A, NOW);
    await setSelectedPropertyId(env, created.cookieValue, PROPERTY_B, NOW);

    expect((await readSession(env, created.cookieValue, NOW))?.selectedPropertyId).toBe(PROPERTY_B);
  });

  it("null を渡すと選択が消える", async () => {
    const { env } = setup();
    const created = await createSession(env, INPUT);
    await setSelectedPropertyId(env, created.cookieValue, PROPERTY_A, NOW);

    await setSelectedPropertyId(env, created.cookieValue, null, NOW);

    expect((await readSession(env, created.cookieValue, NOW))?.selectedPropertyId).toBeUndefined();
  });

  it("フィールドを持たない既存レコードは「未選択」として読める", async () => {
    // 省略可能な列の追加は後方互換（architecture.md §6）。`v` を上げていない。
    const { env, kv } = setup();
    const created = await createSession(env, INPUT);
    const key = onlyEntry(kv).key;
    kv.seed(
      key,
      '{"v":1,"userId":"u","organizationId":"o","orgShortId":"a1b2c3","membershipId":"m","authMethod":"PASSWORD","issuedAt":0,"expiresAt":9999999999999}',
    );

    const record = await readSession(env, created.cookieValue, NOW);
    expect(record).not.toBeNull();
    expect(record?.selectedPropertyId).toBeUndefined();
  });

  it("空文字は未選択として捨てる", async () => {
    const { env, kv } = setup();
    const created = await createSession(env, INPUT);
    const key = onlyEntry(kv).key;
    kv.seed(
      key,
      '{"v":1,"userId":"u","organizationId":"o","orgShortId":"a1b2c3","membershipId":"m","authMethod":"PASSWORD","issuedAt":0,"expiresAt":9999999999999,"selectedPropertyId":""}',
    );

    expect((await readSession(env, created.cookieValue, NOW))?.selectedPropertyId).toBeUndefined();
  });

  it("期限を延長しない（残り時間だけを TTL にする）", async () => {
    // DECISIONS #020。切り替えるたびに延びると「12 時間 / 1 勤務」が崩れる。
    const { env, kv } = setup();
    const created = await createSession(env, INPUT);
    const expiresAt = onlyEntry(kv).record.expiresAt;
    const fourHoursLater = new Date(NOW.getTime() + 4 * 60 * 60 * 1000);

    await setSelectedPropertyId(env, created.cookieValue, PROPERTY_A, fourHoursLater);

    const entries = [...kv.store.values()];
    expect(entries[0]?.expirationTtl).toBe(8 * 60 * 60);
    // 絶対期限そのものも動かない。
    expect(onlyEntry(kv).record.expiresAt).toBe(expiresAt);
  });

  it("期限切れのセッションには書かない", async () => {
    const { env, kv } = setup();
    const created = await createSession(env, INPUT);
    const afterExpiry = new Date(NOW.getTime() + SESSION_TTL_SECONDS.PASSWORD * 1000);

    const result = await setSelectedPropertyId(env, created.cookieValue, PROPERTY_A, afterExpiry);

    expect(result).toBeNull();
    // 読み出しが期限切れとして掃除したまま。復活させない。
    expect(kv.store.size).toBe(0);
  });

  it("破棄済みのセッションを復活させない", async () => {
    const { env, kv } = setup();
    const created = await createSession(env, INPUT);
    await deleteSession(env, created.cookieValue);

    const result = await setSelectedPropertyId(env, created.cookieValue, PROPERTY_A, NOW);

    expect(result).toBeNull();
    expect(kv.store.size).toBe(0);
  });

  it("署名が合わない値では何も書かない", async () => {
    const { env, kv } = setup();
    const created = await createSession(env, INPUT);

    const result = await setSelectedPropertyId(env, `x${created.cookieValue}`, PROPERTY_A, NOW);

    expect(result).toBeNull();
    expect(onlyEntry(kv).record.selectedPropertyId).toBeUndefined();
  });
});

describe("破棄", () => {
  it("削除したセッションは読めない", async () => {
    const { env, kv } = setup();
    const created = await createSession(env, INPUT);
    await deleteSession(env, created.cookieValue);
    expect(kv.store.size).toBe(0);
    await expect(readSession(env, created.cookieValue, NOW)).resolves.toBeNull();
  });

  it("署名が合わない値では何も消さない", async () => {
    const { env, kv } = setup();
    await createSession(env, INPUT);
    await deleteSession(env, "not-a-valid-cookie");
    expect(kv.store.size).toBe(1);
  });
});
