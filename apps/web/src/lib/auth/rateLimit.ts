/**
 * IP 単位のレート制限。カウンタは Workers KV（`RATELIMIT`）。
 *
 * task:  docs/tasks/P0-08.md
 * ルール: .claude/rules/security.md §8
 *
 * ── 厳密ではない。それでよい ────────────────────────────
 * KV の読み取り → 加算 → 書き込みは原子的でないため、**同時到着した
 * リクエストは同じ値を読んで同じ値を書き、上限を数回超えうる。**
 * 厳密なカウンタには Durable Object が要るが、architecture.md §4 は DO を
 * 4 用途（`DocumentSequencer` / `InspectionLock` / `PropertyBoard` /
 * `ReconciliationLock`）に限定している。
 *
 * ここが守るのは「1 IP から毎分数百回の総当たりを浴びる」状態の遮断で、
 * 個別アカウントの保護は**ロック（10 回で 30 分）が担う。**
 * 2 つは別の層であり、片方でもう片方を代替しない。
 *
 * ── 固定窓 ──────────────────────────────────────────────
 * `rl:{bucket}:{identifier}:{窓番号}` を毎分作り、TTL で放置する。
 * スライディング窓にすると 1 リクエストごとに配列を読み書きすることになり、
 * KV の書き込み回数と競合の幅が増える。窓の境界で最大 2 倍通るのは許容する。
 */

import type { Env } from "@pk/db";

/** security.md §8 の制限。**ここに無い経路を勝手に足さない。** */
export const RATE_LIMITS = {
  /** `/auth/login`: 10 req/分/IP。 */
  login: { limit: 10, windowSeconds: 60 },
  /** `/auth/pin-login`: 20 req/分/IP。P0-09 が使う。 */
  pinLogin: { limit: 20, windowSeconds: 60 },
  /** Webhook 受信: 1200 req/分/integration（security.md §8）。P5-10 が使う。 */
  webhook: { limit: 1200, windowSeconds: 60 },
  /**
   * 公開 API 全般: 600 req/分/キー（PK-SPEC-P6 §6.5 / security.md §8）。
   *
   * **識別子はトークンのハッシュ。** 平文を KV のキー名にしない
   * （鍵の一覧を眺めただけでトークンが読める形にしない）。
   */
  publicApi: { limit: 600, windowSeconds: 60 },
  /** 公開 API の稼働記録投入: 60 req/分/キー（§6.5）。**全般に上乗せする。** */
  publicOccupancy: { limit: 60, windowSeconds: 60 },
  /** 公開 API の物理信号投入: 300 req/分/キー（§6.5）。同上。 */
  publicSignals: { limit: 300, windowSeconds: 60 },
  /**
   * 確認依頼のメールリンク画面: 30 req/分/IP（P5-17）。
   *
   * security.md §8 の表には無いが、**認証を要しない画面**なので
   * webhook と同じく IP で絞る。閲覧＋承認操作の両方に掛ける。
   */
  reviewLink: { limit: 30, windowSeconds: 60 },
} as const;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

export interface RateLimitResult {
  allowed: boolean;
  /** 429 の `Retry-After`（秒）。許可されたときは 0。 */
  retryAfterSeconds: number;
}

/**
 * KV の最小 TTL は 60 秒。窓より長く残すのは、窓の終端で書いた値が
 * 窓の終わりより先に消えて上限がリセットされるのを防ぐため。
 */
function ttlFor(windowSeconds: number): number {
  return Math.max(60, windowSeconds * 2);
}

/**
 * クライアント IP。**`X-Forwarded-For` を信用しない**（詐称できる）。
 *
 * Cloudflare が付ける `CF-Connecting-IP` のみを見る。取れない場合
 * （`wrangler dev` など）は固定の識別子に落とす。**その場合、
 * 全リクエストが 1 つの窓を共有して早く上限に達する。** 制限が緩む方向へは倒さない。
 */
export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

/**
 * 1 回分を消費する。**判定と加算を分けない**（間に隙間を作らないため）。
 *
 * 上限に達していれば加算せずに拒否する。拒否したリクエストで窓を伸ばすと、
 * 総当たり中は永久に解除されなくなる。
 */
export async function consumeRateLimit(
  env: Env,
  bucket: RateLimitBucket,
  identifier: string,
  now: Date,
): Promise<RateLimitResult> {
  const { limit, windowSeconds } = RATE_LIMITS[bucket];
  const windowIndex = Math.floor(now.getTime() / (windowSeconds * 1000));
  const key = `rl:${bucket}:${identifier}:${String(windowIndex)}`;

  const raw = await env.RATELIMIT.get(key);
  const current = raw === null ? 0 : Number.parseInt(raw, 10);
  const count = Number.isFinite(current) && current > 0 ? current : 0;

  const windowEndsAt = (windowIndex + 1) * windowSeconds * 1000;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowEndsAt - now.getTime()) / 1000));

  if (count >= limit) return { allowed: false, retryAfterSeconds };

  await env.RATELIMIT.put(key, String(count + 1), { expirationTtl: ttlFor(windowSeconds) });
  return { allowed: true, retryAfterSeconds: 0 };
}
