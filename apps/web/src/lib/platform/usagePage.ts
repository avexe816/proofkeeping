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

import {
  COMPLETENESS_THRESHOLD_PERCENT,
  judgeTenantQuality,
  type TenantQualityVerdict,
} from "@pk/engine";
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
  /** 写真の枚数。**`null` は未計測**（0033 より前の行が混ざっている）。 */
  photoCount: number | null;
  /** 記録された差異の数。**`null` は未計測。** */
  findings: number | null;
}

/**
 * 判定に使った 3 つの閾値。**画面の説明文をここから作る。**
 *
 * PF-14 の「運用（変更可）」で値を変えると**説明文も一緒に変わる**必要が
 * ある。固定の文言を置くと、変えた瞬間に**画面の説明と実際の判定が
 * 食い違う**（オーナー指摘 / DECISIONS #242）。
 */
export interface VerdictThresholds {
  /** 完備率（%）。**PF-14 の 5 項目に無いのでコード上の定数**（engine）。 */
  completenessPercent: number;
  /** 既定値のまま比率（%）。PF-14 の設定値。 */
  defaultRatePercent: number;
  /** 入力所要時間（秒）。PF-14 の設定値。 */
  inputDurationFloorSeconds: number;
}

export interface UsagePage {
  businessDate: string | null;
  /** **loader の戻り値に含める。** 説明文はこれを埋めて作る。 */
  thresholds: VerdictThresholds;
  summary: UsageSummary;
  /** **下位から**並んだ品質の表。 */
  quality: QualityRow[];
  /** 言語の利用割合。**多い順。** 未計測なら空。 */
  locales: LocaleRow[];
  /** 全体の人数（言語の母数）。**`null` は未計測。** */
  totalPeople: number | null;
}

/**
 * 合計する。**1 つでも未計測（`null`）が混ざったら合計も `null`。**
 *
 * 測れたぶんだけ足すと、**未計測のテナントを黙って 0 として扱った合計**に
 * なる。「一部のテナントが抜けた数」を実測として出すより、
 * 「未計測」と言うほうが正しい（オーナー判断 / DECISIONS #242）。
 *
 * 0033 より前に書かれた行はこの 3 列を数えていない。同じ業務日の行は
 * 同じコンシューマが書くので、**実際に混ざるのは移行の当日だけ。**
 */
function sumMeasured(values: readonly (number | null)[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
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

  // **`?? 0` で未計測を 0 に落とさない。** null のまま集めて後で判定する。
  const photoCounts: (number | null)[] = [];
  const findingCounts: (number | null)[] = [];
  // 言語も同じ。1 つでも未計測なら表そのものを出さない。
  const peopleByLocale = new Map<string, number>();
  let localesMeasured = snapshots.length > 0;

  const quality: QualityRow[] = snapshots.map((snapshot) => {
    completedTasks += snapshot.completedTasks;
    observationsRecorded += snapshot.observationsRecorded;
    photoCounts.push(snapshot.photoCount);
    findingCounts.push(snapshot.findingsHigh);
    if (snapshot.localeCounts === null) {
      localesMeasured = false;
    } else {
      for (const [locale, people] of Object.entries(snapshot.localeCounts)) {
        peopleByLocale.set(locale, (peopleByLocale.get(locale) ?? 0) + people);
      }
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

  // 未計測なら**表ごと出さない**（空の表を「0 人」と読ませない）。
  const measuredPeople = localesMeasured
    ? [...peopleByLocale.values()].reduce((total, people) => total + people, 0)
    : null;
  const locales: LocaleRow[] =
    measuredPeople === null
      ? []
      : [...peopleByLocale.entries()]
          .map(([locale, people]) => ({
            locale,
            people,
            percent: percentOf(people, measuredPeople),
          }))
          .sort((a, b) =>
            b.people === a.people ? a.locale.localeCompare(b.locale) : b.people - a.people,
          );

  return {
    businessDate,
    thresholds: {
      completenessPercent: COMPLETENESS_THRESHOLD_PERCENT,
      defaultRatePercent: settings.defaultRateThresholdPercent,
      inputDurationFloorSeconds: settings.inputDurationFloorSeconds,
    },
    summary: {
      completedTasks,
      completenessPercent: percentOf(observationsRecorded, completedTasks),
      photoCount: sumMeasured(photoCounts),
      findings: sumMeasured(findingCounts),
    },
    quality: [...quality].sort(worstFirst),
    locales,
    totalPeople: measuredPeople,
  };
}

/**
 * 判定の説明文を作る（PF-05 の逐語注記）。
 *
 * **数値を文言に固定しない。** `ja.json` はプレースホルダだけを持ち、
 * 実際の値はここで埋める。PF-14 で閾値を変えたら、この文も一緒に変わる。
 *
 * @param template `{completeness}` / `{defaultRate}` / `{seconds}` を含む文。
 */
export function buildVerdictNote(template: string, thresholds: VerdictThresholds): string {
  return template
    .replaceAll("{completeness}", String(thresholds.completenessPercent))
    .replaceAll("{defaultRate}", String(thresholds.defaultRatePercent))
    .replaceAll("{seconds}", String(thresholds.inputDurationFloorSeconds));
}
