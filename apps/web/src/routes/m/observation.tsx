/**
 * M-05 入室時の記録 / M-05b 詳細入力（PK-SPEC-P3 §3.2・§4.1・§4.2）。
 *
 * task:  docs/tasks/P3-03.md / docs/tasks/P3-04.md / docs/tasks/P3-05.md
 * ルール: .claude/rules/ui-writing.md §3・§4
 *
 * ── 守っているもの ──────────────────────────────────────
 *   **数値入力にキーボードを出さない**（§4.1）。`input` を 1 つも置かず、
 *   ステッパーと選択ボタンだけで組む
 *   ボタンは 56px 以上（`pk-m-button` / `pk-m-step__button`）
 *   既定値は選択済みで表示され、**1 タップで確定できる**（§1.2）
 *   **「今回は記録しない」が常にある**（§1.3 MUST）。理由は聞かない
 *   画面表示から確定までを `inputDurationMs` に入れる（§4.1）
 *   「不審」「異常」を出さない。設問はすべて「見た数」（§1.1 / §4.4）
 *
 * ── §3.2 の確認画面をこの画面に畳んである ───────────────
 * 仕様は start の直後に「記録する / 今回は記録しない」の 1 枚を挟む形で
 * 描かれている。**分けていない**（docs/DECISIONS.md #098）。挟むと確定まで
 * 最低 2 タップになり、§1.2 の「既定値のままなら 1 タップ」と両立しない。
 * MUST が要求しているのは**スキップの経路が必ずあること**で、それは
 * 画面下の「今回は記録しない」が満たす。
 *
 * ── オフラインで完結する（§8 MUST）─────────────────────
 * 送信はキューへ積むだけ。**積んだ時点で次の画面へ進む。** ここで記録が
 * 失われると P4 が成立しない（P3-05 の完了条件）。`Idempotency-Key` は
 * キューが積んだ id で、再送しても 2 重に登録されない（§7 MUST）。
 */

import {
  MAX_OBSERVED_QTY,
  TRASH_LEVELS,
  type ItemCodeValue,
  type ObservationCounts,
  type ObservationDetailResponse,
  type TrashLevelValue,
} from "@pk/contracts";
import { findRoomById, findTaskById } from "@pk/db";
import { useRef, useState } from "react";
import { Link, useLoaderData, useNavigate, type LoaderFunctionArgs } from "react-router";

import { assertPermission, propertyTarget } from "../../lib/auth/permission.js";
import { createTranslator, type Locale, type MessageKey } from "../../lib/i18n.js";
import { requireMobileContext } from "../../lib/mobile/session.js";
import { buildObservationDetail } from "../../lib/observation/record.js";
import { enqueueJson, flushQueue } from "../../lib/offline/queue.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

export interface ObservationData extends ObservationDetailResponse {
  locale: Locale;
  taskId: string;
  roomNumber: string;
}

export async function loader({
  request,
  params,
  context,
}: LoaderFunctionArgs): Promise<ObservationData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant, locale } = await requireMobileContext(env, request, now);

  const taskId = params.taskId ?? "";
  const task = await findTaskById(env, tenant, taskId);
  // **404。** 別テナント・担当外は存在を示唆しない（INV-31）。
  if (task === undefined) throw new Response(null, { status: 404 });
  assertPermission(tenant, "observation.read", propertyTarget([task.propertyId]));

  const [detail, room] = await Promise.all([
    buildObservationDetail(env, tenant, task),
    findRoomById(env, tenant, task.roomId),
  ]);

  return { ...detail, locale, taskId, roomNumber: room?.roomNumber ?? "" };
}

/** 画面が扱う値。契約の `ObservationCounts` そのまま。 */
type Counts = ObservationCounts;

/** ステッパーで動かす列（数のもの）。**`trashLevel` と `amenitiesUsed` は別。** */
type NumericCountKey = Exclude<keyof Counts, "trashLevel" | "amenitiesUsed">;

/** M-05 に出す数の項目（§4.1）。**ここに増やさない。** */
const PRIMARY_ITEMS = [
  { key: "bathTowelUsed", label: "m.obs.bathTowel" },
  { key: "faceTowelUsed", label: "m.obs.faceTowel" },
  { key: "bathMatUsed", label: "m.obs.bathMat" },
] as const;

/** M-05b に出す数の項目（§4.2）。**任意入力。** */
const DETAIL_ITEMS = [
  { key: "handTowelUsed", label: "m.obs.handTowel" },
  { key: "slippersUsed", label: "m.obs.slippers" },
  { key: "cupsUsed", label: "m.obs.cups" },
  { key: "extraFutonUsed", label: "m.obs.extraFuton" },
] as const;

/** ベッドの選択肢（§4.1 の「0台 / 1台 / 2台」）。 */
const BED_CHOICES = [0, 1, 2, 3] as const;

export default function ObservationRoute(): React.ReactElement {
  const data = useLoaderData<ObservationData>();
  const t = createTranslator(data.locale);
  const navigate = useNavigate();

  /** 画面が開いた時刻。**確定までの実測**（§4.1 の `inputDurationMs`）。 */
  const openedAt = useRef(Date.now());
  const [step, setStep] = useState<1 | 2>(1);
  const [sending, setSending] = useState(false);
  const [counts, setCounts] = useState<Counts>(() => initialCounts(data));

  /** 既定値のまま確定したか（§3.3 MUST）。**触ったら偽になる。** */
  const [touched, setTouched] = useState(false);
  const [note, setNote] = useState(data.data?.note ?? "");

  const update = (next: Partial<Counts>): void => {
    setTouched(true);
    setCounts((current) => ({ ...current, ...next }));
  };

  const setQty = (key: NumericCountKey, value: number): void => {
    update({ [key]: clamp(value) });
  };

  const setAmenity = (code: ItemCodeValue, value: number): void => {
    setTouched(true);
    setCounts((current) => ({
      ...current,
      amenitiesUsed: { ...current.amenitiesUsed, [code]: clamp(value) },
    }));
  };

  /** 記録する。**押した瞬間にキューへ積み、次の画面へ進む。** */
  const submit = (): void => {
    setSending(true);
    void (async () => {
      await enqueueJson({
        url: `/api/v1/tasks/${data.taskId}/observation`,
        method: "PUT",
        body: {
          ...counts,
          ...(note === "" ? {} : { note }),
          inputDurationMs: Date.now() - openedAt.current,
          // 既定値のまま確定したか。**触っていない場合だけ真**（§3.3）。
          usedDefaults: !touched,
          clientTs: Date.now(),
        },
      });
      await flushQueue();
      await navigate(`/m/task/${data.taskId}`);
    })();
  };

  /** 「今回は記録しない」（§1.3 MUST）。**理由を聞かない。** */
  const skip = (): void => {
    setSending(true);
    void (async () => {
      await enqueueJson({
        url: `/api/v1/tasks/${data.taskId}/observation/skip`,
        body: { clientTs: Date.now() },
      });
      await flushQueue();
      await navigate(`/m/task/${data.taskId}`);
    })();
  };

  // 施設が観察記録を使わない設定（§2.6 の `enabled = false`）。
  if (!data.config.enabled) {
    return (
      <>
        <header className="pk-m-head">
          <div className="pk-m-head__row">
            <Link className="pk-m-head__back" to={`/m/task/${data.taskId}`} aria-label={t("m.obs.back")}>
              ←
            </Link>
            <h1 className="pk-m-head__title">{data.roomNumber}</h1>
          </div>
        </header>
        <main className="pk-m-body">
          <p className="pk-m-empty">{t("m.obs.disabled")}</p>
          <Link className="pk-m-button pk-m-button--secondary" to={`/m/task/${data.taskId}`}>
            {t("m.obs.back")}
          </Link>
        </main>
      </>
    );
  }

  const amenityCodes = data.config.enabledItemCodes;

  return (
    <>
      <header className="pk-m-head">
        <div className="pk-m-head__row">
          <Link className="pk-m-head__back" to={`/m/task/${data.taskId}`} aria-label={t("m.obs.back")}>
            ←
          </Link>
          <h1 className="pk-m-head__title">{data.roomNumber}</h1>
        </div>
        <p className="pk-m-head__sub">
          {step === 1 ? t("m.obs.title") : t("m.obs.detailTitle")} · {step}/2
        </p>
      </header>

      <main className="pk-m-body">
        {step === 1 ? (
          <>
            <p className="pk-m-note">{t("m.obs.lead")}</p>

            {/* ベッド（§4.1）。**「使われましたか」ではなく「いくつ」**（§1.1）。 */}
            {data.config.requireBeds ? (
              <section className="pk-m-obs">
                <p className="pk-m-section">{t("m.obs.beds")}</p>
                <div className="pk-m-check__values">
                  {BED_CHOICES.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className="pk-m-check__value"
                      aria-pressed={counts.bedsUsed === value}
                      onClick={() => {
                        update({ bedsUsed: value });
                      }}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {/* ゴミの量（§4.1）。4 段階。**「異常」の語を使わない**（§4.4）。 */}
            {data.config.requireTrash ? (
              <section className="pk-m-obs">
                <p className="pk-m-section">{t("m.obs.trash")}</p>
                <div className="pk-m-check__values">
                  {TRASH_LEVELS.map((level: TrashLevelValue) => (
                    <button
                      key={level}
                      type="button"
                      className="pk-m-check__value"
                      aria-pressed={counts.trashLevel === level}
                      onClick={() => {
                        update({ trashLevel: level });
                      }}
                    >
                      {t(`m.obs.trash.${level}` as MessageKey)}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {/* 使用済みタオル（§4.1）。ステッパーのみ。 */}
            {data.config.requireTowels ? (
              <section className="pk-m-obs">
                <p className="pk-m-section">{t("m.obs.towels")}</p>
                {PRIMARY_ITEMS.map((item) => (
                  <Stepper
                    key={item.key}
                    label={t(item.label)}
                    value={counts[item.key]}
                    onChange={(value) => {
                      setQty(item.key, value);
                    }}
                    minusLabel={t("m.obs.minus")}
                    plusLabel={t("m.obs.plus")}
                  />
                ))}
              </section>
            ) : null}

            <button type="button" className="pk-m-button" disabled={sending} onClick={submit}>
              {t("m.obs.submit")}
            </button>

            <button
              type="button"
              className="pk-m-button pk-m-button--secondary"
              disabled={sending}
              onClick={() => {
                setStep(2);
              }}
            >
              {t("m.obs.detail")}
            </button>

            {/* §1.3 MUST。**理由も聞かない。** */}
            <button
              type="button"
              className="pk-m-button pk-m-button--secondary pk-m-button--quiet"
              disabled={sending}
              onClick={skip}
            >
              {t("m.obs.skip")}
            </button>
          </>
        ) : (
          <>
            {/* M-05b（§4.2）。**任意入力であることを先に書く。** */}
            <p className="pk-m-note">{t("m.obs.detailLead")}</p>

            {data.config.requireAmenities && amenityCodes.length > 0 ? (
              <section className="pk-m-obs">
                <p className="pk-m-section">{t("m.obs.amenities")}</p>
                {amenityCodes.map((code) => (
                  <Stepper
                    key={code}
                    label={t(`m.obs.item.${code}` as MessageKey)}
                    value={qtyOf(counts.amenitiesUsed[code])}
                    onChange={(value) => {
                      setAmenity(code, value);
                    }}
                    minusLabel={t("m.obs.minus")}
                    plusLabel={t("m.obs.plus")}
                  />
                ))}
              </section>
            ) : null}

            <section className="pk-m-obs">
              <p className="pk-m-section">{t("m.obs.other")}</p>
              {DETAIL_ITEMS.map((item) => (
                <Stepper
                  key={item.key}
                  label={t(item.label)}
                  value={counts[item.key]}
                  onChange={(value) => {
                    setQty(item.key, value);
                  }}
                  minusLabel={t("m.obs.minus")}
                  plusLabel={t("m.obs.plus")}
                />
              ))}
            </section>

            <div className="pk-m-section">
              <span>{t("m.obs.note")}</span>
              <span className="pk-m-section__count">{t("m.obs.optional")}</span>
            </div>
            <textarea
              className="pk-m-memo"
              value={note}
              maxLength={300}
              placeholder={t("m.obs.note.placeholder")}
              onChange={(event) => {
                setTouched(true);
                setNote(event.target.value);
              }}
            />

            <button type="button" className="pk-m-button" disabled={sending} onClick={submit}>
              {t("m.obs.submit")}
            </button>
            <button
              type="button"
              className="pk-m-button pk-m-button--secondary"
              disabled={sending}
              onClick={() => {
                setStep(1);
              }}
            >
              {t("m.obs.back")}
            </button>
          </>
        )}
      </main>
    </>
  );
}

/**
 * ステッパー（§1.2 MUST「数値入力はキーボードを出さない」）。
 *
 * **`input` を持たない。** 数は `output` に出すだけで、変更は 2 つの
 * ボタンからしか起きない。手袋でも押せるよう 56px 角にする。
 */
function Stepper({
  label,
  value,
  onChange,
  minusLabel,
  plusLabel,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  minusLabel: string;
  plusLabel: string;
}): React.ReactElement {
  return (
    <div className="pk-m-step">
      <span className="pk-m-step__label">{label}</span>
      <div className="pk-m-step__control">
        <button
          type="button"
          className="pk-m-step__button"
          aria-label={`${label} ${minusLabel}`}
          onClick={() => {
            onChange(value - 1);
          }}
        >
          −
        </button>
        <output className="pk-m-step__value">{value}</output>
        <button
          type="button"
          className="pk-m-step__button"
          aria-label={`${label} ${plusLabel}`}
          onClick={() => {
            onChange(value + 1);
          }}
        >
          ＋
        </button>
      </div>
    </div>
  );
}

/** 0〜上限に収める。**負の数を作らない。** */
function clamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), MAX_OBSERVED_QTY);
}

/** アメニティの値。§12.4 が未決なので `boolean` も来うる（契約の注記）。 */
function qtyOf(value: number | boolean | undefined): number {
  if (value === undefined) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  return clamp(value);
}

/**
 * 初期値。**記録済みならその値、無ければ既定値**（§3.3）。
 *
 * 記録済みの値を既定で上書きしないこと。入力し直しに来た清掃員が、
 * 前回入れた数を見失う。
 */
function initialCounts(data: ObservationData): Counts {
  if (data.data === null) return { ...data.defaults };
  const row = data.data;
  return {
    bedsUsed: row.bedsUsed,
    trashLevel: row.trashLevel,
    bathTowelUsed: row.bathTowelUsed,
    faceTowelUsed: row.faceTowelUsed,
    handTowelUsed: row.handTowelUsed,
    bathMatUsed: row.bathMatUsed,
    slippersUsed: row.slippersUsed,
    cupsUsed: row.cupsUsed,
    extraFutonUsed: row.extraFutonUsed,
    amenitiesUsed: row.amenitiesUsed,
  };
}
