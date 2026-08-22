/**
 * 消耗ベースラインの算出（PK-SPEC-P3 §5）。**純粋関数。**
 *
 * task: docs/tasks/P3-08.md
 *
 * ── ここに持ち込まないもの ──────────────────────────────
 * DB・fetch・環境変数・`Date.now()`（CLAUDE.md §5 / §5.2 の実装指示）。
 * 観察値の配列を受け取り、統計量と除外記録を返すだけにする。書き込みは
 * 週次バッチ（P3-09）が行う。
 *
 * ── P3 は判定しない ─────────────────────────────────────
 * ここが出すのは中央値・p10・p90・最大・標準偏差という**統計量**だけで、
 * 「多い」「異常」の判定を含まない（§0.2）。閾値との突き合わせは P4。
 * `isReliable = false` の組み合わせは P4 のルール評価から外れる（§2.4 MUST）。
 *
 * ── 集計ウィンドウは呼び出し側が解決する ────────────────
 * §5.4 の「直近 90 日」を日付に直すには現在時刻が要る。それをここへ
 * 持ち込むと純粋関数でなくなるため、`window`（`from` / `to` の業務日）を
 * 受け取る形にした。日数から日付への変換は P3-09 が行う。
 *
 * ── 決定性 ──────────────────────────────────────────────
 * 同じ入力から必ず同じ出力が出ること（§9.3 / testing.md §4）。そのために
 *   ① 並び順を入力順に依存させない（キーで昇順に整列して返す）
 *   ② 浮動小数点の統計量を小数第 4 位で丸める
 *   ③ 除外判定に乱数・時刻を使わない
 * を守る。②は `0.1 + 0.2` の類の誤差で、同じ観察集合から実行ごとに
 * 違う値が保存されるのを防ぐため。
 */

/** 信頼可能とみなす最小サンプル数（§2.4 MUST）。**下げないこと。** */
export const DEFAULT_MIN_SAMPLE_SIZE = 20;

/** 中央値の何倍を超えたら誤入力とみなすか（§5.3）。 */
export const OUTLIER_MEDIAN_MULTIPLIER = 5;

/** これ未満の入力所要時間は精度が疑わしい（§5.3）。ミリ秒。 */
export const MIN_INPUT_DURATION_MS = 3000;

/** 同一スタッフ・同一業務日で同じ値がこの件数以上なら連打とみなす（§5.3）。 */
export const REPEATED_INPUT_THRESHOLD = 10;

/** 統計量を丸める小数桁数。 */
const STAT_DECIMALS = 4;

/**
 * 除外理由。`packages/db` の `BASELINE_EXCLUSION_REASONS` と同じ語彙
 * （依存はさせない）。
 */
export const BASELINE_EXCLUSION_REASON_VALUES = [
  "ZERO_WITH_BEDS_USED",
  "OVER_MEDIAN_5X",
  "INPUT_TOO_FAST",
  "REPEATED_INPUT",
  "FINDING_ATTACHED",
] as const;

export type BaselineExclusionReasonValue = (typeof BASELINE_EXCLUSION_REASON_VALUES)[number];

/** 観察 1 件 × 品目 1 つ。`roomObservation` と `linenRecord` を平らにしたもの。 */
export interface ObservationSample {
  observationId: string;
  propertyId: string;
  roomTypeId: string;
  guestCount: number;
  taskType: string;
  itemCode: string;
  /** 観察された数量。 */
  qty: number;
  businessDate: string;
  /** 記録者の `membership.id`。**連打の検出にのみ使う**（個人の評価に使わない）。 */
  recordedById: string;
  /** 同じ観察の `bedsUsed`。0 値の入力漏れ判定に使う（§5.3）。 */
  bedsUsed: number;
  /** 入力所要時間。未計測なら `null`（除外しない）。 */
  inputDurationMs: number | null;
  /** P4 で差異が付いた日か（§5.2 の 1.）。P3 の時点では常に `false`。 */
  hasFinding: boolean;
  /** 「今回は記録しない」で飛ばした観察か（§1.3）。 */
  observationSkipped: boolean;
}

/** 集計の単位（§5.2 のグルーピング）。 */
export interface BaselineGroupKey {
  propertyId: string;
  roomTypeId: string;
  guestCount: number;
  taskType: string;
  itemCode: string;
}

/** 1 グループぶんの統計量。 */
export interface BaselineResult extends BaselineGroupKey {
  /** `propertyId|roomTypeId|guestCount|taskType|itemCode`。 */
  key: string;
  sampleSize: number;
  medianQty: number;
  p10Qty: number;
  p90Qty: number;
  maxQty: number;
  stdDev: number;
  isReliable: boolean;
}

/** 除外した観察 1 件。`baselineExclusionLog` の 1 行になる（§5.3 MUST）。 */
export interface BaselineExclusion extends BaselineGroupKey {
  observationId: string;
  businessDate: string;
  qty: number;
  reason: BaselineExclusionReasonValue;
}

/**
 * 算出の結果。
 *
 * **仕様 §5.2 の `computeBaseline()` は `BaselineResult[]` を返すが、
 * 除外記録も一緒に返す形にした。** §5.3 MUST が「除外した件数を
 * `baselineExclusionLog` に記録する」と定めており、純粋関数が DB へ
 * 書けない以上、呼び出し側へ渡す経路が要る（docs/DECISIONS.md #095）。
 */
export interface BaselineComputation {
  baselines: BaselineResult[];
  exclusions: BaselineExclusion[];
  /** 入力のうち集計対象になった件数（除外率の分母）。 */
  consideredCount: number;
}

export interface BaselineOptions {
  /** 既定は `DEFAULT_MIN_SAMPLE_SIZE`。 */
  minSampleSize?: number;
  /** 集計ウィンドウ（業務日の閉区間）。省略すると全件を対象にする。 */
  window?: { from: string; to: string };
}

/** グループキーの文字列表現。 */
export function baselineKeyOf(key: BaselineGroupKey): string {
  return [key.propertyId, key.roomTypeId, key.guestCount, key.taskType, key.itemCode].join("|");
}

/**
 * 昇順に整列済みの値から百分位を取る（線形補間）。
 *
 * 補間するのは、サンプルが 20 件程度でも p10 / p90 が階段状に飛ばないため。
 * 最近傍順位法（nearest-rank）だと 20 件では 2 件目・18 件目そのものになり、
 * 1 件の増減で値が跳ねる。
 */
export function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const first = sortedValues[0] ?? 0;
  if (sortedValues.length === 1) return first;

  const position = ((sortedValues.length - 1) * p) / 100;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sortedValues[lower] ?? first;
  if (lower === upper) return lowerValue;
  const upperValue = sortedValues[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

/**
 * 母集団標準偏差（n で割る）。
 *
 * 標本標準偏差（n−1）にしないのは、n = 1 で 0 除算になるため。
 * ここで扱うのは「その組み合わせで観察された全件」であり、
 * さらに大きな母集団からの標本として推定する場面ではない。
 */
export function standardDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function round(value: number): number {
  const factor = 10 ** STAT_DECIMALS;
  return Math.round(value * factor) / factor;
}

function isWithinWindow(sample: ObservationSample, window: BaselineOptions["window"]): boolean {
  if (window === undefined) return true;
  // 業務日は `YYYY-MM-DD` の固定長なので辞書順の比較が日付の比較になる。
  return sample.businessDate >= window.from && sample.businessDate <= window.to;
}

/** 連打（同一スタッフ・同日・同一品目・同一値が閾値以上）に当たる鍵の集合。 */
function repeatedInputKeys(samples: readonly ObservationSample[]): ReadonlySet<string> {
  const counts = new Map<string, Set<string>>();
  for (const sample of samples) {
    const key = [sample.recordedById, sample.businessDate, sample.itemCode, sample.qty].join("|");
    const seen = counts.get(key) ?? new Set<string>();
    // 同じ観察が二重に渡っても 1 件として数える。
    seen.add(sample.observationId);
    counts.set(key, seen);
  }
  const repeated = new Set<string>();
  for (const [key, seen] of counts) {
    if (seen.size >= REPEATED_INPUT_THRESHOLD) repeated.add(key);
  }
  return repeated;
}

function groupKeyOf(sample: ObservationSample): BaselineGroupKey {
  return {
    propertyId: sample.propertyId,
    roomTypeId: sample.roomTypeId,
    guestCount: sample.guestCount,
    taskType: sample.taskType,
    itemCode: sample.itemCode,
  };
}

function exclusionOf(
  sample: ObservationSample,
  reason: BaselineExclusionReasonValue,
): BaselineExclusion {
  return {
    ...groupKeyOf(sample),
    observationId: sample.observationId,
    businessDate: sample.businessDate,
    qty: sample.qty,
    reason,
  };
}

/**
 * **宿泊があれば必ず消費される品目**（DECISIONS #252）。
 *
 * 除外ルール①（`ZERO_WITH_BEDS_USED`）はここに載るものにだけ当てる。
 * **分類（リネン / アメニティ）では決めない。** `EXTRA_FUTON` はリネンだが
 * ほとんどの宿泊で使われず、0 が通常の状態なので入れていない。
 *
 * | 入れた | 理由 |
 * |---|---|
 * | `DUVET_COVER` | `bedsUsed > 0` は「ベッドが使われた」の意。使われたベッドには必ず掛布団カバーが付く |
 * | `PILLOW_CASE` | 同上。使われたベッドには必ず枕がある |
 * | `BATH_TOWEL` | 仕様が「人が泊まったのにタオル 0 枚は入力漏れ」と名指ししている（#058） |
 *
 * **`FACE_TOWEL` は入れていない。** 用意はされるが客が使わないことがあり、
 * 0 が正常でありうる。P4-08 で実データの 0 の出方を見てから判断する
 * （`docs/tasks/P4-08.md`）。
 *
 * **シーツ（`SHEET_SINGLE` / `SHEET_DOUBLE`）も入れていない。**
 * ベッドの種類に依存し、片方は 0 が正常。
 */
export const ALWAYS_CONSUMED_ITEM_CODES = [
  "DUVET_COVER",
  "PILLOW_CASE",
  "BATH_TOWEL",
] as const;

/** 除外ルール①を当てる清掃種別。**退室清掃だけ**（上の注記 2）。 */
const ZERO_RULE_TASK_TYPE = "CHECKOUT";

/**
 * 除外ルール①に当たるか。**品目と清掃種別の両方で絞る。**
 *
 * `DEEP` / `COMMON_AREA` / `RECHECK` も対象外。いずれも「宿泊があった
 * 直後」ではなく、`bedsUsed > 0` との結びつきが `CHECKOUT` ほど強くない。
 */
function isZeroWithBedsUsed(sample: ObservationSample): boolean {
  if (sample.taskType !== ZERO_RULE_TASK_TYPE) return false;
  if (!(ALWAYS_CONSUMED_ITEM_CODES as readonly string[]).includes(sample.itemCode)) return false;
  return sample.qty === 0 && sample.bedsUsed > 0;
}

/**
 * 除外ルールを 1 件に当てる（§5.3）。当たらなければ `null`。
 *
 * **仕様の並び順で先に当たったものを理由にする。** 複数のルールに
 * 当たる観察はあるが、`baselineExclusionLog` は 1 行 1 理由で持つ
 * （内訳を足したときに合計が件数を超えないようにするため）。
 *
 * ── 中央値 0 のグループに 5 倍ルールを当てない ──────────
 * 「中央値の 5 倍を超える」は中央値が 0 だと 0 倍で、**正の値がすべて
 * 外れ値になる。** ミネラルウォーターや追加布団のように通常 0 で
 * たまに使われる品目は、実際に使われた日だけが全部消え、p90 が 0 に
 * 固定される。それは誤入力の除外ではなく、実データの削除にあたる。
 * 中央値が正のときだけ当てる（docs/DECISIONS.md #096）。
 *
 * ── 除外ルール①は 2 つの条件で絞る（DECISIONS #252）──────
 * 仕様（PK-SPEC-P3 §5.3）は「値が 0 かつ `bedsUsed > 0`」を**全品目・
 * 全清掃種別**に当てる書き方だが、そのままでは**正常な 0 まで消えて
 * ベースラインが跳ね上がり、差異を見逃す側へ倒れる。**
 *
 *   1. **品目**: `ALWAYS_CONSUMED_ITEM_CODES` の 3 種だけ。
 *      アメニティや追加布団は「泊まったが使わなかった」が正常な観察。
 *   2. **清掃種別**: `CHECKOUT` の標本だけ。滞在中清掃（`STAYOVER`）では
 *      リネンを交換しない運用があり、**0 が正常**。そこで除外すると
 *      母数が「交換した回」だけになる。
 */
function outlierReasonOf(
  sample: ObservationSample,
  provisionalMedian: number,
  repeated: ReadonlySet<string>,
): BaselineExclusionReasonValue | null {
  if (isZeroWithBedsUsed(sample)) return "ZERO_WITH_BEDS_USED";

  if (provisionalMedian > 0 && sample.qty > provisionalMedian * OUTLIER_MEDIAN_MULTIPLIER) {
    return "OVER_MEDIAN_5X";
  }

  if (sample.inputDurationMs !== null && sample.inputDurationMs < MIN_INPUT_DURATION_MS) {
    return "INPUT_TOO_FAST";
  }

  const repeatKey = [sample.recordedById, sample.businessDate, sample.itemCode, sample.qty].join(
    "|",
  );
  if (repeated.has(repeatKey)) return "REPEATED_INPUT";

  return null;
}

/**
 * 観察値からベースラインを算出する（§5.2）。
 *
 * 手順は仕様のとおり ①除外 → ②グルーピング → ③統計量。
 * 「値が中央値の 5 倍を超える」の中央値は、①のうち差異・未記録を
 * 落とした段階の**暫定中央値**を使う（外れ値を含んだ中央値で外れ値を
 * 判定する。中央値は極端な値に引きずられにくいため成立する）。
 */
export function computeBaseline(
  samples: readonly ObservationSample[],
  options: BaselineOptions = {},
): BaselineComputation {
  const minSampleSize = options.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE;
  const exclusions: BaselineExclusion[] = [];

  // ── ① 除外（§5.2 の 1.）──────────────────────────────
  const candidates: ObservationSample[] = [];
  // 除外率（W-22）の分母。ウィンドウ内で値を持っていた観察の件数。
  let consideredCount = 0;
  for (const sample of samples) {
    if (!isWithinWindow(sample, options.window)) continue;
    // 未記録の観察は値を持たない。除外ではなく、そもそも母数に入らない。
    if (sample.observationSkipped) continue;
    consideredCount += 1;
    if (sample.hasFinding) {
      exclusions.push(exclusionOf(sample, "FINDING_ATTACHED"));
      continue;
    }
    candidates.push(sample);
  }

  const repeated = repeatedInputKeys(candidates);

  // ── ② グルーピング（§5.2 の 2.）──────────────────────
  const groups = new Map<string, ObservationSample[]>();
  for (const sample of candidates) {
    const key = baselineKeyOf(groupKeyOf(sample));
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [sample]);
    else bucket.push(sample);
  }

  // ── ③ 統計量（§5.2 の 3.）────────────────────────────
  const baselines: BaselineResult[] = [];
  for (const [key, bucket] of groups) {
    const provisional = [...bucket].map((sample) => sample.qty).sort((a, b) => a - b);
    const provisionalMedian = percentile(provisional, 50);

    const kept: number[] = [];
    for (const sample of bucket) {
      const reason = outlierReasonOf(sample, provisionalMedian, repeated);
      if (reason === null) kept.push(sample.qty);
      else exclusions.push(exclusionOf(sample, reason));
    }
    // 全件が除外されたグループは行を作らない。**0 件で信頼可能にしない。**
    if (kept.length === 0) continue;

    const values = kept.sort((a, b) => a - b);
    const first = bucket[0];
    /* c8 ignore next -- グループは 1 件以上あるため通らない */
    if (first === undefined) continue;
    baselines.push({
      ...groupKeyOf(first),
      key,
      sampleSize: values.length,
      medianQty: round(percentile(values, 50)),
      p10Qty: round(percentile(values, 10)),
      p90Qty: round(percentile(values, 90)),
      maxQty: round(values[values.length - 1] ?? 0),
      stdDev: round(standardDeviation(values)),
      isReliable: values.length >= minSampleSize,
    });
  }

  // 決定性のため、入力順ではなくキー順で返す。
  baselines.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  exclusions.sort((a, b) => {
    const keyA = `${baselineKeyOf(a)}|${a.observationId}`;
    const keyB = `${baselineKeyOf(b)}|${b.observationId}`;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });

  return { baselines, exclusions, consideredCount };
}
