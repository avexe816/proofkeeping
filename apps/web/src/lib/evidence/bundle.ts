/**
 * 証跡バンドルの組み立て（PK-SPEC-P2 §6.5）。**純粋な組み立てだけ。**
 *
 * task:  docs/tasks/P2-10.md
 * ルール: .claude/rules/architecture.md §5
 *
 * ── I/O を持たない ──────────────────────────────────────
 * R2 からの読み取りと書き込みはコンシューマ（`consumers/evidenceExport.ts`）。
 * ここは**渡された行とバイト列から ZIP の中身を決める**だけ。分けてあるのは、
 * §6.5 の構成（ファイル名・`verify.txt` の形式）をテストで直接押さえるため。
 *
 * ── payload をそのまま入れる ────────────────────────────
 * 各 `*.json` の中身は `evidenceSnapshot.payload` の**文字列そのまま。**
 * `JSON.parse` → `JSON.stringify` を通すと鍵の並びが変わり、
 * 書庫を受け取った相手が `payloadSha256` を再現できなくなる
 * （`repositories/evidence.ts` 冒頭の注記と同じ理由）。
 * **整形（pretty print）もしない。**
 *
 * ── `verify.txt` は sha256sum の形式 ────────────────────
 * `{64 桁の 16 進}  {パス}` を 1 行。区切りは**空白 2 つ**（GNU coreutils の
 * バイナリでない形式）。この形にしてあるので、受け取った側は
 * `sha256sum -c verify.txt` でそのまま検証できる。**独自の形式にしない。**
 */

import type { ZipEntry } from "../zip/store.js";

import { sha256Hex } from "./hash.js";

/** 書庫に入れる証跡 1 件。 */
export interface BundleSnapshotInput {
  snapshotId: string;
  evidenceType: string;
  /** 正規化済み JSON の**文字列**。加工しない。 */
  payload: string;
  payloadSha256: string;
  previousHash: string | null;
  chainHash: string;
  correctsSnapshotId: string | null;
  createdAtMs: number;
}

/** 書庫に入れる写真 1 枚。 */
export interface BundlePhotoInput {
  photoId: string;
  source: "CLEANING" | "INSPECTION";
  /** R2 から読んだ実体。**無い写真はそもそも渡さない。** */
  bytes: Uint8Array;
  /** DB に記録された SHA-256。無い写真（P2-08 より前）は `null`。 */
  sha256: string | null;
}

/** 書庫の素性。**宿泊者に関する値を 1 つも持たない**（security.md §3）。 */
export interface BundleContextInput {
  taskId: string;
  propertyCode: string;
  roomNumber: string;
  businessDate: string;
  taskType: string;
  /** 書き出した時刻。**呼び出し側が渡す**（この層は時計を持たない）。 */
  generatedAt: Date;
  /** 書き出しを要求した `membership.id`。 */
  requestedById: string;
  /** 連鎖の検証結果（`verifyTaskEvidence()` の `ok`）。 */
  chainOk: boolean;
}

/** 組み立ての結果。 */
export interface EvidenceBundle {
  /** `PK-20260910-HTLA-302.zip`（§6.5）。 */
  fileName: string;
  entries: readonly ZipEntry[];
}

/**
 * 書庫のファイル名（§6.5）。
 *
 * `PK-{業務日から区切りを除いたもの}-{施設コード}-{部屋番号}.zip`
 *
 * 施設コードと部屋番号は**そのまま使えるとは限らない**（`101-A` や全角）。
 * ファイル名に使えない文字を `_` へ落とす。**空になったら `X` を置く**
 * （`PK-20260910--302.zip` のような形を作らない）。
 */
export function bundleFileName(
  businessDate: string,
  propertyCode: string,
  roomNumber: string,
): string {
  const date = businessDate.replaceAll("-", "");
  return `PK-${date}-${safeSegment(propertyCode)}-${safeSegment(roomNumber)}.zip`;
}

/** ファイル名に入れてよい形へ落とす。 */
function safeSegment(value: string): string {
  const cleaned = value.replaceAll(/[^0-9A-Za-z_-]/g, "_").replace(/^_+|_+$/g, "");
  return cleaned === "" ? "X" : cleaned;
}

/**
 * 証跡 1 件のファイル名（§6.5 の構成）。
 *
 * `ordinal` は**同じ種別の中での通し番号**（1 始まり）。
 * `evidenceSnapshot` はラウンドの列を持たない（§3.7）ので、
 * **連鎖の順序から数える。** 訂正（§6.4）で同じ種別が増えると
 * 番号が伸びるが、`manifest.json` が `snapshotId` と対応を持つので
 * どれがどれかは辿れる。
 */
export function snapshotFileName(evidenceType: string, ordinal: number): string {
  switch (evidenceType) {
    case "CLEANING_COMPLETION":
      return ordinal === 1 ? "cleaning-completion.json" : `cleaning-completion-${String(ordinal)}.json`;
    case "INSPECTION_PASS":
    case "INSPECTION_FAIL":
      return `inspection-round-${String(ordinal)}.json`;
    case "REWORK_COMPLETION":
      return `rework-round-${String(ordinal)}.json`;
    case "DAILY_REPORT":
      return `daily-report-${String(ordinal)}.json`;
    default:
      // 種別が増えたときに**書庫が黙って壊れない**ようにする。
      return `evidence-${evidenceType.toLowerCase().replaceAll("_", "-")}-${String(ordinal)}.json`;
  }
}

/**
 * 検査の通し番号は `INSPECTION_PASS` と `INSPECTION_FAIL` で共有する。
 *
 * §6.5 の例で `inspection-round-1.json`（不合格）と
 * `inspection-round-2.json`（合格）が並ぶのは、**判定に関わらず
 * ラウンドが 1 本の列**だから。種別ごとに数えると両方が `round-1` になる。
 */
function counterKeyOf(evidenceType: string): string {
  return evidenceType === "INSPECTION_FAIL" ? "INSPECTION_PASS" : evidenceType;
}

/** 写真のファイル名（`photos/cleaning-001.jpg`）。 */
export function photoFileName(source: BundlePhotoInput["source"], ordinal: number): string {
  const prefix = source === "CLEANING" ? "cleaning" : "inspection";
  return `photos/${prefix}-${String(ordinal).padStart(3, "0")}.jpg`;
}

/** `verify.txt` の 1 行。**区切りは空白 2 つ**（sha256sum の形式）。 */
export function verifyLine(sha256: string, path: string): string {
  return `${sha256}  ${path}`;
}

/**
 * 書庫の中身を組み立てる（§6.5）。
 *
 * 並びは manifest → 証跡（連鎖の順）→ 写真 → `verify.txt`。
 * **`verify.txt` は自分自身を載せない**（自己参照になる）。
 *
 * @param snapshots 連鎖の順（`listEvidenceSnapshotsByTask()` の並び）。
 */
export async function buildEvidenceBundle(
  context: BundleContextInput,
  snapshots: readonly BundleSnapshotInput[],
  photos: readonly BundlePhotoInput[],
): Promise<EvidenceBundle> {
  const encoder = new TextEncoder();
  const at = context.generatedAt;

  const counters = new Map<string, number>();
  const snapshotFiles = snapshots.map((snapshot) => {
    const key = counterKeyOf(snapshot.evidenceType);
    const ordinal = (counters.get(key) ?? 0) + 1;
    counters.set(key, ordinal);
    return { snapshot, path: snapshotFileName(snapshot.evidenceType, ordinal) };
  });

  const photoCounters = new Map<string, number>();
  const photoFiles = photos.map((photo) => {
    const ordinal = (photoCounters.get(photo.source) ?? 0) + 1;
    photoCounters.set(photo.source, ordinal);
    return { photo, path: photoFileName(photo.source, ordinal) };
  });

  const manifest = {
    // **鍵の並びを固定するため素直なオブジェクトリテラルで書く。**
    // ここは `canonicalJson()` を通さない（manifest は証跡ではなく目次で、
    // ハッシュ連鎖の対象ではない）。人が読むので整形する。
    bundleVersion: "1",
    generatedAt: at.toISOString(),
    requestedById: context.requestedById,
    task: {
      taskId: context.taskId,
      taskType: context.taskType,
      businessDate: context.businessDate,
      propertyCode: context.propertyCode,
      roomNumber: context.roomNumber,
    },
    // **「保存後に書き換えられていないこと」しか言わない**（§6.1）。
    // 外部の時刻認証は P2 では導入していない。manifest にもそう書く。
    chain: {
      verifiedAtExport: context.chainOk,
      note: "外部の時刻認証は含みません。保存後に書き換えられていないことのみを示します。",
    },
    snapshots: snapshotFiles.map(({ snapshot, path }) => ({
      file: path,
      snapshotId: snapshot.snapshotId,
      evidenceType: snapshot.evidenceType,
      payloadSha256: snapshot.payloadSha256,
      previousHash: snapshot.previousHash,
      chainHash: snapshot.chainHash,
      correctsSnapshotId: snapshot.correctsSnapshotId,
      createdAt: new Date(snapshot.createdAtMs).toISOString(),
    })),
    photos: photoFiles.map(({ photo, path }) => ({
      file: path,
      photoId: photo.photoId,
      source: photo.source,
      recordedSha256: photo.sha256,
    })),
  };

  const entries: ZipEntry[] = [
    { path: "manifest.json", bytes: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`), at },
    ...snapshotFiles.map(({ snapshot, path }) => ({
      path,
      bytes: encoder.encode(snapshot.payload),
      at,
    })),
    ...photoFiles.map(({ photo, path }) => ({ path, bytes: photo.bytes, at })),
  ];

  // **書庫へ入れる実体からハッシュを取る。** DB の `sha256` を写すと、
  // 実体が差し替えられていた場合に `verify.txt` が「正しい」と言ってしまう。
  // DB の値は manifest の `recordedSha256` に別途載っているので、
  // 受け取った側は 2 つを突き合わせられる。
  const lines = await Promise.all(
    entries.map(async (entry) => verifyLine(await sha256Hex(entry.bytes), entry.path)),
  );

  entries.push({
    path: "verify.txt",
    bytes: encoder.encode(`${lines.join("\n")}\n`),
    at,
  });

  return {
    fileName: bundleFileName(context.businessDate, context.propertyCode, context.roomNumber),
    entries,
  };
}
