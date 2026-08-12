import { ALL_PROPERTIES, type PropertySummary } from "@pk/contracts";
import { Form, useLocation } from "react-router";

import { t } from "../lib/i18n.js";
import { needsPropertySearch } from "../lib/property/summary.js";
import type { SelectableProperty } from "../lib/property/selection.js";

/**
 * 施設セレクタ（PK-SPEC-UI-A01 §2 / PK-SPEC-P0 §23）。
 *
 * task: docs/tasks/P0-21.md（P0-14 の切替だけの形から広げた）
 *
 * ── JavaScript 無しでも切り替わる ───────────────────────
 * `<form>` の submit で切り替える。開閉する独自ドロップダウンにすると
 * JS が要る。現場・共用端末を含めて確実に動くほうを採る。
 * 見た目の展開は `<details>` で作り、**中身は素の form のまま**にしてある。
 *
 * ── 全社サマリーは持つロールにだけ出す ──────────────────
 * §23.1 MUST。**非表示だけで済ませない。** API も 403 を返す
 * （`lib/property/selection.ts` の `hasOrgWideView()`）。
 *
 * ── 9 施設以上で検索を出す ──────────────────────────────
 * §23.2「8 を超える場合」。`<datalist>` で絞り込む。JS 無しでも
 * 一覧そのものは下に出ているので、検索が効かなくても操作できる。
 *
 * ── 集計が無い施設に 0 を出さない ───────────────────────
 * `hasRollup` が偽ならバッジを出さない。0 と出すと「1 件も終わって
 * いない」と読める（`PropertySummaryTable` と同じ判断）。
 */
export function PropertySwitcher(props: {
  properties: readonly SelectableProperty[];
  selectedPropertyId: string | null;
  /** `"ALL"` を選んでいるか。 */
  isOrgScope: boolean;
  /** 全社サマリーを持つロールか。 */
  canViewOrgWide: boolean;
  /** ミニバッジの元。まだ読めていなければ空でよい。 */
  summaries: readonly PropertySummary[];
}) {
  const location = useLocation();

  if (props.properties.length === 0) {
    return <p className="pk-property pk-property--empty">{t("property.none")}</p>;
  }

  const badgeOf = new Map(props.summaries.map((summary) => [summary.propertyId, summary]));
  const next = `${location.pathname}${location.search}`;

  return (
    <Form className="pk-property" method="post" action="/app/switch-property">
      <input type="hidden" name="next" value={next} />
      <label className="pk-property__label" htmlFor="propertyId">
        {t("property.current")}
      </label>

      {needsPropertySearch(props.properties.length) ? (
        <>
          <input
            className="pk-property__search"
            list="pk-property-options"
            name="search"
            placeholder={t("property.search.placeholder")}
            aria-label={t("property.search")}
          />
          <datalist id="pk-property-options">
            {props.properties.map((property) => (
              <option key={property.id} value={property.name} />
            ))}
          </datalist>
        </>
      ) : null}

      <select
        className="pk-property__select"
        id="propertyId"
        name="propertyId"
        defaultValue={props.isOrgScope ? ALL_PROPERTIES : (props.selectedPropertyId ?? "")}
      >
        {props.canViewOrgWide ? (
          <option value={ALL_PROPERTIES}>{t("property.all")}</option>
        ) : null}
        {props.properties.map((property) => {
          const summary = badgeOf.get(property.id);
          const badge =
            summary === undefined || !summary.hasRollup
              ? ""
              : ` [${String(summary.completedTasks)}]` +
                `[${String(summary.totalTasks - summary.completedTasks)}]` +
                `[${String(summary.openIssues)}]`;
          const rooms =
            summary === undefined ? "" : ` ${String(summary.roomCount)}${t("property.roomCount")}`;
          return (
            <option key={property.id} value={property.id}>
              {`${property.name}${rooms}${badge}`}
            </option>
          );
        })}
      </select>

      <button className="pk-button pk-button--onBrand" type="submit">
        {t("property.switch")}
      </button>
    </Form>
  );
}
