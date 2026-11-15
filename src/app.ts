import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
} from "express";
import helmet from "helmet";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import {
  MongoError,
  MongoServerError,
  ObjectId,
  type Db,
  type MongoClient,
} from "mongodb";
import { z, ZodError } from "zod";
import type { AuthHttp } from "./auth.js";
import { Membership, type HistoryCursor, type Event } from "./membership.js";
import { Operations, type Intent } from "./operations.js";
import { InviteLimiter } from "./invite-limiter.js";
import { Discovery } from "./discovery.js";
import { profileInput, skillTag, teamProfileInput } from "./profiles.js";
import { Suggestions } from "./ranking.js";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { LiveError, type LiveSource } from "./live-source.js";
import { openLive } from "./live-http.js";
import { currentPerson } from "./current-reads.js";
import { LiveReads, type ProjectionRead } from "./live-reads.js";
import type { CommandReply } from "./operations.js";
import { RateLimiterMongo, RateLimiterRes } from "rate-limiter-flexible";
import { mountWeb } from "./web.js";

type Actor = { id: string; name: string; expiresAt: Date };
type Dependencies = {
  auth: AuthHttp;
  db: Db;
  client: MongoClient;
  origin: string;
  invitationKey: string;
  logger?: Logger;
  isReady?: () => boolean;
  live?: LiveSource;
  webDirectory?: string;
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
  const liveAttempts = new RateLimiterMongo({
    storeClient: options.client,
    dbName: options.db.databaseName,
    tableName: "rate_limits",
    disableIndexesCreation: true,
    keyPrefix: "live_connect",
    points: 20,
    duration: 60,
  });
  const liveReads = options.live
    ? new LiveReads(options.db, options.client, options.live, options.logger)
    : undefined;
  const sharedBoards = new Map<
    string,
    Promise<Awaited<ReturnType<LiveReads["run"]>>>
  >();
  const project = async (
    request: Request,
    response: express.Response,
    read: (context?: ProjectionRead) => Promise<CommandReply>,
    publicBoard?: { key: string; actorId: string },
  ) => {
    const token = request.get("X-Read-Frontier");
    const mode = z
      .enum(["reset", "refresh"])
      .default("reset")
      .parse(request.get("X-Snapshot-Mode"));
    if (mode === "refresh" && !token)
      throw new LiveError("READ_FRONTIER_REQUIRED", 400);
    if (!liveReads) {
      if (token !== undefined) throw new LiveError("LIVE_SOURCE_UNAVAILABLE");
      const reply = await read();
      response.status(reply.status).json(reply.body);
      return;
    }
    const eventId = z.uuid().parse(request.params.eventId);
    const execute = () => liveReads.run(eventId, token, read);
    let result;
    if (publicBoard && mode === "refresh") {
      // Authorization is per caller even when a safe public projection is shared.
      if (
        !(await currentPerson(options.db, {
          eventId,
          actorId: publicBoard.actorId,
        }))
      )
        throw new ApiError(403, "NOT_ENROLLED");
      const minimum = options.live!.minimum(eventId, token);
      const key = `${eventId}:${minimum.frame.generation}:${minimum.at.toString()}:${publicBoard.key}`;
      let pending = sharedBoards.get(key);
      if (!pending && sharedBoards.size < 64) {
        const shared = execute().finally(() => {
          if (sharedBoards.get(key) === shared) sharedBoards.delete(key);
        });
        sharedBoards.set(key, shared);
        pending = shared;
      }
      result = await (pending ?? execute());
    } else result = await execute();
    if (result.frame)
      response.setHeader("X-Read-Frontier", result.frame.frontier);
    response.status(result.reply.status).json(result.reply.body);
  };
  app.get("/health/ready", async (_request, response) => {
    if (
      (options.isReady && !options.isReady()) ||
      (options.live && !options.live.ready)
    ) {
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
  const identify = async (request: Request): Promise<Actor> => {
    let identity;
    try {
      identity = await options.auth.api.getSession({
        headers: fromNodeHeaders(request.headers),
        query: { disableCookieCache: true },
      });
    } catch (error) {
      options.logger?.warn(
        { errorType: error instanceof Error ? error.name : "unknown" },
        "identity lookup unavailable",
      );
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
      !(current.expiresAt instanceof Date) ||
      !Number.isFinite(current.expiresAt.getTime()) ||
      current.expiresAt <= new Date() ||
      String(current.userId) !== identity.user.id
    )
      throw new ApiError(401, "UNAUTHENTICATED");
    return {
      id: identity.user.id,
      name: identity.user.name,
      expiresAt: current.expiresAt,
    };
  };
  const authenticated =
    (
      handler: (
        request: Request,
        response: express.Response,
        actor: Actor,
      ) => Promise<void>,
    ): RequestHandler =>
    async (request, response) => {
      const actor = await identify(request);
      const expectedActor = request.get("X-Actor-Id");
      if (expectedActor !== undefined && expectedActor !== actor.id)
        throw new ApiError(409, "ACTOR_CHANGED");
      await handler(request, response, actor);
    };
  app.get(
    "/api/me",
    authenticated(async (_request, response, actor) => {
      response.json({ id: actor.id, name: actor.name });
    }),
  );
  app.get(
    "/api/events/:eventId/live",
    authenticated(async (request, response, actor) => {
      z.strictObject({}).parse(request.query);
      const eventId = z.uuid().parse(request.params.eventId);
      if (
        (request.get("Origin") && request.get("Origin") !== options.origin) ||
        request.get("Sec-Fetch-Site") === "cross-site"
      )
        throw new ApiError(403, "UNTRUSTED_ORIGIN");
      const authorize = async () => {
        const current = await identify(request);
        if (
          current.id !== actor.id ||
          !(await currentPerson(options.db, { eventId, actorId: actor.id }))
        )
          throw new ApiError(403, "NOT_ENROLLED");
      };
      if (!(await currentPerson(options.db, { eventId, actorId: actor.id })))
        throw new ApiError(403, "NOT_ENROLLED");
      if (!options.live) throw new LiveError("LIVE_SOURCE_UNAVAILABLE");
      try {
        await liveAttempts.consume(actor.id);
      } catch (error) {
        if (error instanceof RateLimiterRes) {
          response.setHeader(
            "Retry-After",
            Math.max(1, Math.ceil(error.msBeforeNext / 1_000)),
          );
          throw new LiveError("LIVE_CONNECTION_RATE_LIMIT", 429);
        }
        throw new LiveError("LIMITER_UNAVAILABLE");
      }
      openLive(
        response,
        options.live,
        eventId,
        actor.id,
        actor.expiresAt,
        authorize,
      );
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
    "/api/events/:eventId",
    authenticated(async (request, response) => {
      z.strictObject({}).parse(request.query);
      const event = await options.db.collection<Event>("events").findOne(
        { _id: z.uuid().parse(request.params.eventId) },
        {
          readConcern: { level: "linearizable" },
          readPreference: "primary",
          maxTimeMS: 1_500,
        },
      );
      if (!event) throw new ApiError(404, "EVENT_NOT_FOUND");
      response.json({
        id: event._id,
        name: event.name,
        minSize: event.minSize,
        maxSize: event.maxSize,
        admissionClosesAt: event.admissionClosesAt,
        admissionsOpen: event.admissionClosesAt > new Date(),
        startsAt: event.startsAt ?? null,
        endsAt: event.endsAt ?? null,
      });
    }),
  );
  app.get(
    "/api/events/:eventId/me",
    authenticated(async (request, response, actor) => {
      z.strictObject({}).parse(request.query);
      await project(request, response, () =>
        membership.getMine({
          actorId: actor.id,
          eventId: z.uuid().parse(request.params.eventId),
        }),
      );
    }),
  );
  app.get(
    "/api/events/:eventId/teams/:teamId",
    authenticated(async (request, response, actor) => {
      z.strictObject({}).parse(request.query);
      await project(request, response, () =>
        membership.getTeam(
          {
            actorId: actor.id,
            eventId: z.uuid().parse(request.params.eventId),
          },
          z.uuid().parse(request.params.teamId),
        ),
      );
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
      let cursor: HistoryCursor | undefined;
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
      await project(request, response, (context) =>
        membership.getHistory(
          {
            actorId: actor.id,
            eventId: z.uuid().parse(request.params.eventId),
          },
          z.uuid().parse(request.params.teamId),
          query.limit,
          cursor,
          context,
        ),
      );
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
      await project(request, response, () =>
        discovery.getProfile({
          eventId: z.uuid().parse(request.params.eventId),
          actorId: actor.id,
        }),
      );
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
      await project(
        request,
        response,
        (context) =>
          discovery.board(
            {
              eventId: z.uuid().parse(request.params.eventId),
              actorId: actor.id,
            },
            query,
            context,
          ),
        { key: JSON.stringify(query), actorId: actor.id },
      );
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
      await project(request, response, (context) =>
        suggestions.get(
          {
            eventId: z.uuid().parse(request.params.eventId),
            actorId: actor.id,
          },
          query,
          context,
        ),
      );
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
      const query = requestQuery(request, "all");
      await project(request, response, (context) =>
        membership.getRequests(
          {
            eventId: z.uuid().parse(request.params.eventId),
            actorId: actor.id,
          },
          query,
          undefined,
          context,
        ),
      );
    }),
  );
  app.get(
    "/api/events/:eventId/teams/:teamId/requests",
    authenticated(async (request, response, actor) => {
      const query = requestQuery(request, "pending");
      await project(request, response, (context) =>
        membership.getRequests(
          {
            eventId: z.uuid().parse(request.params.eventId),
            actorId: actor.id,
          },
          query,
          z.uuid().parse(request.params.teamId),
          context,
        ),
      );
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
      await project(request, response, async (context) => {
        const reply = await membership.getInvitation(
          scope,
          z.uuid().parse(request.params.teamId),
          z.uuid().parse(request.params.invitationId),
          context,
        );
        if (reply.status === 200 && typeof reply.body.code === "string")
          reply.body.link = `${options.origin}/join?event=${scope.eventId}#code=${reply.body.code}`;
        return reply;
      });
    }),
  );
  if (options.webDirectory) mountWeb(app, options.webDirectory);
  app.use((_request, response) => {
    response.status(404).json({ code: "NOT_FOUND" });
  });
  const errors: ErrorRequestHandler = (
    error: unknown,
    _request,
    response,
    _next,
  ) => {
    if (error instanceof ApiError || error instanceof LiveError) {
      if (error.status === 429 && !response.hasHeader("Retry-After"))
        response.setHeader("Retry-After", 1);
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
        ...(error instanceof MongoServerError
          ? { databaseCode: error.code }
          : {}),
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
