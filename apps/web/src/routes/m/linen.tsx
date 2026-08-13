/**
 * M-06 リネン枚数（PK-SPEC-P3 §4.3）。**退室前に出す。**
 *
 * task:  docs/tasks/P3-06.md
 * ルール: .claude/rules/ui-writing.md §3
 *
 * ── 守っているもの ──────────────────────────────────────
 *   チェックリスト完了後に出る（M-04 の下に導線を置く。ここは直接開けない
 *   画面ではないが、**開いても害は無い**ので到達は塞いでいない）
 *   `requireLinen = false` なら**項目を出さない**（§4.3）
 *   **破損・汚損の報告には写真 1 枚が要る**（§4.3 MUST）。P5 の請求根拠
 *   数値入力はステッパーのみ（§1.2）
 *
 * ── 写真はタスクの写真として積む ────────────────────────
 * `linenRecord` に写真の列は無い（§2.3）。撮った 1 枚は
 * `POST /tasks/:id/photos` へ行き、サーバーはリネン記録を受けるときに
 * **タスクに写真が 1 枚以上あるか**を見る（`lib/observation/linen.ts`）。
 * キューは直列なので写真が先に着く。
 *
 * ── 撮影は `input[type=file][capture]` ──────────────────
 * `getUserMedia()` を使わない（security.md §4）。EXIF はクライアントの
 * canvas 再エンコードで落ちる（`lib/photo/resize.ts` / INV-11）。
 */

import { MAX_OBSERVED_QTY, type ItemCodeValue, type LinenListResponse } from "@pk/contracts";
import { findRoomById, findTaskById, listTaskPhotos } from "@pk/db";
import { useRef, useState } from "react";
import { Link, useLoaderData, useNavigate, type LoaderFunctionArgs } from "react-router";

import { assertPermission, propertyTarget } from "../../lib/auth/permission.js";
import { createTranslator, type Locale, type MessageKey } from "../../lib/i18n.js";
import { requireMobileContext } from "../../lib/mobile/session.js";
import { buildLinenResponse } from "../../lib/observation/linen.js";
import { enqueueJson, enqueuePhoto, flushQueue } from "../../lib/offline/queue.js";
import { preparePhoto } from "../../lib/photo/resize.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

export interface LinenData extends LinenListResponse {
  locale: Locale;
  roomNumber: string;
  /** すでにタスクに付いている写真の枚数（§4.3 MUST の判定材料）。 */
  photoCount: number;
}

export async function loader({
  request,
  params,
  context,
}: LoaderFunctionArgs): Promise<LinenData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant, locale } = await requireMobileContext(env, request, now);

  const taskId = params.taskId ?? "";
  const task = await findTaskById(env, tenant, taskId);
  if (task === undefined) throw new Response(null, { status: 404 });
  assertPermission(tenant, "observation.read", propertyTarget([task.propertyId]));

  const [linen, room, photos] = await Promise.all([
    buildLinenResponse(env, tenant, task),
    findRoomById(env, tenant, task.roomId),
    listTaskPhotos(env, tenant, taskId),
  ]);

  return { ...linen, locale, roomNumber: room?.roomNumber ?? "", photoCount: photos.length };
}

/** 品目 1 件ぶんの手元の値。 */
interface ItemState {
  collectedQty: number;
  damagedQty: number;
  stainedQty: number;
}

export default function LinenRoute(): React.ReactElement {
  const data = useLoaderData<LinenData>();
  const t = createTranslator(data.locale);
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);

  const [items, setItems] = useState<Record<string, ItemState>>(() => initialItems(data));
  /** 破損・汚損の欄を開いたか（§4.3 のワイヤーは 2 つのボタン）。 */
  const [showDamage, setShowDamage] = useState(() => hasDamage(initialItems(data)));
  const [addedPhotos, setAddedPhotos] = useState(0);
  const [sending, setSending] = useState(false);

  const update = (code: string, next: Partial<ItemState>): void => {
    setItems((current) => ({
      ...current,
      [code]: { ...(current[code] ?? emptyItem()), ...next },
    }));
  };

  const addPhoto = (file: File): void => {
    void (async () => {
      let prepared;
      try {
        prepared = await preparePhoto(file);
      } catch {
        return;
      }
      await enqueuePhoto({
        url: `/api/v1/tasks/${data.taskId}/photos`,
        fields: { clientId: crypto.randomUUID(), kind: "OTHER" },
        blob: prepared.blob,
      });
      setAddedPhotos((current) => current + 1);
      await flushQueue();
    })();
  };

  const damageReported = hasDamage(items);
  const photoTotal = data.photoCount + addedPhotos;
  // §4.3 MUST。**サーバーも同じ判定をする**（画面の非活性は権限制御でも
  // 業務ルールの実装でもない / CLAUDE.md §5）。
  const needsPhoto = damageReported && photoTotal === 0;

  const submit = (): void => {
    setSending(true);
    void (async () => {
      await enqueueJson({
        url: `/api/v1/tasks/${data.taskId}/linen`,
        method: "PUT",
        body: {
          entries: data.enabledItemCodes.map((code) => ({
            itemCode: code,
            collectedQty: items[code]?.collectedQty ?? 0,
            // 供給枚数は現場で数えない（§4.3 のワイヤーは回収のみ）。
            suppliedQty: 0,
            damagedQty: items[code]?.damagedQty ?? 0,
            stainedQty: items[code]?.stainedQty ?? 0,
          })),
          clientTs: Date.now(),
        },
      });
      await flushQueue();
      await navigate(`/m/task/${data.taskId}`);
    })();
  };

  if (!data.requireLinen || data.enabledItemCodes.length === 0) {
    return (
      <>
        <Head roomNumber={data.roomNumber} taskId={data.taskId} label={t("m.linen.title")} back={t("m.linen.back")} />
        <main className="pk-m-body">
          <p className="pk-m-empty">{t("m.linen.notRequired")}</p>
          <Link className="pk-m-button pk-m-button--secondary" to={`/m/task/${data.taskId}`}>
            {t("m.linen.back")}
          </Link>
        </main>
      </>
    );
  }

  return (
    <>
      <Head roomNumber={data.roomNumber} taskId={data.taskId} label={t("m.linen.title")} back={t("m.linen.back")} />

      <main className="pk-m-body">
        <section className="pk-m-obs">
          <p className="pk-m-section">{t("m.linen.collected")}</p>
          {data.enabledItemCodes.map((code) => (
            <LinenStepper
              key={code}
              label={t(`m.obs.item.${code}` as MessageKey)}
              value={items[code]?.collectedQty ?? 0}
              minusLabel={t("m.obs.minus")}
              plusLabel={t("m.obs.plus")}
              onChange={(value) => {
                update(code, { collectedQty: value });
              }}
            />
          ))}
        </section>

        {showDamage ? (
          <section className="pk-m-obs">
            <p className="pk-m-section">{t("m.linen.damage")}</p>
            {data.enabledItemCodes.map((code) => (
              <div key={code}>
                <LinenStepper
                  label={`${t(`m.obs.item.${code}` as MessageKey)} · ${t("m.linen.damaged")}`}
                  value={items[code]?.damagedQty ?? 0}
                  minusLabel={t("m.obs.minus")}
                  plusLabel={t("m.obs.plus")}
                  onChange={(value) => {
                    update(code, { damagedQty: value });
                  }}
                />
                <LinenStepper
                  label={`${t(`m.obs.item.${code}` as MessageKey)} · ${t("m.linen.stained")}`}
                  value={items[code]?.stainedQty ?? 0}
                  minusLabel={t("m.obs.minus")}
                  plusLabel={t("m.obs.plus")}
                  onChange={(value) => {
                    update(code, { stainedQty: value });
                  }}
                />
              </div>
            ))}

            <p className="pk-m-note">{t("m.linen.photoHint")}</p>
            <button
              type="button"
              className="pk-m-button pk-m-button--secondary"
              onClick={() => fileInput.current?.click()}
            >
              {t("m.linen.addPhoto")}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) addPhoto(file);
                event.target.value = "";
              }}
            />
            <p className="pk-m-note">
              {t("m.linen.photoCount")} {photoTotal}
            </p>
          </section>
        ) : (
          <button
            type="button"
            className="pk-m-button pk-m-button--secondary"
            onClick={() => {
              setShowDamage(true);
            }}
          >
            {t("m.linen.reportDamage")}
          </button>
        )}

        <button
          type="button"
          className="pk-m-button"
          disabled={sending || needsPhoto}
          onClick={submit}
        >
          {t("m.linen.submit")}
        </button>
        {needsPhoto ? <p className="pk-m-note">{t("m.linen.photoRequired")}</p> : null}
      </main>
    </>
  );
}

/** 見出し。**施設名は M-03 が出す**（ここは部屋番号だけ）。 */
function Head({
  roomNumber,
  taskId,
  label,
  back,
}: {
  roomNumber: string;
  taskId: string;
  label: string;
  back: string;
}): React.ReactElement {
  return (
    <header className="pk-m-head">
      <div className="pk-m-head__row">
        <Link className="pk-m-head__back" to={`/m/task/${taskId}`} aria-label={back}>
          ←
        </Link>
        <h1 className="pk-m-head__title">{roomNumber}</h1>
      </div>
      <p className="pk-m-head__sub">{label}</p>
    </header>
  );
}

/** M-05 と同じ形のステッパー。**キーボードを出さない**（§1.2）。 */
function LinenStepper({
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
  const clamp = (next: number): number =>
    next < 0 ? 0 : Math.min(Math.floor(next), MAX_OBSERVED_QTY);
  return (
    <div className="pk-m-step">
      <span className="pk-m-step__label">{label}</span>
      <div className="pk-m-step__control">
        <button
          type="button"
          className="pk-m-step__button"
          aria-label={`${label} ${minusLabel}`}
          onClick={() => {
            onChange(clamp(value - 1));
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
            onChange(clamp(value + 1));
          }}
        >
          ＋
        </button>
      </div>
    </div>
  );
}

function emptyItem(): ItemState {
  return { collectedQty: 0, damagedQty: 0, stainedQty: 0 };
}

/** 保存済みの値を手元へ。**未記録の品目は 0。** */
function initialItems(data: LinenData): Record<string, ItemState> {
  const items: Record<string, ItemState> = {};
  for (const code of data.enabledItemCodes) items[code] = emptyItem();
  for (const row of data.data) {
    items[row.itemCode] = {
      collectedQty: row.collectedQty,
      damagedQty: row.damagedQty,
      stainedQty: row.stainedQty,
    };
  }
  return items;
}

/** 破損・汚損が 1 件でもあるか。 */
function hasDamage(items: Record<string, ItemState>): boolean {
  return Object.values(items).some((item) => item.damagedQty > 0 || item.stainedQty > 0);
}

/** 品目コードの型を画面側でも保つ（`enabledItemCodes` は契約の語彙）。 */
export type LinenItemCode = ItemCodeValue;
