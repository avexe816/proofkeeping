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
  TEST_NOW,
  tenantContext,
} from "../test-support/fake-d1.js";

import * as auditRepo from "./audit.js";
import * as baselineRepo from "./baseline.js";
import * as checklistRepo from "./checklist.js";
import * as cleaningTaskRepo from "./cleaningTask.js";
import * as dailyReportRepo from "./dailyReport.js";
import * as dailyRouteRepo from "./dailyRoute.js";
import * as entitlementRepo from "./entitlement.js";
import * as evidenceRepo from "./evidence.js";
import * as inspectionRepo from "./inspection.js";
import * as inspectionPolicyRepo from "./inspectionPolicy.js";
import * as issueReportRepo from "./issueReport.js";
import * as lostItemRepo from "./lostItem.js";
import * as observationRepo from "./observation.js";
import * as occupancyRepo from "./occupancy.js";
import * as organizationRepo from "./organization.js";
import * as propertyRepo from "./property.js";
import * as rollupRepo from "./rollup.js";
import * as roomRepo from "./room.js";
import * as roomPlanRepo from "./roomPlan.js";
import * as standardTimeRepo from "./standardTime.js";
import * as taskPhotoRepo from "./taskPhoto.js";
import * as userRepo from "./user.js";

/** 検証対象のリポジトリモジュール。**新しいファイルを足したらここに追加する。** */
const REPOSITORY_MODULES: Record<string, Record<string, unknown>> = {
  audit: auditRepo,
  // P4-02 が登録した稼働記録（PK-SPEC-P4 §2.1）。
  // **取込元（`source`）ごとに別の行**（DECISIONS #106）。
  occupancy: occupancyRepo,
  baseline: baselineRepo,
  checklist: checklistRepo,
  cleaningTask: cleaningTaskRepo,
  // P1-21 が登録した 2 モジュール。`taskPhoto` は P1-11 / P1-15 が足した
  // 関数がここに載っておらず、組織条件の自動検査を受けていなかった
  // （P1-14〜P1-18 の申し送り 1）。
  dailyRoute: dailyRouteRepo,
  taskPhoto: taskPhotoRepo,
  // P2-14 が登録した日報（PK-SPEC-P2 §9.4）。
  // **INSERT と SELECT だけ**であることも下で検査する（発行済み帳票）。
  dailyReport: dailyReportRepo,
  entitlement: entitlementRepo,
  // P2-08 が登録した証跡。**INSERT と SELECT だけ**であることも下で検査する。
  evidence: evidenceRepo,
  // P2-02 が登録した検査方式。P2-04 が検査そのもの。
  inspection: inspectionRepo,
  inspectionPolicy: inspectionPolicyRepo,
  // P2-11 / P2-12 が登録した忘れ物と設備不具合（PK-SPEC-P2 §3.5・§3.6）。
  issueReport: issueReportRepo,
  lostItem: lostItemRepo,
  // P3-03〜P3-07 / P3-11 が登録した観察記録（PK-SPEC-P3 §2）。
  // **DELETE が無い**ことも下で検査する（P4 の照合の土台）。
  observation: observationRepo,
  organization: organizationRepo,
  property: propertyRepo,
  rollup: rollupRepo,
  room: roomRepo,
  roomPlan: roomPlanRepo,
  standardTime: standardTimeRepo,
  user: userRepo,
};

/** 自組織の ID。`assertIdBelongsToTenant()` を通る形式。 */
const OWN_ID = {
  user: generateId(TEST_ORG.orgShortId, "usr"),
  membership: generateId(TEST_ORG.orgShortId, "mem"),
  property: generateId(TEST_ORG.orgShortId, "prop"),
  room: generateId(TEST_ORG.orgShortId, "room"),
  roomType: generateId(TEST_ORG.orgShortId, "rtyp"),
  task: generateId(TEST_ORG.orgShortId, "task"),
  template: generateId(TEST_ORG.orgShortId, "ctpl"),
  item: generateId(TEST_ORG.orgShortId, "citm"),
  photo: generateId(TEST_ORG.orgShortId, "photo"),
  // P2-04。
  inspection: generateId(TEST_ORG.orgShortId, "insp"),
  itemResult: generateId(TEST_ORG.orgShortId, "ires"),
  inspectionPhoto: generateId(TEST_ORG.orgShortId, "ipho"),
  // P2-07 / P2-08。
  reworkCycle: generateId(TEST_ORG.orgShortId, "rwk"),
  snapshot: generateId(TEST_ORG.orgShortId, "evd"),
  // P2-11 / P2-12。
  lostItem: generateId(TEST_ORG.orgShortId, "lost"),
  issue: generateId(TEST_ORG.orgShortId, "issue"),
  // P2-14。
  dailyReport: generateId(TEST_ORG.orgShortId, "rpt"),
  // P3-03〜P3-07 / P3-11。
  observation: generateId(TEST_ORG.orgShortId, "obs"),
  // P3-09 / P3-10。
  baseline: generateId(TEST_ORG.orgShortId, "bsln"),
  // P4-02。
  occupancy: generateId(TEST_ORG.orgShortId, "occ"),
} as const;

/** ハッシュの中身は問わない検証で使う値。実在のパスワードから作ったものではない。 */
const FAKE_HASH = "pbkdf2$sha256$210000$c2FsdA$aGFzaA";

/** 日報 1 行ぶんの値（P2-14 / PK-SPEC-P2 §9.4）。**集計値の中身は問わない。** */
const DAILY_REPORT = {
  propertyId: "",
  businessDate: "2026-09-10",
  documentNo: "RPT-2026-0042",
  revision: 1,
  storageKey: "documents/org/prop/daily-reports/2026/09/RPT-2026-0042-r1.pdf",
  payloadSha256: "a".repeat(64),
  pdfSha256: "b".repeat(64),
  totalTasks: 0,
  completedTasks: 0,
  failedFirstInspection: 0,
  openIssues: 0,
  openLostItems: 0,
  generatedById: null,
  supersedesId: null,
} as const;

/** 検査方式の設定値（P2-02 / PK-SPEC-P2 §2.1）。 */
const INSPECTION_POLICY = {
  mode: "SAMPLE",
  sampleRate: 30,
  minDailySample: 3,
  alwaysInspectCheckin: true,
  alwaysInspectRework: true,
  selfInspectionAllowed: false,
  autoAssignInspector: true,
  inspectionSlaMinutes: 20,
} as const;

/** 別組織の ID。越境の検証に使う。 */
const OTHER_ID = {
  user: generateId(OTHER_ORG.orgShortId, "usr"),
  membership: generateId(OTHER_ORG.orgShortId, "mem"),
  property: generateId(OTHER_ORG.orgShortId, "prop"),
  room: generateId(OTHER_ORG.orgShortId, "room"),
  roomType: generateId(OTHER_ORG.orgShortId, "rtyp"),
  task: generateId(OTHER_ORG.orgShortId, "task"),
  template: generateId(OTHER_ORG.orgShortId, "ctpl"),
  item: generateId(OTHER_ORG.orgShortId, "citm"),
  photo: generateId(OTHER_ORG.orgShortId, "photo"),
  // P2-04。
  inspection: generateId(OTHER_ORG.orgShortId, "insp"),
  itemResult: generateId(OTHER_ORG.orgShortId, "ires"),
  inspectionPhoto: generateId(OTHER_ORG.orgShortId, "ipho"),
  // P2-07 / P2-08。
  reworkCycle: generateId(OTHER_ORG.orgShortId, "rwk"),
  snapshot: generateId(OTHER_ORG.orgShortId, "evd"),
  // P2-11 / P2-12。
  lostItem: generateId(OTHER_ORG.orgShortId, "lost"),
  issue: generateId(OTHER_ORG.orgShortId, "issue"),
  // P2-14。
  dailyReport: generateId(OTHER_ORG.orgShortId, "rpt"),
  // P3-03〜P3-07 / P3-11。
  observation: generateId(OTHER_ORG.orgShortId, "obs"),
  // P3-09 / P3-10。
  baseline: generateId(OTHER_ORG.orgShortId, "bsln"),
  // P4-02。
  occupancy: generateId(OTHER_ORG.orgShortId, "occ"),
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
  /**
   * SQL を発行しない関数（ID の採番など）。**組織条件の検査から外す。**
   *
   * 外すのは検査であって登録ではない。**登録の網羅からは外さない**ので、
   * リポジトリに増えた関数がここを黙って素通りすることはない。
   * `true` を付けるのは「DB へ行かないことがその関数の仕様」のときだけ。
   */
  pure?: boolean;
}

/** 観察記録の数（P3 / §2.1）。**中身は問わない検証で使う。** */
const COUNTS = {
  bedsUsed: 2,
  trashLevel: "NORMAL",
  bathTowelUsed: 2,
  faceTowelUsed: 2,
  handTowelUsed: 2,
  bathMatUsed: 1,
  slippersUsed: 2,
  cupsUsed: 2,
  extraFutonUsed: 0,
  amenitiesUsed: {},
} as const;

/** `upsertObservation()` の入力（自組織・別組織で ID だけ差し替える）。 */
function OBSERVATION_INPUT(id: typeof OWN_ID | typeof OTHER_ID) {
  return {
    taskId: id.task,
    propertyId: id.property,
    roomId: id.room,
    roomTypeId: id.roomType,
    businessDate: "2026-09-10",
    ...COUNTS,
    note: null,
    inputDurationMs: 12_400,
    usedDefaults: true,
    recordedById: OWN_ID.membership,
    clientTs: null,
    idempotencyKey: null,
  };
}

/** `upsertLinenRecords()` の入力。 */
function LINEN_INPUT(id: typeof OWN_ID | typeof OTHER_ID) {
  return {
    taskId: id.task,
    propertyId: id.property,
    roomId: id.room,
    businessDate: "2026-09-10",
    recordedById: OWN_ID.membership,
    entries: [
      {
        itemCode: "BATH_TOWEL",
        collectedQty: 2,
        suppliedQty: 0,
        damagedQty: 0,
        stainedQty: 0,
        note: null,
      },
    ],
  } as const;
}

/** `upsertObservationConfig()` の入力。 */
function CONFIG_INPUT(id: typeof OWN_ID | typeof OTHER_ID) {
  return {
    propertyId: id.property,
    enabled: true,
    requireBeds: true,
    requireTrash: true,
    requireTowels: true,
    requireAmenities: false,
    requireLinen: false,
    enabledItemCodes: ["BATH_TOWEL"],
    skipWarnThreshold: 20,
  } as const;
}

/**
 * 全リポジトリ関数の呼び出し表。
 *
 * **関数を追加したらここに 1 行足すこと。** 足し忘れは
 * 「全 export が登録されている」テストが検出する。
 */
/** ベースライン置き換えの入力（P3-09 / PK-SPEC-P3 §5.2）。 */
const BASELINE_REPLACE = (id: typeof OWN_ID | typeof OTHER_ID) =>
  ({
    propertyId: id.property,
    computedFrom: "2026-06-15",
    computedTo: "2026-09-12",
    rows: [
      {
        roomTypeId: id.roomType,
        guestCount: 2,
        taskType: "CHECKOUT",
        itemCode: "BATH_TOWEL",
        sampleSize: 142,
        medianQty: 2,
        p10Qty: 2,
        p90Qty: 3,
        maxQty: 5,
        stdDev: 0.4,
        isReliable: true,
      },
    ],
  }) as const;

/** 除外記録置き換えの入力（同 §5.3）。 */
const BASELINE_EXCLUSIONS = (id: typeof OWN_ID | typeof OTHER_ID) =>
  ({
    propertyId: id.property,
    computedTo: "2026-09-12",
    rows: [
      {
        observationId: id.observation,
        businessDate: "2026-09-10",
        roomTypeId: id.roomType,
        guestCount: 2,
        taskType: "CHECKOUT",
        itemCode: "BATH_TOWEL",
        reason: "OVER_MEDIAN_5X",
        qty: 20,
      },
    ],
  }) as const;

/** 稼働記録の取込先（P4-02 / PK-SPEC-P4 §8.1）。 */
const OCCUPANCY_PARAMS = (id: typeof OWN_ID | typeof OTHER_ID) =>
  ({
    propertyId: id.property,
    businessDate: "2026-09-09",
    source: "CSV_IMPORT",
    importedById: id.membership,
  }) as const;

/** 稼働記録 1 室ぶん。**宿泊者の欄が 1 つも無い**（同 §2.1 MUST）。 */
const OCCUPANCY_ENTRY = (id: typeof OWN_ID | typeof OTHER_ID) =>
  ({
    roomId: id.room,
    isOccupied: true,
    guestCount: 2,
    adultCount: 0,
    childCount: 0,
    reservationRef: "RSV-8891",
    channelCode: null,
    checkInAt: null,
    checkOutAt: null,
    isStayover: false,
    nightsTotal: null,
    nightIndex: null,
    ratePlanCode: null,
    isComplimentary: false,
    isHouseUse: false,
    rawPayload: null,
  }) as const;

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
    // P1-22。施設選択画面の閾値（§19.4）。**組織条件が載ること**を見る。
    name: "organization.updateOrganizationSettings",
    kind: "tenant",
    run: (env, ctx) =>
      organizationRepo.updateOrganizationSettings(env, ctx, { propertySelectionThreshold: 4 }),
  },
  {
    name: "organization.updateTaxProfile",
    kind: "tenant",
    run: (env, ctx) =>
      organizationRepo.updateTaxProfile(env, ctx, {
        legalName: "サンプル運営株式会社",
        invoiceRegistrationNumber: null,
        defaultTaxRoundingMode: "ROUND",
        fiscalYearStartMonth: 4,
      }),
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
    name: "property.listRoomTypes",
    kind: "tenant",
    run: (env, ctx) => propertyRepo.listRoomTypes(env, ctx, OWN_ID.property),
    crossTenant: (env, ctx) => propertyRepo.listRoomTypes(env, ctx, OTHER_ID.property),
  },
  // ── P1-24: 客室タイプに書く経路 ────────────────────────
  {
    name: "property.findRoomTypeById",
    kind: "tenant",
    run: (env, ctx) => propertyRepo.findRoomTypeById(env, ctx, OWN_ID.roomType),
    crossTenant: (env, ctx) => propertyRepo.findRoomTypeById(env, ctx, OTHER_ID.roomType),
  },
  {
    name: "property.createRoomType",
    kind: "tenant",
    run: (env, ctx) =>
      propertyRepo.createRoomType(env, ctx, {
        propertyId: OWN_ID.property,
        code: "TWN",
        name: "ツイン",
      }),
    crossTenant: (env, ctx) =>
      propertyRepo.createRoomType(env, ctx, {
        propertyId: OTHER_ID.property,
        code: "TWN",
        name: "ツイン",
      }),
  },
  {
    name: "property.updateRoomType",
    kind: "tenant",
    run: (env, ctx) => propertyRepo.updateRoomType(env, ctx, OWN_ID.roomType, { name: "ツイン" }),
    crossTenant: (env, ctx) =>
      propertyRepo.updateRoomType(env, ctx, OTHER_ID.roomType, { name: "ツイン" }),
  },
  {
    name: "room.countRoomsByRoomType",
    kind: "tenant",
    run: (env, ctx) => roomRepo.countRoomsByRoomType(env, ctx, OWN_ID.property),
    crossTenant: (env, ctx) => roomRepo.countRoomsByRoomType(env, ctx, OTHER_ID.property),
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
    name: "room.countSellableRoomsByProperty",
    kind: "tenant",
    run: (env, ctx) => roomRepo.countSellableRoomsByProperty(env, ctx),
  },
  {
    name: "room.createRooms",
    kind: "tenant",
    run: (env, ctx) =>
      roomRepo.createRooms(env, ctx, [{ propertyId: OWN_ID.property, roomNumber: "301" }]),
  },
  {
    name: "room.updateRoom",
    kind: "tenant",
    run: (env, ctx) => roomRepo.updateRoom(env, ctx, OWN_ID.room, { note: "メモ" }),
    crossTenant: (env, ctx) => roomRepo.updateRoom(env, ctx, OTHER_ID.room, { note: "メモ" }),
  },
  {
    name: "room.listFloors",
    kind: "tenant",
    run: (env, ctx) => roomRepo.listFloors(env, ctx, OWN_ID.property),
    crossTenant: (env, ctx) => roomRepo.listFloors(env, ctx, OTHER_ID.property),
  },
  {
    name: "room.setHousekeepingStatus",
    kind: "tenant",
    run: (env, ctx) => roomRepo.setHousekeepingStatus(env, ctx, [OWN_ID.room], "READY"),
    crossTenant: (env, ctx) => roomRepo.setHousekeepingStatus(env, ctx, [OTHER_ID.room], "READY"),
  },
  {
    name: "room.setRoomSaleStatus",
    kind: "tenant",
    run: (env, ctx) => roomRepo.setRoomSaleStatus(env, ctx, [OWN_ID.room], "OUT_OF_ORDER"),
    crossTenant: (env, ctx) =>
      roomRepo.setRoomSaleStatus(env, ctx, [OTHER_ID.room], "OUT_OF_ORDER"),
  },
  // ── P2-11 忘れ物（PK-SPEC-P2 §3.5 / §7）──────────────
  {
    name: "lostItem.listLostItems",
    kind: "tenant",
    run: (env, ctx) => lostItemRepo.listLostItems(env, ctx, { propertyId: OWN_ID.property }),
  },
  {
    name: "lostItem.findLostItemById",
    kind: "tenant",
    run: (env, ctx) => lostItemRepo.findLostItemById(env, ctx, OWN_ID.lostItem),
    crossTenant: (env, ctx) => lostItemRepo.findLostItemById(env, ctx, OTHER_ID.lostItem),
  },
  {
    name: "lostItem.maxLostItemSequence",
    kind: "tenant",
    run: (env, ctx) =>
      lostItemRepo.maxLostItemSequence(env, ctx, OWN_ID.property, "2026-09-10"),
    crossTenant: (env, ctx) =>
      lostItemRepo.maxLostItemSequence(env, ctx, OTHER_ID.property, "2026-09-10"),
  },
  {
    name: "lostItem.createLostItem",
    kind: "tenant",
    run: (env, ctx) =>
      lostItemRepo.createLostItem(env, ctx, {
        propertyId: OWN_ID.property,
        taskId: OWN_ID.task,
        roomId: OWN_ID.room,
        businessDate: "2026-09-10",
        managementNo: "LNF-HTLA-20260910-0001",
        category: "OTHER",
        description: "黒い折りたたみ傘",
        foundAt: TEST_NOW,
        foundById: OWN_ID.membership,
        foundLocation: "ベッド下",
        retentionDueAt: TEST_NOW,
      }),
    crossTenant: (env, ctx) =>
      lostItemRepo.createLostItem(env, ctx, {
        propertyId: OTHER_ID.property,
        taskId: null,
        roomId: OTHER_ID.room,
        businessDate: "2026-09-10",
        managementNo: "LNF-HTLB-20260910-0001",
        category: "OTHER",
        description: "黒い折りたたみ傘",
        foundAt: TEST_NOW,
        foundById: OWN_ID.membership,
        foundLocation: "ベッド下",
        retentionDueAt: null,
      }),
  },
  {
    name: "lostItem.advanceLostItem",
    kind: "tenant",
    run: (env, ctx) =>
      lostItemRepo.advanceLostItem(env, ctx, {
        lostItemId: OWN_ID.lostItem,
        from: "FOUND",
        to: "STORED",
        actorId: OWN_ID.membership,
        note: null,
        storageLocation: "事務所ロッカー A",
      }),
    crossTenant: (env, ctx) =>
      lostItemRepo.advanceLostItem(env, ctx, {
        lostItemId: OTHER_ID.lostItem,
        from: "FOUND",
        to: "STORED",
        actorId: OWN_ID.membership,
        note: null,
      }),
  },
  {
    name: "lostItem.markOwnerContacted",
    kind: "tenant",
    run: (env, ctx) => lostItemRepo.markOwnerContacted(env, ctx, OWN_ID.lostItem),
    crossTenant: (env, ctx) => lostItemRepo.markOwnerContacted(env, ctx, OTHER_ID.lostItem),
  },
  {
    name: "lostItem.listLostItemHistory",
    kind: "tenant",
    run: (env, ctx) => lostItemRepo.listLostItemHistory(env, ctx, OWN_ID.lostItem),
    crossTenant: (env, ctx) => lostItemRepo.listLostItemHistory(env, ctx, OTHER_ID.lostItem),
  },
  {
    name: "lostItem.listLostItemPhotos",
    kind: "tenant",
    run: (env, ctx) => lostItemRepo.listLostItemPhotos(env, ctx, OWN_ID.lostItem),
    crossTenant: (env, ctx) => lostItemRepo.listLostItemPhotos(env, ctx, OTHER_ID.lostItem),
  },
  {
    name: "lostItem.countLostItemPhotos",
    kind: "tenant",
    run: (env, ctx) => lostItemRepo.countLostItemPhotos(env, ctx, OWN_ID.lostItem),
    crossTenant: (env, ctx) => lostItemRepo.countLostItemPhotos(env, ctx, OTHER_ID.lostItem),
  },
  {
    name: "lostItem.createLostItemPhoto",
    kind: "tenant",
    run: (env, ctx) =>
      lostItemRepo.createLostItemPhoto(env, ctx, {
        lostItemId: OWN_ID.lostItem,
        propertyId: OWN_ID.property,
        storageKey: "photos/org/prop/2026-09-10/lost/a.jpg",
        sha256: "a".repeat(64),
        uploadedById: OWN_ID.membership,
      }),
    crossTenant: (env, ctx) =>
      lostItemRepo.createLostItemPhoto(env, ctx, {
        lostItemId: OTHER_ID.lostItem,
        propertyId: OWN_ID.property,
        storageKey: "photos/org/prop/2026-09-10/lost/a.jpg",
        sha256: "a".repeat(64),
        uploadedById: OWN_ID.membership,
      }),
  },
  // ── P2-12 設備不具合（同 §3.6 / §8）──────────────────
  {
    name: "issueReport.listIssueReports",
    kind: "tenant",
    run: (env, ctx) => issueReportRepo.listIssueReports(env, ctx, { propertyId: OWN_ID.property }),
  },
  {
    name: "issueReport.findIssueReportById",
    kind: "tenant",
    run: (env, ctx) => issueReportRepo.findIssueReportById(env, ctx, OWN_ID.issue),
    crossTenant: (env, ctx) => issueReportRepo.findIssueReportById(env, ctx, OTHER_ID.issue),
  },
  {
    name: "issueReport.createIssueReport",
    kind: "tenant",
    run: (env, ctx) =>
      issueReportRepo.createIssueReport(env, ctx, {
        propertyId: OWN_ID.property,
        taskId: OWN_ID.task,
        roomId: OWN_ID.room,
        category: "PLUMBING",
        severity: "HIGH",
        title: "洗面台の水が止まらない",
        description: "止水栓を締めても滴りが続く",
        reportedById: OWN_ID.membership,
        roomBlocked: false,
      }),
    crossTenant: (env, ctx) =>
      issueReportRepo.createIssueReport(env, ctx, {
        propertyId: OTHER_ID.property,
        taskId: null,
        roomId: OTHER_ID.room,
        category: "PLUMBING",
        severity: "HIGH",
        title: "洗面台の水が止まらない",
        description: "止水栓を締めても滴りが続く",
        reportedById: OWN_ID.membership,
        roomBlocked: false,
      }),
  },
  {
    name: "issueReport.advanceIssueReport",
    kind: "tenant",
    run: (env, ctx) =>
      issueReportRepo.advanceIssueReport(env, ctx, {
        issueId: OWN_ID.issue,
        from: "OPEN",
        to: "ACKNOWLEDGED",
        actorId: OWN_ID.membership,
        note: null,
      }),
    crossTenant: (env, ctx) =>
      issueReportRepo.advanceIssueReport(env, ctx, {
        issueId: OTHER_ID.issue,
        from: "OPEN",
        to: "ACKNOWLEDGED",
        actorId: OWN_ID.membership,
        note: null,
      }),
  },
  {
    name: "issueReport.listIssueHistory",
    kind: "tenant",
    run: (env, ctx) => issueReportRepo.listIssueHistory(env, ctx, OWN_ID.issue),
    crossTenant: (env, ctx) => issueReportRepo.listIssueHistory(env, ctx, OTHER_ID.issue),
  },
  {
    name: "issueReport.listIssuePhotos",
    kind: "tenant",
    run: (env, ctx) => issueReportRepo.listIssuePhotos(env, ctx, OWN_ID.issue),
    crossTenant: (env, ctx) => issueReportRepo.listIssuePhotos(env, ctx, OTHER_ID.issue),
  },
  {
    name: "issueReport.createIssuePhoto",
    kind: "tenant",
    run: (env, ctx) =>
      issueReportRepo.createIssuePhoto(env, ctx, {
        issueId: OWN_ID.issue,
        propertyId: OWN_ID.property,
        storageKey: "photos/org/prop/2026-09-10/issue/a.jpg",
        sha256: "a".repeat(64),
        uploadedById: OWN_ID.membership,
      }),
    crossTenant: (env, ctx) =>
      issueReportRepo.createIssuePhoto(env, ctx, {
        issueId: OTHER_ID.issue,
        propertyId: OWN_ID.property,
        storageKey: "photos/org/prop/2026-09-10/issue/a.jpg",
        sha256: "a".repeat(64),
        uploadedById: OWN_ID.membership,
      }),
  },
  {
    name: "rollup.listPropertyRollups",
    kind: "tenant",
    run: (env, ctx) => rollupRepo.listPropertyRollups(env, ctx, "2026-08-12"),
  },
  {
    name: "rollup.findPropertyRollup",
    kind: "tenant",
    run: (env, ctx) => rollupRepo.findPropertyRollup(env, ctx, OWN_ID.property, "2026-08-12"),
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
  {
    name: "user.listPropertyStaff",
    kind: "tenant",
    run: (env, ctx) => userRepo.listPropertyStaff(env, ctx, OWN_ID.property),
    crossTenant: (env, ctx) => userRepo.listPropertyStaff(env, ctx, OTHER_ID.property),
  },
  {
    name: "user.setUserLocale",
    kind: "tenant",
    run: (env, ctx) => userRepo.setUserLocale(env, ctx, OWN_ID.user, "en"),
    crossTenant: (env, ctx) => userRepo.setUserLocale(env, ctx, OTHER_ID.user, "en"),
  },
  {
    // P2-02: 新人スタッフ判定の材料。**在籍日数を画面に出す関数ではない。**
    name: "user.findMembershipStartedAt",
    kind: "tenant",
    run: (env, ctx) => userRepo.findMembershipStartedAt(env, ctx, OWN_ID.membership),
    crossTenant: (env, ctx) => userRepo.findMembershipStartedAt(env, ctx, OTHER_ID.membership),
  },

  // ── P2-02: 施設ごとの検査方式 ──────────────────────────
  {
    // P2-16: P1 の真偽値 1 つから検査方式を作る。**DB へ行かない。**
    name: "inspectionPolicy.legacyPolicyValues",
    kind: "tenant",
    pure: true,
    run: () => Promise.resolve(inspectionPolicyRepo.legacyPolicyValues(true)),
  },
  {
    name: "inspectionPolicy.findInspectionPolicy",
    kind: "tenant",
    run: (env, ctx) => inspectionPolicyRepo.findInspectionPolicy(env, ctx, OWN_ID.property),
    crossTenant: (env, ctx) =>
      inspectionPolicyRepo.findInspectionPolicy(env, ctx, OTHER_ID.property),
  },
  {
    name: "inspectionPolicy.listInspectionPolicies",
    kind: "tenant",
    run: (env, ctx) => inspectionPolicyRepo.listInspectionPolicies(env, ctx),
  },
  {
    name: "inspectionPolicy.upsertInspectionPolicy",
    kind: "tenant",
    run: (env, ctx) =>
      inspectionPolicyRepo.upsertInspectionPolicy(env, ctx, OWN_ID.property, INSPECTION_POLICY),
    crossTenant: (env, ctx) =>
      inspectionPolicyRepo.upsertInspectionPolicy(env, ctx, OTHER_ID.property, INSPECTION_POLICY),
  },

  // ── P2-04: 検査・検査項目・検査写真・差戻し ────────────
  {
    name: "inspection.findInspectionById",
    kind: "tenant",
    run: (env, ctx) => inspectionRepo.findInspectionById(env, ctx, OWN_ID.inspection),
    crossTenant: (env, ctx) => inspectionRepo.findInspectionById(env, ctx, OTHER_ID.inspection),
  },
  {
    name: "inspection.findOpenInspectionByTask",
    kind: "tenant",
    run: (env, ctx) => inspectionRepo.findOpenInspectionByTask(env, ctx, OWN_ID.task),
    crossTenant: (env, ctx) => inspectionRepo.findOpenInspectionByTask(env, ctx, OTHER_ID.task),
  },
  {
    name: "inspection.listInspectionsByTask",
    kind: "tenant",
    run: (env, ctx) => inspectionRepo.listInspectionsByTask(env, ctx, OWN_ID.task),
    crossTenant: (env, ctx) => inspectionRepo.listInspectionsByTask(env, ctx, OTHER_ID.task),
  },
  // 日報（P2-14）が 100 室ぶんをまとめて引く。**ID の並びを受け取るので
  // `crossTenant` を書けない**（越境 ID は第 2 層ではなく組織条件が落とす）。
  {
    name: "inspection.listInspectionsByTaskIds",
    kind: "tenant",
    run: (env, ctx) => inspectionRepo.listInspectionsByTaskIds(env, ctx, [OWN_ID.task]),
  },
  {
    name: "inspection.findInspectionByIdempotencyKey",
    kind: "tenant",
    run: (env, ctx) => inspectionRepo.findInspectionByIdempotencyKey(env, ctx, "key-1"),
  },
  {
    name: "inspection.createInspection",
    kind: "tenant",
    run: (env, ctx) =>
      inspectionRepo.createInspection(env, ctx, {
        taskId: OWN_ID.task,
        propertyId: OWN_ID.property,
        round: 1,
        inspectorId: OWN_ID.membership,
      }),
    crossTenant: (env, ctx) =>
      inspectionRepo.createInspection(env, ctx, {
        taskId: OTHER_ID.task,
        propertyId: OTHER_ID.property,
        round: 1,
        inspectorId: OWN_ID.membership,
      }),
  },
  {
    name: "inspection.completeInspection",
    kind: "tenant",
    run: (env, ctx) =>
      inspectionRepo.completeInspection(env, ctx, OWN_ID.inspection, {
        result: "PASS",
        durationSeconds: 90,
      }),
    crossTenant: (env, ctx) =>
      inspectionRepo.completeInspection(env, ctx, OTHER_ID.inspection, {
        result: "PASS",
        durationSeconds: 90,
      }),
  },
  {
    name: "inspection.listInspectionItemResults",
    kind: "tenant",
    run: (env, ctx) => inspectionRepo.listInspectionItemResults(env, ctx, OWN_ID.inspection),
    crossTenant: (env, ctx) =>
      inspectionRepo.listInspectionItemResults(env, ctx, OTHER_ID.inspection),
  },
  {
    name: "inspection.findInspectionItemResultById",
    kind: "tenant",
    run: (env, ctx) => inspectionRepo.findInspectionItemResultById(env, ctx, OWN_ID.itemResult),
    crossTenant: (env, ctx) =>
      inspectionRepo.findInspectionItemResultById(env, ctx, OTHER_ID.itemResult),
  },
  {
    name: "inspection.recordInspectionItemResult",
    kind: "tenant",
    run: (env, ctx) =>
      inspectionRepo.recordInspectionItemResult(env, ctx, {
        inspectionId: OWN_ID.inspection,
        propertyId: OWN_ID.property,
        checklistItemId: OWN_ID.item,
        status: "PASS",
      }),
    crossTenant: (env, ctx) =>
      inspectionRepo.recordInspectionItemResult(env, ctx, {
        inspectionId: OTHER_ID.inspection,
        propertyId: OTHER_ID.property,
        checklistItemId: OTHER_ID.item,
        status: "PASS",
      }),
  },
  {
    name: "inspection.countInspectionPhotosByItem",
    kind: "tenant",
    run: (env, ctx) => inspectionRepo.countInspectionPhotosByItem(env, ctx, OWN_ID.inspection),
    crossTenant: (env, ctx) =>
      inspectionRepo.countInspectionPhotosByItem(env, ctx, OTHER_ID.inspection),
  },
  {
    name: "inspection.findInspectionPhotoByClientId",
    kind: "tenant",
    run: (env, ctx) => inspectionRepo.findInspectionPhotoByClientId(env, ctx, "client-1"),
  },
  {
    name: "inspection.listInspectionPhotos",
    kind: "tenant",
    run: (env, ctx) => inspectionRepo.listInspectionPhotos(env, ctx, OWN_ID.inspection),
    crossTenant: (env, ctx) => inspectionRepo.listInspectionPhotos(env, ctx, OTHER_ID.inspection),
  },
  {
    name: "inspection.createInspectionPhoto",
    kind: "tenant",
    run: (env, ctx) =>
      inspectionRepo.createInspectionPhoto(env, ctx, {
        inspectionId: OWN_ID.inspection,
        itemResultId: OWN_ID.itemResult,
        propertyId: OWN_ID.property,
        storageKey: "photos/x/y.jpg",
        photoId: OWN_ID.inspectionPhoto,
        sha256: "0".repeat(64),
        width: 1600,
        height: 1200,
        fileSize: 12345,
        clientId: "client-1",
        uploadedById: OWN_ID.membership,
      }),
    crossTenant: (env, ctx) =>
      inspectionRepo.createInspectionPhoto(env, ctx, {
        inspectionId: OTHER_ID.inspection,
        itemResultId: OTHER_ID.itemResult,
        propertyId: OTHER_ID.property,
        storageKey: "photos/x/y.jpg",
        photoId: OTHER_ID.inspectionPhoto,
        sha256: "0".repeat(64),
        width: 1600,
        height: 1200,
        fileSize: 12345,
        clientId: "client-1",
        uploadedById: OWN_ID.membership,
      }),
  },
  {
    // ID を採番するだけ。**SQL を発行しない。**
    name: "inspection.newInspectionPhotoId",
    kind: "tenant",
    pure: true,
    run: (_env, ctx) => Promise.resolve(inspectionRepo.newInspectionPhotoId(ctx)),
  },
  {
    name: "inspection.createReworkCycle",
    kind: "tenant",
    run: (env, ctx) =>
      inspectionRepo.createReworkCycle(env, ctx, {
        taskId: OWN_ID.task,
        propertyId: OWN_ID.property,
        inspectionId: OWN_ID.inspection,
        round: 1,
        assignedToId: OWN_ID.membership,
        reasonSummary: "DUST",
      }),
    crossTenant: (env, ctx) =>
      inspectionRepo.createReworkCycle(env, ctx, {
        taskId: OTHER_ID.task,
        propertyId: OTHER_ID.property,
        inspectionId: OTHER_ID.inspection,
        round: 1,
        assignedToId: OWN_ID.membership,
        reasonSummary: "DUST",
      }),
  },
  {
    name: "inspection.listReworkCyclesByTask",
    kind: "tenant",
    run: (env, ctx) => inspectionRepo.listReworkCyclesByTask(env, ctx, OWN_ID.task),
    crossTenant: (env, ctx) => inspectionRepo.listReworkCyclesByTask(env, ctx, OTHER_ID.task),
  },
  {
    name: "inspection.listReworkCyclesByTaskIds",
    kind: "tenant",
    run: (env, ctx) => inspectionRepo.listReworkCyclesByTaskIds(env, ctx, [OWN_ID.task]),
  },

  // ── P2-14: 日報 ────────────────────────────────────────
  {
    name: "dailyReport.createDailyReport",
    kind: "tenant",
    run: (env, ctx) =>
      dailyReportRepo.createDailyReport(env, ctx, { ...DAILY_REPORT, propertyId: OWN_ID.property }),
    crossTenant: (env, ctx) =>
      dailyReportRepo.createDailyReport(env, ctx, {
        ...DAILY_REPORT,
        propertyId: OTHER_ID.property,
      }),
  },
  {
    name: "dailyReport.findDailyReportById",
    kind: "tenant",
    run: (env, ctx) => dailyReportRepo.findDailyReportById(env, ctx, OWN_ID.dailyReport),
    crossTenant: (env, ctx) => dailyReportRepo.findDailyReportById(env, ctx, OTHER_ID.dailyReport),
  },
  {
    name: "dailyReport.findLatestDailyReport",
    kind: "tenant",
    run: (env, ctx) =>
      dailyReportRepo.findLatestDailyReport(env, ctx, OWN_ID.property, "2026-09-10"),
    crossTenant: (env, ctx) =>
      dailyReportRepo.findLatestDailyReport(env, ctx, OTHER_ID.property, "2026-09-10"),
  },
  {
    name: "dailyReport.listDailyReports",
    kind: "tenant",
    run: (env, ctx) => dailyReportRepo.listDailyReports(env, ctx, { propertyId: OWN_ID.property }),
  },

  // ── P2-07: 差戻しの進行 ────────────────────────────────
  {
    name: "inspection.findReworkCycleById",
    kind: "tenant",
    run: (env, ctx) => inspectionRepo.findReworkCycleById(env, ctx, OWN_ID.reworkCycle),
    crossTenant: (env, ctx) =>
      inspectionRepo.findReworkCycleById(env, ctx, OTHER_ID.reworkCycle),
  },
  {
    name: "inspection.findOpenReworkCycleByTask",
    kind: "tenant",
    run: (env, ctx) => inspectionRepo.findOpenReworkCycleByTask(env, ctx, OWN_ID.task),
    crossTenant: (env, ctx) => inspectionRepo.findOpenReworkCycleByTask(env, ctx, OTHER_ID.task),
  },
  {
    name: "inspection.advanceReworkCycle",
    kind: "tenant",
    run: (env, ctx) =>
      inspectionRepo.advanceReworkCycle(env, ctx, OWN_ID.reworkCycle, {
        from: "OPEN",
        to: "IN_PROGRESS",
        startedAt: ctx.now,
      }),
    crossTenant: (env, ctx) =>
      inspectionRepo.advanceReworkCycle(env, ctx, OTHER_ID.reworkCycle, {
        from: "OPEN",
        to: "IN_PROGRESS",
        startedAt: ctx.now,
      }),
  },

  // ── P2-08: 証跡スナップショット ────────────────────────
  {
    name: "evidence.appendEvidenceSnapshot",
    kind: "tenant",
    run: (env, ctx) =>
      evidenceRepo.appendEvidenceSnapshot(env, ctx, {
        propertyId: OWN_ID.property,
        taskId: OWN_ID.task,
        businessDate: "2026-08-13",
        evidenceType: "CLEANING_COMPLETION",
        payload: '{"taskId":"x"}',
        payloadSha256: "aa",
        previousHash: null,
        chainHash: "bb",
      }),
    crossTenant: (env, ctx) =>
      evidenceRepo.appendEvidenceSnapshot(env, ctx, {
        propertyId: OTHER_ID.property,
        taskId: OTHER_ID.task,
        businessDate: "2026-08-13",
        evidenceType: "CLEANING_COMPLETION",
        payload: '{"taskId":"x"}',
        payloadSha256: "aa",
        previousHash: null,
        chainHash: "bb",
      }),
  },
  {
    name: "evidence.listEvidenceSnapshotsByTask",
    kind: "tenant",
    run: (env, ctx) => evidenceRepo.listEvidenceSnapshotsByTask(env, ctx, OWN_ID.task),
    crossTenant: (env, ctx) => evidenceRepo.listEvidenceSnapshotsByTask(env, ctx, OTHER_ID.task),
  },
  {
    name: "evidence.findLatestEvidenceSnapshotByTask",
    kind: "tenant",
    run: (env, ctx) => evidenceRepo.findLatestEvidenceSnapshotByTask(env, ctx, OWN_ID.task),
    crossTenant: (env, ctx) =>
      evidenceRepo.findLatestEvidenceSnapshotByTask(env, ctx, OTHER_ID.task),
  },
  {
    name: "evidence.findEvidenceSnapshotById",
    kind: "tenant",
    run: (env, ctx) => evidenceRepo.findEvidenceSnapshotById(env, ctx, OWN_ID.snapshot),
    crossTenant: (env, ctx) => evidenceRepo.findEvidenceSnapshotById(env, ctx, OTHER_ID.snapshot),
  },
  {
    name: "evidence.listEvidenceSnapshotsByDate",
    kind: "tenant",
    run: (env, ctx) =>
      evidenceRepo.listEvidenceSnapshotsByDate(env, ctx, OWN_ID.property, "2026-08-13"),
    crossTenant: (env, ctx) =>
      evidenceRepo.listEvidenceSnapshotsByDate(env, ctx, OTHER_ID.property, "2026-08-13"),
  },

  // ── P1-01 / P1-03 / P1-05: 清掃タスク ──────────────────
  {
    name: "cleaningTask.listTasks",
    kind: "tenant",
    run: (env, ctx) => cleaningTaskRepo.listTasks(env, ctx, { businessDate: "2026-08-12" }),
  },
  {
    name: "cleaningTask.findTaskById",
    kind: "tenant",
    run: (env, ctx) => cleaningTaskRepo.findTaskById(env, ctx, OWN_ID.task),
    crossTenant: (env, ctx) => cleaningTaskRepo.findTaskById(env, ctx, OTHER_ID.task),
  },
  {
    name: "cleaningTask.findTaskByShortId",
    kind: "tenant",
    run: (env, ctx) => cleaningTaskRepo.findTaskByShortId(env, ctx, "a1b2c3d4"),
  },
  {
    name: "cleaningTask.createTasks",
    kind: "tenant",
    run: (env, ctx) =>
      cleaningTaskRepo.createTasks(env, ctx, [
        {
          propertyId: OWN_ID.property,
          roomId: OWN_ID.room,
          businessDate: "2026-08-12",
          taskType: "CHECKOUT",
          priority: 40,
          standardMinutes: 40,
          shortId: "a1b2c3d4",
        },
      ]),
  },
  {
    name: "cleaningTask.updatePlannedTasks",
    kind: "tenant",
    run: (env, ctx) =>
      cleaningTaskRepo.updatePlannedTasks(env, ctx, "2026-08-12", [
        { roomId: OWN_ID.room, taskType: "CHECKOUT", priority: 10, standardMinutes: 40 },
      ]),
  },
  {
    name: "cleaningTask.cancelPlannedTasks",
    kind: "tenant",
    run: (env, ctx) =>
      cleaningTaskRepo.cancelPlannedTasks(env, ctx, "2026-08-12", [
        { roomId: OWN_ID.room, taskType: "CHECKOUT" },
      ]),
  },
  {
    name: "cleaningTask.reviveCancelledTasks",
    kind: "tenant",
    run: (env, ctx) =>
      cleaningTaskRepo.reviveCancelledTasks(env, ctx, "2026-08-12", [
        { roomId: OWN_ID.room, taskType: "CHECKOUT", priority: 40, standardMinutes: 40 },
      ]),
  },
  {
    name: "cleaningTask.applyTransition",
    kind: "tenant",
    run: (env, ctx) =>
      cleaningTaskRepo.applyTransition(env, ctx, OWN_ID.task, "ASSIGNED", {
        status: "IN_PROGRESS",
      }),
    crossTenant: (env, ctx) =>
      cleaningTaskRepo.applyTransition(env, ctx, OTHER_ID.task, "ASSIGNED", {
        status: "IN_PROGRESS",
      }),
  },
  {
    // P2-04。検査の結果をタスクへ反映する（§4.4 / §4.5）。
    name: "cleaningTask.applyInspectionOutcome",
    kind: "tenant",
    run: (env, ctx) =>
      cleaningTaskRepo.applyInspectionOutcome(env, ctx, OWN_ID.task, {
        result: "PASS",
        round: 1,
        inspectorId: OWN_ID.membership,
      }),
    crossTenant: (env, ctx) =>
      cleaningTaskRepo.applyInspectionOutcome(env, ctx, OTHER_ID.task, {
        result: "PASS",
        round: 1,
        inspectorId: OWN_ID.membership,
      }),
  },
  {
    name: "cleaningTask.listTimeLogs",
    kind: "tenant",
    run: (env, ctx) => cleaningTaskRepo.listTimeLogs(env, ctx, OWN_ID.task),
    crossTenant: (env, ctx) => cleaningTaskRepo.listTimeLogs(env, ctx, OTHER_ID.task),
  },
  {
    name: "cleaningTask.appendTimeLog",
    kind: "tenant",
    run: (env, ctx) =>
      cleaningTaskRepo.appendTimeLog(env, ctx, {
        taskId: OWN_ID.task,
        propertyId: OWN_ID.property,
        event: "START",
        actorId: OWN_ID.membership,
      }),
    crossTenant: (env, ctx) =>
      cleaningTaskRepo.appendTimeLog(env, ctx, {
        taskId: OTHER_ID.task,
        propertyId: OWN_ID.property,
        event: "START",
        actorId: OWN_ID.membership,
      }),
  },
  {
    name: "cleaningTask.findTimeLogByIdempotencyKey",
    kind: "tenant",
    run: (env, ctx) => cleaningTaskRepo.findTimeLogByIdempotencyKey(env, ctx, "key-1"),
  },
  {
    name: "cleaningTask.countTasksByStatus",
    kind: "tenant",
    run: (env, ctx) => cleaningTaskRepo.countTasksByStatus(env, ctx, OWN_ID.property, "2026-08-12"),
    crossTenant: (env, ctx) =>
      cleaningTaskRepo.countTasksByStatus(env, ctx, OTHER_ID.property, "2026-08-12"),
  },
  {
    // P2-02: 最低抽出件数の判定に使う（PK-SPEC-P2 §2.2）。
    name: "cleaningTask.countInspectionSelected",
    kind: "tenant",
    run: (env, ctx) =>
      cleaningTaskRepo.countInspectionSelected(env, ctx, OWN_ID.property, "2026-08-12"),
    crossTenant: (env, ctx) =>
      cleaningTaskRepo.countInspectionSelected(env, ctx, OTHER_ID.property, "2026-08-12"),
  },
  {
    name: "cleaningTask.listShortIds",
    kind: "tenant",
    run: (env, ctx) => cleaningTaskRepo.listShortIds(env, ctx, "2026-08-12"),
  },
  {
    name: "cleaningTask.assignTasks",
    kind: "tenant",
    run: (env, ctx) => cleaningTaskRepo.assignTasks(env, ctx, [OWN_ID.task], OWN_ID.membership),
    crossTenant: (env, ctx) =>
      cleaningTaskRepo.assignTasks(env, ctx, [OTHER_ID.task], OWN_ID.membership),
  },
  {
    name: "cleaningTask.countPhotosByChecklistItem",
    kind: "tenant",
    run: (env, ctx) => cleaningTaskRepo.countPhotosByChecklistItem(env, ctx, OWN_ID.task),
    crossTenant: (env, ctx) =>
      cleaningTaskRepo.countPhotosByChecklistItem(env, ctx, OTHER_ID.task),
  },
  // ── P1-06: チェックリスト ──────────────────────────────
  {
    name: "checklist.listTemplates",
    kind: "tenant",
    run: (env, ctx) => checklistRepo.listTemplates(env, ctx),
  },
  {
    name: "checklist.listTemplatesForProperty",
    kind: "tenant",
    run: (env, ctx) => checklistRepo.listTemplatesForProperty(env, ctx, OWN_ID.property),
    crossTenant: (env, ctx) => checklistRepo.listTemplatesForProperty(env, ctx, OTHER_ID.property),
  },
  {
    name: "checklist.listTemplateItems",
    kind: "tenant",
    run: (env, ctx) => checklistRepo.listTemplateItems(env, ctx, [OWN_ID.template]),
    crossTenant: (env, ctx) => checklistRepo.listTemplateItems(env, ctx, [OTHER_ID.template]),
  },
  {
    name: "checklist.listChecklistItemsByIds",
    kind: "tenant",
    run: (env, ctx) => checklistRepo.listChecklistItemsByIds(env, ctx, [OWN_ID.item]),
    crossTenant: (env, ctx) => checklistRepo.listChecklistItemsByIds(env, ctx, [OTHER_ID.item]),
  },
  {
    name: "checklist.createTemplate",
    kind: "tenant",
    run: (env, ctx) =>
      checklistRepo.createTemplate(env, ctx, {
        propertyId: null,
        roomTypeId: null,
        taskType: "CHECKOUT",
        name: "アウト清掃",
        items: [
          { section: "浴室", labels: { ja: "浴槽を洗浄した" }, isRequired: true, photoRequired: false },
        ],
      }),
  },
  {
    name: "checklist.replaceTemplateItems",
    kind: "tenant",
    run: (env, ctx) =>
      checklistRepo.replaceTemplateItems(env, ctx, OWN_ID.template, {
        name: "アウト清掃",
        items: [
          { section: "浴室", labels: { ja: "浴槽を洗浄した" }, isRequired: true, photoRequired: false },
        ],
      }),
    crossTenant: (env, ctx) =>
      checklistRepo.replaceTemplateItems(env, ctx, OTHER_ID.template, { name: "x", items: [] }),
  },
  {
    name: "checklist.deactivateTemplate",
    kind: "tenant",
    run: (env, ctx) => checklistRepo.deactivateTemplate(env, ctx, OWN_ID.template),
    crossTenant: (env, ctx) => checklistRepo.deactivateTemplate(env, ctx, OTHER_ID.template),
  },
  {
    name: "checklist.expandChecklist",
    kind: "tenant",
    run: (env, ctx) =>
      checklistRepo.expandChecklist(env, ctx, [
        {
          taskId: OWN_ID.task,
          propertyId: OWN_ID.property,
          templateVersion: 1,
          items: [{ itemId: OWN_ID.item, isRequired: true, photoRequired: false }],
        },
      ]),
  },
  {
    name: "checklist.listChecklistResults",
    kind: "tenant",
    run: (env, ctx) => checklistRepo.listChecklistResults(env, ctx, OWN_ID.task),
    crossTenant: (env, ctx) => checklistRepo.listChecklistResults(env, ctx, OTHER_ID.task),
  },
  {
    name: "checklist.recordChecklistResult",
    kind: "tenant",
    run: (env, ctx) =>
      checklistRepo.recordChecklistResult(env, ctx, {
        taskId: OWN_ID.task,
        itemId: OWN_ID.item,
        value: "DONE",
        checkedById: OWN_ID.membership,
      }),
    crossTenant: (env, ctx) =>
      checklistRepo.recordChecklistResult(env, ctx, {
        taskId: OTHER_ID.task,
        itemId: OWN_ID.item,
        value: "DONE",
        checkedById: OWN_ID.membership,
      }),
  },
  // ── P1-02: 標準時間マスタ ──────────────────────────────
  {
    name: "standardTime.listStandardTimes",
    kind: "tenant",
    run: (env, ctx) => standardTimeRepo.listStandardTimes(env, ctx, OWN_ID.property),
    crossTenant: (env, ctx) => standardTimeRepo.listStandardTimes(env, ctx, OTHER_ID.property),
  },
  {
    name: "standardTime.upsertStandardTimes",
    kind: "tenant",
    run: (env, ctx) =>
      standardTimeRepo.upsertStandardTimes(env, ctx, OWN_ID.property, [
        { roomTypeId: OWN_ID.roomType, taskType: "CHECKOUT", minutes: 40 },
      ]),
    crossTenant: (env, ctx) => standardTimeRepo.upsertStandardTimes(env, ctx, OTHER_ID.property, []),
  },
  // ── P1-04: 当日の客室状況 ──────────────────────────────
  {
    name: "roomPlan.listRoomPlans",
    kind: "tenant",
    run: (env, ctx) => roomPlanRepo.listRoomPlans(env, ctx, OWN_ID.property, "2026-08-12"),
    crossTenant: (env, ctx) => roomPlanRepo.listRoomPlans(env, ctx, OTHER_ID.property, "2026-08-12"),
  },
  {
    name: "roomPlan.upsertRoomPlans",
    kind: "tenant",
    run: (env, ctx) =>
      roomPlanRepo.upsertRoomPlans(
        env,
        ctx,
        OWN_ID.property,
        "2026-08-12",
        [
          {
            roomId: OWN_ID.room,
            hasCheckout: true,
            hasCheckin: false,
            isStayover: false,
            guestCount: 2,
            declineClean: false,
          },
        ],
        "MANUAL",
      ),
    crossTenant: (env, ctx) =>
      roomPlanRepo.upsertRoomPlans(env, ctx, OTHER_ID.property, "2026-08-12", [], "CSV"),
  },
  // ── 当日の施設訪問順（P1-21 / §19.5）──────────────────
  {
    name: "dailyRoute.listDailyRoute",
    kind: "tenant",
    run: (env, ctx) => dailyRouteRepo.listDailyRoute(env, ctx, OWN_ID.membership, "2026-08-12"),
    // 他人の動線を引く経路を作らない。別組織の membership は 404。
    crossTenant: (env, ctx) =>
      dailyRouteRepo.listDailyRoute(env, ctx, OTHER_ID.membership, "2026-08-12"),
  },
  // ── 写真（P1-11 / P1-15。P1-21 が検査表へ登録した）────
  {
    name: "taskPhoto.listTaskPhotos",
    kind: "tenant",
    run: (env, ctx) => taskPhotoRepo.listTaskPhotos(env, ctx, OWN_ID.task),
    crossTenant: (env, ctx) => taskPhotoRepo.listTaskPhotos(env, ctx, OTHER_ID.task),
  },
  {
    name: "taskPhoto.countTaskPhotos",
    kind: "tenant",
    run: (env, ctx) => taskPhotoRepo.countTaskPhotos(env, ctx, OWN_ID.task),
    crossTenant: (env, ctx) => taskPhotoRepo.countTaskPhotos(env, ctx, OTHER_ID.task),
  },
  {
    name: "taskPhoto.countPhotosByTask",
    kind: "tenant",
    run: (env, ctx) => taskPhotoRepo.countPhotosByTask(env, ctx, [OWN_ID.task]),
    crossTenant: (env, ctx) => taskPhotoRepo.countPhotosByTask(env, ctx, [OTHER_ID.task]),
  },
  {
    name: "taskPhoto.findTaskPhotoByClientId",
    kind: "tenant",
    run: (env, ctx) => taskPhotoRepo.findTaskPhotoByClientId(env, ctx, "client-uuid"),
  },
  {
    name: "taskPhoto.findTaskPhotoById",
    kind: "tenant",
    run: (env, ctx) => taskPhotoRepo.findTaskPhotoById(env, ctx, OWN_ID.photo),
    crossTenant: (env, ctx) => taskPhotoRepo.findTaskPhotoById(env, ctx, OTHER_ID.photo),
  },
  {
    name: "taskPhoto.listPhotosForChecklistItem",
    kind: "tenant",
    run: (env, ctx) => taskPhotoRepo.listPhotosForChecklistItem(env, ctx, OWN_ID.task, OWN_ID.item),
    crossTenant: (env, ctx) =>
      taskPhotoRepo.listPhotosForChecklistItem(env, ctx, OTHER_ID.task, OWN_ID.item),
  },
  {
    name: "taskPhoto.createTaskPhoto",
    kind: "tenant",
    run: (env, ctx) =>
      taskPhotoRepo.createTaskPhoto(env, ctx, {
        taskId: OWN_ID.task,
        propertyId: OWN_ID.property,
        kind: "AFTER",
        storageKey: `photos/x/${OWN_ID.photo}.jpg`,
        photoId: OWN_ID.photo,
        width: 1600,
        height: 1200,
        fileSize: 400_000,
        clientId: "client-uuid",
        uploadedById: OWN_ID.membership,
      }),
    crossTenant: (env, ctx) =>
      taskPhotoRepo.createTaskPhoto(env, ctx, {
        taskId: OTHER_ID.task,
        propertyId: OTHER_ID.property,
        kind: "AFTER",
        storageKey: `photos/x/${OTHER_ID.photo}.jpg`,
        photoId: OTHER_ID.photo,
        width: 1600,
        height: 1200,
        fileSize: 400_000,
        clientId: "client-uuid",
        uploadedById: OWN_ID.membership,
      }),
  },
  {
    // SQL を発行しない採番関数。**組織条件の検査対象にならない**が、
    // 登録の網羅（全 export が載っていること）のためにここへ置く。
    name: "taskPhoto.newPhotoId",
    kind: "tenant",
    pure: true,
    run: (_env, ctx) => Promise.resolve(taskPhotoRepo.newPhotoId(ctx)),
  },
  // ── P3-03〜P3-07 / P3-11 観察記録（PK-SPEC-P3 §2）────────
  {
    name: "observation.findObservationByTaskId",
    kind: "tenant",
    run: (env, ctx) => observationRepo.findObservationByTaskId(env, ctx, OWN_ID.task),
    crossTenant: (env, ctx) => observationRepo.findObservationByTaskId(env, ctx, OTHER_ID.task),
  },
  {
    name: "observation.findObservationById",
    kind: "tenant",
    run: (env, ctx) => observationRepo.findObservationById(env, ctx, OWN_ID.observation),
    crossTenant: (env, ctx) =>
      observationRepo.findObservationById(env, ctx, OTHER_ID.observation),
  },
  {
    name: "observation.listObservations",
    kind: "tenant",
    run: (env, ctx) =>
      observationRepo.listObservations(env, ctx, {
        propertyId: OWN_ID.property,
        from: "2026-09-01",
        to: "2026-09-30",
      }),
  },
  {
    name: "observation.upsertObservation",
    kind: "tenant",
    run: (env, ctx) => observationRepo.upsertObservation(env, ctx, OBSERVATION_INPUT(OWN_ID)),
    crossTenant: (env, ctx) =>
      observationRepo.upsertObservation(env, ctx, OBSERVATION_INPUT(OTHER_ID)),
  },
  {
    name: "observation.skipObservation",
    kind: "tenant",
    run: (env, ctx) => observationRepo.skipObservation(env, ctx, OWN_ID.task),
    crossTenant: (env, ctx) => observationRepo.skipObservation(env, ctx, OTHER_ID.task),
  },
  {
    name: "observation.amendObservation",
    kind: "tenant",
    run: (env, ctx) =>
      observationRepo.amendObservation(env, ctx, {
        observationId: OWN_ID.observation,
        ...COUNTS,
        note: null,
        changedById: OWN_ID.membership,
        reason: "客室から戻ってきた実物と枚数が違ったため",
      }),
    crossTenant: (env, ctx) =>
      observationRepo.amendObservation(env, ctx, {
        observationId: OTHER_ID.observation,
        ...COUNTS,
        note: null,
        changedById: OWN_ID.membership,
        reason: "客室から戻ってきた実物と枚数が違ったため",
      }),
  },
  {
    name: "observation.listObservationRevisions",
    kind: "tenant",
    run: (env, ctx) => observationRepo.listObservationRevisions(env, ctx, OWN_ID.observation),
    crossTenant: (env, ctx) =>
      observationRepo.listObservationRevisions(env, ctx, OTHER_ID.observation),
  },
  {
    name: "observation.listLinenRecords",
    kind: "tenant",
    run: (env, ctx) => observationRepo.listLinenRecords(env, ctx, OWN_ID.task),
    crossTenant: (env, ctx) => observationRepo.listLinenRecords(env, ctx, OTHER_ID.task),
  },
  {
    name: "observation.upsertLinenRecords",
    kind: "tenant",
    run: (env, ctx) => observationRepo.upsertLinenRecords(env, ctx, LINEN_INPUT(OWN_ID)),
    crossTenant: (env, ctx) => observationRepo.upsertLinenRecords(env, ctx, LINEN_INPUT(OTHER_ID)),
  },
  {
    name: "observation.findObservationConfig",
    kind: "tenant",
    run: (env, ctx) => observationRepo.findObservationConfig(env, ctx, OWN_ID.property),
    crossTenant: (env, ctx) => observationRepo.findObservationConfig(env, ctx, OTHER_ID.property),
  },
  {
    name: "observation.listObservationConfigs",
    kind: "tenant",
    run: (env, ctx) => observationRepo.listObservationConfigs(env, ctx, [OWN_ID.property]),
  },
  {
    name: "observation.upsertObservationConfig",
    kind: "tenant",
    run: (env, ctx) => observationRepo.upsertObservationConfig(env, ctx, CONFIG_INPUT(OWN_ID)),
    crossTenant: (env, ctx) =>
      observationRepo.upsertObservationConfig(env, ctx, CONFIG_INPUT(OTHER_ID)),
  },
  {
    name: "observation.listLinenRecordsInRange",
    kind: "tenant",
    run: (env, ctx) =>
      observationRepo.listLinenRecordsInRange(env, ctx, {
        propertyId: OWN_ID.property,
        from: "2026-06-15",
        to: "2026-09-12",
      }),
    crossTenant: (env, ctx) =>
      observationRepo.listLinenRecordsInRange(env, ctx, {
        propertyId: OTHER_ID.property,
        from: "2026-06-15",
        to: "2026-09-12",
      }),
  },
  {
    name: "roomPlan.listRoomPlansInRange",
    kind: "tenant",
    run: (env, ctx) =>
      roomPlanRepo.listRoomPlansInRange(env, ctx, OWN_ID.property, "2026-06-15", "2026-09-12"),
    crossTenant: (env, ctx) =>
      roomPlanRepo.listRoomPlansInRange(env, ctx, OTHER_ID.property, "2026-06-15", "2026-09-12"),
  },
  // ── P3-09 / P3-10 / P3-12 ベースライン（PK-SPEC-P3 §2.4・§5）──
  {
    name: "baseline.listBaselines",
    kind: "tenant",
    run: (env, ctx) => baselineRepo.listBaselines(env, ctx, { propertyId: OWN_ID.property }),
  },
  {
    name: "baseline.findBaselineById",
    kind: "tenant",
    run: (env, ctx) => baselineRepo.findBaselineById(env, ctx, OWN_ID.baseline),
    crossTenant: (env, ctx) => baselineRepo.findBaselineById(env, ctx, OTHER_ID.baseline),
  },
  {
    name: "baseline.replaceBaselines",
    kind: "tenant",
    run: (env, ctx) => baselineRepo.replaceBaselines(env, ctx, BASELINE_REPLACE(OWN_ID)),
    crossTenant: (env, ctx) => baselineRepo.replaceBaselines(env, ctx, BASELINE_REPLACE(OTHER_ID)),
  },
  {
    name: "baseline.setBaselineOverride",
    kind: "tenant",
    run: (env, ctx) =>
      baselineRepo.setBaselineOverride(env, ctx, {
        baselineId: OWN_ID.baseline,
        manualOverride: 3,
        reason: "連泊の多い時期で p90 が実態より低いため",
      }),
    crossTenant: (env, ctx) =>
      baselineRepo.setBaselineOverride(env, ctx, {
        baselineId: OTHER_ID.baseline,
        manualOverride: 3,
        reason: "連泊の多い時期で p90 が実態より低いため",
      }),
  },
  {
    name: "baseline.clearBaselineOverride",
    kind: "tenant",
    run: (env, ctx) => baselineRepo.clearBaselineOverride(env, ctx, OWN_ID.baseline),
    crossTenant: (env, ctx) => baselineRepo.clearBaselineOverride(env, ctx, OTHER_ID.baseline),
  },
  {
    name: "baseline.listBaselineExclusions",
    kind: "tenant",
    run: (env, ctx) =>
      baselineRepo.listBaselineExclusions(env, ctx, {
        propertyId: OWN_ID.property,
        from: "2026-09-01",
        to: "2026-09-30",
      }),
  },
  {
    name: "baseline.replaceBaselineExclusions",
    kind: "tenant",
    run: (env, ctx) =>
      baselineRepo.replaceBaselineExclusions(env, ctx, BASELINE_EXCLUSIONS(OWN_ID)),
    crossTenant: (env, ctx) =>
      baselineRepo.replaceBaselineExclusions(env, ctx, BASELINE_EXCLUSIONS(OTHER_ID)),
  },
  {
    name: "occupancy.upsertOccupancySnapshots",
    kind: "tenant",
    run: (env, ctx) => occupancyRepo.upsertOccupancySnapshots(env, ctx, OCCUPANCY_PARAMS(OWN_ID), [
      OCCUPANCY_ENTRY(OWN_ID),
    ]),
    crossTenant: (env, ctx) =>
      occupancyRepo.upsertOccupancySnapshots(env, ctx, OCCUPANCY_PARAMS(OTHER_ID), [
        OCCUPANCY_ENTRY(OTHER_ID),
      ]),
  },
  {
    name: "occupancy.listOccupancySnapshots",
    kind: "tenant",
    run: (env, ctx) =>
      occupancyRepo.listOccupancySnapshots(env, ctx, {
        propertyId: OWN_ID.property,
        businessDate: "2026-09-09",
      }),
    crossTenant: (env, ctx) =>
      occupancyRepo.listOccupancySnapshots(env, ctx, {
        propertyId: OTHER_ID.property,
        businessDate: "2026-09-09",
      }),
  },
  {
    name: "occupancy.findOccupancySnapshotById",
    kind: "tenant",
    run: (env, ctx) => occupancyRepo.findOccupancySnapshotById(env, ctx, OWN_ID.occupancy),
    crossTenant: (env, ctx) =>
      occupancyRepo.findOccupancySnapshotById(env, ctx, OTHER_ID.occupancy),
  },
];

/** 組織条件を検査する対象。**`pure` の関数だけを外す。** */
const SQL_INVOCATIONS = INVOCATIONS.filter((invocation) => invocation.pure !== true);

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
  it.each(SQL_INVOCATIONS)("$name は organization_id 条件つきの SQL を発行する", async (invocation) => {
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

  it.each(SQL_INVOCATIONS)(
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

describe("証跡スナップショットの不変性", () => {
  // P2-01 完了条件 / PK-SPEC-P2 §3.7 MUST / CLAUDE.md §4。
  // **INSERT だけ。** 訂正は `correctsSnapshotId` を持つ新しい行を足す（§6.4）。
  it("evidence_snapshot を UPDATE / DELETE するリポジトリ関数が無い", () => {
    const offenders = repositorySources().filter(
      ({ code }) =>
        /\.update\(\s*evidenceSnapshot/.test(code) || /\.delete\(\s*evidenceSnapshot/.test(code),
    );
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  it("evidence_snapshot を対象にした SQL の update / delete が無い", () => {
    // drizzle の呼び出しを介さない生 SQL（`sql\`\``）でも同じこと。
    const offenders = repositorySources().filter(({ code }) =>
      /(update|delete\s+from)\s+["`']?evidence_snapshot/i.test(code),
    );
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });
});

describe("日報の不変性", () => {
  // P2-14 完了条件 / PK-SPEC-P2 §9.3 / CLAUDE.md §4（発行済み帳票）。
  // **INSERT だけ。** 再生成は revision を上げた新しい行を足す。
  it("daily_report を UPDATE / DELETE するリポジトリ関数が無い", () => {
    const offenders = repositorySources().filter(
      ({ code }) => /\.update\(\s*dailyReport/.test(code) || /\.delete\(\s*dailyReport/.test(code),
    );
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  it("daily_report を対象にした SQL の update / delete が無い", () => {
    const offenders = repositorySources().filter(({ code }) =>
      /(update|delete\s+from)\s+["`']?daily_report/i.test(code),
    );
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });
});

describe("観察記録の不変性", () => {
  // PK-SPEC-P3 §0.1（P4 の照合はこのデータの上にしか成立しない）/
  // 同 §2.1 MUST（上書きは許すが履歴を残す）。
  // **DELETE が 1 つも無い。** 訂正は `amendObservation()`。
  it("room_observation / observation_revision を DELETE する関数が無い", () => {
    const offenders = repositorySources().filter(
      ({ code }) =>
        /\.delete\(\s*roomObservation/.test(code) ||
        /\.delete\(\s*observationRevision/.test(code) ||
        /\.delete\(\s*linenRecord/.test(code),
    );
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  it("修正履歴（observation_revision）を UPDATE する関数が無い", () => {
    // 追記のみ。**旧値を書き換えられたら履歴の意味が無い。**
    const offenders = repositorySources().filter(({ code }) =>
      /\.update\(\s*observationRevision/.test(code),
    );
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  it("観察の表を対象にした SQL の delete が無い", () => {
    const offenders = repositorySources().filter(({ code }) =>
      /delete\s+from\s+["`']?(room_observation|observation_revision|linen_record)/i.test(code),
    );
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });
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
