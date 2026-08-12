import type { LoaderFunctionArgs } from "react-router";
import { NotFoundError } from "@pk/db";
import { useLoaderData } from "react-router";

import { t } from "../../lib/i18n.js";
import { switchProperty } from "../../lib/property/selection.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/**
 * 施設 1 件の客室ボード（PK-SPEC-P0 §23.5）。
 *
 *   /app/p/{propertyId}/board
 *
 * task: docs/tasks/P0-21.md
 *
 * ── URL を正とする ──────────────────────────────────────
 * §23.5 MUST。URL の `propertyId` とセッションの選択が違えば **URL 側へ
 * セッションを寄せる。** ブックマークと共有が成立するのはこの向きだけ。
 *
 * ── 権限外は 404 ────────────────────────────────────────
 * `switchProperty()` が `NotFoundError` を投げる。**403 にしない**
 * （INV-31 / architecture.md §2 第 2 層）。
 *
 * ── 中身はまだ無い ──────────────────────────────────────
 * 客室ボードの実体（客室の一覧・状態・リアルタイム配信）は P1。
 * P0-21 が持つのは **URL と選択状態の対応だけ。**
 */
export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, cookieValue } = await requireAppContext(env, request, now);

  const propertyId = params["propertyId"];
  if (propertyId === undefined) throw new NotFoundError();

  // URL を正としてセッションを更新する。到達できない施設なら NotFoundError
  // （middleware / ErrorBoundary が 404 に写す）。
  await switchProperty(env, tenant, cookieValue, propertyId, now, session.membershipId);

  return { propertyId };
}

export default function PropertyBoard() {
  const data = useLoaderData<{ propertyId: string }>();
  return (
    <section className="pk-page">
      <h1 className="pk-page__title">{t("nav.board")}</h1>
      <p className="pk-page__lead" data-property-id={data.propertyId}>
        {t("dashboard.placeholder")}
      </p>
    </section>
  );
}
