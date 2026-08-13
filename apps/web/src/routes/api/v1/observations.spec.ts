/**
 * 観察記録・リネン API の配線（P3-03〜P3-07）。
 *
 * 仕様: docs/PK-SPEC-P3.md §2.2・§4.3・§7・§8
 * ルール: .claude/rules/security.md §1 / .claude/rules/ui-writing.md §5
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - 記録が `room_observation` へ入り、**組織条件つきで書かれる**
 *   - `Idempotency-Key` の再送で 2 重登録しない（§7 MUST / P3-05）
 *   - 「今回は記録しない」に**理由の受け口が無い**（§1.3 MUST）
 *   - 破損・汚損の写真が無いときは **400。409 にしない**（§4.3 MUST /
 *     409 はオフラインキューが「処理済」として捨てる）
 *   - 事後修正が `CLEANER` に 404（§2.2 MUST）／理由が無ければ 400
 *
 * ── 代役の行は位置で組む ────────────────────────────────
 * `createFakeD1()` の `raw()` はそのまま drizzle へ渡る。**列の順序は
 * スキーマの宣言順。** 列を足す task はここも直すこと。
 */

import type { Env } from "@pk/db";
import { createFakeD1, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../../lib/auth/cookie.js";
import { createSession } from "../../../lib/auth/session.js";
import { createFakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import observations from "./observations.js";
import tasks from "./tasks.js";

const SECRET = "test-session-secret-not-used-anywhere-else";
const NOW = new Date("2026-09-11T05:10:00.000Z");

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
const ROOM_ID = `${ORG_SHORT_ID}__room_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const TASK_ID = `${ORG_SHORT_ID}__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const OBSERVATION_ID = `${ORG_SHORT_ID}__obs_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const OTHER_ORG_TASK_ID = "zz9zz9__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH";
const IDEMPOTENCY_KEY = "8f0f0d5e-0d2e-4a9f-9a04-0c5d1a7d2b31";

function depsFor(role: string): TenantDeps {
  return {
    findMembershipByUserId: () =>
      Promise.resolve({ id: MEMBERSHIP_ID, role: role as "CLEANER", isActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

/** 入室時の記録の本体（§4.1 の 9 項目）。 */
const COUNTS = {
  bedsUsed: 2,
  trashLevel: "NORMAL",
  bathTowelUsed: 2,
  faceTowelUsed: 2,
  handTowelUsed: 2,
  bathMatUsed: 1,
  slippersUsed: 2,
  cupsUsed: 2,
  extraFutonUsed: 0,
  amenitiesUsed: {},
} as const;

/** `cleaning_task` の 1 行。**列の順序は schema/task.ts の宣言順。** */
function taskRow(): unknown[] {
  return [
    TASK_ID,
    ORGANIZATION_ID,
    PROPERTY_ID,
    ROOM_ID,
    "2026-09-10",
    "CHECKOUT",
    "IN_PROGRESS",
    40, // priority
    MEMBERSHIP_ID,
    40, // standard_minutes
    null, // actual_minutes
    0, // pause_count
    0, // rework_count
    0, // inspection_required
    0, // inspection_skipped
    null, // inspection_skip_reason
    null, // inspector_id
    null, // inspected_at
    null, // inspection_result
    0, // current_inspection_round
    "AUTO",
    null, // note
    null, // blocked_reason
    "a1b2c3d4", // short_id
    null, // sequence_in_day
    null, // assigned_at
    null, // started_at
    null, // completed_at
    null, // cancelled_at
    0, // created_at
    0, // updated_at
    // P3-01 が足した 2 列（PK-SPEC-P3 §2.7）。**宣言順は末尾。**
    0, // observation_skipped
    null, // observation_recorded_at
  ];
}

/** `room_observation` の 1 行。**列の順序は schema/observation.ts の宣言順。** */
function observationRow(idempotencyKey: string | null): unknown[] {
  return [
    OBSERVATION_ID,
    ORGANIZATION_ID,
    PROPERTY_ID,
    TASK_ID,
    ROOM_ID,
    `${ORG_SHORT_ID}__rtyp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
    "2026-09-10",
    2, // beds_used
    "NORMAL",
    2, // bath_towel_used
    2, // face_towel_used
    2, // hand_towel_used
    1, // bath_mat_used
    2, // slippers_used
    2, // cups_used
    0, // extra_futon_used
    "{}", // amenities_used
    null, // note
    12_400, // input_duration_ms
    1, // used_defaults
    MEMBERSHIP_ID,
    NOW.getTime(),
    null, // client_ts
    null, // device_info
    idempotencyKey,
    0, // created_at
    0, // updated_at
  ];
}

/** `observation_config` の 1 行。**列の順序は schema/observation.ts の宣言順。** */
function configRow(enabledItemCodes: string[]): unknown[] {
  return [
    `${ORG_SHORT_ID}__ocfg_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
    ORGANIZATION_ID,
    PROPERTY_ID,
    1, // enabled
    1, // require_beds
    1, // require_trash
    1, // require_towels
    0, // require_amenities
    1, // require_linen
    JSON.stringify(enabledItemCodes),
    20, // skip_warn_threshold
    NOW.getTime(),
  ];
}

function setup(role = "CLEANER"): {
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
  api.route("/tasks", tasks);
  api.route("/observations", observations);
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
        authMethod: "PIN",
        now: NOW,
      });
      return `${SESSION_COOKIE_NAME}=${created.cookieValue}`;
    },
  };
}

async function send(
  ctx: ReturnType<typeof setup>,
  method: "PUT" | "POST" | "PATCH",
  path: string,
  body: unknown,
  cookie: string | null,
  idempotencyKey?: string,
): Promise<Response> {
  return ctx.app.request(
    path,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie === null ? {} : { Cookie: cookie }),
        ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
      },
      body: JSON.stringify(body),
    },
    ctx.env,
  );
}

describe("PUT /api/v1/tasks/:taskId/observation", () => {
  it("セッションが無ければ 401", async () => {
    const ctx = setup();

    const res = await send(ctx, "PUT", `/api/v1/tasks/${TASK_ID}/observation`, {}, null);

    expect(res.status).toBe(401);
  });

  it("他組織の taskId は 404 で、DB に触れない", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await send(
      ctx,
      "PUT",
      `/api/v1/tasks/${OTHER_ORG_TASK_ID}/observation`,
      { ...COUNTS, usedDefaults: true },
      cookie,
    );

    expect(res.status).toBe(404);
    expect(ctx.d1.queries.filter((query) => query.sql.includes("room_observation"))).toEqual([]);
  });

  it("記録が room_observation へ入る（組織 ID つき）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow()]);

    const res = await send(
      ctx,
      "PUT",
      `/api/v1/tasks/${TASK_ID}/observation`,
      { ...COUNTS, usedDefaults: true, inputDurationMs: 12_400 },
      cookie,
      IDEMPOTENCY_KEY,
    );

    expect(res.status).toBe(200);
    const insert = ctx.d1.queries.find((query) =>
      query.sql.startsWith('insert into "room_observation"'),
    );
    expect(insert).toBeDefined();
    // 第 1 層。**組織 ID が必ず載る。**
    expect(insert?.params).toContain(ORGANIZATION_ID);
    // §7 MUST。再送を弾く鍵が行に残る。
    expect(insert?.params).toContain(IDEMPOTENCY_KEY);
  });

  it("同じ Idempotency-Key の再送では書かない（§7 MUST / P3-05）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    // findTaskById → 設定 → 客室 → 稼働予定 → 既存の観察記録。
    ctx.d1.enqueueRows([taskRow()]);
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([observationRow(IDEMPOTENCY_KEY)]);

    const res = await send(
      ctx,
      "PUT",
      `/api/v1/tasks/${TASK_ID}/observation`,
      { ...COUNTS, usedDefaults: true },
      cookie,
      IDEMPOTENCY_KEY,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unchanged: true });
    expect(
      ctx.d1.queries.filter((query) => query.sql.startsWith('insert into "room_observation"')),
    ).toEqual([]);
  });

  it("項目の値が範囲外なら 400", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await send(
      ctx,
      "PUT",
      `/api/v1/tasks/${TASK_ID}/observation`,
      { ...COUNTS, bedsUsed: -1, usedDefaults: true },
      cookie,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_REQUEST" });
  });
});

describe("POST /api/v1/tasks/:taskId/observation/skip", () => {
  it("理由を受け取らずに記録できる（§1.3 MUST）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow()]);

    const res = await send(
      ctx,
      "POST",
      `/api/v1/tasks/${TASK_ID}/observation/skip`,
      { clientTs: NOW.getTime() },
      cookie,
    );

    expect(res.status).toBe(200);
    const update = ctx.d1.queries.find((query) =>
      query.sql.startsWith('update "cleaning_task"'),
    );
    expect(update?.sql).toContain("observation_skipped");
    expect(update?.params).toContain(ORGANIZATION_ID);
  });

  it("理由を送っても保存されない（受け口が無い）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow()]);

    const res = await send(
      ctx,
      "POST",
      `/api/v1/tasks/${TASK_ID}/observation/skip`,
      { reason: "面倒だった" },
      cookie,
    );

    expect(res.status).toBe(200);
    for (const query of ctx.d1.queries) {
      expect(query.params).not.toContain("面倒だった");
    }
  });
});

describe("PUT /api/v1/tasks/:taskId/linen", () => {
  it("破損の報告に写真が無ければ 400（409 にしない / §4.3 MUST）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow()]);
    ctx.d1.enqueueRows([configRow(["BATH_TOWEL"])]);
    // タスクの写真は 0 枚。
    ctx.d1.enqueueRows([]);

    const res = await send(
      ctx,
      "PUT",
      `/api/v1/tasks/${TASK_ID}/linen`,
      {
        entries: [
          {
            itemCode: "BATH_TOWEL",
            collectedQty: 2,
            suppliedQty: 0,
            damagedQty: 1,
            stainedQty: 0,
          },
        ],
      },
      cookie,
    );

    // **409 だとオフラインキューが「処理済」として捨てる**
    // （ui-writing.md §5 / `lib/offline/policy.ts` の `verdictOf()`）。
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "PHOTO_REQUIRED" });
    expect(
      ctx.d1.queries.filter((query) => query.sql.startsWith('insert into "linen_record"')),
    ).toEqual([]);
  });

  it("施設で有効にしていない品目は保存されない（§2.5 MUST）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow()]);
    ctx.d1.enqueueRows([configRow(["BATH_TOWEL"])]);

    const res = await send(
      ctx,
      "PUT",
      `/api/v1/tasks/${TASK_ID}/linen`,
      {
        entries: [
          { itemCode: "YUKATA", collectedQty: 3, suppliedQty: 0, damagedQty: 0, stainedQty: 0 },
        ],
      },
      cookie,
    );

    expect(res.status).toBe(200);
    expect(
      ctx.d1.queries.filter((query) => query.sql.startsWith('insert into "linen_record"')),
    ).toEqual([]);
  });
});

describe("PATCH /api/v1/observations/:observationId", () => {
  it("CLEANER には 404（§2.2 MUST は PROPERTY_MANAGER 以上）", async () => {
    const ctx = setup("CLEANER");
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([observationRow(null)]);

    const res = await send(
      ctx,
      "PATCH",
      `/api/v1/observations/${OBSERVATION_ID}`,
      { ...COUNTS, reason: "枚数を数え直したため" },
      cookie,
    );

    // **403 にしない**（資源の存在を示唆しない / INV-31）。
    expect(res.status).toBe(404);
    expect(
      ctx.d1.queries.filter((query) => query.sql.startsWith('update "room_observation"')),
    ).toEqual([]);
  });

  it("INSPECTOR にも 404（検査担当は数を直せない）", async () => {
    const ctx = setup("INSPECTOR");
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([observationRow(null)]);

    const res = await send(
      ctx,
      "PATCH",
      `/api/v1/observations/${OBSERVATION_ID}`,
      { ...COUNTS, reason: "枚数を数え直したため" },
      cookie,
    );

    expect(res.status).toBe(404);
  });

  it("理由が空なら 400（§2.2 MUST）", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const cookie = await ctx.cookie();

    const res = await send(
      ctx,
      "PATCH",
      `/api/v1/observations/${OBSERVATION_ID}`,
      { ...COUNTS, reason: "" },
      cookie,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_REQUEST" });
    expect(ctx.d1.queries).toEqual([]);
  });

  it("PROPERTY_MANAGER の修正は旧値を observation_revision へ積む", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const cookie = await ctx.cookie();
    // 使用側 → `amendObservation()` の実在確認 → 履歴（採番用）→
    // batch の 2 文 → 修正後の再取得。**代役は batch の各文でも 1 組ずつ
    // 取り出す**（`test-support/fake-d1.ts` の `batch()`）。
    ctx.d1.enqueueRows([observationRow(null)]);
    ctx.d1.enqueueRows([observationRow(null)]);
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([observationRow(null)]);

    const res = await send(
      ctx,
      "PATCH",
      `/api/v1/observations/${OBSERVATION_ID}`,
      { ...COUNTS, bedsUsed: 1, reason: "枚数を数え直したため" },
      cookie,
    );

    expect(res.status).toBe(200);
    const revision = ctx.d1.queries.find((query) =>
      query.sql.startsWith('insert into "observation_revision"'),
    );
    expect(revision?.params).toContain("枚数を数え直したため");
    // security.md §6。**理由必須の監査ログが残る。**
    const audit = ctx.d1.queries.find((query) => query.sql.startsWith('insert into "audit_log"'));
    expect(audit?.params).toContain("observation.amended");
  });
});
