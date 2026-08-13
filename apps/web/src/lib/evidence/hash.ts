/**
 * SHA-256（PK-SPEC-P2 §6.2 / §6.3）。
 *
 * task: docs/tasks/P2-08.md
 *
 * ── `packages/engine` に置かない ─────────────────────────
 * `crypto.subtle.digest` は `Promise` を返す。engine は同期の純粋関数だけを
 * 持つ約束にしてあり（CLAUDE.md §5）、非同期を混ぜると「規則の表を
 * テストで直接押さえる」形が崩れる。正規化 JSON の**文字列**を作るところまでが
 * engine（`canonicalJson()`）、そこから先のハッシュがここ。
 *
 * ── 出力は小文字 16 進 ──────────────────────────────────
 * DB にも R2 の `customMetadata` にもこの表記で入る（§6.3）。
 * **base64 に変えないこと。** 保存済みの値と照合できなくなる。
 */

/**
 * バイト列の SHA-256（小文字 16 進 64 桁）。
 *
 * 写真のハッシュ（§6.3）に使う。
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // `BufferSource` として渡す。`Uint8Array` の `buffer` を直に渡すと
  // 部分ビューのときに範囲外まで読む。
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 文字列の SHA-256（UTF-8 でエンコードしてから）。
 *
 * 正規化 JSON（`payloadSha256`）と連鎖の入力（`chainHash`）に使う。
 * **`TextEncoder` は常に UTF-8。** ここを変えると既存のハッシュが再現しない。
 */
export async function sha256HexOfText(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}
