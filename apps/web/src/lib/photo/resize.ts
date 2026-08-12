/**
 * 撮影した写真のクライアント側処理（PK-SPEC-P1 §7.2）。
 *
 * task:  docs/tasks/P1-11.md
 * ルール: .claude/rules/security.md §4
 *
 * ```
 * 撮影 → canvas で再エンコード（長辺 1600px / JPEG q=0.7）
 *      → EXIF は再エンコードで丸ごと落ちる（GPS を含む）
 *      → clientId を採番して送信 or キューへ
 * ```
 *
 * ── `getUserMedia()` を使わない（§7.1 MUST）─────────────
 * 撮影は `input[type=file][capture=environment]`。この関数が受けるのは
 * その `File` で、**カメラを開く実装はここにも画面にも無い。**
 *
 * ── canvas 再エンコードが EXIF 除去そのもの ─────────────
 * `canvas.toBlob()` が出すのは画素から作り直した JPEG で、元の APP1
 * セグメントは引き継がれない。**「GPS だけ消す」処理を書かない。**
 * 消し漏れが起きるのは、消す対象を列挙する実装のほうだから。
 * HEIC → JPEG の変換（§7.3）も同じ経路で済む。
 *
 * ── ここはブラウザでのみ動く ────────────────────────────
 * `createImageBitmap` / `OffscreenCanvas` が要る。SSR から呼ばないこと。
 */

import { PHOTO_JPEG_QUALITY, PHOTO_MAX_LONG_EDGE } from "@pk/contracts";

/** 縮小後の寸法。 */
export interface Scaled {
  width: number;
  height: number;
}

/**
 * 長辺を上限に収める寸法を計算する。**拡大しない。**
 *
 * 小さい写真を 1600px へ引き伸ばすと、増えるのはファイルサイズだけ。
 */
export function fitLongEdge(width: number, height: number, maxLongEdge: number): Scaled {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge || longEdge === 0) return { width, height };
  const ratio = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/** 処理後の写真。 */
export interface PreparedPhoto {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * 撮影した画像を送信できる形にする。
 *
 * @throws 画像として読めない場合（対応していない形式・壊れたファイル）。
 */
export async function preparePhoto(file: Blob): Promise<PreparedPhoto> {
  const bitmap = await createImageBitmap(file);
  try {
    const scaled = fitLongEdge(bitmap.width, bitmap.height, PHOTO_MAX_LONG_EDGE);
    const canvas = new OffscreenCanvas(scaled.width, scaled.height);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("CANVAS_UNAVAILABLE");
    context.drawImage(bitmap, 0, 0, scaled.width, scaled.height);

    const blob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: PHOTO_JPEG_QUALITY,
    });
    return { blob, width: scaled.width, height: scaled.height };
  } finally {
    bitmap.close();
  }
}
