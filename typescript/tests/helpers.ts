import { readFileSync } from "node:fs";
import { parse } from "yaml";

/* ------------------------------------------------------- OpenAPI example access */

type JsonObject = Record<string, unknown>;

const document = parse(
  readFileSync(new URL("../../openapi/nbq-v1.openapi.yaml", import.meta.url), "utf8"),
) as JsonObject;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dig(root: unknown, pointer: readonly (string | number)[]): unknown {
  let current: unknown = root;
  for (const key of pointer) {
    if (Array.isArray(current) && typeof key === "number") {
      current = current[key];
      continue;
    }
    if (!isObject(current)) {
      throw new Error(`OpenAPI snapshot: cannot walk ${pointer.join("/")} at ${String(key)}`);
    }
    current = current[key];
  }
  if (current === undefined) {
    throw new Error(`OpenAPI snapshot: nothing at ${pointer.join("/")}`);
  }
  return current;
}

/** Follows a local `$ref` once, so `examples: { x: { $ref: ... } }` resolves. */
function deref(value: unknown): unknown {
  if (isObject(value) && typeof value.$ref === "string") {
    const pointer = value.$ref.replace(/^#\//, "").split("/");
    return dig(document, pointer);
  }
  return value;
}

function asObject(value: unknown, where: string): JsonObject {
  const resolved = deref(value);
  if (!isObject(resolved)) {
    throw new Error(`OpenAPI snapshot: ${where} is not an object`);
  }
  return resolved;
}

/** `components.examples.<name>.value` — the shared, reusable examples. */
export function sharedExample(name: string): JsonObject {
  return asObject(dig(document, ["components", "examples", name, "value"]), `example ${name}`);
}

/** A named `requestBody` example of an operation. */
export function requestExample(path: string, method: string, name: string): JsonObject {
  const example = asObject(
    dig(document, [
      "paths",
      path,
      method,
      "requestBody",
      "content",
      "application/json",
      "examples",
      name,
    ]),
    `request example ${name}`,
  );
  return asObject(example.value, `request example ${name}.value`);
}

/** A response example: named when `name` is given, otherwise the single `example`. */
export function responseExample(
  path: string,
  method: string,
  status: string,
  name?: string,
): JsonObject {
  const content = dig(document, ["paths", path, method, "responses", status, "content"]);
  const json = asObject(dig(content, ["application/json"]), `response ${status}`);
  if (name === undefined) {
    return asObject(json.example, `response ${status} example`);
  }
  const named = asObject(dig(json, ["examples", name]), `response ${status} example ${name}`);
  return asObject(named.value, `response ${status} example ${name}.value`);
}

/** The `text/csv` example of `GET /v1/configuration/questions`. */
export function csvResponseExample(): string {
  const value = dig(document, [
    "paths",
    "/v1/configuration/questions",
    "get",
    "responses",
    "200",
    "content",
    "text/csv",
    "example",
  ]);
  if (typeof value !== "string") {
    throw new Error("OpenAPI snapshot: the text/csv example is not a string");
  }
  return value;
}

/** The example body of a shared `components.responses` entry. */
export function errorExample(component: string, name?: string): JsonObject {
  const json = asObject(
    dig(document, ["components", "responses", component, "content", "application/json"]),
    `components.responses.${component}`,
  );
  if (name === undefined) {
    return asObject(json.example, `components.responses.${component}.example`);
  }
  const named = asObject(dig(json, ["examples", name]), `${component}.examples.${name}`);
  return asObject(named.value, `${component}.examples.${name}.value`);
}

/* --------------------------------------------------------------- fetch recorder */

export interface RecordedRequest {
  readonly url: string;
  readonly path: string;
  readonly search: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly rawBody: string | undefined;
}

export type Responder = (request: RecordedRequest, index: number) => Response | Promise<Response>;

export interface FetchRecorder {
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly requests: RecordedRequest[];
}

/** JSON response with the `Content-Type` and optional extra headers. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

export function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "Content-Type": "text/csv", ...init.headers },
  });
}

/**
 * Injectable `fetch` that records what the SDK sent. `responders` is consumed in
 * order; the last one is reused once the queue is exhausted.
 */
export function recordFetch(responders: readonly Responder[]): FetchRecorder {
  const requests: RecordedRequest[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);
    const recorded: RecordedRequest = {
      url: rawUrl,
      path: url.pathname,
      search: url.search,
      method: init?.method ?? "GET",
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      rawBody: typeof init?.body === "string" ? init.body : undefined,
    };
    requests.push(recorded);
    const index = requests.length - 1;
    const responder = responders[Math.min(index, responders.length - 1)];
    if (responder === undefined) {
      throw new Error("recordFetch: no responder configured");
    }
    return await responder(recorded, index);
  };
  return { fetch, requests };
}

/** Always answers the same payload. */
export function alwaysJson(body: unknown, init: ResponseInit = {}): FetchRecorder {
  return recordFetch([() => jsonResponse(body, init)]);
}

/** Indexed access that fails loudly instead of returning `undefined`. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an item at index ${index}, got ${items.length} item(s)`);
  }
  return item;
}

export function parseBody(request: RecordedRequest): unknown {
  if (request.rawBody === undefined) {
    return undefined;
  }
  return JSON.parse(request.rawBody) as unknown;
}

export const TEST_API_KEY = "nbq_live_test_key_do_not_use";
export const TEST_BASE_URL = "https://api.example.test";

/** The closed `ErrorCode` catalogue declared by the contract. */
export function contractErrorCodes(): readonly string[] {
  const codes = dig(document, ["components", "schemas", "ErrorCode", "enum"]);
  if (!Array.isArray(codes)) {
    throw new Error("OpenAPI snapshot: ErrorCode.enum is not an array");
  }
  return codes.map((code) => {
    if (typeof code !== "string") {
      throw new Error("OpenAPI snapshot: ErrorCode.enum holds a non-string");
    }
    return code;
  });
}
