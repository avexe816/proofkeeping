/**
 * 通知バッジの件数（A01 §3.2）。
 *
 * ── ここが見るのは 3 つ ─────────────────────────────────
 *   1. LOW を数に入れない（受け入れ基準 #15）
 *   2. 未対応（OPEN / REVIEWING）だけを数え、閉じた差異を残さない
 *   3. 差異を読めない相手には `null`（0 ではない / security.md §1）
 *
 * リポジトリが組む SQL は `packages/db` 側の spec が見ている。
 */

import type { Env, FindingStatus, TenantContext } from "@pk/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const countFindingsByStatus = vi.fn();

vi.mock("@pk/db", () => ({
  countFindingsByStatus: (...args: unknown[]) => countFindingsByStatus(...args) as unknown,
}));

const { countNotificationBadge, formatNotificationBadge } = await import("./badge.js");

const ENV = {} as unknown as Env;
const PROPERTY_A = "a1b2c3__prop_01JBXQ3ZK8N4P2VYR60000";
const PROPERTY_B = "a1b2c3__prop_01JBXQ3ZK8N4P2VYR60001";

function tenant(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    organizationId: "org_test_alpha",
    orgShortId: "a1b2c3",
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now: new Date("2026-08-20T00:00:00.000Z"),
    ...overrides,
  };
}

function counts(rows: Partial<Record<FindingStatus, number>>) {
  countFindingsByStatus.mockResolvedValue(
    new Map(Object.entries(rows) as [FindingStatus, number][]),
  );
}

beforeEach(() => {
  countFindingsByStatus.mockReset();
});

describe("countNotificationBadge", () => {
  it("未対応（OPEN / REVIEWING）を足す", async () => {
    counts({ OPEN: 3, REVIEWING: 1 });
    expect(await countNotificationBadge(ENV, tenant(), null)).toBe(4);
  });

  it("閉じた差異を数えない", async () => {
    counts({ OPEN: 2, RESOLVED: 40, FALSE_POSITIVE: 7, SUPPRESSED: 5 });
    expect(await countNotificationBadge(ENV, tenant(), null)).toBe(2);
  });

  it("HIGH と MEDIUM だけを引く（LOW を渡さない）", async () => {
    counts({ OPEN: 1 });
    await countNotificationBadge(ENV, tenant(), null);
    expect(countFindingsByStatus).toHaveBeenCalledWith(ENV, expect.anything(), {
      propertyId: undefined,
      severity: ["HIGH", "MEDIUM"],
    });
  });

  it("施設を選んでいればその施設で絞る", async () => {
    counts({ OPEN: 1 });
    await countNotificationBadge(ENV, tenant(), PROPERTY_A);
    expect(countFindingsByStatus).toHaveBeenCalledWith(ENV, expect.anything(), {
      propertyId: PROPERTY_A,
      severity: ["HIGH", "MEDIUM"],
    });
  });

  it("差異が 1 件も無ければ 0（`null` ではない）", async () => {
    counts({});
    expect(await countNotificationBadge(ENV, tenant(), null)).toBe(0);
  });

  // ── 負例 ──────────────────────────────────────────────

  it("CLEANER には `null` を返し、件数を引きにいかない", async () => {
    const result = await countNotificationBadge(
      ENV,
      tenant({ role: "CLEANER", allowedPropertyIds: [PROPERTY_A] }),
      PROPERTY_A,
    );
    expect(result).toBeNull();
    expect(countFindingsByStatus).not.toHaveBeenCalled();
  });

  it("INSPECTOR にも `null` を返す", async () => {
    const result = await countNotificationBadge(
      ENV,
      tenant({ role: "INSPECTOR", allowedPropertyIds: [PROPERTY_A] }),
      PROPERTY_A,
    );
    expect(result).toBeNull();
    expect(countFindingsByStatus).not.toHaveBeenCalled();
  });

  it("担当外の施設を表示中なら `null`", async () => {
    const result = await countNotificationBadge(
      ENV,
      tenant({ role: "PROPERTY_MANAGER", allowedPropertyIds: [PROPERTY_A] }),
      PROPERTY_B,
    );
    expect(result).toBeNull();
    expect(countFindingsByStatus).not.toHaveBeenCalled();
  });

  it("全社を読めないロールが全社表示に落ちたら `null`", async () => {
    const result = await countNotificationBadge(
      ENV,
      tenant({ role: "PROPERTY_MANAGER", allowedPropertyIds: [PROPERTY_A] }),
      null,
    );
    expect(result).toBeNull();
  });
});

describe("formatNotificationBadge — A01 §3.2 の表", () => {
  it("0 件はバッジを出さない", () => {
    expect(formatNotificationBadge(0)).toBeNull();
  });

  it("1 件以上はそのまま", () => {
    expect(formatNotificationBadge(1)).toBe("1");
    expect(formatNotificationBadge(4)).toBe("4");
    expect(formatNotificationBadge(99)).toBe("99");
  });

  it("99 件超は 99+", () => {
    expect(formatNotificationBadge(100)).toBe("99+");
    expect(formatNotificationBadge(1234)).toBe("99+");
  });

  it("負の数でも出さない（数え損ねを 0 と同じに倒す）", () => {
    expect(formatNotificationBadge(-1)).toBeNull();
  });
});
