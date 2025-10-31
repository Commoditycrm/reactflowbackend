// src/services/email/EmailService.ts
import sgMail, {
  MailDataRequired,
  ClientResponse,
  MailService,
} from "@sendgrid/mail";
import { EnvLoader } from "../util/EnvLoader";
import logger from "../logger";

export class EmailService {
  private static instance: EmailService;
  private readonly mailer: MailService;
  private readonly fromEmail: string;

  private constructor() {
    this.mailer = sgMail;
    this.mailer.setApiKey(EnvLoader.getOrThrow("SENDGRID_API_KEY"));
    this.fromEmail = EnvLoader.getOrThrow("EMAIL_FROM");
  }

  static getInstance(): EmailService {
    if (!EmailService.instance) EmailService.instance = new EmailService();
    return EmailService.instance;
  }

  /** Lowest-level: send exactly what SendGrid expects */
  async send(data: MailDataRequired): Promise<boolean> {
    try {
      const [resp] = await this.mailer.send(data);
      logger.info("SendGrid send ok", {
        to: this.extractTo(data),
        status: resp.statusCode,
        messageId: (resp.headers["x-message-id"] as string) ?? "",
      });
      return true;
    } catch (err) {
      this.logError("send", err, data);
      return false;
    }
  }

  /** Single dynamic-template email (no undefined keys) */
  async sendTemplate(opts: {
    to: MailDataRequired["to"];
    templateId: NonNullable<MailDataRequired["templateId"]>;
    dynamicTemplateData: NonNullable<MailDataRequired["dynamicTemplateData"]>;
    subject?: MailDataRequired["subject"];
    cc?: MailDataRequired["cc"];
    bcc?: MailDataRequired["bcc"];
    attachments?: MailDataRequired["attachments"];
    categories?: MailDataRequired["categories"];
    customArgs?: MailDataRequired["customArgs"];
  }): Promise<boolean> {
    const msg: MailDataRequired = {
      from: this.fromEmail,
      to: opts.to,
      templateId: opts.templateId,
      dynamicTemplateData: opts.dynamicTemplateData,
      ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
      ...(opts.cc ? { cc: opts.cc } : {}),
      ...(opts.bcc ? { bcc: opts.bcc } : {}),
      ...(opts.attachments ? { attachments: opts.attachments } : {}),
      ...(opts.categories ? { categories: opts.categories } : {}),
      ...(opts.customArgs ? { customArgs: opts.customArgs } : {}),
    };
    return this.send(msg);
  }

  /** Bulk dynamic-template email using personalizations */
  async sendBulkTemplate(opts: {
    personalizations: NonNullable<MailDataRequired["personalizations"]>;
    templateId: NonNullable<MailDataRequired["templateId"]>;
    subject?: MailDataRequired["subject"];
    cc?: MailDataRequired["cc"];
    bcc?: MailDataRequired["bcc"];
    attachments?: MailDataRequired["attachments"];
    categories?: MailDataRequired["categories"];
    customArgs?: MailDataRequired["customArgs"];
  }): Promise<boolean> {
    if (!opts.personalizations.length) return false;

    const msg: MailDataRequired = {
      from: this.fromEmail,
      personalizations: opts.personalizations,
      templateId: opts.templateId,
      ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
      ...(opts.cc ? { cc: opts.cc } : {}),
      ...(opts.bcc ? { bcc: opts.bcc } : {}),
      ...(opts.attachments ? { attachments: opts.attachments } : {}),
      ...(opts.categories ? { categories: opts.categories } : {}),
      ...(opts.customArgs ? { customArgs: opts.customArgs } : {}),
    };
    return this.send(msg);
  }

  // ---- helpers ----
  private extractTo(data: MailDataRequired) {
    const pz = (data as any)
      .personalizations as MailDataRequired["personalizations"];
    if (Array.isArray(pz) && pz.length) {
      const emails = pz.flatMap((p: any) => {
        const to = p?.to;
        const arr = Array.isArray(to) ? to : [to];
        return arr
          .map((x: any) => (typeof x === "string" ? x : x?.email))
          .filter(Boolean);
      });
      return Array.from(new Set(emails));
    }
    const t = (data as any).to as MailDataRequired["to"];
    if (!t) return null;
    const arr = Array.isArray(t) ? t : [t];
    return Array.from(
      new Set(
        arr
          .map((x: any) => (typeof x === "string" ? x : x?.email))
          .filter(Boolean)
      )
    );
  }

  private logError(ctx: string, err: unknown, msg: MailDataRequired) {
    const res = (err as any)?.response as ClientResponse | undefined;
    const statusCode = (res as any)?.statusCode;
    const body = (res as any)?.body;
    let parsed: unknown = body;
    if (typeof body === "string") {
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = body.slice(0, 400);
      }
    }
    logger.error(`SendGrid ${ctx} failed`, {
      to: this.extractTo(msg),
      statusCode,
      errors: (parsed as any)?.errors ?? parsed,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
