import { z } from "zod";
import { boundedEventInterval } from "./event-dates.js";

const secret = z
  .string()
  .min(32)
  .refine((value) => !/^(replace|change|your[_-])/i.test(value));
const credential = z
  .string()
  .min(1)
  .refine((value) => !/^(replace|change|your[_-])/i.test(value));
const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    APP_ORIGIN: z.url().transform((value) => new URL(value).origin),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\//),
    MONGODB_DATABASE: z.string().regex(/^h4h_[A-Za-z0-9_-]{1,48}$/),
    BETTER_AUTH_SECRET: secret,
    INVITATION_ENCRYPTION_KEY: secret,
    GOOGLE_CLIENT_ID: credential,
    GOOGLE_CLIENT_SECRET: credential,
    DEMO_EVENT_ID: z.uuid().default("8ce60ac2-e914-4eaf-a02c-51e854827dcc"),
    DEMO_MIN_SIZE: z.coerce.number().int().min(1).max(20).default(2),
    DEMO_MAX_SIZE: z.coerce.number().int().min(1).max(20).default(4),
    DEMO_ADMISSIONS_CLOSES_AT: z.iso.datetime(),
    DEMO_EVENT_STARTS_AT: z.iso.datetime().optional(),
    DEMO_EVENT_ENDS_AT: z.iso.datetime().optional(),
  })
  .superRefine((config, context) => {
    if (!/^https?:/.test(config.APP_ORIGIN))
      context.addIssue({
        code: "custom",
        path: ["APP_ORIGIN"],
        message: "HTTP(S) required",
      });
    if (
      config.NODE_ENV === "production" &&
      !config.APP_ORIGIN.startsWith("https:")
    )
      context.addIssue({
        code: "custom",
        path: ["APP_ORIGIN"],
        message: "HTTPS required in production",
      });
    if (config.DEMO_MIN_SIZE > config.DEMO_MAX_SIZE)
      context.addIssue({
        code: "custom",
        path: ["DEMO_MIN_SIZE"],
        message: "Minimum exceeds maximum",
      });
    const start = config.DEMO_EVENT_STARTS_AT,
      end = config.DEMO_EVENT_ENDS_AT;
    if (
      (start || end) &&
      !boundedEventInterval(
        start ? new Date(start) : undefined,
        end ? new Date(end) : undefined,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["DEMO_EVENT_STARTS_AT"],
        message:
          "Provide both event dates with a positive interval of at most 31 days",
      });
    if (config.BETTER_AUTH_SECRET === config.INVITATION_ENCRYPTION_KEY)
      context.addIssue({
        code: "custom",
        path: ["INVITATION_ENCRYPTION_KEY"],
        message: "Use distinct secrets",
      });
  });

export function loadConfig(environment: NodeJS.ProcessEnv) {
  return schema.parse(environment);
}
