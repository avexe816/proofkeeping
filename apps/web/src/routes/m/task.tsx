/**
 * M-03 タスク詳細（PK-SPEC-P1 §9.3）と写真（§7）。
 *
 * task:  docs/tasks/P1-09.md / docs/tasks/P1-11.md
 * ルール: .claude/rules/ui-writing.md §3 / .claude/rules/security.md §4
 * 参照:  ui-prototypes/mobile/pk-05-task-detail.html / pk-09-photo.html
 *
 * ── 守っているもの ──────────────────────────────────────
 *   経過時間は 1 秒ごとに更新（§9.3）
 *   超過は**オレンジ→グレー。赤を使わない**（INV-05）。判定は
 *   `elapsedToneOf()`（`packages/engine`）で、色は CSS 側
 *   「完了する」は必須が残っていれば非活性。**何が足りないかを直下に出す**
 *   「入室できない」は理由を選ばせる。**その他を常設し説明を求めない**（INV-24）
 *   撮影は `input[type=file][capture]`。**`getUserMedia()` を使わない**（§7.1）
 *
 * ── 経過時間の出どころ ──────────────────────────────────
 * 真実は `taskTimeLog` の並び（§2.2）。loader が `summarizeTimeLogs()` で
 * 実作業時間を出し、作業中なら「そこからの秒数」を画面が足す。
 * **中断中は増えない。** 一覧（M-02）が開始時刻からの時計なのと違い、
 * ここは中断を差し引いた値になる。
 */

import {
  countPhotosByChecklistItem,
  findPropertyById,
  findRoomById,
  findTaskById,
  listChecklistResults,
  listTaskPhotos,
  listTimeLogs,
} from "@pk/db";
import {
  checkCompletion,
  checklistProgress,
  elapsedToneOf,
  summarizeTimeLogs,
  type TaskStatusValue,
} from "@pk/engine";
import { MAX_PHOTOS_PER_TASK, TASK_REASON_CODES, type PhotoErrorCode } from "@pk/contracts";
import { useEffect, useRef, useState } from "react";
import { Link, useLoaderData, useRevalidator, type LoaderFunctionArgs } from "react-router";

import { assertPermission, propertyTarget } from "../../lib/auth/permission.js";
import { createTranslator, type Locale, type MessageKey } from "../../lib/i18n.js";
import { formatElapsed } from "../../lib/mobile/format.js";
import { requireMobileContext } from "../../lib/mobile/session.js";
import { enqueueJson, enqueuePhoto, flushQueue } from "../../lib/offline/queue.js";
import { preparePhoto } from "../../lib/photo/resize.js";
import { signObjectUrl } from "../../lib/storage/signedUrl.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { useOfflineQueue } from "../../ui/mobile/useOfflineQueue.js";

export interface TaskPhotoView {
  photoId: string;
  url: string;
}

export interface TaskDetailData {
  locale: Locale;
  taskId: string;
  roomNumber: string;
  propertyName: string;
  taskType: string;
  status: TaskStatusValue;
  standardMinutes: number;
  note: string | null;
  /** 中断を差し引いた実作業時間（ミリ秒）。 */
  workedMs: number;
  /** 作業中なら、この時刻からの経過を足す（epoch ミリ秒）。 */
  runningSince: number | null;
  checklistDone: number;
  checklistTotal: number;
  /** 必須で未記録の件数（§5.3 の `CHECKLIST_INCOMPLETE`）。 */
  incompleteCount: number;
  /** 写真が要るのに無い件数（同 `PHOTO_REQUIRED`）。 */
  missingPhotoCount: number;
  photos: TaskPhotoView[];
  photoLimit: number;
}

export async function loader({
  request,
  params,
  context,
}: LoaderFunctionArgs): Promise<TaskDetailData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant, locale } = await requireMobileContext(env, request, now);

  const taskId = params.taskId ?? "";
  const task = await findTaskById(env, tenant, taskId);
  // **404。** 別テナント・担当外は存在を示唆しない（INV-31）。
  if (task === undefined) throw new Response(null, { status: 404 });
  assertPermission(tenant, "task.read", propertyTarget([task.propertyId]));

  const [room, property, timeLogs, results, photoCounts, photos] = await Promise.all([
    findRoomById(env, tenant, task.roomId),
    findPropertyById(env, tenant, task.propertyId),
    listTimeLogs(env, tenant, taskId),
    listChecklistResults(env, tenant, taskId),
    countPhotosByChecklistItem(env, tenant, taskId),
    listTaskPhotos(env, tenant, taskId),
  ]);

  const elapsed = summarizeTimeLogs(
    timeLogs.map((row) => ({ event: row.event, occurredAt: row.occurredAt.getTime() })),
  );
  const checklistInputs = results.map((row) => ({
    itemId: row.itemId,
    isRequired: row.isRequired,
    photoRequired: row.photoRequired,
    value: row.value,
    photoCount: photoCounts.get(row.itemId) ?? 0,
  }));
  const progress = checklistProgress(checklistInputs);
  const completion = checkCompletion(checklistInputs);

  return {
    locale,
    taskId,
    roomNumber: room?.roomNumber ?? "",
    propertyName: property?.name ?? "",
    taskType: task.taskType,
    status: task.status,
    standardMinutes: task.standardMinutes,
    note: task.note,
    workedMs: elapsed.workedMs,
    // 区間が開いたまま ＝ 作業中。**サーバー時刻を基準にする。**
    runningSince: elapsed.isOpen ? now.getTime() : null,
    checklistDone: progress.done,
    checklistTotal: progress.total,
    incompleteCount: completion.incompleteItemIds.length,
    missingPhotoCount: completion.missingPhotoItemIds.length,
    photos: await Promise.all(
      photos.map(async (photo) => ({
        photoId: photo.id,
        url: await signObjectUrl(env.SESSION_SECRET, photo.storageKey, now),
      })),
    ),
    photoLimit: MAX_PHOTOS_PER_TASK,
  };
}

/** 送信待ちの写真（まだサーバーに無い）。 */
interface PendingPhoto {
  queueId: string;
  objectUrl: string;
}

export default function TaskDetailRoute(): React.ReactElement {
  const data = useLoaderData<TaskDetailData>();
  const t = createTranslator(data.locale);
  const revalidator = useRevalidator();
  const queue = useOfflineQueue();
  const fileInput = useRef<HTMLInputElement>(null);

  // `revalidator` は毎描画で同一性が変わる。effect の依存から外すため ref に逃がす。
  const revalidate = useRef(revalidator.revalidate);
  revalidate.current = revalidator.revalidate;

  const [now, setNow] = useState(() => Date.now());
  const [status, setStatus] = useState<TaskStatusValue>(data.status);
  const [reasonFor, setReasonFor] = useState<"pause" | "block" | null>(null);
  const [pendingPhotos, setPendingPhotos] = useState<PendingPhoto[]>([]);
  const [photoError, setPhotoError] = useState<PhotoErrorCode | null>(null);
  const [note, setNote] = useState(data.note ?? "");

  // **1 秒ごと**（§9.3）。作業中でなければ止める（電池を使わない）。
  useEffect(() => {
    if (data.runningSince === null) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [data.runningSince]);

  useEffect(() => {
    setStatus(data.status);
  }, [data.status]);

  // 送り終わった写真は手元の仮表示を畳む。**`objectUrl` も解放する。**
  // 畳むと同時に取り直す（サーバー側の 1 枚として出し直すため）。
  useEffect(() => {
    const kept = pendingPhotos.filter((photo) => queue.state.ids.includes(photo.queueId));
    if (kept.length === pendingPhotos.length) return;
    for (const photo of pendingPhotos) {
      if (!kept.includes(photo)) URL.revokeObjectURL(photo.objectUrl);
    }
    setPendingPhotos(kept);
    void revalidate.current();
  }, [queue.state.ids, pendingPhotos]);

  const elapsedMs = data.workedMs + (data.runningSince === null ? 0 : now - data.runningSince);
  const tone = elapsedToneOf(data.standardMinutes, elapsedMs);

  const send = (action: string, body: Record<string, unknown>, nextStatus: TaskStatusValue): void => {
    void (async () => {
      await enqueueJson({ url: `/api/v1/tasks/${data.taskId}/${action}`, body });
      // 楽観的更新（§8.3）。**押した瞬間に画面が動く。**
      setStatus(nextStatus);
      setReasonFor(null);
      // flush トリガー 5「タスク完了操作の直後」。
      await flushQueue();
      void revalidate.current();
    })();
  };

  const addPhoto = (file: File): void => {
    void (async () => {
      setPhotoError(null);
      if (data.photos.length + pendingPhotos.length >= data.photoLimit) {
        setPhotoError("PHOTO_LIMIT_EXCEEDED");
        return;
      }
      let prepared;
      try {
        // **ここで EXIF が落ちる**（canvas の再エンコード / INV-11）。
        prepared = await preparePhoto(file);
      } catch {
        setPhotoError("UNSUPPORTED_IMAGE");
        return;
      }
      const clientId = crypto.randomUUID();
      const item = await enqueuePhoto({
        url: `/api/v1/tasks/${data.taskId}/photos`,
        fields: { clientId, kind: "AFTER" },
        blob: prepared.blob,
      });
      setPendingPhotos((current) => [
        ...current,
        { queueId: item.id, objectUrl: URL.createObjectURL(prepared.blob) },
      ]);
      await flushQueue();
    })();
  };

  const canComplete =
    data.incompleteCount === 0 &&
    data.missingPhotoCount === 0 &&
    (status === "IN_PROGRESS" || status === "PAUSED");
  const isFinished =
    status === "COMPLETED" || status === "AWAITING_INSPECTION" || status === "CANCELLED";

  return (
    <>
      <header className="pk-m-head">
        {/* §19.8 MUST。**施設名を常時表示する。部屋番号だけを出さない。**
            複数施設のタスクが 1 画面に並ぶため、この画面まで来て初めて
            「別の施設の部屋だった」と気づける状態にしておく。
            見出しの上に置くのは、部屋番号より先に目に入る位置だから。 */}
        <p className="pk-m-head__property">{`🏨 ${data.propertyName}`}</p>
        <div className="pk-m-head__row">
          <Link className="pk-m-head__back" to="/m/today" aria-label={t("m.checklist.back")}>
            ←
          </Link>
          <h1 className="pk-m-head__title">{data.roomNumber}</h1>
        </div>
        <p className="pk-m-head__sub">
          {t(`m.taskType.${data.taskType}` as MessageKey)} ·{" "}
          {t(`m.status.${status}` as MessageKey)}
        </p>
      </header>

      <main className="pk-m-body">
        <section className="pk-m-timer">
          <div>
            <div className="pk-m-timer__value">
              {data.standardMinutes}
              {t("m.task.minutes")}
            </div>
            <div className="pk-m-timer__label">{t("m.task.standard")}</div>
          </div>
          <div>
            {/* 超過の色は `tone`。**赤は無い**（INV-05）。 */}
            <div className={`pk-m-timer__value pk-m-timer__value--${tone}`}>
              {formatElapsed(elapsedMs)}
            </div>
            <div className="pk-m-timer__label">{t("m.task.elapsed")}</div>
          </div>
          <div>
            <div className="pk-m-timer__value">
              {data.checklistDone}/{data.checklistTotal}
            </div>
            <div className="pk-m-timer__label">{t("m.task.checklist")}</div>
          </div>
        </section>

        <Link className="pk-m-link" to={`/m/task/${data.taskId}/checklist`}>
          {t("m.task.checklist")}
          <span className="pk-m-link__count">
            {data.checklistDone}/{data.checklistTotal} ›
          </span>
        </Link>

        <div className="pk-m-section">
          <span>{t("m.task.photos")}</span>
          <span className="pk-m-section__count">
            {data.photos.length + pendingPhotos.length} / {data.photoLimit}
          </span>
        </div>
        <div className="pk-m-photos">
          {data.photos.map((photo) => (
            <div key={photo.photoId} className="pk-m-photos__cell">
              <img src={photo.url} alt="" loading="lazy" />
            </div>
          ))}
          {pendingPhotos.map((photo) => (
            <div key={photo.queueId} className="pk-m-photos__cell">
              <img src={photo.objectUrl} alt="" />
              <span className="pk-m-photos__pending">{t("m.photo.pending")}</span>
            </div>
          ))}
          {isFinished ? null : (
            <button
              type="button"
              className="pk-m-photos__add"
              onClick={() => fileInput.current?.click()}
              aria-label={t("m.photo.add")}
            >
              ＋
            </button>
          )}
        </div>
        {/* **`getUserMedia()` を使わない**（§7.1 MUST）。標準のファイル入力。 */}
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
        <p className="pk-m-note">{t("m.photo.noGps")}</p>
        {photoError === null ? null : (
          <p className="pk-m-notice" role="alert">
            {t(PHOTO_ERROR_MESSAGE[photoError])}
          </p>
        )}

        <div className="pk-m-section">
          <span>{t("m.task.memo")}</span>
          <span className="pk-m-section__count">{t("m.task.memo.optional")}</span>
        </div>
        <p className="pk-m-note">{t("m.task.memo.hint")}</p>
        <textarea
          className="pk-m-memo"
          value={note}
          maxLength={500}
          placeholder={t("m.task.memo.placeholder")}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />

        {isFinished ? null : (
          <>
            {reasonFor === null ? null : (
              <section className="pk-m-panel">
                <p className="pk-m-section">
                  {reasonFor === "block" ? t("m.task.blocked.reason") : t("m.task.pause.reason")}
                </p>
                {TASK_REASON_CODES.map((code) => (
                  <button
                    key={code}
                    type="button"
                    className="pk-m-button pk-m-button--secondary pk-m-button--quiet"
                    onClick={() => {
                      send(
                        reasonFor,
                        { reasonCode: code, note: note === "" ? undefined : note },
                        reasonFor === "block" ? "BLOCKED" : "PAUSED",
                      );
                    }}
                  >
                    {t(`m.reason.${code}` as MessageKey)}
                  </button>
                ))}
                <button
                  type="button"
                  className="pk-m-button pk-m-button--secondary pk-m-button--quiet"
                  onClick={() => {
                    setReasonFor(null);
                  }}
                >
                  {t("m.task.cancel")}
                </button>
              </section>
            )}

            <div className="pk-m-button-row">
              <button
                type="button"
                className="pk-m-button pk-m-button--secondary"
                onClick={() => {
                  if (status === "PAUSED") send("resume", {}, "IN_PROGRESS");
                  else setReasonFor("pause");
                }}
              >
                {status === "PAUSED" ? t("m.task.resume") : t("m.task.pause")}
              </button>
              <button
                type="button"
                className="pk-m-button pk-m-button--secondary"
                onClick={() => {
                  if (status === "BLOCKED") send("unblock", {}, "ASSIGNED");
                  else setReasonFor("block");
                }}
              >
                {status === "BLOCKED" ? t("m.task.unblock") : t("m.task.block")}
              </button>
            </div>

            <button
              type="button"
              className="pk-m-button"
              disabled={!canComplete}
              onClick={() => {
                send("complete", { note: note === "" ? undefined : note }, "COMPLETED");
              }}
            >
              {t("m.task.complete")}
            </button>
            {/* **何が足りないかを直下に出す**（§9.3）。 */}
            {data.incompleteCount === 0 ? null : (
              <p className="pk-m-note">
                {t("m.task.complete.blockedByChecklist")}（{data.incompleteCount}）
              </p>
            )}
            {data.missingPhotoCount === 0 ? null : (
              <p className="pk-m-note">
                {t("m.task.complete.blockedByPhoto")}（{data.missingPhotoCount}）
              </p>
            )}
          </>
        )}

      </main>
    </>
  );
}

/** 写真の受け付けを断った理由。**撮り直しで直るものだけを画面に出す。** */
const PHOTO_ERROR_MESSAGE: Record<PhotoErrorCode, MessageKey> = {
  INVALID_REQUEST: "m.photo.unsupported",
  PHOTO_LIMIT_EXCEEDED: "m.photo.limitReached",
  PHOTO_TOO_LARGE: "m.photo.tooLarge",
  UNSUPPORTED_IMAGE: "m.photo.unsupported",
};
