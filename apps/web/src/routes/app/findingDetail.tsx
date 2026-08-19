/**
 * W-07 差異詳細（PK-SPEC-P4 §6.2・§6.3）。
 *
 *   /app/audit/findings/:findingId
 *
 * task:  docs/tasks/P4-07.md
 * ルール: .claude/rules/ui-writing.md §2 / .claude/rules/security.md §1
 * 参照:  ui-prototypes/owner/pkown-v3-B-findings-records.html（05 差異の詳細）
 *
 * ── 3 系統を必ず並列に出す（§6.2 MUST）──────────────────
 * ① 稼働記録 ② 現場観察 ③ 物理信号 の 3 枠を**常に描く。**
 * データが無い枠には「データなし」と明示する。枠ごと消さないこと。
 * 消すと「3 系統のうち何が欠けているのか」が読めず、確信度の意味も薄れる。
 *
 * ── 清掃員は「見たもの」しか答えていない ────────────────
 * §1.1 / PK-SPEC-P3 §1.1。観察の枠には「この部屋は使われましたか」に
 * 対する答えは無い。ベッドの台数・ゴミの量・タオルの枚数だけがあり、
 * 突き合わせはサーバーが行った。**その説明を画面に常時置く**
 * （プロトタイプ 05 の注記と同じ文面）。
 *
 * ── 「不正」と言わない ──────────────────────────────────
 * §6.3 MUST。`CONFIRMED_DISCREPANCY` を選んでも文面は
 * 「差異を確認し、社内で対応」。ui-writing.md §2 の禁止語を出さない。
 *
 * ── 状態を変えられるのは `OWNER` / `ORG_ADMIN` だけ ──────
 * §6.4。`PROPERTY_MANAGER` は読めるが閉じられない。**フォームを隠すだけに
 * しない**（action 側でも `assertPermission()` を通す）。
 */

import {
  FINDING_ASSIGNABLE_STATUSES,
  FINDING_FALSE_POSITIVE_CODES,
  FINDING_RESOLVED_CODES,
  RESOLUTION_NOTE_MAX_LENGTH,
  findingStatusRequestSchema,
  type FindingDetailResponse,
} from "@pk/contracts";
import { NotFoundError } from "@pk/db";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import {
  ORGANIZATION_TARGET,
  assertPermission,
  can,
  propertyTarget,
} from "../../lib/auth/permission.js";
import { t } from "../../lib/i18n.js";
import { applyFindingStatus, collectFindingDetail } from "../../lib/reconciliation/findings.js";
import {
  ACCESS_PURPOSE_LABEL,
  FALSE_POSITIVE_CODE_LABEL,
  RESOLVED_CODE_LABEL,
  SEVERITY_LABEL,
  STATUS_LABEL,
  resolutionCodeLabel,
} from "../../lib/reconciliation/labels.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";
import type { MessageKey } from "../../lib/i18n.js";
import type { RoomAccessPurpose } from "@pk/db";

interface FindingDetailData {
  detail: FindingDetailResponse;
  canWrite: boolean;
}

/** ゴミの量（PK-SPEC-P3 §2.1）の文言キー。**「異常」と言わない。** */
const TRASH_LABEL: Record<string, MessageKey> = {
  NONE: "finding.trash.none",
  LOW: "finding.trash.low",
  NORMAL: "finding.trash.normal",
  HIGH: "finding.trash.high",
};

export async function loader({
  request,
  params,
  context,
}: LoaderFunctionArgs): Promise<FindingDetailData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);

  const findingId = params["findingId"];
  if (findingId === undefined) throw new NotFoundError();

  const detail = await collectFindingDetail(env, tenant, findingId);
  // **存在しない差異と担当外施設の差異を区別しない**（INV-31 / §6.4 MUST）。
  if (detail === null) throw new NotFoundError();

  assertPermission(tenant, "finding.read", propertyTarget([detail.finding.propertyId]));

  return { detail, canWrite: can(tenant, "finding.write", ORGANIZATION_TARGET) };
}

interface FindingDetailResult {
  saved?: boolean;
  /** 解決コード・理由の形が要件を満たしていない。**保存していない。** */
  rejected?: boolean;
}

/**
 * 状態の変更（§6.3）。
 *
 * API（`routes/api/v1/findings.ts`）と同じ関数を通る（`applyFindingStatus()`）。
 * **判定・監査ログ・誤検知の学習をここに写経しないこと。**
 */
export async function action({
  request,
  params,
  context,
}: ActionFunctionArgs): Promise<FindingDetailResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const findingId = params["findingId"];
  if (findingId === undefined) throw new NotFoundError();

  // **施設を解決する前に組織全体の書き込み権限で閉じる**（API と同じ順）。
  assertPermission(tenant, "finding.write", ORGANIZATION_TARGET);

  const form = await request.formData();
  const parsed = findingStatusRequestSchema.safeParse({
    status: form.get("status"),
    resolutionCode: emptyToNull(form.get("resolutionCode")),
    resolutionNote: emptyToNull(form.get("resolutionNote")),
  });
  if (!parsed.success) return { rejected: true };

  const updated = await applyFindingStatus(env, tenant, {
    findingId,
    status: parsed.data.status,
    resolutionCode: parsed.data.resolutionCode,
    resolutionNote: parsed.data.resolutionNote,
    actorId: session.membershipId,
  });
  if (updated === null) throw new NotFoundError();

  return { saved: true };
}

/** 空欄は `null`。**空文字を解決コードとして通さない。** */
function emptyToNull(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value;
}

export default function FindingDetail() {
  const { detail, canWrite } = useLoaderData<FindingDetailData>();
  const result = useActionData<FindingDetailResult>();
  const { finding, sources, reference, history } = detail;

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{finding.title}</h1>
        <a className="pk-button" href="/app/audit/findings">
          {t("finding.backToList")}
        </a>
      </div>

      {/* 確認の順序を固定する STEP 表示（プロトタイプ 05 の確定事項）。 */}
      <ol className="pk-steps">
        <li className="pk-steps__item pk-steps__item--done">{t("finding.step1")}</li>
        <li className="pk-steps__item pk-steps__item--on">{t("finding.step2")}</li>
        <li className="pk-steps__item">{t("finding.step3")}</li>
        <li className="pk-steps__item">{t("finding.step4")}</li>
      </ol>

      <p className="pk-muted">
        {`${finding.propertyName} ${finding.roomNumber} / ${finding.businessDate} / ${finding.ruleCode}`}
      </p>
      <p className="pk-muted">
        {`${t(SEVERITY_LABEL[finding.severity])} / ${t("finding.column.confidence")} ${String(
          finding.confidence,
        )}% / ${t(STATUS_LABEL[finding.status])}`}
      </p>
      <p>{finding.summary}</p>

      {/* ── 3 系統（§6.2 MUST）。枠は常に 3 つ。 ─────────────── */}
      <h2 className="pk-pagehead__title">{t("finding.sources")}</h2>
      <div className="pk-meters">
        <section className="pk-meter">
          <h3 className="pk-meter__label">{t("finding.source.occupancy")}</h3>
          {sources.occupancy === null ? (
            <p className="pk-muted">{t("finding.noData")}</p>
          ) : (
            <dl className="pk-items">
              <dt>{t("finding.occupancy.state")}</dt>
              <dd>
                {sources.occupancy.isOccupied
                  ? t("finding.occupancy.occupied")
                  : t("finding.occupancy.vacant")}
              </dd>
              <dt>{t("finding.occupancy.reservationRef")}</dt>
              <dd>{sources.occupancy.reservationRef ?? t("finding.none")}</dd>
              <dt>{t("finding.occupancy.guestCount")}</dt>
              <dd>{String(sources.occupancy.guestCount)}</dd>
              <dt>{t("finding.occupancy.source")}</dt>
              <dd>{sources.occupancy.source}</dd>
            </dl>
          )}
        </section>

        <section className="pk-meter">
          <h3 className="pk-meter__label">{t("finding.source.observation")}</h3>
          {sources.observation === null ? (
            <p className="pk-muted">
              {sources.observationSkipped ? t("finding.observationSkipped") : t("finding.noData")}
            </p>
          ) : (
            <dl className="pk-items">
              <dt>{t("finding.observation.beds")}</dt>
              <dd>{String(sources.observation.bedsUsed)}</dd>
              <dt>{t("finding.observation.trash")}</dt>
              <dd>{t(TRASH_LABEL[sources.observation.trashLevel] ?? "finding.noData")}</dd>
              <dt>{t("finding.observation.bathTowel")}</dt>
              <dd>{String(sources.observation.bathTowelUsed)}</dd>
              <dt>{t("finding.observation.faceTowel")}</dt>
              <dd>{String(sources.observation.faceTowelUsed)}</dd>
              <dt>{t("finding.observation.bathMat")}</dt>
              <dd>{String(sources.observation.bathMatUsed)}</dd>
              <dt>{t("finding.observation.input")}</dt>
              <dd>
                {sources.observation.usedDefaults
                  ? t("finding.observation.usedDefaults")
                  : t("finding.observation.changed")}
              </dd>
              {sources.observation.recordedByName === null ? null : (
                <>
                  <dt>{t("finding.observation.recordedBy")}</dt>
                  <dd>{sources.observation.recordedByName}</dd>
                </>
              )}
            </dl>
          )}
        </section>

        <section className="pk-meter">
          <h3 className="pk-meter__label">{t("finding.source.signal")}</h3>
          {sources.signals === null ? (
            <p className="pk-muted">{t("finding.noData")}</p>
          ) : (
            <>
              <ul className="pk-items">
                {sources.signals.map((signal) => (
                  <li key={`${signal.signalType}|${String(signal.occurredAt)}`}>
                    {`${signal.signalType} ${new Date(signal.occurredAt).toISOString()}`}
                  </li>
                ))}
              </ul>
              {/*
                PK-SPEC-P6 §4.3 MUST「差異詳細画面に『鍵の種別は取得できて
                いません』と明示する」。**取れているものと取れていないものを
                混ぜて出さない。** 1 件でも不明なら出す（不明のぶんだけ
                根拠が弱い / R002・R013 は確信度を 25 下げている）。
              */}
              {sources.signals.some(
                (signal) => signal.actorType === null || signal.actorType === "UNKNOWN",
              ) ? (
                <p className="pk-muted">{t("finding.signal.actorTypeUnknown")}</p>
              ) : null}
            </>
          )}
        </section>
      </div>

      {/* §1.1 / PK-SPEC-P3 §1.1。**この文は消さないこと。** */}
      <p className="pk-notice">{t("finding.observedOnly")}</p>

      {/* ── 確信度の根拠（プロトタイプ「確信度の内訳」）────────
          engine は根拠を文として持つ（`matchedSignals`）。寄与度の数値は
          出力に無いため出さない（DECISIONS #202）。全件を隠さず並べる。 */}
      {finding.matchedSignals.length === 0 ? null : (
        <>
          <h2 className="pk-pagehead__title">{t("finding.signals.title")}</h2>
          <ol className="pk-signals">
            {finding.matchedSignals.map((signal) => (
              <li key={signal} className="pk-signals__item">
                {signal}
              </li>
            ))}
          </ol>
        </>
      )}

      {/* ── 次に確認していただきたいこと（3 列のうち 2 列は宿泊者以外の
          原因。まず自社側を確認する、という配置 / プロトタイプの注記）。 */}
      <h2 className="pk-pagehead__title">{t("finding.next.title")}</h2>
      <div className="pk-nextchecks">
        <div>
          <h3 className="pk-nextchecks__head">{t("finding.next.front")}</h3>
          <ul className="pk-nextchecks__list">
            <li>{t("finding.next.front1")}</li>
            <li>{t("finding.next.front2")}</li>
            <li>{t("finding.next.front3")}</li>
          </ul>
        </div>
        <div>
          <h3 className="pk-nextchecks__head">{t("finding.next.ops")}</h3>
          <ul className="pk-nextchecks__list">
            <li>{t("finding.next.ops1")}</li>
            <li>{t("finding.next.ops2")}</li>
            <li>{t("finding.next.ops3")}</li>
          </ul>
        </div>
        <div>
          <h3 className="pk-nextchecks__head">{t("finding.next.record")}</h3>
          <ul className="pk-nextchecks__list">
            <li>{t("finding.next.record1")}</li>
            <li>{t("finding.next.record2")}</li>
            <li>{t("finding.next.record3")}</li>
          </ul>
        </div>
      </div>
      {/* 宿泊者への連絡より先に確認を促す（プロトタイプの MUST 相当）。 */}
      <p className="pk-notice pk-notice--warn">{t("finding.next.beforeContact")}</p>

      {/* ── 参考情報（§6.2 中段）───────────────────────────── */}
      <h2 className="pk-pagehead__title">{t("finding.reference")}</h2>
      <dl className="pk-items">
        <dt>{t("finding.reference.photos")}</dt>
        <dd>{String(reference.photoCount)}</dd>
        <dt>{t("finding.reference.access")}</dt>
        <dd>
          {reference.accessLogs.length === 0
            ? t("finding.reference.accessNone")
            : reference.accessLogs
                .map((log) => t(ACCESS_PURPOSE_LABEL[log.purpose as RoomAccessPurpose]))
                .join(" / ")}
        </dd>
        <dt>{t("finding.reference.roomStatus")}</dt>
        <dd>{`${reference.roomSaleStatus} / ${reference.roomHousekeepingStatus}`}</dd>
        <dt>{t("finding.reference.adjacent")}</dt>
        <dd>
          {reference.adjacent
            .map(
              (day) =>
                `${day.businessDate} ${
                  day.isOccupied === null
                    ? t("finding.noData")
                    : day.isOccupied
                      ? t("finding.occupancy.occupied")
                      : t("finding.occupancy.vacant")
                }`,
            )
            .join(" / ")}
        </dd>
      </dl>

      {/* ── 対応（§6.3）──────────────────────────────────── */}
      <h2 className="pk-pagehead__title">{t("finding.action")}</h2>
      {result?.saved === true ? <p className="pk-message">{t("finding.saved")}</p> : null}
      {result?.rejected === true ? <p className="pk-notice--warn">{t("finding.rejected")}</p> : null}

      {canWrite ? (
        <Form method="post" className="pk-fieldset">
          <label className="pk-field">
            <span className="pk-field__label">{t("finding.form.status")}</span>
            <select className="pk-select" name="status" defaultValue={assignableStatusOf(finding.status)}>
              {FINDING_ASSIGNABLE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(STATUS_LABEL[status])}
                </option>
              ))}
            </select>
          </label>

          <label className="pk-field">
            <span className="pk-field__label">{t("finding.form.code")}</span>
            <select className="pk-select" name="resolutionCode" defaultValue={finding.resolutionCode ?? ""}>
              <option value="">{t("finding.form.codeNone")}</option>
              <optgroup label={t("finding.status.resolved")}>
                {FINDING_RESOLVED_CODES.map((code) => (
                  <option key={`resolved-${code}`} value={code}>
                    {t(RESOLVED_CODE_LABEL[code])}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t("finding.status.falsePositive")}>
                {FINDING_FALSE_POSITIVE_CODES.map((code) => (
                  <option key={`fp-${code}`} value={code}>
                    {t(FALSE_POSITIVE_CODE_LABEL[code])}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>

          <label className="pk-field">
            <span className="pk-field__label">{t("finding.form.note")}</span>
            <input
              className="pk-input"
              type="text"
              name="resolutionNote"
              maxLength={RESOLUTION_NOTE_MAX_LENGTH}
              defaultValue={finding.resolutionNote ?? ""}
            />
            <span className="pk-field__hint">{t("finding.form.noteHint")}</span>
          </label>

          <button className="pk-button pk-button--primary" type="submit">
            {t("finding.form.save")}
          </button>
        </Form>
      ) : (
        <p className="pk-muted">{t("finding.readOnly")}</p>
      )}

      {/* ── 対応履歴（§6.2 下段）───────────────────────────── */}
      <h2 className="pk-pagehead__title">{t("finding.history")}</h2>
      <ul className="pk-timeline">
        {history.map((entry) => (
          <li key={`${entry.kind}|${String(entry.at)}`}>
            {`${new Date(entry.at).toISOString()} ${
              entry.kind === "DETECTED"
                ? t("finding.history.detected")
                : t(STATUS_LABEL[entry.status ?? "OPEN"])
            }`}
            {codeTextOf(entry.resolutionCode)}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** `SUPPRESSED` は人が選べない。**初期値は「未対応」へ寄せる。** */
function assignableStatusOf(status: FindingDetailResponse["finding"]["status"]): string {
  return status === "SUPPRESSED" ? "OPEN" : status;
}

/** 解決コードの表示。語彙外なら何も出さない（DB は text なので起こりうる）。 */
function codeTextOf(code: string | null): string {
  const key = resolutionCodeLabel(code);
  return key === null ? "" : ` ${t(key)}`;
}
