/**
 * 証跡バンドルのテスト（PK-SPEC-P2 §6.5）。
 *
 * task: docs/tasks/P2-10.md
 *
 * 完了条件「`verify.txt` で全ファイルを検証できる」を、
 * **書庫の中身から実際に照合し直して**確かめる。
 */

import { describe, expect, it } from "vitest";

import { buildZip } from "../zip/store.js";

import {
  buildEvidenceBundle,
  bundleFileName,
  photoFileName,
  snapshotFileName,
  verifyLine,
  type BundleContextInput,
  type BundlePhotoInput,
  type BundleSnapshotInput,
} from "./bundle.js";
import { sha256Hex } from "./hash.js";

const GENERATED_AT = new Date("2026-09-10T05:00:00.000Z");

const CONTEXT: BundleContextInput = {
  taskId: "o7k2m9__task_01JBXQ3ZK8N4P2VYR6",
  propertyCode: "HTLA",
  roomNumber: "302",
  businessDate: "2026-09-10",
  taskType: "CHECKOUT",
  generatedAt: GENERATED_AT,
  requestedById: "o7k2m9__mem_admin",
  chainOk: true,
};

function snapshot(
  evidenceType: string,
  index: number,
  extra: Partial<BundleSnapshotInput> = {},
): BundleSnapshotInput {
  return {
    snapshotId: `evd_${String(index)}`,
    evidenceType,
    payload: `{"n":${String(index)}}`,
    payloadSha256: `p${String(index)}`,
    previousHash: index === 1 ? null : `c${String(index - 1)}`,
    chainHash: `c${String(index)}`,
    correctsSnapshotId: null,
    createdAtMs: Date.UTC(2026, 8, 10, 4, index, 0),
    ...extra,
  };
}

function photo(
  source: BundlePhotoInput["source"],
  index: number,
): BundlePhotoInput {
  return {
    photoId: `ph_${String(index)}`,
    source,
    bytes: new TextEncoder().encode(`jpeg-${String(index)}`),
    sha256: `recorded-${String(index)}`,
  };
}

/** 書庫の中身を `{ path: bytes }` に開く。 */
function pathsOf(entries: readonly { path: string }[]): string[] {
  return entries.map((entry) => entry.path);
}

describe("bundleFileName", () => {
  it("§6.5 の例と同じ形になる", () => {
    expect(bundleFileName("2026-09-10", "HTLA", "302")).toBe("PK-20260910-HTLA-302.zip");
  });

  it("ファイル名に使えない文字を落とす", () => {
    expect(bundleFileName("2026-09-10", "HTL/A", "3 02")).toBe("PK-20260910-HTL_A-3_02.zip");
  });

  it("全角だけの部屋番号でも空にならない", () => {
    expect(bundleFileName("2026-09-10", "HTLA", "三〇二")).toBe("PK-20260910-HTLA-X.zip");
  });

  it("ハイフンとアンダースコアは残す", () => {
    expect(bundleFileName("2026-09-10", "HTL-A", "101_B")).toBe("PK-20260910-HTL-A-101_B.zip");
  });

  it("前後のアンダースコアを落とす", () => {
    expect(bundleFileName("2026-09-10", "（HTLA）", "302")).toBe("PK-20260910-HTLA-302.zip");
  });
});

describe("snapshotFileName", () => {
  it("§6.5 の構成そのままの名前が出る", () => {
    expect(snapshotFileName("CLEANING_COMPLETION", 1)).toBe("cleaning-completion.json");
    expect(snapshotFileName("INSPECTION_FAIL", 1)).toBe("inspection-round-1.json");
    expect(snapshotFileName("REWORK_COMPLETION", 1)).toBe("rework-round-1.json");
    expect(snapshotFileName("INSPECTION_PASS", 2)).toBe("inspection-round-2.json");
  });

  it("清掃完了が 2 件目以降なら番号が付く（訂正）", () => {
    expect(snapshotFileName("CLEANING_COMPLETION", 2)).toBe("cleaning-completion-2.json");
  });

  it("知らない種別でも名前が出る", () => {
    expect(snapshotFileName("SOMETHING_NEW", 1)).toBe("evidence-something-new-1.json");
  });
});

describe("photoFileName / verifyLine", () => {
  it("写真は 3 桁の連番", () => {
    expect(photoFileName("CLEANING", 1)).toBe("photos/cleaning-001.jpg");
    expect(photoFileName("INSPECTION", 12)).toBe("photos/inspection-012.jpg");
  });

  it("verify.txt の区切りは空白 2 つ（sha256sum の形式）", () => {
    expect(verifyLine("abc", "manifest.json")).toBe("abc  manifest.json");
  });
});

describe("buildEvidenceBundle", () => {
  it("§6.5 の構成でファイルが並ぶ", async () => {
    const bundle = await buildEvidenceBundle(
      CONTEXT,
      [
        snapshot("CLEANING_COMPLETION", 1),
        snapshot("INSPECTION_FAIL", 2),
        snapshot("REWORK_COMPLETION", 3),
        snapshot("INSPECTION_PASS", 4),
      ],
      [photo("CLEANING", 1), photo("INSPECTION", 2)],
    );

    expect(bundle.fileName).toBe("PK-20260910-HTLA-302.zip");
    expect(pathsOf(bundle.entries)).toEqual([
      "manifest.json",
      "cleaning-completion.json",
      "inspection-round-1.json",
      "rework-round-1.json",
      "inspection-round-2.json",
      "photos/cleaning-001.jpg",
      "photos/inspection-001.jpg",
      "verify.txt",
    ]);
  });

  it("verify.txt で全ファイルを検証できる（完了条件）", async () => {
    const bundle = await buildEvidenceBundle(
      CONTEXT,
      [snapshot("CLEANING_COMPLETION", 1), snapshot("INSPECTION_PASS", 2)],
      [photo("CLEANING", 1)],
    );

    const verify = bundle.entries.find((entry) => entry.path === "verify.txt");
    const lines = new TextDecoder().decode(verify?.bytes).trimEnd().split("\n");

    // verify.txt 自身は載らない。残り全部が 1 行ずつある。
    expect(lines).toHaveLength(bundle.entries.length - 1);

    for (const line of lines) {
      const [hash, path] = line.split("  ");
      const entry = bundle.entries.find((candidate) => candidate.path === path);
      expect(entry, `${String(path)} が書庫に無い`).toBeDefined();
      expect(await sha256Hex(entry?.bytes ?? new Uint8Array(0))).toBe(hash);
    }
  });

  it("payload を加工しない（並びを崩さない）", async () => {
    const raw = '{"z":1,"a":2}';
    const bundle = await buildEvidenceBundle(
      CONTEXT,
      [snapshot("CLEANING_COMPLETION", 1, { payload: raw })],
      [],
    );
    const file = bundle.entries.find((entry) => entry.path === "cleaning-completion.json");
    expect(new TextDecoder().decode(file?.bytes)).toBe(raw);
  });

  it("manifest に写真の記録済みハッシュが載る", async () => {
    const bundle = await buildEvidenceBundle(CONTEXT, [], [photo("CLEANING", 7)]);
    const manifest = JSON.parse(
      new TextDecoder().decode(bundle.entries[0]?.bytes),
    ) as { photos: { photoId: string; recordedSha256: string | null; file: string }[] };
    expect(manifest.photos).toEqual([
      { file: "photos/cleaning-001.jpg", photoId: "ph_7", source: "CLEANING", recordedSha256: "recorded-7" },
    ]);
  });

  it("manifest が連鎖の検証結果と但し書きを持つ", async () => {
    const bundle = await buildEvidenceBundle(
      { ...CONTEXT, chainOk: false },
      [snapshot("CLEANING_COMPLETION", 1)],
      [],
    );
    const manifest = JSON.parse(
      new TextDecoder().decode(bundle.entries[0]?.bytes),
    ) as { chain: { verifiedAtExport: boolean; note: string } };
    expect(manifest.chain.verifiedAtExport).toBe(false);
    expect(manifest.chain.note).toContain("外部の時刻認証");
  });

  it("宿泊者に関する値を持たない（security.md §3）", async () => {
    const bundle = await buildEvidenceBundle(CONTEXT, [snapshot("CLEANING_COMPLETION", 1)], []);
    const manifestText = new TextDecoder().decode(bundle.entries[0]?.bytes);
    for (const forbidden of ["guest", "reservation", "passport", "phone", "email"]) {
      expect(manifestText.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("証跡も写真も無くても書庫になる", async () => {
    const bundle = await buildEvidenceBundle(CONTEXT, [], []);
    expect(pathsOf(bundle.entries)).toEqual(["manifest.json", "verify.txt"]);
  });

  it("そのまま ZIP に詰められる（パスが重複しない）", async () => {
    const bundle = await buildEvidenceBundle(
      CONTEXT,
      [
        snapshot("CLEANING_COMPLETION", 1),
        snapshot("CLEANING_COMPLETION", 2, { correctsSnapshotId: "evd_1" }),
        snapshot("INSPECTION_PASS", 3),
      ],
      [photo("CLEANING", 1), photo("CLEANING", 2), photo("INSPECTION", 3)],
    );
    expect(() => buildZip(bundle.entries)).not.toThrow();
    expect(pathsOf(bundle.entries)).toContain("cleaning-completion-2.json");
  });
});
