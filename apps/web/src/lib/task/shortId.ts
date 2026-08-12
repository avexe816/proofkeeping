/**
 * タスクの直リンク用 `shortId`（8 桁）。
 *
 * task: docs/tasks/P1-01.md
 * 仕様: docs/PK-SPEC-P1.md §9.1（`/t/{shortId}`）
 *
 * ── なぜ ULID をそのまま使わないのか ────────────────────
 * `/t/{shortId}` は現場で口頭・紙・チャットに載る。26 桁の ULID は
 * 読み上げられない。8 桁は「読み上げられる長さ」と「同じ組織の
 * 1 日ぶんのタスクの中で衝突しない長さ」の折り合いで、仕様が定めた値。
 *
 * ── alphabet ────────────────────────────────────────────
 * `ORG_SHORT_ID_ALPHABET`（31 文字・`0 1 i l o` を除く）を借りる。
 * 同じ理由（人が読み・URL に載り・口頭で伝わる）で作られた表なので、
 * 別の表を作らない。31⁸ ≈ 8.5×10¹¹。
 *
 * ── 衝突 ────────────────────────────────────────────────
 * 一意制約は `(organizationId, shortId)`。**採番の時点で既存を避ける。**
 * 制約に任せると `onConflictDoNothing()` が黙って行を落とし、
 * 「生成したはずのタスクが無い」状態になる（`createTasks()` は
 * 一意制約の衝突を「既にある」と解釈するため区別できない）。
 */

import { ORG_SHORT_ID_ALPHABET } from "@pk/db";

/** 桁数。`packages/db` の `TASK_SHORT_ID_LENGTH` と同じ値。 */
export const SHORT_ID_LENGTH = 8;

/** 剰余バイアスを避けるための棄却境界（31 × 8 = 248）。 */
const REJECT_AT = Math.floor(256 / ORG_SHORT_ID_ALPHABET.length) * ORG_SHORT_ID_ALPHABET.length;

/** 乱数源。**テストでのみ差し替える。** */
export type RandomBytes = (size: number) => Uint8Array;

function cryptoRandomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

/** 候補を 1 つ作る。衝突チェックはしない。 */
function draw(randomBytes: RandomBytes): string {
  let out = "";
  // 棄却率 3.1%。実乱数なら 1〜2 回で埋まる。壊れたスタブで無限ループにしない。
  for (let attempt = 0; attempt < 32 && out.length < SHORT_ID_LENGTH; attempt++) {
    for (const byte of randomBytes(SHORT_ID_LENGTH * 2)) {
      if (out.length === SHORT_ID_LENGTH) break;
      if (byte >= REJECT_AT) continue;
      out += ORG_SHORT_ID_ALPHABET.charAt(byte % ORG_SHORT_ID_ALPHABET.length);
    }
  }
  if (out.length !== SHORT_ID_LENGTH) throw new Error("SHORT_ID_RANDOM_EXHAUSTED");
  return out;
}

/**
 * 既存と衝突しない `shortId` を採番する。
 *
 * `taken` は呼び出し側が持つ集合。**採番するたびに足していく**ので、
 * 1 回の生成バッチの中でも重複しない。
 *
 * @throws `SHORT_ID_EXHAUSTED` 32 回引いても空きが見つからなかった。
 *   31⁸ の空間で起きるなら `taken` の作り方を疑うべきで、黙って重複を返さない。
 */
export function nextShortId(taken: Set<string>, randomBytes: RandomBytes = cryptoRandomBytes): string {
  for (let attempt = 0; attempt < 32; attempt++) {
    const candidate = draw(randomBytes);
    if (taken.has(candidate)) continue;
    taken.add(candidate);
    return candidate;
  }
  throw new Error("SHORT_ID_EXHAUSTED");
}
