/**
 * `packages/billing` の語彙が schema と一致していることの検査。
 *
 * task: docs/tasks/P5-04.md
 *
 * ── なぜ import ではなく比較なのか ──────────────────────
 * `packages/billing` は依存ゼロ（CLAUDE.md §5）。schema から import すると
 * 純粋関数の側に D1 への辺ができる。かわりに**値を写し、片側だけ増えたら
 * ここが落ちる**形にしてある。`packages/engine` の `TASK_TYPE_VALUES` と
 * 同じ扱い。
 *
 * **検査を `packages/db` 側に置いてある。** billing の spec から `@pk/db` を
 * 引くと、Workers 型を持たないルートの tsconfig に `packages/db` が
 * 引き戻される（ルート tsconfig の `exclude` の注記）。辺の向きは
 * db → billing にしかできない。
 */

import {
  OCCUPANCY_CHANNEL_CODE_VALUES,
  SIGNAL_ACTOR_TYPE_VALUES,
  SIGNAL_TYPE_VALUES,
} from "@pk/integrations";
import {
  BILLING_PERIOD_STATUS_VALUES,
  INVOICE_ITEM_CODE_VALUES,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHOD_VALUES,
  ITEM_CODE_BY_TASK_TYPE,
  ITEM_CODE_LABELS,
  TASK_TYPE_LABELS,
  TASK_TYPE_VALUES,
  TAX_ROUNDING_MODE_VALUES,
} from "@pk/billing";
import { describe, expect, it } from "vitest";

import { BILLING_PERIOD_STATUSES, INVOICE_ITEM_CODES, PAYMENT_METHODS } from "./invoice.js";
import {
  OCCUPANCY_CHANNEL_CODES,
  SIGNAL_ACTOR_TYPES,
  SIGNAL_TYPES,
} from "./reconciliation.js";
import { TAX_ROUNDING_MODES } from "./organization.js";
import { TASK_TYPES } from "./task.js";

describe("packages/billing の語彙が schema と一致する", () => {
  it("清掃種別", () => {
    expect([...TASK_TYPE_VALUES]).toEqual([...TASK_TYPES]);
  });

  it("品目コード（PK-SPEC-P5 §2.4）", () => {
    expect([...INVOICE_ITEM_CODE_VALUES]).toEqual([...INVOICE_ITEM_CODES]);
  });

  it("端数処理方式（billing.md §4）", () => {
    expect([...TAX_ROUNDING_MODE_VALUES]).toEqual([...TAX_ROUNDING_MODES]);
  });

  it("月次締めの状態（PK-SPEC-P5 §2.8）", () => {
    expect([...BILLING_PERIOD_STATUS_VALUES]).toEqual([...BILLING_PERIOD_STATUSES]);
  });

  it("入金方法（同 §2.6）", () => {
    expect([...PAYMENT_METHOD_VALUES]).toEqual([...PAYMENT_METHODS]);
  });

  it("すべての入金方法に表示名がある", () => {
    for (const method of PAYMENT_METHODS) {
      expect(PAYMENT_METHOD_LABELS[method]).toBeTruthy();
    }
  });
});

describe("表示名と対応表", () => {
  it("すべての清掃種別に表示名がある", () => {
    for (const type of TASK_TYPES) {
      expect(TASK_TYPE_LABELS[type]).toBeTruthy();
    }
  });

  it("すべての品目コードに表示名がある", () => {
    for (const code of INVOICE_ITEM_CODES) {
      expect(ITEM_CODE_LABELS[code]).toBeTruthy();
    }
  });

  it("対応表の値はすべて品目コードの語彙に含まれる", () => {
    for (const code of Object.values(ITEM_CODE_BY_TASK_TYPE)) {
      expect(INVOICE_ITEM_CODES).toContain(code);
    }
  });

  it("RECHECK には品目コードが無い（§2.4 の表に対応する行が無い）", () => {
    // 近い名前へ寄せない。¥0 明細＋警告で残す（docs/OPEN_QUESTIONS.md #069）。
    expect(ITEM_CODE_BY_TASK_TYPE.RECHECK).toBeUndefined();
  });
});

/**
 * `packages/integrations` の語彙が schema と一致していることの検査（P6-03）。
 *
 * ── なぜ import ではなく比較なのか ──────────────────────
 * アダプタ層は連携先ごとの差を吸収する場所で、**D1 を知らない**
 * （PK-SPEC-P6 §1.1）。schema から import すると integrations → db の辺が
 * でき、アダプタが直接テーブルを触れるようになる。`packages/billing` と
 * 同じく値を写し、**片側だけ増えたらここが落ちる**形にしてある。
 *
 * ずれると何が起きるか: アダプタが返した `signalType` を `physical_signal`
 * へ入れる段で落ちる。**受信の時点では通り、保存の時点で失敗する**ので、
 * 外部システム側には 200 を返したあとに消える。それを防ぐ。
 */
describe("packages/integrations の語彙が schema と一致する（PK-SPEC-P6 §4.1）", () => {
  it("物理シグナルの種類", () => {
    expect([...SIGNAL_TYPE_VALUES]).toEqual([...SIGNAL_TYPES]);
  });

  it("鍵の種別", () => {
    expect([...SIGNAL_ACTOR_TYPE_VALUES]).toEqual([...SIGNAL_ACTOR_TYPES]);
  });

  it("販売経路", () => {
    expect([...OCCUPANCY_CHANNEL_CODE_VALUES]).toEqual([...OCCUPANCY_CHANNEL_CODES]);
  });
});
