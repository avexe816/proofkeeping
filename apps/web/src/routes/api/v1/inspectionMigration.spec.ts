/**
 * P1 暫定機能の移行・削除の配線（P2-16）。
 *
 * 仕様: docs/PK-SPEC-P2.md §13
 * ルール: .claude/rules/security.md §1
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - 取り残しの一覧が業務日をまたいで返る（§13.3）
 *   - 緊急上書きが `EMERGENCY_OVERRIDE` として完了させる（同）
 *   - **`inspectionResult` を書かない**（§2.3「検査なしを検査合格にしない」）
 *   - 理由が無ければ 400（`AUDIT_ACTIONS` の `requiresReason`）
 *   - 監査ログに理由つきで残る（§13.3）
 *   - **`INSPECTOR` は上書きできない**（404 / §13.1 で廃止した一括承認を
 *     検査担当が 1 件ずつ再現できないようにする）
 *   - 配列を受け取る口が無い（同）
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

import inspections from "./inspections.js";
import tasks from "./tasks.js";

const SECRET = "test-session-secret-not-used-anywhere-else";
const NOW = new Date("2026-09-10T05:00:00.000Z");

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

const ORG_SHORT_ID = "a1b2c3";
const ORGANIZATION_ID = "org_test_alpha";
const ACTOR_ID = `${ORG_SHORT_ID}__mem_01JBXQ3ZK8N4P2VYR6ZZZZZZZZ`;
const CLEANER_ID = `${ORG_SHORT_ID}__mem_01JBXQ3ZK8N4P2VYR6YYYYYYYY`;
const USER_ID = `${ORG_SHORT_ID}__usr_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const PROPERTY_ID = `${ORG_SHORT_ID}__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const ROOM_ID = `${ORG_SHORT_ID}__room_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const ROOM_ID_2 = `${ORG_SHORT_ID}__room_01JBXQ3ZK8N4P2VYR6BBBBBBBB`;
const TASK_ID = `${ORG_SHORT_ID}__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const TASK_ID_2 = `${ORG_SHORT_ID}__task_01JBXQ3ZK8N4P2VYR6BBBBBBBB`;
const OTHER_ORG_TASK_ID = `zz9zz9__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

function depsFor(role: string): TenantDeps {
  return {
    findMembershipByUserId: () =>
      Promise.resolve({ id: ACTOR_ID, role: role as "PROPERTY_MANAGER", isActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

/** `cleaning_task` の 1 行。**列の順序は schema/task.ts の宣言順。** */
function taskRow(
  status: string,
  options: { taskId?: string; roomId?: string; businessDate?: string; skipReason?: string } = {},
): unknown[] {
  return [
    options.taskId ?? TASK_ID,
    ORGANIZATION_ID,
    PROPERTY_ID,
    options.roomId ?? ROOM_ID,
    options.businessDate ?? "2026-09-10",
    "CHECKOUT",
    status,
    50, // priority
    CLEANER_ID,
    40, // standard_minutes
    38, // actual_minutes
    0, // pause_count
    0, // rework_count
    1, // inspection_required
    options.skipReason === undefined ? 0 : 1, // inspection_skipped
    options.skipReason ?? null,
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
    NOW.getTime() - 3 * 60 * 60_000, // started_at
    NOW.getTime() - 2 * 60 * 60_000, // completed_at
    null, // cancelled_at
    0,
    0,
  ];
}

/** `property` の 1 行。**列の順序は schema/property.ts の宣言順。** */
function propertyRow(): unknown[] {
  return [
    PROPERTY_ID,
    ORGANIZATION_ID,
    "HTLA",
    "テスト施設",
    null, // postal_code
    null, // address
    null, // phone
    null, // contact_name
    "Asia/Tokyo",
    "05:00",
    1, // inspection_required
    0, // sort_order
    1, // is_active
    0,
    0,
  ];
}

/** `property_inspection_policy` の 1 行。**列の順序は schema/inspection.ts の宣言順。** */
function policyRow(mode: string): unknown[] {
  return [
    `${ORG_SHORT_ID}__ipol_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
    ORGANIZATION_ID,
    PROPERTY_ID,
    mode,
    mode === "ALL" ? 100 : 0,
    0,
    1,
    1,
    0,
    1,
    20,
    0,
    0,
  ];
}

/** `room` の 1 行。**列の順序は schema/property.ts の宣言順。** */
function roomRow(roomId: string, roomNumber: string): unknown[] {
  return [
    roomId,
    ORGANIZATION_ID,
    PROPERTY_ID,
    null,
    null,
    null,
    roomNumber,
    1,
    "MANUAL",
    null,
    null,
    0,
    1,
    0,
    0,
  ];
}

interface Ctx {
  app: Hono<AppEnv>;
  env: Env;
  d1: FakeD1;
  cookie: () => Promise<string>;
}

function setup(role = "PROPERTY_MANAGER"): Ctx {
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
  api.route("/inspections", inspections);
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
        membershipId: ACTOR_ID,
        authMethod: "PASSWORD",
        now: NOW,
      });
      return `${SESSION_COOKIE_NAME}=${created.cookieValue}`;
    },
  };
}

async function get(ctx: Ctx, path: string, cookie: string): Promise<Response> {
  return ctx.app.request(path, { headers: { Cookie: cookie } }, ctx.env);
}

async function post(ctx: Ctx, path: string, body: unknown, cookie: string): Promise<Response> {
  return ctx.app.request(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    },
    ctx.env,
  );
}

/** 発行された SQL のうち、表 `table` への書き込み。 */
function writesTo(ctx: Ctx, table: string): { sql: string; params: unknown[] }[] {
  return ctx.d1.queries.filter(
    (query) =>
      (query.sql.startsWith("insert into") || query.sql.startsWith("update")) &&
      query.sql.includes(`"${table}"`),
  );
}

/** 上書きが読む順に積む（findTaskById → findOpenInspectionByTask）。 */
function enqueueOverride(ctx: Ctx, task: unknown[], openInspection: unknown[][] = []): void {
  ctx.d1.enqueueRows([task]);
  ctx.d1.enqueueRows(openInspection);
}

// ────────────────────────────────────────────────────────────
// GET /inspections/stranded（§13.3）
// ────────────────────────────────────────────────────────────

describe("GET /api/v1/inspections/stranded", () => {
  it("業務日をまたいだ検査待ちを、古い順に返す", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    // buildStrandedList の Promise.all（宣言順に発行される）
    ctx.d1.enqueueRows([
      taskRow("AWAITING_INSPECTION", {
        taskId: TASK_ID_2,
        roomId: ROOM_ID_2,
        businessDate: "2026-09-10",
      }),
      taskRow("AWAITING_INSPECTION", { businessDate: "2026-08-30" }),
    ]); // listTasks
    ctx.d1.enqueueRows([roomRow(ROOM_ID, "302"), roomRow(ROOM_ID_2, "410")]); // listRooms
    ctx.d1.enqueueRows([policyRow("NONE")]); // findInspectionPolicy
    ctx.d1.enqueueRows([propertyRow()]); // findPropertyById

    const res = await get(ctx, `/api/v1/inspections/stranded?propertyId=${PROPERTY_ID}`, cookie);
    expect(res.status).toBe(200);

    // **並びまで見る。** 古い取り残しから片付けるための一覧なので、
    // 順序が崩れると読み手の判断が変わる。
    expect(await res.json()).toMatchObject({
      mode: "NONE",
      data: [{ businessDate: "2026-08-30" }, { businessDate: "2026-09-10" }],
    });
  });

  it("業務日で絞らない（M-08 と違って古い日付が落ちない）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([policyRow("ALL")]);
    ctx.d1.enqueueRows([propertyRow()]);

    await get(ctx, `/api/v1/inspections/stranded?propertyId=${PROPERTY_ID}`, cookie);

    const listing = ctx.d1.queries.find((query) => query.sql.includes('from "cleaning_task"'));
    // 選択する列には出るので、**絞り込み条件**を見る。
    expect(listing?.sql.split(" where ")[1]).not.toContain("business_date");
  });

  it("検査方式の行が無ければ P1 の設定から組み立てる（既定の ALL で埋めない）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([]); // findInspectionPolicy … 行が無い
    ctx.d1.enqueueRows([propertyRow()]); // inspection_required = 1

    const res = await get(ctx, `/api/v1/inspections/stranded?propertyId=${PROPERTY_ID}`, cookie);

    expect(await res.json()).toMatchObject({ mode: "ALL" });
  });

  it("施設を指定しないと 400", async () => {
    const ctx = setup();
    const res = await get(ctx, "/api/v1/inspections/stranded", await ctx.cookie());
    expect(res.status).toBe(400);
  });

  it("担当外の施設は 404（403 を返さない / INV-31）", async () => {
    const ctx = setup();
    const res = await get(
      ctx,
      `/api/v1/inspections/stranded?propertyId=${ORG_SHORT_ID}__prop_01JBXQ3ZK8N4P2VYR6ZZZZZZZZ`,
      await ctx.cookie(),
    );
    expect(res.status).toBe(404);
  });
});

// ────────────────────────────────────────────────────────────
// POST /tasks/:taskId/inspection/override（§13.3）
// ────────────────────────────────────────────────────────────

describe("POST /api/v1/tasks/:taskId/inspection/override", () => {
  it("検査せずに COMPLETED へ進め、省略理由を EMERGENCY_OVERRIDE で残す", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    enqueueOverride(ctx, taskRow("AWAITING_INSPECTION"));

    const res = await post(
      ctx,
      `/api/v1/tasks/${TASK_ID}/inspection/override`,
      { reason: "P2 移行。検査担当が不在のまま 2 週間経過" },
      cookie,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ taskId: TASK_ID, status: "COMPLETED", unchanged: false });

    const update = writesTo(ctx, "cleaning_task")[0];
    expect(update?.params).toContain("EMERGENCY_OVERRIDE");
    // **楽観的排他。** 検査待ちの行にしか当たらない。
    expect(update?.params).toContain("AWAITING_INSPECTION");
  });

  it("検査合格として記録しない（§2.3）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    enqueueOverride(ctx, taskRow("AWAITING_INSPECTION"));

    await post(ctx, `/api/v1/tasks/${TASK_ID}/inspection/override`, { reason: "移行" }, cookie);

    const update = writesTo(ctx, "cleaning_task")[0];
    expect(update?.sql).not.toContain("inspection_result");
    expect(update?.params).not.toContain("PASS");
    // 検査の行そのものを作らない（§13.3「後付けで Inspection を作らない」）。
    expect(writesTo(ctx, "inspection")).toEqual([]);
  });

  it("客室を READY にする（検査待ちのまま残さない）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    enqueueOverride(ctx, taskRow("AWAITING_INSPECTION"));

    await post(ctx, `/api/v1/tasks/${TASK_ID}/inspection/override`, { reason: "移行" }, cookie);

    expect(writesTo(ctx, "room")[0]?.params).toContain("READY");
  });

  it("監査ログに理由つきで残る", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    enqueueOverride(ctx, taskRow("AWAITING_INSPECTION"));

    await post(
      ctx,
      `/api/v1/tasks/${TASK_ID}/inspection/override`,
      { reason: "検査担当が不在" },
      cookie,
    );

    const audit = writesTo(ctx, "audit_log")[0];
    expect(audit?.params).toContain("inspection.emergencyOverride");
    expect(audit?.params).toContain("検査担当が不在");
  });

  it("理由が無ければ 400（状態を触らない）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await post(ctx, `/api/v1/tasks/${TASK_ID}/inspection/override`, {}, cookie);

    expect(res.status).toBe(400);
    expect(writesTo(ctx, "cleaning_task")).toEqual([]);
  });

  it("空文字の理由を通さない", async () => {
    const ctx = setup();
    const res = await post(
      ctx,
      `/api/v1/tasks/${TASK_ID}/inspection/override`,
      { reason: "" },
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("検査待ちでないタスクは 409", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow("IN_PROGRESS")]);

    const res = await post(
      ctx,
      `/api/v1/tasks/${TASK_ID}/inspection/override`,
      { reason: "移行" },
      cookie,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "INVALID_TRANSITION" });
  });

  it("既に上書き済みなら成功として返し、状態を触らない（再送）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow("COMPLETED", { skipReason: "EMERGENCY_OVERRIDE" })]);

    const res = await post(
      ctx,
      `/api/v1/tasks/${TASK_ID}/inspection/override`,
      { reason: "移行" },
      cookie,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ taskId: TASK_ID, status: "COMPLETED", unchanged: true });
    expect(writesTo(ctx, "cleaning_task")).toEqual([]);
    // **監査ログも二重に積まない。**
    expect(writesTo(ctx, "audit_log")).toEqual([]);
  });

  it("検査が始まっているタスクは横取りしない", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    enqueueOverride(ctx, taskRow("AWAITING_INSPECTION"), [
      [
        `${ORG_SHORT_ID}__insp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
        ORGANIZATION_ID,
        PROPERTY_ID,
        TASK_ID,
        1,
        ACTOR_ID,
      ],
    ]);

    const res = await post(
      ctx,
      `/api/v1/tasks/${TASK_ID}/inspection/override`,
      { reason: "移行" },
      cookie,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "INSPECTION_ALREADY_STARTED" });
    expect(writesTo(ctx, "cleaning_task")).toEqual([]);
  });

  it("別テナントのタスクは 404（DB へ行かない）", async () => {
    const ctx = setup();
    const res = await post(
      ctx,
      `/api/v1/tasks/${OTHER_ORG_TASK_ID}/inspection/override`,
      { reason: "移行" },
      await ctx.cookie(),
    );

    expect(res.status).toBe(404);
    expect(ctx.d1.queries).toEqual([]);
  });

  it("INSPECTOR は上書きできない（404）", async () => {
    const ctx = setup("INSPECTOR");
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow("AWAITING_INSPECTION")]);

    const res = await post(
      ctx,
      `/api/v1/tasks/${TASK_ID}/inspection/override`,
      { reason: "移行" },
      cookie,
    );

    expect(res.status).toBe(404);
    expect(writesTo(ctx, "cleaning_task")).toEqual([]);
  });

  it("CLEANER は上書きできない（404）", async () => {
    const ctx = setup("CLEANER");
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow("AWAITING_INSPECTION")]);

    const res = await post(
      ctx,
      `/api/v1/tasks/${TASK_ID}/inspection/override`,
      { reason: "移行" },
      cookie,
    );

    expect(res.status).toBe(404);
  });

  it("まとめて閉じる口が無い（配列を受け取らない）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow("AWAITING_INSPECTION")]);

    // §13.1 で廃止した一括承認を、名前を変えて戻さないための回帰。
    const res = await post(
      ctx,
      `/api/v1/tasks/${TASK_ID}/inspection/override`,
      { taskIds: [TASK_ID, TASK_ID_2], reason: "移行" },
      cookie,
    );

    // 余分な鍵は無視され、対象は経路の `:taskId` 1 件だけ。
    expect(res.status).toBe(200);
    expect(writesTo(ctx, "cleaning_task")).toHaveLength(1);
  });
});
