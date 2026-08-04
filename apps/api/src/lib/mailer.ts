// Minimal SMTP client over Cloudflare Workers' native TCP Sockets API (`cloudflare:sockets`),
// STARTTLS to Gmail on port 587. No Nodemailer — its `net`/`tls` module isn't available on Workers,
// and this avoids a third-party email API dependency since the requirement is Gmail SMTP specifically.
//
// Local dev (plain Node, via src/dev-server.ts) has no `cloudflare:sockets` — falls back to
// nodemailer there, since Node also has no raw TCP access without its own net/tls modules.

type SmtpConfig = {
  host: string;
  port: number;
  user: string; // Gmail address
  pass: string; // Gmail App Password (Google Account → Security → App Passwords)
};

async function sendMailNode(config: SmtpConfig, opts: { to: string; subject: string; text: string; html?: string }) {
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.default.createTransport({
    host: config.host,
    port: config.port,
    secure: false,
    requireTLS: true,
    auth: { user: config.user, pass: config.pass },
  });
  await transport.sendMail({
    from: `Attendance ERP <${config.user}>`,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
  });
}

class SmtpLineReader {
  private buffer = "";
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async readResponse(): Promise<string> {
    // Multi-line SMTP responses use "250-" for continuation and "250 " for the final line.
    let full = "";
    while (true) {
      while (!this.buffer.includes("\r\n")) {
        const { value, done } = await this.reader.read();
        if (done) throw new Error("SMTP connection closed unexpectedly");
        this.buffer += new TextDecoder().decode(value);
      }
      const idx = this.buffer.indexOf("\r\n");
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      full += line + "\n";
      if (/^\d{3} /.test(line)) break; // final line of the response block
    }
    return full;
  }
}

async function writeLine(writer: WritableStreamDefaultWriter<Uint8Array>, line: string) {
  await writer.write(new TextEncoder().encode(line + "\r\n"));
}

function expectCode(response: string, code: string) {
  if (!response.startsWith(code)) {
    throw new Error(`SMTP error, expected ${code}: ${response}`);
  }
}

export async function sendMail(
  config: SmtpConfig,
  opts: { to: string; subject: string; text: string; html?: string }
): Promise<void> {
  // Resolves only under workerd; on plain Node the import rejects and we fall back to nodemailer.
  const cfSockets = await import("cloudflare:sockets").catch(() => null);
  if (!cfSockets) {
    await sendMailNode(config, opts);
    return;
  }
  const { connect } = cfSockets;

  const socket = connect(
    { hostname: config.host, port: config.port },
    { secureTransport: "starttls", allowHalfOpen: false }
  );

  let writer = socket.writable.getWriter();
  let reader = socket.readable.getReader();
  let lineReader = new SmtpLineReader(reader);

  expectCode(await lineReader.readResponse(), "220");

  await writeLine(writer, `EHLO attendance-erp.local`);
  expectCode(await lineReader.readResponse(), "250");

  await writeLine(writer, "STARTTLS");
  expectCode(await lineReader.readResponse(), "220");

  // Upgrade the plaintext socket to TLS; must release locks before startTls().
  writer.releaseLock();
  reader.releaseLock();
  const secureSocket = socket.startTls();
  writer = secureSocket.writable.getWriter();
  reader = secureSocket.readable.getReader();
  lineReader = new SmtpLineReader(reader);

  await writeLine(writer, `EHLO attendance-erp.local`);
  expectCode(await lineReader.readResponse(), "250");

  await writeLine(writer, "AUTH LOGIN");
  expectCode(await lineReader.readResponse(), "334");

  await writeLine(writer, btoa(config.user));
  expectCode(await lineReader.readResponse(), "334");

  await writeLine(writer, btoa(config.pass));
  expectCode(await lineReader.readResponse(), "235");

  await writeLine(writer, `MAIL FROM:<${config.user}>`);
  expectCode(await lineReader.readResponse(), "250");

  await writeLine(writer, `RCPT TO:<${opts.to}>`);
  expectCode(await lineReader.readResponse(), "250");

  await writeLine(writer, "DATA");
  expectCode(await lineReader.readResponse(), "354");

  const body = [
    `From: Attendance ERP <${config.user}>`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: ${opts.html ? "text/html" : "text/plain"}; charset=UTF-8`,
    "",
    opts.html ?? opts.text,
    ".",
  ].join("\r\n");

  await writeLine(writer, body);
  expectCode(await lineReader.readResponse(), "250");

  await writeLine(writer, "QUIT");
  await writer.close();
}

export function otpEmailTemplate(otp: string, ttlMinutes: number) {
  return {
    subject: "Your Attendance Portal login OTP",
    text: `Your one-time password is ${otp}. It expires in ${ttlMinutes} minutes. If you did not request this, ignore this email.`,
    html: `<p>Your one-time password is <b style="font-size:18px">${otp}</b>.</p><p>It expires in ${ttlMinutes} minutes. If you did not request this, ignore this email.</p>`,
  };
}
