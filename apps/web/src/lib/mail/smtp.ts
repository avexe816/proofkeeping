/**
 * SMTP クライアント（Lark Mail / `cloudflare:sockets`）。
 *
 * task: docs/tasks/P5-21.md
 * 決定: docs/DECISIONS.md #248
 *
 * ── 何も出力しない ──────────────────────────────────────
 * **このファイルは `console` を 1 度も呼ばない。** 宛先も本文も
 * サーバーの応答文字列も、呼び出し側へ返す `boolean` と**段階名**だけに
 * 畳んで渡す。応答の全文を持ち出さないのは、SMTP が拒否のときに
 * 宛先をそのまま echo するため（`550 <someone@example.com> not found`）。
 * `tests/security/mailSecrets.spec.ts` がこれを走査で固定する。
 *
 * ── 投げない ────────────────────────────────────────────
 * 例外を投げると、呼び出し元のスタックに接続先やコマンドが載りうる。
 * **すべて戻り値で表す。**
 *
 * ── 1 通 1 接続 ─────────────────────────────────────────
 * 接続を使い回さない。Workers の実行単位は短く、張りっぱなしの接続を
 * 持てない。**必ず閉じる**（`finally`）。
 *
 * ── 465 と 587 ──────────────────────────────────────────
 * 既定は **465 の implicit TLS**（`secureTransport: "on"`）。
 * Lark 側で 465 が使えないときだけ `SMTP_SECURE="starttls"` にして
 * 587 へ倒す（`connect(…, "starttls")` → `EHLO` → `STARTTLS` →
 * `startTls()` → **`EHLO` をやり直す**）。**25 番は使わない。**
 *
 * ── Queue の中だけで呼ぶ ────────────────────────────────
 * SMTP は往復が多い。リクエストハンドラ（CPU 50ms）では呼ばない
 * （CLAUDE.md §4）。呼び出し元は `consumers/*` と、開通の発行だけ。
 */

/** 接続の作り方。**テストは偽物を差し込む**（本番で渡さない）。 */
export type SocketConnect = (
  address: { hostname: string; port: number },
  options: { secureTransport: "on" | "starttls"; allowHalfOpen: false },
) => SmtpSocket;

/** 使う範囲だけを写した socket の形（`cloudflare:sockets` の部分集合）。 */
export interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close: () => Promise<void>;
  startTls: () => SmtpSocket;
}

/** 接続の設定。**password 以外は秘密ではない。** */
export interface SmtpConfig {
  host: string;
  port: number;
  /** `implicit` = 465、`starttls` = 587。 */
  secure: "implicit" | "starttls";
  username: string;
  password: string;
  /** `EHLO` に載せる名前。ドメインでよい。 */
  ehloName: string;
}

/**
 * どこまで進んだか。**失敗の報告はこの粒度まで**（応答文字列を出さない）。
 *
 * `probe` はここまでで止め、`send` は `DATA` まで進む。
 */
export const SMTP_STAGES = [
  "CONNECT",
  "TLS",
  "GREETING",
  "EHLO",
  "AUTH",
  "MAIL_FROM",
  "RCPT_TO",
  "DATA",
  "QUIT",
] as const;
export type SmtpStage = (typeof SMTP_STAGES)[number];

/** 1 回のやり取りの結果。**応答文字列を持たない。** */
export interface SmtpOutcome {
  ok: boolean;
  /** 失敗した段階。成功なら `null`。 */
  failedAt: SmtpStage | null;
  /** 失敗した応答の 3 桁コード（`550` など）。読めなければ `null`。 */
  code: number | null;
}

/** 全体のタイムアウト（ミリ秒）。**設定項目にしない。** */
export const SMTP_TIMEOUT_MS = 15_000;

/** 既定の接続。**`cloudflare:sockets` は使うときだけ読む**（test は node 環境）。 */
async function defaultConnect(): Promise<SocketConnect> {
  const mod = (await import("cloudflare:sockets")) as unknown as { connect: SocketConnect };
  return mod.connect;
}

/** 1 行ずつ読み、応答をまとめる小さな読み手。**中身を外へ出さない。** */
class ResponseReader {
  private buffer = "";
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  /**
   * 応答を 1 つ読む。継続行（`250-`）を最後の行（`250 `）まで畳む。
   *
   * 返すのは**コードと、広告された機能の有無を見るための大文字化した本文**。
   * 呼び出し側はコードと `includes()` にしか使わない（外へ出さない）。
   */
  async read(): Promise<{ code: number; text: string } | null> {
    for (;;) {
      const complete = this.takeComplete();
      if (complete !== null) return complete;

      const chunk = await this.reader.read();
      if (chunk.done) return null;
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  /** バッファに応答が 1 つ揃っていれば取り出す。 */
  private takeComplete(): { code: number; text: string } | null {
    const lines = this.buffer.split("\r\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      // 最後の行は「4 文字目が空白」。継続行は `-`。
      if (line.length >= 4 && line[3] === " ") {
        const code = Number.parseInt(line.slice(0, 3), 10);
        const text = lines.slice(0, i + 1).join("\n").toUpperCase();
        this.buffer = lines.slice(i + 1).join("\r\n");
        return { code: Number.isNaN(code) ? 0 : code, text };
      }
    }
    return null;
  }

  release(): void {
    try {
      this.reader.releaseLock();
    } catch {
      // 閉じ済みなら何もしない。
    }
  }
}

/** 送信の口。**行の終端は必ず CRLF。** */
class CommandWriter {
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly encoder = new TextEncoder();

  constructor(stream: WritableStream<Uint8Array>) {
    this.writer = stream.getWriter();
  }

  async write(line: string): Promise<void> {
    await this.writer.write(this.encoder.encode(`${line}\r\n`));
  }

  /** 本文をそのまま流す（既に CRLF 済み）。 */
  async writeRaw(data: string): Promise<void> {
    await this.writer.write(this.encoder.encode(data));
  }

  release(): void {
    try {
      this.writer.releaseLock();
    } catch {
      // 閉じ済みなら何もしない。
    }
  }
}

/** `AUTH LOGIN` に使う base64。 */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** 進行中の 1 セッション。**`run()` の中だけで生きる。** */
interface Session {
  reader: ResponseReader;
  writer: CommandWriter;
  socket: SmtpSocket;
}

/**
 * 接続 → TLS → greeting → EHLO までを通す。**probe と send の共通部分。**
 *
 * 成功したら `session` と、`EHLO` の応答（機能の広告）を返す。
 */
async function open(
  config: SmtpConfig,
  connect: SocketConnect,
): Promise<
  | { ok: true; session: Session; ehloText: string }
  | { ok: false; failedAt: SmtpStage; code: number | null; socket: SmtpSocket | null }
> {
  let socket: SmtpSocket;
  try {
    socket = connect(
      { hostname: config.host, port: config.port },
      {
        secureTransport: config.secure === "implicit" ? "on" : "starttls",
        allowHalfOpen: false,
      },
    );
  } catch {
    return { ok: false, failedAt: "CONNECT", code: null, socket: null };
  }

  let active = socket;
  let reader = new ResponseReader(active.readable);
  let writer = new CommandWriter(active.writable);

  // greeting（220）。**implicit TLS はここに届いた時点で handshake 済み。**
  const greeting = await reader.read();
  if (greeting === null || greeting.code !== 220) {
    return {
      ok: false,
      failedAt: config.secure === "implicit" ? "TLS" : "GREETING",
      code: greeting?.code ?? null,
      socket: active,
    };
  }

  await writer.write(`EHLO ${config.ehloName}`);
  let ehlo = await reader.read();
  if (ehlo === null || ehlo.code !== 250) {
    return { ok: false, failedAt: "EHLO", code: ehlo?.code ?? null, socket: active };
  }

  // 587 のときだけ、ここで TLS へ上げてやり直す。
  if (config.secure === "starttls") {
    if (!ehlo.text.includes("STARTTLS")) {
      return { ok: false, failedAt: "TLS", code: null, socket: active };
    }
    await writer.write("STARTTLS");
    const upgrade = await reader.read();
    if (upgrade === null || upgrade.code !== 220) {
      return { ok: false, failedAt: "TLS", code: upgrade?.code ?? null, socket: active };
    }

    reader.release();
    writer.release();
    active = active.startTls();
    reader = new ResponseReader(active.readable);
    writer = new CommandWriter(active.writable);

    // **TLS のあとは EHLO をやり直す**（RFC 3207 §4.2）。
    await writer.write(`EHLO ${config.ehloName}`);
    ehlo = await reader.read();
    if (ehlo === null || ehlo.code !== 250) {
      return { ok: false, failedAt: "EHLO", code: ehlo?.code ?? null, socket: active };
    }
  }

  return { ok: true, session: { reader, writer, socket: active }, ehloText: ehlo.text };
}

/** 後始末。**失敗しても握りつぶす**（閉じられないことを報告しても直せない）。 */
async function closeQuietly(session: Session | null, socket: SmtpSocket | null): Promise<void> {
  if (session !== null) {
    session.reader.release();
    session.writer.release();
  }
  const target = session?.socket ?? socket;
  if (target === null) return;
  try {
    await target.close();
  } catch {
    // 何もしない。
  }
}

/** 全体に時間の上限を掛ける。**相手が黙っても戻る。** */
async function withTimeout<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      resolve(fallback);
    }, SMTP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `probeSmtp()` の結果。**段階ごとの真偽値だけ。** */
export interface SmtpProbeResult {
  tcp: boolean;
  tls: boolean;
  greeting: boolean;
  ehlo: boolean;
  /** `AUTH` が広告されているか。**認証は試さない。** */
  authAdvertised: boolean;
  /** 失敗した段階。すべて通れば `null`。 */
  failedAt: SmtpStage | null;
}

/**
 * 接続の確認だけを行う（**メールを送らない**）。
 *
 * 接続 → TLS → greeting → `EHLO` → `AUTH` の広告の有無を見て `QUIT`。
 * **`AUTH LOGIN` は実行しない** — 失敗回数を Lark 側に溜めないため、
 * また password を検証段階で持ち出さないため（`SMTP_PASSWORD` を
 * 受け取らない引数の形にしてある）。
 */
export async function probeSmtp(
  config: Omit<SmtpConfig, "password" | "username"> & { username?: undefined },
  connect?: SocketConnect,
): Promise<SmtpProbeResult> {
  const failed = (failedAt: SmtpStage, reached: Partial<SmtpProbeResult>): SmtpProbeResult => ({
    tcp: false,
    tls: false,
    greeting: false,
    ehlo: false,
    authAdvertised: false,
    ...reached,
    failedAt,
  });

  const connector = connect ?? (await defaultConnect());
  return withTimeout(
    (async (): Promise<SmtpProbeResult> => {
      const opened = await open({ ...config, username: "", password: "" }, connector);
      if (!opened.ok) {
        await closeQuietly(null, opened.socket);
        const reached: Partial<SmtpProbeResult> = {
          tcp: opened.failedAt !== "CONNECT",
          tls: opened.failedAt !== "CONNECT" && opened.failedAt !== "TLS",
          greeting:
            opened.failedAt !== "CONNECT" &&
            opened.failedAt !== "TLS" &&
            opened.failedAt !== "GREETING",
        };
        return failed(opened.failedAt, reached);
      }

      const { session, ehloText } = opened;
      const authAdvertised = ehloText.includes("AUTH");
      await session.writer.write("QUIT");
      await closeQuietly(session, null);

      return {
        tcp: true,
        tls: true,
        greeting: true,
        ehlo: true,
        authAdvertised,
        failedAt: authAdvertised ? null : "AUTH",
      };
    })(),
    failed("CONNECT", {}),
  );
}

/** `sendViaSmtp()` の入力。**本文は組み立て済み**（`mime.ts`）。 */
export interface SmtpSendInput {
  /** エンベロープの差出人（`MAIL FROM`）。 */
  envelopeFrom: string;
  /** 宛先（`RCPT TO`）。**1 件以上。** cc も含めてここへ入れる。 */
  recipients: readonly string[];
  /** `DATA` に流す本文（ヘッダを含む / CRLF 済み）。 */
  data: string;
}

/**
 * 1 通送る。**成否と段階だけを返す。**
 *
 * 手順は `AUTH LOGIN` → `MAIL FROM` → `RCPT TO` → `DATA` → `.` → `QUIT`。
 * **`DATA` の完了（250）を受け取れたものだけを成功**とする
 * （= Lark が受理した。届いたかどうかは分からない / #248）。
 */
export async function sendViaSmtp(
  config: SmtpConfig,
  input: SmtpSendInput,
  connect?: SocketConnect,
): Promise<SmtpOutcome> {
  const connector = connect ?? (await defaultConnect());

  return withTimeout(
    (async (): Promise<SmtpOutcome> => {
      const opened = await open(config, connector);
      if (!opened.ok) {
        await closeQuietly(null, opened.socket);
        return { ok: false, failedAt: opened.failedAt, code: opened.code };
      }

      const { session } = opened;
      const { reader, writer } = session;

      /** 1 コマンド送って、期待するコードが返るかを見る。 */
      const step = async (line: string, expected: number): Promise<number | null> => {
        await writer.write(line);
        const response = await reader.read();
        if (response === null) return null;
        return response.code === expected ? null : response.code;
      };

      try {
        // AUTH LOGIN。**password はここでしか使わない。**
        await writer.write("AUTH LOGIN");
        const authPrompt = await reader.read();
        if (authPrompt === null || authPrompt.code !== 334) {
          return { ok: false, failedAt: "AUTH", code: authPrompt?.code ?? null };
        }
        await writer.write(base64(config.username));
        const passPrompt = await reader.read();
        if (passPrompt === null || passPrompt.code !== 334) {
          return { ok: false, failedAt: "AUTH", code: passPrompt?.code ?? null };
        }
        await writer.write(base64(config.password));
        const authed = await reader.read();
        if (authed === null || authed.code !== 235) {
          return { ok: false, failedAt: "AUTH", code: authed?.code ?? null };
        }

        const mailFrom = await step(`MAIL FROM:<${input.envelopeFrom}>`, 250);
        if (mailFrom !== null) return { ok: false, failedAt: "MAIL_FROM", code: mailFrom };

        // **1 件でも拒否されたら送らない。** 一部にだけ届いた状態を作らない。
        for (const recipient of input.recipients) {
          const rcptTo = await step(`RCPT TO:<${recipient}>`, 250);
          if (rcptTo !== null) return { ok: false, failedAt: "RCPT_TO", code: rcptTo };
        }

        const dataReady = await step("DATA", 354);
        if (dataReady !== null) return { ok: false, failedAt: "DATA", code: dataReady };

        await writer.writeRaw(input.data);
        await writer.write(".");
        const accepted = await reader.read();
        if (accepted === null || accepted.code !== 250) {
          return { ok: false, failedAt: "DATA", code: accepted?.code ?? null };
        }

        await writer.write("QUIT");
        return { ok: true, failedAt: null, code: null };
      } finally {
        await closeQuietly(session, null);
      }
    })(),
    { ok: false, failedAt: "CONNECT", code: null },
  );
}
