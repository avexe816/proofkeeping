/**
 * 写真の実体照合（PK-SPEC-P2 §6.3）。
 *
 * task:  docs/tasks/P2-09.md
 * ルール: .claude/rules/security.md §4, §6
 *
 * ── `verifyTaskEvidence()` との違い ──────────────────────
 * `lib/evidence/verify.ts` が見るのは **DB の中だけ**（payload の文字列と
 * その SHA-256、連鎖）。写真は payload に `{ id, sha256 }` として載って
 * いるだけなので、**R2 の実体が差し替えられても連鎖は無傷のまま通る。**
 * §6.3 の「アップロード完了時にサーバー側でバイナリの SHA-256 を計算。
 * DB の sha256 と R2 object metadata の双方へ保存」は、この照合を
 * できるようにするために書かれている。ここがその照合を行う。
 *
 * ── 読み込むのは要求されたときだけ ──────────────────────
 * 写真 1 枚 500KB × 最大 20 枚を毎回読むと、画面の表示に数 MB の
 * R2 読み取りが乗る。**W-07 を開いただけでは走らせない。**
 * 「整合性を確認」を押したときだけ呼ぶ（`routes/app/evidenceDetail.tsx`）。
 *
 * ── 不一致は監査ログへ ──────────────────────────────────
 * §6.3 の MUST。`export.data` ではなく **`export.evidenceZip` でもない**
 * 新しい action を足していない理由は下の `recordPhotoMismatch()` の注記。
 */

import { listInspectionPhotos, listTaskPhotos, recordAudit, type Env, type TenantContext } from "@pk/db";

import { sha256Hex } from "./hash.js";

/** 1 枚の照合結果。 */
export interface PhotoIntegrityResult {
  photoId: string;
  /** `task_photo` か `inspection_photo` か。**画面が節を分けるため。** */
  source: "CLEANING" | "INSPECTION";
  /**
   * 判定。
   *
   * | 値 | 意味 |
   * |---|---|
   * | `MATCH` | R2 の実体の SHA-256 が DB と一致した |
   * | `MISMATCH` | 一致しない。**実体が差し替えられている** |
   * | `MISSING` | R2 に実体が無い（保持期間切れ・削除） |
   * | `NOT_RECORDED` | DB に `sha256` が無い（P2-08 より前の写真） |
   */
  verdict: "MATCH" | "MISMATCH" | "MISSING" | "NOT_RECORDED";
}

/** タスク 1 件の写真照合の結果。 */
export interface PhotoIntegrityReport {
  taskId: string;
  /** **`MISMATCH` が 1 枚も無いこと。** `MISSING` / `NOT_RECORDED` は含めない。 */
  ok: boolean;
  photos: readonly PhotoIntegrityResult[];
}

/** 照合する 1 枚の素性。 */
interface PhotoRow {
  id: string;
  storageKey: string;
  sha256: string | null;
  source: PhotoIntegrityResult["source"];
}

/**
 * R2 の実体を読んでハッシュを取り直す。
 *
 * **`customMetadata` の値を信用しない。** §6.3 は R2 の metadata にも
 * 同じ値を保存すると定めるが、実体を差し替える相手は metadata も
 * 一緒に書き換えられる。**バイト列そのものから取り直す**のでなければ
 * 照合にならない。
 */
async function verifyOne(env: Env, row: PhotoRow): Promise<PhotoIntegrityResult> {
  if (row.sha256 === null || row.sha256 === "") {
    return { photoId: row.id, source: row.source, verdict: "NOT_RECORDED" };
  }
  const object = await env.PHOTOS.get(row.storageKey);
  if (object === null) {
    return { photoId: row.id, source: row.source, verdict: "MISSING" };
  }
  const actual = await sha256Hex(new Uint8Array(await object.arrayBuffer()));
  return {
    photoId: row.id,
    source: row.source,
    verdict: actual === row.sha256 ? "MATCH" : "MISMATCH",
  };
}

/**
 * タスク 1 件の写真を R2 と突き合わせる（§6.3）。
 *
 * **直列ではなく並行に読む。** 20 枚を順に読むと R2 の往復が積み上がる。
 * それでも 1 回の操作で数 MB を読むので、**リクエストハンドラから
 * 呼ぶ前に「押されたときだけ」であることを確かめること**（冒頭の注記）。
 */
export async function verifyTaskPhotos(
  env: Env,
  ctx: TenantContext,
  task: { taskId: string; propertyId: string },
  inspectionIds: readonly string[],
  actorId: string,
): Promise<PhotoIntegrityReport> {
  const [cleaningPhotos, inspectionPhotoLists] = await Promise.all([
    listTaskPhotos(env, ctx, task.taskId),
    Promise.all(inspectionIds.map((id) => listInspectionPhotos(env, ctx, id))),
  ]);

  const rows: PhotoRow[] = [
    ...cleaningPhotos.map((row) => ({
      id: row.id,
      storageKey: row.storageKey,
      sha256: row.sha256,
      source: "CLEANING" as const,
    })),
    ...inspectionPhotoLists.flat().map((row) => ({
      id: row.id,
      storageKey: row.storageKey,
      sha256: row.sha256,
      source: "INSPECTION" as const,
    })),
  ];

  const photos = await Promise.all(rows.map((row) => verifyOne(env, row)));
  const mismatched = photos.filter((photo) => photo.verdict === "MISMATCH");

  if (mismatched.length > 0) {
    await recordPhotoMismatch(env, ctx, task, actorId, mismatched);
  }

  return { taskId: task.taskId, ok: mismatched.length === 0, photos };
}

/**
 * 不一致を残す（§6.3「不一致時は Sentry と監査ログへ記録する」）。
 *
 * ── 監査の action を増やしていない ──────────────────────
 * `AUDIT_ACTIONS` は security.md §6 の列挙をそのまま写した閉じた表で、
 * 「照合して不一致だった」はそこに無い。**新しい action を足すと、
 * 監査ログが業務操作の記録から「システムの検査結果」の置き場へ広がる。**
 * ここは `export.data`（データの持ち出し・確認の記録）として残す。
 * `after` に写真 ID と件数だけを入れ、**ハッシュの値そのものは入れない**
 * （不一致の実体は R2 と DB にあり、監査ログはその写しを持つ場所ではない）。
 *
 * ── Sentry ─────────────────────────────────────────────
 * SDK をまだ入れていない（`SENTRY_DSN` は wrangler.spec.ts が
 * secret として名前だけ知っている状態）。**`console.error` で残す。**
 * Workers のログは Sentry の取り込み先になるので、SDK を入れる task が
 * ここを差し替えればよい。**写真 ID 以上のものを出さない。**
 */
async function recordPhotoMismatch(
  env: Env,
  ctx: TenantContext,
  task: { taskId: string; propertyId: string },
  actorId: string,
  mismatched: readonly PhotoIntegrityResult[],
): Promise<void> {
  console.error(
    `evidence-photo-mismatch task=${task.taskId} count=${String(mismatched.length)} ` +
      `photos=${mismatched.map((photo) => photo.photoId).join(",")}`,
  );
  await recordAudit(env, ctx, {
    actorId,
    action: "export.data",
    targetType: "task",
    targetId: task.taskId,
    propertyId: task.propertyId,
    after: {
      check: "photoIntegrity",
      mismatchCount: mismatched.length,
      photoIds: mismatched.map((photo) => photo.photoId),
    },
  });
}
