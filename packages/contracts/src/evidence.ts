/**
 * 証跡スナップショットの応答（PK-SPEC-P2 §3.7 / §6.3）。
 *
 * task: docs/tasks/P2-08.md
 *
 * ── 書き込みのスキーマが 1 つも無い ─────────────────────
 * §3.7 の MUST は「`EvidenceSnapshot` は INSERT のみ。UPDATE / DELETE API を
 * 作らない」。証跡は**業務操作の副産物としてサーバーが書く**もので、
 * リクエストから payload を受け取る経路が存在しない。だから
 * `evidenceCreateRequestSchema` に当たるものをここへ置かない。
 * 訂正（§6.4）も「新しいスナップショットを追加する」操作で、
 * その入口は訂正の対象になる業務操作の側（P2-09 以降）にある。
 *
 * ── 「証拠」と書かない ──────────────────────────────────
 * 語彙は「証跡」（ui-writing.md §2）。英語のキー名も `evidence` で、
 * `proof` / `forensic` の類を使わない。
 */

import { z } from "zod";

import { businessDateSchema } from "./task.js";

/** 証跡の種別（§3.7 の `EvidenceType`）。`packages/db` と同じ並び。 */
export const EVIDENCE_TYPES = [
  "CLEANING_COMPLETION",
  "INSPECTION_PASS",
  "INSPECTION_FAIL",
  "REWORK_COMPLETION",
  "DAILY_REPORT",
] as const;

export const evidenceTypeSchema = z.enum(EVIDENCE_TYPES);

export type EvidenceTypeValue = (typeof EVIDENCE_TYPES)[number];

/**
 * 証跡 1 件の概要（W-07 / P2-09 が読む）。
 *
 * `payload` そのものは含めない。**正規化 JSON は再ハッシュに使う値**で、
 * 一覧に載せると 1 件あたりの応答が大きくなり、かつ画面が
 * `JSON.parse` → 再表示で並びを崩す誘惑が生まれる（ハッシュが再現しなくなる）。
 * 中身が要る画面は 1 件ずつ引く。
 */
export const evidenceSnapshotSchema = z.object({
  snapshotId: z.string(),
  taskId: z.string().nullable(),
  businessDate: businessDateSchema,
  evidenceType: evidenceTypeSchema,
  schemaVersion: z.string(),
  payloadSha256: z.string(),
  previousHash: z.string().nullable(),
  chainHash: z.string(),
  /** 訂正元（§6.4）。**元の行は残る。** */
  correctsSnapshotId: z.string().nullable(),
  correctionReason: z.string().nullable(),
  createdAt: z.number().int(),
});

export type EvidenceSnapshotSummary = z.infer<typeof evidenceSnapshotSchema>;

/**
 * 1 件の検証結果（§6.3「整合性を確認」）。
 *
 * 3 つを別々に返す。**どれが崩れたかで原因が違う。**
 *   `payloadMatches` 偽 … payload が書き換えられた
 *   `chainMatches`   偽 … `chainHash` が書き換えられた
 *   `linkMatches`    偽 … 途中の行が消された / 順序が入れ替えられた
 */
export const snapshotVerificationSchema = z.object({
  snapshotId: z.string(),
  evidenceType: evidenceTypeSchema,
  payloadMatches: z.boolean(),
  chainMatches: z.boolean(),
  linkMatches: z.boolean(),
  ok: z.boolean(),
});

export type SnapshotVerificationResult = z.infer<typeof snapshotVerificationSchema>;

/**
 * `GET /api/v1/tasks/:taskId/evidence/verify`（P2-09 が画面から呼ぶ）。
 *
 * **`ok` が偽のとき、どこから崩れているかを返す。** 全件を「壊れている」で
 * 塗ると、起点が読めず調査に使えない。
 */
export const evidenceVerifyResponseSchema = z.object({
  taskId: z.string(),
  ok: z.boolean(),
  firstBrokenSnapshotId: z.string().nullable(),
  snapshots: z.array(snapshotVerificationSchema),
});

export type EvidenceVerifyResponse = z.infer<typeof evidenceVerifyResponseSchema>;
