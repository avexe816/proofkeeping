/**
 * 現場画面の施設選択（P1-22 / PK-SPEC-P1 §19.4）。
 *
 * ── 見ているもの ────────────────────────────────────────
 *   選択画面を挟む条件（当日の施設数 × 組織設定の閾値）
 *   「当日中は再表示しない」（`pickedOn` が当日かどうか）
 *   翌日を選んでいる間は開始できない（`startable`）
 *   ラジオの値の往復（`{businessDate}/{propertyId}`）
 */

import { describe, expect, it } from "vitest";

import { ALL_MOBILE_PROPERTIES, decidePick, decodePickValue, encodePickValue } from "./pick.js";

const TODAY = "2026-08-10";
const TOMORROW = "2026-08-11";
const YESTERDAY = "2026-08-09";
const PROPERTY = "a1b2c3__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH";

describe("decidePick — 選択画面を挟むか（§19.4）", () => {
  it("未選択で 4 施設なら選択画面へ", () => {
    const decision = decidePick({
      pick: undefined,
      today: TODAY,
      todayPropertyCount: 4,
      threshold: 4,
    });
    expect(decision.showPicker).toBe(true);
  });

  it("未選択で 3 施設なら挟まない（§19.3 のグループ表示）", () => {
    const decision = decidePick({
      pick: undefined,
      today: TODAY,
      todayPropertyCount: 3,
      threshold: 4,
    });
    expect(decision.showPicker).toBe(false);
    expect(decision.filterPropertyId).toBeNull();
  });

  it("組織設定を 2 にすれば 2 施設で挟む", () => {
    expect(
      decidePick({ pick: undefined, today: TODAY, todayPropertyCount: 2, threshold: 2 })
        .showPicker,
    ).toBe(true);
  });

  it("当日ぶんの選択があれば挟まない（当日中は再表示しない）", () => {
    const decision = decidePick({
      pick: { propertyId: PROPERTY, businessDate: TODAY, pickedOn: TODAY },
      today: TODAY,
      todayPropertyCount: 6,
      threshold: 4,
    });
    expect(decision.showPicker).toBe(false);
    expect(decision.filterPropertyId).toBe(PROPERTY);
  });

  it("前日の選択は効かない（業務日が変わったら出し直す）", () => {
    const decision = decidePick({
      pick: { propertyId: PROPERTY, businessDate: YESTERDAY, pickedOn: YESTERDAY },
      today: TODAY,
      todayPropertyCount: 6,
      threshold: 4,
    });
    expect(decision.showPicker).toBe(true);
  });

  it("前日の選択で、当日が閾値未満なら絞り込まずに一覧を出す", () => {
    const decision = decidePick({
      pick: { propertyId: PROPERTY, businessDate: YESTERDAY, pickedOn: YESTERDAY },
      today: TODAY,
      todayPropertyCount: 2,
      threshold: 4,
    });
    expect(decision.showPicker).toBe(false);
    expect(decision.filterPropertyId).toBeNull();
    expect(decision.businessDate).toBe(TODAY);
  });
});

describe("decidePick — 絞り込みと開始の可否", () => {
  it("「すべての施設」を選んでいれば絞らない", () => {
    const decision = decidePick({
      pick: { propertyId: ALL_MOBILE_PROPERTIES, businessDate: TODAY, pickedOn: TODAY },
      today: TODAY,
      todayPropertyCount: 5,
      threshold: 4,
    });
    expect(decision.filterPropertyId).toBeNull();
    expect(decision.showPicker).toBe(false);
    expect(decision.startable).toBe(true);
  });

  it("翌日を選んでいると開始できない（表示のみ / §19.4）", () => {
    const decision = decidePick({
      pick: { propertyId: PROPERTY, businessDate: TOMORROW, pickedOn: TODAY },
      today: TODAY,
      todayPropertyCount: 5,
      threshold: 4,
    });
    expect(decision.businessDate).toBe(TOMORROW);
    expect(decision.startable).toBe(false);
  });

  it("当日を選んでいれば開始できる", () => {
    expect(
      decidePick({
        pick: { propertyId: PROPERTY, businessDate: TODAY, pickedOn: TODAY },
        today: TODAY,
        todayPropertyCount: 5,
        threshold: 4,
      }).startable,
    ).toBe(true);
  });

  it("未選択のときは当日の一覧を全施設ぶん出す", () => {
    const decision = decidePick({
      pick: undefined,
      today: TODAY,
      todayPropertyCount: 1,
      threshold: 4,
    });
    expect(decision).toEqual({
      showPicker: false,
      businessDate: TODAY,
      filterPropertyId: null,
      startable: true,
    });
  });

  it("担当が 0 施設でも選択画面へ送らない", () => {
    expect(
      decidePick({ pick: undefined, today: TODAY, todayPropertyCount: 0, threshold: 2 })
        .showPicker,
    ).toBe(false);
  });
});

describe("encodePickValue / decodePickValue", () => {
  it("往復する", () => {
    expect(decodePickValue(encodePickValue(TODAY, PROPERTY))).toEqual({
      businessDate: TODAY,
      propertyId: PROPERTY,
    });
  });

  it("「すべての施設」も往復する", () => {
    expect(decodePickValue(encodePickValue(TODAY, ALL_MOBILE_PROPERTIES))).toEqual({
      businessDate: TODAY,
      propertyId: ALL_MOBILE_PROPERTIES,
    });
  });

  it("区切りが無ければ null", () => {
    expect(decodePickValue(PROPERTY)).toBeNull();
  });

  it("業務日の形が違えば null", () => {
    expect(decodePickValue(`8/10/${PROPERTY}`)).toBeNull();
  });

  it("施設が空なら null", () => {
    expect(decodePickValue(`${TODAY}/`)).toBeNull();
  });

  it("空文字は null", () => {
    expect(decodePickValue("")).toBeNull();
  });
});
