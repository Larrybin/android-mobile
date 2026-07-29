import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import {
  CashbackError,
  type CashbackStage,
} from "../core/errors.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_STDOUT_LIMIT = 1024 * 1024;
const DEFAULT_STDERR_LIMIT = 8 * 1024;

export interface CommandOptions {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  stage?: CashbackStage;
  secrets?: string[];
}

export interface ManagedCommand {
  readonly child: ChildProcess;
  errorOutput(): string;
  wait(): Promise<number | null>;
  stop(timeoutMs?: number): Promise<void>;
}

export function redactSecrets(message: string, secrets: string[] = []): string {
  let redacted = message.replace(
    /([?&]api_key=)[^&\s]+/gi,
    "$1[REDACTED]",
  );
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function appendBounded(
  current: Buffer,
  chunk: Buffer,
  limit: number,
): Buffer {
  const nextSize = current.length + chunk.length;
  if (nextSize > limit) {
    throw new CashbackError(
      "COMMAND_OUTPUT_LIMIT",
      "runtime",
      `command output exceeded ${limit} bytes`,
    );
  }
  return Buffer.concat([current, chunk], nextSize);
}

function displayCommand(command: string): string {
  return command.split("/").at(-1) || command;
}

async function execute(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<Buffer> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxStdoutBytes = DEFAULT_STDOUT_LIMIT,
    maxStderrBytes = DEFAULT_STDERR_LIMIT,
    signal,
    env,
    stage = "runtime",
    secrets = [],
  } = options;

  if (signal?.aborted) {
    throw new CashbackError("INTERRUPTED", stage, "command cancelled");
  }

  return await new Promise<Buffer>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (error?: CashbackError) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (error) {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        rejectPromise(error);
      } else {
        resolvePromise(stdout);
      }
    };

    const failOutputLimit = (stream: "stdout" | "stderr", limit: number) => {
      finish(
        new CashbackError(
          "COMMAND_OUTPUT_LIMIT",
          stage,
          `${displayCommand(command)} ${stream} exceeded ${limit} bytes`,
        ),
      );
    };

    const cancel = () => {
      finish(new CashbackError("INTERRUPTED", stage, "command cancelled"));
    };

    const timer = setTimeout(() => {
      finish(
        new CashbackError(
          "COMMAND_TIMEOUT",
          stage,
          `${displayCommand(command)} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        stdout = appendBounded(stdout, chunk, maxStdoutBytes);
      } catch {
        failOutputLimit("stdout", maxStdoutBytes);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      try {
        stderr = appendBounded(stderr, chunk, maxStderrBytes);
      } catch {
        failOutputLimit("stderr", maxStderrBytes);
      }
    });
    child.once("error", (error) => {
      finish(
        new CashbackError(
          "COMMAND_FAILED",
          stage,
          redactSecrets(
            `${displayCommand(command)} failed: ${error.message}`,
            secrets,
          ),
          { cause: error },
        ),
      );
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.toString("utf8").trim() || "unknown error";
      finish(
        new CashbackError(
          "COMMAND_FAILED",
          stage,
          redactSecrets(
            `${displayCommand(command)} failed with exit ${code}: ${detail}`,
            secrets,
          ),
        ),
      );
    });
  });
}

export async function runCommandBuffer(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<Buffer> {
  return execute(command, args, options);
}

export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<string> {
  return (await execute(command, args, options)).toString("utf8").trim();
}

export function startManagedCommand(
  command: string,
  args: string[],
  options: Pick<CommandOptions, "env" | "maxStderrBytes" | "secrets" | "stage"> = {},
): ManagedCommand {
  const {
    env,
    maxStderrBytes = DEFAULT_STDERR_LIMIT,
    secrets = [],
    stage = "runtime",
  } = options;
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr: Buffer = Buffer.alloc(0);
  child.stderr?.on("data", (chunk: Buffer) => {
    const combined = Buffer.concat([stderr, chunk]);
    stderr = combined.subarray(Math.max(0, combined.length - maxStderrBytes));
  });
  child.once("error", (error) => {
    const message = redactSecrets(error.message, secrets);
    stderr = Buffer.from(message).subarray(-maxStderrBytes);
  });

  const wait = async (): Promise<number | null> => {
    if (child.exitCode !== null) {
      return child.exitCode;
    }
    return await new Promise((resolvePromise) => {
      child.once("close", (code) => resolvePromise(code));
      child.once("error", () => resolvePromise(child.exitCode));
    });
  };

  return {
    child,
    errorOutput: () => redactSecrets(stderr.toString("utf8").trim(), secrets),
    wait,
    stop: async (timeoutMs = 5_000) => {
      if (child.exitCode !== null) {
        return;
      }
      child.kill("SIGTERM");
      await Promise.race([wait(), delay(timeoutMs)]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await wait();
      }
      if (child.exitCode === null) {
        throw new CashbackError(
          "COMMAND_STOP_FAILED",
          stage,
          `${displayCommand(command)} did not stop`,
        );
      }
    },
  };
}
