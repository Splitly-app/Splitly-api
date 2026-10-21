import { openapi } from "@elysia/openapi";
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { createRoomRoutes } from "./modules/rooms/routes";
import type { RoomService } from "./modules/rooms/service";

export type Identity = { id: string };
export type AuthGateway = (token: string) => Promise<Identity | null>;

export function createApp(options: {
  allowedOrigins: string[];
  docsEnabled?: boolean;
  resolveUser: AuthGateway;
  rooms?: RoomService;
  version: string;
  log?: (entry: Record<string, unknown>) => void;
}) {
  return new Elysia()
    .use(
      openapi({
        enabled: options.docsEnabled ?? false,
        provider: "swagger-ui",
        path: "/docs",
        specPath: "/docs/json",
        documentation: {
          info: { title: "Splitly API", version: "0.1.0" },
          components: {
            securitySchemes: {
              BearerAuth: {
                type: "http",
                scheme: "bearer",
                bearerFormat: "JWT",
              },
              RoomToken: {
                type: "apiKey",
                in: "header",
                name: "x-room-token",
                description:
                  "Room link token; anyone holding it can edit this room",
              },
              MemberToken: {
                type: "apiKey",
                in: "header",
                name: "x-member-token",
                description:
                  "Selected member session token; required for expense mutations",
              },
            },
          },
        },
      }),
    )
    .use(
      cors({
        origin: options.allowedOrigins,
        credentials: false,
        allowedHeaders: [
          "authorization",
          "content-type",
          "x-room-token",
          "x-member-token",
        ],
        exposeHeaders: ["x-request-id"],
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      }),
    )
    .onRequest(({ set }) => {
      // Generate our own ID; avoid trusting client-supplied log data.
      set.headers["x-request-id"] = crypto.randomUUID();
    })
    .onAfterHandle(({ request, set }) => {
      options.log?.({
        event: "http_request",
        method: request.method,
        path: new URL(request.url).pathname,
        status: set.status ?? 200,
        requestId: set.headers["x-request-id"],
      });
    })
    .onError(({ code, set }) => {
      if (code === "NOT_FOUND") {
        set.status = 404;
        return { error: { code: "NOT_FOUND", message: "Route not found" } };
      }
      if (code === "VALIDATION") {
        set.status = 422;
        return {
          error: { code: "VALIDATION_ERROR", message: "Invalid request" },
        };
      }
      set.status = 500;
      return {
        error: {
          code: "INTERNAL_ERROR",
          message: "Request could not be completed",
        },
      };
    })
    .get("/healthz", () => ({ status: "ok", version: options.version }), {
      detail: { summary: "Process health" },
    })
    .get(
      "/v1/me",
      async ({ headers, set }) => {
        const match = /^Bearer ([^\s]+)$/i.exec(headers.authorization ?? "");
        if (!match) {
          set.status = 401;
          return {
            error: {
              code: "UNAUTHORIZED",
              message: "A valid access token is required",
            },
          };
        }
        let user: Identity | null;
        try {
          user = await options.resolveUser(match[1]);
        } catch {
          set.status = 503;
          return {
            error: {
              code: "AUTH_UNAVAILABLE",
              message: "Authentication is unavailable",
            },
          };
        }
        if (!user) {
          set.status = 401;
          return {
            error: {
              code: "UNAUTHORIZED",
              message: "A valid access token is required",
            },
          };
        }
        return { data: { id: user.id } };
      },
      {
        detail: {
          summary: "Get the verified current user",
          security: [{ BearerAuth: [] }],
          responses: {
            200: { description: "Verified user ID" },
            401: { description: "Missing or invalid access token" },
            503: { description: "Authentication provider unavailable" },
          },
        },
      },
    )
    .use(options.rooms ? createRoomRoutes(options.rooms) : new Elysia());
}
