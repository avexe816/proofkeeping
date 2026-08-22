/**
 * 差戻し・再清掃 API の配線（P2-07）。
 *
 * 仕様: docs/PK-SPEC-P2.md §4.6 / §4.7
 * ルール: .claude/rules/security.md §1
 *
 * ── 見ているもの ────────────────────────────────────────
 * 状態機械そのものは `packages/engine` の reworkStatus.spec.ts が表で
 * 押さえる。ここは **task の完了条件 4 つが経路として成立していること**。
 *   - 差戻し項目だけが再清掃画面に表示される（§4.6）
 *   - 元のチェックリスト結果が変更されない（§4.6）
 *   - 2 回以上のラウンドが正しく記録される（§4.5 / §3.4）
 *   - Waive に理由と関連 Issue が必須（§4.7）
 * 併せて、**`CLEANER` が他人の差戻しに到達できない**ことも見る（404）。
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

import reworks from "./reworks.js";

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
const CLEANER_ID = `${ORG_SHORT_ID}__mem_01JBXQ3ZK8N4P2VYR6ZZZZZZZZ`;
const OTHER_CLEANER_ID = `${ORG_SHORT_ID}__mem_01JBXQ3ZK8N4P2VYR6YYYYYYYY`;
const USER_ID = `${ORG_SHORT_ID}__usr_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const PROPERTY_ID = `${ORG_SHORT_ID}__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const ROOM_ID = `${ORG_SHORT_ID}__room_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const TASK_ID = `${ORG_SHORT_ID}__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const INSPECTION_ID = `${ORG_SHORT_ID}__insp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const REWORK_ID = `${ORG_SHORT_ID}__rwk_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const ISSUE_ID = `${ORG_SHORT_ID}__issue_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const ITEM_FAIL = `${ORG_SHORT_ID}__citm_01JBXQ3ZK8N4P2VYR6AAAAAAAA`;
const ITEM_PASS = `${ORG_SHORT_ID}__citm_01JBXQ3ZK8N4P2VYR6BBBBBBBB`;
const RESULT_FAIL = `${ORG_SHORT_ID}__ires_01JBXQ3ZK8N4P2VYR6AAAAAAAA`;
const RESULT_PASS = `${ORG_SHORT_ID}__ires_01JBXQ3ZK8N4P2VYR6BBBBBBBB`;
const OTHER_ORG_REWORK_ID = `zz9zz9__rwk_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

function depsFor(role: string): TenantDeps {
  return {
    findMembershipByUserId: () =>
      Promise.resolve({ id: CLEANER_ID, role: role as "CLEANER", isEffectiveActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

/** `cleaning_task` の 1 行。**列の順序は schema/task.ts の宣言順。** */
function taskRow(status: string, options: { round?: number; reworkCount?: number } = {}): unknown[] {
  return [
    TASK_ID,
    ORGANIZATION_ID,
    PROPERTY_ID,
    ROOM_ID,
    "2026-09-10",
    "CHECKOUT",
    status,
    40,
    CLEANER_ID,
    40,
    null,
    0,
    options.reworkCount ?? 1,
    1,
    0,
    null,
    null,
    null,
    null,
    options.round ?? 1,
    "AUTO",
    null,
    null,
    "a1b2c3d4",
    null,
    null,
    null,
    null,
    null,
    0,
    0,
  ];
}

/** `rework_cycle` の 1 行。**列の順序は schema/inspection.ts の宣言順。** */
function reworkRow(
  status: string,
  options: { assignedToId?: string; round?: number } = {},
): unknown[] {
  return [
    REWORK_ID,
    ORGANIZATION_ID,
    PROPERTY_ID,
    TASK_ID,
    INSPECTION_ID,
    options.round ?? 1,
    options.assignedToId ?? CLEANER_ID,
    status,
    "WATER_SPOT",
    NOW.getTime() + 30 * 60_000, // due_at
    status === "OPEN" ? null : NOW.getTime() - 60_000, // started_at
    null, // completed_at
    null, // waived_by_id
    null, // waived_reason
    null, // waived_issue_id
    0,
    0,
  ];
}

/** `inspection_item_result` の 1 行。**列の順序は schema/inspection.ts の宣言順。** */
function itemResultRow(id: string, itemId: string, status: string): unknown[] {
  return [
    id,
    ORGANIZATION_ID,
    PROPERTY_ID,
    INSPECTION_ID,
    itemId,
    status,
    status === "FAIL" ? "WATER_SPOT" : null,
    status === "FAIL" ? "右下に水滴跡があります" : null,
    status === "FAIL" ? 1 : 0, // rework_required
    null,
    0,
    0,
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
    1,
    1,
    0,
    "DONE",
    null,
    NOW.getTime(),
    CLEANER_ID,
    sortOrder,
    0,
    0,
  ];
}

/** `checklist_item` の 1 行。**列の順序は schema/checklist.ts の宣言順。** */
function checklistItemRow(id: string, section: string, label: string): unknown[] {
  return [
    id,
    ORGANIZATION_ID,
    `${ORG_SHORT_ID}__ctpl_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
    section,
    JSON.stringify({ ja: label }),
    1,
    0,
    0,
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
    "Asia/Tokyo",
    "05:00",
    1, // inspection_required
    null, // address
    null, // note
    0, // sort_order
    1, // is_active
    0,
    0,
  ];
}

/** `property_inspection_policy` の 1 行（ALL）。**列の順序は schema/inspection.ts の宣言順。** */
function policyRow(): unknown[] {
  return [
    `${ORG_SHORT_ID}__ipol_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
    ORGANIZATION_ID,
    PROPERTY_ID,
    "ALL",
    100,
    3,
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
function roomRow(): unknown[] {
  return [
    ROOM_ID,
    ORGANIZATION_ID,
    PROPERTY_ID,
    null,
    null,
    null,
    "302",
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

function setup(role = "CLEANER"): Ctx {
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
  api.route("/reworks", reworks);
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
        membershipId: CLEANER_ID,
        authMethod: "PIN",
        now: NOW,
      });
      return `${SESSION_COOKIE_NAME}=${created.cookieValue}`;
    },
  };
}

async function get(ctx: Ctx, path: string, cookie: string | null): Promise<Response> {
  return ctx.app.request(
    path,
    { headers: cookie === null ? {} : { Cookie: cookie } },
    ctx.env,
  );
}

async function post(
  ctx: Ctx,
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

/** 発行された SQL のうち、表 `table` への書き込み。 */
function writesTo(ctx: Ctx, table: string): string[] {
  return ctx.d1.queries
    .map((query) => query.sql)
    .filter(
      (sql) =>
        (sql.startsWith("insert into") || sql.startsWith("update")) && sql.includes(`"${table}"`),
    );
}

/** `GET /reworks/:id` が読む順に積む。 */
function enqueueDetail(ctx: Ctx, options: { assignedToId?: string; status?: string } = {}): void {
  ctx.d1.enqueueRows([
    reworkRow(options.status ?? "OPEN", {
      ...(options.assignedToId === undefined ? {} : { assignedToId: options.assignedToId }),
    }),
  ]); // findReworkCycleById
  ctx.d1.enqueueRows([taskRow("REWORK")]); // findTaskById
  ctx.d1.enqueueRows([roomRow()]); // findRoomById
  // listReworkItems の Promise.all（宣言順に発行される）
  ctx.d1.enqueueRows([
    itemResultRow(RESULT_FAIL, ITEM_FAIL, "FAIL"),
    itemResultRow(RESULT_PASS, ITEM_PASS, "PASS"),
  ]); // listInspectionItemResults
  ctx.d1.enqueueRows([]); // listInspectionPhotos
  ctx.d1.enqueueRows([
    cleaningResultRow(ITEM_FAIL, 0),
    cleaningResultRow(ITEM_PASS, 1),
  ]); // listChecklistResults
  ctx.d1.enqueueRows([checklistItemRow(ITEM_FAIL, "bathroom", "鏡")]); // listChecklistItemsByIds
}

// ────────────────────────────────────────────────────────────
// GET /api/v1/reworks/:reworkCycleId（§4.6 / §11.4）
// ────────────────────────────────────────────────────────────

describe("GET /api/v1/reworks/:reworkCycleId", () => {
  it("セッションが無ければ 401", async () => {
    const ctx = setup();

    const res = await get(ctx, `/api/v1/reworks/${REWORK_ID}`, null);

    expect(res.status).toBe(401);
  });

  it("他組織の reworkCycleId は 404 で、DB に触れない", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await get(ctx, `/api/v1/reworks/${OTHER_ORG_REWORK_ID}`, cookie);

    expect(res.status).toBe(404);
    expect(ctx.d1.queries.filter((query) => query.sql.includes("rework_cycle"))).toEqual([]);
  });

  it("差戻し項目だけが返る（合格した項目は返らない / §4.6）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    enqueueDetail(ctx);

    const res = await get(ctx, `/api/v1/reworks/${REWORK_ID}`, cookie);

    expect(res.status).toBe(200);
    const body = await res.json<{
      items: { checklistItemId: string; section: string; labels: Record<string, string> }[];
    }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.checklistItemId).toBe(ITEM_FAIL);
    // §11.4 の「浴室 > 鏡」。**ラベルが空欄にならない。**
    expect(body.items[0]?.section).toBe("bathroom");
    expect(body.items[0]?.labels.ja).toBe("鏡");
  });

  it("検査者の ID を返さない（§1.2）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    enqueueDetail(ctx);

    const res = await get(ctx, `/api/v1/reworks/${REWORK_ID}`, cookie);

    expect(await res.text()).not.toContain("inspectorId");
  });

  it("読み取りだけで、チェックリスト結果を書き換えない（§4.6）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    enqueueDetail(ctx);

    await get(ctx, `/api/v1/reworks/${REWORK_ID}`, cookie);

    expect(writesTo(ctx, "task_checklist_result")).toEqual([]);
    expect(writesTo(ctx, "inspection_item_result")).toEqual([]);
  });

  it("CLEANER は他人に割り当てられた差戻しを見られない（404）", async () => {
    const ctx = setup("CLEANER");
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([reworkRow("OPEN", { assignedToId: OTHER_CLEANER_ID })]);
    ctx.d1.enqueueRows([taskRow("REWORK")]);

    const res = await get(ctx, `/api/v1/reworks/${REWORK_ID}`, cookie);

    // **403 ではなく 404**（INV-31。403 は存在を示唆する）。
    expect(res.status).toBe(404);
  });

  it("PROPERTY_MANAGER は他人の差戻しも見られる（担当施設の範囲）", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const cookie = await ctx.cookie();
    enqueueDetail(ctx, { assignedToId: OTHER_CLEANER_ID });

    const res = await get(ctx, `/api/v1/reworks/${REWORK_ID}`, cookie);

    expect(res.status).toBe(200);
  });
});

// ────────────────────────────────────────────────────────────
// POST /waive（§4.7）
// ────────────────────────────────────────────────────────────

describe("POST /api/v1/reworks/:reworkCycleId/waive", () => {
  it("理由が無ければ 400（§4.7「理由必須」）", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const cookie = await ctx.cookie();

    const res = await post(
      ctx,
      `/api/v1/reworks/${REWORK_ID}/waive`,
      { issueReportId: ISSUE_ID, roomOutcome: "BLOCKED" },
      cookie,
    );

    expect(res.status).toBe(400);
    expect(writesTo(ctx, "rework_cycle")).toEqual([]);
  });

  it("関連 Issue が無ければ 400（§4.7「関連する IssueReport 必須」）", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const cookie = await ctx.cookie();

    const res = await post(
      ctx,
      `/api/v1/reworks/${REWORK_ID}/waive`,
      { reason: "シャワー混合栓の故障", roomOutcome: "BLOCKED" },
      cookie,
    );

    expect(res.status).toBe(400);
    expect(writesTo(ctx, "rework_cycle")).toEqual([]);
  });

  it("免除後の客室の扱いが無ければ 400（§4.7「READY か BLOCKED を選択」）", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const cookie = await ctx.cookie();

    const res = await post(
      ctx,
      `/api/v1/reworks/${REWORK_ID}/waive`,
      { reason: "シャワー混合栓の故障", issueReportId: ISSUE_ID },
      cookie,
    );

    expect(res.status).toBe(400);
  });

  it("CLEANER は免除できない（404 / §4.7 は P_MANAGER 以上）", async () => {
    const ctx = setup("CLEANER");
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([reworkRow("OPEN")]);
    ctx.d1.enqueueRows([taskRow("REWORK")]);

    const res = await post(
      ctx,
      `/api/v1/reworks/${REWORK_ID}/waive`,
      { reason: "シャワー混合栓の故障", issueReportId: ISSUE_ID, roomOutcome: "BLOCKED" },
      cookie,
    );

    expect(res.status).toBe(404);
    expect(writesTo(ctx, "rework_cycle")).toEqual([]);
  });

  it("3 つ揃っていれば差戻しを WAIVED にし、客室を動かし、監査ログを残す", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([reworkRow("OPEN")]); // findReworkCycleById
    ctx.d1.enqueueRows([taskRow("REWORK")]); // findTaskById
    ctx.d1.enqueueRows([roomRow()]); // findRoomById
    ctx.d1.enqueueRows([reworkRow("WAIVED")]); // 応答のための再取得

    const res = await post(
      ctx,
      `/api/v1/reworks/${REWORK_ID}/waive`,
      { reason: "シャワー混合栓の故障", issueReportId: ISSUE_ID, roomOutcome: "BLOCKED" },
      cookie,
    );

    expect(res.status).toBe(200);
    const update = ctx.d1.queries.find((query) => query.sql.startsWith('update "rework_cycle"'));
    expect(update?.params).toContain("WAIVED");
    expect(update?.params).toContain(ISSUE_ID);
    // **免除は行を消さない**（証跡に残す）。
    expect(ctx.d1.queries.some((query) => query.sql.startsWith("delete"))).toBe(false);
    // 客室は選ばせた側へ。
    expect(writesTo(ctx, "room").length).toBeGreaterThan(0);
    // 監査ログ 2 件（`rework.waived` と `room.statusOverridden`）。
    expect(writesTo(ctx, "audit_log").length).toBe(2);
  });

  it("免除はタスクの状態を動かさない（§10.1 の合格率を歪めない）", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([reworkRow("OPEN")]);
    ctx.d1.enqueueRows([taskRow("REWORK")]);
    ctx.d1.enqueueRows([roomRow()]);
    ctx.d1.enqueueRows([reworkRow("WAIVED")]);

    await post(
      ctx,
      `/api/v1/reworks/${REWORK_ID}/waive`,
      { reason: "シャワー混合栓の故障", issueReportId: ISSUE_ID, roomOutcome: "READY" },
      cookie,
    );

    expect(writesTo(ctx, "cleaning_task")).toEqual([]);
  });

  it("既に解決済みの差戻しは免除できない（409）", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([reworkRow("RESOLVED")]);
    ctx.d1.enqueueRows([taskRow("AWAITING_INSPECTION")]);
    ctx.d1.enqueueRows([roomRow()]);

    const res = await post(
      ctx,
      `/api/v1/reworks/${REWORK_ID}/waive`,
      { reason: "シャワー混合栓の故障", issueReportId: ISSUE_ID, roomOutcome: "READY" },
      cookie,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "REWORK_ALREADY_SETTLED" });
  });

  it("免除の再送は 200 で、状態を二重に書かない", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([reworkRow("WAIVED")]);
    ctx.d1.enqueueRows([taskRow("REWORK")]);
    ctx.d1.enqueueRows([roomRow()]);

    const res = await post(
      ctx,
      `/api/v1/reworks/${REWORK_ID}/waive`,
      { reason: "シャワー混合栓の故障", issueReportId: ISSUE_ID, roomOutcome: "READY" },
      cookie,
    );

    expect(res.status).toBe(200);
    expect((await res.json<{ unchanged: boolean }>()).unchanged).toBe(true);
    expect(writesTo(ctx, "rework_cycle")).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// POST /start（§4.6）
// ────────────────────────────────────────────────────────────

describe("POST /api/v1/reworks/:reworkCycleId/start", () => {
  it("解決済みの差戻しは開始できない（409）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([reworkRow("RESOLVED")]);
    ctx.d1.enqueueRows([taskRow("AWAITING_INSPECTION")]);
    ctx.d1.enqueueRows([roomRow()]);

    const res = await post(ctx, `/api/v1/reworks/${REWORK_ID}/start`, {}, cookie);

    expect(res.status).toBe(409);
    expect(writesTo(ctx, "rework_cycle")).toEqual([]);
  });

  it("開始の再送は 200 で、状態を書き換えない", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([reworkRow("IN_PROGRESS")]);
    ctx.d1.enqueueRows([taskRow("IN_PROGRESS")]);
    ctx.d1.enqueueRows([roomRow()]);

    const res = await post(ctx, `/api/v1/reworks/${REWORK_ID}/start`, {}, cookie);

    expect(res.status).toBe(200);
    expect((await res.json<{ unchanged: boolean }>()).unchanged).toBe(true);
    expect(writesTo(ctx, "rework_cycle")).toEqual([]);
  });

  it("CLEANER は他人の差戻しを開始できない（404）", async () => {
    const ctx = setup("CLEANER");
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([reworkRow("OPEN", { assignedToId: OTHER_CLEANER_ID })]);
    ctx.d1.enqueueRows([taskRow("REWORK")]);

    const res = await post(ctx, `/api/v1/reworks/${REWORK_ID}/start`, {}, cookie);

    expect(res.status).toBe(404);
    expect(writesTo(ctx, "rework_cycle")).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// POST /complete（§4.6）
// ────────────────────────────────────────────────────────────

describe("POST /api/v1/reworks/:reworkCycleId/complete", () => {
  it("開始していない差戻しは完了できない（409）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([reworkRow("OPEN")]);
    ctx.d1.enqueueRows([taskRow("REWORK")]);
    ctx.d1.enqueueRows([roomRow()]);

    const res = await post(ctx, `/api/v1/reworks/${REWORK_ID}/complete`, {}, cookie);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "INVALID_TRANSITION" });
    expect(writesTo(ctx, "cleaning_task")).toEqual([]);
  });

  it("2 回目のラウンドを完了すると、その行だけが RESOLVED になり証跡が 1 件増える", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    // ラウンド 2 の差戻し。**行が別なので前のラウンドを書き換えない**（§3.4）。
    ctx.d1.enqueueRows([reworkRow("IN_PROGRESS", { round: 2 })]); // findReworkCycleById
    ctx.d1.enqueueRows([taskRow("IN_PROGRESS", { round: 2, reworkCount: 2 })]); // findTaskById
    ctx.d1.enqueueRows([roomRow()]); // findRoomById
    // ── runTransition("complete") が読む順 ──
    ctx.d1.enqueueRows([taskRow("IN_PROGRESS", { round: 2, reworkCount: 2 })]); // findTaskById
    ctx.d1.enqueueRows([propertyRow()]); // findPropertyById
    ctx.d1.enqueueRows([]); // listChecklistResults（項目ゼロ＝完了できる）
    ctx.d1.enqueueRows([]); // countPhotosByChecklistItem
    ctx.d1.enqueueRows([policyRow()]); // findInspectionPolicy（ALL）
    ctx.d1.enqueueRows([]); // listTimeLogs（追記後の読み直し）
    // `rework_count` が 0 でないので `CLEANING_COMPLETION` は書かれない。
    // ── 差戻し側 → REWORK_COMPLETION の証跡 ──
    ctx.d1.enqueueRows([itemResultRow(RESULT_FAIL, ITEM_FAIL, "FAIL")]); // listInspectionItemResults
    ctx.d1.enqueueRows([]); // listTaskPhotos
    ctx.d1.enqueueRows([]); // findLatestEvidenceSnapshotByTask
    ctx.d1.enqueueRows([reworkRow("RESOLVED", { round: 2 })]); // 応答のための再取得

    const res = await post(ctx, `/api/v1/reworks/${REWORK_ID}/complete`, {}, cookie);

    expect(res.status).toBe(200);
    const update = ctx.d1.queries.find((query) => query.sql.startsWith('update "rework_cycle"'));
    expect(update?.params).toContain("RESOLVED");
    // **ラウンド 2 の行だけ。** 更新は 1 件で、id と現在の状態で絞っている。
    expect(writesTo(ctx, "rework_cycle")).toHaveLength(1);
    // 楽観的排他。**`status = IN_PROGRESS` の行にしか当たらない。**
    expect(update?.sql).toContain('"rework_cycle"."status" = ?');
    expect(update?.params).toContain("IN_PROGRESS");

    // 証跡は `REWORK_COMPLETION` が 1 件。**`CLEANING_COMPLETION` は増えない**
    // （§6.5 の ZIP は cleaning-completion.json を 1 件しか持たない）。
    const snapshots = ctx.d1.queries.filter((query) =>
      query.sql.startsWith('insert into "evidence_snapshot"'),
    );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.params).toContain("REWORK_COMPLETION");
  });

  it("完了は元のチェックリスト結果・検査結果を書き換えない（§4.6）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([reworkRow("IN_PROGRESS")]);
    ctx.d1.enqueueRows([taskRow("IN_PROGRESS")]);
    ctx.d1.enqueueRows([roomRow()]);
    ctx.d1.enqueueRows([taskRow("IN_PROGRESS")]);
    ctx.d1.enqueueRows([propertyRow()]);
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([policyRow()]);
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([itemResultRow(RESULT_FAIL, ITEM_FAIL, "FAIL")]);
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([reworkRow("RESOLVED")]);

    await post(ctx, `/api/v1/reworks/${REWORK_ID}/complete`, {}, cookie);

    expect(writesTo(ctx, "task_checklist_result")).toEqual([]);
    expect(writesTo(ctx, "inspection_item_result")).toEqual([]);
    expect(writesTo(ctx, "inspection")).toEqual([]);
  });
});
