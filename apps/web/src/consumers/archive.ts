/**
 * 年次アーカイブ（PK-SPEC-P0 §19.7 / P7-08）。**Queue コンシューマ。**
 *
 * task:  docs/tasks/P7-08.md
 * ルール: .claude/rules/architecture.md §5 / billing.md §2
 *
 * ```
 * 運用者の判断（`pnpm shards:usage` が warning / critical を出す）
 *   → QUEUE_ARCHIVE_RESTORE（kind: "ARCHIVE_EXPORT"）
 *     → ここ: 表ごとに JSONL → SHA-256 → gzip → R2 → archive_manifest
 * ```
 *
 * ── 「削除」ではなく「退避」（P7 固有の絶対ルール）──────
 * **この経路は D1 から行を外さない。** §19.7 の手順 3（`DELETE`）は
 * **退避が完了して、R2 の写しが検証できてから**の別工程にしてある
 * （docs/DECISIONS.md #159）。書き出しと取り外しを 1 つの実行に混ぜると、
 * R2 への書き込みが半分成功した状態で行が消えうる。
 *
 * ── 除外の判断をここに書かない ──────────────────────────
 * どの表を退避してよいかは `packages/db` の `archivePolicy.ts`。
 * **知らない表は既定で除外**（そちらの注記）。ここが独自に表を足せない
 * ようにするため、`ARCHIVABLE_TABLES` に無い名前は落とす。
 *
 * **実際に回すのは `DIRECTLY_ARCHIVABLE_TABLES`（5 表）。** §19.7 が挙げる
 * 9 表のうち、`businessDate` 列を自分で持つのはこの 5 表だけで、残り 4 表は
 * 親を辿らないと業務日が決まらない（docs/OPEN_QUESTIONS.md #096）。
 * **退避する表を減らす向きは安全側**（退避されない行は D1 に残るだけ）。
 *
 * ── 冪等（testing.md §4）─────────────────────────────────
 * 同じ年を 3 回退避しても、R2 は同じキーへ上書き、`archive_manifest` は
 * `uq_archive_manifest` で 1 行のまま。**`sha256` が毎回同じ**なら
 * 中身も同じ（行の並びを `id` で固定してある）。
 */

import {
  listArchiveTableRows,
  lookupOrganizationId,
  recordArchiveManifest,
  DIRECTLY_ARCHIVABLE_TABLES,
  archiveCutoffBusinessDate,
  archiveObjectKey,
  isArchivable,
  isDirectlyArchivable,
  toJsonl,
  type DirectlyArchivableTable,
  type Env,
  type TenantContext,
} from "@pk/db";

import { sha256HexOfText } from "../lib/evidence/hash.js";

/** キューへ載せるメッセージ。 */
export interface ArchiveExportMessage {
  kind: "ARCHIVE_EXPORT";
  orgShortId: string;
  /** 退避する年（西暦）。**その年の業務日だけを書き出す。** */
  year: number;
  /** 要求した時刻（ミリ秒）。**再送でも変わらない。** */
  requestedAtMs: number;
}

/** メッセージの形を確かめる。 */
export function isArchiveExportMessage(value: unknown): value is ArchiveExportMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message["kind"] === "ARCHIVE_EXPORT" &&
    typeof message["orgShortId"] === "string" &&
    message["orgShortId"].length > 0 &&
    typeof message["year"] === "number" &&
    Number.isInteger(message["year"]) &&
    typeof message["requestedAtMs"] === "number"
  );
}

/** 1 件の処理結果。 */
export type ArchiveExportOutcome =
  | {
      kind: "OK";
      /** 書き出した表の数。 */
      tables: number;
      /** 書き出した行の合計。 */
      rows: number;
    }
  /** 再送しても直らない。**ack して落とす。** */
  | { kind: "DROPPED"; reason: string }
  /** R2 / D1 の失敗。**retry。** */
  | { kind: "FAILED"; reason: string };

/**
 * 1 組織・1 年ぶんを退避する。
 *
 * **13 か月より新しい行を書き出さない。** `year` が新しすぎる場合は
 * その年の中でも境界より前だけを書く（`archiveCutoffBusinessDate()`）。
 */
export async function runArchiveExport(
  env: Env,
  message: ArchiveExportMessage,
): Promise<ArchiveExportOutcome> {
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

  const cutoff = archiveCutoffBusinessDate(now);
  // その年の終わりと、13 か月の境界の**早い方**まで。
  const yearEnd = `${String(message.year)}-12-31`;
  const effectiveCutoff = cutoff < yearEnd ? cutoff : yearEnd;
  const yearStart = `${String(message.year)}-01-01`;
  if (effectiveCutoff <= yearStart) {
    // その年はまだ 13 か月経っていない。**何も書き出さない。**
    return { kind: "DROPPED", reason: "WITHIN_RETENTION" };
  }

  let tables = 0;
  let rows = 0;
  try {
    for (const table of DIRECTLY_ARCHIVABLE_TABLES) {
      // **`archivePolicy.ts` の判断を 2 つとも通す。** ここで表を足せないようにする。
      // `isArchivable` は §19.7 の対象か、`isDirectlyArchivable` は
      // `businessDate` 列を自分で持つか。**片方でも偽なら書き出さない。**
      if (!isArchivable(table) || !isDirectlyArchivable(table)) continue;
      const written = await exportTable(env, ctx, {
        table,
        year: message.year,
        from: yearStart,
        to: effectiveCutoff,
      });
      tables += 1;
      rows += written;
    }
  } catch (error) {
    return { kind: "FAILED", reason: error instanceof Error ? error.name : "UNKNOWN" };
  }

  return { kind: "OK", tables, rows };
}

/**
 * 1 表ぶんを書き出す。
 *
 * ```
 * ① 行を読む（`id` 昇順。**並びを固定しないとハッシュが毎回変わる**）
 * ② JSONL へ
 * ③ SHA-256（**圧縮前**。復元側が中身を確かめる値）
 * ④ gzip
 * ⑤ R2 へ PUT
 * ⑥ archive_manifest へ記録
 * ```
 *
 * **0 行でも記録する。** 「その年その表は無かった」も事実で、
 * 記録が無いと「まだ退避していない」と区別できない。
 */
async function exportTable(
  env: Env,
  ctx: TenantContext,
  params: { table: DirectlyArchivableTable; year: number; from: string; to: string },
): Promise<number> {
  const rows = await listArchiveTableRows(env, ctx, {
    table: params.table,
    from: params.from,
    to: params.to,
  });

  const jsonl = toJsonl(rows);
  // **圧縮前のハッシュ。** gzip の出力は実装とレベルで変わりうるので、
  // 圧縮後を検証値にすると「同じ中身なのに一致しない」が起きる。
  const sha256 = await sha256HexOfText(jsonl);
  const body = await gzip(jsonl);

  const objectKey = archiveObjectKey({
    organizationId: ctx.organizationId,
    year: params.year,
    table: params.table,
  });

  await env.ARCHIVE.put(objectKey, body, {
    httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
    // **検証値をオブジェクト側にも持たせる。** R2 の一覧だけでも
    // どの退避か辿れるようにする（D1 が失われた場合の最後の手掛かり）。
    customMetadata: {
      sha256,
      rowCount: String(rows.length),
      cutoffBusinessDate: params.to,
    },
  });

  await recordArchiveManifest(env, ctx, {
    year: params.year,
    tableName: params.table,
    objectKey,
    rowCount: rows.length,
    sha256,
    sizeBytes: body.byteLength,
    cutoffBusinessDate: params.to,
  });

  return rows.length;
}

/**
 * gzip で圧縮する（§19.7 の `.jsonl.gz`）。
 *
 * **`CompressionStream` を使う。** Workers に zlib は無い。
 */
export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * バッチを処理する。
 *
 * **retry の遅延を付けない。** 年次の実行で、急いで再送する理由が無い。
 * Queue の既定に任せる。
 */
export async function handleArchiveExportBatch(env: Env, batch: MessageBatch): Promise<void> {
  for (const message of batch.messages) {
    if (!isArchiveExportMessage(message.body)) {
      console.error("archive-export-invalid-message");
      message.ack();
      continue;
    }
    const outcome = await runArchiveExport(env, message.body);
    if (outcome.kind === "FAILED") {
      console.error(`archive-export-failed reason=${outcome.reason}`);
      message.retry();
    } else {
      if (outcome.kind === "DROPPED") {
        console.error(`archive-export-skipped reason=${outcome.reason}`);
      }
      message.ack();
    }
  }
}
