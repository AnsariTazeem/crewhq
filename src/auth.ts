import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { customSession } from "better-auth/plugins";
import type { Db, MongoClient } from "mongodb";

export type AuthHttp = Pick<ReturnType<typeof betterAuth>, "handler" | "api">;

export function authOptions(input: {
  db: Db;
  client: MongoClient;
  origin: string;
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
}): BetterAuthOptions {
  const secure = input.origin.startsWith("https:");
  return {
    appName: "Hack4Hack Team Formation",
    baseURL: input.origin,
    secret: input.secret,
    trustedOrigins: [input.origin],
    database: mongodbAdapter(input.db, { client: input.client }),
    socialProviders: {
      google: {
        clientId: input.googleClientId,
        clientSecret: input.googleClientSecret,
      },
    },
    account: { accountLinking: { enabled: false } },
    session: {
      expiresIn: 86_400,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    plugins: [
      customSession(async ({ user, session }) => ({
        user: { id: user.id, name: user.name },
        session: {
          id: session.id,
          userId: session.userId,
          expiresAt: session.expiresAt,
        },
      })),
    ],
    rateLimit: { enabled: true, storage: "database", window: 60, max: 100 },
    advanced: {
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, secure, sameSite: "lax" },
      database: { joins: true },
    },
  };
}
