import type {
  DocumentRequestEvent,
  RedirectSource,
} from "./redirect-core.js";

interface CdpDocumentRequest {
  requestId?: unknown;
  frameId?: unknown;
  type?: unknown;
  timestamp?: unknown;
  wallTime?: unknown;
  request?: {
    url?: unknown;
  };
  redirectResponse?: {
    url?: unknown;
    status?: unknown;
  };
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function parseDocumentRequest(
  input: CdpDocumentRequest,
  rootFrameId: string,
  source: Extract<RedirectSource, "chrome" | "app-webview">,
): DocumentRequestEvent | null {
  if (
    input.type !== "Document" ||
    input.frameId !== rootFrameId ||
    typeof input.requestId !== "string" ||
    typeof input.timestamp !== "number" ||
    typeof input.wallTime !== "number" ||
    !isHttpUrl(input.request?.url)
  ) {
    return null;
  }

  const redirectUrl = input.redirectResponse?.url;
  const redirectStatus = input.redirectResponse?.status;
  return {
    requestId: input.requestId,
    url: input.request.url,
    timestamp: input.timestamp,
    wallTime: input.wallTime,
    source,
    redirectFrom:
      isHttpUrl(redirectUrl) && typeof redirectStatus === "number"
        ? { url: redirectUrl, statusCode: redirectStatus }
        : undefined,
  };
}

export interface ActivitySnapshot {
  packageName: string | null;
  viewUrls: string[];
}

export function parseActivitySnapshot(output: string): ActivitySnapshot {
  const packageName =
    output.match(
      /mResumedActivity:\s+ActivityRecord\{[^\s]+\s+([a-zA-Z0-9._]+)\//,
    )?.[1] ?? null;
  const viewUrls = [
    ...new Set(
      [...output.matchAll(/\bdat=(https?:\/\/[^\s}\]]+)/g)].map(
        (match) => match[1]!,
      ),
    ),
  ];
  return { packageName, viewUrls };
}
