/**
 * 退避データの復元（PK-SPEC-P7 §9 / P7-09）。**Queue コンシューマ。**
 *
 * task: docs/tasks/P7-09.md
 *
 * ```
 * 管理者が期間と施設を指定して復元をリクエスト
 *   → QUEUE_ARCHIVE_RESTORE（kind: "ARCHIVE_RESTORE"）
 *     → ここ: archive_manifest → R2 → gunzip → JSONL → 一時テーブルへ展開
 *       → 完了を通知。7 日間閲覧可能
 * ```
 *
 * ── 「削除」ではなく「退避」（P7 固有の絶対ルール）──────
 * §9 MUST:「アーカイブは削除ではなく退避であることを UI で明示する。」
 * **この経路は R2 のオブジェクトにも `archive_manifest` にも触らない。**
 * 読むだけ。期限が来て消えるのは**復元した写し**（`archive_restore_row`）で、
 * 退避そのものは残り続ける。何度でも復元できる。
 *
 * ── 元の表へ書き戻さない ────────────────────────────────
 * **復元は閲覧のためであって、復旧ではない。** `cleaning_task` などへ
 * INSERT すると、現役の表に 13 か月前の行が混ざり、集計と業務日の前提が
 * 崩れる（`schema/integration.ts` の注記）。
 *
 * ── 部分的に読めた写しを「全部ある」と見せない ──────────
 * JSONL が 1 行でも壊れていたら `FAILED` にする（`parseJsonl()` が
 * `null` を返す）。**壊れた行だけ捨てて残りを見せない。** 欠けた記録を
 * 完全なものとして読ませるほうが危ない。
 *
 * ── 冪等（testing.md §4）─────────────────────────────────
 * 同じメッセージを 3 回処理しても、`PENDING` 以外の行は**着手しない**。
 * 2 回目以降は `DROPPED`（既に処理済み）になる。
 */

import {
  ARCHIVE_RESTORE_ROW_LIMIT,
  archiveRestoreExpiresAt,
  findArchiveRestoreById,
  insertArchiveRestoreRows,
  listArchiveManifests,
  lookupOrganizationId,
  parseJsonl,
  restoreYearsOf,
  updateArchiveRestoreStatus,
  type ArchiveRestoreRowInput,
  type Env,
  type TenantContext,
} from "@pk/db";

import { notify } from "./notify.js";

/** キューへ載せるメッセージ。 */
export interface ArchiveRestoreMessage {
  kind: "ARCHIVE_RESTORE";
  orgShortId: string;
  /** `archive_restore.id`。 */
  restoreId: string;
  /** 要求した時刻（ミリ秒）。**再送でも変わらない。** */
  requestedAtMs: number;
}

/** メッセージの形を確かめる。 */
export function isArchiveRestoreMessage(value: unknown): value is ArchiveRestoreMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message["kind"] === "ARCHIVE_RESTORE" &&
    typeof message["orgShortId"] === "string" &&
    message["orgShortId"].length > 0 &&
    typeof message["restoreId"] === "string" &&
    message["restoreId"].length > 0 &&
    typeof message["requestedAtMs"] === "number"
  );
}

/** 1 件の処理結果。 */
export type ArchiveRestoreOutcome =
  | { kind: "OK"; tables: number; rows: number }
  /** 再送しても直らない。**ack して落とす。** */
  | { kind: "DROPPED"; reason: string }
  /** R2 / D1 の失敗。**retry。** */
  | { kind: "FAILED"; reason: string };

/** gzip を解く。**`DecompressionStream` を使う**（Workers に zlib は無い）。 */
export async function gunzip(body: ArrayBuffer): Promise<string> {
  const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/**
 * 1 件の復元を実行する。
 *
 * `PENDING` の行だけを進める。**それ以外は何もしない**（冪等）。
 */
export async function runArchiveRestore(
  env: Env,
  message: ArchiveRestoreMessage,
): Promise<ArchiveRestoreOutcome> {
  const organizationId = await lookupOrganizationId(env, message.orgShortId);
  if (organizationId === null) return { kind: "DROPPED", reason: "ORGANIZATION_NOT_FOUND" };

  const now = new Date(message.requestedAtMs);
  const ctx: TenantContext = {
    organizationId,
    orgShortId: message.orgShortId,
    // バッチはセッションを持たない。**組織全体ロールで動く。**
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now,
  };

  const restore = await findArchiveRestoreById(env, ctx, message.restoreId);
  if (restore === undefined) return { kind: "DROPPED", reason: "RESTORE_NOT_FOUND" };
  // **着手済みなら何もしない。** 再送で二重に展開しないため。
  if (restore.status !== "PENDING") return { kind: "DROPPED", reason: "ALREADY_HANDLED" };

  try {
    await updateArchiveRestoreStatus(env, ctx, { id: restore.id, status: "RUNNING" });

    const manifests = await listArchiveManifests(env, ctx);
    const years = new Set(restoreYearsOf(restore.fromBusinessDate, restore.toBusinessDate));
    const targets = manifests.filter((manifest) => years.has(manifest.year));

    const collected: ArchiveRestoreRowInput[] = [];
    let tables = 0;

    for (const manifest of targets) {
      const object = await env.ARCHIVE.get(manifest.objectKey);
      // **退避の記録があるのに実体が無い。** 復元は失敗させる
      // （「その表は空だった」と見せない）。
      if (object === null) {
        await fail(env, ctx, restore.id, "ARCHIVE_OBJECT_MISSING", now);
        return { kind: "DROPPED", reason: "ARCHIVE_OBJECT_MISSING" };
      }

      const rows = parseJsonl(await gunzip(await object.arrayBuffer()));
      // **1 行でも壊れていたら全体を失敗させる**（冒頭の注記）。
      if (rows === null) {
        await fail(env, ctx, restore.id, "ARCHIVE_PAYLOAD_BROKEN", now);
        return { kind: "DROPPED", reason: "ARCHIVE_PAYLOAD_BROKEN" };
      }

      let matched = 0;
      for (const row of rows) {
        const businessDate = typeof row["businessDate"] === "string" ? row["businessDate"] : null;
        if (businessDate === null) continue;
        if (businessDate < restore.fromBusinessDate || businessDate > restore.toBusinessDate) {
          continue;
        }
        // 施設で絞る場合（§9.1「期間と施設を指定して」）。
        if (restore.propertyId !== null && row["propertyId"] !== restore.propertyId) continue;

        collected.push({
          tableName: manifest.tableName,
          businessDate,
          payload: JSON.stringify(row),
        });
        matched += 1;

        // **上限で黙って切り詰めない。** 途中までの写しを「全部ある」と
        // 見せるより、失敗として返すほうが安全。
        if (collected.length > ARCHIVE_RESTORE_ROW_LIMIT) {
          await fail(env, ctx, restore.id, "TOO_MANY_ROWS", now);
          return { kind: "DROPPED", reason: "TOO_MANY_ROWS" };
        }
      }
      if (matched > 0) tables += 1;
    }

    await insertArchiveRestoreRows(env, ctx, restore.id, collected);

    // **`expiresAt` は READY になった時点から 7 日**（§9.2）。
    // 要求した時点からにすると、待ち行列が長いぶん閲覧できる時間が削られる。
    await updateArchiveRestoreStatus(env, ctx, {
      id: restore.id,
      status: "READY",
      tableCount: tables,
      rowCount: collected.length,
      expiresAt: archiveRestoreExpiresAt(now),
      completedAt: now,
      errorCode: null,
    });

    // §9.1 の手順 4「完了をメール通知」。
    await notify(env, {
      orgShortId: ctx.orgShortId,
      eventCode: "archive.restore_ready",
      propertyId: restore.propertyId,
      subject: "退避データの復元が終わりました",
      summary: `${restore.fromBusinessDate} 〜 ${restore.toBusinessDate} の ${String(collected.length)} 件を 7 日間ご覧いただけます`,
      linkPath: `/app/archive/${restore.id}`,
      dedupeKey: `archive-restore:${restore.id}`,
      requestedAtMs: message.requestedAtMs,
    });

    return { kind: "OK", tables, rows: collected.length };
  } catch (error) {
    // **状態を `PENDING` のままにしない。** retry で拾えるようにするが、
    // 何度も落ちる場合に「走りっぱなし」に見えるのを避ける。
    return { kind: "FAILED", reason: error instanceof Error ? error.name : "UNKNOWN" };
  }
}

/** 失敗を記録する。**理由は短い符号**（例外の文面を利用者に見せない）。 */
async function fail(
  env: Env,
  ctx: TenantContext,
  id: string,
  errorCode: string,
  now: Date,
): Promise<void> {
  await updateArchiveRestoreStatus(env, ctx, {
    id,
    status: "FAILED",
    errorCode,
    completedAt: now,
  });
}

/**
 * バッチを処理する。
 *
 * **retry の遅延を付けない。** 利用者が待っているが、急かしても
 * R2 と D1 が速くなるわけではない。Queue の既定に任せる。
 */
export async function handleArchiveRestoreBatch(env: Env, batch: MessageBatch): Promise<void> {
  for (const message of batch.messages) {
    if (!isArchiveRestoreMessage(message.body)) {
      console.error("archive-restore-invalid-message");
      message.ack();
      continue;
    }
    const outcome = await runArchiveRestore(env, message.body);
    if (outcome.kind === "FAILED") {
      console.error(`archive-restore-failed reason=${outcome.reason}`);
      message.retry();
      continue;
    }
    if (outcome.kind === "DROPPED") {
      console.error(`archive-restore-skipped reason=${outcome.reason}`);
    }
    message.ack();
  }
}
