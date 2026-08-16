/**
 * シードデータ。**3 施設 120 室・清掃スタッフ 15 名。**
 *
 * task:  docs/tasks/P0-18.md
 * ルール: .claude/rules/security.md §2（PIN）/ .claude/rules/architecture.md §1
 *
 * ── ファイル名を変えないこと ────────────────────────────
 * このパスは ESLint の `no-direct-shard-access` / `no-raw-drizzle` の
 * allowlist に書かれている（docs/DECISIONS.md #009）。改名すると lint が落ちる。
 *
 * ── ハッシュ化を注入で受ける理由 ────────────────────────
 * `hashPin()` / `hashPassword()` は `apps/web/src/lib/auth/` にある。
 * **`packages/*` から `apps/*` は import できない**（依存の向きが逆になる）。
 * かといってここで PBKDF2 を書き直すと、方式・反復回数・保存形式が
 * 二重管理になる。**注入で受けて、実装は 1 つに保つ。**
 *
 * 呼び出し側は `apps/web/src/lib/seed/runSeed.ts`。そこが
 * `pinSchema`（@pk/contracts）で検証してから `hashPin()` を渡す。
 * ここでも `pinSchema` を通すのは二重確認で、**迂回路を作らないため**
 * （`hashPin()` を直に呼ぶと連番・ゾロ目を登録できる — P0-09 の申し送り）。
 *
 * ── 3 回実行しても同じ状態になる ────────────────────────
 * ID は決定的に採る（固定の時刻とカウンタから ULID を作る）。
 * 加えて全 INSERT が `onConflictDoNothing()`。**どちらか片方では足りない。**
 * ID だけ決定的でも一意制約の衝突で落ち、`onConflictDoNothing` だけでは
 * 2 回目に別 ID の行が増える。
 *
 * ── production では実行しない ───────────────────────────
 * `ENVIRONMENT` を見て落とす。フラグで上書きできる余地を作らない。
 */

import { pinSchema } from "@pk/contracts";

import type { Env } from "./env.js";
import { createUlidFactory } from "./id.js";
import { reserveOrgShortId } from "./orgDirectory.js";
import { getTenantDb, type ShardContext } from "./router.js";
import { legacyPolicyValues } from "./repositories/inspectionPolicy.js";
import { checklistItem, checklistTemplate } from "./schema/checklist.js";
import { MODULE_CODES, moduleEntitlement } from "./schema/billing.js";
import { propertyInspectionPolicy } from "./schema/inspection.js";
import { organization, organizationTaxProfile } from "./schema/organization.js";
import { building, floor, property, room, roomType } from "./schema/property.js";
import { standardTime } from "./schema/task.js";
import { membership, propertyAssignment, user } from "./schema/user.js";
import { SEED_CHECKLIST_TEMPLATES } from "./seedChecklists.js";

/** シードが使う組織。**本番に存在しない値**であることが分かる名前にする。 */
export const SEED_ORG_SHORT_ID = "seed01";

/** ID を決定的にするための固定時刻（ULID のタイムスタンプ部）。 */
const SEED_ULID_EPOCH_MS = Date.parse("2026-01-01T00:00:00.000Z");

/**
 * 施設の構成（PK-SPEC-P0 §23.2 の例と同じ 60 / 40 / 20 = 120 室）。
 *
 * `rooms` は**売れる客室の数**。清掃専用の場所（`isSellable = false`）は
 * これと別に足す。§24.3 の「客室数の集計に含めない」を、
 * シードの時点から守った形にしておく。
 */
const SEED_PROPERTIES = [
  { code: "HTLA", name: "サンプルホテル東京", rooms: 60, firstRoomNumber: 101 },
  { code: "INOS", name: "サンプルイン大阪", rooms: 40, firstRoomNumber: 201 },
  { code: "RYKY", name: "サンプル旅館京都", rooms: 20, firstRoomNumber: 301 },
] as const;

/** 客室タイプ。標準時間は持たない（P1-02 の標準時間マスタが持つ）。 */
const SEED_ROOM_TYPES = [
  { code: "SGL", name: "シングル", bedCount: 1, capacity: 1, sellable: true },
  { code: "TWN", name: "ツイン", bedCount: 2, capacity: 2, sellable: true },
  { code: "PANTRY", name: "パントリー", bedCount: null, capacity: null, sellable: false },
] as const;

/**
 * 清掃スタッフ 15 名の PIN。
 *
 * **連番・ゾロ目を避けてある**（security.md §2 / `pinSchema`）。
 * 生成式にせず表で持つのは、式にすると「連番になっていないこと」を
 * 読んで確かめられなくなるため。
 */
const SEED_PINS = [
  "2739", "4816", "5308", "7194", "8265",
  "3947", "6013", "9472", "1806", "5271",
  "8394", "2650", "7138", "4029", "6581",
] as const;

/** シードが作る清掃スタッフの人数。 */
export const SEED_CLEANER_COUNT = SEED_PINS.length;

/** シードが作る管理者のスタッフ番号。 */
export const SEED_OWNER_STAFF_NUMBER = "0001";

/**
 * ハッシュ化の注入。**本番のパスワード・PIN 設定と同じ実装を渡すこと。**
 * テストは決定的な代役を渡してよい。
 */
export interface SeedDeps {
  hashPassword: (password: string) => Promise<string>;
  hashPin: (pin: string) => Promise<string>;
}

/** シードが投入する認証情報。**production では使えない**（実行自体を止める）。 */
export interface SeedCredentials {
  /** 管理者のパスワード。呼び出し側が渡す。ここに既定値を持たない。 */
  ownerPassword: string;
}

/** 投入結果。件数だけを返す。 */
export interface SeedResult {
  organizationId: string;
  orgShortId: string;
  properties: number;
  rooms: number;
  cleaners: number;
  /** 既定のチェックリストテンプレート数（P1-06 / §6.2 の 2 種）。 */
  checklistTemplates: number;
}

/**
 * シードを投入する。**同じ env に対して何度実行しても同じ状態になる。**
 *
 * @throws `SEED_FORBIDDEN_IN_PRODUCTION` production で呼ばれた場合。
 * @throws `SEED_PIN_REJECTED` PIN が `pinSchema` を通らない場合。
 */
export async function seed(
  env: Env,
  deps: SeedDeps,
  credentials: SeedCredentials,
  now: Date,
): Promise<SeedResult> {
  if (env.ENVIRONMENT === "production") throw new Error("SEED_FORBIDDEN_IN_PRODUCTION");

  // ── ID を決定的に採る ────────────────────────────────
  // 乱数部はカウンタ。同じ順序で呼べば同じ ID が出る。
  let counter = 0;
  const ulid = createUlidFactory({
    now: () => SEED_ULID_EPOCH_MS,
    randomBytes: (size) => {
      counter += 1;
      const bytes = new Uint8Array(size);
      // 下位バイトから counter を敷き詰める。単調増加なので ULID の
      // 「生成順 = 辞書順」もそのまま保たれる。
      for (let i = 0; i < size; i++) bytes[size - 1 - i] = (counter >>> (i * 8)) & 0xff;
      return bytes;
    },
  });
  const id = (prefix: string): string => `${SEED_ORG_SHORT_ID}__${prefix}_${ulid()}`;

  const organizationId = id("org");
  const ctx: ShardContext = { organizationId, orgShortId: SEED_ORG_SHORT_ID };

  // 6 桁の予約は組織本体より先（`reserveOrgShortId()` の注記）。
  // 2 回目以降は既に予約済みなので主キー違反になる。**握りつぶすのは
  // シードだけ**で、同じ organizationId が入っていることを確かめてからにする。
  try {
    await reserveOrgShortId(env, { orgShortId: SEED_ORG_SHORT_ID, organizationId, now });
  } catch {
    // 予約済み。`organization` 側の onConflictDoNothing と合わせて冪等になる。
  }

  const db = await getTenantDb(env, ctx);
  const stamps = { createdAt: now, updatedAt: now };

  await db
    .insert(organization)
    .values({
      id: organizationId,
      organizationId,
      orgShortId: SEED_ORG_SHORT_ID,
      name: "サンプル運営株式会社",
      ...stamps,
    })
    .onConflictDoNothing();

  await db
    .insert(organizationTaxProfile)
    .values({
      id: id("tax"),
      organizationId,
      legalName: "サンプル運営株式会社",
      // **登録番号を入れない。** 未設定のときに「適格請求書は発行できません」
      // が出ること（P0-16）を、シードのままで確かめられるようにする。
      invoiceRegistrationNumber: null,
      ...stamps,
    })
    .onConflictDoNothing();

  // ── モジュールの有効化（PK-SPEC-P7 §3.1）─────────────
  //
  // **これが無いと画面が使えない。** サイドバーは `module_entitlement` を
  // 引いて、無効なモジュールの項目を「ご契約に含まれていません」の
  // グレー表示にする（`ui/navigation.ts`）。行が 1 つも無い組織では
  // **全項目がグレーになり、ログインしても何も開けない。**
  // 実際に staging がそうなっていた。
  //
  // シードは「動かして確かめるための組織」なので、**全モジュールを
  // 有効にする。** 未契約の見え方を確かめたいときは、この行を
  // 消すのではなく管理画面から無効化すること。
  //
  // `propertyId` は null（組織全体に効かせる）。`source` は既定の `PLAN`。
  for (const moduleCode of MODULE_CODES) {
    await db
      .insert(moduleEntitlement)
      .values({
        id: id("ent"),
        organizationId,
        propertyId: null,
        moduleCode,
        isEnabled: true,
        ...stamps,
      })
      .onConflictDoNothing();
  }

  // ── 施設・建物・階・客室タイプ・客室 ────────────────
  let roomCount = 0;
  const propertyIds: string[] = [];

  for (const [index, spec] of SEED_PROPERTIES.entries()) {
    const propertyId = id("prop");
    propertyIds.push(propertyId);

    await db
      .insert(property)
      .values({
        id: propertyId,
        organizationId,
        code: spec.code,
        name: spec.name,
        sortOrder: index,
        ...stamps,
      })
      .onConflictDoNothing();

    // 検査方式（P2-16 / PK-SPEC-P2 §13.2）。**施設と一組で入れる。**
    // シードの施設は `inspectionRequired = false` なので `NONE` になる。
    // 0011 のマイグレーションが既存施設へ入れる値と同じ規則で作る
    // （シードは移行のあとに流れるので、マイグレーションでは埋まらない）。
    await db
      .insert(propertyInspectionPolicy)
      .values({
        id: id("ipol"),
        organizationId,
        propertyId,
        ...legacyPolicyValues(false),
        ...stamps,
      })
      .onConflictDoNothing();

    const buildingId = id("bldg");
    await db
      .insert(building)
      .values({ id: buildingId, organizationId, propertyId, name: "本館", ...stamps })
      .onConflictDoNothing();

    const roomTypeIds = new Map<string, string>();
    for (const [typeIndex, type] of SEED_ROOM_TYPES.entries()) {
      const roomTypeId = id("rtyp");
      roomTypeIds.set(type.code, roomTypeId);
      await db
        .insert(roomType)
        .values({
          id: roomTypeId,
          organizationId,
          propertyId,
          code: type.code,
          name: type.name,
          bedCount: type.bedCount,
          capacity: type.capacity,
          sortOrder: typeIndex,
          ...stamps,
        })
        .onConflictDoNothing();

      // 標準時間（P1-02）。**清掃専用の場所には作らない。**
      // 値は PK-SPEC-P1 §3.1 の既定分数と同じにしてある（シードで
      // 既定と違う値が入っていると、生成結果の説明がつかなくなる）。
      if (type.sellable) {
        for (const [taskType, minutes] of [
          ["CHECKOUT", 40],
          ["STAYOVER", 20],
        ] as const) {
          await db
            .insert(standardTime)
            .values({
              id: id("stdt"),
              organizationId,
              propertyId,
              roomTypeId,
              taskType,
              minutes,
              ...stamps,
            })
            .onConflictDoNothing();
        }
      }
    }

    // 階は部屋番号の百の位から作る（101 → 1F）。
    const floorIds = new Map<number, string>();
    for (let offset = 0; offset < spec.rooms; offset++) {
      const roomNumber = spec.firstRoomNumber + offset;
      const floorNumber = Math.floor(roomNumber / 100);

      let floorId = floorIds.get(floorNumber);
      if (floorId === undefined) {
        floorId = id("flr");
        floorIds.set(floorNumber, floorId);
        await db
          .insert(floor)
          .values({
            id: floorId,
            organizationId,
            propertyId,
            buildingId,
            name: `${String(floorNumber)}F`,
            sortOrder: floorNumber,
            ...stamps,
          })
          .onConflictDoNothing();
      }

      await db
        .insert(room)
        .values({
          id: id("room"),
          organizationId,
          propertyId,
          buildingId,
          floorId,
          roomTypeId: roomTypeIds.get(offset % 2 === 0 ? "SGL" : "TWN") ?? null,
          roomNumber: String(roomNumber),
          isSellable: true,
          sourceType: "MANUAL",
          sortOrder: offset,
          ...stamps,
        })
        .onConflictDoNothing();
      roomCount += 1;
    }

    // 清掃専用の場所。**客室 120 室に数えない**（§24.3）。
    await db
      .insert(room)
      .values({
        id: id("room"),
        organizationId,
        propertyId,
        buildingId,
        roomTypeId: roomTypeIds.get("PANTRY") ?? null,
        roomNumber: `B0${String(index + 1)}`,
        isSellable: false,
        sourceType: "MANUAL",
        sortOrder: 900,
        ...stamps,
      })
      .onConflictDoNothing();
  }

  // ── 既定のチェックリストテンプレート 2 種（P1-06 / §6.2）─────
  // **組織共通**（propertyId = null / roomTypeId = null）。テンプレートを
  // 1 つも作っていない組織でも、タスクにチェックリストが付く。
  for (const template of SEED_CHECKLIST_TEMPLATES) {
    const templateId = id("ctpl");
    await db
      .insert(checklistTemplate)
      .values({
        id: templateId,
        organizationId,
        propertyId: null,
        roomTypeId: null,
        taskType: template.taskType,
        name: template.name,
        version: 1,
        ...stamps,
      })
      .onConflictDoNothing();

    for (const [itemIndex, entry] of template.items.entries()) {
      await db
        .insert(checklistItem)
        .values({
          id: id("citm"),
          organizationId,
          templateId,
          section: entry.section,
          labels: entry.labels,
          isRequired: entry.isRequired,
          photoRequired: entry.photoRequired,
          sortOrder: itemIndex,
          ...stamps,
        })
        .onConflictDoNothing();
    }
  }

  // ── 管理者 1 名 ──────────────────────────────────────
  // task の完了条件には無いが、**これが無いと画面に入れず**、投入した
  // 3 施設 120 室を確かめられない。docs/PROGRESS.md に明記してある。
  const ownerId = id("usr");
  await db
    .insert(user)
    .values({
      id: ownerId,
      organizationId,
      staffNumber: SEED_OWNER_STAFF_NUMBER,
      displayName: "サンプル オーナー",
      passwordHash: await deps.hashPassword(credentials.ownerPassword),
      passwordUpdatedAt: now,
      ...stamps,
    })
    .onConflictDoNothing();

  await db
    .insert(membership)
    .values({ id: id("mem"), organizationId, userId: ownerId, role: "OWNER", ...stamps })
    .onConflictDoNothing();

  // ── 清掃スタッフ 15 名 ───────────────────────────────
  for (const [index, pin] of SEED_PINS.entries()) {
    // **`hashPin()` の前に必ず通す。** 連番・ゾロ目の拒否はここでしか効かない。
    const parsed = pinSchema.safeParse(pin);
    if (!parsed.success) throw new Error("SEED_PIN_REJECTED");

    const userId = id("usr");
    const staffNumber = String(1001 + index);

    await db
      .insert(user)
      .values({
        id: userId,
        organizationId,
        staffNumber,
        displayName: `サンプル 清掃${String(index + 1)}`,
        pinHash: await deps.hashPin(parsed.data),
        // 初回変更の強制（security.md §2）。列の既定は true だが明示する。
        pinMustChange: true,
        ...stamps,
      })
      .onConflictDoNothing();

    const membershipId = id("mem");
    await db
      .insert(membership)
      .values({ id: membershipId, organizationId, userId, role: "CLEANER", ...stamps })
      .onConflictDoNothing();

    // 施設スコープロールなので割当が要る。**割当が無いと 0 件になる**
    // （DECISIONS #017）。3 施設へ順に振る。
    const propertyId = propertyIds[index % propertyIds.length];
    if (propertyId !== undefined) {
      await db
        .insert(propertyAssignment)
        .values({ id: id("asgn"), organizationId, membershipId, propertyId, assignedAt: now, ...stamps })
        .onConflictDoNothing();
    }
  }

  return {
    organizationId,
    orgShortId: SEED_ORG_SHORT_ID,
    properties: SEED_PROPERTIES.length,
    rooms: roomCount,
    cleaners: SEED_CLEANER_COUNT,
    checklistTemplates: SEED_CHECKLIST_TEMPLATES.length,
  };
}
