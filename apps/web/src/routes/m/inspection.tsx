/**
 * M-09 検査実施（PK-SPEC-P2 §11.3 / §4.3）。
 *
 * task:  docs/tasks/P2-06.md
 * ルール: .claude/rules/ui-writing.md §3
 *
 * ── §11.3 の MUST を 3 つとも守る ───────────────────────
 *   **画面初期値をすべて PASS にしない。未選択から始める。**
 *     判定は `item.status`（`null` = 未選択）をそのまま出す。
 *     サーバー側も「行が無い＝まだ見ていない」（P2-04）。
 *   **「全て合格」を置かない。**
 *     一括操作のボタンも、ループして全項目を送るコードも書かない。
 *     API 側も 1 項目ずつしか受けない（DECISIONS #064）。
 *   不合格項目だけを次の再清掃画面に表示する → M-12（P2-07）。
 *
 * ── 不合格に要るもの（§4.3）─────────────────────────────
 * 理由コード・コメント 1〜200 文字・写真 1 枚以上。**入力の途中では
 * 弾かない**（写真を撮る前に「不合格」を選べなくなる）。足りないものは
 * 完了時に `POST /complete` が 409 で返し、画面がその項目へ印を付ける。
 *
 * ── 送信はオフラインキューに載せない ────────────────────
 * 検査は施設内で通信のある場所（フロント・事務所）で行う想定で、
 * かつ排他制御を伴う。**「後で送る」にすると、別の検査者と重なったことが
 * 遅れて分かる。** 記録はその場で送り、失敗はその場で見せる。
 */

import {
  DEFECT_CODES,
  DEFECT_NOTE_MAX_LENGTH,
  INSPECTION_ITEM_STATUSES,
  type InspectionDetailResponse,
  type InspectionItem,
} from "@pk/contracts";
import { findInspectionById, findRoomById, findTaskById } from "@pk/db";
import { useState } from "react";
import { Link, useLoaderData, useNavigate, type LoaderFunctionArgs } from "react-router";

import { assertPermission, propertyTarget } from "../../lib/auth/permission.js";
import { listInspectionItems, toInspection } from "../../lib/inspection/detail.js";
import { createTranslator, type Locale, type MessageKey } from "../../lib/i18n.js";
import { requireMobileContext } from "../../lib/mobile/session.js";
import { preparePhoto } from "../../lib/photo/resize.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

export interface InspectionDetailData {
  locale: Locale;
  inspectionId: string;
  roomNumber: string;
  round: number;
  result: "PASS" | "FAIL" | null;
  items: InspectionItem[];
}

export async function loader({
  request,
  params,
  context,
}: LoaderFunctionArgs): Promise<InspectionDetailData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant, locale } = await requireMobileContext(env, request, now);

  const inspectionId = params.inspectionId ?? "";
  const row = await findInspectionById(env, tenant, inspectionId);
  if (row === undefined) throw new Response(null, { status: 404 });
  // 画面はリポジトリを直接呼ぶ（DECISIONS #049）。**loader でも権限を判定する。**
  assertPermission(tenant, "inspection.read", propertyTarget([row.propertyId]));

  const task = await findTaskById(env, tenant, row.taskId);
  if (task === undefined) throw new Response(null, { status: 404 });
  const room = await findRoomById(env, tenant, task.roomId);

  const data = toInspection(row, {
    taskId: task.id,
    propertyId: task.propertyId,
    businessDate: task.businessDate,
    roomNumber: room?.roomNumber ?? "",
  });

  // **担当清掃者の名前を出さない**（判断の前に名前を見せない / OPEN_QUESTIONS #046）。
  return {
    locale,
    inspectionId,
    roomNumber: data.roomNumber,
    round: data.round,
    result: data.result,
    items: await listInspectionItems(env, tenant, row.id, row.taskId),
  };
}

export default function InspectionRoute(): React.ReactElement {
  const data = useLoaderData<InspectionDetailData>();
  const t = createTranslator(data.locale);
  const navigate = useNavigate();

  /** サーバーが返した最新の項目。記録するたびに置き換える。 */
  const [items, setItems] = useState<InspectionItem[]>(data.items);
  /** 送信中の項目。二度押しを止める。 */
  const [pending, setPending] = useState<string | null>(null);
  /** 完了時に返ってきた「足りないもの」。項目に印を付ける。 */
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [failure, setFailure] = useState<MessageKey | null>(null);
  const [completing, setCompleting] = useState(false);
  /** アップロード中の項目。 */
  const [uploading, setUploading] = useState<string | null>(null);

  /**
   * 不合格項目の写真を 1 枚送る（§4.3）。
   *
   * **リサイズと EXIF 除去はクライアントでも行う**（security.md §4 の
   * 「クライアントとサーバーの両方で除去する」）。サーバー側は
   * `uploadInspectionPhoto()` が改めて落とす。
   */
  const addPhoto = (item: InspectionItem, file: File): void => {
    if (item.itemResultId === null) return;
    setUploading(item.checklistItemId);
    setFailure(null);
    void (async () => {
      try {
        const prepared = await preparePhoto(file);
        const form = new FormData();
        form.set("clientId", crypto.randomUUID());
        form.set("itemResultId", item.itemResultId ?? "");
        form.set("file", new File([prepared.blob], "inspection.jpg", { type: "image/jpeg" }));

        const response = await fetch(`/api/v1/inspections/${data.inspectionId}/photos`, {
          method: "POST",
          body: form,
        });
        if (!response.ok) {
          setFailure("m.inspection.error.photo");
          return;
        }
        // 枚数を数え直す。**応答の 1 枚だけを足さない**（再送で二重になる）。
        await reload();
      } catch {
        setFailure("m.inspection.error.offline");
      } finally {
        setUploading(null);
      }
    })();
  };

  /** 項目を引き直す。写真の枚数はサーバーが数えた値を正とする。 */
  const reload = async (): Promise<void> => {
    try {
      const response = await fetch(`/api/v1/inspections/${data.inspectionId}`);
      if (!response.ok) return;
      const body = await response.json<InspectionDetailResponse>();
      setItems(body.items);
    } catch {
      // 通信できないだけ。手元の表示は変えない。
    }
  };

  /** 1 項目を記録する。**まとめて送らない。** */
  const record = (item: InspectionItem, patch: Partial<InspectionItem>): void => {
    const next: InspectionItem = { ...item, ...patch };
    setItems((current) =>
      current.map((row) => (row.checklistItemId === item.checklistItemId ? next : row)),
    );
    if (next.status === null) return;

    setPending(item.checklistItemId);
    setFailure(null);
    void (async () => {
      try {
        const response = await fetch(`/api/v1/inspections/${data.inspectionId}/items`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            checklistItemId: next.checklistItemId,
            status: next.status,
            ...(next.defectCode === null ? {} : { defectCode: next.defectCode }),
            ...(next.note === null || next.note === "" ? {} : { note: next.note }),
            reworkRequired: next.reworkRequired,
          }),
        });
        if (!response.ok) {
          setFailure("m.inspection.error.record");
          return;
        }
        const body = await response.json<InspectionDetailResponse>();
        setItems(body.items);
      } catch {
        setFailure("m.inspection.error.offline");
      } finally {
        setPending(null);
      }
    })();
  };

  const complete = (): void => {
    setCompleting(true);
    setFailure(null);
    void (async () => {
      try {
        const response = await fetch(`/api/v1/inspections/${data.inspectionId}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientTs: Date.now() }),
        });
        if (response.ok) {
          await navigate("/m/inspections");
          return;
        }
        type Failure = { error?: string; details?: Record<string, string[]> };
        const empty: Failure = {};
        const body = await response.json<Failure>().catch(() => empty);
        setMissing(new Set(Object.values(body.details ?? {}).flat()));
        setFailure(completeFailureKey(body.error ?? ""));
      } catch {
        setFailure("m.inspection.error.offline");
      } finally {
        setCompleting(false);
      }
    })();
  };

  const answered = items.filter((item) => item.status !== null).length;
  const failed = items.filter((item) => item.status === "FAIL").length;
  const sections = groupBySection(items);
  const readOnly = data.result !== null;

  return (
    <>
      <header className="pk-m-head">
        <div className="pk-m-head__row">
          <Link className="pk-m-head__back" to="/m/inspections" aria-label={t("m.inspection.back")}>
            ←
          </Link>
          <h1 className="pk-m-head__title">
            {data.roomNumber} · {t("m.inspection.round")} {data.round}
          </h1>
        </div>
        <p className="pk-m-head__sub">
          {answered}/{items.length}
          {failed === 0 ? null : ` · ${t("m.inspection.failedCount")} ${String(failed)}`}
        </p>
      </header>

      <main className="pk-m-body">
        {readOnly ? <p className="pk-m-alert">{t("m.inspection.settled")}</p> : null}
        {failure === null ? null : (
          <p className="pk-m-alert" role="status">
            {t(failure)}
          </p>
        )}

        {items.length === 0 ? (
          <p className="pk-m-empty">{t("m.inspection.empty")}</p>
        ) : (
          sections.map(([section, sectionItems]) => (
            <section key={section} className="pk-m-check">
              <div className="pk-m-check__header">
                <span>{section}</span>
              </div>

              {sectionItems.map((item) => (
                <div
                  key={item.checklistItemId}
                  className={
                    missing.has(item.checklistItemId)
                      ? "pk-m-check__item pk-m-check__item--missing"
                      : "pk-m-check__item"
                  }
                >
                  <div className="pk-m-check__label">
                    {item.labels[data.locale] ?? item.labels.ja ?? ""}
                  </div>

                  {/* 3 値。**既定値を持たせない**（§11.3 MUST）。 */}
                  <div className="pk-m-check__values">
                    {INSPECTION_ITEM_STATUSES.map((status) => (
                      <button
                        key={status}
                        type="button"
                        className="pk-m-check__value"
                        aria-pressed={item.status === status}
                        disabled={readOnly || pending === item.checklistItemId}
                        onClick={() => {
                          record(item, {
                            status,
                            // 不合格を外したら理由も消す（サーバー側も同じ / P2-04）。
                            ...(status === "FAIL" ? { reworkRequired: true } : {
                              defectCode: null,
                              note: null,
                              reworkRequired: false,
                            }),
                          });
                        }}
                      >
                        {t(`m.inspection.status.${status}` as MessageKey)}
                      </button>
                    ))}
                  </div>

                  {/* 不合格のときだけ出す（§11.3 のワイヤー）。 */}
                  {item.status !== "FAIL" ? null : (
                    <div className="pk-m-defect">
                      <label className="pk-m-defect__field">
                        <span>{t("m.inspection.defectCode")}</span>
                        <select
                          value={item.defectCode ?? ""}
                          disabled={readOnly}
                          onChange={(event) => {
                            record(item, {
                              defectCode: (event.target.value === ""
                                ? null
                                : event.target.value) as InspectionItem["defectCode"],
                            });
                          }}
                        >
                          <option value="">{t("m.inspection.defectCodeEmpty")}</option>
                          {DEFECT_CODES.map((code) => (
                            <option key={code} value={code}>
                              {t(`m.inspection.defect.${code}` as MessageKey)}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="pk-m-defect__field">
                        <span>{t("m.inspection.note")}</span>
                        <textarea
                          rows={2}
                          maxLength={DEFECT_NOTE_MAX_LENGTH}
                          defaultValue={item.note ?? ""}
                          disabled={readOnly}
                          onBlur={(event) => {
                            if ((item.note ?? "") === event.target.value) return;
                            record(item, { note: event.target.value });
                          }}
                        />
                      </label>

                      {/*
                        写真（§4.3 で必須）。**`getUserMedia()` を使わない**
                        （security.md §4）。標準のファイル入力＋クライアント側の
                        リサイズ・EXIF 除去（`preparePhoto()`）。
                        `itemResultId` は不合格を記録して初めて埋まる。
                      */}
                      <p className="pk-m-note">
                        {t("m.inspection.photoRequired")} · {t("m.inspection.photoCount")}{" "}
                        {item.photoCount}
                      </p>
                      <label className="pk-m-defect__camera">
                        <span>
                          {uploading === item.checklistItemId
                            ? t("m.inspection.photoUploading")
                            : t("m.inspection.photoAdd")}
                        </span>
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          hidden
                          disabled={readOnly || item.itemResultId === null}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (file !== undefined) addPhoto(item, file);
                          }}
                        />
                      </label>

                      <label className="pk-m-defect__field">
                        <span>{t("m.inspection.reworkRequired")}</span>
                        <input
                          type="checkbox"
                          checked={item.reworkRequired}
                          disabled={readOnly}
                          onChange={(event) => {
                            record(item, { reworkRequired: event.target.checked });
                          }}
                        />
                      </label>
                    </div>
                  )}
                </div>
              ))}
            </section>
          ))
        )}

        {/* **「全て合格」は無い。** 完了は 1 つだけ。 */}
        {readOnly ? null : (
          <button
            type="button"
            className="pk-m-button"
            disabled={completing}
            onClick={complete}
          >
            {completing ? t("m.inspection.completing") : t("m.inspection.complete")}
          </button>
        )}
      </main>
    </>
  );
}

/** セクションごとにまとめる。**並びは `sortOrder` のまま**（清掃時の定義順）。 */
function groupBySection(items: readonly InspectionItem[]): [string, InspectionItem[]][] {
  const sections = new Map<string, InspectionItem[]>();
  for (const item of [...items].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const bucket = sections.get(item.section);
    if (bucket === undefined) sections.set(item.section, [item]);
    else bucket.push(item);
  }
  return [...sections.entries()];
}

/** 完了できなかったときの文言キー。 */
function completeFailureKey(error: string): MessageKey {
  const known: Record<string, MessageKey> = {
    ITEMS_INCOMPLETE: "m.inspection.error.incomplete",
    DEFECT_DETAILS_REQUIRED: "m.inspection.error.defectDetails",
    INSPECTION_ALREADY_COMPLETED: "m.inspection.error.settled",
  };
  return known[error] ?? "m.inspection.error.generic";
}
