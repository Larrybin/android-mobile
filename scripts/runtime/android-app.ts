import { CashbackError } from "../core/errors.js";
import {
  runCommand,
  type CommandOptions,
} from "./command.js";

type TextRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<string>;

export function parseLauncherActivity(
  output: string,
  packageName: string,
): string {
  const component = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${packageName}/`));
  if (!component || !/^[a-zA-Z0-9._]+\/[a-zA-Z0-9._]+$/.test(component)) {
    throw new CashbackError(
      "APP_LAUNCHER_NOT_FOUND",
      "app",
      `launcher activity was not resolved for ${packageName}`,
    );
  }
  return component;
}

export async function launchAndroidApp(
  serial: string,
  packageName: string,
  textRunner: TextRunner = runCommand,
  stage: "app" | "capture" = "app",
): Promise<void> {
  const prefix = ["-s", serial, "shell"];
  const resolved = await textRunner(
    "adb",
    [
      ...prefix,
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      "-a",
      "android.intent.action.MAIN",
      "-c",
      "android.intent.category.LAUNCHER",
      packageName,
    ],
    { stage },
  );
  const component = parseLauncherActivity(resolved, packageName);
  await textRunner(
    "adb",
    [...prefix, "am", "start", "-W", "-n", component],
    { stage },
  );
}
