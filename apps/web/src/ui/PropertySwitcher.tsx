import { Form, useLocation } from "react-router";

import { t } from "../lib/i18n.js";
import type { SelectableProperty } from "../lib/property/selection.js";

/**
 * 施設セレクタ（PK-SPEC-UI-A01 §2 / PK-SPEC-P0 §23）。
 *
 * task: docs/tasks/P0-14.md
 *
 * ── P0-14 の範囲は「切り替わって、残ること」 ────────────
 * v3 標準が定める**状態サマリーの 3 数字（完了 / 作業中 / 要対応）・
 * 全社サマリー・8 施設超の検索は P0-21 の担当。**
 * それらは `dailyPropertyRollup` と `GET /api/v1/properties/summary`
 * （60 秒 KV キャッシュ）を前提にしていて、どちらもまだ無い。
 * 数字を持たないミニバッジを先に置くと、空欄が仕様のように見える。
 *
 * ── JavaScript 無しでも切り替わる ───────────────────────
 * `<form>` の submit で切り替える。開閉する独自ドロップダウンにすると
 * JS が要る。現場・共用端末を含めて確実に動くほうを採る（見た目の
 * ドロップダウンは P0-21 が状態サマリーと一緒に作る）。
 */
export function PropertySwitcher(props: {
  properties: readonly SelectableProperty[];
  selectedPropertyId: string | null;
}) {
  const location = useLocation();

  if (props.properties.length === 0) {
    return <p className="pk-property pk-property--empty">{t("property.none")}</p>;
  }

  return (
    <Form className="pk-property" method="post" action="/app/switch-property">
      <input type="hidden" name="next" value={`${location.pathname}${location.search}`} />
      <label className="pk-property__label" htmlFor="propertyId">
        {t("property.current")}
      </label>
      <select
        className="pk-property__select"
        id="propertyId"
        name="propertyId"
        defaultValue={props.selectedPropertyId ?? ""}
      >
        {props.properties.map((property) => (
          <option key={property.id} value={property.id}>
            {property.name}
          </option>
        ))}
      </select>
      <button className="pk-button pk-button--onBrand" type="submit">
        {t("property.switch")}
      </button>
    </Form>
  );
}
