import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AddRepoInput,
  KachinaApi,
  UpdateSettingsInput
} from "../shared/types";
import type { RepoService } from "../main/repo-service";

const MAX_REQUEST_BYTES = 1024 * 1024;

interface InvokeRequest {
  method: keyof KachinaApi;
  args: unknown[];
}

export interface KachinaWebServerOptions {
  host: string;
  port: number;
  staticDirectory: string;
  requestShutdown: () => void;
}

export function createKachinaWebServer(
  service: RepoService,
  options: KachinaWebServerOptions
): http.Server {
  const staticDirectory = path.resolve(options.staticDirectory);
  const allowedHosts = new Set([
    `${options.host}:${options.port}`.toLowerCase(),
    `localhost:${options.port}`.toLowerCase()
  ]);
  const allowedOrigins = new Set([
    `http://${options.host}:${options.port}`.toLowerCase(),
    `http://localhost:${options.port}`.toLowerCase()
  ]);

  return http.createServer((request, response) => {
    void handleRequest(
      service,
      staticDirectory,
      allowedHosts,
      allowedOrigins,
      options.requestShutdown,
      request,
      response
    ).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
}

async function handleRequest(
  service: RepoService,
  staticDirectory: string,
  allowedHosts: ReadonlySet<string>,
  allowedOrigins: ReadonlySet<string>,
  requestShutdown: () => void,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  applySecurityHeaders(response);

  const host = request.headers.host?.toLowerCase() ?? "";
  if (!allowedHosts.has(host)) {
    sendJson(response, 403, { error: "Host is not allowed." });
    return;
  }

  const requestUrl = new URL(request.url ?? "/", `http://${host}`);
  if (requestUrl.pathname === "/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    sendJson(response, 200, { status: "ok" }, request.method === "HEAD");
    return;
  }

  if (requestUrl.pathname === "/api/invoke") {
    await handleApiRequest(service, allowedOrigins, request, response);
    return;
  }

  if (requestUrl.pathname === "/api/shutdown") {
    if (!validateJsonPost(allowedOrigins, request, response)) {
      return;
    }
    response.once("finish", () => {
      setImmediate(requestShutdown);
    });
    sendJson(response, 202, { status: "shutting-down" });
    return;
  }

  await serveStaticFile(staticDirectory, requestUrl.pathname, request, response);
}

async function handleApiRequest(
  service: RepoService,
  allowedOrigins: ReadonlySet<string>,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (!validateJsonPost(allowedOrigins, request, response)) {
    return;
  }

  const invocation = parseInvokeRequest(await readJsonBody(request));
  const result = await invokeService(service, invocation);
  sendJson(response, 200, result);
}

function validateJsonPost(
  allowedOrigins: ReadonlySet<string>,
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed." });
    return false;
  }

  const origin = request.headers.origin?.toLowerCase() ?? "";
  if (!allowedOrigins.has(origin)) {
    sendJson(response, 403, { error: "Origin is not allowed." });
    return false;
  }
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    sendJson(response, 415, { error: "Content-Type must be application/json." });
    return false;
  }
  return true;
}

async function invokeService(
  service: RepoService,
  invocation: InvokeRequest
): Promise<unknown> {
  const { method, args } = invocation;
  switch (method) {
    case "getSnapshot":
      requireArgumentCount(method, args, 0);
      return service.getSnapshot();
    case "refreshAll":
      requireArgumentCount(method, args, 0);
      return await service.refreshAll();
    case "scanConfiguredRoots":
      requireArgumentCount(method, args, 0);
      return await service.scanConfiguredRoots();
    case "addRepo":
      requireArgumentCount(method, args, 1);
      return await service.addRepo(recordArgument<AddRepoInput>(args, 0));
    case "removeRepo":
      requireArgumentCount(method, args, 1);
      return await service.removeRepo(stringArgument(args, 0));
    case "updateSettings":
      requireArgumentCount(method, args, 1);
      return await service.updateSettings(recordArgument<UpdateSettingsInput>(args, 0));
    case "stageFile":
      requireArgumentCount(method, args, 2);
      return await service.stageFile(stringArgument(args, 0), stringArgument(args, 1));
    case "unstageFile":
      requireArgumentCount(method, args, 2);
      return await service.unstageFile(stringArgument(args, 0), stringArgument(args, 1));
    case "commitRepo":
      requireArgumentCount(method, args, 2);
      return await service.commitRepo(stringArgument(args, 0), stringArgument(args, 1));
    case "pushRepo":
      requireArgumentCount(method, args, 1);
      return await service.pushRepo(stringArgument(args, 0));
    case "syncRepo":
      requireArgumentCount(method, args, 1);
      return await service.syncRepo(stringArgument(args, 0));
    case "openInEditor":
      requireArgumentCount(method, args, 1);
      return await service.openInEditor(stringArgument(args, 0));
    case "openInFileManager":
      requireArgumentCount(method, args, 1);
      return await service.openInFileManager(stringArgument(args, 0));
    case "openInTerminal":
      requireArgumentCount(method, args, 1);
      return await service.openInTerminal(stringArgument(args, 0));
    case "cancelRepoOperation":
      requireArgumentCount(method, args, 1);
      return service.cancelRepoOperation(stringArgument(args, 0));
    default:
      throw new Error("Unknown Kachina API method.");
  }
}

function parseInvokeRequest(value: unknown): InvokeRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { method?: unknown }).method !== "string" ||
    !Array.isArray((value as { args?: unknown }).args)
  ) {
    throw new Error("Invalid Kachina API request.");
  }
  return value as InvokeRequest;
}

function requireArgumentCount(
  method: keyof KachinaApi,
  args: unknown[],
  expected: number
): void {
  if (args.length !== expected) {
    throw new Error(`${method} expects ${expected} argument(s).`);
  }
}

function stringArgument(args: unknown[], index: number): string {
  const value = args[index];
  if (typeof value !== "string") {
    throw new Error(`Argument ${index + 1} must be a string.`);
  }
  return value;
}

function recordArgument<T>(args: unknown[], index: number): T {
  const value = args[index];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Argument ${index + 1} must be an object.`);
  }
  return value as T;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body is not valid JSON.");
  }
}

async function serveStaticFile(
  staticDirectory: string,
  requestPath: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    sendJson(response, 400, { error: "Invalid request path." });
    return;
  }

  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const candidate = path.resolve(staticDirectory, relativePath);
  if (
    candidate !== staticDirectory &&
    !candidate.startsWith(`${staticDirectory}${path.sep}`)
  ) {
    sendJson(response, 403, { error: "Path is not allowed." });
    return;
  }

  let content: Buffer;
  try {
    content = await fs.readFile(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    sendJson(
      response,
      code === "ENOENT" || code === "EISDIR" ? 404 : 500,
      { error: code === "ENOENT" || code === "EISDIR" ? "Not found." : "Could not read file." }
    );
    return;
  }

  response.statusCode = 200;
  response.setHeader("Content-Type", contentType(candidate));
  response.setHeader(
    "Cache-Control",
    path.basename(candidate) === "index.html"
      ? "no-store"
      : "public, max-age=31536000, immutable"
  );
  response.setHeader("Content-Length", content.byteLength);
  response.end(request.method === "HEAD" ? undefined : content);
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
  headOnly = false
): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Length", body.byteLength);
  response.end(headOnly ? undefined : body);
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function contentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
