/**
 * テナントのスナップショットの投入（PF-02）。
 *
 * 完了条件のうちここが見るもの:
 *   - **1 メッセージが 1 テナントぶん**（組織ごとに 1 通）
 *   - 1 組織で落ちても残りを止めない
 *   - 結果に組織 ID を含めない（ログへ出さないため）
 */

import type { Env } from "@pk/db";
import { createFakeD1, createFakeEnv, type FakeD1 } from "@pk/db/test-support";
import { describe, expect, it } from "vitest";

import { isTenantSnapshotMessage } from "../../consumers/tenantSnapshot.js";

import {
  dispatchTenantSnapshots,
  TENANT_SNAPSHOT_ORGANIZATION_LIMIT,
} from "./snapshotDispatch.js";

const NOW = new Date("2026-08-19T17:00:00.000Z");

/** `listOrganizationDirectory()` が返す行（orgShortId / organizationId）。 */
function directory(fake: FakeD1, orgShortIds: readonly string[]): void {
  fake.enqueueRows(orgShortIds.map((orgShortId) => [orgShortId, `${orgShortId}__org_x`]));
}

function envWith(fake: FakeD1, sent: unknown[], failOn?: string): Env {
  return {
    ...createFakeEnv(fake),
    QUEUE_ROLLUP_UPDATE: {
      send: (message: { orgShortId?: string }) => {
        if (failOn !== undefined && message.orgShortId === failOn) {
          return Promise.reject(new Error("QUEUE_ERROR"));
        }
        sent.push(message);
        return Promise.resolve();
      },
    },
  } as unknown as Env;
}

describe("dispatchTenantSnapshots", () => {
  it("組織ごとに 1 通ずつ投げる", async () => {
    const fake = createFakeD1();
    directory(fake, ["aaa111", "bbb222", "ccc333"]);
    const sent: unknown[] = [];

    const result = await dispatchTenantSnapshots(envWith(fake, sent), NOW);

    expect(result.organizations).toBe(3);
    expect(result.queued).toBe(3);
    expect(result.failedOrganizations).toBe(0);
    expect(sent).toHaveLength(3);
  });

  it("メッセージが `TENANT_SNAPSHOT` の形をしている（ROLLUP_UPDATE と相乗り）", async () => {
    const fake = createFakeD1();
    directory(fake, ["aaa111"]);
    const sent: unknown[] = [];
    await dispatchTenantSnapshots(envWith(fake, sent), NOW);

    expect(sent[0]).toEqual({
      kind: "TENANT_SNAPSHOT",
      orgShortId: "aaa111",
      requestedAtMs: NOW.getTime(),
    });
    expect(isTenantSnapshotMessage(sent[0])).toBe(true);
  });

  it("**1 通に 2 つ以上のテナントを詰めない**（完了条件）", async () => {
    const fake = createFakeD1();
    directory(fake, ["aaa111", "bbb222"]);
    const sent: { orgShortId: string }[] = [];
    await dispatchTenantSnapshots(envWith(fake, sent), NOW);

    expect(sent.map((message) => message.orgShortId)).toEqual(["aaa111", "bbb222"]);
    for (const message of sent) {
      expect(typeof message.orgShortId).toBe("string");
    }
  });

  it("1 組織で落ちても残りを止めない", async () => {
    const fake = createFakeD1();
    directory(fake, ["aaa111", "bbb222", "ccc333"]);
    const sent: unknown[] = [];

    const result = await dispatchTenantSnapshots(envWith(fake, sent, "bbb222"), NOW);

    expect(result.queued).toBe(2);
    expect(result.failedOrganizations).toBe(1);
  });

  it("**時刻をメッセージが持つ**（再送で payload が変わらない）", async () => {
    const fake = createFakeD1();
    directory(fake, ["aaa111"]);
    const sent: { requestedAtMs: number }[] = [];
    await dispatchTenantSnapshots(envWith(fake, sent), NOW);
    expect(sent[0]?.requestedAtMs).toBe(NOW.getTime());
  });

  it("組織が 0 件でも落ちない", async () => {
    const fake = createFakeD1();
    directory(fake, []);
    const sent: unknown[] = [];
    const result = await dispatchTenantSnapshots(envWith(fake, sent), NOW);
    expect(result).toEqual({
      organizations: 0,
      queued: 0,
      failedOrganizations: 0,
      truncated: false,
    });
  });

  it("上限に達したら `truncated`（取りこぼしに気づけるようにする）", async () => {
    const fake = createFakeD1();
    directory(
      fake,
      Array.from({ length: TENANT_SNAPSHOT_ORGANIZATION_LIMIT }, (_, index) =>
        `org${String(index).padStart(3, "0")}`,
      ),
    );
    const sent: unknown[] = [];
    const result = await dispatchTenantSnapshots(envWith(fake, sent), NOW);
    expect(result.truncated).toBe(true);
  });

  it("結果に組織 ID を含めない（ログへ出さないため）", async () => {
    const fake = createFakeD1();
    directory(fake, ["aaa111"]);
    const sent: unknown[] = [];
    const result = await dispatchTenantSnapshots(envWith(fake, sent), NOW);
    expect(JSON.stringify(result)).not.toContain("aaa111");
    expect(JSON.stringify(result)).not.toContain("org_x");
  });
});
