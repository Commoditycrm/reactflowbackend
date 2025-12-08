// src/services/WhatsAppService.ts
import { Twilio } from "twilio";
import { EnvLoader } from "../util/EnvLoader";
import logger from "../logger";

export interface WhatsAppTextPayload {
  to: string;
  body: string;
}

export interface WhatsAppMediaPayload {
  to: string;
  body: string;
  mediaUrl: string[];
}

export interface WhatsAppTemplatePayload {
  to: string;
  contentSid: string;
  variables: Record<string, string>;
}

export class WhatsAppService {
  private static instance: WhatsAppService;
  private client: Twilio;
  private fromNumber: string;

  private constructor() {
    const sid = EnvLoader.getOrThrow("TWILIO_ACCOUNT_SID");
    const token = EnvLoader.getOrThrow("TWILIO_AUTH_TOKEN");
    const from = EnvLoader.getOrThrow("TWILIO_WHATSAPP_FROM");

    this.client = new Twilio(sid, token);
    this.fromNumber = from.startsWith("whatsapp:") ? from : `whatsapp:${from}`;
  }

  static getInstance(): WhatsAppService {
    if (!WhatsAppService.instance) {
      WhatsAppService.instance = new WhatsAppService();
    }
    return WhatsAppService.instance;
  }

  private toWhatsApp(num: string): string {
    return num.startsWith("whatsapp:") ? num : `whatsapp:${num}`;
  }

  // -------------------------------------------------------------------------
  // 1) SIMPLE TEXT
  // -------------------------------------------------------------------------
  async sendText({ to, body }: WhatsAppTextPayload) {
    try {
      if (!to) throw new Error("Recipient number (to) is required");
      if (!body) throw new Error("Message body is required");

      const result = await this.client.messages.create({
        from: this.fromNumber,
        to: this.toWhatsApp(to),
        body,
      });

      logger?.info(`WA text sent to ${to}: SID=${result.sid}`);
      return result;
    } catch (err: any) {
      logger?.error(`WA text FAILED to ${to}:`, { err });
      throw err;
    }
  }

  
  async sendMedia({ to, body, mediaUrl }: WhatsAppMediaPayload) {
    try {
      if (!to) throw new Error("Recipient number (to) is required");
      if (!mediaUrl || mediaUrl.length === 0) {
        throw new Error("mediaUrl is required");
      }

      const result = await this.client.messages.create({
        from: this.fromNumber,
        to: this.toWhatsApp(to),
        mediaUrl,
        body,
      });

      logger?.info(`WA media sent to ${to}: SID=${result.sid}`);
      return result;
    } catch (err: any) {
      logger?.error(`WA media FAILED to ${to}:`,{err});
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // 3) TEMPLATE
  // -------------------------------------------------------------------------
  async sendTemplate({ to, contentSid, variables }: WhatsAppTemplatePayload) {
    try {
      if (!to) throw new Error("Recipient number (to) is required");
      if (!contentSid) throw new Error("contentSid is required");

      const result = await this.client.messages.create({
        from: this.fromNumber,
        to: this.toWhatsApp(to),
        contentSid,
        contentVariables: JSON.stringify(variables ?? {}),
      });

      logger?.info(
        `WA template sent to ${to}: SID=${result.sid}, contentSid=${contentSid}`
      );

      return result;
    } catch (err: any) {
      logger?.error(
        `WA template FAILED to ${to}: contentSid=${contentSid} | ${err.message}`
      );
      throw err;
    }
  }
}
