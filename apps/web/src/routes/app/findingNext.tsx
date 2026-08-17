/**
 * W-07 差異の詳細への入口 — 次に確認する 1 件へ直行する。
 *
 *   /app/audit/findings/next
 *
 * 経緯:  人間の指示 2026-08-17「差異の詳細を実現」。詳細画面
 *        （`/app/audit/findings/:findingId`）は P4-07 で実装済みだが、
 *        ID の無いサイドバーからは指せず「準備中」のままだった
 *        （`navigation.ts` の旧注記）。
 * 参照:  ui-prototypes/owner/pkown-v3-B-findings-records.html（05）
 * ルール: .claude/rules/security.md §1（CLEANER / INSPECTOR は 404）
 *
 * ── 「次の 1 件」の決め方 ───────────────────────────────
 * 未確認（OPEN / REVIEWING）のうち **重要度の高い順 → 確信度の高い順 →
 * 新しい順**。一覧（W-06）の並びと同じ考え方で、朝いちばんに見るべき
 * ものへ最短で届ける。未確認が無ければ空状態を出す（リダイレクトの
 * 輪を作らない）。
 */

import { listFindings } from "@pk/db";
import { redirect, type LoaderFunctionArgs } from "react-router";

import { t } from "../../lib/i18n.js";
import { resolveListScope } from "../../lib/property/listScope.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/** 重要度の並び。`listFindings()` は text 順で並べられない（HIGH < LOW < MEDIUM）。 */
const SEVERITY_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);

  // **これが門**（P7-18 / P7-20 と同じ形）。`CLEANER` / `INSPECTOR` は 404。
  // 施設スコープロールは第 1 層（withTenantScope）が担当施設へ絞る。
  resolveListScope(tenant, "finding.read", null);

  const findings = await listFindings(env, tenant, {
    status: ["OPEN", "REVIEWING"],
    limit: 100,
  });

  const next = [...findings].sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? SEVERITY_RANK.LOW ?? 2) -
        (SEVERITY_RANK[b.severity] ?? SEVERITY_RANK.LOW ?? 2) ||
      b.confidence - a.confidence ||
      b.createdAt.getTime() - a.createdAt.getTime(),
  )[0];

  if (next !== undefined) throw redirect(`/app/audit/findings/${next.id}`);
  return null;
}

/** 未確認の差異が無いときだけ描画される。 */
export default function FindingNext() {
  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("findingNext.title")}</h1>
      </div>
      <p className="pk-muted">{t("findingNext.empty")}</p>
      <p>
        <a className="pk-button" href="/app/audit/findings">
          {t("findingNext.toList")}
        </a>
      </p>
    </section>
  );
}
