/**
 * トライアル終了後の読み取り専用モード（P7-03 / PK-SPEC-P7 §2.5）。
 *
 * ── 見ているもの ────────────────────────────────────────
 *   読み取り（GET / HEAD / OPTIONS）は**いつでも通る**
 *   終了後の書き込みは **402**
 *   **優先度 1（§5.2）の 4 操作だけは通る**（記録済みの作業を落とさない）
 *   トライアル中・非トライアルは書ける
 *   読み取りでは契約を引かない（無駄なクエリを足していない）
 */

import { PaymentRequiredError } from "@pk/db";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { AppEnv } from "./context.js";
import { withTrialReadOnly, type TrialReadOnlyDeps } from "./readOnly.js";

const NOW = new Date("2026-09-15T00:00:00.000Z");
const ENDED = new Date("2026-09-01T00:00:00.000Z");
const FUTURE = new Date("2026-10-01T00:00:00.000Z");
/** 終了から 90 日を過ぎた時点。 */
const LONG_AFTER = new Date("2027-01-01T00:00:00.000Z");

type Subscription = { status?: string | null; trialEndsAt?: Date | null } | undefined;

function build(subscription: Subscription, now: Date = NOW): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const deps: TrialReadOnlyDeps = { findSubscription: () => Promise.resolve(subscription) };

  app.use("*", async (c, next) => {
    c.set("tenant", { organizationId: "org", orgShortId: "a1b2c3", now } as never);
    await next();
  });
  app.onError((error) => {
    if (error instanceof PaymentRequiredError) return new Response(null, { status: 402 });
    throw error;
  });
  app.use("*", withTrialReadOnly(deps));
  app.all("*", (c) => c.text("ok"));
  return app;
}

async function send(app: Hono<AppEnv>, method: string, path = "/api/v1/rooms"): Promise<Response> {
  return app.request(path, { method });
}

describe("読み取り", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    it(`${method} は終了後でも通る`, async () => {
      const app = build({ status: "TRIAL", trialEndsAt: ENDED });
      expect((await send(app, method)).status).toBe(200);
    });
  }

  it("**読み取りでは契約を引かない**", async () => {
    let calls = 0;
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("tenant", { organizationId: "org", orgShortId: "a1b2c3", now: NOW } as never);
      await next();
    });
    app.use(
      "*",
      withTrialReadOnly({
        findSubscription: () => {
          calls += 1;
          return Promise.resolve({ status: "TRIAL", trialEndsAt: ENDED });
        },
      }),
    );
    app.all("*", (c) => c.text("ok"));

    await send(app, "GET");
    expect(calls).toBe(0);
  });
});

describe("書き込み", () => {
  it("**トライアルが終わっていたら 402**", async () => {
    const app = build({ status: "TRIAL", trialEndsAt: ENDED });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((await send(app, method)).status).toBe(402);
    }
  });

  it("**保持期限を過ぎても 402**（書けないだけ。消えたのではない）", async () => {
    const app = build({ status: "TRIAL", trialEndsAt: ENDED }, LONG_AFTER);
    expect((await send(app, "POST")).status).toBe(402);
  });

  it("トライアル中は通る", async () => {
    const app = build({ status: "TRIAL", trialEndsAt: FUTURE });
    expect((await send(app, "POST")).status).toBe(200);
  });

  it("**期限が無いトライアルは通る**（設定漏れで止めない）", async () => {
    const app = build({ status: "TRIAL", trialEndsAt: null });
    expect((await send(app, "POST")).status).toBe(200);
  });

  it("トライアルでなければ通る", async () => {
    for (const status of ["ACTIVE", "PAST_DUE", "CANCELED"]) {
      const app = build({ status, trialEndsAt: ENDED });
      expect((await send(app, "POST")).status).toBe(200);
    }
  });

  it("契約の行が無ければ通る（未契約はエンタイトルメントの担当）", async () => {
    const app = build(undefined);
    expect((await send(app, "POST")).status).toBe(200);
  });
});

/**
 * §5.2 の優先度 1。**ここが通らないと、記録済みの作業が落ちる。**
 *
 * 402 は 4xx で、オフラインキューは 4xx を `GIVE_UP` にする
 * （`lib/offline/policy.ts`）。夜中に期限が切れると、その勤務で
 * 記録した完了が捨てられる。
 */
describe("優先度 1 の書き込みだけは通る（§5.2 / DECISIONS #183）", () => {
  const TASK = "/api/v1/tasks/a1b2c3__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH";

  for (const action of ["start", "pause", "resume", "complete"]) {
    it(`終了後でも \`${action}\` は通る`, async () => {
      const app = build({ status: "TRIAL", trialEndsAt: ENDED });
      expect((await send(app, "POST", `${TASK}/${action}`)).status).toBe(200);
    });
  }

  it("**それ以外のタスク操作は止まる**（免除を広げていない）", async () => {
    const app = build({ status: "TRIAL", trialEndsAt: ENDED });
    for (const path of [`${TASK}/photos`, `${TASK}/observation`, "/api/v1/tasks/generate"]) {
      expect((await send(app, "POST", path)).status).toBe(402);
    }
  });

  it("クエリ文字列が付いていても判定が外れない", async () => {
    const app = build({ status: "TRIAL", trialEndsAt: ENDED });
    expect((await send(app, "POST", `${TASK}/complete?retry=1`)).status).toBe(200);
  });
});
