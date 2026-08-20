import { checkHealth, type HealthState } from "@pk/db";
import { useLoaderData, type LoaderFunctionArgs } from "react-router";

import { t } from "../../lib/i18n.js";
import { requirePlatformOperator } from "../../lib/platform/requireOperator.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

/**
 * サービス稼働（PF-03 / プロトタイプ 01）。
 *
 *   /plat/status
 *
 * task: docs/tasks/PF-03.md
 *
 * ── **出す元のある指標だけを並べる** ────────────────────
 * プロトタイプ 01 は KPI 5 つ（稼働率 30 日 / API 応答 p95 / 同期キュー /
 * 同期の失敗 / 写真ストレージ）と、表に p95・直近 24 時間・エラー率を
 * 置いている。**この 8 つはどれも出す元が無い**（OPEN_QUESTIONS #114）。
 *
 * 出す元が在るのは**コンポーネントの状態だけ** — `checkHealth()` が
 * shards / storage / cache / queues を `ok` / `degraded` で返す。
 * したがってこの画面は**状態の表と注記だけ**を持つ。
 *
 * **無い指標を 0 や「—」で埋めない。列ごと置かない**（#107 と同じ判断 /
 * PF-03「やらないこと」）。埋めると、計測が無いことが画面から見えなくなり、
 * 「稼働率 0%」を実測と読む人が出る。
 *
 * ── シャード番号を出さない（完了条件 / architecture.md §1）──
 * `ShardHealth` は**件数しか持たない**（`expected` / `declared` /
 * `reachable`）。番号も内部ホスト名も型の上で存在しない。
 *
 * ── 事象履歴を置いていない ──────────────────────────────
 * 表が無い（#114）。**書き込みの口も作らない** — 運営が自分で履歴を
 * 書ける画面にすると、記録の意味が変わる。
 */

/** 表に出す 1 行。**状態だけ。** */
interface ComponentRow {
  key: Parameters<typeof t>[0];
  state: HealthState;
  /** 補足（シャードの到達本数など）。**番号ではなく件数。** */
  note: string | null;
}

interface StatusData {
  overall: HealthState;
  components: ComponentRow[];
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<StatusData> {
  const env = getEnv(context);
  // 門を通す（表示名は使わない — この画面に「ようこそ」は要らない）。
  await requirePlatformOperator(env, request, new Date());

  const health = await checkHealth(env);

  return {
    overall: health.state,
    components: [
      {
        key: "plat.status.component.shards",
        state: health.shards.state,
        // 「16 本中 16 本」。**どの番号かは出さない。**
        note: `${String(health.shards.reachable)} / ${String(health.shards.expected)}`,
      },
      { key: "plat.status.component.storage", state: health.storage, note: null },
      { key: "plat.status.component.cache", state: health.cache, note: null },
      { key: "plat.status.component.queues", state: health.queues, note: null },
    ],
  };
}

export default function PlatStatus() {
  const data = useLoaderData<StatusData>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("plat.status.title")}</h1>
      </div>

      <p className="pk-page__lede">
        {data.overall === "ok" ? t("plat.status.overall.ok") : t("plat.status.overall.degraded")}
      </p>

      <div className="pk-card">
        <h2 className="pk-card__title">{t("plat.status.components")}</h2>
        <table className="pk-table">
          <thead>
            <tr>
              <th scope="col">{t("plat.status.column.component")}</th>
              <th scope="col">{t("plat.status.column.state")}</th>
            </tr>
          </thead>
          <tbody>
            {data.components.map((row) => (
              <tr key={row.key}>
                <td>
                  {t(row.key)}
                  {row.note === null ? null : <span className="pk-muted"> {row.note}</span>}
                </td>
                <td>
                  <span
                    className={
                      row.state === "ok" ? "pk-tag pk-tag--ok" : "pk-tag pk-tag--warn"
                    }
                  >
                    {row.state === "ok" ? t("plat.status.state.ok") : t("plat.status.state.degraded")}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* **計測が無いことを画面に書く。** 空欄で察させない。 */}
        <p className="pk-muted">{t("plat.status.metrics.pending")}</p>
      </div>

      {/* 逐語の注記 2 つ（PF-03「逐語で置く注記」）。**言い換えない。**
          新しい CSS を足さず、既存の `pk-muted` に載せる。 */}
      <div className="pk-card">
        <h2 className="pk-card__title">{t("plat.status.notes")}</h2>
        <p className="pk-muted">{t("plat.status.note.conflict")}</p>
        <p className="pk-muted">{t("plat.status.note.maintenance")}</p>
      </div>
    </section>
  );
}
