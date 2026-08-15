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
import * as integrationRepo from "./integration.js";
import * as apiKeyRepo from "./apiKey.js";
import * as outboundWebhookRepo from "./outboundWebhook.js";
import * as notificationRepo from "./notification.js";
import * as inspectionPolicyRepo from "./inspectionPolicy.js";
import * as invoiceRepo from "./invoice.js";
import * as issueReportRepo from "./issueReport.js";
import * as lostItemRepo from "./lostItem.js";
import * as observationRepo from "./observation.js";
import * as occupancyRepo from "./occupancy.js";
import * as reconciliationRepo from "./reconciliation.js";
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
  // P4-05 が登録した照合の実行と差異（PK-SPEC-P4 §2.4・§2.5）。
  // **DELETE が無い**ことも下で検査する（再実行は差分の追加 / 同 §5.3）。
  reconciliation: reconciliationRepo,
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
  // P6-01 / P6-04 が登録した外部連携（PK-SPEC-P6 §2）。
  // **資格情報を返す関数が無い**（返すのは KV の参照キーまで / security.md §7）。
  integration: integrationRepo,
  // P6-09 が登録した通知（PK-SPEC-P6 §2.4・§2.5・§5）。
  // **「誰が通知を開いたか」を集計する関数が無い**（security.md §5）。
  notification: notificationRepo,
  // P6-12 が登録した公開 API のキー（PK-SPEC-P6 §6.1）。
  // **平文のトークンを受け取る関数も返す関数も無い**（security.md §7）。
  apiKey: apiKeyRepo,
  // P6-13 が登録した送信 Webhook（PK-SPEC-P6 §6.4）。
  // **署名鍵そのものを返す関数が無い**（security.md §7）。
  outboundWebhook: outboundWebhookRepo,
  // P2-08 が登録した証跡。**INSERT と SELECT だけ**であることも下で検査する。
  evidence: evidenceRepo,
  // P2-02 が登録した検査方式。P2-04 が検査そのもの。
  inspection: inspectionRepo,
  inspectionPolicy: inspectionPolicyRepo,
  // P2-11 / P2-12 が登録した忘れ物と設備不具合（PK-SPEC-P2 §3.5・§3.6）。
  issueReport: issueReportRepo,
  lostItem: lostItemRepo,
  // P5-01 が登録した請求・領収（PK-SPEC-P5 §2）。
  // **`invoice` / `receipt` に DELETE が無い**ことも下で検査する
  // （発行済み帳票 / billing.md §2。訂正は赤伝＋再発行）。
  invoice: invoiceRepo,
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

/** `upsertPropertyRollup()` に渡す数字。**中身は検証の対象ではない。** */
const ROLLUP_COUNTS = {
  totalTasks: 0,
  completedTasks: 0,
  reworkTasks: 0,
  totalMinutes: 0,
  inspectedTasks: 0,
  firstPassTasks: 0,
  openIssues: 0,
  findingsHigh: 0,
} as const;

/** 自組織の ID。`assertIdBelongsToTenant()` を通る形式。 */
const OWN_ID = {
  // P6-12。
  apiKey: generateId(TEST_ORG.orgShortId, "akey"),
  outboundWebhook: generateId(TEST_ORG.orgShortId, "owh"),
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
  // P4-05。
  run: generateId(TEST_ORG.orgShortId, "run"),
  finding: generateId(TEST_ORG.orgShortId, "find"),
  counterparty: generateId(TEST_ORG.orgShortId, "cp"),
  pricingRule: generateId(TEST_ORG.orgShortId, "prc"),
  invoice: generateId(TEST_ORG.orgShortId, "inv"),
  receipt: generateId(TEST_ORG.orgShortId, "rcp"),
  delivery: generateId(TEST_ORG.orgShortId, "dlv"),
  billingPeriod: generateId(TEST_ORG.orgShortId, "bper"),
  billingPeriodReview: generateId(TEST_ORG.orgShortId, "bprv"),
  // P6-01 / P6-04。外部連携（PK-SPEC-P6 §2）。
  integration: generateId(TEST_ORG.orgShortId, "intg"),
  syncLog: generateId(TEST_ORG.orgShortId, "slog"),
  externalMapping: generateId(TEST_ORG.orgShortId, "xmap"),
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
  // P6-12。
  apiKey: generateId(OTHER_ORG.orgShortId, "akey"),
  outboundWebhook: generateId(OTHER_ORG.orgShortId, "owh"),
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
  // P4-05。
  run: generateId(OTHER_ORG.orgShortId, "run"),
  finding: generateId(OTHER_ORG.orgShortId, "find"),
  counterparty: generateId(OTHER_ORG.orgShortId, "cp"),
  pricingRule: generateId(OTHER_ORG.orgShortId, "prc"),
  invoice: generateId(OTHER_ORG.orgShortId, "inv"),
  receipt: generateId(OTHER_ORG.orgShortId, "rcp"),
  delivery: generateId(OTHER_ORG.orgShortId, "dlv"),
  billingPeriod: generateId(OTHER_ORG.orgShortId, "bper"),
  billingPeriodReview: generateId(OTHER_ORG.orgShortId, "bprv"),
  integration: generateId(OTHER_ORG.orgShortId, "intg"),
  syncLog: generateId(OTHER_ORG.orgShortId, "slog"),
  externalMapping: generateId(OTHER_ORG.orgShortId, "xmap"),
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

/** 照合の実行 1 件（P4-05 / PK-SPEC-P4 §2.4）。 */
const RUN_INPUT = (id: typeof OWN_ID | typeof OTHER_ID) =>
  ({
    propertyId: id.property,
    businessDate: "2026-09-09",
    engineVersion: "1.0",
    rulesetHash: "00000000",
    availableSources: ["occupancy", "observation"],
  }) as const;

/** 差異 1 件（同 §2.5）。**不正の認定ではない**（同 §1.1）。 */
const FINDING = (id: typeof OWN_ID | typeof OTHER_ID) => ({
  roomId: id.room,
  ruleCode: "R001" as const,
  ruleVersion: "1.0",
  severity: "HIGH" as const,
  confidence: 80,
  title: "302 号室：稼働記録のない使用痕跡",
  summary: "",
  evidence: {},
  matchedSignals: ["BEDS_USED", "TRASH_PRESENT"],
});

/** 取引先 1 件（P5-01 / PK-SPEC-P5 §2.1）。**宿泊者ではなく事業者。** */
const COUNTERPARTY_INPUT = {
  code: "CP-001",
  legalName: "株式会社サンプル",
  displayName: null,
  invoiceRegistrationNo: null,
  postalCode: null,
  address1: null,
  address2: null,
  department: null,
  contactName: null,
  billingEmail: "billing@example.com",
  ccEmails: [] as string[],
  closingDay: 31,
  paymentTermDays: 30,
  taxRoundingMode: "FLOOR",
  isActive: true,
  // **`as const` にしない。** `ccEmails` が `readonly []` になると
  // `UpsertCounterpartyInput`（`string[]`）に代入できない。
} satisfies invoiceRepo.UpsertCounterpartyInput;

/** 料金設定 1 件（同 §2.2）。**値上げは行の追加**（既存行を書き換えない）。 */
const PRICING_INPUT = (id: typeof OWN_ID | typeof OTHER_ID) =>
  ({
    counterpartyId: id.counterparty,
    propertyId: id.property,
    roomTypeId: null,
    taskType: null,
    itemCode: "CLEAN_CHECKOUT",
    unitPrice: 3000,
    taxRate: 10,
    isReducedRate: false,
    validFrom: "2026-09-01",
    validTo: null,
    priority: 50,
  }) as const;

/**
 * 請求書 1 通ぶんの発行入力（P5-07 / 同 §4.1 の ③〜⑥）。
 *
 * **金額は呼び出し側が確定させたもの。** リポジトリは計算しない。
 */
const CREATE_INVOICE_INPUT = (id: typeof OWN_ID | typeof OTHER_ID) => ({
  counterpartyId: id.counterparty,
  documentNo: "INV-2026-0042",
  issueDate: "2026-10-01",
  dueDate: "2026-10-31",
  periodFrom: "2026-09-01",
  periodTo: "2026-09-30",
  counterpartyName: "サンプルホテル運営株式会社",
  subtotalAmount: 651600,
  taxAmount: 65160,
  totalAmount: 716760,
  isQualifiedInvoice: true,
  issuerSnapshot: { legalName: "サンプル清掃株式会社" },
  counterpartySnapshot: { legalName: "サンプルホテル運営株式会社" },
  payloadSha256: "b".repeat(64),
  note: null,
  confirmedById: id.membership,
  lines: [
    {
      lineNo: 1,
      propertyId: id.property,
      itemCode: "CLEAN_CHECKOUT" as const,
      description: "サンプルホテル東京 / アウト清掃",
      serviceDateFrom: "2026-09-01",
      serviceDateTo: "2026-09-30",
      quantity: 180,
      unit: "室",
      unitPrice: 3200,
      amount: 576000,
      taxRate: 10,
      isReducedRate: false,
      sourceRef: { taskIds: [id.task] },
    },
  ],
  taxSummaries: [
    {
      taxRate: 10,
      isReducedRate: false,
      subtotalAmount: 651600,
      taxAmount: 65160,
      totalAmount: 716760,
    },
  ],
  sequence: { documentType: "INVOICE" as const, fiscalYear: 2026, lastNumber: 42 },
});

/** 送付ログ 1 行（同 §2.7）。**差異の詳細を `bodyPreview` に入れない。** */
const DELIVERY_INPUT = (id: typeof OWN_ID | typeof OTHER_ID) =>
  ({
    docType: "INVOICE",
    documentId: id.invoice,
    channel: "EMAIL",
    toEmail: "keiri@example.co.jp",
    ccEmails: [],
    subject: "請求書のご送付（INV-2026-0042）",
    bodyPreview: "いつもお世話になっております。",
    status: "SENT",
    providerMessageId: null,
    errorMessage: null,
    sentById: id.membership,
    sentAt: null,
  }) satisfies invoiceRepo.RecordDocumentDeliveryInput;

/** 領収書 1 通（P5-08 / 同 §4.2）。**印紙の値を持たない**（billing.md §3）。 */
const CREATE_RECEIPT_INPUT = (id: typeof OWN_ID | typeof OTHER_ID) =>
  ({
    invoiceId: id.invoice,
    counterpartyId: id.counterparty,
    documentNo: "RCP-2026-0018",
    issueDate: "2026-10-28",
    totalAmount: 716760,
    counterpartyName: "サンプルホテル運営株式会社",
    receivedAmount: 716760,
    receivedDate: "2026-10-28",
    paymentMethod: "BANK_TRANSFER",
    purposeText: "清掃業務委託料として（2026年9月分）",
    taxSummary: [
      { taxRate: 10, isReducedRate: false, subtotalAmount: 651600, taxAmount: 65160, totalAmount: 716760 },
    ],
    isQualifiedInvoice: true,
    issuerSnapshot: { legalName: "サンプル清掃株式会社" },
    counterpartySnapshot: { legalName: "サンプルホテル運営株式会社" },
    sequence: { fiscalYear: 2026, lastNumber: 18 },
  }) satisfies invoiceRepo.CreateReceiptInput;

/** 業務上の入室 1 件（P4-10 / 同 §2.3）。**宿泊者の情報を持たない。** */
const ACCESS_LOG_INPUT = (id: typeof OWN_ID | typeof OTHER_ID) =>
  ({
    propertyId: id.property,
    roomId: id.room,
    businessDate: "2026-09-09",
    purpose: "INSPECTION",
    enteredAt: new Date("2026-09-09T02:00:00Z"),
    exitedAt: null,
    actorName: null,
    note: null,
    registeredById: id.membership,
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
    // **`crossTenant` を置いていない。** まとめ引きなので越境 ID は例外に
    // ならず、組織条件で落ちて Map に現れない（`listFindings()` と同じ形）。
    name: "room.listRoomNumbersByIds",
    kind: "tenant",
    run: (env, ctx) => roomRepo.listRoomNumbersByIds(env, ctx, [OWN_ID.room]),
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
  // P5-14 が足した 4 本。**再計算 UPSERT と、その材料の 3 本。**
  // 材料は `rollup-update` のコンシューマ専用だが、組織条件の検証は
  // 他と同じに掛ける（rollup.ts の注記）。
  {
    name: "rollup.listRollupsInRange",
    kind: "tenant",
    run: (env, ctx) =>
      rollupRepo.listRollupsInRange(env, ctx, { from: "2026-09-01", to: "2026-09-30" }),
  },
  {
    name: "rollup.upsertPropertyRollup",
    kind: "tenant",
    run: (env, ctx) =>
      rollupRepo.upsertPropertyRollup(env, ctx, {
        propertyId: OWN_ID.property,
        businessDate: "2026-09-10",
        counts: ROLLUP_COUNTS,
        now: TEST_NOW,
      }),
    crossTenant: (env, ctx) =>
      rollupRepo.upsertPropertyRollup(env, ctx, {
        propertyId: OTHER_ID.property,
        businessDate: "2026-09-10",
        counts: ROLLUP_COUNTS,
        now: TEST_NOW,
      }),
  },
  {
    name: "rollup.countTasksForRollup",
    kind: "tenant",
    run: (env, ctx) => rollupRepo.countTasksForRollup(env, ctx, OWN_ID.property, "2026-09-10"),
    crossTenant: (env, ctx) =>
      rollupRepo.countTasksForRollup(env, ctx, OTHER_ID.property, "2026-09-10"),
  },
  {
    name: "rollup.countOpenIssuesForRollup",
    kind: "tenant",
    run: (env, ctx) => rollupRepo.countOpenIssuesForRollup(env, ctx, OWN_ID.property),
    crossTenant: (env, ctx) => rollupRepo.countOpenIssuesForRollup(env, ctx, OTHER_ID.property),
  },
  {
    name: "rollup.countHighFindingsForRollup",
    kind: "tenant",
    run: (env, ctx) =>
      rollupRepo.countHighFindingsForRollup(env, ctx, OWN_ID.property, "2026-09-10"),
    crossTenant: (env, ctx) =>
      rollupRepo.countHighFindingsForRollup(env, ctx, OTHER_ID.property, "2026-09-10"),
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
  // P5-15 の清掃会社プランが読む「稼働スタッフ」（PK-SPEC-P5 §7.2）。
  // **人数だけを返す。** 個人が並ぶ配列を画面へ渡さない（security.md §5）。
  {
    name: "user.countActiveMembershipsByRole",
    kind: "tenant",
    run: (env, ctx) => userRepo.countActiveMembershipsByRole(env, ctx),
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
    // P5-13。請求明細の `sourceRef.taskIds` から辿る（§6.3）。
    // **D1 の 100 変数**で割る（`paramBudget.spec.ts` も見る）。
    name: "cleaningTask.listTasksByIds",
    kind: "tenant",
    run: (env, ctx) => cleaningTaskRepo.listTasksByIds(env, ctx, [OWN_ID.task]),
    crossTenant: (env, ctx) => cleaningTaskRepo.listTasksByIds(env, ctx, [OTHER_ID.task]),
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
  {
    name: "occupancy.hasOccupancySnapshotsInRange",
    kind: "tenant",
    run: (env, ctx) =>
      occupancyRepo.hasOccupancySnapshotsInRange(env, ctx, {
        propertyId: OWN_ID.property,
        from: "2026-08-10",
        to: "2026-09-09",
      }),
    crossTenant: (env, ctx) =>
      occupancyRepo.hasOccupancySnapshotsInRange(env, ctx, {
        propertyId: OTHER_ID.property,
        from: "2026-08-10",
        to: "2026-09-09",
      }),
  },
  // P4-05。照合の実行と差異（PK-SPEC-P4 §2.4・§2.5・§5）。
  {
    name: "reconciliation.listPhysicalSignals",
    kind: "tenant",
    run: (env, ctx) =>
      reconciliationRepo.listPhysicalSignals(env, ctx, {
        propertyId: OWN_ID.property,
        businessDate: "2026-09-09",
      }),
    crossTenant: (env, ctx) =>
      reconciliationRepo.listPhysicalSignals(env, ctx, {
        propertyId: OTHER_ID.property,
        businessDate: "2026-09-09",
      }),
  },
  {
    name: "reconciliation.listRoomAccessLogs",
    kind: "tenant",
    run: (env, ctx) =>
      reconciliationRepo.listRoomAccessLogs(env, ctx, {
        propertyId: OWN_ID.property,
        businessDate: "2026-09-09",
      }),
    crossTenant: (env, ctx) =>
      reconciliationRepo.listRoomAccessLogs(env, ctx, {
        propertyId: OTHER_ID.property,
        businessDate: "2026-09-09",
      }),
  },
  {
    name: "reconciliation.listRuleConfigs",
    kind: "tenant",
    run: (env, ctx) => reconciliationRepo.listRuleConfigs(env, ctx, OWN_ID.property),
    crossTenant: (env, ctx) => reconciliationRepo.listRuleConfigs(env, ctx, OTHER_ID.property),
  },
  {
    name: "reconciliation.listRecentFalsePositives",
    kind: "tenant",
    run: (env, ctx) =>
      reconciliationRepo.listRecentFalsePositives(env, ctx, {
        propertyId: OWN_ID.property,
        from: new Date("2026-08-10T00:00:00Z"),
      }),
    crossTenant: (env, ctx) =>
      reconciliationRepo.listRecentFalsePositives(env, ctx, {
        propertyId: OTHER_ID.property,
        from: new Date("2026-08-10T00:00:00Z"),
      }),
  },
  {
    name: "reconciliation.startReconciliationRun",
    kind: "tenant",
    run: (env, ctx) => reconciliationRepo.startReconciliationRun(env, ctx, RUN_INPUT(OWN_ID)),
    crossTenant: (env, ctx) =>
      reconciliationRepo.startReconciliationRun(env, ctx, RUN_INPUT(OTHER_ID)),
  },
  {
    name: "reconciliation.finishReconciliationRun",
    kind: "tenant",
    run: (env, ctx) =>
      reconciliationRepo.finishReconciliationRun(env, ctx, {
        runId: OWN_ID.run,
        status: "COMPLETED",
        roomsEvaluated: 0,
      }),
    crossTenant: (env, ctx) =>
      reconciliationRepo.finishReconciliationRun(env, ctx, {
        runId: OTHER_ID.run,
        status: "COMPLETED",
        roomsEvaluated: 0,
      }),
  },
  {
    name: "reconciliation.listReconciliationRuns",
    kind: "tenant",
    run: (env, ctx) =>
      reconciliationRepo.listReconciliationRuns(env, ctx, { propertyId: OWN_ID.property }),
    crossTenant: (env, ctx) =>
      reconciliationRepo.listReconciliationRuns(env, ctx, { propertyId: OTHER_ID.property }),
  },
  {
    name: "reconciliation.findReconciliationRunById",
    kind: "tenant",
    run: (env, ctx) => reconciliationRepo.findReconciliationRunById(env, ctx, OWN_ID.run),
    crossTenant: (env, ctx) =>
      reconciliationRepo.findReconciliationRunById(env, ctx, OTHER_ID.run),
  },
  {
    name: "reconciliation.insertFindings",
    kind: "tenant",
    run: (env, ctx) =>
      reconciliationRepo.insertFindings(
        env,
        ctx,
        { runId: OWN_ID.run, propertyId: OWN_ID.property, businessDate: "2026-09-09" },
        [FINDING(OWN_ID)],
      ),
    crossTenant: (env, ctx) =>
      reconciliationRepo.insertFindings(
        env,
        ctx,
        { runId: OTHER_ID.run, propertyId: OTHER_ID.property, businessDate: "2026-09-09" },
        [FINDING(OTHER_ID)],
      ),
  },
  {
    // **`crossTenant` を置いていない。** `listFindings()` は `propertyId` を
    // 任意で受ける一覧で、別組織の施設 ID を渡しても例外ではなく 0 件になる
    // （組織条件が必ず AND される / `listBaselines()` と同じ形）。
    name: "reconciliation.listFindings",
    kind: "tenant",
    run: (env, ctx) => reconciliationRepo.listFindings(env, ctx, { propertyId: OWN_ID.property }),
  },
  {
    name: "reconciliation.findFindingById",
    kind: "tenant",
    run: (env, ctx) => reconciliationRepo.findFindingById(env, ctx, OWN_ID.finding),
    crossTenant: (env, ctx) => reconciliationRepo.findFindingById(env, ctx, OTHER_ID.finding),
  },
  // ── P5-01 が足したもの（PK-SPEC-P5 §2）────────────────────
  {
    // 取引先は組織のマスタ。**施設スコープを持たない**（`NO_PROPERTY_SCOPE`）。
    name: "invoice.listCounterparties",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.listCounterparties(env, ctx),
  },
  {
    name: "invoice.findCounterpartyById",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.findCounterpartyById(env, ctx, OWN_ID.counterparty),
    crossTenant: (env, ctx) => invoiceRepo.findCounterpartyById(env, ctx, OTHER_ID.counterparty),
  },
  {
    name: "invoice.upsertCounterparty",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.upsertCounterparty(env, ctx, COUNTERPARTY_INPUT),
  },
  // ── P5-02 / P5-03 が足したもの ─────────────────────────────
  {
    // **`code` を受けない**（鍵の付け替えは新しい取引先を作る操作）。
    name: "invoice.updateCounterparty",
    kind: "tenant",
    run: (env, ctx) =>
      invoiceRepo.updateCounterparty(env, ctx, OWN_ID.counterparty, { isActive: false }),
    crossTenant: (env, ctx) =>
      invoiceRepo.updateCounterparty(env, ctx, OTHER_ID.counterparty, { isActive: false }),
  },
  {
    // **`validTo` しか触らない**（値上げは行の追加 / PK-SPEC-P5 §2.2）。
    name: "invoice.closePricingRule",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.closePricingRule(env, ctx, OWN_ID.pricingRule, "2026-09-30"),
    crossTenant: (env, ctx) =>
      invoiceRepo.closePricingRule(env, ctx, OTHER_ID.pricingRule, "2026-09-30"),
  },
  {
    name: "invoice.listPricingRules",
    kind: "tenant",
    run: (env, ctx) =>
      invoiceRepo.listPricingRules(env, ctx, { counterpartyId: OWN_ID.counterparty }),
  },
  {
    name: "invoice.findPricingRuleById",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.findPricingRuleById(env, ctx, OWN_ID.pricingRule),
    crossTenant: (env, ctx) => invoiceRepo.findPricingRuleById(env, ctx, OTHER_ID.pricingRule),
  },
  {
    name: "invoice.insertPricingRule",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.insertPricingRule(env, ctx, PRICING_INPUT(OWN_ID)),
    crossTenant: (env, ctx) => invoiceRepo.insertPricingRule(env, ctx, PRICING_INPUT(OTHER_ID)),
  },
  // ── P5-07 が足したもの（PK-SPEC-P5 §4.1）──────────────────
  {
    // ③〜⑥ を 1 トランザクションで書く。**採番は呼び出し側。**
    name: "invoice.createInvoice",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.createInvoice(env, ctx, CREATE_INVOICE_INPUT(OWN_ID)),
    crossTenant: (env, ctx) => invoiceRepo.createInvoice(env, ctx, CREATE_INVOICE_INPUT(OTHER_ID)),
  },
  {
    // ⑧⑨ の書き戻し。**金額に触れない。**
    name: "invoice.updateInvoicePdf",
    kind: "tenant",
    run: (env, ctx) =>
      invoiceRepo.updateInvoicePdf(env, ctx, OWN_ID.invoice, {
        pdfStorageKey: "invoices/x/INV-2026-0042-r1.pdf",
        pdfSha256: "a".repeat(64),
      }),
    crossTenant: (env, ctx) =>
      invoiceRepo.updateInvoicePdf(env, ctx, OTHER_ID.invoice, {
        pdfStorageKey: "invoices/x/INV-2026-0042-r1.pdf",
        pdfSha256: "a".repeat(64),
      }),
  },
  {
    // ⑫。**`CONFIRMED` のときだけ進む**（再送で状態が戻らない）。
    name: "invoice.markInvoiceSent",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.markInvoiceSent(env, ctx, OWN_ID.invoice, ctx.now),
    crossTenant: (env, ctx) => invoiceRepo.markInvoiceSent(env, ctx, OTHER_ID.invoice, ctx.now),
  },
  {
    // ⑪ 送付ログ。**追記のみ。**
    name: "invoice.recordDocumentDelivery",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.recordDocumentDelivery(env, ctx, DELIVERY_INPUT(OWN_ID)),
    crossTenant: (env, ctx) =>
      invoiceRepo.recordDocumentDelivery(env, ctx, DELIVERY_INPUT(OTHER_ID)),
  },
  // ── P5-10 が足したもの（PK-SPEC-P5 §2.7）──────────────────
  {
    // webhook から状態を進める。**終端からは動かない。**
    name: "invoice.updateDocumentDeliveryStatus",
    kind: "tenant",
    run: (env, ctx) =>
      invoiceRepo.updateDocumentDeliveryStatus(env, ctx, OWN_ID.delivery, { status: "DELIVERED" }),
    crossTenant: (env, ctx) =>
      invoiceRepo.updateDocumentDeliveryStatus(env, ctx, OTHER_ID.delivery, {
        status: "DELIVERED",
      }),
  },
  {
    name: "invoice.setDeliveryProviderMessageId",
    kind: "tenant",
    run: (env, ctx) =>
      invoiceRepo.setDeliveryProviderMessageId(env, ctx, OWN_ID.delivery, "resend_msg_1"),
    crossTenant: (env, ctx) =>
      invoiceRepo.setDeliveryProviderMessageId(env, ctx, OTHER_ID.delivery, "resend_msg_1"),
  },
  {
    // 不達の一覧（画面の警告の材料）。
    name: "invoice.listFailedDeliveries",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.listFailedDeliveries(env, ctx, {}),
  },
  // ── P5-09 が足したもの（PK-SPEC-P5 §5）────────────────────
  {
    // 取消。**PDF に触らない**（元の PDF は閲覧できるまま / §5.2 MUST）。
    name: "invoice.voidInvoice",
    kind: "tenant",
    run: (env, ctx) =>
      invoiceRepo.voidInvoice(env, ctx, OWN_ID.invoice, { reason: "金額誤り", voidedAt: ctx.now }),
    crossTenant: (env, ctx) =>
      invoiceRepo.voidInvoice(env, ctx, OTHER_ID.invoice, {
        reason: "金額誤り",
        voidedAt: ctx.now,
      }),
  },
  // ── P5-08 が足したもの（PK-SPEC-P5 §4.2）──────────────────
  {
    // ① 入金の記録。**発行後・取消前のときだけ `PAID` へ進む。**
    name: "invoice.markInvoicePaid",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.markInvoicePaid(env, ctx, OWN_ID.invoice, ctx.now),
    crossTenant: (env, ctx) => invoiceRepo.markInvoicePaid(env, ctx, OTHER_ID.invoice, ctx.now),
  },
  {
    // ③ 領収書の発行。**印紙の列を持たない**（billing.md §3）。
    name: "invoice.createReceipt",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.createReceipt(env, ctx, CREATE_RECEIPT_INPUT(OWN_ID)),
    crossTenant: (env, ctx) => invoiceRepo.createReceipt(env, ctx, CREATE_RECEIPT_INPUT(OTHER_ID)),
  },
  {
    name: "invoice.updateReceiptPdf",
    kind: "tenant",
    run: (env, ctx) =>
      invoiceRepo.updateReceiptPdf(env, ctx, OWN_ID.receipt, {
        pdfStorageKey: "receipts/x/RCP-2026-0018-r1.pdf",
        pdfSha256: "c".repeat(64),
      }),
    crossTenant: (env, ctx) =>
      invoiceRepo.updateReceiptPdf(env, ctx, OTHER_ID.receipt, {
        pdfStorageKey: "receipts/x/RCP-2026-0018-r1.pdf",
        pdfSha256: "c".repeat(64),
      }),
  },
  {
    name: "invoice.markReceiptSent",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.markReceiptSent(env, ctx, OWN_ID.receipt, ctx.now),
    crossTenant: (env, ctx) => invoiceRepo.markReceiptSent(env, ctx, OTHER_ID.receipt, ctx.now),
  },
  {
    name: "invoice.listInvoices",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.listInvoices(env, ctx, { counterpartyId: OWN_ID.counterparty }),
  },
  // P5-14 の組織ダッシュボードが読む金額（PK-SPEC-P5 §7.1 / DECISIONS #132）。
  {
    name: "invoice.sumInvoiceLineAmountsByProperty",
    kind: "tenant",
    run: (env, ctx) =>
      invoiceRepo.sumInvoiceLineAmountsByProperty(env, ctx, {
        from: "2026-09-01",
        to: "2026-09-30",
      }),
  },
  {
    name: "invoice.findInvoiceById",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.findInvoiceById(env, ctx, OWN_ID.invoice),
    crossTenant: (env, ctx) => invoiceRepo.findInvoiceById(env, ctx, OTHER_ID.invoice),
  },
  {
    name: "invoice.listInvoiceLines",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.listInvoiceLines(env, ctx, OWN_ID.invoice),
    crossTenant: (env, ctx) => invoiceRepo.listInvoiceLines(env, ctx, OTHER_ID.invoice),
  },
  {
    name: "invoice.listInvoiceTaxSummaries",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.listInvoiceTaxSummaries(env, ctx, OWN_ID.invoice),
    crossTenant: (env, ctx) => invoiceRepo.listInvoiceTaxSummaries(env, ctx, OTHER_ID.invoice),
  },
  {
    name: "invoice.listReceipts",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.listReceipts(env, ctx, { counterpartyId: OWN_ID.counterparty }),
  },
  {
    name: "invoice.findReceiptById",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.findReceiptById(env, ctx, OWN_ID.receipt),
    crossTenant: (env, ctx) => invoiceRepo.findReceiptById(env, ctx, OTHER_ID.receipt),
  },
  {
    name: "invoice.listDocumentDeliveries",
    kind: "tenant",
    run: (env, ctx) =>
      invoiceRepo.listDocumentDeliveries(env, ctx, {
        docType: "INVOICE",
        documentId: OWN_ID.invoice,
      }),
    crossTenant: (env, ctx) =>
      invoiceRepo.listDocumentDeliveries(env, ctx, {
        docType: "INVOICE",
        documentId: OTHER_ID.invoice,
      }),
  },
  {
    name: "invoice.findDocumentDeliveryById",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.findDocumentDeliveryById(env, ctx, OWN_ID.delivery),
    crossTenant: (env, ctx) => invoiceRepo.findDocumentDeliveryById(env, ctx, OTHER_ID.delivery),
  },
  {
    name: "invoice.listBillingPeriods",
    kind: "tenant",
    run: (env, ctx) =>
      invoiceRepo.listBillingPeriods(env, ctx, { counterpartyId: OWN_ID.counterparty }),
  },
  {
    name: "invoice.findBillingPeriodById",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.findBillingPeriodById(env, ctx, OWN_ID.billingPeriod),
    crossTenant: (env, ctx) => invoiceRepo.findBillingPeriodById(env, ctx, OTHER_ID.billingPeriod),
  },
  // ── P5-05 が足したもの（PK-SPEC-P5 §2.8・§6.1）────────────
  {
    // 冪等。同じ期間で 2 回呼んでも 1 行（`uq_period`）。
    name: "invoice.ensureBillingPeriod",
    kind: "tenant",
    run: (env, ctx) =>
      invoiceRepo.ensureBillingPeriod(env, ctx, {
        counterpartyId: OWN_ID.counterparty,
        periodFrom: "2026-09-01",
        periodTo: "2026-09-30",
      }),
    crossTenant: (env, ctx) =>
      invoiceRepo.ensureBillingPeriod(env, ctx, {
        counterpartyId: OTHER_ID.counterparty,
        periodFrom: "2026-09-01",
        periodTo: "2026-09-30",
      }),
  },
  {
    // 楽観ロック付き。**状態機械の判定は `@pk/billing` 側。**
    name: "invoice.updateBillingPeriodStatus",
    kind: "tenant",
    run: (env, ctx) =>
      invoiceRepo.updateBillingPeriodStatus(
        env,
        ctx,
        OWN_ID.billingPeriod,
        { status: "REVIEWING", aggregatedAt: ctx.now },
        "OPEN",
      ),
    crossTenant: (env, ctx) =>
      invoiceRepo.updateBillingPeriodStatus(
        env,
        ctx,
        OTHER_ID.billingPeriod,
        { status: "REVIEWING", aggregatedAt: ctx.now },
        "OPEN",
      ),
  },
  // ── P5-12 が足したもの（双方合意の履歴 / PK-SPEC-P5 §6.2）──
  {
    // **追記だけ。** 更新も削除も無い（DECISIONS #127）。
    name: "invoice.appendBillingPeriodReview",
    kind: "tenant",
    run: (env, ctx) =>
      invoiceRepo.appendBillingPeriodReview(env, ctx, {
        billingPeriodId: OWN_ID.billingPeriod,
        action: "REJECT",
        comment: "9/15 の 3 室は当方都合でキャンセルしています。",
        lineComments: [],
        linesSnapshot: [],
        snapshotTotalAmount: 0,
        statusBefore: "REVIEWING",
        statusAfter: "REVIEWING",
        byCounterparty: true,
        actorId: OWN_ID.membership,
      }),
    crossTenant: (env, ctx) =>
      invoiceRepo.appendBillingPeriodReview(env, ctx, {
        billingPeriodId: OTHER_ID.billingPeriod,
        action: "REJECT",
        comment: "9/15 の 3 室は当方都合でキャンセルしています。",
        lineComments: [],
        linesSnapshot: [],
        snapshotTotalAmount: 0,
        statusBefore: "REVIEWING",
        statusAfter: "REVIEWING",
        byCounterparty: true,
        actorId: OWN_ID.membership,
      }),
  },
  {
    name: "invoice.listBillingPeriodReviews",
    kind: "tenant",
    run: (env, ctx) => invoiceRepo.listBillingPeriodReviews(env, ctx, OWN_ID.billingPeriod),
    crossTenant: (env, ctx) =>
      invoiceRepo.listBillingPeriodReviews(env, ctx, OTHER_ID.billingPeriod),
  },
  // P5-15 の請求状況が読む「最後に見せた明細の写し」（同 §7.2）。
  // **締めを集計し直さない**（`findLatestReviewSnapshotTotals()` の注記）。
  {
    name: "invoice.findLatestReviewSnapshotTotals",
    kind: "tenant",
    run: (env, ctx) =>
      invoiceRepo.findLatestReviewSnapshotTotals(env, ctx, [OWN_ID.billingPeriod]),
  },
  {
    name: "invoice.findBillingPeriodReviewById",
    kind: "tenant",
    run: (env, ctx) =>
      invoiceRepo.findBillingPeriodReviewById(env, ctx, OWN_ID.billingPeriodReview),
    crossTenant: (env, ctx) =>
      invoiceRepo.findBillingPeriodReviewById(env, ctx, OTHER_ID.billingPeriodReview),
  },
  // ── P4-06 / P4-07 / P4-10 が足したもの ────────────────────
  {
    // 状態ごとの件数（W-06 のヘッダー / §6.1）。施設は任意。
    name: "reconciliation.countFindingsByStatus",
    kind: "tenant",
    run: (env, ctx) =>
      reconciliationRepo.countFindingsByStatus(env, ctx, { propertyId: OWN_ID.property }),
  },
  {
    // 月ごと・重要度ごとの件数（月次監査レポート §7.1 の「2.」）。
    name: "reconciliation.countFindingsByMonth",
    kind: "tenant",
    run: (env, ctx) =>
      reconciliationRepo.countFindingsByMonth(env, ctx, {
        propertyId: OWN_ID.property,
        from: "2025-10-01",
        to: "2026-09-30",
      }),
    crossTenant: (env, ctx) =>
      reconciliationRepo.countFindingsByMonth(env, ctx, {
        propertyId: OTHER_ID.property,
        from: "2025-10-01",
        to: "2026-09-30",
      }),
  },
  {
    // 抑制された差異の件数（§4.3）。
    name: "reconciliation.sumSuppressedFindings",
    kind: "tenant",
    run: (env, ctx) =>
      reconciliationRepo.sumSuppressedFindings(env, ctx, { propertyId: OWN_ID.property }),
  },
  {
    name: "reconciliation.updateFindingStatus",
    kind: "tenant",
    run: (env, ctx) =>
      reconciliationRepo.updateFindingStatus(env, ctx, {
        findingId: OWN_ID.finding,
        status: "REVIEWING",
        resolutionCode: null,
        resolutionNote: null,
        resolvedById: OWN_ID.membership,
      }),
    crossTenant: (env, ctx) =>
      reconciliationRepo.updateFindingStatus(env, ctx, {
        findingId: OTHER_ID.finding,
        status: "REVIEWING",
        resolutionCode: null,
        resolutionNote: null,
        resolvedById: OWN_ID.membership,
      }),
  },
  {
    name: "reconciliation.insertDetectionFeedback",
    kind: "tenant",
    run: (env, ctx) =>
      reconciliationRepo.insertDetectionFeedback(env, ctx, {
        propertyId: OWN_ID.property,
        roomId: OWN_ID.room,
        ruleCode: "R001",
        outcome: "FALSE_POSITIVE",
        reasonCode: "DATA_ERROR",
      }),
    crossTenant: (env, ctx) =>
      reconciliationRepo.insertDetectionFeedback(env, ctx, {
        propertyId: OTHER_ID.property,
        roomId: OTHER_ID.room,
        ruleCode: "R001",
        outcome: "FALSE_POSITIVE",
        reasonCode: "DATA_ERROR",
      }),
  },
  {
    // 監査ログの読み取り（R010 / R014 の根拠 / PK-SPEC-P4 §3.8・§3.10）。
    name: "audit.listAuditLogs",
    kind: "tenant",
    run: (env, ctx) =>
      auditRepo.listAuditLogs(env, ctx, {
        propertyId: OWN_ID.property,
        actions: ["room.statusOverridden"],
        from: new Date("2026-09-01T00:00:00Z"),
        to: new Date("2026-09-10T00:00:00Z"),
      }),
    crossTenant: (env, ctx) =>
      auditRepo.listAuditLogs(env, ctx, {
        propertyId: OTHER_ID.property,
        actions: ["room.statusOverridden"],
        from: new Date("2026-09-01T00:00:00Z"),
        to: new Date("2026-09-10T00:00:00Z"),
      }),
  },
  {
    // 期間ぶんの稼働記録（R004 の「その間に他の稼働記録がない」/ §3.5）。
    name: "occupancy.listOccupancyInRange",
    kind: "tenant",
    run: (env, ctx) =>
      occupancyRepo.listOccupancyInRange(env, ctx, {
        propertyId: OWN_ID.property,
        from: "2026-09-01",
        to: "2026-09-09",
      }),
    crossTenant: (env, ctx) =>
      occupancyRepo.listOccupancyInRange(env, ctx, {
        propertyId: OTHER_ID.property,
        from: "2026-09-01",
        to: "2026-09-09",
      }),
  },
  {
    // ルール設定（W-25 / PK-SPEC-P4 §2.7）。**行が無ければ作る。**
    name: "reconciliation.upsertRuleConfig",
    kind: "tenant",
    run: (env, ctx) =>
      reconciliationRepo.upsertRuleConfig(env, ctx, {
        propertyId: OWN_ID.property,
        ruleCode: "R001",
        isEnabled: false,
        severityOverride: null,
        thresholds: {},
      }),
    crossTenant: (env, ctx) =>
      reconciliationRepo.upsertRuleConfig(env, ctx, {
        propertyId: OTHER_ID.property,
        ruleCode: "R001",
        isEnabled: false,
        severityOverride: null,
        thresholds: {},
      }),
  },
  {
    name: "reconciliation.createRoomAccessLog",
    kind: "tenant",
    run: (env, ctx) =>
      reconciliationRepo.createRoomAccessLog(env, ctx, ACCESS_LOG_INPUT(OWN_ID)),
    crossTenant: (env, ctx) =>
      reconciliationRepo.createRoomAccessLog(env, ctx, ACCESS_LOG_INPUT(OTHER_ID)),
  },

  // ── P6-01 / P6-04。外部連携（PK-SPEC-P6 §2・§4.2）───────────
  {
    name: "integration.listIntegrations",
    kind: "tenant",
    run: (env, ctx) => integrationRepo.listIntegrations(env, ctx, { kind: "SMART_LOCK" }),
  },
  {
    name: "integration.listOrgWideIntegrations",
    kind: "tenant",
    run: (env, ctx) => integrationRepo.listOrgWideIntegrations(env, ctx, "PMS"),
  },
  {
    name: "integration.findIntegrationById",
    kind: "tenant",
    run: (env, ctx) => integrationRepo.findIntegrationById(env, ctx, OWN_ID.integration),
    crossTenant: (env, ctx) => integrationRepo.findIntegrationById(env, ctx, OTHER_ID.integration),
  },
  {
    name: "integration.createIntegration",
    kind: "tenant",
    run: (env, ctx) =>
      integrationRepo.createIntegration(env, ctx, {
        propertyId: OWN_ID.property,
        kind: "SMART_LOCK",
        vendorCode: "api-generic",
        displayName: "汎用 Webhook",
      }),
    crossTenant: (env, ctx) =>
      integrationRepo.createIntegration(env, ctx, {
        propertyId: OTHER_ID.property,
        kind: "SMART_LOCK",
        vendorCode: "api-generic",
        displayName: "汎用 Webhook",
      }),
  },
  {
    name: "integration.markIntegrationSynced",
    kind: "tenant",
    run: (env, ctx) =>
      integrationRepo.markIntegrationSynced(env, ctx, {
        integrationId: OWN_ID.integration,
        ok: true,
      }),
    crossTenant: (env, ctx) =>
      integrationRepo.markIntegrationSynced(env, ctx, {
        integrationId: OTHER_ID.integration,
        ok: false,
      }),
  },
  {
    // P6-13: 送信 Webhook（§6.4）。
    name: "outboundWebhook.createOutboundWebhook",
    kind: "tenant",
    run: (env, ctx) =>
      outboundWebhookRepo.createOutboundWebhook(env, ctx, {
        url: "https://example.test/hook",
        secretRef: "cred:x",
        events: ["invoice.issued"],
      }),
  },
  {
    name: "outboundWebhook.listOutboundWebhooks",
    kind: "tenant",
    run: (env, ctx) => outboundWebhookRepo.listOutboundWebhooks(env, ctx),
  },
  {
    name: "outboundWebhook.listActiveOutboundWebhooks",
    kind: "tenant",
    run: (env, ctx) => outboundWebhookRepo.listActiveOutboundWebhooks(env, ctx),
  },
  {
    name: "outboundWebhook.findOutboundWebhookById",
    kind: "tenant",
    run: (env, ctx) =>
      outboundWebhookRepo.findOutboundWebhookById(env, ctx, OWN_ID.outboundWebhook),
    crossTenant: (env, ctx) =>
      outboundWebhookRepo.findOutboundWebhookById(env, ctx, OTHER_ID.outboundWebhook),
  },
  {
    name: "outboundWebhook.markOutboundDelivered",
    kind: "tenant",
    run: (env, ctx) =>
      outboundWebhookRepo.markOutboundDelivered(env, ctx, OWN_ID.outboundWebhook),
    crossTenant: (env, ctx) =>
      outboundWebhookRepo.markOutboundDelivered(env, ctx, OTHER_ID.outboundWebhook),
  },
  {
    name: "outboundWebhook.markOutboundFailed",
    kind: "tenant",
    run: (env, ctx) => outboundWebhookRepo.markOutboundFailed(env, ctx, OWN_ID.outboundWebhook),
    crossTenant: (env, ctx) =>
      outboundWebhookRepo.markOutboundFailed(env, ctx, OTHER_ID.outboundWebhook),
  },
  {
    name: "outboundWebhook.deactivateOutboundWebhook",
    kind: "tenant",
    run: (env, ctx) =>
      outboundWebhookRepo.deactivateOutboundWebhook(env, ctx, OWN_ID.outboundWebhook),
    crossTenant: (env, ctx) =>
      outboundWebhookRepo.deactivateOutboundWebhook(env, ctx, OTHER_ID.outboundWebhook),
  },
  {
    name: "outboundWebhook.reactivateOutboundWebhook",
    kind: "tenant",
    run: (env, ctx) =>
      outboundWebhookRepo.reactivateOutboundWebhook(env, ctx, OWN_ID.outboundWebhook),
    crossTenant: (env, ctx) =>
      outboundWebhookRepo.reactivateOutboundWebhook(env, ctx, OTHER_ID.outboundWebhook),
  },
  {
    // P6-12: 公開 API のキー（§6.1）。
    name: "apiKey.createApiKey",
    kind: "tenant",
    run: (env, ctx) =>
      apiKeyRepo.createApiKey(env, ctx, {
        name: "テスト",
        keyPrefix: `pk_live_${ctx.orgShortId}`,
        keyHash: "0".repeat(64),
        scopes: ["tasks:read"],
        propertyIds: null,
        createdById: OWN_ID.membership,
      }),
    crossTenant: (env, ctx) =>
      apiKeyRepo.createApiKey(env, ctx, {
        name: "テスト",
        keyPrefix: `pk_live_${ctx.orgShortId}`,
        keyHash: "0".repeat(64),
        scopes: ["tasks:read"],
        // **他組織の施設 ID を混ぜたキーを作れない。**
        propertyIds: [OTHER_ID.property],
        createdById: OWN_ID.membership,
      }),
  },
  {
    name: "apiKey.listApiKeys",
    kind: "tenant",
    run: (env, ctx) => apiKeyRepo.listApiKeys(env, ctx),
  },
  {
    name: "apiKey.findApiKeyByHash",
    kind: "tenant",
    run: (env, ctx) => apiKeyRepo.findApiKeyByHash(env, ctx, "0".repeat(64)),
  },
  {
    name: "apiKey.revokeApiKey",
    kind: "tenant",
    run: (env, ctx) => apiKeyRepo.revokeApiKey(env, ctx, OWN_ID.apiKey),
    crossTenant: (env, ctx) => apiKeyRepo.revokeApiKey(env, ctx, OTHER_ID.apiKey),
  },
  {
    name: "apiKey.touchApiKeyLastUsed",
    kind: "tenant",
    run: (env, ctx) => apiKeyRepo.touchApiKeyLastUsed(env, ctx, OWN_ID.apiKey),
    crossTenant: (env, ctx) => apiKeyRepo.touchApiKeyLastUsed(env, ctx, OTHER_ID.apiKey),
  },
  {
    // P6-09: 通知の宛先（§5.1）。**組織全体で引く。**
    name: "notification.listNotificationRecipients",
    kind: "tenant",
    run: (env, ctx) =>
      notificationRepo.listNotificationRecipients(env, ctx, {
        roles: ["ORG_ADMIN"],
        propertyId: null,
      }),
    crossTenant: (env, ctx) =>
      notificationRepo.listNotificationRecipients(env, ctx, {
        roles: ["PROPERTY_MANAGER"],
        propertyId: OTHER_ID.property,
      }),
  },
  {
    name: "notification.listNotificationPreferences",
    kind: "tenant",
    run: (env, ctx) =>
      notificationRepo.listNotificationPreferences(env, ctx, {
        membershipIds: [OWN_ID.membership],
        eventCode: "issue.critical",
      }),
  },
  {
    name: "notification.upsertNotificationPreference",
    kind: "tenant",
    run: (env, ctx) =>
      notificationRepo.upsertNotificationPreference(env, ctx, {
        membershipId: OWN_ID.membership,
        eventCode: "issue.critical",
        channels: ["EMAIL"],
      }),
    crossTenant: (env, ctx) =>
      notificationRepo.upsertNotificationPreference(env, ctx, {
        membershipId: OTHER_ID.membership,
        eventCode: "issue.critical",
        channels: ["EMAIL"],
      }),
  },
  {
    name: "notification.listDeliverablePushMembershipIds",
    kind: "tenant",
    run: (env, ctx) =>
      notificationRepo.listDeliverablePushMembershipIds(env, ctx, [OWN_ID.membership]),
  },
  {
    // P6-07: サーキットブレーカー（§3.4）。
    name: "integration.openIntegrationCircuit",
    kind: "tenant",
    run: (env, ctx) => integrationRepo.openIntegrationCircuit(env, ctx, OWN_ID.integration),
    crossTenant: (env, ctx) =>
      integrationRepo.openIntegrationCircuit(env, ctx, OTHER_ID.integration),
  },
  {
    name: "integration.reactivateIntegration",
    kind: "tenant",
    run: (env, ctx) => integrationRepo.reactivateIntegration(env, ctx, OWN_ID.integration),
    crossTenant: (env, ctx) =>
      integrationRepo.reactivateIntegration(env, ctx, OTHER_ID.integration),
  },
  {
    name: "integration.startSyncLog",
    kind: "tenant",
    run: (env, ctx) =>
      integrationRepo.startSyncLog(env, ctx, {
        integrationId: OWN_ID.integration,
        direction: "INBOUND",
        trigger: "WEBHOOK",
      }),
    crossTenant: (env, ctx) =>
      integrationRepo.startSyncLog(env, ctx, {
        integrationId: OTHER_ID.integration,
        direction: "INBOUND",
        trigger: "WEBHOOK",
      }),
  },
  {
    name: "integration.finishSyncLog",
    kind: "tenant",
    run: (env, ctx) =>
      integrationRepo.finishSyncLog(env, ctx, {
        syncLogId: OWN_ID.syncLog,
        status: "SUCCESS",
        startedAt: TEST_NOW,
      }),
    crossTenant: (env, ctx) =>
      integrationRepo.finishSyncLog(env, ctx, {
        syncLogId: OTHER_ID.syncLog,
        status: "SUCCESS",
        startedAt: TEST_NOW,
      }),
  },
  {
    name: "integration.listSyncLogs",
    kind: "tenant",
    run: (env, ctx) => integrationRepo.listSyncLogs(env, ctx, { integrationId: OWN_ID.integration }),
    crossTenant: (env, ctx) =>
      integrationRepo.listSyncLogs(env, ctx, { integrationId: OTHER_ID.integration }),
  },
  {
    // `rawSample` の保持 7 日（security.md §3）。**行そのものは消さない。**
    name: "integration.purgeSyncLogRawSamples",
    kind: "tenant",
    run: (env, ctx) => integrationRepo.purgeSyncLogRawSamples(env, ctx, TEST_NOW),
  },
  {
    name: "integration.listExternalMappings",
    kind: "tenant",
    run: (env, ctx) =>
      integrationRepo.listExternalMappings(env, ctx, { integrationId: OWN_ID.integration }),
    crossTenant: (env, ctx) =>
      integrationRepo.listExternalMappings(env, ctx, { integrationId: OTHER_ID.integration }),
  },
  {
    // **未マッピングを例外にしない**（PK-SPEC-P6 §2.3 MUST）。
    name: "integration.resolveExternalIds",
    kind: "tenant",
    run: (env, ctx) =>
      integrationRepo.resolveExternalIds(env, ctx, {
        integrationId: OWN_ID.integration,
        entityType: "ROOM",
        externalIds: ["LOCK-302"],
      }),
    crossTenant: (env, ctx) =>
      integrationRepo.resolveExternalIds(env, ctx, {
        integrationId: OTHER_ID.integration,
        entityType: "ROOM",
        externalIds: ["LOCK-302"],
      }),
  },
  {
    name: "integration.countUnmappedExternalIds",
    kind: "tenant",
    run: (env, ctx) =>
      integrationRepo.countUnmappedExternalIds(env, ctx, {
        integrationId: OWN_ID.integration,
        entityType: "ROOM",
        externalIds: ["LOCK-302", "LOCK-303"],
      }),
    crossTenant: (env, ctx) =>
      integrationRepo.countUnmappedExternalIds(env, ctx, {
        integrationId: OTHER_ID.integration,
        entityType: "ROOM",
        externalIds: ["LOCK-302"],
      }),
  },
  {
    name: "integration.listMappedInternalIds",
    kind: "tenant",
    run: (env, ctx) =>
      integrationRepo.listMappedInternalIds(env, ctx, {
        integrationId: OWN_ID.integration,
        entityType: "ROOM",
      }),
    crossTenant: (env, ctx) =>
      integrationRepo.listMappedInternalIds(env, ctx, {
        integrationId: OTHER_ID.integration,
        entityType: "ROOM",
      }),
  },
  {
    name: "integration.upsertExternalMappings",
    kind: "tenant",
    run: (env, ctx) =>
      integrationRepo.upsertExternalMappings(env, ctx, OWN_ID.integration, [
        { entityType: "ROOM", internalId: OWN_ID.room, externalId: "302" },
      ]),
    crossTenant: (env, ctx) =>
      integrationRepo.upsertExternalMappings(env, ctx, OWN_ID.integration, [
        { entityType: "ROOM", internalId: OTHER_ID.room, externalId: "302" },
      ]),
  },
  {
    name: "integration.deactivateExternalMapping",
    kind: "tenant",
    run: (env, ctx) =>
      integrationRepo.deactivateExternalMapping(env, ctx, OWN_ID.externalMapping),
    crossTenant: (env, ctx) =>
      integrationRepo.deactivateExternalMapping(env, ctx, OTHER_ID.externalMapping),
  },
  {
    // 物理シグナルの受信（PK-SPEC-P6 §4.2）。**重複は排除される。**
    name: "reconciliation.insertPhysicalSignals",
    kind: "tenant",
    run: (env, ctx) =>
      reconciliationRepo.insertPhysicalSignals(env, ctx, [
        {
          propertyId: OWN_ID.property,
          roomId: OWN_ID.room,
          businessDate: "2026-09-09",
          signalType: "DOOR_UNLOCK",
          occurredAt: TEST_NOW,
          deviceId: "LOCK-302",
        },
      ]),
    crossTenant: (env, ctx) =>
      reconciliationRepo.insertPhysicalSignals(env, ctx, [
        {
          propertyId: OTHER_ID.property,
          roomId: OTHER_ID.room,
          businessDate: "2026-09-09",
          signalType: "DOOR_UNLOCK",
          occurredAt: TEST_NOW,
          deviceId: "LOCK-302",
        },
      ]),
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

describe("発行済み帳票（PK-SPEC-P5 §2 / billing.md §2）", () => {
  // **物理削除しない。** 訂正は赤伝（マイナス伝票）＋再発行（§5）。
  // 「訂正・削除の履歴が残るシステム」方式の土台で、外部タイムスタンプを
  // 導入していないぶんここが効いている（billing.md §2）。
  it("invoice / receipt を DELETE するリポジトリ関数が無い", () => {
    for (const table of ["invoice", "receipt", "invoiceLine", "invoiceTaxSummary"]) {
      const offenders = repositorySources().filter(({ code }) =>
        new RegExp(`\\.delete\\(\\s*${table}\\b`).test(code),
      );
      expect(offenders.map(({ file }) => file), table).toEqual([]);
    }
  });

  it("invoice / receipt を対象にした SQL の delete が無い", () => {
    const offenders = repositorySources().filter(({ code }) =>
      /delete\s+from\s+["`']?(invoice|receipt|invoice_line|invoice_tax_summary)/i.test(code),
    );
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  // **送付ログも消さない**（誰にいつ送ったかは電子取引の記録そのもの）。
  it("document_delivery を DELETE するリポジトリ関数が無い", () => {
    const offenders = repositorySources().filter(({ code }) =>
      /\.delete\(\s*documentDelivery\b/.test(code),
    );
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  // **金額を書き換える更新関数を作らない**（invoice.ts 冒頭の注記）。
  // 金額が変わるのは赤伝を切って作り直したとき。
  //
  // ── ファイル単位から `set()` 単位へ変えた（P5-07）──────
  // 元は「`db.update(invoice)` と `totalAmount:` が同じファイルに在る」で
  // 見ていた。**発行（`createInvoice()`）が入った時点で成り立たなくなる**
  // — INSERT には当然 `totalAmount:` が要り、同じファイルに
  // `updateInvoicePdf()` の `db.update(invoice)` も在るため。
  // ファイルを分ければ通るが、それは検査を避けるための分割になる。
  // **見るべきは「UPDATE の `set()` に金額が載っているか」**なので、
  // そこだけを取り出して見る。INSERT は素通りする。
  it("請求書の金額を引数に取る更新関数が無い", () => {
    const setBlocks = /\.update\(\s*invoice\s*\)[\s\S]{0,200}?\.set\(\{([\s\S]*?)\}\)/g;
    const offenders = repositorySources().filter(({ code }) => {
      for (const match of code.matchAll(setBlocks)) {
        if (/(totalAmount|subtotalAmount|taxAmount)\s*:/.test(match[1] ?? "")) return true;
      }
      return false;
    });
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  // **取消が PDF に触らない**（§5.2 MUST「元の PDF は R2 に残し、
  // 閲覧できる状態を維持する」）。`status = VOIDED` を書く `set()` に
  // `pdfStorageKey` / `pdfSha256` が入っていないこと。
  it("請求書を取り消す更新関数が PDF の列に触らない", () => {
    const setBlocks = /\.update\(\s*invoice\s*\)[\s\S]{0,200}?\.set\(\{([\s\S]*?)\}\)/g;
    const offenders = repositorySources().filter(({ code }) => {
      for (const match of code.matchAll(setBlocks)) {
        const body = match[1] ?? "";
        if (/"VOIDED"/.test(body) && /(pdfStorageKey|pdfSha256)\s*:/.test(body)) return true;
      }
      return false;
    });
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  // 領収書も同じ（金額を `set()` に入れる更新関数を作らない）。
  it("領収書の金額を引数に取る更新関数が無い", () => {
    const setBlocks = /\.update\(\s*receipt\s*\)[\s\S]{0,200}?\.set\(\{([\s\S]*?)\}\)/g;
    const offenders = repositorySources().filter(({ code }) => {
      for (const match of code.matchAll(setBlocks)) {
        if (/(receivedAmount|totalAmount)\s*:/.test(match[1] ?? "")) return true;
      }
      return false;
    });
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  // 上の検査が本当に効いていることを確かめる（検査そのものの回帰）。
  // **`set()` に金額を入れた形を見逃さない。**
  it("金額を `set()` に入れた形なら上の検査が捕まえる", () => {
    const sample = `
      await db
        .update(invoice)
        .set({ totalAmount: 1, updatedAt: ctx.now })
        .where(eq(invoice.id, invoiceId));
    `;
    const setBlocks = /\.update\(\s*invoice\s*\)[\s\S]{0,200}?\.set\(\{([\s\S]*?)\}\)/g;
    const hit = [...sample.matchAll(setBlocks)].some((match) =>
      /(totalAmount|subtotalAmount|taxAmount)\s*:/.test(match[1] ?? ""),
    );
    expect(hit).toBe(true);
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
