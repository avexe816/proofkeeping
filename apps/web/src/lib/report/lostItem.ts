/**
 * 忘れ物のユースケース（PK-SPEC-P2 §7）。
 *
 * task:  docs/tasks/P2-11.md
 * ルール: .claude/rules/security.md §1, §3
 *
 * ── §7.4 の絞りはここに 1 か所だけ ──────────────────────
 * 「`CLEANER`: 登録と自分が登録した内容の閲覧。保管場所や返却先は閲覧不可」。
 * `assertPermission("lostItem.read")` は施設までしか絞れないので、
 *   ① 一覧を `foundById = 自分` で絞る
 *   ② `storageLocation` を `null` にする
 * の 2 つをここで行う。**画面で絞る形にしないこと**（CLAUDE.md §5）。
 *
 * ── 自動廃棄をしない（§7.3 MUST）───────────────────────
 * 期限（`retentionDueAt`）を計算して保存するが、**それを見て状態を
 * 変える経路がどこにも無い。** `warningLevelFor()` は色を返すだけ。
 * このファイルに Cron / Queue から呼ぶ関数を足さないこと。
 */

import type { LostItemStatusValue, LostItemSummary } from "@pk/contracts";
import {
  advanceLostItem,
  createLostItem,
  findPropertyById,
  listLostItems,
  maxLostItemSequence,
  recordAudit,
  type Env,
  type LostItemFilter,
  type TenantContext,
} from "@pk/db";
import { lostItemManagementNo, retentionDueAtMs, warningLevelFor } from "@pk/engine";

import { can, propertyTarget } from "../auth/permission.js";

/**
 * 管理番号の採り直し回数（§7.2）。
 *
 * 採番は「その施設・その業務日の最大値 + 1」で、**同時登録が衝突しうる。**
 * UNIQUE 制約が守るので壊れはしないが、1 回で諦めると現場が
 * 「登録できない」に当たる。**3 回まで採り直す。**
 * それでも駄目なら `NUMBER_CONFLICT` を返し、画面が再送を促す。
 * `DocumentSequencer` を使わない理由は `repositories/lostItem.ts` の注記。
 */
const MAX_NUMBER_RETRIES = 3;

/** 登録の入力。**持ち主に関する値を 1 つも取らない。** */
export interface RegisterLostItemInput {
  propertyId: string;
  roomId: string;
  taskId: string | null;
  businessDate: string;
  category: LostItemSummary["category"];
  description: string;
  foundLocation: string;
  foundById: string;
  /** 施設の保持日数設定。**未設定なら `null`**（engine が既定を当てる）。 */
  propertyRetentionDays: number | null;
  ip?: string | undefined;
}

/** 登録の結果。 */
export type RegisterLostItemOutcome =
  | { kind: "CREATED"; lostItemId: string; managementNo: string }
  | { kind: "REJECTED"; error: "NUMBER_CONFLICT" };

/**
 * 忘れ物を登録する（§7.1 の「発見」〜「管理番号を自動採番」）。
 *
 * **監査ログを書かない。** security.md §6 の列挙に忘れ物の登録は無い。
 * 状態の履歴（`lostItemHistory`）が誰がいつ登録したかを持つ。
 * **監査へ回すのは移管だけ**（下の `recordTransferAudit()`）。
 */
export async function registerLostItem(
  env: Env,
  ctx: TenantContext,
  input: RegisterLostItemInput,
): Promise<RegisterLostItemOutcome> {
  const property = await findPropertyById(env, ctx, input.propertyId);
  const propertyCode = property?.code ?? "X";

  const dueAtMs = retentionDueAtMs(
    ctx.now.getTime(),
    input.category,
    input.propertyRetentionDays,
  );

  let sequence = (await maxLostItemSequence(env, ctx, input.propertyId, input.businessDate)) + 1;

  for (let attempt = 0; attempt < MAX_NUMBER_RETRIES; attempt++) {
    const managementNo = lostItemManagementNo(propertyCode, input.businessDate, sequence);
    const created = await createLostItem(env, ctx, {
      propertyId: input.propertyId,
      taskId: input.taskId,
      roomId: input.roomId,
      businessDate: input.businessDate,
      managementNo,
      category: input.category,
      description: input.description,
      foundAt: ctx.now,
      foundById: input.foundById,
      foundLocation: input.foundLocation,
      retentionDueAt: new Date(dueAtMs),
    });

    if (created.kind === "CREATED") {
      return { kind: "CREATED", lostItemId: created.lostItemId, managementNo };
    }
    // 衝突。**次の番号で採り直す。** 欠番は残るが、§7.2 は連番の
    // 連続性を要求していない（billing.md §5 の帳票番号とは違う）。
    sequence += 1;
  }

  return { kind: "REJECTED", error: "NUMBER_CONFLICT" };
}

/**
 * `INSPECTOR` が進めてよい遷移先（§7.4「保管済への更新」）。
 *
 * `PERMISSION_MATRIX` はロール × 操作までしか表せないので、
 * **遷移先ごとの絞りはここ**（`permission.ts` の `lostItem.manage` の注記）。
 */
const INSPECTOR_ALLOWED_TARGETS: readonly LostItemStatusValue[] = ["STORED"];

/** 状態変更の入力。 */
export interface ChangeLostItemStatusInput {
  lostItemId: string;
  /** 現在の状態。**呼び出し側が引いた行から渡す**（クライアントに申告させない）。 */
  from: LostItemStatusValue;
  to: LostItemStatusValue;
  propertyId: string;
  actorId: string;
  note: string | null;
  storageLocation?: string | null | undefined;
  policeReportNo?: string | null | undefined;
  disposalReason?: string | null | undefined;
  ip?: string | undefined;
}

/** 状態変更の結果。 */
export type ChangeLostItemStatusOutcome =
  | { kind: "ADVANCED" }
  | { kind: "REJECTED"; error: "INVALID_TRANSITION" | "DISPOSAL_REASON_REQUIRED" };

/**
 * 状態を進める（§7.1）。
 *
 * ── 廃棄には理由が要る ──────────────────────────────────
 * §7.3 MUST「期限が来ても責任者の明示操作が必要」。**何もせずに
 * `DISPOSED` へ進める形にすると、「明示操作」が押しただけになる。**
 * 理由を必須にして、後から誰が何の判断で捨てたかを辿れるようにする。
 *
 * ── 廃棄は監査ログへ回さない ────────────────────────────
 * security.md §6 の列挙に忘れ物は無く、**`AUDIT_ACTIONS` に当てはまる
 * action が無い。** 表を増やすと監査ログが業務操作の記録から
 * 「何でも置ける場所」へ広がる。廃棄は `lostItemHistory` に理由つきで
 * 残す。履歴は追記のみで UPDATE / DELETE の関数が無い
 * （`repositories.spec.ts` がソースで固定）ので、消せなさは監査ログと
 * 変わらない。移管（`TRANSFERRED`）だけは物が組織の外へ出るので
 * `export.data` として監査にも残す。判断は docs/DECISIONS.md #082。
 */
export async function changeLostItemStatus(
  env: Env,
  ctx: TenantContext,
  input: ChangeLostItemStatusInput,
): Promise<ChangeLostItemStatusOutcome> {
  if (ctx.role === "INSPECTOR" && !INSPECTOR_ALLOWED_TARGETS.includes(input.to)) {
    return { kind: "REJECTED", error: "INVALID_TRANSITION" };
  }
  if (input.to === "DISPOSED" && (input.disposalReason ?? "").trim() === "") {
    return { kind: "REJECTED", error: "DISPOSAL_REASON_REQUIRED" };
  }

  const result = await advanceLostItem(env, ctx, {
    lostItemId: input.lostItemId,
    from: input.from,
    to: input.to,
    actorId: input.actorId,
    // **理由を履歴の `note` へ落とす。** 品物の行（`disposalReason`）と
    // 履歴の両方に残す。行は上書きされうるが履歴は追記だけ。
    note: input.to === "DISPOSED" ? (input.disposalReason ?? null) : input.note,
    ...(input.storageLocation === undefined ? {} : { storageLocation: input.storageLocation }),
    ...(input.policeReportNo === undefined ? {} : { policeReportNo: input.policeReportNo }),
    ...(input.disposalReason === undefined ? {} : { disposalReason: input.disposalReason }),
  });

  if (result.kind === "NOOP") return { kind: "REJECTED", error: "INVALID_TRANSITION" };

  if (input.to === "TRANSFERRED") {
    await recordTransferAudit(env, ctx, {
      actorId: input.actorId,
      propertyId: input.propertyId,
      lostItemId: input.lostItemId,
      note: input.note,
    });
  }
  return { kind: "ADVANCED" };
}

/**
 * 一覧（§7.4 の絞りを掛けたもの）。
 *
 * **`CLEANER` は自分が登録したものだけ。** 呼び出し側が `filter` に
 * `foundById` を入れるのではなく、ここで上書きする。
 * 入れ忘れが「見えすぎる」方向に倒れないため。
 */
export async function listVisibleLostItems(
  env: Env,
  ctx: TenantContext,
  membershipId: string,
  filter: LostItemFilter,
): Promise<LostItemSummary[]> {
  const scoped: LostItemFilter =
    ctx.role === "CLEANER" ? { ...filter, foundById: membershipId } : filter;

  const rows = await listLostItems(env, ctx, scoped);
  return rows.map((row) => toLostItemSummary(ctx, row));
}

/**
 * 行 → 応答の形。**保管場所の出し分けはここだけ**（冒頭の注記）。
 *
 * `lostItem.readStorage` は security.md §1 の絶対境界そのもので、
 * `CLEANER` に `DENY` が入っている。**ロールを直接見ずに権限へ問う。**
 */
export function toLostItemSummary(
  ctx: TenantContext,
  row: {
    id: string;
    propertyId: string;
    roomId: string;
    businessDate: string;
    managementNo: string;
    category: LostItemSummary["category"];
    description: string;
    foundAt: Date;
    foundById: string;
    foundLocation: string;
    status: LostItemStatusValue;
    storageLocation: string | null;
    policeReportNo: string | null;
    ownerContactedAt: Date | null;
    retentionDueAt: Date | null;
  },
): LostItemSummary {
  const canReadStorage = can(ctx, "lostItem.readStorage", propertyTarget([row.propertyId]));
  const dueAtMs = row.retentionDueAt?.getTime() ?? null;

  return {
    lostItemId: row.id,
    propertyId: row.propertyId,
    roomId: row.roomId,
    businessDate: row.businessDate,
    managementNo: row.managementNo,
    category: row.category,
    description: row.description,
    foundAtMs: row.foundAt.getTime(),
    foundById: row.foundById,
    foundLocation: row.foundLocation,
    status: row.status,
    // §7.4。**`CLEANER` には保管場所も警察届出番号（返却先の手がかり）も返さない。**
    storageLocation: canReadStorage ? row.storageLocation : null,
    policeReportNo: canReadStorage ? row.policeReportNo : null,
    ownerContactedAtMs: row.ownerContactedAt?.getTime() ?? null,
    retentionDueAtMs: dueAtMs,
    warningLevel:
      dueAtMs === null
        ? "NORMAL"
        : warningLevelFor(row.category, dueAtMs, ctx.now.getTime()),
  };
}

/**
 * 移管（`TRANSFERRED`）を監査ログへ残す。
 *
 * **物が組織の外へ出る操作**なので、`export.data`（security.md §6 の
 * 「データエクスポート」）として残す。廃棄（`DISPOSED`）を監査に
 * 残さないのは、履歴が理由つきで追記されるため（DECISIONS #082）。
 * 移管は受け渡し先が組織の外にあり、**社内の履歴だけでは辿れない。**
 */
async function recordTransferAudit(
  env: Env,
  ctx: TenantContext,
  input: { actorId: string; propertyId: string; lostItemId: string; note: string | null },
): Promise<void> {
  await recordAudit(env, ctx, {
    actorId: input.actorId,
    action: "export.data",
    targetType: "lostItem",
    targetId: input.lostItemId,
    propertyId: input.propertyId,
    after: { transferred: true, note: input.note },
  });
}
