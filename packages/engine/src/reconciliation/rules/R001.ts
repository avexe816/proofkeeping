/**
 * R001 — 稼働記録のない使用痕跡（PK-SPEC-P4 §3.2）。**純粋関数。**
 *
 * task: docs/tasks/P4-04.md
 *
 * ```
 * 稼働記録では空室（A） × 清掃時に使用の痕跡（B）
 * ```
 *
 * ── これは不正の認定ではない ────────────────────────────
 * §1.1。差異の原因には設備の不具合・業務上の例外・記録漏れが含まれる。
 * 出すのは**「記録と現場が食い違っている」という事実**だけで、
 * 原因の判断は人間が行う。文言に「不正」「疑わしい」を出さない
 * （ui-writing.md §2）。
 *
 * ── 痕跡の数がそのまま確信度になる ──────────────────────
 * `35 + シグナル数 × 15`（§3.2）。ベッドだけが使われていた（1 つ）と、
 * ベッド・ゴミ・タオル・バスマットが揃っている（4 つ）を同じ確信度で
 * 出さない。**1 つしか無いものは 79 で頭打ちになる**（§1.3 の単一シグナル
 * 上限。掛けるのは `confidence.ts` で、ここではない）。
 *
 * ── 抑制はここで完結していない ──────────────────────────
 * 冒頭の早期 return は §3.2 のコードそのままだが、`MAINTENANCE` /
 * 入室記録 / 自社利用は `evaluate()` が**呼ぶ前に**抑制する（§4.1）。
 * ここに残してあるのは、ルール単体で呼んでも同じ結論になるようにするため。
 * **消さないこと。** 抑制の経路を通らない呼び出し（テスト・将来の再評価）で
 * 差異が出てしまう。
 */

import type { FindingDraft, ObservationFact, Rule, RuleContext } from "../types.js";

/** ゴミが「あった」と読む水準（§3.2）。`LOW` は差異の根拠にしない。 */
const TRASH_PRESENT: ReadonlySet<ObservationFact["trashLevel"]> = new Set<
  ObservationFact["trashLevel"]
>(["NORMAL", "HIGH"]);

/** 確信度の基点と 1 シグナルあたりの加算、および上限（§3.2）。 */
export const R001_BASE_CONFIDENCE = 35;
export const R001_CONFIDENCE_PER_SIGNAL = 15;
export const R001_MAX_CONFIDENCE = 95;

/**
 * アメニティが 1 つでも使われているか。
 *
 * 値は「個数」または「使ったか」（PK-SPEC-P3 §2.1）。**両方の形を受ける。**
 * 数え方を型で強制していないのは観察項目が施設ごとに違うため（同 §2.6）。
 */
export function hasAnyAmenityUsed(
  amenitiesUsed: Readonly<Record<string, number | boolean>>,
): boolean {
  return Object.values(amenitiesUsed).some((value) =>
    typeof value === "boolean" ? value : value > 0,
  );
}

/**
 * 使用の痕跡を数える。**並びは固定。** §10.1 の決定性のため、
 * `Object.keys()` の順に依存する数え方をしない。
 */
export function matchedSignalsOf(observation: ObservationFact): string[] {
  const signals: string[] = [];
  if (observation.bedsUsed >= 1) signals.push("BEDS_USED");
  if (TRASH_PRESENT.has(observation.trashLevel)) signals.push("TRASH_PRESENT");
  if (observation.bathTowelUsed >= 1) signals.push("TOWEL_USED");
  if (observation.bathMatUsed >= 1) signals.push("BATHMAT_USED");
  if (hasAnyAmenityUsed(observation.amenitiesUsed)) signals.push("AMENITY_USED");
  return signals;
}

export const R001: Rule = {
  code: "R001",
  version: "1.0",
  title: "稼働記録のない使用痕跡",
  requires: ["occupancy", "observation"],

  evaluate(context: RuleContext): FindingDraft | null {
    const { occupancy, observation, room, accessLogs } = context;

    // 稼働記録が「空室」でなければ差異ではない。**記録が無い日は R006 の担当。**
    if (occupancy === null || occupancy.isOccupied) return null;
    if (occupancy.isHouseUse || occupancy.isComplimentary) return null;
    // **記録しなかったことを差異にしない**（PK-SPEC-P3 §1.3）。
    if (observation === null || observation.skipped) return null;
    if (room.saleStatus === "MAINTENANCE" || room.saleStatus === "OUT_OF_ORDER") return null;
    if (accessLogs.length > 0) return null; // 正当な入室が登録済み

    const signals = matchedSignalsOf(observation);
    if (signals.length === 0) return null;

    const confidence = Math.min(
      R001_MAX_CONFIDENCE,
      R001_BASE_CONFIDENCE + signals.length * R001_CONFIDENCE_PER_SIGNAL,
    );

    return {
      ruleCode: "R001",
      // §3.2 は 3 つ以上・2 つ以上のどちらも HIGH。**1 つだけが MEDIUM。**
      severity: signals.length >= 2 ? "HIGH" : "MEDIUM",
      confidence,
      title: `${room.number} 号室：稼働記録のない使用痕跡`,
      summary:
        `稼働記録では空室ですが、清掃時に ${String(signals.length)} 種類の` +
        `使用痕跡が記録されています。`,
      matchedSignals: signals,
      // §6.2 の 3 系統をそのまま出せる形。**欠けている系統は呼び出し側が
      // 「データなし」と出す**（ここで空オブジェクトを作らない）。
      evidence: {
        occupancy: {
          isOccupied: false,
          source: occupancy.source,
          reservationRef: occupancy.reservationRef,
          guestCount: occupancy.guestCount,
          importedAt: occupancy.importedAt,
        },
        observation: {
          bedsUsed: observation.bedsUsed,
          trashLevel: observation.trashLevel,
          bathTowelUsed: observation.bathTowelUsed,
          bathMatUsed: observation.bathMatUsed,
          amenitiesUsed: observation.amenitiesUsed,
          recordedAt: observation.recordedAt,
          recordedById: observation.recordedById,
          usedDefaults: observation.usedDefaults,
        },
        room: { number: room.number, saleStatus: room.saleStatus },
      },
    };
  },
};
