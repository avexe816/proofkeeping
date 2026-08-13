/**
 * M-12 再清掃（PK-SPEC-P2 §11.4 / §4.6）。
 *
 * task:  docs/tasks/P2-07.md
 * ルール: .claude/rules/ui-writing.md §3
 *
 * ── §11.4 のワイヤーをそのまま ───────────────────────────
 * ```
 * 302号室  再清掃 1回目
 * 期限 14:30
 *
 * 浴室 > 鏡
 *   水滴跡
 *   「右下に水滴跡があります」
 *   [検査写真]
 *
 * [ 再清掃を開始 ]
 * 完了後
 *   [ 写真を撮る ]
 *   [ 再清掃を完了 ]
 * ```
 *
 * ── 出さないもの ────────────────────────────────────────
 *   **合格した項目**（§4.6「清掃者は差戻し項目だけを表示できる」）。
 *     絞りはサーバー側（`listReworkItems()`）で、ここは並べるだけ。
 *   **検査者の名前。** 差戻しは人ではなく項目に紐づく（§1.2）。
 *   **期限超過の赤色。** オレンジまで（ui-writing.md §3「急かさない」）。
 *   **「やり直し」の語。** 「再清掃」（同 §2）。
 *
 * ── 「すべて直した」の一括操作を置かない ────────────────
 * 項目ごとのチェックを付けさせない。**何が直ったかは次のラウンドの検査が
 * 判定する**（§4.6 / ui-writing.md §4「清掃員に『判断』させない」）。
 * だから画面にあるのは「開始」「写真」「完了」の 3 つだけ。
 *
 * ── 送信はオフラインキューに載せない ────────────────────
 * 再清掃の開始と完了はタスクの状態を動かし、その先に検査の排他が続く
 * （M-09 と同じ判断 / DECISIONS #068）。**その場で送り、失敗はその場で
 * 見せる。** 写真は M-03 と同じ経路なのでキューに載る。
 */

import { MAX_PHOTO_BYTES, type ReworkItem } from "@pk/contracts";
import { findOpenReworkCycleByTask, findRoomById, findTaskById } from "@pk/db";
import { useState } from "react";
import { Link, useLoaderData, useNavigate, type LoaderFunctionArgs } from "react-router";

import { assertPermission, propertyTarget } from "../../lib/auth/permission.js";
import { createTranslator, type Locale, type MessageKey } from "../../lib/i18n.js";
import { requireMobileContext } from "../../lib/mobile/session.js";
import { preparePhoto } from "../../lib/photo/resize.js";
import { assertReworkVisible, listReworkItems } from "../../lib/rework/detail.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

export interface ReworkScreenData {
  locale: Locale;
  taskId: string;
  /** 未決着の差戻しが無ければ `null`（画面は「もう片付いています」を出す）。 */
  reworkCycleId: string | null;
  roomNumber: string;
  round: number;
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "WAIVED" | null;
  /** 再清掃期限（epoch ms）。無ければ `null`。 */
  dueAt: number | null;
  items: ReworkItem[];
  photoCount: number;
}

/**
 * `taskId` で開く（`/m/task/:taskId/rework`）。
 *
 * **差戻しの ID を URL に置かない。** 清掃者は M-02 の一覧から部屋を押して
 * 入るので、差戻しの ID を知らない。未決着の差戻しはタスクにつき最大 1 件
 * （`findOpenReworkCycleByTask()` の注記）。
 */
export async function loader({
  request,
  params,
  context,
}: LoaderFunctionArgs): Promise<ReworkScreenData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant, locale, session } = await requireMobileContext(env, request, now);

  const taskId = params.taskId ?? "";
  const task = await findTaskById(env, tenant, taskId);
  if (task === undefined) throw new Response(null, { status: 404 });
  // 画面はリポジトリを直接呼ぶ（DECISIONS #049）。**loader でも権限を判定する。**
  assertPermission(tenant, "rework.read", propertyTarget([task.propertyId]));

  const room = await findRoomById(env, tenant, task.roomId);
  const row = await findOpenReworkCycleByTask(env, tenant, task.id);
  if (row === undefined) {
    return {
      locale,
      taskId: task.id,
      reworkCycleId: null,
      roomNumber: room?.roomNumber ?? "",
      round: task.currentInspectionRound,
      status: null,
      dueAt: null,
      items: [],
      photoCount: 0,
    };
  }

  // **`CLEANER` は自分の差戻しだけ**（§4.6）。他人のものは 404。
  assertReworkVisible(tenant, row, session.membershipId);

  return {
    locale,
    taskId: task.id,
    reworkCycleId: row.id,
    roomNumber: room?.roomNumber ?? "",
    round: row.round,
    status: row.status,
    dueAt: row.dueAt?.getTime() ?? null,
    items: await listReworkItems(env, tenant, row, now),
    photoCount: 0,
  };
}

export default function ReworkRoute(): React.ReactElement {
  const data = useLoaderData<ReworkScreenData>();
  const t = createTranslator(data.locale);
  const navigate = useNavigate();

  const [status, setStatus] = useState(data.status);
  const [photoCount, setPhotoCount] = useState(data.photoCount);
  const [pending, setPending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [failure, setFailure] = useState<MessageKey | null>(null);

  /** 開始・完了を送る。**その場で送る**（冒頭の注記）。 */
  const send = (action: "start" | "complete"): void => {
    const reworkCycleId = data.reworkCycleId;
    if (reworkCycleId === null) return;
    setPending(true);
    setFailure(null);
    void (async () => {
      try {
        const response = await fetch(`/api/v1/reworks/${reworkCycleId}/${action}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // §14.1。**再送で二重に進まない。**
            "Idempotency-Key": `${reworkCycleId}:${action}`,
          },
          body: JSON.stringify({ clientTs: Date.now() }),
        });
        if (!response.ok) {
          type Failure = { error?: string };
          const empty: Failure = {};
          const body = await response.json<Failure>().catch(() => empty);
          setFailure(failureKey(body.error ?? ""));
          return;
        }
        if (action === "start") {
          setStatus("IN_PROGRESS");
          return;
        }
        // 完了したら一覧へ戻る。**この画面に留めない**（次は検査待ち）。
        await navigate("/m/today");
      } catch {
        setFailure("m.rework.error.offline");
      } finally {
        setPending(false);
      }
    })();
  };

  /**
   * 再清掃の写真を 1 枚送る（§11.4 の「写真を撮る」）。
   *
   * **M-03 と同じ経路**（`POST /tasks/:taskId/photos`）。再清掃の写真を
   * 別の表に分けていないのは、清掃の記録という点で同じものだから。
   * どのラウンドの写真かは撮影時刻と証跡の連鎖から辿れる。
   */
  const addPhoto = (file: File): void => {
    setUploading(true);
    setFailure(null);
    void (async () => {
      try {
        if (file.size > MAX_PHOTO_BYTES * 8) {
          setFailure("m.rework.error.photo");
          return;
        }
        const prepared = await preparePhoto(file);
        const form = new FormData();
        form.set("clientId", crypto.randomUUID());
        form.set("kind", "AFTER");
        form.set("file", new File([prepared.blob], "rework.jpg", { type: "image/jpeg" }));

        const response = await fetch(`/api/v1/tasks/${data.taskId}/photos`, {
          method: "POST",
          body: form,
        });
        if (!response.ok) {
          setFailure("m.rework.error.photo");
          return;
        }
        setPhotoCount((current) => current + 1);
      } catch {
        setFailure("m.rework.error.offline");
      } finally {
        setUploading(false);
      }
    })();
  };

  const settled = status === null || status === "RESOLVED" || status === "WAIVED";

  return (
    <>
      <header className="pk-m-head">
        <div className="pk-m-head__row">
          <Link className="pk-m-head__back" to="/m/today" aria-label={t("m.rework.back")}>
            ←
          </Link>
          <h1 className="pk-m-head__title">
            {data.roomNumber} · {t("m.rework.title")} {data.round}
            {t("m.rework.roundSuffix")}
          </h1>
        </div>
        {/* 期限。**赤にしない**（ui-writing.md §3）。 */}
        {data.dueAt === null ? null : (
          <p className="pk-m-head__sub">
            {t("m.rework.dueAt")} {formatClock(data.dueAt)}
          </p>
        )}
      </header>

      <main className="pk-m-body">
        {settled ? <p className="pk-m-alert">{t("m.rework.settled")}</p> : null}
        {failure === null ? null : (
          <p className="pk-m-alert" role="status">
            {t(failure)}
          </p>
        )}

        {data.items.length === 0 ? (
          <p className="pk-m-empty">{t("m.rework.empty")}</p>
        ) : (
          [...data.items]
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((item) => (
              <section key={item.checklistItemId} className="pk-m-rework">
                {/* §11.4 の「浴室 > 鏡」。 */}
                <p className="pk-m-rework__where">
                  {item.section}
                  {item.section === "" ? "" : " > "}
                  {item.labels[data.locale] ?? item.labels.ja ?? ""}
                </p>
                {item.defectCode === null ? null : (
                  <p className="pk-m-rework__code">
                    {t(`m.inspection.defect.${item.defectCode}` as MessageKey)}
                  </p>
                )}
                {/* 検査者の指示。**そのまま出す。** 要約しない。 */}
                {item.note === null || item.note === "" ? null : (
                  <p className="pk-m-rework__note">{item.note}</p>
                )}
                {item.photos.length === 0 ? null : (
                  <div className="pk-m-rework__photos">
                    {item.photos.map((photo) => (
                      <img
                        key={photo.photoId}
                        className="pk-m-rework__photo"
                        src={photo.url}
                        alt={t("m.rework.inspectionPhoto")}
                      />
                    ))}
                  </div>
                )}
              </section>
            ))
        )}

        {/* ── 操作は 3 つだけ（冒頭の注記）── */}
        {settled || data.reworkCycleId === null ? null : status === "OPEN" ? (
          <button
            type="button"
            className="pk-m-button"
            disabled={pending}
            onClick={() => {
              send("start");
            }}
          >
            {pending ? t("m.rework.starting") : t("m.rework.start")}
          </button>
        ) : (
          <>
            <p className="pk-m-note">
              {t("m.rework.photoCount")} {photoCount}
            </p>
            <label className="pk-m-defect__camera">
              <span>{uploading ? t("m.rework.photoUploading") : t("m.rework.photoAdd")}</span>
              {/* **`getUserMedia()` を使わない**（security.md §4）。 */}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                disabled={uploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file !== undefined) addPhoto(file);
                }}
              />
            </label>
            <button
              type="button"
              className="pk-m-button"
              disabled={pending}
              onClick={() => {
                send("complete");
              }}
            >
              {pending ? t("m.rework.completing") : t("m.rework.complete")}
            </button>
          </>
        )}
      </main>
    </>
  );
}

/**
 * 期限の時刻（`HH:MM`）。
 *
 * **端末のタイムゾーンで出す。** 現場の端末は施設の現地時刻に合っている
 * 前提（`businessDate` の扱いと同じ / architecture.md §7）。
 */
function formatClock(epochMs: number): string {
  const at = new Date(epochMs);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** 進められなかったときの文言キー。 */
function failureKey(error: string): MessageKey {
  const known: Record<string, MessageKey> = {
    REWORK_ALREADY_SETTLED: "m.rework.error.settled",
    INVALID_TRANSITION: "m.rework.error.notStarted",
    TASK_INVALID_TRANSITION: "m.rework.error.taskState",
  };
  return known[error] ?? "m.rework.error.generic";
}
