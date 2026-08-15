/**
 * 通知の配信（P6-09 / PK-SPEC-P6 §5）。
 *
 * ルール: .claude/rules/testing.md §4（冪等）/ ui-writing.md §6
 *
 * 完了条件（`docs/tasks/P6-09.md`）のうち、ここが押さえるもの:
 *   - **`CLEANER` に `task.rework_assigned` 以外が届かない**（配信の端まで）
 *   - 静音時間が機能する（`PUSH` を落とし、`EMAIL` は落とさない）
 *
 * 判定そのものは `lib/notification/routing.spec.ts`。ここは
 * **実際に fetch が飛ぶかどうか**を見る。
 */

import { generateId } from "@pk/db";
import { createFakeD1, createFakeEnv, TEST_ORG, type FakeD1 } from "@pk/db/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dedupeKvKey, isNotifyMessage, notificationBody, runNotify, type NotifyMessage } from "./notify.js";

const MEMBERSHIP_ID = generateId(TEST_ORG.orgShortId, "mem");
const PROPERTY_ID = generateId(TEST_ORG.orgShortId, "prop");
const REQUESTED_AT = new Date("2026-09-10T05:00:00.000Z"); // JST 14:00（日中）
const NIGHT_AT = new Date("2026-09-10T14:30:00.000Z"); // JST 23:30（静音時間）

const MESSAGE: NotifyMessage = {
  kind: "NOTIFY",
  orgShortId: TEST_ORG.orgShortId,
  eventCode: "integration.error",
  propertyId: null,
  subject: "外部連携が停止しました",
  summary: "○○PMS との連携が続けて失敗したため、自動同期を止めました。",
  linkPath: "/app/settings/integrations/x/mappings",
  dedupeKey: "integration.error:x",
  requestedAtMs: REQUESTED_AT.getTime(),
};

/** `CONFIG` KV の代わり。**何が置かれたかを見る。** */
function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

/** 送信を数える fetch。 */
function stubFetch(ok = true) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve({ ok, json: () => Promise.resolve({ id: "re_1" }) });
    },
  );
  return calls;
}

/** 取込が引く行を順に積む。①組織 ②宛先 ③通知設定（④施設） */
function primeFake(
  fake: FakeD1,
  options: { role?: string; email?: string | null; channels?: string[] | null } = {},
): void {
  fake.enqueueRows([[TEST_ORG.organizationId]]); // org_directory
  const email = "email" in options ? options.email : "a@example.com";
  fake.enqueueRows([[MEMBERSHIP_ID, options.role ?? "ORG_ADMIN", email, "ja"]]);
  fake.enqueueRows(
    options.channels === undefined || options.channels === null
      ? []
      : [[MEMBERSHIP_ID, JSON.stringify(options.channels), null, null]],
  );
}

function envWith(fake: FakeD1, kv = fakeKv()) {
  return { ...createFakeEnv(fake), CONFIG: kv, RESEND_API_KEY: "k", RESEND_FROM_ADDRESS: "n@pk" } as never;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isNotifyMessage", () => {
  it("正しい形を受け入れる", () => {
    expect(isNotifyMessage(MESSAGE)).toBe(true);
  });

  it("**語彙に無い `eventCode` を拒む**（§5.1 の 10 件だけ）", () => {
    expect(isNotifyMessage({ ...MESSAGE, eventCode: "task.completed" })).toBe(false);
  });

  it("`dedupeKey` が空なら拒む（冪等の鍵）", () => {
    expect(isNotifyMessage({ ...MESSAGE, dedupeKey: "" })).toBe(false);
  });

  it("他のメッセージ型と取り違えない", () => {
    expect(isNotifyMessage({ kind: "INVOICE_DELIVERY", orgShortId: "a" })).toBe(false);
  });

  it("オブジェクトでなければ拒む", () => {
    expect(isNotifyMessage(null)).toBe(false);
    expect(isNotifyMessage("NOTIFY")).toBe(false);
  });
});

describe("runNotify — 送る", () => {
  it("`ORG_ADMIN` へ EMAIL が 1 通飛ぶ", async () => {
    const fake = createFakeD1();
    primeFake(fake);
    const calls = stubFetch();
    const outcome = await runNotify(envWith(fake), MESSAGE);
    expect(outcome).toEqual({ kind: "OK", sent: 1, withheld: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
  });

  it("**本文に要約とリンクだけ**（ui-writing.md §6）", () => {
    const body = notificationBody(MESSAGE);
    expect(body).toContain(MESSAGE.summary);
    expect(body).toContain(MESSAGE.linkPath);
    // 金額・客室番号・個人名を組み立てていない。
    expect(body.split("\n").filter((line) => line !== "")).toHaveLength(2);
  });

  it("送ったら `dedupeKey` を KV へ置く", async () => {
    const fake = createFakeD1();
    primeFake(fake);
    stubFetch();
    const kv = fakeKv();
    await runNotify(envWith(fake, kv), MESSAGE);
    expect(kv.store.get(dedupeKvKey(TEST_ORG.orgShortId, MESSAGE.dedupeKey))).toBe("1");
  });
});

describe("runNotify — 送らない", () => {
  it("**同じ `dedupeKey` は 2 度送らない**（冪等 / testing.md §4）", async () => {
    const fake = createFakeD1();
    const calls = stubFetch();
    const kv = fakeKv({ [dedupeKvKey(TEST_ORG.orgShortId, MESSAGE.dedupeKey)]: "1" });
    const outcome = await runNotify(envWith(fake, kv), MESSAGE);
    expect(outcome).toEqual({ kind: "OK", sent: 0, withheld: 0 });
    expect(calls).toHaveLength(0);
  });

  it("組織が引けなければ ack して捨てる", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([]);
    const outcome = await runNotify(envWith(fake), MESSAGE);
    expect(outcome).toEqual({ kind: "DROPPED", reason: "ORGANIZATION_NOT_FOUND" });
  });

  it("知らないイベントは ack して捨てる", async () => {
    const fake = createFakeD1();
    const outcome = await runNotify(envWith(fake), { ...MESSAGE, eventCode: "task.completed" as never });
    expect(outcome).toEqual({ kind: "DROPPED", reason: "UNKNOWN_EVENT" });
  });

  it("**取引先向けのイベントは組織内の宛先を持たない**（OPEN_QUESTIONS #090）", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([[TEST_ORG.organizationId]]);
    const outcome = await runNotify(envWith(fake), {
      ...MESSAGE,
      eventCode: "period.review_requested",
    });
    expect(outcome).toEqual({ kind: "DROPPED", reason: "NO_INTERNAL_AUDIENCE" });
  });

  it("宛先が 0 人でも成功（対象ロールの在籍者がいない組織）", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([[TEST_ORG.organizationId]]);
    fake.enqueueRows([]); // 宛先なし
    const calls = stubFetch();
    expect(await runNotify(envWith(fake), MESSAGE)).toEqual({ kind: "OK", sent: 0, withheld: 0 });
    expect(calls).toHaveLength(0);
  });

  it("**メール未登録は送らないが失敗にもしない**（`email` は任意項目）", async () => {
    const fake = createFakeD1();
    primeFake(fake, { email: null });
    const calls = stubFetch();
    expect(await runNotify(envWith(fake), MESSAGE)).toEqual({ kind: "OK", sent: 0, withheld: 1 });
    expect(calls).toHaveLength(0);
  });

  it("設定でチャネルを空にしたら送らない", async () => {
    const fake = createFakeD1();
    primeFake(fake, { channels: [] });
    const calls = stubFetch();
    expect(await runNotify(envWith(fake), MESSAGE)).toEqual({ kind: "OK", sent: 0, withheld: 1 });
    expect(calls).toHaveLength(0);
  });

  it("Resend が失敗しても例外にしない（他の宛先を巻き込まない）", async () => {
    const fake = createFakeD1();
    primeFake(fake);
    stubFetch(false);
    expect(await runNotify(envWith(fake), MESSAGE)).toEqual({ kind: "OK", sent: 0, withheld: 1 });
  });
});

describe("runNotify — `CLEANER` の境界（§5.1 MUST / security.md §1）", () => {
  it("**清掃スタッフには 1 通も飛ばない**（対象ロールに含まれないイベント）", async () => {
    const fake = createFakeD1();
    primeFake(fake, { role: "CLEANER" });
    const calls = stubFetch();
    // `integration.error` の対象は `ORG_ADMIN`。宛先の照会自体が
    // `ORG_ADMIN` で絞られるが、万一 `CLEANER` の行が返っても落ちる。
    const outcome = await runNotify(envWith(fake), MESSAGE);
    expect(outcome).toEqual({ kind: "OK", sent: 0, withheld: 1 });
    expect(calls).toHaveLength(0);
  });

  it("**唯一許されたイベントも外へは送らない**（既定は `IN_APP`）", async () => {
    const fake = createFakeD1();
    primeFake(fake, { role: "CLEANER" });
    const calls = stubFetch();
    const outcome = await runNotify(envWith(fake), {
      ...MESSAGE,
      eventCode: "task.rework_assigned",
      propertyId: null,
    });
    expect(outcome).toEqual({ kind: "OK", sent: 0, withheld: 1 });
    expect(calls).toHaveLength(0);
  });
});

describe("runNotify — 静音時間（§5.3）", () => {
  it("**深夜でも EMAIL は止めない**（§5.3 が止めるのは PUSH / LINE）", async () => {
    const fake = createFakeD1();
    primeFake(fake);
    const calls = stubFetch();
    const outcome = await runNotify(envWith(fake), {
      ...MESSAGE,
      requestedAtMs: NIGHT_AT.getTime(),
    });
    expect(outcome).toEqual({ kind: "OK", sent: 1, withheld: 0 });
    expect(calls).toHaveLength(1);
  });

  it("深夜に PUSH だけの設定なら 1 通も飛ばない（`IN_APP` へ落ちる）", async () => {
    const fake = createFakeD1();
    primeFake(fake, { channels: ["PUSH"] });
    const calls = stubFetch();
    const outcome = await runNotify(envWith(fake), {
      ...MESSAGE,
      requestedAtMs: NIGHT_AT.getTime(),
    });
    expect(outcome).toEqual({ kind: "OK", sent: 0, withheld: 1 });
    expect(calls).toHaveLength(0);
  });
});

/** 施設スコープのイベントは施設を引く（タイムゾーン）。 */
describe("runNotify — 施設スコープ", () => {
  it("施設が指定されていれば施設の割当で宛先を絞る", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([[TEST_ORG.organizationId]]);
    fake.enqueueRows([[MEMBERSHIP_ID, "PROPERTY_MANAGER", "pm@example.com", "ja"]]);
    fake.enqueueRows([]); // 設定なし
    fake.enqueueRows([[PROPERTY_ID, TEST_ORG.organizationId]]); // property（timezone）
    const calls = stubFetch();
    const outcome = await runNotify(envWith(fake), {
      ...MESSAGE,
      eventCode: "issue.critical",
      propertyId: PROPERTY_ID,
    });
    expect(outcome).toEqual({ kind: "OK", sent: 1, withheld: 0 });
    expect(calls).toHaveLength(1);
    // 宛先の照会が `property_assignment` を起点にしている。
    expect(fake.queries.some((query) => query.sql.includes("property_assignment"))).toBe(true);
  });
});
