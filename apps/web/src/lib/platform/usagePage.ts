/**
 * 利用状況の組み立て（PF-05 / プロトタイプ 03）。
 *
 * task: docs/tasks/PF-05.md
 *
 * ── 元はスナップショットだけ ────────────────────────────
 * `getTenantDb()` を呼ばない（PF-04 と同じ / DECISIONS #220）。
 *
 * ── 軸はテナント・言語・時系列だけ（PF-05「やらないこと」）──
 * **個人単位の集計を作らない**（security.md §5 / INV-07）。
 * スナップショットが個人を持っていないので、ここでも作れない。
 *
 * ── 品質の表は**下位から**（完了条件）─────────────────
 * 良い順にすると、手当てが要るテナントが下に沈んで見えなくなる。
 * 並べ替えの向きが仕様そのものなので、テストで固定する。
 */

import { judgeTenantQuality, type TenantQualityVerdict } from "@pk/engine";
import type { PlatformOperationSettings, TenantSnapshotRow } from "@pk/db";

/** 品質の表の 1 行。**個人を特定できる値を持たない。** */
export interface QualityRow {
  organizationId: string;
  name: string;
  /** 完備率（%）。**出せない日は `null`**（0 ではない）。 */
  completenessPercent: number | null;
  /** 既定値のまま比率（%）。記録が 0 件なら `null`。 */
  defaultRatePercent: number | null;
  /** 入力所要時間の中央値（ミリ秒）。計測が無ければ `null`。 */
  inputDurationMedianMs: number | null;
  needsSupport: boolean;
  /** 該当した指標の数（0〜3）。**なぜ「要支援」かを画面で説明できる。** */
  signalCount: number;
}

/** 言語の利用割合の 1 行。**人数だけ。** */
export interface LocaleRow {
  locale: string;
  people: number;
  /** 全体に占める割合（%・整数）。母数が 0 なら `null`。 */
  percent: number | null;
}

/** KPI。**出す元の無いものは持たない**（DECISIONS #238 と同じ扱い）。 */
export interface UsageSummary {
  /** 記録された清掃（完了タスク数の合計）。 */
  completedTasks: number;
  /** 記録の完備率（%）。分母が 0 なら `null`。 */
  completenessPercent: number | null;
  /** 写真の枚数。 */
  photoCount: number;
  /** 記録された差異の数。 */
  findings: number;
}

export interface UsagePage {
  businessDate: string | null;
  summary: UsageSummary;
  /** **下位から**並んだ品質の表。 */
  quality: QualityRow[];
  /** 言語の利用割合。**多い順。** */
  locales: LocaleRow[];
  /** 全体の人数（言語の母数）。 */
  totalPeople: number;
}

/** 百分率（整数・切り捨て）。母数が 0 なら `null`。**0 を返さない。** */
function percentOf(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.floor((numerator * 100) / denominator);
}

/**
 * 並べ替えの鍵。**小さいほど先に出る（＝下位から）。**
 *
 * 1. 「要支援」を先頭へ（該当数が多い順）
 * 2. 次に完備率の低い順
 *
 * **完備率が出せないテナントを先頭に置かない。** 記録が無い日は
 * 「悪い」ではない（`judgeTenantQuality()` と同じ向き）。
 */
function worstFirst(a: QualityRow, b: QualityRow): number {
  if (a.signalCount !== b.signalCount) return b.signalCount - a.signalCount;
  const left = a.completenessPercent ?? Number.POSITIVE_INFINITY;
  const right = b.completenessPercent ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left - right;
  return a.name.localeCompare(b.name);
}

export function buildUsagePage(
  snapshots: readonly TenantSnapshotRow[],
  settings: PlatformOperationSettings,
  businessDate: string | null,
): UsagePage {
  const thresholds = {
    inputDurationFloorSeconds: settings.inputDurationFloorSeconds,
    defaultRateThresholdPercent: settings.defaultRateThresholdPercent,
  };

  let completedTasks = 0;
  let observationsRecorded = 0;
  let photoCount = 0;
  let findings = 0;
  const peopleByLocale = new Map<string, number>();

  const quality: QualityRow[] = snapshots.map((snapshot) => {
    completedTasks += snapshot.completedTasks;
    observationsRecorded += snapshot.observationsRecorded;
    photoCount += snapshot.photoCount;
    findings += snapshot.findingsHigh;
    for (const [locale, people] of Object.entries(snapshot.localeCounts)) {
      peopleByLocale.set(locale, (peopleByLocale.get(locale) ?? 0) + people);
    }

    const verdict: TenantQualityVerdict = judgeTenantQuality(
      {
        completedTasks: snapshot.completedTasks,
        observationsRecorded: snapshot.observationsRecorded,
        observationsUsedDefaults: snapshot.observationsUsedDefaults,
        inputDurationMedianMs: snapshot.inputDurationMedianMs,
      },
      thresholds,
    );

    return {
      organizationId: snapshot.organizationId,
      name: snapshot.name,
      completenessPercent: verdict.completenessPercent,
      defaultRatePercent: verdict.defaultRatePercent,
      inputDurationMedianMs: snapshot.inputDurationMedianMs,
      needsSupport: verdict.needsSupport,
      signalCount: verdict.signalCount,
    };
  });

  const totalPeople = [...peopleByLocale.values()].reduce((total, people) => total + people, 0);
  const locales: LocaleRow[] = [...peopleByLocale.entries()]
    .map(([locale, people]) => ({ locale, people, percent: percentOf(people, totalPeople) }))
    .sort((a, b) => (b.people === a.people ? a.locale.localeCompare(b.locale) : b.people - a.people));

  return {
    businessDate,
    summary: {
      completedTasks,
      completenessPercent: percentOf(observationsRecorded, completedTasks),
      photoCount,
      findings,
    },
    quality: [...quality].sort(worstFirst),
    locales,
    totalPeople,
  };
}
