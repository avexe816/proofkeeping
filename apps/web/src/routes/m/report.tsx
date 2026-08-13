/**
 * M-13 報告（PK-SPEC-P2 §11.5 / §7 / §8）。
 *
 *   /m/report?taskId=...
 *
 * task:  docs/tasks/P2-13.md
 * ルール: .claude/rules/ui-writing.md §3, §4
 *
 * ── §11.5 のワイヤーをそのまま ───────────────────────────
 * ```
 * 何を報告しますか？
 *
 * [ 忘れ物 ]       [ 設備・清掃の不具合 ]
 * ```
 *
 * ── 3 タップで写真撮影まで（完了条件）───────────────────
 * ```
 * 1 タップ目  [ 忘れ物 ] / [ 不具合 ]
 * 2 タップ目  区分（カテゴリ）のチップ
 * 3 タップ目  [ 写真を撮る ]
 * ```
 * **区分より後ろの入力（説明・場所）は写真の後ろに置く。** 現場は
 * 「まず撮る」で、文字を打つのは落ち着いてから（ui-writing.md §4）。
 * 撮影が 4 タップ目に落ちる並べ方にしないこと。
 *
 * ── 判断させない ────────────────────────────────────────
 * ui-writing.md §4。「貴重品ですか？」ではなく**区分を選ばせる。**
 * 重要度も「止めるべきか」ではなく §8.2 の定義文をそのまま出し、
 * 客室が止まるかどうかはサーバーが決める（engine の `roomEffectOf()`）。
 *
 * ── `CRITICAL` だけ確認を挟む ───────────────────────────
 * §8.2 MUST。ui-writing.md §3 は「確認ダイアログを挟まない」と定めるが、
 * これは客室を止める操作で、押し間違いが販売にまで及ぶ。**画面の確認と
 * サーバー側の `confirmed` の 2 段**（`lib/report/issue.ts`）。
 *
 * ── 送信はオフラインキューに載せない ────────────────────
 * 忘れ物は管理番号の採番を伴い、不具合は客室を止めうる。**どちらも
 * 「送れたか」がその場で分からないと困る**（M-09 / M-12 と同じ判断 /
 * DECISIONS #068）。その場で送り、失敗はその場で見せる。
 */

import {
  ISSUE_CATEGORIES,
  ISSUE_SEVERITIES,
  LOST_ITEM_CATEGORIES,
  type IssueCategoryValue,
  type IssueSeverityValue,
  type LostItemCategoryValue,
} from "@pk/contracts";
import { findRoomById, findTaskById } from "@pk/db";
import { useRef, useState } from "react";
import { useLoaderData, useNavigate, type LoaderFunctionArgs } from "react-router";

import { assertPermission, propertyTarget } from "../../lib/auth/permission.js";
import { createTranslator, type Locale, type MessageKey } from "../../lib/i18n.js";
import { requireMobileContext } from "../../lib/mobile/session.js";
import { preparePhoto } from "../../lib/photo/resize.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

interface ReportScreenData {
  locale: Locale;
  /** 報告元のタスク。**無くてもよい**（タスク外での発見 / §3.5 の `taskId?`）。 */
  taskId: string | null;
  roomId: string;
  roomNumber: string;
}

/**
 * `?taskId=` から客室を解決する。
 *
 * **客室を選ばせない。** 現場は「いまいる部屋」で報告する。M-03 から
 * 遷移するので `taskId` は常に付く。付いていない場合は 404 にして、
 * 部屋の一覧から選び直させる（誤った部屋に紐づけるより安全）。
 */
export async function loader({
  request,
  context,
}: LoaderFunctionArgs): Promise<ReportScreenData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant, locale } = await requireMobileContext(env, request, now);

  const taskId = new URL(request.url).searchParams.get("taskId");
  if (taskId === null) throw new Response(null, { status: 404 });

  const task = await findTaskById(env, tenant, taskId);
  if (task === undefined) throw new Response(null, { status: 404 });
  // 画面はリポジトリを直接呼ぶ（DECISIONS #049）。**loader でも権限を判定する。**
  // 報告できることが前提なので `issue.write` で見る（忘れ物側は同じ範囲）。
  assertPermission(tenant, "issue.write", propertyTarget([task.propertyId]));

  const room = await findRoomById(env, tenant, task.roomId);

  return {
    locale,
    taskId: task.id,
    roomId: task.roomId,
    roomNumber: room?.roomNumber ?? "",
  };
}

/** 2 択（§11.5）。**3 つ目を足さないこと。** */
type ReportKind = "LOST" | "ISSUE";

/** 送信の段階。画面はこれで出し分ける。 */
type Phase = "CHOOSE" | "FORM" | "SENDING" | "DONE";

export default function ReportScreen(): React.ReactElement {
  const data = useLoaderData<ReportScreenData>();
  const t = createTranslator(data.locale);
  const navigate = useNavigate();

  const [kind, setKind] = useState<ReportKind | null>(null);
  const [phase, setPhase] = useState<Phase>("CHOOSE");
  const [lostCategory, setLostCategory] = useState<LostItemCategoryValue>("OTHER");
  const [issueCategory, setIssueCategory] = useState<IssueCategoryValue>("OTHER");
  const [severity, setSeverity] = useState<IssueSeverityValue>("LOW");
  const [description, setDescription] = useState("");
  const [foundLocation, setFoundLocation] = useState("");
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [failure, setFailure] = useState<MessageKey | null>(null);
  /** `CRITICAL` の確認（§8.2 MUST）。**押すまで送らない。** */
  const [confirmedCritical, setConfirmedCritical] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  /** 撮影 → 長辺 1600px / JPEG q=0.7 へ（EXIF はここで落ちる / §7.2）。 */
  async function pickPhoto(file: File): Promise<void> {
    setFailure(null);
    try {
      const prepared = await preparePhoto(file);
      if (photo !== null) URL.revokeObjectURL(photo.url);
      setPhoto({ blob: prepared.blob, url: URL.createObjectURL(prepared.blob) });
    } catch {
      setFailure("m.report.error.photo");
    }
  }

  /**
   * 送信。**報告を立ててから写真を送る**（写真の置き場が親の ID で決まる）。
   *
   * 写真だけ失敗した場合は**報告は残す。** 現場に「もう一度全部やり直し」を
   * させない。画面は「写真を送れませんでした」を出し、報告そのものは成立する。
   */
  async function submit(): Promise<void> {
    setPhase("SENDING");
    setFailure(null);

    const isLost = kind === "LOST";
    const endpoint = isLost ? "/api/v1/lost-items" : "/api/v1/issues";
    const body = isLost
      ? {
          roomId: data.roomId,
          taskId: data.taskId ?? undefined,
          category: lostCategory,
          description: description.trim() === "" ? t("m.report.lost.noDescription") : description,
          foundLocation: foundLocation.trim() === "" ? t("m.report.lost.noLocation") : foundLocation,
        }
      : {
          roomId: data.roomId,
          taskId: data.taskId ?? undefined,
          category: issueCategory,
          severity,
          title: description.trim() === "" ? t(`m.report.issue.category.${issueCategory}` as MessageKey) : description,
          description: description.trim() === "" ? t("m.report.issue.noDescription") : description,
          confirmed: confirmedCritical,
        };

    let created: { lostItemId?: string; issueId?: string };
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setPhase("FORM");
        setFailure(response.status === 409 ? "m.report.error.conflict" : "m.report.error.generic");
        return;
      }
      created = await response.json<{ lostItemId?: string; issueId?: string }>();
    } catch {
      setPhase("FORM");
      setFailure("m.report.error.offline");
      return;
    }

    const id = isLost ? created.lostItemId : created.issueId;
    if (photo !== null && id !== undefined) {
      const form = new FormData();
      form.append("file", photo.blob, "photo.jpg");
      try {
        const response = await fetch(`${endpoint}/${id}/photos`, { method: "POST", body: form });
        // **報告は残す**（冒頭の注記）。写真の失敗だけを伝える。
        if (!response.ok) setFailure("m.report.error.photoUpload");
      } catch {
        setFailure("m.report.error.photoUpload");
      }
    }

    setPhase("DONE");
  }

  // ── ① 2 択（§11.5）──────────────────────────────────
  if (phase === "CHOOSE") {
    return (
      <section className="pk-m-screen">
        <header className="pk-m-head">
          <h1 className="pk-m-head__title">{t("m.report.title")}</h1>
          <p className="pk-m-head__sub">{data.roomNumber}</p>
        </header>
        <main className="pk-m-body">
          <p className="pk-m-report__ask">{t("m.report.ask")}</p>
          <div className="pk-m-report__choice">
            <button
              type="button"
              className="pk-m-button"
              onClick={() => {
                setKind("LOST");
                setPhase("FORM");
              }}
            >
              {t("m.report.choice.lost")}
            </button>
            <button
              type="button"
              className="pk-m-button"
              onClick={() => {
                setKind("ISSUE");
                setPhase("FORM");
              }}
            >
              {t("m.report.choice.issue")}
            </button>
          </div>
          <button
            type="button"
            className="pk-m-button pk-m-button--quiet"
            onClick={() => void navigate(-1)}
          >
            {t("m.report.back")}
          </button>
        </main>
      </section>
    );
  }

  if (phase === "DONE") {
    return (
      <section className="pk-m-screen">
        <main className="pk-m-body">
          <p className="pk-m-alert" role="status">
            {t("m.report.done")}
          </p>
          {failure === null ? null : <p className="pk-m-alert">{t(failure)}</p>}
          <button
            type="button"
            className="pk-m-button"
            onClick={() => void navigate(data.taskId === null ? "/m/today" : `/m/task/${data.taskId}`)}
          >
            {t("m.report.backToTask")}
          </button>
        </main>
      </section>
    );
  }

  const isLost = kind === "LOST";
  const needsConfirm = !isLost && severity === "CRITICAL";
  const sending = phase === "SENDING";

  // ── ② 区分 → ③ 写真 → 説明（冒頭の「3 タップ」）──────
  return (
    <section className="pk-m-screen">
      <header className="pk-m-head">
        <h1 className="pk-m-head__title">
          {isLost ? t("m.report.choice.lost") : t("m.report.choice.issue")}
        </h1>
        <p className="pk-m-head__sub">{data.roomNumber}</p>
      </header>

      <main className="pk-m-body">
        {failure === null ? null : (
          <p className="pk-m-alert" role="alert">
            {t(failure)}
          </p>
        )}

        {/* ② 区分。**チップで 1 タップ。** 判断ではなく分類を選ばせる。 */}
        <p className="pk-m-report__label">{t("m.report.category")}</p>
        <div className="pk-m-chips">
          {(isLost ? LOST_ITEM_CATEGORIES : ISSUE_CATEGORIES).map((value) => {
            const selected = isLost ? lostCategory === value : issueCategory === value;
            return (
              <button
                key={value}
                type="button"
                className={selected ? "pk-m-chip pk-m-chip--on" : "pk-m-chip"}
                aria-pressed={selected}
                onClick={() => {
                  if (isLost) setLostCategory(value as LostItemCategoryValue);
                  else setIssueCategory(value as IssueCategoryValue);
                }}
              >
                {t(
                  (isLost
                    ? `m.report.lost.category.${value}`
                    : `m.report.issue.category.${value}`) as MessageKey,
                )}
              </button>
            );
          })}
        </div>

        {/* 重要度（§8.2）。**定義文をそのまま出す。** 「止めるべきか」は聞かない。 */}
        {isLost ? null : (
          <>
            <p className="pk-m-report__label">{t("m.report.severity")}</p>
            <div className="pk-m-chips">
              {ISSUE_SEVERITIES.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={severity === value ? "pk-m-chip pk-m-chip--on" : "pk-m-chip"}
                  aria-pressed={severity === value}
                  onClick={() => {
                    setSeverity(value);
                    setConfirmedCritical(false);
                  }}
                >
                  {t(`m.report.issue.severity.${value}` as MessageKey)}
                </button>
              ))}
            </div>
            <p className="pk-m-note">{t(`m.report.issue.severityNote.${severity}` as MessageKey)}</p>
          </>
        )}

        {/* ③ 写真。**説明より前に置く**（冒頭の「3 タップ」）。 */}
        <p className="pk-m-report__label">{t("m.report.photo")}</p>
        {photo === null ? null : (
          <img className="pk-m-report__preview" src={photo.url} alt={t("m.report.photo")} />
        )}
        <button
          type="button"
          className="pk-m-button"
          onClick={() => fileInput.current?.click()}
        >
          {photo === null ? t("m.report.photoTake") : t("m.report.photoRetake")}
        </button>
        {/* **`getUserMedia()` を使わない**（security.md §4）。標準のファイル入力。 */}
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void pickPhoto(file);
            event.target.value = "";
          }}
        />
        {/* security.md §4。**人物・身分証の撮影を促さない。** 逆に注意を出す。 */}
        <p className="pk-m-note">{t("m.report.photoNote")}</p>

        {/* 文字の入力は最後。既定のままでも送れる（ui-writing.md §4）。 */}
        <label className="pk-m-report__field">
          <span>{isLost ? t("m.report.lost.description") : t("m.report.issue.description")}</span>
          <textarea
            className="pk-m-textarea"
            rows={2}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </label>
        {isLost ? (
          <label className="pk-m-report__field">
            <span>{t("m.report.lost.location")}</span>
            <input
              className="pk-m-input"
              value={foundLocation}
              onChange={(event) => {
                setFoundLocation(event.target.value);
              }}
            />
          </label>
        ) : null}

        {/* §8.2 MUST。**`CRITICAL` だけ確認を挟む。** */}
        {needsConfirm ? (
          <label className="pk-m-report__confirm">
            <input
              type="checkbox"
              checked={confirmedCritical}
              onChange={(event) => {
                setConfirmedCritical(event.target.checked);
              }}
            />
            <span>{t("m.report.issue.criticalConfirm")}</span>
          </label>
        ) : null}

        <button
          type="button"
          className="pk-m-button pk-m-button--primary"
          disabled={sending || (needsConfirm && !confirmedCritical)}
          onClick={() => void submit()}
        >
          {sending ? t("m.report.sending") : t("m.report.submit")}
        </button>
        <button
          type="button"
          className="pk-m-button pk-m-button--quiet"
          disabled={sending}
          onClick={() => {
            setPhase("CHOOSE");
            setKind(null);
          }}
        >
          {t("m.report.back")}
        </button>
      </main>
    </section>
  );
}
