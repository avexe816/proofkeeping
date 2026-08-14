import {
  NotFoundError,
  deactivateExternalMapping,
  findIntegrationById,
  listExternalMappings,
  listRooms,
  listSyncLogs,
  recordAudit,
  upsertExternalMappings,
} from "@pk/db";
import { autoMapRooms, type AutoMapCandidate } from "@pk/integrations";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { assertPermission, can, propertyTarget } from "../../lib/auth/permission.js";
import { t } from "../../lib/i18n.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/**
 * W-23 マッピング設定（PK-SPEC-P6 §2.3 / §7.2）。
 *
 *   /app/settings/integrations/:integrationId/mappings
 *
 * task: docs/tasks/P6-05.md
 *
 * ── 何を見せる画面か ────────────────────────────────────
 * §7.2 の表をそのまま作る。ProofKeeping の客室と外部システムの ID を
 * 左右に並べ、**結べていないものを両側とも `✕ 未マッピング` として出す。**
 *
 * ```
 * ProofKeeping        外部システム         状態
 * 302  ツイン    ←→  302                  ○
 * 305  ダブル    ←→  0305                 ○（手動設定）
 * —                  9001                 ✕ 未マッピング
 * 601  ツイン    ←→  —                    ✕ 未マッピング
 * ```
 *
 * ── 外部システム側の一覧をどこから取るか ────────────────
 * §7.2 の `— ←→ 9001`（対応の無い外部 ID）は、本来アダプタの
 * `listRooms()` / `listDevices()` から来る。**実接続する PMS は未確定で、
 * 登録済みのアダプタが 1 つも無い**（P6-06 は人間待ち / §11 の未決事項 1）。
 *
 * そこでこの画面は、外部システム側の一覧を**利用者が貼り付ける**形にした
 * （1 行 1 件、`外部ID` または `外部ID,表示名`）。貼り付けた一覧に対して
 * §7.2 の「自動マッピング」が走る。アダプタが入れば、同じ
 * `autoMapRooms()` へ `listRooms()` の結果を渡すだけで置き換わる
 * （docs/DECISIONS.md #144 / docs/OPEN_QUESTIONS.md #087）。
 *
 * **受信中に落ちた外部 ID をここへ出せない。** 未マッピングの機器 ID は
 * `sync_log.recordsSkipped` に件数としてしか残っておらず、どの ID が
 * 落ちたかを保つ列が仕様に無い（§2.2）。件数は下の「取込の状況」に出す。
 *
 * ── リポジトリを直接呼ぶ ────────────────────────────────
 * PC 管理画面の方針（docs/DECISIONS.md #049）。**そのため
 * `assertPermission()` を loader と action の両方で呼ぶ。**
 *
 * ── W-13 からの導線がまだ無い ───────────────────────────
 * 連携設定（W-13 / §7.1）は P6-14。それまでこの画面へは URL で入る。
 */

/** 表の 1 行。**左右のどちらかが欠けている行が「未マッピング」。** */
interface MappingRow {
  /** 対応そのものの ID。未マッピングの行では `null`。 */
  mappingId: string | null;
  /** ProofKeeping 側。無ければ `null`（`— ←→ 9001`）。 */
  internal: { roomId: string; roomNumber: string } | null;
  /** 外部システム側。無ければ `null`（`601 ←→ —`）。 */
  external: { externalId: string; externalLabel: string | null } | null;
}

/** 取込の状況（§7.1 の「未マッピング客室 N 件」に対応する数字）。 */
interface IngestStatus {
  /** 直近の同期で「対応が無くて落ちた」件数の合計。 */
  recentSkipped: number;
  /** 数えた同期ログの件数。 */
  recentRuns: number;
}

interface MappingsData {
  integrationId: string;
  displayName: string;
  status: string;
  rows: MappingRow[];
  /** 対応の付いていない客室の数（W-13 の「未マッピング客室 N 件」）。 */
  unmappedRoomCount: number;
  ingest: IngestStatus;
  canWrite: boolean;
}

/** 直近いくつの同期ログからスキップ件数を数えるか。 */
const RECENT_SYNC_LOGS = 20;

export async function loader({
  request,
  params,
  context,
}: LoaderFunctionArgs): Promise<MappingsData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);

  // **施設を渡さない。** 連携は組織の設定で、`integration.read` は
  // `OWNER` / `ORG_ADMIN` / `AUDITOR` だけの組織スコープ操作。
  assertPermission(tenant, "integration.read", propertyTarget([]));

  const integrationId = params["integrationId"];
  if (integrationId === undefined) throw new NotFoundError();

  // **越境 ID はここで `NotFoundError`**（第 2 層 / 403 を返さない）。
  const integration = await findIntegrationById(env, tenant, integrationId);
  if (integration === undefined) throw new NotFoundError();

  const [mappings, rooms, syncLogs] = await Promise.all([
    listExternalMappings(env, tenant, { integrationId, entityType: "ROOM" }),
    listRooms(
      env,
      tenant,
      integration.propertyId === null ? {} : { propertyId: integration.propertyId },
    ),
    listSyncLogs(env, tenant, { integrationId, limit: RECENT_SYNC_LOGS }),
  ]);

  const roomById = new Map(rooms.map((row) => [row.id, row]));
  const mappedRoomIds = new Set(mappings.map((row) => row.internalId));

  const rows: MappingRow[] = [];
  // ① 対応の付いている行。
  for (const mapping of mappings) {
    const room = roomById.get(mapping.internalId);
    rows.push({
      mappingId: mapping.id,
      // **客室が無効化されていても対応は残る。** 行を消すと、過去の
      // 取込がどこへ入ったかを画面から辿れなくなる。
      internal:
        room === undefined
          ? null
          : { roomId: room.id, roomNumber: room.roomNumber },
      external: { externalId: mapping.externalId, externalLabel: mapping.externalLabel },
    });
  }
  // ② 対応の無い客室（§7.2 の `601 ツイン ←→ —`）。
  for (const room of rooms) {
    if (mappedRoomIds.has(room.id)) continue;
    rows.push({
      mappingId: null,
      internal: { roomId: room.id, roomNumber: room.roomNumber },
      external: null,
    });
  }

  return {
    integrationId,
    displayName: integration.displayName,
    status: integration.status,
    rows,
    unmappedRoomCount: rows.filter((row) => row.external === null).length,
    ingest: {
      recentSkipped: syncLogs.reduce((sum, log) => sum + log.recordsSkipped, 0),
      recentRuns: syncLogs.length,
    },
    canWrite: can(tenant, "integration.write", propertyTarget([])),
  };
}

/** action の結果。**件数だけを返す**（画面が i18n キーへ写す）。 */
interface MappingsResult {
  intent?: "auto" | "add" | "remove";
  inserted?: number;
  unchanged?: number;
  /** 番号が重なっていて結べなかった部屋番号（`autoMapRooms()` の `ambiguous`）。 */
  ambiguous?: string[];
  rejected?: boolean;
}

/**
 * 貼り付けられた外部システムの一覧を読む。
 *
 * 1 行 1 件。`外部ID` または `外部ID,表示名`。**空行と重複は落とす。**
 * CSV として厳密に解釈しない（引用符・改行入りの値を受け取らない）。
 * ここに来るのは PMS の管理画面からコピーした部屋番号の並びで、
 * 込み入った値が入るなら手動で 1 件ずつ足す方が確実。
 */
export function parseExternalRoomList(text: string): AutoMapCandidate[] {
  const seen = new Set<string>();
  const rows: AutoMapCandidate[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [rawId, ...rest] = line.split(",");
    const externalId = (rawId ?? "").trim();
    if (externalId === "") continue;
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    const label = rest.join(",").trim();
    rows.push({
      id: externalId,
      number: externalId,
      ...(label === "" ? {} : { label }),
    });
  }
  return rows;
}

export async function action({
  request,
  params,
  context,
}: ActionFunctionArgs): Promise<MappingsResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  assertPermission(tenant, "integration.write", propertyTarget([]));

  const integrationId = params["integrationId"];
  if (integrationId === undefined) throw new NotFoundError();
  const integration = await findIntegrationById(env, tenant, integrationId);
  if (integration === undefined) throw new NotFoundError();

  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "remove") {
    const mappingId = form.get("mappingId");
    if (typeof mappingId !== "string") return { rejected: true };
    // **行は消さない。** 無効化だけ（`deactivateExternalMapping()` の注記）。
    await deactivateExternalMapping(env, tenant, mappingId);
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "integrationMapping.updated",
      targetType: "externalMapping",
      targetId: mappingId,
      before: { isActive: true },
      after: { isActive: false },
    });
    return { intent: "remove" };
  }

  if (intent === "add") {
    const roomId = form.get("roomId");
    const externalId = form.get("externalId");
    if (typeof roomId !== "string" || typeof externalId !== "string") return { rejected: true };
    const trimmed = externalId.trim();
    if (roomId === "" || trimmed === "") return { rejected: true };

    // **越境 ID は `upsertExternalMappings()` が落とす**（`internalId` を
    // `assertIdBelongsToTenant()` に掛けている）。
    const result = await upsertExternalMappings(env, tenant, integrationId, [
      { entityType: "ROOM", internalId: roomId, externalId: trimmed },
    ]);
    if (result.inserted > 0) {
      await recordAudit(env, tenant, {
        actorId: session.membershipId,
        action: "integrationMapping.updated",
        targetType: "externalMapping",
        targetId: integrationId,
        after: { entityType: "ROOM", internalId: roomId, externalId: trimmed, source: "MANUAL" },
      });
    }
    return { intent: "add", inserted: result.inserted, unchanged: result.unchanged };
  }

  if (intent !== "auto") return { rejected: true };

  const externalList = form.get("externalList");
  if (typeof externalList !== "string") return { rejected: true };

  const [mappings, rooms] = await Promise.all([
    listExternalMappings(env, tenant, { integrationId, entityType: "ROOM" }),
    listRooms(
      env,
      tenant,
      integration.propertyId === null ? {} : { propertyId: integration.propertyId },
    ),
  ]);

  // **既にある対応を候補から外す**（手で直した `305 ←→ 0305` を守る）。
  const result = autoMapRooms({
    internal: rooms.map((row) => ({ id: row.id, number: row.roomNumber })),
    external: parseExternalRoomList(externalList),
    alreadyMappedInternalIds: new Set(mappings.map((row) => row.internalId)),
    alreadyMappedExternalIds: new Set(mappings.map((row) => row.externalId)),
  });

  const upserted = await upsertExternalMappings(
    env,
    tenant,
    integrationId,
    result.pairs.map((pair) => ({
      entityType: "ROOM" as const,
      internalId: pair.internalId,
      externalId: pair.externalId,
      externalLabel: pair.externalLabel,
    })),
  );

  if (upserted.inserted > 0) {
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "integrationMapping.updated",
      targetType: "externalMapping",
      targetId: integrationId,
      after: { entityType: "ROOM", inserted: upserted.inserted, source: "AUTO" },
    });
  }

  return {
    intent: "auto",
    inserted: upserted.inserted,
    unchanged: upserted.unchanged,
    ambiguous: result.ambiguous,
  };
}

export default function IntegrationMappings() {
  const data = useLoaderData<MappingsData>();
  const result = useActionData<MappingsResult>();

  return (
    <div className="pk-page">
      <header className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("integrationMapping.title")}</h1>
        <p className="pk-muted">{`${data.displayName}（${data.status}）`}</p>
      </header>

      {/* §2.3 MUST: 未マッピングをエラーにせず、件数として提示する。 */}
      <section className="pk-meter">
        <h2 className="pk-meter__label">{t("integrationMapping.status")}</h2>
        <dl className="pk-items">
          <dt>{t("integrationMapping.unmappedRooms")}</dt>
          <dd>{String(data.unmappedRoomCount)}</dd>
          <dt>{t("integrationMapping.recentSkipped")}</dt>
          <dd>{`${String(data.ingest.recentSkipped)}（${String(data.ingest.recentRuns)}）`}</dd>
        </dl>
        <p className="pk-muted">{t("integrationMapping.skippedNote")}</p>
      </section>

      {result?.rejected === true ? (
        <p className="pk-notice">{t("integrationMapping.rejected")}</p>
      ) : null}
      {result?.intent === undefined || result.inserted === undefined ? null : (
        <p className="pk-notice">
          {`${t("integrationMapping.applied")}: ${String(result.inserted)} / ${String(
            result.unchanged ?? 0,
          )}`}
        </p>
      )}
      {result?.ambiguous !== undefined && result.ambiguous.length > 0 ? (
        <p className="pk-notice">
          {`${t("integrationMapping.ambiguous")}: ${result.ambiguous.join(", ")}`}
        </p>
      ) : null}

      {data.canWrite ? (
        <section className="pk-meter">
          <h2 className="pk-meter__label">{t("integrationMapping.auto")}</h2>
          <p className="pk-muted">{t("integrationMapping.autoNote")}</p>
          <Form method="post">
            <input type="hidden" name="intent" value="auto" />
            <textarea
              name="externalList"
              aria-label={t("integrationMapping.externalList")}
              rows={6}
              required
            />
            <button className="pk-button" type="submit">
              {t("integrationMapping.run")}
            </button>
          </Form>
        </section>
      ) : null}

      <table className="pk-table">
        <thead>
          <tr>
            <th scope="col">{t("integrationMapping.internal")}</th>
            <th scope="col">{t("integrationMapping.external")}</th>
            <th scope="col">{t("integrationMapping.state")}</th>
            <th scope="col">{t("integrationMapping.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.mappingId ?? `room:${row.internal?.roomId ?? ""}`}>
              <td>{row.internal === null ? "—" : row.internal.roomNumber}</td>
              <td>
                {row.external === null
                  ? "—"
                  : row.external.externalLabel === null
                    ? row.external.externalId
                    : `${row.external.externalId}（${row.external.externalLabel}）`}
              </td>
              <td>
                {row.external === null || row.internal === null
                  ? t("integrationMapping.unmapped")
                  : t("integrationMapping.mapped")}
              </td>
              <td>
                {!data.canWrite ? null : row.mappingId !== null ? (
                  <Form method="post" className="pk-inline">
                    <input type="hidden" name="intent" value="remove" />
                    <input type="hidden" name="mappingId" value={row.mappingId} />
                    <button className="pk-button" type="submit">
                      {t("integrationMapping.remove")}
                    </button>
                  </Form>
                ) : row.internal === null ? null : (
                  <Form method="post" className="pk-inline">
                    <input type="hidden" name="intent" value="add" />
                    <input type="hidden" name="roomId" value={row.internal.roomId} />
                    <input
                      name="externalId"
                      aria-label={t("integrationMapping.external")}
                      required
                    />
                    <button className="pk-button" type="submit">
                      {t("integrationMapping.add")}
                    </button>
                  </Form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
