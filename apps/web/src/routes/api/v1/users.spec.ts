/**
 * `/api/v1/users`（P7-01 / PK-SPEC-P7 §2.3 Step 5）。
 *
 * ── 見ているもの ────────────────────────────────────────
 *   `user.write` を持たないロールが **404** になること（403 ではない）
 *   `PROPERTY_MANAGER` が**担当外の施設**へスタッフを差し込めないこと
 *   スタッフ番号の重複が **409**、形の誤りが **400** で分かれること
 *   **初期 PIN が応答に 1 回だけ現れ、PIN も ハッシュも監査ログに載らないこと**
 *   `pinMustChange` が true で作られること（security.md §2）
 *   越境した `propertyId` が **404** になり、DB へ届かないこと
 *
 * ── 代役の行は位置で組む ────────────────────────────────
 * `createFakeD1()` の `raw()` はそのまま drizzle へ渡る。
 */

import { FIELD_STAFF_ROLES, PIN_POLICY, type FieldStaffCreateResponse } from "@pk/contracts";
import { ROLES, type Env } from "@pk/db";
import { createFakeD1, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../../lib/auth/cookie.js";
import { createSession } from "../../../lib/auth/session.js";
import { createFakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import users from "./users.js";

const SECRET = "test-session-secret-not-used-anywhere-else";
const NOW = new Date("2026-08-15T09:00:00.000Z");

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

const ORG_SHORT_ID = "a1b2c3";
const OTHER_ORG_SHORT_ID = "z9y8x7";
const ORGANIZATION_ID = "org_test_alpha";
const MEMBERSHIP_ID = `${ORG_SHORT_ID}__mem_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const USER_ID = `${ORG_SHORT_ID}__usr_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const PROPERTY_ID = `${ORG_SHORT_ID}__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const OTHER_PROPERTY_ID = `${ORG_SHORT_ID}__prop_01JBXQ3ZK8N4P2VYR6ZZZZZZZZ`;
const CROSS_TENANT_PROPERTY_ID = `${OTHER_ORG_SHORT_ID}__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

type TestRole = "ORG_ADMIN" | "PROPERTY_MANAGER" | "CLEANER" | "AUDITOR";

function deps(role: TestRole): TenantDeps {
  return {
    findMembershipByUserId: () => Promise.resolve({ id: MEMBERSHIP_ID, role, isActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

function setup(role: TestRole = "ORG_ADMIN"): {
  app: Hono<AppEnv>;
  env: Env;
  d1: FakeD1;
  cookie: () => Promise<string>;
} {
  const d1 = createFakeD1();
  const env = {
    SESSION: createFakeKv().namespace,
    SESSION_SECRET: SECRET,
    SHARD_COUNT: "1",
    SHARD_00: d1.database,
    SHARD_MAP: createFakeKv().namespace,
  } as unknown as Env;

  const app = new Hono<AppEnv>();
  const api = new Hono<AppEnv>();
  useTenantMiddleware(api, deps(role));
  api.route("/users", users);
  app.route("/api/v1", api);

  return {
    app,
    env,
    d1,
    cookie: async () => {
      const created = await createSession(env, {
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        orgShortId: ORG_SHORT_ID,
        membershipId: MEMBERSHIP_ID,
        authMethod: "PASSWORD",
        now: NOW,
      });
      return `${SESSION_COOKIE_NAME}=${created.cookieValue}`;
    },
  };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "清掃 花子",
    staffNumber: "S-0042",
    role: "CLEANER",
    propertyIds: [PROPERTY_ID],
    ...overrides,
  };
}

async function post(
  ctx: ReturnType<typeof setup>,
  body: unknown,
  cookie: string | null,
): Promise<Response> {
  return ctx.app.request(
    "/api/v1/users",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie === null ? {} : { Cookie: cookie }),
      },
      body: JSON.stringify(body),
    },
    ctx.env,
  );
}

describe("受け付けるロール", () => {
  it("**`FIELD_STAFF_ROLES` は `ROLES` の部分集合**（contracts と db がずれていない）", () => {
    // `packages/contracts` は `packages/db` に依存しないので、包含は
    // 両方を import できるここでしか見られない（`user.spec.ts` の注記）。
    for (const role of FIELD_STAFF_ROLES) {
      expect((ROLES as readonly string[]).includes(role)).toBe(true);
    }
  });

  it("PIN でログインするのは現場系の 2 ロールだけ（security.md §2 の表）", () => {
    expect([...FIELD_STAFF_ROLES]).toEqual(["CLEANER", "INSPECTOR"]);
  });
});

describe("POST /api/v1/users", () => {
  it("セッションが無ければ 401", async () => {
    const ctx = setup();
    const res = await post(ctx, validBody(), null);
    expect(res.status).toBe(401);
  });

  it("登録できると 201。**初期 PIN が 1 回だけ返る**", async () => {
    const ctx = setup();
    const res = await post(ctx, validBody(), await ctx.cookie());

    expect(res.status).toBe(201);
    const body: FieldStaffCreateResponse = await res.json();
    expect(body.initialPin).toMatch(/^[0-9]{4}$/);
    expect(body.initialPin.length).toBe(PIN_POLICY.length);
    expect(body.userId.startsWith(`${ORG_SHORT_ID}__usr_`)).toBe(true);
    expect(body.role).toBe("CLEANER");
  });

  it("**PIN を入力として受け付けない**（送っても無視して発行する）", async () => {
    const ctx = setup();
    const res = await post(ctx, validBody({ pin: "2580" }), await ctx.cookie());

    expect(res.status).toBe(201);
    const body: FieldStaffCreateResponse = await res.json();
    // 送った値がそのまま採用されていないこと。**発行は一様乱数**なので
    // まれに一致しうる（1/10000）。ここで見るのは「入力が素通りしない」
    // ことなので、ハッシュが平文の PIN でないことを併せて確かめる。
    const inserted = ctx.d1.queries.find((q) => q.sql.includes('insert into "user"'));
    expect(inserted).toBeDefined();
    expect(JSON.stringify(inserted?.params)).not.toContain("2580");
    expect(body.initialPin).toMatch(/^[0-9]{4}$/);
  });

  it("`user` / `membership` / `property_assignment` の 3 表を作る", async () => {
    const ctx = setup();
    await post(ctx, validBody(), await ctx.cookie());

    const sql = ctx.d1.queries.map((q) => q.sql).join("\n");
    expect(sql).toContain('insert into "user"');
    expect(sql).toContain('insert into "membership"');
    expect(sql).toContain('insert into "property_assignment"');
  });

  it("**`pinMustChange` が true で作られる**（security.md §2）", async () => {
    const ctx = setup();
    await post(ctx, validBody(), await ctx.cookie());

    const inserted = ctx.d1.queries.find((q) => q.sql.includes('insert into "user"'));
    // boolean は 1 / 0 で入る。**0 になっていたら発行した PIN が使われ続ける。**
    expect(inserted?.params).toContain(1);
  });

  it("**PIN もハッシュも監査ログに載らない**（security.md §6）", async () => {
    const ctx = setup();
    const res = await post(ctx, validBody(), await ctx.cookie());
    const body: FieldStaffCreateResponse = await res.json();

    const audit = ctx.d1.queries.find((q) => q.sql.includes('insert into "audit_log"'));
    expect(audit).toBeDefined();
    const serialized = JSON.stringify(audit?.params);
    expect(serialized).not.toContain(body.initialPin);
    expect(serialized).not.toContain("pbkdf2");
    // 監査の行そのものは残る。
    expect(serialized).toContain("user.invited");
  });

  it("スタッフ番号が重複していたら 409", async () => {
    const ctx = setup();
    // `onConflictDoNothing()` が 0 行になる状況を作る。
    ctx.d1.enqueueChanges(0);
    const res = await post(ctx, validBody(), await ctx.cookie());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "DUPLICATE_STAFF_NUMBER" });
  });

  it("形が違えば 400（DB へ届かない）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    for (const body of [
      validBody({ displayName: "" }),
      validBody({ staffNumber: "スタッフ番号" }),
      validBody({ role: "OWNER" }),
      validBody({ propertyIds: [] }),
      validBody({ email: "not-an-email" }),
    ]) {
      const res = await post(ctx, body, cookie);
      expect(res.status).toBe(400);
    }
    expect(ctx.d1.queries.some((q) => q.sql.includes('insert into "user"'))).toBe(false);
  });

  it("**`CLEANER` は 404**（`user.write` を持たない。403 ではない）", async () => {
    const ctx = setup("CLEANER");
    const res = await post(ctx, validBody(), await ctx.cookie());
    expect(res.status).toBe(404);
  });

  it("**`AUDITOR` は 404**（読取専用）", async () => {
    const ctx = setup("AUDITOR");
    const res = await post(ctx, validBody(), await ctx.cookie());
    expect(res.status).toBe(404);
  });

  it("`PROPERTY_MANAGER` は担当施設なら作れる", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const res = await post(ctx, validBody(), await ctx.cookie());
    expect(res.status).toBe(201);
  });

  it("**`PROPERTY_MANAGER` は担当外の施設へ差し込めない（404）**", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const res = await post(
      ctx,
      validBody({ propertyIds: [OTHER_PROPERTY_ID] }),
      await ctx.cookie(),
    );

    expect(res.status).toBe(404);
    expect(ctx.d1.queries.some((q) => q.sql.includes('insert into "user"'))).toBe(false);
  });

  it("**越境した施設 ID は 404**（DB へ届かない）", async () => {
    const ctx = setup();
    const res = await post(
      ctx,
      validBody({ propertyIds: [CROSS_TENANT_PROPERTY_ID] }),
      await ctx.cookie(),
    );

    expect(res.status).toBe(404);
    expect(ctx.d1.queries.some((q) => q.sql.includes('insert into "user"'))).toBe(false);
  });

  it("**削除・一覧の口が無い**（P7-01 の範囲は登録だけ）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    for (const method of ["GET", "DELETE", "PATCH"] as const) {
      const res = await ctx.app.request(
        "/api/v1/users",
        { method, headers: { Cookie: cookie } },
        ctx.env,
      );
      expect(res.status).toBe(404);
    }
  });
});
