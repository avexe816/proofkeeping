/**
 * 稼働照合エンジンの型（PK-SPEC-P4 §9）。
 *
 * task: docs/tasks/P4-03.md
 *
 * ── ここに DB・fetch・環境変数・現在時刻を持ち込まない ──
 * §9 MUST / P4 固有の絶対ルール。**現在時刻は `RuleContext.now` で注入する。**
 * `Date.now()` / `new Date()` をこのディレクトリのどこにも書かない。
 * 同じ入力から同じ出力が出ること（§10.1 の決定性）が、照合を 3 回走らせても
 * 差異が重複しない（§10.2）ことの土台になっている。
 *
 * ── 置き場所が仕様と違う ────────────────────────────────
 * §9 は `packages/engine/src/{index,types,confidence,suppression}.ts` と
 * 書くが、`packages/engine/src` には P1〜P3 のモジュールが 25 個ほど並んでおり、
 * そこに `types.ts` を置くと**何の型なのか読めない**（`baseline.ts` は
 * 既に P3 のものが居る）。照合のぶんを `reconciliation/` にまとめた。
 * 公開の口（`packages/engine/src/index.ts` からの re-export）は §9 のとおり。
 *
 * ── 「検知」ではなく「照合」 ────────────────────────────
 * 型・フィールド・語彙に「不正」「検知」「監視」「疑わしい」を出さない
 * （§1.1 MUST / ui-writing.md §2）。ここが作るのは**差異の下書き**であって、
 * 原因の判断ではない。
 */

/** 3 系統（§1.2）。**欠けている系統は「データなし」と明示する。** */
export const RECONCILIATION_SOURCES = ["occupancy", "observation", "signal"] as const;

export type ReconciliationSource = (typeof RECONCILIATION_SOURCES)[number];

/** 差異の重要度（§2.5）。**並びは高い順。** §4.2 の引き下げが 1 段階ずつ下る。 */
export const SEVERITIES = ["HIGH", "MEDIUM", "LOW"] as const;

export type Severity = (typeof SEVERITIES)[number];

/** 確信度の下限・上限（§1.3）。 */
export const MIN_CONFIDENCE = 0;
export const MAX_CONFIDENCE = 100;

// ────────────────────────────────────────────────────────────
// 照合に渡す事実
// ────────────────────────────────────────────────────────────

/**
 * 施設。
 *
 * `occupancyLinked` と `daysSinceOperationStart` は §4.1 / §4.2 が要求するが、
 * **`property` に対応する列がまだ無い**（OPEN_QUESTIONS #063）。engine は
 * 値を受け取る形にしてあるので、列が入れば呼び出し側の 1 行で効く。
 */
export interface PropertyFact {
  id: string;
  /** 稼働記録の連携があるか（§4.1 / R006 の条件）。 */
  occupancyLinked: boolean;
  /** 運用開始からの日数（§4.1 の 30 日 / §4.2 の 60 日）。分からなければ `null`。 */
  daysSinceOperationStart: number | null;
}

/** 客室。`saleStatus` は §4.1 の抑制条件。 */
export interface RoomFact {
  id: string;
  /** 表示用の部屋番号（§3.2 の `title` が使う）。 */
  number: string;
  roomTypeId: string;
  saleStatus: "ON_SALE" | "MAINTENANCE" | "OUT_OF_ORDER";
}

/**
 * A 系統 — 稼働記録（§2.1）。
 *
 * **氏名・連絡先を持たない。** 照合に要るのは人数と予約参照番号だけ
 * （§2.1 MUST / security.md §3）。ここに欄を足さないこと。
 */
export interface OccupancyFact {
  isOccupied: boolean;
  guestCount: number;
  reservationRef: string | null;
  /** epoch ミリ秒。 */
  checkInAt: number | null;
  checkOutAt: number | null;
  isStayover: boolean;
  nightsTotal: number | null;
  nightIndex: number | null;
  isComplimentary: boolean;
  isHouseUse: boolean;
}

/**
 * B 系統 — 現場の観察（PK-SPEC-P3 §2.1）。
 *
 * `skipped` は「今回は記録しない」を選んだ場合（同 §1.3）。
 * **記録が無いことを差異にしない。** 観察は強制ではない。
 */
export interface ObservationFact {
  skipped: boolean;
  bedsUsed: number;
  trashLevel: "NONE" | "LOW" | "NORMAL" | "HIGH";
  bathTowelUsed: number;
  faceTowelUsed: number;
  handTowelUsed: number;
  bathMatUsed: number;
  slippersUsed: number;
  cupsUsed: number;
  extraFutonUsed: number;
  amenitiesUsed: Readonly<Record<string, number | boolean>>;
  /** 既定値のまま確定したか（§4.2 で確信度 −20）。 */
  usedDefaults: boolean;
}

/** C 系統 — 物理の痕跡（§2.2）。`occurredAt` は epoch ミリ秒。 */
export interface SignalFact {
  signalType:
    | "DOOR_UNLOCK"
    | "DOOR_OPEN"
    | "KEY_ISSUE"
    | "POWER_ON"
    | "WIFI_JOIN"
    | "SELF_CHECKIN"
    | "SAFE_USE"
    | "MINIBAR_SENSOR";
  occurredAt: number;
  actorType: "GUEST_KEY" | "STAFF_KEY" | "MASTER_KEY" | "MOBILE_KEY" | "UNKNOWN" | null;
}

/** 正当な入室の記録（§2.3）。**あれば抑制する**（§4.1）。 */
export interface AccessLogFact {
  purpose: "INSPECTION" | "MAINTENANCE" | "VENDOR_VISIT" | "SHOWING" | "TRAINING" | "OTHER";
  enteredAt: number;
  exitedAt: number | null;
}

/** 清掃タスク（R004 / R006 / R011 / R012 が見る）。 */
export interface TaskFact {
  taskType: string;
  isCompleted: boolean;
  completedAt: number | null;
  actualMinutes: number | null;
  photoCount: number;
}

/**
 * 消耗ベースライン（PK-SPEC-P3 §2.4）。
 *
 * **`isReliable = false` の行を渡さないこと**（同 §2.4 MUST）。
 * 根拠の薄い統計で差異を出さないため、絞るのは呼び出し側の責務。
 * `sampleSize` は §4.2 の確信度調整（20〜40 で −10）に使う。
 */
export interface BaselineFact {
  itemCode: string;
  sampleSize: number;
  medianQty: number;
  p90Qty: number;
  isReliable: boolean;
}

/**
 * ルールに渡す 1 客室ぶんの文脈。
 *
 * **null は「データなし」であって「0」ではない**（§1.2）。
 * 系統が欠けているのか、値が 0 なのかを取り違えないこと。
 */
export interface RuleContext {
  /** **注入された現在時刻。** `Date.now()` を呼ばない（§9 MUST）。 */
  now: Date;
  businessDate: string;
  property: PropertyFact;
  room: RoomFact;
  occupancy: OccupancyFact | null;
  observation: ObservationFact | null;
  task: TaskFact | null;
  signals: readonly SignalFact[];
  accessLogs: readonly AccessLogFact[];
  baselines: readonly BaselineFact[];
  /**
   * 前日の観察（R005 の「2 日連続」）。無ければ `null`。
   *
   * **R010 と R014 の入力はまだここに無い。** R010 は客室ステータスの
   * 手動上書き履歴（`auditLog`）、R014 は稼働記録の変更履歴を要する。
   * どちらもこの表から直接は引けないため、**そのルールを実装する task
   * （P4-12）が必要な事実をここへ足すこと。** 推測で欄を作っていない。
   */
  previousObservation: ObservationFact | null;
  /**
   * このルールの閾値（`ruleConfig.thresholds`）。
   *
   * **engine が知っている鍵だけを読む。** 知らない鍵は無視する
   * （画面から任意の鍵を入れられても挙動が変わらない）。
   */
  thresholds: Readonly<Record<string, number>>;
}

// ────────────────────────────────────────────────────────────
// ルール
// ────────────────────────────────────────────────────────────

/**
 * ルールが返す差異の下書き。
 *
 * **`confidence` はルールが出した素の値。** §4.2 の調整は
 * `evaluate()` が後から掛ける（ルールごとに調整を書くと、
 * 掛け忘れた 1 つだけが高い確信度を出す）。
 */
export interface FindingDraft {
  ruleCode: string;
  severity: Severity;
  confidence: number;
  title: string;
  summary: string;
  /** 3 系統の根拠。差異詳細画面（W-07）がそのまま出す（§6.2）。 */
  evidence: Readonly<Record<string, unknown>>;
  /** 根拠になったシグナルの識別子。**`length === 1` は単一シグナル**（§1.3）。 */
  matchedSignals: readonly string[];
}

/** 1 つの検出ルール（§9）。**純粋関数。** */
export interface Rule {
  code: string;
  version: string;
  /** UI 表示名（§3.1 の「名称」）。 */
  title: string;
  /** このルールが要る系統（§1.2）。欠けていれば評価そのものを飛ばす。 */
  requires: readonly ReconciliationSource[];
  /** ベースラインを要るか（§4.1 の「開業から 30 日以内」の抑制対象）。 */
  requiresBaseline?: boolean;
  /** 該当しなければ `null`。**「差異なし」を差異として返さない。** */
  evaluate: (context: RuleContext) => FindingDraft | null;
}

// ────────────────────────────────────────────────────────────
// 抑制と結果
// ────────────────────────────────────────────────────────────

/**
 * 抑制の理由（§4.1 の 6 条件に 1 対 1）。
 *
 * **仕様は理由の語彙を定めていない。** §4.3 が「抑制したことを可視化する」と
 * 求めるので、件数だけでなく内訳を出せる形にした。
 */
export const SUPPRESSION_REASONS = [
  /** 客室が MAINTENANCE / OUT_OF_ORDER。 */
  "ROOM_NOT_ON_SALE",
  /** 正当な入室が登録済み。 */
  "ACCESS_LOG_REGISTERED",
  /** 自社利用・招待。 */
  "HOUSE_USE_OR_COMPLIMENTARY",
  /** 施設が稼働記録の連携を持たない（A 系統を要するルール）。 */
  "OCCUPANCY_NOT_LINKED",
  /** 運用開始から 30 日以内（ベースラインが未成熟なルール）。 */
  "OPERATION_TOO_NEW",
  /** `ruleConfig.isEnabled = false`。 */
  "RULE_DISABLED",
  /** 要る系統が揃っていない（§1.2）。**抑制であって「該当なし」ではない。** */
  "SOURCE_UNAVAILABLE",
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** 抑制した 1 件。**握りつぶさず件数と理由を残す**（§4.3）。 */
export interface SuppressedRule {
  ruleCode: string;
  reason: SuppressionReason;
}

/** `evaluate()` の結果。 */
export interface EvaluationResult {
  findings: readonly FindingDraft[];
  /** 抑制した内訳。`reconciliationRun.findingsSuppressed` はこの件数。 */
  suppressed: readonly SuppressedRule[];
  /** 実際に `evaluate()` を呼んだルールの数（`reconciliationRun.rulesEvaluated`）。 */
  rulesEvaluated: number;
}

/** ルールごとの設定（`ruleConfig` / §2.7）。 */
export interface RuleSetting {
  isEnabled: boolean;
  severityOverride: Severity | null;
  thresholds: Readonly<Record<string, number>>;
}

/** `evaluate()` の任意入力。 */
export interface EvaluationOptions {
  /** 揃っている系統（§1.2）。省略すると `RuleContext` の中身から判定する。 */
  availableSources?: readonly ReconciliationSource[];
  /** ルールコード → 設定。無い場合は既定（有効・上書きなし・閾値なし）。 */
  settings?: Readonly<Record<string, RuleSetting>>;
  /**
   * 同一客室・同一ルールで直近 30 日の `FALSE_POSITIVE` 件数（§4.2）。
   * 3 件以上で重要度を 1 段階下げる。
   */
  falsePositiveCounts?: Readonly<Record<string, number>>;
}
