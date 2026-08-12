/**
 * ID の自己記述検証と拒否の写像（P0-10）。
 *
 * 完了条件「ID 不一致で **DB 問い合わせ前に** 404 が返る」を、
 * ハンドラへ到達しないこと（＝リポジトリが呼ばれる余地が無いこと）で確かめる。
 */

import type { Env, TenantContext } from "@pk/db";
import { NotFoundError, PaymentRequiredError } from "@pk/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { AppEnv } from "./context.js";
import {
  apiErrorHandler,
  apiNotFoundHandler,
  sanitizeErrorCode,
  withResourceGuard,
} from "./resourceGuard.js";

const ORG_SHORT_ID = "a1b2c3";
const OTHER_ORG_SHORT_ID = "z9y8x7";

const TENANT: TenantContext = {
  organizationId: "org_test_alpha",
  orgShortId: ORG_SHORT_ID,
  role: "ORG_ADMIN",
  allowedPropertyIds: [],
  now: new Date("2026-08-12T09:00:00.000Z"),
};

const ENV = {} as unknown as Env;

interface Harness {
  app: Hono<AppEnv>;
  /** ハンドラへ到達した回数。0 なら DB 問い合わせの余地が無い。 */
  reached: () => number;
}

/** tenant を直に載せた最小の app。session / tenant middleware は通さない。 */
function setup(): Harness {
  let reached = 0;
  const app = new Hono<AppEnv>();
  app.onError(apiErrorHandler());
  app.notFound(apiNotFoundHandler());
  app.use("*", async (c, next) => {
    c.set("tenant", TENANT);
    await next();
  });
  app.use("*", withResourceGuard());
  app.get("/tasks/:taskId", (c) => {
    reached++;
    return c.body(null, 204);
  });
  app.get("/pages/:page", (c) => {
    reached++;
    return c.body(null, 204);
  });
  app.get("/tasks/:taskId/photos/:photoId", (c) => {
    reached++;
    return c.body(null, 204);
  });
  return { app, reached: () => reached };
}

describe("パス変数の照合", () => {
  it("自組織の ID は通る", async () => {
    const { app, reached } = setup();

    const res = await app.request(`/tasks/${ORG_SHORT_ID}__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH`, {}, ENV);

    expect(res.status).toBe(204);
    expect(reached()).toBe(1);
  });

  it("別組織の ID は 404", async () => {
    const { app } = setup();

    const res = await app.request(
      `/tasks/${OTHER_ORG_SHORT_ID}__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
      {},
      ENV,
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "RESOURCE_NOT_FOUND" });
  });

  it("別組織の ID ではハンドラへ到達しない（DB 問い合わせ前に落とす）", async () => {
    const { app, reached } = setup();

    await app.request(`/tasks/${OTHER_ORG_SHORT_ID}__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH`, {}, ENV);

    expect(reached()).toBe(0);
  });

  it("403 を返さない", async () => {
    // architecture.md §2 第2層 / INV-31。403 は資源の存在を示唆する。
    const { app } = setup();

    const res = await app.request(
      `/tasks/${OTHER_ORG_SHORT_ID}__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
      {},
      ENV,
    );

    expect(res.status).not.toBe(403);
  });

  it("形が壊れた自己記述 ID も 404", async () => {
    const { app, reached } = setup();

    const res = await app.request(`/tasks/${ORG_SHORT_ID}__notaprefix_xxx`, {}, ENV);

    expect(res.status).toBe(404);
    expect(reached()).toBe(0);
  });

  it("複数のパス変数をすべて見る", async () => {
    const { app, reached } = setup();

    const res = await app.request(
      `/tasks/${ORG_SHORT_ID}__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH` +
        `/photos/${OTHER_ORG_SHORT_ID}__evd_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
      {},
      ENV,
    );

    expect(res.status).toBe(404);
    expect(reached()).toBe(0);
  });

  it("自己記述 ID の形でない値は素通しする", async () => {
    // ページ番号・施設コードなど。ID かどうかの厳密な検査は
    // リポジトリ層の assertIdBelongsToTenant() が二重に行う。
    const { app, reached } = setup();

    const res = await app.request("/pages/2", {}, ENV);

    expect(res.status).toBe(204);
    expect(reached()).toBe(1);
  });

  it("tenant が無いまま置かれたら例外（配線の誤り）", async () => {
    const app = new Hono<AppEnv>();
    app.onError(apiErrorHandler());
    app.use("*", withResourceGuard());
    app.get("/tasks/:taskId", (c) => c.body(null, 204));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await app.request(`/tasks/${ORG_SHORT_ID}__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH`, {}, ENV);

    // 404 でも 401 でもない。利用者の誤りではないため。
    expect(res.status).toBe(500);
    expect(spy).toHaveBeenCalledWith("CONTEXT_MISSING_TENANT");
    spy.mockRestore();
  });
});

describe("apiErrorHandler", () => {
  /** ハンドラが投げる例外を写す app。 */
  function appThatThrows(error: Error): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.onError(apiErrorHandler());
    app.get("/x", () => {
      throw error;
    });
    return app;
  }

  it("ハンドラの NotFoundError を 404 にする", async () => {
    const res = await appThatThrows(new NotFoundError()).request("/x", {}, ENV);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "RESOURCE_NOT_FOUND" });
  });

  it("ハンドラの PaymentRequiredError を 402 にする（P0-12）", async () => {
    const res = await appThatThrows(new PaymentRequiredError()).request("/x", {}, ENV);

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "PAYMENT_REQUIRED" });
  });

  it("402 の本体に不足モジュール名を載せない", async () => {
    const res = await appThatThrows(new PaymentRequiredError("AUDIT")).request("/x", {}, ENV);

    expect(await res.text()).not.toContain("AUDIT");
  });

  it("それ以外は 500。内訳を応答に載せない", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await appThatThrows(new Error("SHARD_BINDING_MISSING:SHARD_07")).request(
      "/x",
      {},
      ENV,
    );

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("SHARD");
    spy.mockRestore();
  });

  it("ログにシャード番号を出さない", async () => {
    // architecture.md §1「シャード番号を URL・レスポンス・ログに露出しない」。
    // Hono 既定のハンドラは例外をそのまま console.error するため、ここで握る。
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await appThatThrows(new Error("SHARD_BINDING_MISSING:SHARD_07")).request("/x", {}, ENV);

    expect(spy).toHaveBeenCalledWith("SHARD_BINDING_MISSING");
    spy.mockRestore();
  });
});

describe("apiNotFoundHandler", () => {
  it("未定義の経路も権限で拒否した経路と同じ応答", async () => {
    // 片方が Hono 既定のテキスト 404 だと、その差で経路の実装有無が読める。
    const { app } = setup();

    const undefinedRoute = await app.request("/nothing-here", {}, ENV);
    const denied = await app.request(
      `/tasks/${OTHER_ORG_SHORT_ID}__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
      {},
      ENV,
    );

    expect(undefinedRoute.status).toBe(denied.status);
    expect(await undefinedRoute.json()).toEqual(await denied.json());
  });
});

describe("sanitizeErrorCode", () => {
  it("`:` の右を落とす", () => {
    expect(sanitizeErrorCode(new Error("SHARD_BINDING_MISSING:SHARD_07"))).toBe(
      "SHARD_BINDING_MISSING",
    );
    expect(sanitizeErrorCode(new Error("SHARD_MAP_INVALID:org_test_alpha"))).toBe(
      "SHARD_MAP_INVALID",
    );
  });

  it("コードの形でないものは中身ごと捨てる", () => {
    expect(sanitizeErrorCode(new Error("something went wrong at line 42"))).toBe("UNEXPECTED_ERROR");
    expect(sanitizeErrorCode(new Error(""))).toBe("UNEXPECTED_ERROR");
  });

  it("Error でない値も落とせる", () => {
    expect(sanitizeErrorCode("SHARD_BINDING_MISSING:SHARD_07")).toBe("UNEXPECTED_ERROR");
    expect(sanitizeErrorCode(null)).toBe("UNEXPECTED_ERROR");
  });
});
