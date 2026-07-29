export type CashbackStage =
  | "config"
  | "proxy"
  | "device"
  | "app"
  | "ui"
  | "capture"
  | "artifact"
  | "cleanup"
  | "runtime";

interface CashbackErrorOptions {
  cause?: unknown;
  evidencePaths?: string[];
}

export class CashbackError extends Error {
  readonly code: string;
  readonly stage: CashbackStage;
  readonly evidencePaths: string[];

  constructor(
    code: string,
    stage: CashbackStage,
    message: string,
    options: CashbackErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CashbackError";
    this.code = code;
    this.stage = stage;
    this.evidencePaths = [...(options.evidencePaths ?? [])];
  }
}

export function toCashbackError(
  error: unknown,
  stage: CashbackStage,
): CashbackError {
  if (error instanceof CashbackError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new CashbackError("UNEXPECTED_ERROR", stage, message, { cause: error });
}
