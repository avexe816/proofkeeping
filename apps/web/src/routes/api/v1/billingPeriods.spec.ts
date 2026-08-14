/**
 * `/api/v1/billing-periods`（P5-05 / PK-SPEC-P5 §2.8・§6.1・§9）。
 *
 * ── 見ているもの ────────────────────────────────────────
 *   `billing.read` / `billing.write` を持たないロールが **404**（403 ではない）
 *   知らない `status` が **400**（黙って全件を返さない）
 *   `OPEN` 以外からの集計が **409**（締め直して金額が動かない / §2.8）
 *   越境した `billingPeriodId` が **404** になり、DB へ届かないこと
 *   状態変更が `AuditLog` に残ること（CLAUDE.md §5）
 *   差戻しが**コメント無しでは通らない**こと（§6.2 MUST）
 *   差戻しコメントが `lineKey` で行に付き、**知らない行なら 400** になること
 *   合意・差戻し・確認依頼が**履歴に追記される**こと（同上）
 *   `request-review` が**状態を変えない**こと（OPEN_QUESTIONS #072）
 *   **物理削除の口が無いこと**（CLAUDE.md §4）。履歴にも更新の口が無いこと
 *   明細行から**集計元のタスク**へ辿れること（§6.3 / P5-13）
 *
 * ── 明細の組み立ては差し替えてある ──────────────────────
 * `lib/billing/draft.ts` は施設・客室・タスク・料金設定を 5 表ぶん引く。
 * 代役 D1 でその行を全部並べても、見えるのは**代役の並び順**であって
 * 明細の意味ではない。ここで見たいのは「差戻しコメントが行に付くか」
 * なので、**明細そのものは既知の値に固定する。** 金額の計算は
 * `packages/billing` の純粋関数テストが持つ（testing.md §3）。
 *
 * ── 代役の行は位置で組む ────────────────────────────────
 * `createFakeD1()` の `raw()` はそのまま drizzle へ渡る。**列の順序は
 * schema/invoice.ts の `billing_period` の宣言順。**
 */

import type { Env } from "@pk/db";
import { createFakeD1, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../../lib/auth/cookie.js";
import { createSession } from "../../../lib/auth/session.js";
import { createFakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import billingPeriods from "./billingPeriods.js";

/**
 * 既知の明細（`buildPeriodDraft()` の差し替え）。
 *
 * 2 行。`lineKey` は `施設|清掃種別|客室タイプ` で、`@pk/billing` の
 * `billingLineKeyOf()` が作るものと同じ形。**`vi.hoisted()` で組むのは、
 * `vi.mock()` の工場が spec の const より先に走るため。**
 */
const { DRAFT, LINE_KEY_TWIN, LINE_KEY_SINGLE } = vi.hoisted(() => {
  const propertyId = "a1b2c3__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH";
  const twin = `${propertyId}|CHECKOUT|a1b2c3__rmtp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
  const single = `${propertyId}|STAYOVER|`;
  return {
    LINE_KEY_TWIN: twin,
    LINE_KEY_SINGLE: single,
    DRAFT: {
      lines: [
        {
          lineNo: 1,
          lineKey: twin,
          propertyId,
          itemCode: "CLEAN_CHECKOUT",
          description: "サンプルホテル東京 / アウト清掃 / ツイン",
          serviceDateFrom: "2026-09-01",
          serviceDateTo: "2026-09-30",
          quantity: 95,
          unit: "室",
          unitPrice: 3800,
          amount: 361000,
          taxRate: 10,
          isReducedRate: false,
          sourceRef: {
            // **実在する形の ID。** `listTasksByIds()` は越境 ID を
            // DB へ行く前に落とすので、雑な文字列だと 404 になる。
            taskIds: [
              "a1b2c3__task_01JBXQ3ZK8N4P2VYR6ABCDEFT1",
              "a1b2c3__task_01JBXQ3ZK8N4P2VYR6ABCDEFT2",
            ],
            pricingRuleId: null,
            pricingStage: null,
          },
        },
        {
          lineNo: 2,
          lineKey: single,
          propertyId,
          itemCode: "CLEAN_STAYOVER",
          description: "サンプルホテル東京 / 滞在清掃",
          serviceDateFrom: "2026-09-02",
          serviceDateTo: "2026-09-28",
          quantity: 42,
          unit: "室",
          unitPrice: 1800,
          amount: 75600,
          taxRate: 10,
          isReducedRate: false,
          sourceRef: {
            taskIds: ["a1b2c3__task_01JBXQ3ZK8N4P2VYR6ABCDEFT3"],
            pricingRuleId: null,
            pricingStage: null,
          },
        },
      ],
      taxSummaries: [
        {
          taxRate: 10,
          isReducedRate: false,
          subtotalAmount: 436600,
          taxAmount: 43660,
          totalAmount: 480260,
        },
      ],
      subtotalAmount: 436600,
      taxAmount: 43660,
      totalAmount: 480260,
      // §3.2 MUST。**単価が引けなかった行を黙って落とさない。**
      warnings: [
        {
          code: "PRICE_NOT_FOUND",
          propertyId,
          taskType: "DEEP",
          roomTypeId: null,
          taskCount: 3,
        },
      ],
    },
  };
});

vi.mock("../../../lib/billing/draft.js", () => ({
  buildPeriodDraft: () => Promise.resolve(DRAFT),
}));

const SECRET = "test-session-secret-not-used-anywhere-else";
const NOW = new Date("2026-10-01T00:00:00.000Z");

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
const PERIOD_ID = `${ORG_SHORT_ID}__bper_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const OTHER_PERIOD_ID = `${OTHER_ORG_SHORT_ID}__bper_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const COUNTERPARTY_ID = `${ORG_SHORT_ID}__cp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

type TestRole = "ORG_ADMIN" | "PROPERTY_MANAGER" | "INSPECTOR" | "AUDITOR";

function deps(role: TestRole): TenantDeps {
  return {
    findMembershipByUserId: () => Promise.resolve({ id: MEMBERSHIP_ID, role, isActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

/** `billing_period` の 1 行。**列の順序は schema/invoice.ts の宣言順。** */
function periodRow(status = "OPEN"): unknown[] {
  return [
    PERIOD_ID,
    ORGANIZATION_ID,
    COUNTERPARTY_ID,
    "2026-09-01",
    "2026-09-30",
    status,
    null, // aggregated_at
    null, // agreed_at
    0, // agreed_by_counterparty
    null, // invoice_id
    0, // created_at
    0, // updated_at
  ];
}

/** `counterparty` の 1 行（`POST /` が締め日を読む）。 */
function counterpartyRow(closingDay = 31): unknown[] {
  return [
    COUNTERPARTY_ID,
    ORGANIZATION_ID,
    "CP-001",
    "サンプルホテル運営株式会社",
    null,
    "T1234567890123",
    "1000001",
    "東京都千代田区1-1-1",
    null,
    "経理部",
    "山田",
    "keiri@example.co.jp",
    "[]",
    closingDay,
    30,
    "FLOOR",
    1,
    0,
    0,
  ];
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
  api.route("/billing-periods", billingPeriods);
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

async function get(
  ctx: ReturnType<typeof setup>,
  path: string,
  cookie: string,
): Promise<Response> {
  return ctx.app.request(path, { headers: { cookie } }, ctx.env);
}

async function post(
  ctx: ReturnType<typeof setup>,
  path: string,
  cookie: string,
): Promise<Response> {
  return ctx.app.request(path, { method: "POST", headers: { cookie } }, ctx.env);
}

async function postJson(
  ctx: ReturnType<typeof setup>,
  path: string,
  cookie: string,
  body: unknown,
): Promise<Response> {
  return ctx.app.request(
    path,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    ctx.env,
  );
}

/** `cleaning_task` の 1 行。**列の順序は schema/task.ts の宣言順。** */
function taskRow(suffix: string): unknown[] {
  return [
    `${ORG_SHORT_ID}__task_01JBXQ3ZK8N4P2VYR6ABCDEF${suffix}`,
    ORGANIZATION_ID,
    PROPERTY_ID,
    `${ORG_SHORT_ID}__room_01JBXQ3ZK8N4P2VYR6ABCDEF${suffix}`,
    "2026-09-15",
    "CHECKOUT",
    "COMPLETED",
    50,
    null, // assignee_id
    30, // standard_minutes
    28, // actual_minutes
    0, // pause_count
    0, // rework_count
    1, // inspection_required
    0, // inspection_skipped
    null, // inspection_skip_reason
    null, // inspector_id
    null, // inspected_at
    "PASS", // inspection_result
    1, // current_inspection_round
    "AUTO",
    null, // note
    null, // blocked_reason
    `SHORT${suffix}`,
    null, // sequence_in_day
    null, // assigned_at
    0, // started_at
    0, // completed_at
    null, // cancelled_at
    0,
    0,
  ];
}

/** `room` の 1 行。**列の順序は schema/property.ts の宣言順。** */
function roomRow(suffix: string): unknown[] {
  return [
    `${ORG_SHORT_ID}__room_01JBXQ3ZK8N4P2VYR6ABCDEF${suffix}`,
    ORGANIZATION_ID,
    PROPERTY_ID,
    null, // building_id
    null, // floor_id
    null, // room_type_id
    `10${suffix}`, // room_number
  ];
}

/** `billing_period_review` の 1 行。**列の順序は schema/invoice.ts の宣言順。** */
function reviewRow(
  seq: number,
  action: string,
  comment: string | null,
  lineComments: unknown[] = [],
): unknown[] {
  return [
    `${ORG_SHORT_ID}__bprv_01JBXQ3ZK8N4P2VYR6ABCDEF0${String(seq)}`,
    ORGANIZATION_ID,
    PERIOD_ID,
    seq,
    action,
    comment,
    JSON.stringify(lineComments),
    "[]",
    0,
    "REVIEWING",
    "REVIEWING",
    1,
    MEMBERSHIP_ID,
    0,
    0,
  ];
}

describe("GET /api/v1/billing-periods", () => {
  it("一覧を返す。**組織 ID を含めない**", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("REVIEWING")]);

    const response = await get(ctx, "/api/v1/billing-periods", await ctx.cookie());
    expect(response.status).toBe(200);

    const body = await response.json<{ data: Record<string, unknown>[] }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      billingPeriodId: PERIOD_ID,
      counterpartyId: COUNTERPARTY_ID,
      periodFrom: "2026-09-01",
      periodTo: "2026-09-30",
      status: "REVIEWING",
      agreedByCounterparty: false,
      invoiceId: null,
    });
    expect(JSON.stringify(body)).not.toContain(ORGANIZATION_ID);
  });

  it("**金額を返さない**（§2.8 に列が無い / DECISIONS #124）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow()]);

    const response = await get(ctx, "/api/v1/billing-periods", await ctx.cookie());
    const body = await response.json<{ data: Record<string, unknown>[] }>();
    expect(body.data[0]).not.toHaveProperty("totalAmount");
    expect(body.data[0]).not.toHaveProperty("subtotalAmount");
  });

  it("知らない status は 400（黙って全件を返さない）", async () => {
    const ctx = setup();
    const response = await get(ctx, "/api/v1/billing-periods?status=REVIEWINGG", await ctx.cookie());
    expect(response.status).toBe(400);
  });

  it("`INSPECTOR` は 404（請求情報を見られない / security.md §1）", async () => {
    const ctx = setup("INSPECTOR");
    const response = await get(ctx, "/api/v1/billing-periods", await ctx.cookie());
    expect(response.status).toBe(404);
  });

  it("`AUDITOR` は読める（組織全体・読取専用）", async () => {
    const ctx = setup("AUDITOR");
    ctx.d1.enqueueRows([periodRow()]);
    const response = await get(ctx, "/api/v1/billing-periods", await ctx.cookie());
    expect(response.status).toBe(200);
  });
});

describe("POST /api/v1/billing-periods/:id/aggregate", () => {
  it("`OPEN` を `REVIEWING` へ進め、監査ログに残す", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("OPEN")]); // findBillingPeriodById
    ctx.d1.enqueueRows([]); // updateBillingPeriodStatus
    ctx.d1.enqueueRows([]); // recordAudit

    const response = await post(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/aggregate`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ billingPeriodId: PERIOD_ID, status: "REVIEWING" });

    const statements = ctx.d1.queries.map((query) => query.sql);
    expect(statements.some((sql) => sql.includes("update") && sql.includes("billing_period"))).toBe(
      true,
    );
    expect(statements.some((sql) => sql.includes("audit_log"))).toBe(true);
  });

  it("`REVIEWING` からの集計は 409（締め直して金額が動かない）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("REVIEWING")]);

    const response = await post(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/aggregate`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(409);
    // **更新へ進んでいない。** `select` にも `updated_at` 列が現れるので、
    // 文の種類（先頭の動詞）で見る。
    expect(
      ctx.d1.queries.some((query) => query.sql.trimStart().toLowerCase().startsWith("update")),
    ).toBe(false);
  });

  it("`INVOICED` からの集計も 409", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("INVOICED")]);
    const response = await post(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/aggregate`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(409);
  });

  it("越境した ID は 404 で、DB へ届かない", async () => {
    const ctx = setup();
    const response = await post(
      ctx,
      `/api/v1/billing-periods/${OTHER_PERIOD_ID}/aggregate`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
    expect(ctx.d1.queries).toHaveLength(0);
  });

  it("`PROPERTY_MANAGER` は 404（`billing.write` を持たない）", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const response = await post(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/aggregate`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
  });

  it("`AUDITOR` は書き込めない", async () => {
    const ctx = setup("AUDITOR");
    const response = await post(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/aggregate`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
  });
});

describe("POST /api/v1/billing-periods", () => {
  it("締め日から期間を導いて起票する（月末締め・10/1 → 9 月分）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow(31)]); // findCounterpartyById
    ctx.d1.enqueueRows([]); // ensureBillingPeriod の検索
    ctx.d1.enqueueRows([]); // insert

    const response = await post(
      ctx,
      `/api/v1/billing-periods?counterpartyId=${COUNTERPARTY_ID}`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      periodFrom: "2026-09-01",
      periodTo: "2026-09-30",
    });
  });

  it("20 日締めなら 8/21〜9/20", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow(20)]);
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([]);

    const response = await post(
      ctx,
      `/api/v1/billing-periods?counterpartyId=${COUNTERPARTY_ID}`,
      await ctx.cookie(),
    );
    expect(await response.json()).toMatchObject({
      periodFrom: "2026-08-21",
      periodTo: "2026-09-20",
    });
  });

  it("既にあれば 200 で既存を返す（2 回押しても 2 行作らない）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow(31)]);
    ctx.d1.enqueueRows([[PERIOD_ID]]);

    const response = await post(
      ctx,
      `/api/v1/billing-periods?counterpartyId=${COUNTERPARTY_ID}`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ billingPeriodId: PERIOD_ID });
    expect(
      ctx.d1.queries.some((query) => query.sql.trimStart().toLowerCase().startsWith("insert")),
    ).toBe(false);
  });

  it("`counterpartyId` が無ければ 400", async () => {
    const ctx = setup();
    const response = await post(ctx, "/api/v1/billing-periods", await ctx.cookie());
    expect(response.status).toBe(400);
  });

  it("**期間をリクエストで受け取らない**（締め日と合わない請求を作らせない）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow(31)]);
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([]);

    const response = await post(
      ctx,
      `/api/v1/billing-periods?counterpartyId=${COUNTERPARTY_ID}&periodFrom=2020-01-01&periodTo=2020-01-31`,
      await ctx.cookie(),
    );
    expect(await response.json()).toMatchObject({
      periodFrom: "2026-09-01",
      periodTo: "2026-09-30",
    });
  });
});

describe("GET /api/v1/billing-periods/:id/lines", () => {
  it("明細を `lineKey` つきで返す。**組織 ID を含めない**", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("REVIEWING")]);
    ctx.d1.enqueueRows([counterpartyRow()]);

    const response = await get(ctx, `/api/v1/billing-periods/${PERIOD_ID}/lines`, await ctx.cookie());
    expect(response.status).toBe(200);

    const body = await response.json<{
      data: Record<string, unknown>[];
      totalAmount: number;
      warnings: unknown[];
    }>();
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({
      lineNo: 1,
      lineKey: LINE_KEY_TWIN,
      quantity: 95,
      unitPrice: 3800,
      amount: 361000,
      // 集計元は**件数だけ**（タスク ID の一覧は P5-13 のドリルダウン）。
      taskCount: 2,
    });
    expect(body.totalAmount).toBe(480260);
    // §3.2 MUST。単価が引けなかった作業を黙って落とさない。
    expect(body.warnings).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain(ORGANIZATION_ID);
  });

  it("タスク ID の一覧を返さない（P5-13 の範囲）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("REVIEWING")]);
    ctx.d1.enqueueRows([counterpartyRow()]);

    const response = await get(ctx, `/api/v1/billing-periods/${PERIOD_ID}/lines`, await ctx.cookie());
    const text = await response.text();
    expect(text).not.toContain("sourceRef");
    expect(text).not.toContain("taskIds");
  });

  it("`INSPECTOR` は 404（請求情報を見られない / security.md §1）", async () => {
    const ctx = setup("INSPECTOR");
    const response = await get(ctx, `/api/v1/billing-periods/${PERIOD_ID}/lines`, await ctx.cookie());
    expect(response.status).toBe(404);
    expect(ctx.d1.queries).toHaveLength(0);
  });

  it("越境した ID は DB へ届かない（404）", async () => {
    const ctx = setup();
    const response = await get(
      ctx,
      `/api/v1/billing-periods/${OTHER_PERIOD_ID}/lines`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
    expect(ctx.d1.queries).toHaveLength(0);
  });
});

describe("POST /api/v1/billing-periods/:id/reject", () => {
  it("**コメントが無ければ 400**（§6.2 MUST）", async () => {
    const ctx = setup();
    const response = await postJson(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/reject`,
      await ctx.cookie(),
      {},
    );
    expect(response.status).toBe(400);
    // 状態を触っていない。**理由の無い差戻しを記録に残さない。**
    expect(ctx.d1.queries).toHaveLength(0);
  });

  it("空白だけのコメントも 400", async () => {
    const ctx = setup();
    const response = await postJson(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/reject`,
      await ctx.cookie(),
      { comment: "   " },
    );
    expect(response.status).toBe(400);
  });

  it("明細行にコメントを付けて差し戻し、履歴に残す", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("AGREED")]); // findBillingPeriodById
    ctx.d1.enqueueRows([counterpartyRow()]); // findCounterpartyById
    ctx.d1.enqueueRows([]); // updateBillingPeriodStatus
    ctx.d1.enqueueRows([]); // appendBillingPeriodReview: 直前の seq
    ctx.d1.enqueueRows([]); // appendBillingPeriodReview: insert
    ctx.d1.enqueueRows([]); // recordAudit

    const response = await postJson(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/reject`,
      await ctx.cookie(),
      {
        comment: "9月分をご確認ください。",
        lineComments: [
          {
            lineKey: LINE_KEY_TWIN,
            comment: "9/15 の 3 室は当方都合でキャンセルしています。ご確認ください。",
          },
        ],
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      billingPeriodId: PERIOD_ID,
      status: "REVIEWING",
      seq: 1,
    });

    const inserted = ctx.d1.queries.find((query) =>
      query.sql.toLowerCase().includes("insert into \"billing_period_review\""),
    );
    expect(inserted).toBeDefined();
    const params = JSON.stringify(inserted?.params);
    expect(params).toContain("9/15 の 3 室");
    // 行を指すのは `lineKey`。**そのときの `lineNo` と取引内容も一緒に残す。**
    expect(params).toContain(LINE_KEY_TWIN);
    expect(params).toContain("アウト清掃 / ツイン");
    // 修正履歴（そのとき見えていた明細）。
    expect(params).toContain("480260");
  });

  it("客室タイプを持たない行（共用部・滞在清掃）にもコメントが付く", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("REVIEWING")]);
    ctx.d1.enqueueRows([counterpartyRow()]);

    const response = await postJson(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/reject`,
      await ctx.cookie(),
      {
        comment: "滞在清掃の件数をご確認ください。",
        lineComments: [{ lineKey: LINE_KEY_SINGLE, comment: "9/20 の 2 室は対象外です。" }],
      },
    );
    expect(response.status).toBe(200);

    const inserted = ctx.d1.queries.find((query) =>
      query.sql.toLowerCase().includes('insert into "billing_period_review"'),
    );
    expect(JSON.stringify(inserted?.params)).toContain("滞在清掃");
  });

  it("`AGREED` から差し戻すと合意が取り消される（§6.1）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("AGREED")]);
    ctx.d1.enqueueRows([counterpartyRow()]);

    await postJson(ctx, `/api/v1/billing-periods/${PERIOD_ID}/reject`, await ctx.cookie(), {
      comment: "行2 をご確認ください。",
    });

    const update = ctx.d1.queries.find(
      (query) =>
        query.sql.toLowerCase().startsWith("update") && query.sql.includes("billing_period"),
    );
    expect(update?.sql).toContain("agreed_at");
    expect(update?.sql).toContain("agreed_by_counterparty");
    // `agreedAt` は null、`agreedByCounterparty` は 0 に戻る。
    expect(update?.params).toContain(null);
    expect(update?.params).toContain(0);
  });

  it("明細に無い `lineKey` は 400（消えた行への指摘を受け取らない）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("REVIEWING")]);
    ctx.d1.enqueueRows([counterpartyRow()]);

    const response = await postJson(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/reject`,
      await ctx.cookie(),
      {
        comment: "ご確認ください。",
        lineComments: [{ lineKey: "a1b2c3__prop_XXXX|CHECKOUT|", comment: "この行です" }],
      },
    );
    expect(response.status).toBe(400);
    // 読んだだけ。**状態も履歴も動かさない。**
    expect(
      ctx.d1.queries.some((query) => query.sql.toLowerCase().startsWith("update")),
    ).toBe(false);
    expect(
      ctx.d1.queries.some((query) => query.sql.toLowerCase().startsWith("insert")),
    ).toBe(false);
  });

  it("`OPEN` からは差し戻せない（409）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("OPEN")]);
    ctx.d1.enqueueRows([counterpartyRow()]);

    const response = await postJson(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/reject`,
      await ctx.cookie(),
      { comment: "まだ集計されていません。" },
    );
    expect(response.status).toBe(409);
  });

  it("`AUDITOR` は書けない（読取専用 / security.md §1）", async () => {
    const ctx = setup("AUDITOR");
    const response = await postJson(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/reject`,
      await ctx.cookie(),
      { comment: "ご確認ください。" },
    );
    expect(response.status).toBe(404);
    expect(ctx.d1.queries).toHaveLength(0);
  });
});

describe("POST /api/v1/billing-periods/:id/agree", () => {
  it("`REVIEWING` を `AGREED` へ進め、そのときの明細を履歴に固定する", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("REVIEWING")]);
    ctx.d1.enqueueRows([counterpartyRow()]);
    ctx.d1.enqueueRows([]); // update
    ctx.d1.enqueueRows([]); // 直前の seq
    ctx.d1.enqueueRows([]); // insert
    ctx.d1.enqueueRows([]); // recordAudit

    const response = await postJson(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/agree`,
      await ctx.cookie(),
      { byCounterparty: true },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ billingPeriodId: PERIOD_ID, status: "AGREED" });

    const statements = ctx.d1.queries.map((query) => query.sql);
    expect(statements.some((sql) => sql.includes("billing_period_review"))).toBe(true);
    expect(statements.some((sql) => sql.includes("audit_log"))).toBe(true);

    const inserted = ctx.d1.queries.find((query) =>
      query.sql.toLowerCase().includes("insert into \"billing_period_review\""),
    );
    // 合意した数字が残る（あとで元データが動いても追える）。
    expect(JSON.stringify(inserted?.params)).toContain("480260");
  });

  it("本文が無くても合意できる（既定は取引先の意思）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("REVIEWING")]);
    ctx.d1.enqueueRows([counterpartyRow()]);

    const response = await post(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/agree`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(200);
  });

  it("`OPEN` からは合意できない（409）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("OPEN")]);
    ctx.d1.enqueueRows([counterpartyRow()]);

    const response = await post(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/agree`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(409);
  });

  it("同時に 2 本来たら 1 本だけ通る（楽観ロック）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("REVIEWING")]);
    ctx.d1.enqueueRows([counterpartyRow()]);
    ctx.d1.enqueueChanges(0); // update が 0 行 = 別のリクエストが先に進めた

    const response = await post(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/agree`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(409);
    // **履歴を書いていない。** 状態が動いていないのに合意が残ると履歴が嘘になる。
    expect(
      ctx.d1.queries.some((query) => query.sql.includes("billing_period_review")),
    ).toBe(false);
  });
});

describe("POST /api/v1/billing-periods/:id/request-review", () => {
  it("**状態を変えない。** 依頼した事実だけを履歴に残す（OPEN_QUESTIONS #072）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("REVIEWING")]);
    ctx.d1.enqueueRows([counterpartyRow()]);
    ctx.d1.enqueueRows([]); // 直前の seq
    ctx.d1.enqueueRows([]); // insert

    const response = await postJson(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/request-review`,
      await ctx.cookie(),
      { comment: "9月分の明細をご確認ください。" },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ status: "REVIEWING", seq: 1 });

    // `billing_period` を更新していない。
    expect(
      ctx.d1.queries.some(
        (query) =>
          query.sql.toLowerCase().startsWith("update") && query.sql.includes("billing_period\""),
      ),
    ).toBe(false);
    expect(
      ctx.d1.queries.some((query) => query.sql.includes("billing_period_review")),
    ).toBe(true);
  });

  it("`OPEN` では依頼できない（409）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("OPEN")]);
    ctx.d1.enqueueRows([counterpartyRow()]);

    const response = await post(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/request-review`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(409);
  });
});

describe("GET /api/v1/billing-periods/:id/reviews", () => {
  it("履歴を古い順に返す", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("REVIEWING")]);
    ctx.d1.enqueueRows([
      reviewRow(1, "REQUEST_REVIEW", "ご確認ください。"),
      reviewRow(2, "REJECT", "行2 をご確認ください。", [
        {
          lineKey: LINE_KEY_TWIN,
          lineNo: 2,
          description: "サンプルホテル東京 / アウト清掃 / ツイン",
          comment: "9/15 の 3 室は当方都合でキャンセルしています。",
        },
      ]),
    ]);

    const response = await get(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/reviews`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(200);

    const body = await response.json<{ data: Record<string, unknown>[] }>();
    expect(body.data.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(body.data[1]).toMatchObject({ action: "REJECT", byCounterparty: true });
    expect(JSON.stringify(body)).toContain("9/15 の 3 室");
    expect(JSON.stringify(body)).not.toContain(ORGANIZATION_ID);
  });

  it("`INSPECTOR` は 404", async () => {
    const ctx = setup("INSPECTOR");
    const response = await get(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/reviews`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
  });
});

describe("GET /api/v1/billing-periods/:id/lines/tasks", () => {
  it("明細行の集計元タスクを返す（§6.3 の入口）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("REVIEWING")]);
    ctx.d1.enqueueRows([counterpartyRow()]);
    ctx.d1.enqueueRows([taskRow("T1"), taskRow("T2")]); // listTasksByIds
    ctx.d1.enqueueRows([roomRow("T1"), roomRow("T2")]); // listRooms

    const response = await get(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/lines/tasks?lineKey=${encodeURIComponent(LINE_KEY_TWIN)}`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(200);

    const body = await response.json<{
      lineNo: number;
      lineKey: string;
      description: string;
      taskCount: number;
      data: Record<string, unknown>[];
    }>();
    expect(body.lineKey).toBe(LINE_KEY_TWIN);
    expect(body.description).toContain("ツイン");
    // 集計時に確定した件数（差し替えた明細の `sourceRef` は 2 件）。
    expect(body.taskCount).toBe(2);
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({ roomNumber: "10T1", status: "COMPLETED" });
    expect(JSON.stringify(body)).not.toContain(ORGANIZATION_ID);
  });

  it("W-07 へ繋ぐ `taskId` を返す。**証跡そのものは返さない**", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("REVIEWING")]);
    ctx.d1.enqueueRows([counterpartyRow()]);
    ctx.d1.enqueueRows([taskRow("T1")]);
    ctx.d1.enqueueRows([roomRow("T1")]);

    const response = await get(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/lines/tasks?lineKey=${encodeURIComponent(LINE_KEY_TWIN)}`,
      await ctx.cookie(),
    );
    const body = await response.json<{ data: { taskId: string }[] }>();
    expect(body.data[0]?.taskId).toContain("__task_");

    const statements = ctx.d1.queries.map((query) => query.sql);
    // 写真の署名付き URL を一覧で先に発行しない（security.md §4）。
    expect(statements.some((sql) => sql.includes("evidence_snapshot"))).toBe(false);
    expect(statements.some((sql) => sql.includes("task_photo"))).toBe(false);
  });

  it("`lineKey` が無ければ 400", async () => {
    const ctx = setup();
    const response = await get(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/lines/tasks`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(400);
    expect(ctx.d1.queries).toHaveLength(0);
  });

  it("明細に無い `lineKey` は 404（差戻しの間に行が消えることがある）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("REVIEWING")]);
    ctx.d1.enqueueRows([counterpartyRow()]);

    const response = await get(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/lines/tasks?lineKey=${encodeURIComponent("nope|CHECKOUT|")}`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
  });

  it("越境した ID は DB へ届かない（404）", async () => {
    const ctx = setup();
    const response = await get(
      ctx,
      `/api/v1/billing-periods/${OTHER_PERIOD_ID}/lines/tasks?lineKey=${encodeURIComponent(LINE_KEY_TWIN)}`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
    expect(ctx.d1.queries).toHaveLength(0);
  });

  it("`INSPECTOR` は 404（請求情報を見られない / security.md §1）", async () => {
    const ctx = setup("INSPECTOR");
    const response = await get(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/lines/tasks?lineKey=${encodeURIComponent(LINE_KEY_TWIN)}`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
    expect(ctx.d1.queries).toHaveLength(0);
  });
});

describe("作ってはいけない口", () => {
  it.each(["PATCH", "DELETE"])(
    "履歴に %s が無い（追記だけ / DECISIONS #127）",
    async (method) => {
      const ctx = setup();
      const response = await ctx.app.request(
        `/api/v1/billing-periods/${PERIOD_ID}/reviews`,
        { method, headers: { cookie: await ctx.cookie() } },
        ctx.env,
      );
      expect(response.status).toBe(404);
      expect(ctx.d1.queries).toHaveLength(0);
    },
  );

  it("DELETE が無い（CLAUDE.md §4）", async () => {
    const ctx = setup();
    const response = await ctx.app.request(
      `/api/v1/billing-periods/${PERIOD_ID}`,
      { method: "DELETE", headers: { cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(response.status).toBe(404);
    expect(ctx.d1.queries).toHaveLength(0);
  });
});
