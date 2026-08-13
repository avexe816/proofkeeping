/**
 * 証跡スナップショットのリポジトリ（PK-SPEC-P2 §3.7 / §6）。
 *
 * task: docs/tasks/P2-08.md
 * ルール: .claude/rules/architecture.md §2
 *
 * ── INSERT と SELECT しか無い ────────────────────────────
 * §3.7 の MUST は「`EvidenceSnapshot` は INSERT のみ。UPDATE / DELETE API を
 * 作らない」。**このファイルに `db.update(evidenceSnapshot)` /
 * `db.delete(evidenceSnapshot)` を書かないこと。**
 * `repositories.spec.ts` が全リポジトリのソースを走査して固定しており、
 * 書けば CI が落ちる。訂正は `correctsSnapshotId` を持つ新しい行を足す（§6.4）。
 *
 * ── ハッシュはここで計算しない ──────────────────────────
 * `payloadSha256` / `chainHash` は呼び出し側（`apps/web/src/lib/evidence/`）が
 * 計算して渡す。**リポジトリ層で計算すると、正規化 JSON の文字列と
 * ハッシュの対応がこの層に閉じてしまい**、検証（§6.3「整合性を確認」）が
 * 同じ経路を通れなくなる。この層は「渡された文字列をそのまま保存する」だけ。
 *
 * ── `payload` は文字列のまま扱う ────────────────────────
 * 正規化済みの JSON 文字列を保存する。**読み出して `JSON.parse` →
 * `JSON.stringify` を通さない。** 鍵の並びが変わって `payloadSha256` が
 * 再現しなくなる（`schema/inspection.ts` 冒頭の注記）。
 */

import { and, asc, desc, eq } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import {
  evidenceSnapshot,
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceType,
} from "../schema/inspection.js";

import { withTenantScope } from "./base.js";

/** `appendEvidenceSnapshot()` の入力。 */
export interface AppendEvidenceSnapshotInput {
  propertyId: string;
  /** 日報など、タスクに紐づかない証跡がある（§3.7）。 */
  taskId: string | null;
  /** 業務日 `YYYY-MM-DD`（architecture.md §7）。 */
  businessDate: string;
  evidenceType: EvidenceType;
  /** 正規化済み JSON の**文字列**。`canonicalJson()` の出力そのまま。 */
  payload: string;
  /** `sha256(payload)` の 16 進。 */
  payloadSha256: string;
  /** 同一タスク内の前スナップショットの `chainHash`。先頭は `null`。 */
  previousHash: string | null;
  /** `sha256(chainHashInput(previousHash, payloadSha256))` の 16 進。 */
  chainHash: string;
  /** 訂正元（§6.4）。**元の行は残る。** */
  correctsSnapshotId?: string | null | undefined;
  correctionReason?: string | null | undefined;
  /** 生成した `membership.id`。バッチ生成では `null`。 */
  createdById?: string | null | undefined;
  /** スキーマ版。省略時は現在の版（`EVIDENCE_SCHEMA_VERSION`）。 */
  schemaVersion?: string | undefined;
}

/**
 * 証跡を 1 件足す。**追記だけ。**
 *
 * 冪等の鍵を持たせていない。**同じ出来事の証跡が 2 件できないのは、
 * 呼び出し側の状態遷移が 1 回しか成功しないため**（`completeInspection()` は
 * `result IS NULL` の行にしか当たらず、`advanceReworkCycle()` は
 * `status = from` の行にしか当たらない）。証跡を書くのはその成功の後で、
 * 再送は遷移の段階で `NOOP` になる。ここに鍵を足すと、
 * 「同じ payload だが正当に 2 件」（訂正 / §6.4）を弾いてしまう。
 *
 * @returns 作った行の `id` と `chainHash`。
 */
export async function appendEvidenceSnapshot(
  env: Env,
  ctx: TenantContext,
  input: AppendEvidenceSnapshotInput,
): Promise<{ id: string; chainHash: string }> {
  assertIdBelongsToTenant(input.propertyId, ctx);
  if (input.taskId !== null) assertIdBelongsToTenant(input.taskId, ctx);
  const db = await getTenantDb(env, ctx);

  const id = generateId(ctx.orgShortId, "evd");
  await db.insert(evidenceSnapshot).values({
    id,
    organizationId: ctx.organizationId,
    propertyId: input.propertyId,
    taskId: input.taskId,
    businessDate: input.businessDate,
    evidenceType: input.evidenceType,
    schemaVersion: input.schemaVersion ?? EVIDENCE_SCHEMA_VERSION,
    payload: input.payload,
    payloadSha256: input.payloadSha256,
    previousHash: input.previousHash,
    chainHash: input.chainHash,
    correctsSnapshotId: input.correctsSnapshotId ?? null,
    correctionReason: input.correctionReason ?? null,
    createdAt: ctx.now,
    createdById: input.createdById ?? null,
  });

  return { id, chainHash: input.chainHash };
}

/**
 * タスク 1 件の証跡。**`createdAt` の昇順。**
 *
 * 連鎖は保存順にしか繋がらない（`verifyEvidenceChain()` は昇順を要求する）。
 * W-07（P2-09）と証跡 ZIP（P2-10）が同じ並びを使う。
 */
export async function listEvidenceSnapshotsByTask(
  env: Env,
  ctx: TenantContext,
  taskId: string,
) {
  assertIdBelongsToTenant(taskId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(evidenceSnapshot)
    .where(
      withTenantScope(
        evidenceSnapshot,
        ctx,
        evidenceSnapshot.propertyId,
        eq(evidenceSnapshot.taskId, taskId),
      ),
    )
    .orderBy(asc(evidenceSnapshot.createdAt), asc(evidenceSnapshot.id));
}

/**
 * そのタスクの直前の証跡（連鎖の `previousHash` に使う）。
 *
 * **`createdAt` の降順で 1 件。** 同一ミリ秒に 2 件入った場合は `id` で
 * 決める（ULID なので採番順になる）。`listEvidenceSnapshotsByTask()` の
 * 並びと逆順で一致させてある。**片方だけ変えないこと。**
 */
export async function findLatestEvidenceSnapshotByTask(
  env: Env,
  ctx: TenantContext,
  taskId: string,
) {
  assertIdBelongsToTenant(taskId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(evidenceSnapshot)
    .where(
      withTenantScope(
        evidenceSnapshot,
        ctx,
        evidenceSnapshot.propertyId,
        eq(evidenceSnapshot.taskId, taskId),
      ),
    )
    .orderBy(desc(evidenceSnapshot.createdAt), desc(evidenceSnapshot.id))
    .limit(1);
  return rows[0];
}

/** 証跡 1 件（W-07 / ZIP が引く）。 */
export async function findEvidenceSnapshotById(
  env: Env,
  ctx: TenantContext,
  snapshotId: string,
) {
  assertIdBelongsToTenant(snapshotId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(evidenceSnapshot)
    .where(
      withTenantScope(
        evidenceSnapshot,
        ctx,
        evidenceSnapshot.propertyId,
        eq(evidenceSnapshot.id, snapshotId),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * 施設・業務日・種別で引く（§3.7 の第 2 インデックス）。
 *
 * 日報（P2-14）と証跡一覧 W-06（P2-09）が使う。**種別は省略できる。**
 */
export async function listEvidenceSnapshotsByDate(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  businessDate: string,
  evidenceType?: EvidenceType,
) {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(evidenceSnapshot)
    .where(
      withTenantScope(
        evidenceSnapshot,
        ctx,
        evidenceSnapshot.propertyId,
        and(
          eq(evidenceSnapshot.propertyId, propertyId),
          eq(evidenceSnapshot.businessDate, businessDate),
          ...(evidenceType === undefined
            ? []
            : [eq(evidenceSnapshot.evidenceType, evidenceType)]),
        ),
      ),
    )
    .orderBy(asc(evidenceSnapshot.createdAt), asc(evidenceSnapshot.id));
}
