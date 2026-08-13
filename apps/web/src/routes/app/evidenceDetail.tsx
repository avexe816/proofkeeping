/**
 * W-07 証跡詳細（PK-SPEC-P2 §12.2 / §12.3）。
 *
 *   /app/p/{propertyId}/evidence/{taskId}
 *
 * task: docs/tasks/P2-09.md
 *
 * ── §12.2 の表示順 ──────────────────────────────────────
 *   ① タスク概要 ② タイムライン ③ 検査 ④ 差戻し
 *   ⑤ 証跡ハッシュと「整合性を確認」 ⑥ 「証跡を ZIP 出力」
 *
 * **③ の「清掃チェックリストと写真」を持っていない。** 項目ごとの
 * 結果と写真は M-03 / M-04 / M-09 が持ち、W-07 から辿れる形になって
 * いない（この画面から写真を並べると、清掃者ごとの作業内容を
 * 一覧する面ができる / §1.3）。**証跡の連鎖と写真のハッシュ照合は
 * ここで完結する**ので、§16.2 の受け入れ条件は満たしている。
 * 画面としての未達は docs/PROGRESS.md に残してある。
 *
 * ── 整合性の確認は押したときだけ ────────────────────────
 * 写真の実体照合（§6.3）は R2 から数 MB を読む。**loader では走らせない。**
 * `action`（POST）で実行する（`lib/evidence/photoIntegrity.ts` 冒頭）。
 *
 * ── ZIP は Queue 経由 ───────────────────────────────────
 * 「証跡を ZIP 出力」は要求を積むだけで、その場では出来ない（§6.5 /
 * `consumers/evidenceExport.ts`）。出来上がったら同じ画面に
 * ダウンロードのリンクが出る。**画面を自動で更新しない**
 * （管理画面は現場画面と違い、勝手に動くと操作を見失う）。
 */

import { findTaskById, listInspectionsByTask, NotFoundError } from "@pk/db";
import type { TimelineEntry } from "@pk/engine";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { assertPermission, can, propertyTarget } from "../../lib/auth/permission.js";
import {
  evidenceBundleKey,
  type EvidenceExportMessage,
} from "../../consumers/evidenceExport.js";
import { loadEvidenceDetail, type EvidenceDetail } from "../../lib/evidence/detail.js";
import { verifyTaskPhotos, type PhotoIntegrityReport } from "../../lib/evidence/photoIntegrity.js";
import { verifyTaskEvidence } from "../../lib/evidence/verify.js";
import { t, type MessageKey } from "../../lib/i18n.js";
import { switchProperty } from "../../lib/property/selection.js";
import { signObjectUrl } from "../../lib/storage/signedUrl.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

interface EvidenceDetailData {
  detail: EvidenceDetail;
  /** ZIP を出せるロールか。**非表示は権限制御ではない**（security.md §1）。 */
  canExport: boolean;
  /** 出来上がっている書庫の署名付き URL。無ければ `null`。 */
  bundleUrl: string | null;
}

export async function loader({
  request,
  params,
  context,
}: LoaderFunctionArgs): Promise<EvidenceDetailData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, cookieValue } = await requireAppContext(env, request, now);

  const propertyId = params["propertyId"];
  const taskId = params["taskId"];
  if (propertyId === undefined || taskId === undefined) throw new NotFoundError();

  await switchProperty(env, tenant, cookieValue, propertyId, now, session.membershipId);

  const task = await findTaskById(env, tenant, taskId);
  if (task === undefined) throw new NotFoundError();
  // **施設は資源から解決した値**を使う（INV-32）。パス変数を渡さない。
  assertPermission(tenant, "task.read", propertyTarget([task.propertyId]));

  const canExport = can(tenant, "evidence.export", propertyTarget([task.propertyId]));
  const bundle = canExport
    ? await env.EVIDENCE.head(evidenceBundleKey(tenant.organizationId, task.id))
    : null;

  return {
    detail: await loadEvidenceDetail(env, tenant, task),
    canExport,
    bundleUrl:
      bundle === null
        ? null
        : await signObjectUrl(env.SESSION_SECRET, bundle.key, now),
  };
}

/** action の結果。**文言を持たない。** 画面が i18n キーへ写す。 */
interface EvidenceDetailActionResult {
  /** 連鎖の検証。`ok` が偽なら、どこから崩れたかを持つ。 */
  chain?: { ok: boolean; firstBrokenSnapshotId: string | null };
  /** 写真の実体照合（§6.3）。 */
  photos?: PhotoIntegrityReport;
  queued?: boolean;
  invalid?: boolean;
}

export async function action({
  request,
  params,
  context,
}: ActionFunctionArgs): Promise<EvidenceDetailActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const taskId = params["taskId"];
  if (taskId === undefined) throw new NotFoundError();

  const task = await findTaskById(env, tenant, taskId);
  if (task === undefined) throw new NotFoundError();

  const intent = (await request.formData()).get("intent");

  if (intent === "verify") {
    assertPermission(tenant, "task.read", propertyTarget([task.propertyId]));
    const inspections = await listInspectionsByTask(env, tenant, task.id);
    const [chain, photos] = await Promise.all([
      verifyTaskEvidence(env, tenant, task.id),
      verifyTaskPhotos(
        env,
        tenant,
        { taskId: task.id, propertyId: task.propertyId },
        inspections.map((inspection) => inspection.id),
        session.membershipId,
      ),
    ]);
    return {
      chain: { ok: chain.ok, firstBrokenSnapshotId: chain.firstBrokenSnapshotId },
      photos,
    };
  }

  if (intent === "export") {
    assertPermission(tenant, "evidence.export", propertyTarget([task.propertyId]));
    const message: EvidenceExportMessage = {
      kind: "EVIDENCE_ZIP",
      organizationId: tenant.organizationId,
      orgShortId: tenant.orgShortId,
      taskId: task.id,
      requestedById: session.membershipId,
      requestedAtMs: now.getTime(),
    };
    await env.QUEUE_EVIDENCE_EXPORT.send(message);
    return { queued: true };
  }

  return { invalid: true };
}

/** タイムラインの 1 行を文言へ。**種別ごとに 1 キー。** */
function timelineLabel(entry: TimelineEntry): string {
  return t(`evidence.timeline.${entry.kind}` as MessageKey);
}

/** 時刻の表示。**業務の記録なので分まで。** 秒は出さない（急かさない / §1.3）。 */
function formatTime(atMs: number): string {
  const at = new Date(atMs);
  return `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
}

export default function EvidenceDetailScreen(): React.ReactElement {
  const data = useLoaderData<EvidenceDetailData>();
  const result = useActionData<EvidenceDetailActionResult>();
  const detail = data.detail;

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("evidence.detail.title")}</h1>
        <p className="pk-muted">{`${detail.businessDate} · ${detail.taskType} · ${detail.status}`}</p>
      </div>

      <p className="pk-notice">{t("evidence.disclaimer")}</p>

      {/* ② タイムライン（§12.3）。 */}
      <h2>{t("evidence.detail.timeline")}</h2>
      {detail.timeline.length === 0 ? (
        <p className="pk-muted">{t("evidence.detail.timelineEmpty")}</p>
      ) : (
        <ol className="pk-timeline">
          {detail.timeline.map((entry, index) => (
            <li key={`${String(entry.atMs)}-${entry.kind}-${String(index)}`}>
              <span className="pk-mono">{formatTime(entry.atMs)}</span>
              <span>{timelineLabel(entry)}</span>
              {entry.round === null ? null : (
                <span className="pk-muted">{`#${String(entry.round)}`}</span>
              )}
              {entry.reasonCode === null ? null : (
                <span className="pk-muted">{entry.reasonCode}</span>
              )}
            </li>
          ))}
        </ol>
      )}

      {/* ③ 検査 / ④ 差戻し。 */}
      <h2>{t("evidence.detail.inspections")}</h2>
      {detail.inspections.length === 0 ? (
        <p className="pk-muted">{t("evidence.none")}</p>
      ) : (
        <ul>
          {detail.inspections.map((inspection) => (
            <li key={inspection.inspectionId}>
              {`#${String(inspection.round)} ${inspection.result ?? t("evidence.detail.inProgress")}`}
              {inspection.selfApproved ? ` · ${t("evidence.detail.selfApproved")}` : ""}
            </li>
          ))}
        </ul>
      )}

      <h2>{t("evidence.detail.reworks")}</h2>
      {detail.reworkCycles.length === 0 ? (
        <p className="pk-muted">{t("evidence.none")}</p>
      ) : (
        <ul>
          {detail.reworkCycles.map((rework) => (
            <li key={rework.reworkCycleId}>
              {`#${String(rework.round)} ${rework.status} · ${rework.reasonSummary}`}
              {rework.waivedReason === null ? "" : ` · ${rework.waivedReason}`}
            </li>
          ))}
        </ul>
      )}

      {/* ⑤ 証跡ハッシュと「整合性を確認」。 */}
      <h2>{t("evidence.detail.snapshots")}</h2>
      <table className="pk-table">
        <thead>
          <tr>
            <th scope="col">{t("evidence.detail.type")}</th>
            <th scope="col">{t("evidence.detail.payloadSha256")}</th>
            <th scope="col">{t("evidence.detail.chainHash")}</th>
          </tr>
        </thead>
        <tbody>
          {detail.snapshots.map((snapshot) => (
            <tr key={snapshot.snapshotId}>
              <td>{t(`evidence.type.${snapshot.evidenceType}` as MessageKey)}</td>
              <td className="pk-mono">{snapshot.payloadSha256.slice(0, 12)}</td>
              <td className="pk-mono">{snapshot.chainHash.slice(0, 12)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <Form method="post">
        <input type="hidden" name="intent" value="verify" />
        <button className="pk-button" type="submit">
          {t("evidence.detail.verify")}
        </button>
      </Form>

      {result?.chain === undefined ? null : (
        <p className={result.chain.ok ? "pk-notice" : "pk-notice pk-notice--warn"}>
          {result.chain.ok ? t("evidence.verify.ok") : t("evidence.verify.changed")}
        </p>
      )}
      {result?.photos === undefined ? null : (
        <p className={result.photos.ok ? "pk-notice" : "pk-notice pk-notice--warn"}>
          {result.photos.ok ? t("evidence.verify.photoOk") : t("evidence.verify.photoChanged")}
        </p>
      )}

      {/* ⑥ 「証跡を ZIP 出力」。 */}
      {data.canExport ? (
        <>
          <h2>{t("evidence.detail.export")}</h2>
          <Form method="post">
            <input type="hidden" name="intent" value="export" />
            <button className="pk-button" type="submit">
              {t("evidence.detail.exportSubmit")}
            </button>
          </Form>
          {result?.queued === true ? <p className="pk-notice">{t("evidence.export.queued")}</p> : null}
          {data.bundleUrl === null ? null : (
            <p>
              <a href={data.bundleUrl}>{t("evidence.export.download")}</a>
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
