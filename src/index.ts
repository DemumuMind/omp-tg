#!/usr/bin/env bun
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { ConfigError, loadConfig, type Config } from "./config/env.ts";
import { createApp, installSignalHandlers } from "./telegram/bot.ts";
import { createLogger } from "./utils/logger.ts";

function fatal(event: string, message: string): never {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "error", event, message })}\n`);
  process.exit(1);
}

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  fatal("config_error", error instanceof ConfigError ? error.message : String(error));
}

if (process.argv.includes("--check")) {
  try {
    await access(config.OMP_BIN, constants.X_OK);
  } catch {
    fatal("check_failed", `OMP binary is not executable: ${config.OMP_BIN}`);
  }
  process.stdout.write(`${JSON.stringify({ level: "info", event: "check_ok", ompBin: config.OMP_BIN })}\n`);
  process.exit(0);
}

const log = createLogger(config.LOG_LEVEL);
const app = createApp(config);
installSignalHandlers(app);

process.on("unhandledRejection", (reason) => {
  log.error("unhandled_rejection", { message: reason instanceof Error ? reason.message : String(reason) });
  void app.shutdown("fatal", 1);
});
process.on("uncaughtException", (error) => {
  log.error("uncaught_exception", { message: error.message });
  void app.shutdown("fatal", 1);
});

try {
  await app.start();
} catch (error) {
  fatal("start_failed", error instanceof Error ? error.message : String(error));
}
