import { CashbackError } from "./errors.js";

export type RedirectSource =
  | "activity-intent"
  | "app-webview"
  | "chrome";

export interface DocumentRequestEvent {
  requestId: string;
  url: string;
  timestamp: number;
  wallTime: number;
  source: RedirectSource;
  redirectFrom?: {
    url: string;
    statusCode: number;
  };
}

export interface RedirectHop {
  sequence: number;
  url: string;
  statusCode?: number;
  source: RedirectSource;
  timestamp: string;
}

function appendUnique(
  output: RedirectHop[],
  event: DocumentRequestEvent,
): void {
  const last = output.at(-1);
  if (last?.url === event.url) {
    return;
  }
  output.push({
    sequence: output.length + 1,
    url: event.url,
    source: event.source,
    timestamp: new Date(event.wallTime * 1_000).toISOString(),
  });
}

export function buildRedirectChain(
  events: DocumentRequestEvent[],
): RedirectHop[] {
  const output: RedirectHop[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    const eventKey = [
      event.requestId,
      event.url,
      event.wallTime,
      event.redirectFrom?.url ?? "",
    ].join("\n");
    if (seen.has(eventKey)) {
      continue;
    }
    seen.add(eventKey);

    if (event.redirectFrom) {
      const last = output.at(-1);
      if (last && last.url !== event.redirectFrom.url) {
        throw new CashbackError(
          "REDIRECT_CHAIN_INCOMPLETE",
          "capture",
          `redirect continuity mismatch: ${last.url} -> ${event.redirectFrom.url}`,
        );
      }
      if (!last) {
        output.push({
          sequence: 1,
          url: event.redirectFrom.url,
          statusCode: event.redirectFrom.statusCode,
          source: event.source,
          timestamp: new Date(event.wallTime * 1_000).toISOString(),
        });
      } else {
        last.statusCode = event.redirectFrom.statusCode;
      }
    }
    appendUnique(output, event);
  }

  return output;
}
