import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
} from "express";
import helmet from "helmet";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { MongoError, ObjectId, type Db, type MongoClient } from "mongodb";
import { z, ZodError } from "zod";
import type { AuthHttp } from "./auth.js";
import { Membership } from "./membership.js";
import { Operations, type Intent } from "./operations.js";
import { InviteLimiter } from "./invite-limiter.js";
import { Discovery } from "./discovery.js";
import { profileInput, skillTag, teamProfileInput } from "./profiles.js";
import { Suggestions } from "./ranking.js";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

type Actor = { id: string; name: string };
type Dependencies = {
  auth: AuthHttp;
  db: Db;
  client: MongoClient;
  origin: string;
  invitationKey: string;
  logger?: Logger;
  isReady?: () => boolean;
};
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
function intent(request: Request, actor: Actor): Intent {
  return {
    actorId: actor.id,
    eventId: z.uuid().parse(request.params.eventId),
    key: z.uuid().parse(request.get("Idempotency-Key")),
  };
}

export function createApp(options?: Dependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(helmet());
  app.use((request, response, next) => {
    const requestId = randomUUID();
    const started = performance.now();
    response.setHeader("X-Request-Id", requestId);
    response.on("finish", () =>
      options?.logger?.info(
        {
          requestId,
          method: request.method,
          path: request.path,
          status: response.statusCode,
          durationMs: performance.now() - started,
        },
        "HTTP response",
      ),
    );
    next();
  });
  app.get("/health/live", (_request, response) => {
    response.json({ status: "alive" });
  });
  if (!options) return app;
  const membership = new Membership(
    options.db,
    options.client,
    options.invitationKey,
    options.logger,
  );
  const inviteLimiter = new InviteLimiter(
    options.db,
    options.client,
    options.invitationKey,
  );
  const operations = new Operations(options.db, options.client, options.logger);
  const discovery = new Discovery(options.db, operations);
  const suggestions = new Suggestions(options.db, options.client);
  app.get("/health/ready", async (_request, response) => {
    if (options.isReady && !options.isReady()) {
      response.status(503).json({ status: "unavailable" });
      return;
    }
    try {
      const hello = await options.db.command({ hello: 1 });
      response
        .status(hello.isWritablePrimary ? 200 : 503)
        .json({ status: hello.isWritablePrimary ? "ready" : "unavailable" });
    } catch {
      response.status(503).json({ status: "unavailable" });
    }
  });
  app.use("/api", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.all("/api/auth/*splat", toNodeHandler(options.auth));
  app.use(express.json({ limit: "16kb", strict: true }));
  app.use("/api", (request, _response, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      if (
        request.get("Origin") !== options.origin ||
        request.get("X-App-Request") !== "1"
      )
        throw new ApiError(403, "UNTRUSTED_ORIGIN");
      if (!request.is("application/json"))
        throw new ApiError(415, "JSON_REQUIRED");
    }
    next();
  });
  const authenticated =
    (
      handler: (
        request: Request,
        response: express.Response,
        actor: Actor,
      ) => Promise<void>,
    ): RequestHandler =>
    async (request, response) => {
      let identity;
      try {
        identity = await options.auth.api.getSession({
          headers: fromNodeHeaders(request.headers),
          query: { disableCookieCache: true },
        });
      } catch {
        throw new ApiError(503, "IDENTITY_UNAVAILABLE");
      }
      if (!identity || !ObjectId.isValid(identity.session.id))
        throw new ApiError(401, "UNAUTHENTICATED");
      const current = await options.db.collection("session").findOne(
        { _id: new ObjectId(identity.session.id) },
        {
          readConcern: { level: "linearizable" },
          readPreference: "primary",
          maxTimeMS: 1_000,
        },
      );
      if (
        !current ||
        current.expiresAt <= new Date() ||
        String(current.userId) !== identity.user.id
      )
        throw new ApiError(401, "UNAUTHENTICATED");
      await handler(request, response, {
        id: identity.user.id,
        name: identity.user.name,
      });
    };
  app.get(
    "/api/me",
    authenticated(async (_request, response, actor) => {
      response.json(actor);
    }),
  );
  app.get(
    "/api/events/:eventId/operations/:key",
    authenticated(async (request, response, actor) => {
      const reply = await operations.get({
        actorId: actor.id,
        eventId: z.uuid().parse(request.params.eventId),
        key: z.uuid().parse(request.params.key),
      });
      response.status(reply.status).json(reply.body);
    }),
  );
  app.get(
    "/api/events/:eventId/me",
    authenticated(async (request, response, actor) => {
      z.strictObject({}).parse(request.query);
      const reply = await membership.getMine({
        actorId: actor.id,
        eventId: z.uuid().parse(request.params.eventId),
      });
      response.status(reply.status).json(reply.body);
    }),
  );
  app.get(
    "/api/events/:eventId/teams/:teamId",
    authenticated(async (request, response, actor) => {
      z.strictObject({}).parse(request.query);
      const reply = await membership.getTeam(
        { actorId: actor.id, eventId: z.uuid().parse(request.params.eventId) },
        z.uuid().parse(request.params.teamId),
      );
      response.status(reply.status).json(reply.body);
    }),
  );
  app.get(
    "/api/events/:eventId/teams/:teamId/history",
    authenticated(async (request, response, actor) => {
      const query = z
        .strictObject({
          limit: z
            .string()
            .regex(/^\d{1,2}$/)
            .transform(Number)
            .pipe(z.number().min(1).max(50))
            .default(20),
          cursor: z
            .string()
            .regex(/^[A-Za-z0-9_-]{1,256}$/)
            .optional(),
        })
        .parse(request.query);
      let cursor;
      if (query.cursor) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(
            Buffer.from(query.cursor, "base64url").toString("utf8"),
          );
        } catch {
          throw new ApiError(400, "INVALID_CURSOR");
        }
        cursor = z
          .strictObject({
            at: z.iso.datetime().transform((value) => new Date(value)),
            id: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(decoded);
      }
      const reply = await membership.getHistory(
        { actorId: actor.id, eventId: z.uuid().parse(request.params.eventId) },
        z.uuid().parse(request.params.teamId),
        query.limit,
        cursor,
      );
      response.status(reply.status).json(reply.body);
    }),
  );
  app.post(
    "/api/events/:eventId/enroll",
    authenticated(async (request, response, actor) => {
      z.strictObject({}).parse(request.body);
      const reply = await membership.enroll(intent(request, actor), actor.name);
      response.status(reply.status).json(reply.body);
    }),
  );
  app.get(
    "/api/events/:eventId/profile",
    authenticated(async (request, response, actor) => {
      z.strictObject({}).parse(request.query);
      const reply = await discovery.getProfile({
        eventId: z.uuid().parse(request.params.eventId),
        actorId: actor.id,
      });
      response.status(reply.status).json(reply.body);
    }),
  );
  app.post(
    "/api/events/:eventId/profile",
    authenticated(async (request, response, actor) => {
      const reply = await discovery.saveProfile(
        intent(request, actor),
        profileInput.parse(request.body),
      );
      response.status(reply.status).json(reply.body);
    }),
  );
  app.get(
    "/api/events/:eventId/board",
    authenticated(async (request, response, actor) => {
      const query = z
        .strictObject({
          kind: z.enum(["people", "teams"]).default("people"),
          limit: z
            .string()
            .regex(/^\d{1,2}$/)
            .transform(Number)
            .pipe(z.number().min(1).max(50))
            .default(20),
          after: z
            .string()
            .regex(/^[A-Za-z0-9_-]{1,128}$/)
            .optional(),
          skill: skillTag.optional(),
          search: z.string().trim().min(1).max(80).optional(),
        })
        .parse(request.query);
      const reply = await discovery.board(
        { eventId: z.uuid().parse(request.params.eventId), actorId: actor.id },
        query,
      );
      response.status(reply.status).json(reply.body);
    }),
  );
  app.post(
    "/api/events/:eventId/teams/:teamId/profile",
    authenticated(async (request, response, actor) => {
      const reply = await membership.saveTeamProfile(
        intent(request, actor),
        z.uuid().parse(request.params.teamId),
        teamProfileInput.parse(request.body),
      );
      response.status(reply.status).json(reply.body);
    }),
  );
  app.get(
    "/api/events/:eventId/teammate-suggestions",
    authenticated(async (request, response, actor) => {
      const size = z
        .string()
        .regex(/^\d{1,2}$/)
        .transform(Number)
        .pipe(z.number().min(1).max(25));
      const query = z
        .strictObject({
          limit: size.default(10),
          unrankedLimit: size.default(10),
          unrankedAfter: z
            .string()
            .regex(/^[A-Za-z0-9_-]{1,128}$/)
            .optional(),
        })
        .parse(request.query);
      const reply = await suggestions.get(
        { eventId: z.uuid().parse(request.params.eventId), actorId: actor.id },
        query,
      );
      response.status(reply.status).json(reply.body);
    }),
  );
  const requestQuery = (request: Request, defaultState: "all" | "pending") =>
    z
      .strictObject({
        limit: z
          .string()
          .regex(/^\d{1,2}$/)
          .transform(Number)
          .pipe(z.number().min(1).max(50))
          .default(20),
        after: z.uuid().optional(),
        state: z.enum(["all", "pending"]).default(defaultState),
      })
      .parse(request.query);
  app.get(
    "/api/events/:eventId/requests",
    authenticated(async (request, response, actor) => {
      const reply = await membership.getRequests(
        { eventId: z.uuid().parse(request.params.eventId), actorId: actor.id },
        requestQuery(request, "all"),
      );
      response.status(reply.status).json(reply.body);
    }),
  );
  app.get(
    "/api/events/:eventId/teams/:teamId/requests",
    authenticated(async (request, response, actor) => {
      const reply = await membership.getRequests(
        { eventId: z.uuid().parse(request.params.eventId), actorId: actor.id },
        requestQuery(request, "pending"),
        z.uuid().parse(request.params.teamId),
      );
      response.status(reply.status).json(reply.body);
    }),
  );
  app.post(
    "/api/events/:eventId/teams/:teamId/requests",
    authenticated(async (request, response, actor) => {
      z.strictObject({}).parse(request.body);
      const reply = await membership.createRequest(
        intent(request, actor),
        z.uuid().parse(request.params.teamId),
      );
      response.status(reply.status).json(reply.body);
    }),
  );
  app.post(
    "/api/events/:eventId/teams/:teamId/requests/:requestId/accept",
    authenticated(async (request, response, actor) => {
      z.strictObject({}).parse(request.body);
      const reply = await membership.acceptRequest(
        intent(request, actor),
        z.uuid().parse(request.params.teamId),
        z.uuid().parse(request.params.requestId),
      );
      response.status(reply.status).json(reply.body);
    }),
  );
  app.post(
    "/api/events/:eventId/teams/:teamId/requests/:requestId/:action",
    authenticated(async (request, response, actor) => {
      const action = z
        .enum(["decline", "withdraw"])
        .parse(request.params.action);
      z.strictObject({}).parse(request.body);
      const reply = await membership.closeRequest(
        intent(request, actor),
        z.uuid().parse(request.params.teamId),
        z.uuid().parse(request.params.requestId),
        action,
      );
      response.status(reply.status).json(reply.body);
    }),
  );
  app.post(
    "/api/events/:eventId/teams",
    authenticated(async (request, response, actor) => {
      const { name } = z
        .strictObject({ name: z.string().trim().min(1).max(80) })
        .parse(request.body);
      const reply = await membership.createTeam(intent(request, actor), name);
      response.status(reply.status).json(reply.body);
    }),
  );
  app.post(
    "/api/events/:eventId/teams/:teamId/invitations",
    authenticated(async (request, response, actor) => {
      const invitation = z
        .union([
          z.strictObject({ kind: z.literal("shared").default("shared") }),
          z.strictObject({
            kind: z.literal("personal"),
            subjectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
          }),
        ])
        .parse(request.body);
      const reply = await membership.issueInvitation(
        intent(request, actor),
        z.uuid().parse(request.params.teamId),
        invitation.kind === "personal" ? invitation.subjectId : undefined,
      );
      response.status(reply.status).json(reply.body);
    }),
  );
  app.post(
    "/api/events/:eventId/invitations/redeem",
    authenticated(async (request, response, actor) => {
      const limit = await inviteLimiter.consume(
        actor.id,
        request.ip ?? "unknown",
      );
      if (!limit.allowed) {
        if (limit.retryAfter)
          response.setHeader("Retry-After", limit.retryAfter);
        response.status(limit.status).json({
          code: limit.status === 429 ? "RATE_LIMITED" : "LIMITER_UNAVAILABLE",
        });
        return;
      }
      const { code } = z
        .strictObject({ code: z.string().regex(/^[A-Za-z0-9_-]{22}$/) })
        .parse(request.body);
      const reply = await membership.redeemInvitation(
        intent(request, actor),
        code,
      );
      response.status(reply.status).json(reply.body);
    }),
  );
  app.post(
    "/api/events/:eventId/teams/:teamId/invitations/:invitationId/revoke",
    authenticated(async (request, response, actor) => {
      z.strictObject({}).parse(request.body);
      const reply = await membership.revokeInvitation(
        intent(request, actor),
        z.uuid().parse(request.params.teamId),
        z.uuid().parse(request.params.invitationId),
      );
      response.status(reply.status).json(reply.body);
    }),
  );
  app.post(
    "/api/events/:eventId/teams/:teamId/leave",
    authenticated(async (request, response, actor) => {
      const { successorId } = z
        .strictObject({
          successorId: z
            .string()
            .regex(/^[A-Za-z0-9_-]{1,128}$/)
            .optional(),
        })
        .parse(request.body);
      const reply = await membership.leave(
        intent(request, actor),
        z.uuid().parse(request.params.teamId),
        successorId,
      );
      response.status(reply.status).json(reply.body);
    }),
  );
  app.post(
    "/api/events/:eventId/teams/:teamId/members/:userId/remove",
    authenticated(async (request, response, actor) => {
      z.strictObject({}).parse(request.body);
      const reply = await membership.removeMember(
        intent(request, actor),
        z.uuid().parse(request.params.teamId),
        z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,128}$/)
          .parse(request.params.userId),
      );
      response.status(reply.status).json(reply.body);
    }),
  );
  app.get(
    "/api/events/:eventId/teams/:teamId/invitations/:invitationId",
    authenticated(async (request, response, actor) => {
      const scope = {
        actorId: actor.id,
        eventId: z.uuid().parse(request.params.eventId),
      };
      const reply = await membership.getInvitation(
        scope,
        z.uuid().parse(request.params.teamId),
        z.uuid().parse(request.params.invitationId),
      );
      if (reply.status === 200 && typeof reply.body.code === "string")
        reply.body.link = `${options.origin}/join#code=${reply.body.code}`;
      response.status(reply.status).json(reply.body);
    }),
  );
  app.use((_request, response) => {
    response.status(404).json({ code: "NOT_FOUND" });
  });
  const errors: ErrorRequestHandler = (
    error: unknown,
    _request,
    response,
    _next,
  ) => {
    if (error instanceof ApiError) {
      response.status(error.status).json({ code: error.code });
      return;
    }
    if (error instanceof ZodError) {
      response.status(400).json({
        code: "INVALID_INPUT",
        fields: error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      });
      return;
    }
    if (error && typeof error === "object" && "type" in error) {
      if (error.type === "entity.too.large") {
        response.status(413).json({ code: "BODY_TOO_LARGE" });
        return;
      }
      if (error.type === "entity.parse.failed") {
        response.status(400).json({ code: "INVALID_JSON" });
        return;
      }
    }
    options.logger?.warn(
      {
        requestId: response.getHeader("X-Request-Id"),
        errorType: error instanceof Error ? error.name : "unknown",
        ...(error instanceof MongoError ? { labels: error.errorLabels } : {}),
      },
      "HTTP request failed",
    );
    response.status(error instanceof MongoError ? 503 : 500).json({
      code:
        error instanceof MongoError ? "STORAGE_UNAVAILABLE" : "INTERNAL_ERROR",
    });
  };
  app.use(errors);
  return app;
}
