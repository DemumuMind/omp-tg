import type { Logger } from "./logger.ts";

export interface Watchdog {
  ready(): void;
  stop(): void;
}

function notify(bin: string, args: string[], log: Logger): void {
  try {
    const proc = Bun.spawn([bin, ...args], { stdout: "ignore", stderr: "ignore" });
    void proc.exited.then((code) => {
      if (code !== 0) log.debug("watchdog_notify_failed", { code });
    });
  } catch (error) {
    log.debug("watchdog_notify_failed", { message: error instanceof Error ? error.message : String(error) });
  }
}

/** sd_notify integration for Type=notify + WatchdogSec. No-op outside systemd. */
export function createWatchdog(log: Logger): Watchdog {
  const socket = process.env.NOTIFY_SOCKET;
  const bin = Bun.which("systemd-notify");
  if (!socket || !bin) {
    return { ready: () => undefined, stop: () => undefined };
  }
  const usec = Number(process.env.WATCHDOG_USEC ?? "0");
  const interval = Number.isFinite(usec) && usec > 0 ? Math.max(1000, Math.floor(usec / 3000)) : 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  return {
    ready() {
      notify(bin, ["--ready", "--status=omp-tg polling Telegram"], log);
      if (interval > 0 && timer === null) {
        timer = setInterval(() => {
          if (!stopped) notify(bin, ["WATCHDOG=1"], log);
        }, interval);
        timer.unref?.();
      }
    },
    stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      notify(bin, ["--stopping"], log);
    },
  };
}
