/**
 * 稼働記録 API の配線（P4-02 / PK-SPEC-P4 §8・§8.1）。
 *
 * ルール: .claude/rules/security.md §1 / .claude/rules/testing.md §4
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - CSV が `occupancy_snapshot` へ入り、**組織条件つきで書かれる**
 *   - **3 回取込んでも重複しない**（§10.2 / P4-02 の完了条件）
 *   - **再取込の差分が `audit_log` に載る**（§8.1 MUST / 同上）
 *   - 読めなかった行と客室マスタに無い部屋番号を**捨てずに返す**
 *   - `CLEANER` / `INSPECTOR` が到達できない（security.md §1）
 *   - 取込元を API 越しに名乗れない（`PMS_API` を作らせない）
 *
 * ── 代役の行は位置で組む ────────────────────────────────
 * `createFakeD1()` の `raw()` はそのまま drizzle へ渡る。**列の順序は
 * その `select()` の宣言順。** 列を足す task はここも直すこと。
 */

import type { Env } from "@pk/db";
import { createFakeD1, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../../lib/auth/cookie.js";
import { createSession } from "../../../lib/auth/session.js";
import { createFakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import occupancy from "./occupancy.js";

const SECRET = "test-session-secret-not-used-anywhere-else";
const NOW = new Date("2026-09-10T05:10:00.000Z");

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

const ORG_SHORT_ID = "a1b2c3";
const ORGANIZATION_ID = "org_test_alpha";
const MEMBERSHIP_ID = `${ORG_SHORT_ID}__mem_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const USER_ID = `${ORG_SHORT_ID}__usr_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const PROPERTY_ID = `${ORG_SHORT_ID}__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const ROOM_302 = `${ORG_SHORT_ID}__room_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const ROOM_303 = `${ORG_SHORT_ID}__room_01JBXQ3ZK8N4P2VYR6ABCDEFGJ`;

const BUSINESS_DATE = "2026-09-09";

const HEADER =
  "room_number,business_date,is_occupied,guest_count,reservation_ref," +
  "check_in_at,check_out_at,is_stayover,night_index,nights_total,is_house_use";

function depsFor(role: string): TenantDeps {
  return {
    findMembershipByUserId: () =>
      Promise.resolve({ id: MEMBERSHIP_ID, role: role as "OWNER", isActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

/** `listRooms()` が返す 1 行。**列の順序は schema/property.ts の `room` 宣言順。** */
function roomRow(id: string, number: string): unknown[] {
  return [
    id,
    ORGANIZATION_ID,
    PROPERTY_ID,
    null, // building_id
    null, // floor_id
    null, // room_type_id
    number,
    1, // is_sellable
    "DIRTY", // housekeeping_status
    "AVAILABLE", // sale_status
    "MANUAL", // source_type
    null, // external_room_id
    null, // note
    0, // sort_order
    1, // is_active
    NOW.getTime(),
    NOW.getTime(),
  ];
}

/**
 * `upsertOccupancySnapshots()` の既存行。
 * **列の順序は repositories/occupancy.ts の `select({...})` 順。**
 */
function storedRow(roomId: string, overrides: Partial<Record<string, unknown>> = {}): unknown[] {
  const row: Record<string, unknown> = {
    id: `${ORG_SHORT_ID}__occ_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
    roomId,
    isOccupied: 1,
    guestCount: 2,
    adultCount: 0,
    childCount: 0,
    reservationRef: "RSV-8891",
    channelCode: null,
    checkInAt: null,
    checkOutAt: null,
    isStayover: 0,
    nightsTotal: null,
    nightIndex: null,
    ratePlanCode: null,
    isComplimentary: 0,
    isHouseUse: 0,
    ...overrides,
  };
  return Object.values(row);
}

function setup(role = "ORG_ADMIN"): {
  app: Hono<AppEnv>;
  env: Env;
  d1: FakeD1;
  cookie: () => Promise<string>;
} {
  const kv = createFakeKv();
  const d1 = createFakeD1();
  const env = {
    SESSION: kv.namespace,
    SESSION_SECRET: SECRET,
    SHARD_COUNT: "1",
    SHARD_00: d1.database,
    SHARD_MAP: createFakeKv().namespace,
  } as unknown as Env;

  const app = new Hono<AppEnv>();
  const api = new Hono<AppEnv>();
  useTenantMiddleware(api, depsFor(role));
  api.route("/occupancy", occupancy);
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

async function post(
  ctx: ReturnType<typeof setup>,
  path: string,
  body: unknown,
  cookie: string | null,
): Promise<Response> {
  return ctx.app.request(
    path,
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

/**
 * CSV 取込の代役の並び。**ハンドラが引く順に積む。**
 * ①`listRooms()`（部屋番号 → ID）②`upsertOccupancySnapshots()` の既存行。
 */
function enqueueImport(d1: FakeD1, existing: unknown[][]): void {
  d1.enqueueRows([roomRow(ROOM_302, "302"), roomRow(ROOM_303, "303")]);
  d1.enqueueRows(existing);
}

/** 稼働記録への INSERT。**引用符の種類に依存しない**（drizzle の出力は `"`）。 */
const OCCUPANCY_INSERT = /^insert into ["`]occupancy_snapshot["`]/i;

function writes(d1: FakeD1): string[] {
  return d1.queries
    .map((query) => query.sql)
    .filter((sql) => /^\s*(insert|update)/i.test(sql));
}

function auditWrites(d1: FakeD1): { sql: string; params: unknown[] }[] {
  return d1.queries.filter((query) => query.sql.includes("audit_log"));
}

describe("POST /api/v1/occupancy/import/csv", () => {
  it("セッションが無ければ 401", async () => {
    const ctx = setup();
    const res = await post(ctx, "/api/v1/occupancy/import/csv", {}, null);
    expect(res.status).toBe(401);
  });

  it("CSV を取り込み、件数を返す", async () => {
    const ctx = setup();
    enqueueImport(ctx.d1, []);

    const res = await post(
      ctx,
      "/api/v1/occupancy/import/csv",
      {
        propertyId: PROPERTY_ID,
        businessDate: BUSINESS_DATE,
        csv: [
          HEADER,
          `302,${BUSINESS_DATE},false,0,,,,false,,,false`,
          `303,${BUSINESS_DATE},true,2,RSV-8891,,,false,1,3,false`,
        ].join("\n"),
      },
      await ctx.cookie(),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      businessDate: BUSINESS_DATE,
      source: "CSV_IMPORT",
      inserted: 2,
      updated: 0,
      unchanged: 0,
      unknownRoomNumbers: [],
      skippedLines: [],
    });
  });

  it("書き込む SQL に組織条件が載る", async () => {
    const ctx = setup();
    enqueueImport(ctx.d1, []);

    await post(
      ctx,
      "/api/v1/occupancy/import/csv",
      {
        propertyId: PROPERTY_ID,
        businessDate: BUSINESS_DATE,
        csv: [HEADER, `302,${BUSINESS_DATE},true,2,,,,false,,,false`].join("\n"),
      },
      await ctx.cookie(),
    );

    const inserts = ctx.d1.queries.filter((query) => OCCUPANCY_INSERT.test(query.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.params).toContain(ORGANIZATION_ID);
  });

  it("客室マスタに無い部屋番号を捨てずに返す", async () => {
    const ctx = setup();
    enqueueImport(ctx.d1, []);

    const res = await post(
      ctx,
      "/api/v1/occupancy/import/csv",
      {
        propertyId: PROPERTY_ID,
        businessDate: BUSINESS_DATE,
        csv: [HEADER, `999,${BUSINESS_DATE},true,2,,,,false,,,false`].join("\n"),
      },
      await ctx.cookie(),
    );

    await expect(res.json()).resolves.toMatchObject({
      inserted: 0,
      unknownRoomNumbers: ["999"],
    });
  });

  it("読めなかった行の番号を返す（`is_occupied` が空の行）", async () => {
    const ctx = setup();
    enqueueImport(ctx.d1, []);

    const res = await post(
      ctx,
      "/api/v1/occupancy/import/csv",
      {
        propertyId: PROPERTY_ID,
        businessDate: BUSINESS_DATE,
        csv: [
          HEADER,
          `302,${BUSINESS_DATE},,0,,,,false,,,false`,
          `303,${BUSINESS_DATE},true,2,,,,false,,,false`,
        ].join("\n"),
      },
      await ctx.cookie(),
    );

    await expect(res.json()).resolves.toMatchObject({ inserted: 1, skippedLines: [2] });
  });

  it("業務日の書式が壊れていれば 400", async () => {
    const ctx = setup();
    const res = await post(
      ctx,
      "/api/v1/occupancy/import/csv",
      { propertyId: PROPERTY_ID, businessDate: "2026/09/09", csv: HEADER },
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "INVALID_REQUEST" });
  });

  it("取込元を本文で指定できない（`PMS_API` を名乗れない）", async () => {
    const ctx = setup();
    enqueueImport(ctx.d1, []);

    const res = await post(
      ctx,
      "/api/v1/occupancy/import/csv",
      {
        propertyId: PROPERTY_ID,
        businessDate: BUSINESS_DATE,
        source: "PMS_API",
        csv: [HEADER, `302,${BUSINESS_DATE},true,2,,,,false,,,false`].join("\n"),
      },
      await ctx.cookie(),
    );

    // 余分な鍵は Zod が落とすのではなく無視され、**口が決めた取込元になる。**
    await expect(res.json()).resolves.toMatchObject({ source: "CSV_IMPORT" });
  });
});

describe("POST /api/v1/occupancy/import/csv — 冪等（§10.2）", () => {
  it("同じ内容の再取込では 1 文も書かない", async () => {
    const ctx = setup();
    enqueueImport(ctx.d1, [
      storedRow(ROOM_302, { isOccupied: 0, guestCount: 0, reservationRef: null }),
    ]);

    const res = await post(
      ctx,
      "/api/v1/occupancy/import/csv",
      {
        propertyId: PROPERTY_ID,
        businessDate: BUSINESS_DATE,
        csv: [HEADER, `302,${BUSINESS_DATE},false,0,,,,false,,,false`].join("\n"),
      },
      await ctx.cookie(),
    );

    await expect(res.json()).resolves.toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect(writes(ctx.d1)).toEqual([]);
  });

  it("内容が変わらない再取込では監査ログを書かない", async () => {
    const ctx = setup();
    enqueueImport(ctx.d1, [
      storedRow(ROOM_302, { isOccupied: 0, guestCount: 0, reservationRef: null }),
    ]);

    await post(
      ctx,
      "/api/v1/occupancy/import/csv",
      {
        propertyId: PROPERTY_ID,
        businessDate: BUSINESS_DATE,
        csv: [HEADER, `302,${BUSINESS_DATE},false,0,,,,false,,,false`].join("\n"),
      },
      await ctx.cookie(),
    );

    // 3 回取込むたびに監査ログが増えると、**本当に上書きが起きた回を探せない。**
    expect(auditWrites(ctx.d1)).toEqual([]);
  });
});

describe("POST /api/v1/occupancy/import/csv — 差分の監査（§8.1 MUST）", () => {
  it("上書きが起きたら監査ログを 1 件書く", async () => {
    const ctx = setup();
    enqueueImport(ctx.d1, [storedRow(ROOM_302)]);

    await post(
      ctx,
      "/api/v1/occupancy/import/csv",
      {
        propertyId: PROPERTY_ID,
        businessDate: BUSINESS_DATE,
        // 既存は「稼働あり 2 名」。取込は「空室」。
        csv: [HEADER, `302,${BUSINESS_DATE},false,0,,,,false,,,false`].join("\n"),
      },
      await ctx.cookie(),
    );

    const audits = auditWrites(ctx.d1);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.params).toContain("occupancy.imported");
  });

  it("監査ログの `after` に変わった項目が入る", async () => {
    const ctx = setup();
    enqueueImport(ctx.d1, [storedRow(ROOM_302)]);

    await post(
      ctx,
      "/api/v1/occupancy/import/csv",
      {
        propertyId: PROPERTY_ID,
        businessDate: BUSINESS_DATE,
        csv: [HEADER, `302,${BUSINESS_DATE},false,0,,,,false,,,false`].join("\n"),
      },
      await ctx.cookie(),
    );

    const payload = auditWrites(ctx.d1)[0]?.params.find(
      (param): param is string => typeof param === "string" && param.includes("isOccupied"),
    );
    expect(payload).toBeDefined();
    const parsed = JSON.parse(payload ?? "{}") as {
      updated: number;
      changes: { field: string; before: unknown; after: unknown }[];
    };
    expect(parsed.updated).toBe(1);
    expect(parsed.changes).toEqual(
      expect.arrayContaining([
        { roomId: ROOM_302, field: "isOccupied", before: true, after: false },
        { roomId: ROOM_302, field: "guestCount", before: 2, after: 0 },
      ]),
    );
  });

  it("新規の取込でも監査ログを書く", async () => {
    const ctx = setup();
    enqueueImport(ctx.d1, []);

    await post(
      ctx,
      "/api/v1/occupancy/import/csv",
      {
        propertyId: PROPERTY_ID,
        businessDate: BUSINESS_DATE,
        csv: [HEADER, `302,${BUSINESS_DATE},true,2,,,,false,,,false`].join("\n"),
      },
      await ctx.cookie(),
    );

    expect(auditWrites(ctx.d1)).toHaveLength(1);
  });
});

describe("GET /api/v1/occupancy", () => {
  it("施設と業務日が無ければ 400", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    const res = await ctx.app.request("/api/v1/occupancy", { headers: { Cookie: cookie } }, ctx.env);
    expect(res.status).toBe(400);
  });

  it("未知の取込元を指定したら 400（黙って全件にしない）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    const res = await ctx.app.request(
      `/api/v1/occupancy?propertyId=${PROPERTY_ID}&businessDate=${BUSINESS_DATE}&source=NOPE`,
      { headers: { Cookie: cookie } },
      ctx.env,
    );
    expect(res.status).toBe(400);
  });

  it("取込元を省略すると全件を引く", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([]);
    const cookie = await ctx.cookie();

    const res = await ctx.app.request(
      `/api/v1/occupancy?propertyId=${PROPERTY_ID}&businessDate=${BUSINESS_DATE}`,
      { headers: { Cookie: cookie } },
      ctx.env,
    );

    expect(res.status).toBe(200);
    const select = ctx.d1.queries[0];
    expect(select?.params).not.toContain("CSV_IMPORT");
  });

  it("`rawPayload` を返さない", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([]);
    const cookie = await ctx.cookie();

    const res = await ctx.app.request(
      `/api/v1/occupancy?propertyId=${PROPERTY_ID}&businessDate=${BUSINESS_DATE}`,
      { headers: { Cookie: cookie } },
      ctx.env,
    );

    expect(ctx.d1.queries[0]?.sql).not.toContain("raw_payload");
    await expect(res.json()).resolves.toEqual({ businessDate: BUSINESS_DATE, data: [] });
  });
});

describe("権限（security.md §1 / PK-SPEC-P4 §11）", () => {
  it.each(["CLEANER", "INSPECTOR"])("%s は取込に到達できない", async (role) => {
    const ctx = setup(role);

    const res = await post(
      ctx,
      "/api/v1/occupancy/import/csv",
      { propertyId: PROPERTY_ID, businessDate: BUSINESS_DATE, csv: HEADER },
      await ctx.cookie(),
    );

    // **稼働記録は差異の根拠そのもの。** 現場に見せる理由が無い。
    expect(res.status).toBe(404);
    expect(writes(ctx.d1)).toEqual([]);
  });

  it.each(["CLEANER", "INSPECTOR"])("%s は一覧に到達できない", async (role) => {
    const ctx = setup(role);
    const cookie = await ctx.cookie();

    const res = await ctx.app.request(
      `/api/v1/occupancy?propertyId=${PROPERTY_ID}&businessDate=${BUSINESS_DATE}`,
      { headers: { Cookie: cookie } },
      ctx.env,
    );

    expect(res.status).toBe(404);
  });

  it("AUDITOR は読めるが書けない", async () => {
    const reader = setup("AUDITOR");
    reader.d1.enqueueRows([]);
    const cookie = await reader.cookie();

    const read = await reader.app.request(
      `/api/v1/occupancy?propertyId=${PROPERTY_ID}&businessDate=${BUSINESS_DATE}`,
      { headers: { Cookie: cookie } },
      reader.env,
    );
    expect(read.status).toBe(200);

    const writer = setup("AUDITOR");
    const write = await post(
      writer,
      "/api/v1/occupancy/import/csv",
      { propertyId: PROPERTY_ID, businessDate: BUSINESS_DATE, csv: HEADER },
      await writer.cookie(),
    );
    expect(write.status).toBe(404);
  });
});

describe("POST /api/v1/occupancy/snapshots", () => {
  it("手入力は取込元 MANUAL で入る", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([]);

    const res = await post(
      ctx,
      "/api/v1/occupancy/snapshots",
      {
        propertyId: PROPERTY_ID,
        businessDate: BUSINESS_DATE,
        entries: [{ roomId: ROOM_302, isOccupied: true, guestCount: 2 }],
      },
      await ctx.cookie(),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ source: "MANUAL", inserted: 1 });
  });

  it("空室に人数を入れても 0 にする", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([]);

    await post(
      ctx,
      "/api/v1/occupancy/snapshots",
      {
        propertyId: PROPERTY_ID,
        businessDate: BUSINESS_DATE,
        entries: [{ roomId: ROOM_302, isOccupied: false, guestCount: 2 }],
      },
      await ctx.cookie(),
    );

    const insert = ctx.d1.queries.find((query) => OCCUPANCY_INSERT.test(query.sql));
    // 「空室に 2 名」は矛盾。**照合の根拠を食い違わせない。**
    expect(insert).toBeDefined();
    expect(insert?.params ?? []).not.toContain(2);
  });

  it("別組織の客室 ID は 404", async () => {
    const ctx = setup();

    const res = await post(
      ctx,
      "/api/v1/occupancy/snapshots",
      {
        propertyId: PROPERTY_ID,
        businessDate: BUSINESS_DATE,
        entries: [
          { roomId: "zz9zz9__room_01JBXQ3ZK8N4P2VYR6ABCDEFGH", isOccupied: true, guestCount: 1 },
        ],
      },
      await ctx.cookie(),
    );

    expect(res.status).toBe(404);
  });
});
