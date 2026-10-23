import { installSignalHandlers, makeShutdown } from "../../telegram/bot.ts";
import { createLogger } from "../../utils/logger.ts";

const log = createLogger("info");
const events: string[] = [];

const shutdown = makeShutdown({
  stopBot: async () => {
    events.push("bot.stop");
  },
  stopSessions: async () => {
    events.push("sessions.shutdown");
  },
  log,
  exit: (code) => {
    events.push(`exit ${code}`);
    process.stdout.write(`events:${events.join(",")}\n`);
    process.exit(code);
  },
});

installSignalHandlers({ shutdown });
process.stdout.write("ready\n");
process.stdin.resume();
