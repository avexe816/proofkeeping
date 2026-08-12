/**
 * `POST /api/v1/tasks/:taskId/:action`（P1-05）。
 *
 * 仕様: docs/PK-SPEC-P1.md §5.3 / §8.2
 *
 * ── 見ているもの ────────────────────────────────────────
 * 状態機械そのものは `packages/engine` の taskStatus.spec.ts が表で押さえる。
 * ここは**ハンドラの配線**だけを見る。
 *   - 未定義の操作が 404（経路の存在を示唆しない）
 *   - 理由コード必須（§5.3）
 *   - `Idempotency-Key` の再送で状態が変わらない（§8.2 / CLAUDE.md §5）
 *   - 他組織の taskId が 404（§14.5）
 *
 * ── 代役の行は位置で組む ────────────────────────────────
 * `createFakeD1()` の `raw()` はそのまま drizzle へ渡る。**列の順序は
 * スキーマの宣言順。** 列を足す task はここも直すこと（session.spec.ts と同じ）。
 */

import type { Env } from "@pk/db";
import { createFakeD1, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "../../../lib/auth/cookie.js";
import { createSession } from "../../../lib/auth/session.js";
import { createFakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import tasks from "./tasks.js";

const SECRET = "test-session-secret-not-used-anywhere-else";
const NOW = new Date("2026-08-12T09:00:00.000Z");
const ORG_SHORT_ID = "a1b2c3";
const ORGANIZATION_ID = "org_test_alpha";
const MEMBERSHIP_ID = `${ORG_SHORT_ID}__mem_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const USER_ID = `${ORG_SHORT_ID}__usr_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const PROPERTY_ID = `${ORG_SHORT_ID}__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const ROOM_ID = `${ORG_SHORT_ID}__room_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const TASK_ID = `${ORG_SHORT_ID}__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const OTHER_ORG_TASK_ID = `zz9zz9__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

const DEPS: TenantDeps = {
  findMembershipByUserId: () =>
    Promise.resolve({ id: MEMBERSHIP_ID, role: "CLEANER", isActive: true }),
  listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
};

/** `cleaning_task` の 1 行。**列の順序は schema/task.ts の宣言順。** */
function taskRow(status: string): unknown[] {
  return [
    TASK_ID,
    ORGANIZATION_ID,
    PROPERTY_ID,
    ROOM_ID,
    "2026-08-12",
    "CHECKOUT",
    status,
    40, // priority
    MEMBERSHIP_ID,
    40, // standard_minutes
    null, // actual_minutes
    0, // pause_count
    0, // rework_count
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

/** `task_time_log` の 1 行。**列の順序は schema/task.ts の宣言順。** */
function timeLogRow(idempotencyKey: string): unknown[] {
  return [
    `${ORG_SHORT_ID}__tlog_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
    ORGANIZATION_ID,
    PROPERTY_ID,
    TASK_ID,
    "START",
    0, // occurred_at
    MEMBERSHIP_ID,
    null, // reason_code
    null, // client_ts
    idempotencyKey,
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

function setup(): {
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
  useTenantMiddleware(api, DEPS);
  api.route("/tasks", tasks);
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

async function post(
  ctx: ReturnType<typeof setup>,
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

describe("POST /api/v1/tasks/:taskId/:action", () => {
  it("セッションが無ければ 401", async () => {
    const ctx = setup();

    const res = await post(ctx, `/api/v1/tasks/${TASK_ID}/start`, {}, null);

    expect(res.status).toBe(401);
  });

  it("未定義の操作は 404（経路の存在を示唆しない）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await post(ctx, `/api/v1/tasks/${TASK_ID}/destroy`, {}, cookie);

    expect(res.status).toBe(404);
  });

  it("他組織の taskId は 404 で、DB に触れない", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await post(ctx, `/api/v1/tasks/${OTHER_ORG_TASK_ID}/start`, {}, cookie);

    expect(res.status).toBe(404);
    // 第 2 層（`assertIdBelongsToTenant`）が DB の手前で落としている。
    expect(ctx.d1.queries.filter((query) => query.sql.includes("cleaning_task"))).toEqual([]);
  });

  it("中断に理由コードが無ければ REASON_REQUIRED（§5.3）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow("IN_PROGRESS")]);

    const res = await post(ctx, `/api/v1/tasks/${TASK_ID}/pause`, {}, cookie);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "REASON_REQUIRED" });
  });

  it("その状態から実行できない操作は INVALID_TRANSITION", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    // 未割当のタスクを start しようとした（§5.3 は ASSIGNED / PAUSED / REWORK）。
    ctx.d1.enqueueRows([taskRow("CREATED")]);
    ctx.d1.enqueueRows([]); // 時間ログ（idempotency 照合）
    ctx.d1.enqueueRows([]); // 施設（検査の要否）

    const res = await post(ctx, `/api/v1/tasks/${TASK_ID}/start`, {}, cookie, "key-1");

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "INVALID_TRANSITION" });
  });

  it("同じ Idempotency-Key の再送は状態を変えず unchanged で返す（§8.2）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow("IN_PROGRESS")]); // findTaskById
    ctx.d1.enqueueRows([timeLogRow("key-1")]); // 既に処理済みの鍵
    ctx.d1.enqueueRows([taskRow("IN_PROGRESS")]); // 応答のための再取得
    ctx.d1.enqueueRows([roomRow()]); // 部屋番号

    const res = await post(ctx, `/api/v1/tasks/${TASK_ID}/start`, {}, cookie, "key-1");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      unchanged: true,
      data: { status: "IN_PROGRESS", taskId: TASK_ID, roomNumber: "302" },
    });
    // **状態を変える UPDATE も、時間ログの INSERT も出ていない。**
    expect(ctx.d1.queries.filter((query) => query.sql.startsWith("insert into"))).toEqual([]);
    expect(ctx.d1.queries.filter((query) => query.sql.startsWith("update"))).toEqual([]);
  });

  it("ボディが JSON でなければ 400", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await ctx.app.request(
      `/api/v1/tasks/${TASK_ID}/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: "{",
      },
      ctx.env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_REQUEST" });
  });
});

describe("POST /api/v1/tasks/:taskId/checklist（P1-10 の前提）", () => {
  /**
   * **`/:taskId/:action` に吸われていないこと。**
   *
   * Hono は登録順に照合し、静的な区間を優先しない。`/:taskId/:action` を
   * 先に登録すると `action = "checklist"` として扱われ、
   * `taskActionSchema` が弾いて 404 になる（記録が 1 件も残らない）。
   * ここは「チェックリストのハンドラまで届いたか」を、
   * `task_checklist_result` への UPDATE が出たことで見る。
   */
  it("チェックリストのハンドラへ届く（:action に吸われない）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow("IN_PROGRESS")]); // findTaskById

    await post(
      ctx,
      `/api/v1/tasks/${TASK_ID}/checklist`,
      { itemId: `${ORG_SHORT_ID}__citm_01JBXQ3ZK8N4P2VYR6ABCDEFGH`, value: "DONE" },
      cookie,
    );

    expect(
      ctx.d1.queries.some((query) => query.sql.includes("task_checklist_result")),
    ).toBe(true);
  });

  it("値が 3 値のいずれかでなければ 400（INV-22）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await post(
      ctx,
      `/api/v1/tasks/${TASK_ID}/checklist`,
      { itemId: `${ORG_SHORT_ID}__citm_01JBXQ3ZK8N4P2VYR6ABCDEFGH`, value: "YES" },
      cookie,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_REQUEST" });
  });
});

describe("POST /api/v1/tasks/:taskId/photos（P1-11）", () => {
  const CLIENT_ID = "0b3a1f2c-7c9e-4e6a-9a2c-1d5f6b7c8d90";

  /** multipart で送る。**`file` は Blob。** */
  async function postPhoto(
    ctx: ReturnType<typeof setup>,
    path: string,
    form: FormData,
    cookie: string | null,
  ): Promise<Response> {
    return ctx.app.request(
      path,
      {
        method: "POST",
        headers: cookie === null ? {} : { Cookie: cookie },
        body: form,
      },
      ctx.env,
    );
  }

  function formWith(bytes: number[]): FormData {
    const form = new FormData();
    form.append("clientId", CLIENT_ID);
    form.append("kind", "AFTER");
    form.append("file", new Blob([new Uint8Array(bytes)]), "photo.jpg");
    return form;
  }

  it("セッションが無ければ 401", async () => {
    const ctx = setup();

    const res = await postPhoto(ctx, `/api/v1/tasks/${TASK_ID}/photos`, formWith([0xff, 0xd8]), null);

    expect(res.status).toBe(401);
  });

  it("他組織の taskId は 404 で、DB に触れない（§14.5 / INV-31）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await postPhoto(
      ctx,
      `/api/v1/tasks/${OTHER_ORG_TASK_ID}/photos`,
      formWith([0xff, 0xd8]),
      cookie,
    );

    expect(res.status).toBe(404);
    expect(ctx.d1.queries.filter((query) => query.sql.includes("task_photo"))).toEqual([]);
  });

  it("clientId が uuid でなければ 400（冪等鍵にならない）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    const form = new FormData();
    form.append("clientId", "not-a-uuid");
    form.append("file", new Blob([new Uint8Array([0xff, 0xd8])]), "photo.jpg");

    const res = await postPhoto(ctx, `/api/v1/tasks/${TASK_ID}/photos`, form, cookie);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_REQUEST" });
  });

  it("file が無ければ 400", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    const form = new FormData();
    form.append("clientId", CLIENT_ID);

    const res = await postPhoto(ctx, `/api/v1/tasks/${TASK_ID}/photos`, form, cookie);

    expect(res.status).toBe(400);
  });

  it("画像として読めないバイト列は 415（EXIF を落とせないものを保存しない）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow("IN_PROGRESS")]); // findTaskById
    ctx.d1.enqueueRows([]); // findTaskPhotoByClientId
    ctx.d1.enqueueRows([[0]]); // countTaskPhotos

    const res = await postPhoto(
      ctx,
      `/api/v1/tasks/${TASK_ID}/photos`,
      formWith([0x00, 0x01, 0x02, 0x03]),
      cookie,
    );

    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "UNSUPPORTED_IMAGE" });
  });

  it("500KB を超える写真は 413（§7.3）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow("IN_PROGRESS")]); // findTaskById
    ctx.d1.enqueueRows([]); // findTaskPhotoByClientId

    const oversize = new Array<number>(500 * 1024 + 1).fill(0xff);

    const res = await postPhoto(ctx, `/api/v1/tasks/${TASK_ID}/photos`, formWith(oversize), cookie);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "PHOTO_TOO_LARGE" });
  });

  it("1 タスク 20 枚を超えたら 409（§7.3）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([taskRow("IN_PROGRESS")]); // findTaskById
    ctx.d1.enqueueRows([]); // findTaskPhotoByClientId
    ctx.d1.enqueueRows([[20]]); // countTaskPhotos

    const res = await postPhoto(ctx, `/api/v1/tasks/${TASK_ID}/photos`, formWith([0xff, 0xd8]), cookie);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "PHOTO_LIMIT_EXCEEDED" });
  });
});
