/**
 * リポジトリ層の横断検証。**テナント分離の第 1 層の要。**
 *
 * task: docs/tasks/P0-07.md
 * 仕様: docs/PK-SPEC-P0.md §19.4 第1層
 *
 * ── この spec が守るもの ────────────────────────────────
 * 「すべてのリポジトリ関数が発行する SQL に `organization_id` 条件が載る」。
 *
 * **関数を追加したら自動的に検証対象に入る。** モジュールの export を走査し、
 * 下の `INVOCATIONS` に登録の無い関数があればテストが落ちる。登録すれば
 * 組織条件・越境 ID の検証がそのまま掛かる。登録を強制することで
 * 「新しい関数だけ条件が抜けている」状態を作れなくしている。
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Env } from "../env.js";
import { generateId } from "../id.js";
import { NotFoundError } from "../errors.js";
import type { TenantContext } from "../router.js";
import {
  createFakeD1,
  createFakeEnv,
  OTHER_ORG,
  TEST_ORG,
  tenantContext,
} from "../test-support/fake-d1.js";

import * as auditRepo from "./audit.js";
import * as entitlementRepo from "./entitlement.js";
import * as organizationRepo from "./organization.js";
import * as propertyRepo from "./property.js";
import * as roomRepo from "./room.js";
import * as userRepo from "./user.js";

/** 検証対象のリポジトリモジュール。**新しいファイルを足したらここに追加する。** */
const REPOSITORY_MODULES: Record<string, Record<string, unknown>> = {
  audit: auditRepo,
  entitlement: entitlementRepo,
  organization: organizationRepo,
  property: propertyRepo,
  room: roomRepo,
  user: userRepo,
};

/** 自組織の ID。`assertIdBelongsToTenant()` を通る形式。 */
const OWN_ID = {
  user: generateId(TEST_ORG.orgShortId, "usr"),
  membership: generateId(TEST_ORG.orgShortId, "mem"),
  property: generateId(TEST_ORG.orgShortId, "prop"),
  room: generateId(TEST_ORG.orgShortId, "room"),
} as const;

/** ハッシュの中身は問わない検証で使う値。実在のパスワードから作ったものではない。 */
const FAKE_HASH = "pbkdf2$sha256$210000$c2FsdA$aGFzaA";

/** 別組織の ID。越境の検証に使う。 */
const OTHER_ID = {
  user: generateId(OTHER_ORG.orgShortId, "usr"),
  membership: generateId(OTHER_ORG.orgShortId, "mem"),
  property: generateId(OTHER_ORG.orgShortId, "prop"),
  room: generateId(OTHER_ORG.orgShortId, "room"),
} as const;

/**
 * 1 関数の呼び出し方。
 *
 * `kind`:
 *   - `tenant`    通常の業務リポジトリ。`TenantContext` を要求する。
 *   - `bootstrap` 認証ブートストラップ専用（`ShardContext` で足りる 4 関数）。
 * `crossTenant`: ID 引数を取る関数。別組織の ID を渡したときの経路。
 */
interface Invocation {
  /** `"property.listProperties"` の形。モジュール名と export 名。 */
  name: string;
  kind: "tenant" | "bootstrap";
  run: (env: Env, ctx: TenantContext) => Promise<unknown>;
  crossTenant?: (env: Env, ctx: TenantContext) => Promise<unknown>;
}

/**
 * 全リポジトリ関数の呼び出し表。
 *
 * **関数を追加したらここに 1 行足すこと。** 足し忘れは
 * 「全 export が登録されている」テストが検出する。
 */
const INVOCATIONS: Invocation[] = [
  {
    name: "audit.recordAudit",
    kind: "tenant",
    run: (env, ctx) =>
      auditRepo.recordAudit(env, ctx, {
        actorId: OWN_ID.membership,
        action: "property.created",
        targetType: "property",
        targetId: OWN_ID.property,
      }),
    // actorId は membership の自己記述 ID。別組織の操作者を記録できてはならない。
    crossTenant: (env, ctx) =>
      auditRepo.recordAudit(env, ctx, {
        actorId: OTHER_ID.membership,
        action: "property.created",
        targetType: "property",
      }),
  },
  {
    name: "entitlement.isModuleEnabled",
    kind: "tenant",
    run: (env, ctx) => entitlementRepo.isModuleEnabled(env, ctx, "AUDIT", null),
    crossTenant: (env, ctx) => entitlementRepo.isModuleEnabled(env, ctx, "AUDIT", OTHER_ID.property),
  },
  {
    name: "entitlement.listEnabledModules",
    kind: "tenant",
    run: (env, ctx) => entitlementRepo.listEnabledModules(env, ctx, null),
    crossTenant: (env, ctx) => entitlementRepo.listEnabledModules(env, ctx, OTHER_ID.property),
  },
  {
    name: "organization.findOrganization",
    kind: "tenant",
    run: (env, ctx) => organizationRepo.findOrganization(env, ctx),
  },
  {
    name: "organization.findTaxProfile",
    kind: "tenant",
    run: (env, ctx) => organizationRepo.findTaxProfile(env, ctx),
  },
  {
    name: "property.listProperties",
    kind: "tenant",
    run: (env, ctx) => propertyRepo.listProperties(env, ctx, { isActive: true }),
  },
  {
    name: "property.findPropertyById",
    kind: "tenant",
    run: (env, ctx) => propertyRepo.findPropertyById(env, ctx, OWN_ID.property),
    crossTenant: (env, ctx) => propertyRepo.findPropertyById(env, ctx, OTHER_ID.property),
  },
  {
    name: "property.findPropertyByCode",
    kind: "tenant",
    run: (env, ctx) => propertyRepo.findPropertyByCode(env, ctx, "HTLA"),
  },
  {
    name: "property.createProperty",
    kind: "tenant",
    run: (env, ctx) => propertyRepo.createProperty(env, ctx, { code: "HTLA", name: "テスト施設" }),
  },
  {
    name: "room.listRooms",
    kind: "tenant",
    run: (env, ctx) => roomRepo.listRooms(env, ctx, { isSellable: true }),
  },
  {
    name: "room.findRoomById",
    kind: "tenant",
    run: (env, ctx) => roomRepo.findRoomById(env, ctx, OWN_ID.room),
    crossTenant: (env, ctx) => roomRepo.findRoomById(env, ctx, OTHER_ID.room),
  },
  {
    name: "user.listUsers",
    kind: "tenant",
    run: (env, ctx) => userRepo.listUsers(env, ctx, { isActive: true }),
  },
  {
    name: "user.findUserById",
    kind: "tenant",
    run: (env, ctx) => userRepo.findUserById(env, ctx, OWN_ID.user),
    crossTenant: (env, ctx) => userRepo.findUserById(env, ctx, OTHER_ID.user),
  },
  {
    name: "user.findUserByStaffNumber",
    kind: "bootstrap",
    run: (env, ctx) => userRepo.findUserByStaffNumber(env, ctx, "S-0001"),
  },
  {
    name: "user.recordLoginAttempt",
    kind: "bootstrap",
    run: (env, ctx) =>
      userRepo.recordLoginAttempt(env, ctx, {
        userId: OWN_ID.user,
        failedLoginCount: 1,
        lockedUntil: null,
        now: ctx.now,
      }),
    crossTenant: (env, ctx) =>
      userRepo.recordLoginAttempt(env, ctx, {
        userId: OTHER_ID.user,
        failedLoginCount: 1,
        lockedUntil: null,
        now: ctx.now,
      }),
  },
  {
    name: "user.findMembershipByUserId",
    kind: "bootstrap",
    run: (env, ctx) => userRepo.findMembershipByUserId(env, ctx, OWN_ID.user),
    crossTenant: (env, ctx) => userRepo.findMembershipByUserId(env, ctx, OTHER_ID.user),
  },
  {
    name: "user.listAssignedPropertyIds",
    kind: "bootstrap",
    run: (env, ctx) => userRepo.listAssignedPropertyIds(env, ctx, OWN_ID.membership),
    crossTenant: (env, ctx) =>
      userRepo.listAssignedPropertyIds(env, ctx, OTHER_ID.membership),
  },
  {
    name: "user.listRecentPasswordHashes",
    kind: "tenant",
    run: (env, ctx) => userRepo.listRecentPasswordHashes(env, ctx, OWN_ID.user),
    crossTenant: (env, ctx) => userRepo.listRecentPasswordHashes(env, ctx, OTHER_ID.user),
  },
  {
    name: "user.setPasswordHash",
    kind: "tenant",
    run: (env, ctx) =>
      userRepo.setPasswordHash(env, ctx, { userId: OWN_ID.user, passwordHash: FAKE_HASH }),
    crossTenant: (env, ctx) =>
      userRepo.setPasswordHash(env, ctx, { userId: OTHER_ID.user, passwordHash: FAKE_HASH }),
  },
];

/**
 * リポジトリの実ソース（spec を除く）。**コメント行は落とす。**
 *
 * 落とさないと、禁止事項を説明した doc コメント自体が検査に引っ掛かる。
 */
function repositorySources(): { file: string; code: string }[] {
  const directory = dirname(fileURLToPath(import.meta.url));
  return readdirSync(directory)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
    .map((file) => ({
      file,
      code: readFileSync(join(directory, file), "utf8")
        .split("\n")
        .filter((line) => {
          const trimmed = line.trimStart();
          return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
        })
        .join("\n"),
    }));
}

/** SELECT / UPDATE / DELETE の組織条件。 */
const ORG_CONDITION = /"[a-z_]+"\."organization_id" = \?/;

/** INSERT は WHERE を持たない。列に organization_id があることを見る。 */
const INSERT_WITH_ORG = /^insert into "[a-z_]+" \([^)]*"organization_id"/;

describe("登録漏れの検出", () => {
  it("エクスポートされた全リポジトリ関数が INVOCATIONS に登録されている", () => {
    const registered = new Set(INVOCATIONS.map((invocation) => invocation.name));
    const exported: string[] = [];
    for (const [moduleName, module] of Object.entries(REPOSITORY_MODULES)) {
      for (const [exportName, value] of Object.entries(module)) {
        if (typeof value === "function") exported.push(`${moduleName}.${exportName}`);
      }
    }

    const missing = exported.filter((name) => !registered.has(name));
    // 落ちたら repositories.spec.ts の INVOCATIONS に 1 行足すこと。
    // 組織条件の検証はそれだけで自動的に掛かる。
    expect(missing).toEqual([]);
  });

  it("INVOCATIONS に実在しない関数が残っていない", () => {
    for (const invocation of INVOCATIONS) {
      const [moduleName, exportName] = invocation.name.split(".");
      const module = moduleName === undefined ? undefined : REPOSITORY_MODULES[moduleName];
      expect(exportName === undefined ? undefined : module?.[exportName]).toBeTypeOf("function");
    }
  });
});

describe("organizationId の強制注入", () => {
  it.each(INVOCATIONS)("$name は organization_id 条件つきの SQL を発行する", async (invocation) => {
    const fake = createFakeD1();
    await invocation.run(createFakeEnv(fake), tenantContext());

    expect(fake.queries.length).toBeGreaterThan(0);
    for (const query of fake.queries) {
      if (query.sql.startsWith("insert into")) {
        expect(query.sql).toMatch(INSERT_WITH_ORG);
      } else {
        expect(query.sql).toMatch(ORG_CONDITION);
      }
      expect(query.params).toContain(TEST_ORG.organizationId);
    }
  });

  it.each(INVOCATIONS)(
    "$name は施設スコープロールでも organization_id 条件を落とさない",
    async (invocation) => {
      const fake = createFakeD1();
      await invocation.run(
        createFakeEnv(fake),
        tenantContext({ role: "CLEANER", allowedPropertyIds: ["prop_a"] }),
      );
      for (const query of fake.queries) {
        if (!query.sql.startsWith("insert into")) expect(query.sql).toMatch(ORG_CONDITION);
        expect(query.params).toContain(TEST_ORG.organizationId);
      }
    },
  );
});

describe("越境 ID", () => {
  const withCrossTenant = INVOCATIONS.filter((invocation) => invocation.crossTenant !== undefined);

  it("ID 引数を取る関数が 1 つ以上ある", () => {
    expect(withCrossTenant.length).toBeGreaterThan(0);
  });

  it.each(withCrossTenant)(
    "$name は別組織の ID で NotFoundError を投げ、DB に触れない",
    async (invocation) => {
      const fake = createFakeD1();
      const env = createFakeEnv(fake);
      // 403 ではなく 404 に写像される例外であること（architecture.md §2 第2層）。
      await expect(invocation.crossTenant?.(env, tenantContext())).rejects.toBeInstanceOf(
        NotFoundError,
      );
      // 問い合わせる前に落ちること。ここが 0 でないと越境 ID が DB へ届いている。
      expect(fake.queries).toEqual([]);
    },
  );
});

describe("認証ブートストラップの範囲", () => {
  it("ShardContext で足りる関数は 4 つだけ", () => {
    // 増やすと施設スコープの掛からない経路が広がる（DECISIONS #016 / #018）。
    // 4 つとも「認証が成立する前に動く」関数に限られる。ログイン後に動く関数を
    // ここへ足さないこと。TenantContext を要求できるなら要求する。
    const bootstrap = INVOCATIONS.filter((invocation) => invocation.kind === "bootstrap");
    expect(bootstrap.map((invocation) => invocation.name)).toEqual([
      "user.findUserByStaffNumber",
      "user.recordLoginAttempt",
      "user.findMembershipByUserId",
      "user.listAssignedPropertyIds",
    ]);
  });

  it("ブートストラップ関数はすべて user.ts にある", () => {
    // 別ファイルへ散ると「施設スコープが掛からない経路」の一覧性が失われる。
    const modules = INVOCATIONS.filter((invocation) => invocation.kind === "bootstrap").map(
      (invocation) => invocation.name.split(".")[0],
    );
    expect([...new Set(modules)]).toEqual(["user"]);
  });

  it("withOrganizationScope を呼んでいるのは user.ts だけ", () => {
    // 登録表（INVOCATIONS）ではなく実ソースを見る。kind の付け替えだけでは
    // すり抜けられないようにするため。
    // base.ts（定義元）と index.ts（再エクスポート）は使用箇所ではないので除く。
    const callers = repositorySources()
      .filter(({ file }) => file !== "base.ts" && file !== "index.ts")
      .filter(({ code }) => code.includes("withOrganizationScope("))
      .map(({ file }) => file);
    expect(callers).toEqual(["user.ts"]);
  });

  it("リポジトリは全局テーブル（org_directory）を引かない", () => {
    // org_directory は organization_id 列を持つため TenantScopedTable を
    // 型としては満たしてしまう（base.ts の doc 参照）。型で弾けない分をここで見る。
    // 全局テーブルへは getGlobalDb()（SHARD_00 固定）からのみ到達する。
    for (const { file, code } of repositorySources()) {
      expect(code, file).not.toMatch(/orgDirectory|schema\/global/);
    }
  });

  it("リポジトリは db.query.* を使わない", () => {
    // relational query API は where を省いても型が通り、withTenantScope を迂回できる。
    for (const { file, code } of repositorySources()) {
      expect(code, file).not.toMatch(/\bdb\.query\./);
    }
  });
});

describe("ctx.now", () => {
  it("createProperty は ctx.now を createdAt / updatedAt に入れる", async () => {
    // リポジトリで Date.now() を呼ばない（CLAUDE.md §5）。
    const fake = createFakeD1();
    const now = new Date("2026-01-02T03:04:05.000Z");
    await propertyRepo.createProperty(createFakeEnv(fake), tenantContext({ now }), {
      code: "HTLB",
      name: "テスト施設",
    });
    const query = fake.queries[0];
    const timestamps = query?.params.filter((param) => param === now.getTime());
    expect(timestamps).toHaveLength(2);
  });

  it("createProperty の id は自組織の orgShortId を持つ", async () => {
    const fake = createFakeD1();
    const created = await propertyRepo.createProperty(
      createFakeEnv(fake),
      tenantContext(),
      { code: "HTLC", name: "テスト施設" },
    );
    expect(created.id.startsWith(`${TEST_ORG.orgShortId}__prop_`)).toBe(true);
    expect(created.organizationId).toBe(TEST_ORG.organizationId);
  });
});
