/**
 * `DocumentSequencer`（Durable Object）の呼び出し口。
 *
 * task:  docs/tasks/P0-17.md
 * ルール: .claude/rules/billing.md §5
 *
 * **番号が要る経路は必ずここを通す。** `env.DOCUMENT_SEQUENCER` を
 * 各所で直に叩くと、インスタンス名の組み立てが分かれて
 * 「同じ組織・同じ年度なのに別カウンタ」が生まれる。
 *
 * ── D1 の `document_sequence` は権威ではない ────────────
 * 採番の正は DO。`document_sequence`（P0-06）は監査と復元のための
 * 控えで、**そちらを読んで次の番号を決めないこと**（billing.md §5）。
 * 控えへの記録は帳票を発行する task（P5）が、発行トランザクションの
 * 中で行う。
 */

import {
  documentSequencerName,
  formatDocumentNumber,
  type DocumentType,
} from "@pk/billing";
import type { Env } from "@pk/db";

import { SEQUENCER_ORIGIN, type IssuedSequence } from "../../durable/DocumentSequencer.js";

/** 採番の要求。**組織 ID はセッションから解決したものを渡すこと。** */
export interface IssueDocumentNumberInput {
  organizationId: string;
  documentType: DocumentType;
  /** `fiscalYearOf(businessDate, taxProfile.fiscalYearStartMonth)` の結果。 */
  fiscalYear: number;
}

/** 採番の結果。 */
export interface IssuedDocumentNumber {
  /** 連番そのもの。`document_sequence.lastNumber` へ控える値。 */
  sequence: number;
  /** 帳票に載る文字列（`INV-2026-0042`）。 */
  documentNumber: string;
}

/**
 * 次の番号を払い出す。
 *
 * **冪等ではない。呼ぶたびに番号が進む。** 再試行で呼び直すと欠番になる
 * （billing.md §5 は欠番を許容する）。二重発行を防ぐのは発行 API 側の
 * `Idempotency-Key`（CLAUDE.md §5）であって、ここではない。
 */
export async function issueDocumentNumber(
  env: Env,
  input: IssueDocumentNumberInput,
): Promise<IssuedDocumentNumber> {
  const name = documentSequencerName(input.organizationId, input.documentType, input.fiscalYear);
  const stub = env.DOCUMENT_SEQUENCER.get(env.DOCUMENT_SEQUENCER.idFromName(name));

  const response = await stub.fetch(`${SEQUENCER_ORIGIN}/issue`, { method: "POST" });
  if (!response.ok) throw new Error("DOCUMENT_SEQUENCER_UNAVAILABLE");

  const body = await response.json<IssuedSequence>();
  return {
    sequence: body.sequence,
    documentNumber: formatDocumentNumber(input.documentType, input.fiscalYear, body.sequence),
  };
}
