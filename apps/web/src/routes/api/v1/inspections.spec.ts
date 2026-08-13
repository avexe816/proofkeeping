/**
 * 検査 API の配線（P2-04）。
 *
 * 仕様: docs/PK-SPEC-P2.md §4.2〜§4.5
 * ルール: .claude/rules/security.md §1
 *
 * ── 見ているもの ────────────────────────────────────────
 * 集約そのものは `packages/engine` の inspectionResult.spec.ts が表で押さえ、
 * 排他は `durable/InspectionLock.spec.ts` が押さえる。ここは
 * **task の完了条件 4 つが経路として成立していること**だけを見る。
 *   - 清掃担当者本人が自分のタスクを検査できない（404 ではなく 409 で、
 *     資源の存在は権限で既に確かめられている）
 *   - 自己検査の例外に理由と監査ログが必須
 *   - 1 項目でも FAIL があれば全体が FAIL
 *   - FAIL に理由コード・コメント・写真がないと完了できない
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
import {
  InspectionGate,
  type InspectionHolder,
  type LockStorage,
} from "../../../durable/InspectionLock.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import inspections from "./inspections.js";
import tasks from "./tasks.js";

const SECRET = "test-session-secret-not-used-anywhere-else";
const NOW = new Date("2026-09-10T04:00:00.000Z");

// セッションの失効は実時刻で判定される。時計を止めないと、実時刻が
// `NOW + 12h` を過ぎた日から全件 401 になる（tasks.spec.ts と同じ）。
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

const ORG_SHORT_ID = "a1b2c3";
const ORGANIZATION_ID = "org_test_alpha";
const INSPECTOR_ID = `${ORG_SHORT_ID}__mem_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const CLEANER_ID = `${ORG_SHORT_ID}__mem_01JBXQ3ZK8N4P2VYR6ZZZZZZZZ`;
const USER_ID = `${ORG_SHORT_ID}__usr_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const PROPERTY_ID = `${ORG_SHORT_ID}__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const ROOM_ID = `${ORG_SHORT_ID}__room_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const TASK_ID = `${ORG_SHORT_ID}__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const INSPECTION_ID = `${ORG_SHORT_ID}__insp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const ITEM_A = `${ORG_SHORT_ID}__citm_01JBXQ3ZK8N4P2VYR6AAAAAAAA`;
const ITEM_B = `${ORG_SHORT_ID}__citm_01JBXQ3ZK8N4P2VYR6BBBBBBBB`;
const ITEM_RESULT_A = `${ORG_SHORT_ID}__ires_01JBXQ3ZK8N4P2VYR6AAAAAAAA`;
const ITEM_RESULT_B = `${ORG_SHORT_ID}__ires_01JBXQ3ZK8N4P2VYR6BBBBBBBB`;
const OTHER_ORG_TASK_ID = `zz9zz9__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

/** 既定は検査担当。清掃員の経路を見る test だけ `role` を差し替える。 */
function depsFor(role: TenantDeps extends never ? never : string = "INSPECTOR"): TenantDeps {
  return {
    findMembershipByUserId: () =>
      Promise.resolve({ id: INSPECTOR_ID, role: role as "INSPECTOR", isActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

/** `cleaning_task` の 1 行。**列の順序は schema/task.ts の宣言順。** */
function taskRow(
  status: string,
  options: { assigneeId?: string | null; round?: number } = {},
): unknown[] {
  return [
    TASK_ID,
    ORGANIZATION_ID,
    PROPERTY_ID,
    ROOM_ID,
    "2026-09-10",
    "CHECKOUT",
    status,
    40, // priority
    options.assigneeId === undefined ? CLEANER_ID : options.assigneeId,
    40, // standard_minutes
    null, // actual_minutes
    0, // pause_count
    0, // rework_count
    1, // inspection_required
    0, // inspection_skipped
    null, // inspection_skip_reason
    null, // inspector_id
    null, // inspected_at
    null, // inspection_result
    options.round ?? 0, // current_inspection_round
    "AUTO",
    null, // note
    null, // blocked_reason
    "a1b2c3d4", // short_id
    null, // sequence_in_day
    null, // assigned_at
    null, // started_at
    null, // completed_at
    null, // cancelled_at
    0,
    0,
  ];
}

/** `property_inspection_policy` の 1 行。**列の順序は schema/inspection.ts の宣言順。** */
function policyRow(selfInspectionAllowed: boolean): unknown[] {
  return [
    `${ORG_SHORT_ID}__ipol_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
    ORGANIZATION_ID,
    PROPERTY_ID,
    "ALL",
    100, // sample_rate
    3, // min_daily_sample
    1, // always_inspect_checkin
    1, // always_inspect_rework
    selfInspectionAllowed ? 1 : 0,
    1, // auto_assign_inspector
    20, // inspection_sla_minutes
    0,
    0,
  ];
}

/** `inspection` の 1 行。**列の順序は schema/inspection.ts の宣言順。** */
function inspectionRow(
  options: { inspectorId?: string; result?: string | null; round?: number } = {},
): unknown[] {
  return [
    INSPECTION_ID,
    ORGANIZATION_ID,
    PROPERTY_ID,
    TASK_ID,
    options.round ?? 1,
    options.inspectorId ?? INSPECTOR_ID,
    options.result ?? null,
    NOW.getTime() - 60_000, // started_at
    null, // completed_at
    null, // duration_seconds
    0, // self_approved
    null, // override_reason
    null, // general_note
    null, // client_ts
    null, // idempotency_key
    0, // created_at
  ];
}

/** `task_checklist_result` の 1 行。**列の順序は schema/checklist.ts の宣言順。** */
function cleaningResultRow(itemId: string, sortOrder: number): unknown[] {
  return [
    `${ORG_SHORT_ID}__cres_01JBXQ3ZK8N4P2VYR6${sortOrder === 0 ? "AAAAAAAA" : "BBBBBBBB"}`,
    ORGANIZATION_ID,
    PROPERTY_ID,
    TASK_ID,
    itemId,
    1, // template_version
    1, // is_required
    0, // photo_required
    "DONE", // value
    null, // reason_code
    NOW.getTime(),
    CLEANER_ID,
    sortOrder,
    0,
    0,
  ];
}

/** `inspection_item_result` の 1 行。**列の順序は schema/inspection.ts の宣言順。** */
function itemResultRow(
  id: string,
  checklistItemId: string,
  status: string,
  options: { defectCode?: string | null; note?: string | null } = {},
): unknown[] {
  return [
    id,
    ORGANIZATION_ID,
    PROPERTY_ID,
    INSPECTION_ID,
    checklistItemId,
    status,
    options.defectCode ?? null,
    options.note ?? null,
    status === "FAIL" ? 1 : 0, // rework_required
    null, // rework_due_at
    0,
    0,
  ];
}

/** `checklist_item` の 1 行。**列の順序は schema/checklist.ts の宣言順。** */
function checklistItemRow(id: string, sortOrder: number): unknown[] {
  return [
    id,
    ORGANIZATION_ID,
    `${ORG_SHORT_ID}__ctpl_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
    "bathroom",
    JSON.stringify({ ja: "洗面台" }),
    1, // is_required
    0, // photo_required
    sortOrder,
    0,
    0,
  ];
}

/** `room` の 1 行。**列の順序は schema/property.ts の宣言順。** */
function roomRow(): unknown[] {
  return [
    ROOM_ID,
    ORGANIZATION_ID,
    PROPERTY_ID,
    null, // building_id
    null, // floor_id
    null, // room_type_id
    "302",
    1, // is_sellable
    "MANUAL",
    null, // external_room_id
    null, // note
    0, // sort_order
    1, // is_active
    0,
    0,
  ];
}

/** `InspectionLock` の代役。**経路は DO と同じ 3 本。** */
function createFakeLockNamespace(): DurableObjectNamespace {
  const gates = new Map<string, InspectionGate>();
  const gateFor = (name: string): InspectionGate => {
    const existing = gates.get(name);
    if (existing !== undefined) return existing;
    const store = new Map<string, InspectionHolder>();
    const storage: LockStorage = {
      get: (key) => Promise.resolve(store.get(key)),
      put: (key, value) => {
        store.set(key, value);
        return Promise.resolve();
      },
      delete: (key) => {
        store.delete(key);
        return Promise.resolve();
      },
    };
    const gate = new InspectionGate(storage);
    gates.set(name, gate);
    return gate;
  };

  return {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      async fetch(url: string, init?: { body?: string }): Promise<Response> {
        const gate = gateFor(name);
        const path = new URL(url).pathname;
        const body: Record<string, never> =
          init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, never>);
        if (path === "/acquire") {
          const result = await gate.acquire({
            round: Number(body.round),
            inspectorId: String(body.inspectorId),
            nowMs: Number(body.nowMs),
          });
          return Response.json(result, { status: result.acquired ? 200 : 409 });
        }
        if (path === "/release") {
          return Response.json({ released: await gate.release(Number(body.round)) });
        }
        return Response.json({ holder: await gate.peek() });
      },
    }),
  } as unknown as DurableObjectNamespace;
}

interface Ctx {
  app: Hono<AppEnv>;
  env: Env;
  d1: FakeD1;
  lock: DurableObjectNamespace;
  cookie: () => Promise<string>;
}

function setup(role = "INSPECTOR"): Ctx {
  const kv = createFakeKv();
  const d1 = createFakeD1();
  const lock = createFakeLockNamespace();
  const env = {
    SESSION: kv.namespace,
    SESSION_SECRET: SECRET,
    SHARD_COUNT: "1",
    SHARD_00: d1.database,
    SHARD_MAP: createFakeKv().namespace,
    INSPECTION_LOCK: lock,
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
    lock,
    cookie: async () => {
      const created = await createSession(env, {
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        orgShortId: ORG_SHORT_ID,
        membershipId: INSPECTOR_ID,
        authMethod: "PASSWORD",
        now: NOW,
      });
      return `${SESSION_COOKIE_NAME}=${created.cookieValue}`;
    },
  };
}

async function post(
  ctx: Ctx,
  path: string,
  body: unknown,
  cookie: string | null,
  idempotencyKey?: string,
): Promise<Response> {
  return ctx.app.request(
    path,
    {
      method: "POST",
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

/** 発行された SQL のうち、表 `table` への書き込み。 */
function writesTo(ctx: Ctx, table: string): string[] {
  return ctx.d1.queries
    .map((query) => query.sql)
    .filter(
      (sql) =>
        (sql.startsWith("insert into") || sql.startsWith("update")) && sql.includes(`"${table}"`),
    );
}

// ────────────────────────────────────────────────────────────
// 検査開始（§4.2）
// ────────────────────────────────────────────────────────────

describe("POST /api/v1/tasks/:taskId/inspection/start", () => {
  it("セッションが無ければ 401", async () => {
    const ctx = setup();

    const res = await post(ctx, `/api/v1/tasks/${TASK_ID}/inspection/start`, {}, null);

    expect(res.status).toBe(401);
  });

  it("他組織の taskId は 404 で、DB に触れない", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await post(ctx, `/api/v1/tasks/${OTHER_ORG_TASK_ID}/inspection/start`, {}, cookie);

    expect(res.status).toBe(404);
    expect(ctx.d1.queries.filter((query) => query.sql.includes("cleaning_task"))).toEqual([]);
  });

  it("CLEANER は検査を開始できない（404）", async () => {
    // security.md §1 / §5.1。清掃員に検査権限は無い。**403 ではなく 404。**
    const ctx = setup("CLEANER");
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow("AWAITING_INSPECTION")]);

    const res = await post(ctx, `/api/v1/tasks/${TASK_ID}/inspection/start`, {}, cookie);

    expect(res.status).toBe(404);
    expect(writesTo(ctx, "inspection")).toEqual([]);
  });

  it("検査待ちでないタスクは INVALID_TRANSITION（§4.1）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow("IN_PROGRESS")]);

    const res = await post(ctx, `/api/v1/tasks/${TASK_ID}/inspection/start`, {}, cookie);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "INVALID_TRANSITION" });
    expect(writesTo(ctx, "inspection")).toEqual([]);
  });

  // ── 完了条件 1: 清掃担当者本人が自分のタスクを検査できない ──
  it("清掃担当者本人の検査は SELF_INSPECTION_FORBIDDEN（既定）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    // 担当者＝検査しようとしている本人。施設の設定は無い（＝許していない）。
    ctx.d1.enqueueRows([taskRow("AWAITING_INSPECTION", { assigneeId: INSPECTOR_ID })]);
    ctx.d1.enqueueRows([]); // property_inspection_policy（行が無い）

    const res = await post(
      ctx,
      `/api/v1/tasks/${TASK_ID}/inspection/start`,
      { overrideReason: "急いでいるため" },
      cookie,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "SELF_INSPECTION_FORBIDDEN" });
    // **理由を書いても通らない。** 施設が許していないため。
    expect(writesTo(ctx, "inspection")).toEqual([]);
  });

  // ── 完了条件 2: 自己検査の例外に理由と監査ログが必須 ──
  it("施設が許していても、理由が無ければ REASON_REQUIRED", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow("AWAITING_INSPECTION", { assigneeId: INSPECTOR_ID })]);
    ctx.d1.enqueueRows([policyRow(true)]);

    const res = await post(ctx, `/api/v1/tasks/${TASK_ID}/inspection/start`, {}, cookie);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "REASON_REQUIRED" });
    expect(writesTo(ctx, "inspection")).toEqual([]);
  });

  it("施設が許し、理由があれば通る。**監査ログが残る**", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow("AWAITING_INSPECTION", { assigneeId: INSPECTOR_ID })]);
    ctx.d1.enqueueRows([policyRow(true)]);
    ctx.d1.enqueueRows([]); // 開いている検査は無い
    ctx.d1.enqueueRows([inspectionRow()]); // INSERT 後の読み直し
    ctx.d1.enqueueRows([taskRow("AWAITING_INSPECTION", { assigneeId: INSPECTOR_ID })]);
    ctx.d1.enqueueRows([roomRow()]);

    const res = await post(
      ctx,
      `/api/v1/tasks/${TASK_ID}/inspection/start`,
      { overrideReason: "他の検査者が不在のため" },
      cookie,
    );

    expect(res.status).toBe(200);
    const audits = ctx.d1.queries.filter((query) => query.sql.includes("audit_log"));
    expect(audits).toHaveLength(1);
    // 理由が監査ログに載っている（security.md §1「理由必須＋監査ログ」）。
    expect(audits[0]?.params).toContain("他の検査者が不在のため");
  });

  // ── testing.md §5: 同時検査開始 ─────────────────────────
  it("別の検査者が開いている検査があれば INSPECTION_ALREADY_STARTED（§4.2）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow("AWAITING_INSPECTION")]);
    ctx.d1.enqueueRows([]); // policy
    ctx.d1.enqueueRows([inspectionRow({ inspectorId: CLEANER_ID })]); // 別人が保持

    const res = await post(ctx, `/api/v1/tasks/${TASK_ID}/inspection/start`, {}, cookie);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "INSPECTION_ALREADY_STARTED" });
    expect(writesTo(ctx, "inspection")).toEqual([]);
  });

  it("同じ検査者の再要求は開いている検査を返す（画面の再読み込み）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow("AWAITING_INSPECTION")]);
    ctx.d1.enqueueRows([]); // policy
    ctx.d1.enqueueRows([inspectionRow()]); // 自分が保持
    ctx.d1.enqueueRows([taskRow("AWAITING_INSPECTION")]);
    ctx.d1.enqueueRows([roomRow()]);

    const res = await post(ctx, `/api/v1/tasks/${TASK_ID}/inspection/start`, {}, cookie);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      unchanged: true,
      data: { inspectionId: INSPECTION_ID, round: 1 },
    });
    // **新しい検査を作っていない。**
    expect(writesTo(ctx, "inspection")).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// 検査項目（§4.3）
// ────────────────────────────────────────────────────────────

describe("PUT /api/v1/inspections/:inspectionId/items", () => {
  it("確定済みの検査は書き換えられない", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([inspectionRow({ result: "PASS" })]);

    const res = await ctx.app.request(
      `/api/v1/inspections/${INSPECTION_ID}/items`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ checklistItemId: ITEM_A, status: "PASS" }),
      },
      ctx.env,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "INSPECTION_ALREADY_COMPLETED" });
    expect(writesTo(ctx, "inspection_item_result")).toEqual([]);
  });

  it("**配列を受け取らない**（「全て合格」を 1 回で送れない）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await ctx.app.request(
      `/api/v1/inspections/${INSPECTION_ID}/items`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify([
          { checklistItemId: ITEM_A, status: "PASS" },
          { checklistItemId: ITEM_B, status: "PASS" },
        ]),
      },
      ctx.env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_REQUEST" });
    expect(writesTo(ctx, "inspection_item_result")).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// 検査完了（§4.4 / §4.5）
// ────────────────────────────────────────────────────────────

/**
 * 完了経路の読み取りを積む。
 *
 * 順序は `completeInspectionUseCase()` の手順どおり:
 *   inspection → cleaning_task → room →
 *   （項目）task_checklist_result → inspection_item_result → inspection_photo →
 *   checklist_item
 */
function enqueueCompleteReads(
  ctx: Ctx,
  itemResults: unknown[][],
  photoCounts: unknown[][] = [],
): void {
  ctx.d1.enqueueRows([inspectionRow()]);
  ctx.d1.enqueueRows([taskRow("AWAITING_INSPECTION")]);
  ctx.d1.enqueueRows([roomRow()]);
  ctx.d1.enqueueRows([cleaningResultRow(ITEM_A, 0), cleaningResultRow(ITEM_B, 1)]);
  ctx.d1.enqueueRows(itemResults);
  ctx.d1.enqueueRows(photoCounts);
  ctx.d1.enqueueRows([checklistItemRow(ITEM_A, 0), checklistItemRow(ITEM_B, 1)]);
}

describe("POST /api/v1/inspections/:inspectionId/complete", () => {
  // ── 完了条件 3: 1 項目でも FAIL があれば全体が FAIL ──
  it("1 項目が FAIL なら全体が FAIL。タスクは REWORK、差戻しが作られる（§4.5）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    enqueueCompleteReads(
      ctx,
      [
        itemResultRow(ITEM_RESULT_A, ITEM_A, "PASS"),
        itemResultRow(ITEM_RESULT_B, ITEM_B, "FAIL", {
          defectCode: "HAIR",
          note: "浴槽に髪の毛",
        }),
      ],
      [[ITEM_RESULT_B, 1]],
    );
    ctx.d1.enqueueRows([inspectionRow({ result: "FAIL" })]); // 確定後の読み直し

    const res = await post(ctx, `/api/v1/inspections/${INSPECTION_ID}/complete`, {}, cookie);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      result: "FAIL",
      taskStatus: "REWORK",
      unchanged: false,
    });
    // 差戻しサイクルが 1 件（§4.5）。
    expect(writesTo(ctx, "rework_cycle")).toHaveLength(1);
    // 客室は DIRTY へ戻る（§4.5）。
    const roomUpdate = ctx.d1.queries.find(
      (query) => query.sql.startsWith("update") && query.sql.includes('"room"'),
    );
    expect(roomUpdate?.params).toContain("DIRTY");
  });

  it("全項目 PASS なら合格。タスクは COMPLETED、客室は READY（§4.4）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    enqueueCompleteReads(ctx, [
      itemResultRow(ITEM_RESULT_A, ITEM_A, "PASS"),
      itemResultRow(ITEM_RESULT_B, ITEM_B, "NOT_APPLICABLE"),
    ]);
    ctx.d1.enqueueRows([inspectionRow({ result: "PASS" })]);

    const res = await post(ctx, `/api/v1/inspections/${INSPECTION_ID}/complete`, {}, cookie);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      result: "PASS",
      taskStatus: "COMPLETED",
      reworkCycleId: null,
    });
    // 差戻しは作られない。
    expect(writesTo(ctx, "rework_cycle")).toEqual([]);
    const roomUpdate = ctx.d1.queries.find(
      (query) => query.sql.startsWith("update") && query.sql.includes('"room"'),
    );
    expect(roomUpdate?.params).toContain("READY");
  });

  // ── 完了条件 4: FAIL に理由コード・コメント・写真 ──
  it("FAIL に写真が無ければ完了できない（§4.3）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    enqueueCompleteReads(ctx, [
      itemResultRow(ITEM_RESULT_A, ITEM_A, "PASS"),
      itemResultRow(ITEM_RESULT_B, ITEM_B, "FAIL", { defectCode: "HAIR", note: "浴槽に髪の毛" }),
    ]);

    const res = await post(ctx, `/api/v1/inspections/${INSPECTION_ID}/complete`, {}, cookie);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "DEFECT_DETAILS_REQUIRED",
      details: { missingPhotoItemIds: [ITEM_B] },
    });
    // **検査は確定していない。**
    expect(writesTo(ctx, "inspection")).toEqual([]);
    expect(writesTo(ctx, "cleaning_task")).toEqual([]);
  });

  it("FAIL に理由コードとコメントが無ければ完了できない（§4.3）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    enqueueCompleteReads(
      ctx,
      [
        itemResultRow(ITEM_RESULT_A, ITEM_A, "PASS"),
        itemResultRow(ITEM_RESULT_B, ITEM_B, "FAIL"),
      ],
      [[ITEM_RESULT_B, 1]],
    );

    const res = await post(ctx, `/api/v1/inspections/${INSPECTION_ID}/complete`, {}, cookie);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "DEFECT_DETAILS_REQUIRED",
      details: { missingDefectCodeItemIds: [ITEM_B], missingNoteItemIds: [ITEM_B] },
    });
  });

  it("答えていない項目があれば ITEMS_INCOMPLETE（未選択を PASS にしない）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    // 項目 B の行が無い＝まだ見ていない。
    enqueueCompleteReads(ctx, [itemResultRow(ITEM_RESULT_A, ITEM_A, "PASS")]);

    const res = await post(ctx, `/api/v1/inspections/${INSPECTION_ID}/complete`, {}, cookie);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "ITEMS_INCOMPLETE",
      details: { unansweredItemIds: [ITEM_B] },
    });
    expect(writesTo(ctx, "cleaning_task")).toEqual([]);
  });

  it("確定済みの検査への再送は、その結果を返して何も書かない", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([inspectionRow({ result: "PASS" })]);
    ctx.d1.enqueueRows([taskRow("COMPLETED")]);
    ctx.d1.enqueueRows([roomRow()]);

    const res = await post(ctx, `/api/v1/inspections/${INSPECTION_ID}/complete`, {}, cookie);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: "PASS", unchanged: true });
    expect(ctx.d1.queries.filter((query) => query.sql.startsWith("update"))).toEqual([]);
    expect(ctx.d1.queries.filter((query) => query.sql.startsWith("insert into"))).toEqual([]);
  });

  it("**ボディで判定を上書きできない**（§4.3 MUST）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    enqueueCompleteReads(
      ctx,
      [
        itemResultRow(ITEM_RESULT_A, ITEM_A, "PASS"),
        itemResultRow(ITEM_RESULT_B, ITEM_B, "FAIL", { defectCode: "HAIR", note: "髪の毛" }),
      ],
      [[ITEM_RESULT_B, 1]],
    );
    ctx.d1.enqueueRows([inspectionRow({ result: "FAIL" })]);

    // 検査者が「全体は合格」と主張してくる。
    const res = await post(
      ctx,
      `/api/v1/inspections/${INSPECTION_ID}/complete`,
      { result: "PASS" },
      cookie,
    );

    expect(res.status).toBe(200);
    // **無視される。** 項目に FAIL がある以上、全体は FAIL。
    expect(await res.json()).toMatchObject({ result: "FAIL", taskStatus: "REWORK" });
  });
});
