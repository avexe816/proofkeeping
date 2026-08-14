/**
 * サーキットブレーカー（P6-07 / PK-SPEC-P6 §3.4）。
 *
 * 仕様の受け入れ基準（§8.1）:
 *   - 5 回連続失敗で ERROR になり、通知される
 *   - **ERROR 状態でも照合バッチが完走する**
 *   - **手動 CSV 取込が常に使える**
 *
 * ── 通知はここに無い ────────────────────────────────────
 * `integration.error` の EMAIL 配信は §5.1 の 10 イベントの 1 つで、
 * **通知基盤は P6-09。** ここが押さえるのは「今回開いたのか、既に
 * 開いていたのか」を返すところまでで、その真偽値を受けて 1 回だけ
 * 送るのが P6-09 の仕事（`openCircuitIfNeeded()` の注記）。
 *
 * ── 後ろ 2 つを「読まないこと」で確かめる ───────────────
 * 「ERROR でも照合が完走する」「CSV 取込が常に使える」は、
 * **照合バッチと CSV 取込が `integration` を 1 度も読まない**という
 * 構造で成り立っている。振る舞いのテストは「たまたま今は通る」を
 * 通してしまうので、依存そのものが無いことを見る。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { generateId } from "@pk/db";
import { createFakeD1, createFakeEnv, TEST_ORG, type FakeD1 } from "@pk/db/test-support";
import { CIRCUIT_OPEN_THRESHOLD } from "@pk/integrations";
import { describe, expect, it } from "vitest";

import { openCircuitIfNeeded } from "./signalIngest.js";

const INTEGRATION_ID = generateId(TEST_ORG.orgShortId, "intg");
const PROPERTY_ID = generateId(TEST_ORG.orgShortId, "prop");
const NOW = new Date("2026-09-10T02:00:00.000Z");

const CTX = {
  organizationId: TEST_ORG.organizationId,
  orgShortId: TEST_ORG.orgShortId,
  role: "ORG_ADMIN",
  allowedPropertyIds: [],
  now: NOW,
} as const;

/** `integration` を 1 行積む。列順は schema の宣言順。 */
function primeIntegration(
  fake: FakeD1,
  options: { status: string; consecutiveFailures: number },
): void {
  fake.enqueueRows([
    [
      INTEGRATION_ID,
      TEST_ORG.organizationId,
      PROPERTY_ID,
      "SMART_LOCK",
      "api-generic",
      "汎用 Webhook",
      options.status,
      "{}",
      null,
      "PUSH",
      null,
      null,
      null,
      null,
      null,
      null,
      options.consecutiveFailures,
      NOW.getTime(),
      NOW.getTime(),
    ],
  ]);
}

/**
 * `integration` への UPDATE を探す。
 *
 * **`includes("update")` で見ない。** `select` の列に `updated_at` が
 * 並ぶので、読み取りまで拾ってしまう。
 */
function integrationUpdate(queries: readonly { sql: string; params: unknown[] }[]) {
  return queries.find((query) => query.sql.startsWith('update "integration"'));
}

describe("openCircuitIfNeeded — 開く", () => {
  it("5 回連続失敗で ERROR にする", async () => {
    const fake = createFakeD1();
    primeIntegration(fake, { status: "ACTIVE", consecutiveFailures: CIRCUIT_OPEN_THRESHOLD });
    const opened = await openCircuitIfNeeded(createFakeEnv(fake), CTX, INTEGRATION_ID, "TIMEOUT");
    expect(opened).toBe(true);
    expect(integrationUpdate(fake.queries)?.params).toContain("ERROR");
  });

  it("6 回でも開く（取りこぼさない）", async () => {
    const fake = createFakeD1();
    primeIntegration(fake, { status: "ACTIVE", consecutiveFailures: 9 });
    expect(
      await openCircuitIfNeeded(createFakeEnv(fake), CTX, INTEGRATION_ID, "TIMEOUT"),
    ).toBe(true);
  });

  it("失敗理由を残す（外部の応答そのものではなく内部の理由）", async () => {
    const fake = createFakeD1();
    primeIntegration(fake, { status: "ACTIVE", consecutiveFailures: CIRCUIT_OPEN_THRESHOLD });
    await openCircuitIfNeeded(createFakeEnv(fake), CTX, INTEGRATION_ID, "D1_UNAVAILABLE");
    expect(integrationUpdate(fake.queries)?.params).toContain("D1_UNAVAILABLE");
  });
});

describe("openCircuitIfNeeded — 開かない", () => {
  it("4 回では開かない", async () => {
    const fake = createFakeD1();
    primeIntegration(fake, { status: "ACTIVE", consecutiveFailures: 4 });
    const opened = await openCircuitIfNeeded(createFakeEnv(fake), CTX, INTEGRATION_ID, "TIMEOUT");
    expect(opened).toBe(false);
    expect(integrationUpdate(fake.queries)).toBeUndefined();
  });

  it("**既に ERROR なら `false`**（通知を毎回の失敗で送らせない）", async () => {
    const fake = createFakeD1();
    primeIntegration(fake, { status: "ERROR", consecutiveFailures: 12 });
    expect(
      await openCircuitIfNeeded(createFakeEnv(fake), CTX, INTEGRATION_ID, "TIMEOUT"),
    ).toBe(false);
  });

  it("**`SUSPENDED` を上書きしない**（利用者が止めた状態）", async () => {
    const fake = createFakeD1();
    primeIntegration(fake, { status: "SUSPENDED", consecutiveFailures: 12 });
    const opened = await openCircuitIfNeeded(createFakeEnv(fake), CTX, INTEGRATION_ID, "TIMEOUT");
    expect(opened).toBe(false);
    expect(integrationUpdate(fake.queries)).toBeUndefined();
  });

  it("連携が引けなければ `false`（例外にしない）", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([]);
    expect(
      await openCircuitIfNeeded(createFakeEnv(fake), CTX, INTEGRATION_ID, "TIMEOUT"),
    ).toBe(false);
  });

  it("D1 へ到達できなくても例外を投げない（失敗の記録に失敗しても止めない）", async () => {
    // シャードの binding が無い env。`getTenantDb()` が投げる。
    const broken = {} as Parameters<typeof openCircuitIfNeeded>[0];
    await expect(
      openCircuitIfNeeded(broken, CTX, INTEGRATION_ID, "TIMEOUT"),
    ).resolves.toBe(false);
  });
});

/** ソースを読む（相対は `import.meta.url` 起点）。 */
function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("ERROR でも止まらないもの（§1.2 / §3.4 MUST）", () => {
  it("照合バッチは `integration` を 1 度も読まない", () => {
    const text = source("./reconciliation.ts");
    expect(text).not.toContain("findIntegrationById");
    expect(text).not.toContain("listIntegrations");
    expect(text).not.toContain("listOrgWideIntegrations");
  });

  it("照合バッチは連携の状態で分岐しない", () => {
    expect(source("./reconciliation.ts")).not.toContain("consecutiveFailures");
  });

  it("**手動 CSV 取込は `integration` を読まない**（常にフォールバックが残る）", () => {
    const text = source("../routes/api/v1/occupancy.ts");
    expect(text).not.toContain("findIntegrationById");
    expect(text).not.toContain("listIntegrations");
  });

  it("CSV 取込の口が生きている（`source = CSV_IMPORT`）", () => {
    const text = source("../routes/api/v1/occupancy.ts");
    expect(text).toContain('occupancy.post("/import/csv"');
    expect(text).toContain("CSV_IMPORT");
  });

  it("連携先固有の分岐が `packages/integrations` の外に無い（§1.1 MUST）", () => {
    for (const path of ["./signalIngest.ts", "./reconciliation.ts"]) {
      expect(source(path)).not.toMatch(/vendorCode\s*===/);
    }
  });
});
