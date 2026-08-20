/**
 * テナント一覧の組み立て（PF-04 / プロトタイプ 02）。
 *
 * task: docs/tasks/PF-04.md
 *
 * ── 元はスナップショットだけ（完了条件）─────────────────
 * ここは `getTenantDb()` を呼ばない。読むのは `platform_tenant_snapshot`
 * （PF-02 が 1 テナント 1 行で書いたもの）だけ。**リクエスト時に
 * 16 シャードへ fan-out しない**（DECISIONS #220）。
 *
 * ── 判定はここで出す（保存しない）───────────────────────
 * 「要支援」は `judgeTenantQuality()` に閾値を渡して都度出す
 * （DECISIONS #233）。スナップショットに焼き込まれていないので、
 * PF-14 で閾値を変えれば**過去の行も新しい基準で読み直される。**
 *
 * ── 状態の 4 つは契約と品質の掛け合わせ ─────────────────
 * プロトタイプ 02 の状態列は「稼働中 / 試用中 / 注意 / 停止」。
 * 契約状態（`TRIAL` / `ACTIVE` / `PAST_DUE` / `CANCELED`）だけでは
 * 「注意」が出ない。**「注意」は品質から来る**（要支援のテナント）。
 * この掛け合わせをスナップショットに保存しないのが #233 の要点。
 */

import { judgeTenantQuality, type TenantQualityThresholds } from "@pk/engine";
import type { PlatformOperationSettings, TenantSnapshotRow } from "@pk/db";

/** 画面に出す状態。プロトタイプ 02 の 4 つ。 */
export const TENANT_STATES = ["ACTIVE", "TRIAL", "ATTENTION", "SUSPENDED"] as const;
export type TenantState = (typeof TENANT_STATES)[number];

/** 一覧の 1 行。**個人を特定できる値を 1 つも持たない**（INV-10）。 */
export interface TenantRow {
  organizationId: string;
  name: string;
  plan: string | null;
  contractedOn: string | null;
  trialEndsOn: string | null;
  propertyCount: number;
  roomCount: number;
  staffCount: number;
  /** 完備率（%）。**出せない日は `null`**（0 ではない）。 */
  completenessPercent: number | null;
  state: TenantState;
  /** 「要支援」（3 指標のうち 2 つ以上該当）。 */
  needsSupport: boolean;
}

/** KPI 5 つ（プロトタイプ 02 のヘッダー）。 */
export interface TenantSummary {
  tenants: number;
  active: number;
  trial: number;
  attention: number;
  properties: number;
  rooms: number;
}

/** プラン別の構成（プロトタイプ 02 の表）。 */
export interface PlanRow {
  plan: string;
  tenants: number;
  properties: number;
}

export interface TenantListPage {
  /** どの業務日のスナップショットか。**画面に出す**（いつの数字かを隠さない）。 */
  businessDate: string | null;
  summary: TenantSummary;
  rows: TenantRow[];
  plans: PlanRow[];
  /** 試用中のテナント（プロトタイプ 02 の「🧪 試用中テナントの状況」）。 */
  trials: TenantRow[];
}

/**
 * 状態を決める。
 *
 * **停止が最優先。** 契約が切れているテナントを品質の話にしない。
 * 次が試用（試用中は品質が低くて当たり前の時期があり、「注意」で
 * 塗ると定着途中のテナントが全部赤くなる）。**「注意」は稼働中のみ。**
 */
function stateOf(subscriptionStatus: string | null, needsSupport: boolean): TenantState {
  if (subscriptionStatus === "CANCELED" || subscriptionStatus === "PAST_DUE") return "SUSPENDED";
  if (subscriptionStatus === "TRIAL") return "TRIAL";
  return needsSupport ? "ATTENTION" : "ACTIVE";
}

/**
 * 一覧を組み立てる。
 *
 * @param snapshots `listTenantSnapshots()` の結果（1 業務日ぶん）。
 * @param settings PF-14 の「運用（変更可）」。**閾値をここで決めない。**
 */
export function buildTenantListPage(
  snapshots: readonly TenantSnapshotRow[],
  settings: PlatformOperationSettings,
  businessDate: string | null,
): TenantListPage {
  const thresholds: TenantQualityThresholds = {
    inputDurationFloorSeconds: settings.inputDurationFloorSeconds,
    defaultRateThresholdPercent: settings.defaultRateThresholdPercent,
  };

  const rows: TenantRow[] = snapshots.map((snapshot) => {
    const verdict = judgeTenantQuality(
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
      plan: snapshot.plan,
      contractedOn: snapshot.contractedOn,
      trialEndsOn: snapshot.trialEndsOn,
      propertyCount: snapshot.propertyCount,
      roomCount: snapshot.roomCount,
      staffCount: snapshot.staffCount,
      completenessPercent: verdict.completenessPercent,
      state: stateOf(snapshot.subscriptionStatus, verdict.needsSupport),
      needsSupport: verdict.needsSupport,
    };
  });

  const summary: TenantSummary = {
    tenants: rows.length,
    active: rows.filter((row) => row.state === "ACTIVE").length,
    trial: rows.filter((row) => row.state === "TRIAL").length,
    attention: rows.filter((row) => row.state === "ATTENTION").length,
    properties: rows.reduce((total, row) => total + row.propertyCount, 0),
    rooms: rows.reduce((total, row) => total + row.roomCount, 0),
  };

  // プラン別。**契約の無いテナントは並べない**（プランの行が作れない）。
  const byPlan = new Map<string, PlanRow>();
  for (const row of rows) {
    if (row.plan === null) continue;
    const entry = byPlan.get(row.plan) ?? { plan: row.plan, tenants: 0, properties: 0 };
    entry.tenants += 1;
    entry.properties += row.propertyCount;
    byPlan.set(row.plan, entry);
  }

  return {
    businessDate,
    summary,
    rows,
    plans: [...byPlan.values()],
    trials: rows.filter((row) => row.state === "TRIAL"),
  };
}

/**
 * 試用の残り日数。**業務日どうしの引き算**（`Date.now()` を使わない）。
 * 期限が無い・形が違うなら `null`。
 */
export function trialDaysLeft(trialEndsOn: string | null, businessDate: string | null): number | null {
  if (trialEndsOn === null || businessDate === null) return null;
  const end = Date.parse(`${trialEndsOn}T00:00:00.000Z`);
  const today = Date.parse(`${businessDate}T00:00:00.000Z`);
  if (Number.isNaN(end) || Number.isNaN(today)) return null;
  return Math.round((end - today) / 86_400_000);
}
