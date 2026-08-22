/**
 * ベースライン算出のテスト（P3-08 / PK-SPEC-P3 §5）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * 外れ値除外の 4 ルール（§5.3）は、当たる例と**当たらない例**を
 * 並べて置く。除外は「集計から実データを消す」操作なので、
 * 当たりすぎないことのほうが重要になる。
 */

import { describe, expect, it } from "vitest";

import {
  ALWAYS_CONSUMED_ITEM_CODES,
  DEFAULT_MIN_SAMPLE_SIZE,
  MIN_INPUT_DURATION_MS,
  REPEATED_INPUT_THRESHOLD,
  baselineKeyOf,
  computeBaseline,
  percentile,
  standardDeviation,
  type ObservationSample,
} from "./baseline.js";

function sample(overrides: Partial<ObservationSample> = {}): ObservationSample {
  return {
    observationId: `o7k2m9__obs_${String(Math.abs(hash(JSON.stringify(overrides))))}`,
    propertyId: "o7k2m9__prop_A",
    roomTypeId: "o7k2m9__rtyp_TWIN",
    guestCount: 2,
    taskType: "CHECKOUT",
    itemCode: "BATH_TOWEL",
    qty: 2,
    businessDate: "2026-08-01",
    recordedById: "o7k2m9__mem_01",
    bedsUsed: 2,
    inputDurationMs: 12_000,
    hasFinding: false,
    observationSkipped: false,
    ...overrides,
  };
}

/** ID を一意にするためだけの決定的なハッシュ（`Math.random()` を使わない）。 */
function hash(value: string): number {
  let result = 0;
  for (const char of value) result = (result * 31 + char.charCodeAt(0)) | 0;
  return result;
}

/**
 * 同じ値の観察を n 件作る。ID は連番で一意にする。
 *
 * **業務日を 1 日ずつずらしてある。** 同じ値を同じスタッフが同日に
 * 10 件入れると §5.3 の連打ルールに当たるため、それを検査したい
 * テスト以外では日付を散らす。90 日ウィンドウの実データでも、
 * 同一客室タイプ×人数の観察が同日に 10 件並ぶことは通常ない。
 */
function samples(count: number, overrides: Partial<ObservationSample> = {}): ObservationSample[] {
  return Array.from({ length: count }, (_, index) =>
    sample({
      observationId: `o7k2m9__obs_${String(index)}`,
      businessDate: `2026-08-${String((index % 28) + 1).padStart(2, "0")}`,
      ...overrides,
    }),
  );
}

describe("percentile", () => {
  it("空配列は 0", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("1 件ならその値", () => {
    expect(percentile([3], 90)).toBe(3);
  });

  it("中央値は線形補間する", () => {
    expect(percentile([1, 2], 50)).toBe(1.5);
    expect(percentile([1, 2, 3], 50)).toBe(2);
  });

  it("p10 / p90 が端に寄る", () => {
    const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(percentile(values, 10)).toBeCloseTo(0.9, 10);
    expect(percentile(values, 90)).toBeCloseTo(8.1, 10);
  });

  it("全部同じ値なら百分位も同じ値", () => {
    expect(percentile([2, 2, 2, 2], 10)).toBe(2);
    expect(percentile([2, 2, 2, 2], 90)).toBe(2);
  });
});

describe("standardDeviation", () => {
  it("空配列は 0", () => {
    expect(standardDeviation([])).toBe(0);
  });

  it("1 件は 0（0 除算にしない）", () => {
    expect(standardDeviation([5])).toBe(0);
  });

  it("ばらつきが無ければ 0", () => {
    expect(standardDeviation([2, 2, 2])).toBe(0);
  });

  it("母集団標準偏差で計算する", () => {
    // [2,4,4,4,5,5,7,9] の母集団標準偏差は 2
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
  });

  it("順序を変えても同じ", () => {
    expect(standardDeviation([9, 2, 5, 4, 4, 7, 4, 5])).toBe(2);
  });
});

describe("computeBaseline — 統計量", () => {
  it("グループごとに中央値・p10・p90・最大・標準偏差が出る", () => {
    const result = computeBaseline(samples(20, { qty: 2 }));
    expect(result.baselines).toHaveLength(1);
    const baseline = result.baselines[0];
    expect(baseline?.medianQty).toBe(2);
    expect(baseline?.p10Qty).toBe(2);
    expect(baseline?.p90Qty).toBe(2);
    expect(baseline?.maxQty).toBe(2);
    expect(baseline?.stdDev).toBe(0);
  });

  it("キーは施設・客室タイプ・人数・種別・品目で分かれる", () => {
    const result = computeBaseline([
      sample({ observationId: "a", itemCode: "BATH_TOWEL" }),
      sample({ observationId: "b", itemCode: "FACE_TOWEL" }),
      sample({ observationId: "c", guestCount: 1 }),
      sample({ observationId: "d", taskType: "STAYOVER" }),
      sample({ observationId: "e", roomTypeId: "o7k2m9__rtyp_DBL" }),
      sample({ observationId: "f", propertyId: "o7k2m9__prop_B" }),
    ]);
    expect(result.baselines).toHaveLength(6);
  });

  it("グループの識別子は仕様どおりの並び", () => {
    expect(
      baselineKeyOf({
        propertyId: "P",
        roomTypeId: "R",
        guestCount: 2,
        taskType: "CHECKOUT",
        itemCode: "BATH_TOWEL",
      }),
    ).toBe("P|R|2|CHECKOUT|BATH_TOWEL");
  });

  it("集計ウィンドウの外は数えない", () => {
    const result = computeBaseline(
      [
        sample({ observationId: "a", businessDate: "2026-05-31" }),
        sample({ observationId: "b", businessDate: "2026-06-01" }),
        sample({ observationId: "c", businessDate: "2026-08-31" }),
        sample({ observationId: "d", businessDate: "2026-09-01" }),
      ],
      { window: { from: "2026-06-01", to: "2026-08-31" } },
    );
    expect(result.consideredCount).toBe(2);
    expect(result.baselines[0]?.sampleSize).toBe(2);
  });

  it("未記録（スキップ）は母数に入らない", () => {
    const result = computeBaseline([
      sample({ observationId: "a" }),
      sample({ observationId: "b", observationSkipped: true }),
    ]);
    expect(result.consideredCount).toBe(1);
    expect(result.exclusions).toHaveLength(0);
  });

  it("空配列でも落ちない", () => {
    expect(computeBaseline([])).toEqual({
      baselines: [],
      exclusions: [],
      consideredCount: 0,
      zeroReviews: [],
    });
  });
});

describe("computeBaseline — isReliable（§2.4 MUST）", () => {
  it("20 件で信頼可能になる", () => {
    const result = computeBaseline(samples(DEFAULT_MIN_SAMPLE_SIZE, { qty: 2 }));
    expect(result.baselines[0]?.sampleSize).toBe(20);
    expect(result.baselines[0]?.isReliable).toBe(true);
  });

  it("19 件では信頼可能にならない", () => {
    const result = computeBaseline(samples(DEFAULT_MIN_SAMPLE_SIZE - 1, { qty: 2 }));
    expect(result.baselines[0]?.isReliable).toBe(false);
  });

  it("1 件でも行は作る（信頼可能にはしない）", () => {
    const result = computeBaseline(samples(1, { qty: 2 }));
    expect(result.baselines[0]?.sampleSize).toBe(1);
    expect(result.baselines[0]?.isReliable).toBe(false);
  });

  it("除外後の件数で判定する（除外前の件数で数えない）", () => {
    const kept = samples(19, { qty: 2 });
    const dropped = sample({ observationId: "fast", qty: 2, inputDurationMs: 500 });
    const result = computeBaseline([...kept, dropped]);
    expect(result.baselines[0]?.sampleSize).toBe(19);
    expect(result.baselines[0]?.isReliable).toBe(false);
  });

  it("閾値は引数で下げられるが、既定は 20 のまま", () => {
    expect(DEFAULT_MIN_SAMPLE_SIZE).toBe(20);
    const result = computeBaseline(samples(5, { qty: 2 }), { minSampleSize: 5 });
    expect(result.baselines[0]?.isReliable).toBe(true);
  });
});

describe("computeBaseline — 外れ値の除外 4 種（§5.3）", () => {
  it("① 値が 0 かつ bedsUsed > 0 は除外する", () => {
    const result = computeBaseline([
      ...samples(5, { qty: 2 }),
      sample({ observationId: "zero", qty: 0, bedsUsed: 2 }),
    ]);
    expect(result.exclusions.map((exclusion) => exclusion.reason)).toEqual(["ZERO_WITH_BEDS_USED"]);
    expect(result.baselines[0]?.sampleSize).toBe(5);
  });

  it("① bedsUsed が 0 なら値 0 は正常（空室の観察）", () => {
    const result = computeBaseline([
      ...samples(5, { qty: 0, bedsUsed: 0 }),
      sample({ observationId: "another", qty: 0, bedsUsed: 0 }),
    ]);
    expect(result.exclusions).toHaveLength(0);
    expect(result.baselines[0]?.sampleSize).toBe(6);
  });

  it("② 中央値の 5 倍を超える値は除外する", () => {
    const result = computeBaseline([
      ...samples(9, { qty: 2 }),
      sample({ observationId: "typo", qty: 11 }),
    ]);
    expect(result.exclusions.map((exclusion) => exclusion.reason)).toEqual(["OVER_MEDIAN_5X"]);
  });

  it("② ちょうど 5 倍は残す（超えたものだけ）", () => {
    const result = computeBaseline([
      ...samples(9, { qty: 2 }),
      sample({ observationId: "edge", qty: 10 }),
    ]);
    expect(result.exclusions).toHaveLength(0);
    expect(result.baselines[0]?.maxQty).toBe(10);
  });

  it("② 中央値が 0 の品目では 5 倍ルールを当てない", () => {
    // ミネラルウォーターのように通常 0 の品目。実際に使われた日を消さない。
    const result = computeBaseline([
      ...samples(9, { qty: 0, bedsUsed: 0, itemCode: "BOTTLED_WATER" }),
      sample({ observationId: "used", qty: 2, bedsUsed: 0, itemCode: "BOTTLED_WATER" }),
    ]);
    expect(result.exclusions).toHaveLength(0);
    expect(result.baselines[0]?.p90Qty).toBeGreaterThan(0);
  });

  it("③ 3 秒未満で確定した入力は除外する", () => {
    const result = computeBaseline([
      ...samples(5, { qty: 2 }),
      sample({ observationId: "fast", inputDurationMs: MIN_INPUT_DURATION_MS - 1 }),
    ]);
    expect(result.exclusions.map((exclusion) => exclusion.reason)).toEqual(["INPUT_TOO_FAST"]);
  });

  it("③ ちょうど 3 秒は残す。未計測（null）も残す", () => {
    const result = computeBaseline([
      sample({ observationId: "a", inputDurationMs: MIN_INPUT_DURATION_MS }),
      sample({ observationId: "b", inputDurationMs: null }),
    ]);
    expect(result.exclusions).toHaveLength(0);
    expect(result.baselines[0]?.sampleSize).toBe(2);
  });

  it("④ 同一スタッフが同日に 10 件以上同じ値を入れたら除外する", () => {
    const result = computeBaseline(
      samples(REPEATED_INPUT_THRESHOLD, {
        qty: 2,
        recordedById: "o7k2m9__mem_09",
        businessDate: "2026-08-01",
      }),
    );
    expect(result.baselines).toHaveLength(0);
    expect(result.exclusions).toHaveLength(REPEATED_INPUT_THRESHOLD);
    expect(result.exclusions.every((exclusion) => exclusion.reason === "REPEATED_INPUT")).toBe(
      true,
    );
  });

  it("④ 9 件までは連打とみなさない", () => {
    const result = computeBaseline(
      samples(REPEATED_INPUT_THRESHOLD - 1, {
        qty: 2,
        recordedById: "o7k2m9__mem_09",
        businessDate: "2026-08-01",
      }),
    );
    expect(result.exclusions).toHaveLength(0);
  });

  it("④ 日をまたげば連打にならない", () => {
    const first = samples(9, { qty: 2 }).map((entry, index) => ({
      ...entry,
      observationId: `d1-${String(index)}`,
      businessDate: "2026-08-01",
    }));
    const second = samples(9, { qty: 2 }).map((entry, index) => ({
      ...entry,
      observationId: `d2-${String(index)}`,
      businessDate: "2026-08-02",
    }));
    expect(computeBaseline([...first, ...second]).exclusions).toHaveLength(0);
  });

  it("④ スタッフが違えば連打にならない", () => {
    const mixed = samples(REPEATED_INPUT_THRESHOLD, {
      qty: 2,
      businessDate: "2026-08-01",
    }).map((entry, index) => ({
      ...entry,
      recordedById: index % 2 === 0 ? "o7k2m9__mem_01" : "o7k2m9__mem_02",
    }));
    expect(computeBaseline(mixed).exclusions).toHaveLength(0);
  });

  it("差異が付いた日は除外する（§5.2 の 1.）", () => {
    const result = computeBaseline([
      ...samples(5, { qty: 2 }),
      sample({ observationId: "finding", hasFinding: true }),
    ]);
    expect(result.exclusions.map((exclusion) => exclusion.reason)).toEqual(["FINDING_ATTACHED"]);
    expect(result.consideredCount).toBe(6);
  });

  it("複数のルールに当たっても除外は 1 行（仕様の並び順で先に当たったもの）", () => {
    const result = computeBaseline([
      ...samples(5, { qty: 2 }),
      sample({ observationId: "both", qty: 0, bedsUsed: 2, inputDurationMs: 100 }),
    ]);
    expect(result.exclusions).toHaveLength(1);
    expect(result.exclusions[0]?.reason).toBe("ZERO_WITH_BEDS_USED");
  });

  it("全件が除外されたグループは行を作らない", () => {
    const result = computeBaseline(samples(3, { qty: 0, bedsUsed: 2 }));
    expect(result.baselines).toHaveLength(0);
    expect(result.exclusions).toHaveLength(3);
  });

  it("除外記録は品目とグループを保持する（W-22 の内訳に使う）", () => {
    const result = computeBaseline([
      ...samples(5, { qty: 2 }),
      sample({ observationId: "zero", qty: 0, bedsUsed: 2 }),
    ]);
    expect(result.exclusions[0]).toMatchObject({
      observationId: "zero",
      propertyId: "o7k2m9__prop_A",
      roomTypeId: "o7k2m9__rtyp_TWIN",
      guestCount: 2,
      taskType: "CHECKOUT",
      itemCode: "BATH_TOWEL",
      businessDate: "2026-08-01",
      qty: 0,
    });
  });
});

describe("computeBaseline — 決定性（§9.3）", () => {
  const input = [
    ...samples(20, { qty: 2 }),
    sample({ observationId: "x1", qty: 3 }),
    sample({ observationId: "x2", qty: 1 }),
    sample({ observationId: "x3", qty: 4, itemCode: "FACE_TOWEL" }),
    sample({ observationId: "x4", qty: 0, bedsUsed: 2 }),
  ];

  it("同じ入力から同じ出力が出る", () => {
    expect(computeBaseline(input)).toEqual(computeBaseline(input));
  });

  it("入力の並び順を変えても同じ出力になる", () => {
    const reversed = [...input].reverse();
    expect(computeBaseline(reversed)).toEqual(computeBaseline(input));
  });

  it("3 回実行しても結果が変わらない（testing.md §4）", () => {
    const first = computeBaseline(input);
    const second = computeBaseline(input);
    const third = computeBaseline(input);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("入力の配列を書き換えない", () => {
    const copy = input.map((entry) => ({ ...entry }));
    computeBaseline(input);
    expect(input).toEqual(copy);
  });

  it("統計量は小数第 4 位までに丸める", () => {
    const result = computeBaseline([
      sample({ observationId: "a", qty: 1 }),
      sample({ observationId: "b", qty: 2 }),
      sample({ observationId: "c", qty: 2 }),
    ]);
    const stdDev = result.baselines[0]?.stdDev ?? 0;
    expect(stdDev).toBe(0.4714);
  });
});

/**
 * 除外ルール①の適用範囲（DECISIONS #252）。
 *
 * **当てすぎても当てなさすぎても外れる。** 当てすぎるとベースラインが
 * 上がって見逃し、当てなさすぎると下がって誤検知が増える。ここは
 * **「どこに当たり、どこに当たらないか」を両方向で固定する。**
 */
describe("除外ルール①の自己停止（§5.3 / DECISIONS #253）", () => {
  /** 全 10 件のうち `zeros` 件を 0 にする（既定は一覧の品目 × CHECKOUT）。 */
  function withZeros(
    zeros: number,
    overrides: Partial<ObservationSample> = {},
  ): ReturnType<typeof computeBaseline> {
    return computeBaseline(
      Array.from({ length: 10 }, (_unused, index) =>
        sample({
          observationId: `o7k2m9__obs_${String(index)}`,
          businessDate: `2026-08-${String(index + 1).padStart(2, "0")}`,
          itemCode: "PILLOW_CASE",
          qty: index < zeros ? 0 : 2,
          bedsUsed: 2,
          ...overrides,
        }),
      ),
    );
  }

  it("閾値ちょうど（30%）では止まらない — **超えたときだけ**", () => {
    const result = withZeros(3);
    expect(result.exclusions).toHaveLength(3);
    expect(result.zeroReviews).toHaveLength(0);
  });

  it("閾値を超えると①を当てず、標本を残して人手へ回す", () => {
    const result = withZeros(4);
    expect(result.exclusions).toHaveLength(0);
    expect(result.baselines[0]?.sampleSize).toBe(10);

    expect(result.zeroReviews).toHaveLength(1);
    const review = result.zeroReviews[0];
    expect(review?.itemCode).toBe("PILLOW_CASE");
    expect(review?.taskType).toBe("CHECKOUT");
    expect(review?.sampleSize).toBe(10);
    expect(review?.zeroCount).toBe(4);
    expect(review?.zeroRate).toBe(0.4);
  });

  it("**全件が 0 でも標本を全消しにしない**（歯止めの本題）", () => {
    const result = withZeros(10);
    expect(result.exclusions).toHaveLength(0);
    expect(result.baselines).toHaveLength(1);
    expect(result.baselines[0]?.sampleSize).toBe(10);
    expect(result.zeroReviews).toHaveLength(1);
  });

  it("最小件数（5）に満たないグループでは自己停止しない", () => {
    // 4 件すべてが 0 でも比率が意味を持たない。①をそのまま当てる。
    const result = computeBaseline(samples(4, { qty: 0, bedsUsed: 2, itemCode: "PILLOW_CASE" }));
    expect(result.exclusions).toHaveLength(4);
    expect(result.zeroReviews).toHaveLength(0);
  });

  it("**歯止めは除外を増やさない**（対象外の品目では何も起きない）", () => {
    // 一覧に無い品目は元から①が当たらない。0 が多くても review は出ない。
    const result = withZeros(10, { itemCode: "EXTRA_FUTON" });
    expect(result.exclusions).toHaveLength(0);
    expect(result.zeroReviews).toHaveLength(0);
  });

  it("**自己停止は集計キー単位**（別の客室タイプへ伝染しない）", () => {
    const noisy = Array.from({ length: 10 }, (_unused, index) =>
      sample({
        observationId: `noisy_${String(index)}`,
        businessDate: `2026-08-${String(index + 1).padStart(2, "0")}`,
        roomTypeId: "o7k2m9__rtyp_JAPANESE",
        itemCode: "PILLOW_CASE",
        qty: 0,
        bedsUsed: 2,
      }),
    );
    const clean = [
      ...samples(9, { qty: 2, itemCode: "PILLOW_CASE" }),
      sample({ observationId: "one_zero", qty: 0, bedsUsed: 2, itemCode: "PILLOW_CASE" }),
    ];

    const result = computeBaseline([...noisy, ...clean]);
    // 汚れているほうだけ止まり、きれいなほうは①が当たる。
    expect(result.zeroReviews).toHaveLength(1);
    expect(result.zeroReviews[0]?.roomTypeId).toBe("o7k2m9__rtyp_JAPANESE");
    expect(result.exclusions.map((exclusion) => exclusion.reason)).toEqual(["ZERO_WITH_BEDS_USED"]);
    expect(result.exclusions[0]?.roomTypeId).toBe("o7k2m9__rtyp_TWIN");
  });

  it("止まっても他の除外ルールは効く（②③④を巻き添えにしない）", () => {
    const result = computeBaseline([
      ...withZerosSamples(4),
      sample({
        observationId: "fast",
        itemCode: "PILLOW_CASE",
        qty: 2,
        inputDurationMs: MIN_INPUT_DURATION_MS - 1,
      }),
    ]);
    expect(result.zeroReviews).toHaveLength(1);
    expect(result.exclusions.map((exclusion) => exclusion.reason)).toEqual(["INPUT_TOO_FAST"]);
  });

  /** 上の `withZeros` と同じ並びの標本だけを返す。 */
  function withZerosSamples(zeros: number): ObservationSample[] {
    return Array.from({ length: 10 }, (_unused, index) =>
      sample({
        observationId: `o7k2m9__obs_${String(index)}`,
        businessDate: `2026-08-${String(index + 1).padStart(2, "0")}`,
        itemCode: "PILLOW_CASE",
        qty: index < zeros ? 0 : 2,
        bedsUsed: 2,
      }),
    );
  }
});

describe("除外ルール①（ZERO_WITH_BEDS_USED）の適用範囲", () => {
  /** 0 の標本 1 件が除外されたかどうか。 */
  function excludedZero(overrides: Partial<ObservationSample>): boolean {
    const result = computeBaseline([
      ...samples(5, { qty: 2, ...overrides }),
      sample({ observationId: "zero", qty: 0, bedsUsed: 2, ...overrides }),
    ]);
    return result.exclusions.some((exclusion) => exclusion.reason === "ZERO_WITH_BEDS_USED");
  }

  it("**一覧の 3 種は CHECKOUT で当たる**", () => {
    for (const itemCode of ALWAYS_CONSUMED_ITEM_CODES) {
      expect(excludedZero({ taskType: "CHECKOUT", itemCode }), itemCode).toBe(true);
    }
  });

  it("**STAYOVER では当たらない**（滞在中はリネンを交換しない運用がある）", () => {
    for (const itemCode of ALWAYS_CONSUMED_ITEM_CODES) {
      expect(excludedZero({ taskType: "STAYOVER", itemCode }), itemCode).toBe(false);
    }
  });

  it("DEEP / COMMON_AREA / RECHECK でも当たらない", () => {
    for (const taskType of ["DEEP", "COMMON_AREA", "RECHECK"]) {
      expect(excludedZero({ taskType, itemCode: "BATH_TOWEL" }), taskType).toBe(false);
    }
  });

  it("**EXTRA_FUTON は CHECKOUT でも当たらない**（0 が通常の状態）", () => {
    expect(excludedZero({ taskType: "CHECKOUT", itemCode: "EXTRA_FUTON" })).toBe(false);
  });

  it("一覧に載らない品目には当たらない（シーツ・フェイスタオル・コップ）", () => {
    for (const itemCode of ["SHEET_SINGLE", "SHEET_DOUBLE", "FACE_TOWEL", "CUP", "TOOTHBRUSH"]) {
      expect(excludedZero({ taskType: "CHECKOUT", itemCode }), itemCode).toBe(false);
    }
  });

  it("**当たらない品目の 0 は母数に残る**（ベースラインが上がらない）", () => {
    const withZeros = computeBaseline([
      ...samples(5, { qty: 2, taskType: "STAYOVER", itemCode: "DUVET_COVER" }),
      ...samples(5, { qty: 0, bedsUsed: 2, taskType: "STAYOVER", itemCode: "DUVET_COVER" }),
    ]);
    // 0 が 5 件残るので中央値は 2 より下がる。**消えていたら 2 のまま。**
    expect(withZeros.baselines[0]?.sampleSize).toBe(10);
    expect(withZeros.baselines[0]?.medianQty).toBeLessThan(2);
  });

  /**
   * **綴りが語彙に在ることは `apps/web` 側で見る。**
   * `packages/engine` は依存ゼロ（CLAUDE.md §5）で `@pk/db` を読めない。
   */
  it("`ALWAYS_CONSUMED_ITEM_CODES` は 3 種", () => {
    expect([...ALWAYS_CONSUMED_ITEM_CODES]).toEqual(["DUVET_COVER", "PILLOW_CASE", "BATH_TOWEL"]);
  });
});
