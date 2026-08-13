/**
 * 証跡の正規化 JSON とハッシュ連鎖の**入力**（PK-SPEC-P2 §6.2）。**純粋関数。**
 *
 * task: docs/tasks/P2-08.md
 *
 * ── ハッシュそのものはここに無い ────────────────────────
 * SHA-256 の計算は WebCrypto（`crypto.subtle.digest`）で、`Promise` を返す。
 * このモジュールは**同期の純粋関数だけ**を持ち、ハッシュを取る側
 * （`apps/web/src/lib/evidence/hash.ts`）へ「何を文字列にするか」を渡す。
 * 分けてあるのは、正規化の規則をテストで直接押さえられるようにするため。
 * 期待値が 64 桁の 16 進だと、**並びの誤りとハッシュの誤りを区別できない。**
 *
 * ── 決定的であることが唯一の要件 ────────────────────────
 * 同じ入力から必ず同じ文字列が出ること。ここが揺れると、後から
 * `payloadSha256` を再計算しても一致せず、「改ざんされた」と
 * 区別が付かなくなる。そのため以下を固定する。
 *   - オブジェクトのキーは**コードユニット順**（`Array#sort` の既定）。
 *   - 配列の順序は入れ替えない。**順序そのものが記録**（時間ログの並び）。
 *   - `undefined` のキーは落とす。`null` は残す（「無い」と「空」を区別する）。
 *   - 数値は**整数のみ**。小数・`NaN`・`Infinity` は例外にする（§6.2
 *     「数値を整数へ統一した JSON」）。金額と枚数に小数は現れない。
 *   - 日時は `isoUtc()` で ISO 8601 UTC の文字列にしてから入れる。
 *     `Date` を直接渡せない形にしてあるのは、`toJSON()` の暗黙の変換に
 *     頼らないため（`JSON.stringify` の挙動に依存させない）。
 *
 * **`JSON.stringify` の第 2 引数（replacer）で済ませていない。** replacer は
 * キーの順序を制御できず、V8 の挿入順に従う。挿入順は payload を組む
 * コードの行順で決まるので、リファクタで並びが変わるとハッシュが変わる。
 */

/** 連鎖の先頭に使う定数（§6.2 の `previousHash ?? "GENESIS"`）。 */
export const GENESIS_HASH = "GENESIS";

/** 正規化できる値。**`Date` と `undefined` を含まない**（冒頭の注記）。 */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

/** 正規化できない値を渡したときの例外。**黙って落とさない。** */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

/**
 * 正規化 JSON（§6.2）。**キーを辞書順に並べ、空白を入れない。**
 *
 * @throws {CanonicalJsonError} 整数でない数値・関数・`undefined` の直接渡し。
 */
export function canonicalJson(value: CanonicalValue): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isInteger(value)) {
        throw new CanonicalJsonError(`CANONICAL_NON_INTEGER:${String(value)}`);
      }
      // `-0` を `0` に寄せる。`JSON.stringify(-0)` は "0" だが、
      // ここは String() を使うので明示的に潰す（"-0" が混ざらないように）。
      return String(value === 0 ? 0 : value);
    case "object":
      break;
    default:
      throw new CanonicalJsonError(`CANONICAL_UNSUPPORTED:${typeof value}`);
  }

  if (Array.isArray(value)) {
    // 並べ替えない。**順序が記録**（時間ログ・写真の並び）。
    return `[${value.map((entry) => canonicalJson(entry as CanonicalValue)).join(",")}]`;
  }

  const record = value as { readonly [key: string]: CanonicalValue | undefined };
  const parts: string[] = [];
  // **コードユニット順。** `localeCompare` を使わない（ロケールで並びが変わる）。
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * ISO 8601 UTC の文字列（§6.2 の `"2026-09-10T04:25:31.000Z"`）。
 *
 * ミリ秒の epoch を受ける。**`Date` を受けない**のは、呼び出し側が
 * `Date.now()` をここへ持ち込む形にしないため（engine の制約）。
 */
export function isoUtc(epochMs: number): string {
  if (!Number.isInteger(epochMs)) {
    throw new CanonicalJsonError(`CANONICAL_NON_INTEGER_TIME:${String(epochMs)}`);
  }
  return new Date(epochMs).toISOString();
}

/**
 * 連鎖ハッシュの入力（§6.2 の `(previousHash ?? "GENESIS") + payloadSha256`）。
 *
 * **連結だけ。** 区切り文字を入れていないのは仕様の式に合わせたため。
 * どちらも固定長の 16 進（または `GENESIS`）なので、境界は曖昧にならない。
 */
export function chainHashInput(previousHash: string | null, payloadSha256: string): string {
  return `${previousHash ?? GENESIS_HASH}${payloadSha256}`;
}

// ────────────────────────────────────────────────────────────
// payload の組立（§6.2）
// ────────────────────────────────────────────────────────────

/** 写真 1 枚（§6.2 の `photos[]`）。**署名付き URL も R2 キーも入れない。** */
export interface EvidencePhotoInput {
  id: string;
  sha256: string;
}

/** 時間ログ 1 件。**`clientTs` を入れない**（端末の時計は参考値）。 */
export interface EvidenceTimeLogInput {
  event: string;
  atMs: number;
  reasonCode: string | null;
}

/** 清掃完了の証跡（§6.2 の例そのもの）。 */
export interface CleaningCompletionInput {
  taskId: string;
  roomId: string;
  businessDate: string;
  taskType: string;
  /** 清掃担当者の `membership.id`。未割当なら `null`。 */
  cleanerId: string | null;
  completedAtMs: number;
  actualMinutes: number | null;
  checklistTemplateVersion: number | null;
  photos: readonly EvidencePhotoInput[];
  timeLogs: readonly EvidenceTimeLogInput[];
}

/**
 * 清掃完了の payload。
 *
 * **宿泊者に関する値を 1 つも持たない**（security.md §3 / INV-10）。
 * 清掃担当者は `membership.id` で、氏名を入れない（§1.3。証跡が
 * 人事評価の材料になる形を作らない）。
 */
export function buildCleaningCompletionPayload(input: CleaningCompletionInput): CanonicalValue {
  return {
    actualMinutes: input.actualMinutes,
    businessDate: input.businessDate,
    cleanerId: input.cleanerId,
    completedAt: isoUtc(input.completedAtMs),
    photos: input.photos.map((photo) => ({ id: photo.id, sha256: photo.sha256 })),
    roomId: input.roomId,
    taskId: input.taskId,
    taskType: input.taskType,
    templateVersion: input.checklistTemplateVersion,
    timeLogs: input.timeLogs.map((log) => ({
      at: isoUtc(log.atMs),
      event: log.event,
      reasonCode: log.reasonCode,
    })),
  };
}

/** 検査項目 1 件（証跡に載せる分）。 */
export interface EvidenceInspectionItemInput {
  checklistItemId: string;
  status: string;
  defectCode: string | null;
  note: string | null;
  reworkRequired: boolean;
  photos: readonly EvidencePhotoInput[];
}

/** 検査の証跡（`INSPECTION_PASS` / `INSPECTION_FAIL`）。 */
export interface InspectionEvidenceInput {
  taskId: string;
  roomId: string;
  businessDate: string;
  inspectionId: string;
  round: number;
  /** 検査担当者の `membership.id`。 */
  inspectorId: string;
  result: string;
  startedAtMs: number;
  completedAtMs: number;
  durationSeconds: number | null;
  selfApproved: boolean;
  generalNote: string | null;
  items: readonly EvidenceInspectionItemInput[];
}

/**
 * 検査の payload。
 *
 * **項目を全部載せる。** 不合格だけに絞らないのは、後から
 * 「何を見て合格にしたか」が要るため（§12.2 の証跡詳細）。
 * 項目の並びは呼び出し側の順序（清掃時のチェックリスト定義順）を保つ。
 */
export function buildInspectionPayload(input: InspectionEvidenceInput): CanonicalValue {
  return {
    businessDate: input.businessDate,
    completedAt: isoUtc(input.completedAtMs),
    durationSeconds: input.durationSeconds,
    generalNote: input.generalNote,
    inspectionId: input.inspectionId,
    inspectorId: input.inspectorId,
    items: input.items.map((item) => ({
      checklistItemId: item.checklistItemId,
      defectCode: item.defectCode,
      note: item.note,
      photos: item.photos.map((photo) => ({ id: photo.id, sha256: photo.sha256 })),
      reworkRequired: item.reworkRequired,
      status: item.status,
    })),
    result: input.result,
    roomId: input.roomId,
    round: input.round,
    selfApproved: input.selfApproved,
    startedAt: isoUtc(input.startedAtMs),
    taskId: input.taskId,
  };
}

/** 再清掃完了の証跡（`REWORK_COMPLETION` / §4.6）。 */
export interface ReworkCompletionInput {
  taskId: string;
  roomId: string;
  businessDate: string;
  reworkCycleId: string;
  inspectionId: string;
  round: number;
  /** 再清掃の担当者の `membership.id`。 */
  assignedToId: string;
  reasonSummary: string;
  startedAtMs: number | null;
  completedAtMs: number;
  /** 再清掃で差し戻された項目（`checklistItem.id` の並び）。 */
  reworkItemIds: readonly string[];
  /** 再清掃で撮った写真（`taskPhoto`）。 */
  photos: readonly EvidencePhotoInput[];
}

/**
 * 再清掃完了の payload。
 *
 * **差し戻された項目 ID を載せる。** §4.6 の「再清掃で行った操作、写真、
 * 時刻は `ReworkCycle` と次回検査へ紐づける」を証跡側で満たす形で、
 * 次のラウンドの検査証跡と項目 ID で突き合わせられる。
 */
export function buildReworkCompletionPayload(input: ReworkCompletionInput): CanonicalValue {
  return {
    assignedToId: input.assignedToId,
    businessDate: input.businessDate,
    completedAt: isoUtc(input.completedAtMs),
    inspectionId: input.inspectionId,
    photos: input.photos.map((photo) => ({ id: photo.id, sha256: photo.sha256 })),
    reasonSummary: input.reasonSummary,
    reworkCycleId: input.reworkCycleId,
    reworkItemIds: [...input.reworkItemIds],
    roomId: input.roomId,
    round: input.round,
    startedAt: input.startedAtMs === null ? null : isoUtc(input.startedAtMs),
    taskId: input.taskId,
  };
}

// ────────────────────────────────────────────────────────────
// 整合性の確認（§6.3 / §12.2）
// ────────────────────────────────────────────────────────────

/** 検証する 1 件。**保存された値と、再計算した値の両方を渡す。** */
export interface SnapshotVerificationInput {
  snapshotId: string;
  /** 保存されている `payloadSha256`。 */
  storedPayloadSha256: string;
  /** 保存されている `payload` を読み直してハッシュした値。 */
  recomputedPayloadSha256: string;
  /** 保存されている `chainHash`。 */
  storedChainHash: string;
  /** `chainHashInput(previousHash, storedPayloadSha256)` をハッシュした値。 */
  recomputedChainHash: string;
  /** 保存されている `previousHash`。 */
  previousHash: string | null;
}

/** 1 件の判定。 */
export interface SnapshotVerification {
  snapshotId: string;
  /** payload の再計算が保存値と一致した。 */
  payloadMatches: boolean;
  /** 連鎖の再計算が保存値と一致した。 */
  chainMatches: boolean;
  /** 直前のスナップショットの `chainHash` と `previousHash` が繋がっている。 */
  linkMatches: boolean;
  ok: boolean;
}

/** タスク 1 件ぶんの判定。 */
export interface EvidenceChainVerification {
  ok: boolean;
  /** 崩れている最初のスナップショット ID。すべて健全なら `null`。 */
  firstBrokenSnapshotId: string | null;
  snapshots: SnapshotVerification[];
}

/**
 * 証跡連鎖を検証する（§6.3 の「整合性を確認」）。
 *
 * **`createdAt` の昇順で渡すこと。** 連鎖は保存順にしか繋がらない。
 *
 * 3 つを別々に見る。
 *   `payloadMatches` … payload そのものが書き換わっていない
 *   `chainMatches`   … その行の `chainHash` が自分の payload と前の値から出る
 *   `linkMatches`    … `previousHash` が本当に直前の行の `chainHash`
 *
 * **`linkMatches` を分けてあるのは、行の削除を検出するため。** 途中の 1 件を
 * 消すと、残った行はそれぞれ自己整合のままで `chainMatches` が真になる。
 * 繋がりが切れることだけが手がかりになる。
 */
export function verifyEvidenceChain(
  inputs: readonly SnapshotVerificationInput[],
): EvidenceChainVerification {
  const snapshots: SnapshotVerification[] = [];
  let expectedPrevious: string | null = null;

  for (const input of inputs) {
    const payloadMatches = input.storedPayloadSha256 === input.recomputedPayloadSha256;
    const chainMatches = input.storedChainHash === input.recomputedChainHash;
    const linkMatches = input.previousHash === expectedPrevious;

    snapshots.push({
      snapshotId: input.snapshotId,
      payloadMatches,
      chainMatches,
      linkMatches,
      ok: payloadMatches && chainMatches && linkMatches,
    });
    // **保存されている `chainHash` を次の期待値にする。** 再計算した値を
    // 使うと、1 件の改ざんが以降すべてを「壊れている」に倒してしまい、
    // どこが起点かが読めなくなる。
    expectedPrevious = input.storedChainHash;
  }

  const broken = snapshots.find((snapshot) => !snapshot.ok);
  return {
    ok: broken === undefined,
    firstBrokenSnapshotId: broken?.snapshotId ?? null,
    snapshots,
  };
}
