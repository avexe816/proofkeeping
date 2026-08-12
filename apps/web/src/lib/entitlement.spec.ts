/**
 * `assertEntitlement()`（P0-12）。
 *
 * リポジトリ層（`isModuleEnabled()`）が組む SQL は
 * `packages/db/src/repositories/entitlement.spec.ts` が見ている。
 * ここは「未購入なら 402 に写る例外が飛ぶ」ことだけを見る。
 */

import type { Env, TenantContext } from "@pk/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const isModuleEnabled = vi.fn();

vi.mock("@pk/db", async () => {
  // `PaymentRequiredError` は実体を使う。同名クラスを 2 つ作ると
  // `instanceof` が外れ、402 のはずが 500 になる（errors.ts の申し送り）。
  const actual = await vi.importActual<typeof import("@pk/db")>("@pk/db");
  return {
    PaymentRequiredError: actual.PaymentRequiredError,
    isModuleEnabled: (...args: unknown[]) => isModuleEnabled(...args) as unknown,
  };
});

const { PaymentRequiredError } = await import("@pk/db");
const { assertEntitlement } = await import("./entitlement.js");

const ENV = {} as unknown as Env;

const TENANT: TenantContext = {
  organizationId: "org_test_alpha",
  orgShortId: "a1b2c3",
  role: "ORG_ADMIN",
  allowedPropertyIds: [],
  now: new Date("2026-08-12T09:00:00.000Z"),
};

const PROPERTY_ID = "a1b2c3__prop_01JBXQ3ZK8N4P2VYR60000";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assertEntitlement", () => {
  it("契約済みなら何も起きない", async () => {
    isModuleEnabled.mockResolvedValue(true);
    await expect(assertEntitlement(ENV, TENANT, "AUDIT", null)).resolves.toBeUndefined();
  });

  it("未購入なら PaymentRequiredError（→ 402）", async () => {
    isModuleEnabled.mockResolvedValue(false);
    await expect(assertEntitlement(ENV, TENANT, "AUDIT", null)).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
  });

  it("組織単位の判定は propertyId に null を渡す", async () => {
    isModuleEnabled.mockResolvedValue(true);
    await assertEntitlement(ENV, TENANT, "BILLING", null);
    expect(isModuleEnabled).toHaveBeenCalledWith(ENV, TENANT, "BILLING", null);
  });

  it("施設単位の判定は施設 ID をそのまま渡す", async () => {
    isModuleEnabled.mockResolvedValue(true);
    await assertEntitlement(ENV, TENANT, "HOUSEKEEPING_CORE", PROPERTY_ID);
    expect(isModuleEnabled).toHaveBeenCalledWith(ENV, TENANT, "HOUSEKEEPING_CORE", PROPERTY_ID);
  });

  it("投げるのは NotFoundError ではない（404 に潰さない）", async () => {
    // 権限の拒否は 404、契約の不足は 402。混ぜると購入導線が作れない。
    isModuleEnabled.mockResolvedValue(false);
    const error = await assertEntitlement(ENV, TENANT, "AUDIT", null).catch((e: unknown) => e);
    expect((error as Error).name).toBe("PaymentRequiredError");
  });
});
