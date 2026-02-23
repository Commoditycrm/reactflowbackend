# Services & Utilities - Complete Reference

## 📋 Table of Contents
- [Services Overview](#services-overview)
- [Email Service (SendGrid)](#email-service-sendgrid)
- [WhatsApp Service (Twilio)](#whatsapp-service-twilio)
- [Utility Functions](#utility-functions)
- [Logger](#logger)
- [Environment Loader](#environment-loader)

---

## Services Overview

All services use the **Singleton pattern** to ensure single instances across the application.

```
Services/
├── EmailService (SendGrid)
├── WhatsAppService (Twilio)
├── AIBotService (OpenAI)
├── FirebaseFunctions (Firebase Admin)
└── OrganizationEmailServices
```

---

## Email Service (SendGrid)

**File: `src/services/EmailService.ts`**

### Features

- ✅ Transactional emails
- ✅ Template support
- ✅ Bulk sending
- ✅ Attachments
- ✅ Error handling & logging

### Basic Usage

```typescript
import { EmailService } from "./services/EmailService";

const emailService = EmailService.getInstance();

// Send simple email
await emailService.send({
  to: "user@example.com",
  from: "noreply@yourapp.com",
  subject: "Welcome!",
  text: "Welcome to our platform",
  html: "<h1>Welcome!</h1>"
});
```

### Template Email

```typescript
// Using SendGrid dynamic template
await emailService.sendTemplate({
  to: "user@example.com",
  templateId: "d-abc123...",
  dynamicTemplateData: {
    userName: "John Doe",
    actionUrl: "https://yourapp.com/verify",
    expiresIn: "24 hours"
  }
});
```

### Bulk Email

```typescript
// Send to multiple recipients with personalization
await emailService.sendBulkTemplate({
  personalizations: [
    {
      to: [{ email: "user1@example.com" }],
      dynamicTemplateData: {
        userName: "Alice",
        taskCount: 5
      }
    },
    {
      to: [{ email: "user2@example.com" }],
      dynamicTemplateData: {
        userName: "Bob",
        taskCount: 3
      }
    }
  ],
  templateId: "d-xyz789..."
});
```

### With Attachments

```typescript
await emailService.send({
  to: "user@example.com",
  from: "noreply@yourapp.com",
  subject: "Your Report",
  text: "Please find attached",
  attachments: [
    {
      content: Buffer.from("Hello World").toString("base64"),
      filename: "report.txt",
      type: "text/plain",
      disposition: "attachment"
    }
  ]
});
```

### Implementation Details

```typescript
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
    if (!EmailService.instance) {
      EmailService.instance = new EmailService();
    }
    return EmailService.instance;
  }

  async send(data: MailDataRequired): Promise<boolean> {
    try {
      const [resp] = await this.mailer.send(data);
      logger.info("Email sent", {
        to: this.extractTo(data),
        status: resp.statusCode,
        messageId: resp.headers["x-message-id"]
      });
      return true;
    } catch (err) {
      logger.error("Email failed", { error: err });
      throw err;
    }
  }

  async sendTemplate(opts: {
    to: string | string[];
    templateId: string;
    dynamicTemplateData: Record<string, any>;
    subject?: string;
  }): Promise<boolean> {
    const msg: MailDataRequired = {
      from: this.fromEmail,
      to: opts.to,
      templateId: opts.templateId,
      dynamicTemplateData: opts.dynamicTemplateData,
      ...(opts.subject && { subject: opts.subject })
    };
    return this.send(msg);
  }
}
```

### Common Email Templates

**1. User Invitation**
```typescript
await emailService.sendTemplate({
  to: invite.email,
  templateId: process.env.SENDGRID_INVITE_TEMPLATE_ID!,
  dynamicTemplateData: {
    inviterName: inviter.name,
    orgName: organization.name,
    inviteLink: `${process.env.CLIENT_URL}/accept-invite?token=${invite.token}`,
    expiresIn: "7 days"
  }
});
```

**2. Task Assignment**
```typescript
await emailService.sendTemplate({
  to: assignee.email,
  templateId: process.env.SENDGRID_TASK_ASSIGNED_TEMPLATE_ID!,
  dynamicTemplateData: {
    assigneeName: assignee.name,
    taskName: task.label,
    projectName: project.name,
    dueDate: task.endDate,
    taskUrl: `${process.env.CLIENT_URL}/tasks/${task.id}`
  }
});
```

---

## WhatsApp Service (Twilio)

**File: `src/services/WhatsAppServices.ts`**

### Features

- ✅ Text messages
- ✅ Media messages (images, PDFs)
- ✅ Template messages
- ✅ Auto-formatting phone numbers

### Basic Usage

```typescript
import { WhatsAppService } from "./services/WhatsAppServices";

const whatsapp = WhatsAppService.getInstance();

// Send text message
await whatsapp.sendText({
  to: "+1234567890",
  body: "Hello from your project management app!"
});
```

### Send Media

```typescript
await whatsapp.sendMedia({
  to: "+1234567890",
  body: "Here's your project report",
  mediaUrl: [
    "https://yourcdn.com/reports/project-123.pdf"
  ]
});
```

### Send Template

```typescript
// Using approved WhatsApp template
await whatsapp.sendTemplate({
  to: "+1234567890",
  contentSid: "HX1234567890abcdef",  // Twilio content SID
  variables: {
    "1": "John Doe",
    "2": "Fix login bug"
  }
});
```

### Implementation

```typescript
export class WhatsAppService {
  private static instance: WhatsAppService;
  private client: Twilio;
  private fromNumber: string;

  private constructor() {
    const sid = EnvLoader.getOrThrow("TWILIO_ACCOUNT_SID");
    const token = EnvLoader.getOrThrow("TWILIO_AUTH_TOKEN");
    const from = EnvLoader.getOrThrow("TWILIO_WHATSAPP_FROM");

    this.client = new Twilio(sid, token);
    this.fromNumber = from.startsWith("whatsapp:") 
      ? from 
      : `whatsapp:${from}`;
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

  async sendText({ to, body }: { to: string; body: string }) {
    try {
      const result = await this.client.messages.create({
        from: this.fromNumber,
        to: this.toWhatsApp(to),
        body
      });

      logger?.info(`WhatsApp sent to ${to}: SID=${result.sid}`);
      return result;
    } catch (err) {
      logger?.error(`WhatsApp failed to ${to}:`, err);
    }
  }
}
```

### Common Use Cases

**Task Reminder**
```typescript
await whatsapp.sendText({
  to: user.phoneNumber,
  body: `🔔 Reminder: "${task.label}" is due tomorrow!`
});
```

**Project Update**
```typescript
await whatsapp.sendText({
  to: user.phoneNumber,
  body: `📊 Project "${project.name}" status changed to: ${status.name}`
});
```

---

## Utility Functions

### EnvLoader

**File: `src/util/EnvLoader.ts`**

Type-safe environment variable loader:

```typescript
export class EnvLoader {
  /**
   * Get env var or throw error if missing
   */
  static getOrThrow(key: string): string {
    const value = process.env[key];
    if (!value) {
      throw new Error(`Environment variable ${key} is required but not set`);
    }
    return value;
  }

  /**
   * Get env var with default fallback
   */
  static get(key: string, defaultValue?: string): string | undefined {
    return process.env[key] || defaultValue;
  }

  /**
   * Get as integer
   */
  static getInt(key: string, defaultValue?: number): number | undefined {
    const value = process.env[key];
    if (!value) return defaultValue;
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      throw new Error(`Environment variable ${key} must be a number`);
    }
    return parsed;
  }

  /**
   * Get as boolean
   */
  static getBool(key: string, defaultValue = false): boolean {
    const value = process.env[key];
    if (!value) return defaultValue;
    return value.toLowerCase() === "true" || value === "1";
  }
}
```

**Usage:**
```typescript
const apiKey = EnvLoader.getOrThrow("OPENAI_API_KEY");
const port = EnvLoader.getInt("PORT", 4000);
const debug = EnvLoader.getBool("DEBUG", false);
```

### Token Extractor

**File: `src/util/tokenExtractor.ts`**

```typescript
export const getTokenFromHeader = (
  authHeader: string | undefined
): string | null => {
  if (!authHeader) return null;
  
  // Expected format: "Bearer <token>"
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return null;
  }
  
  return parts[1];
};
```

### Minutes Between

**File: `src/util/minutesBetweens.ts`**

```typescript
import { DateTime } from "neo4j-driver";

/**
 * Convert Neo4j DateTime to epoch milliseconds
 */
export const toEpochMs = (dt: DateTime): number => {
  return (
    dt.year * 31536000000 +
    dt.month * 2592000000 +
    dt.day * 86400000 +
    dt.hour * 3600000 +
    dt.minute * 60000 +
    dt.second * 1000 +
    dt.nanosecond / 1000000
  );
};

/**
 * Calculate minutes between two Neo4j DateTimes
 */
export const minutesBetween = (
  start: DateTime,
  end: DateTime
): number => {
  const startMs = toEpochMs(start);
  const endMs = toEpochMs(end);
  return Math.floor((endMs - startMs) / 60000);
};
```

### Retry Custom Claims

**File: `src/util/retrySetCustomClaims.ts`**

```typescript
import { FirebaseFunctions } from "../graphql/firebase/firebaseFunctions";
import logger from "../logger";

const retrySetClaims = async (
  uid: string,
  claims: Record<string, any>,
  maxRetries = 3
): Promise<void> => {
  const firebaseFunctions = FirebaseFunctions.getInstance();
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await firebaseFunctions.setCustomUserClaims(uid, claims);
      logger?.info(`Custom claims set for ${uid} on attempt ${attempt}`);
      return;
    } catch (error) {
      if (attempt === maxRetries) {
        logger?.error(`Failed to set custom claims after ${maxRetries} attempts`, error);
        throw error;
      }
      
      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

export default retrySetClaims;
```

---

## Logger

**Files:**
- `src/logger/index.ts` - Main logger factory
- `src/logger/developmentLogger.ts` - Colorful console logs
- `src/logger/productionLogger.ts` - JSON structured logs

### Usage

```typescript
import logger from "./logger";

// Info
logger?.info("User created", { userId: "123", email: "user@example.com" });

// Warning
logger?.warn("Slow query detected", { duration: 5000, query: "..." });

// Error
logger?.error("Failed to process payment", { error: err, userId: "123" });

// Debug (only in development)
logger?.debug("Processing step", { step: 3, data: {...} });
```

### Development Output

```
[2024-01-07 10:30:00] INFO: User created
  userId: "123"
  email: "user@example.com"
```

### Production Output (JSON)

```json
{
  "timestamp": "2024-01-07T10:30:00.000Z",
  "level": "info",
  "message": "User created",
  "userId": "123",
  "email": "user@example.com"
}
```

### Implementation

```typescript
// src/logger/index.ts
import { isDevelopment } from "../env/detector";
import developmentLogger from "./developmentLogger";
import productionLogger from "./productionLogger";

const logger = isDevelopment() ? developmentLogger : productionLogger;

export default logger;
```

---

## Environment Detector

**File: `src/env/detector.ts`**

```typescript
export const NODE_ENV = process.env.NODE_ENV || "development";

export const isDevelopment = (): boolean => {
  return NODE_ENV === "development";
};

export const isProduction = (): boolean => {
  return NODE_ENV === "production";
};

export const isTest = (): boolean => {
  return NODE_ENV === "test";
};

export const loadDotenv = (): string | null => {
  if (isDevelopment() || isTest()) {
    require("dotenv").config();
    return ".env";
  }
  return null;
};
```

**Usage:**
```typescript
import { isDevelopment, isProduction } from "./env/detector";

if (isDevelopment()) {
  console.log("Running in dev mode");
}

const server = new ApolloServer({
  schema,
  introspection: !isProduction(),  // Disable in production
  debug: !isProduction()
});
```

---

## Common Patterns

### Singleton Service

```typescript
export class MyService {
  private static instance: MyService;
  
  private constructor() {
    // Initialize
  }
  
  static getInstance(): MyService {
    if (!MyService.instance) {
      MyService.instance = new MyService();
    }
    return MyService.instance;
  }
  
  async doSomething(): Promise<void> {
    // Implementation
  }
}

// Usage
const service = MyService.getInstance();
await service.doSomething();
```

### Async Retry

```typescript
async function retryAsync<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delay = 1000
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      await new Promise(resolve => setTimeout(resolve, delay * attempt));
    }
  }
  throw new Error("Max retries exceeded");
}

// Usage
const result = await retryAsync(
  () => externalAPI.call(),
  3,
  1000
);
```

### Error Wrapping

```typescript
class ServiceError extends Error {
  constructor(
    message: string,
    public code: string,
    public originalError?: Error
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

async function sendEmail(to: string): Promise<void> {
  try {
    await emailService.send({ to, ... });
  } catch (error) {
    throw new ServiceError(
      "Failed to send email",
      "EMAIL_SEND_FAILED",
      error as Error
    );
  }
}
```

---

## Best Practices

### 1. Always Use Singleton for Services

✅ Do:
```typescript
const emailService = EmailService.getInstance();
```

❌ Don't:
```typescript
const emailService = new EmailService();  // Multiple instances!
```

### 2. Handle Service Errors Gracefully

✅ Do:
```typescript
try {
  await emailService.send({ ... });
  logger?.info("Email sent successfully");
} catch (error) {
  logger?.error("Email failed, will retry later", error);
  // Queue for retry
}
```

❌ Don't:
```typescript
await emailService.send({ ... });  // Unhandled error will crash!
```

### 3. Use Type-Safe Environment Variables

✅ Do:
```typescript
const apiKey = EnvLoader.getOrThrow("API_KEY");
const port = EnvLoader.getInt("PORT", 4000);
```

❌ Don't:
```typescript
const apiKey = process.env.API_KEY;  // Might be undefined!
const port = parseInt(process.env.PORT);  // Might be NaN!
```

### 4. Log Important Events

```typescript
// Service initialization
logger?.info("Email service initialized", { from: this.fromEmail });

// Success
logger?.info("Email sent", { to, messageId });

// Errors
logger?.error("Email failed", { to, error });
```

---

## Summary

Services & Utilities provide:
- ✅ **Email Service** - Transactional & template emails
- ✅ **WhatsApp Service** - SMS notifications
- ✅ **Type-Safe Config** - Environment variable management
- ✅ **Logging** - Structured logging for dev & prod
- ✅ **Utilities** - Token extraction, retries, date handling
- ✅ **Singleton Pattern** - Single instances, efficient resource use
