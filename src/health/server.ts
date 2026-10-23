import type { Logger } from "../utils/logger.ts";

export interface HealthState {
  startedAt: number;
  sessions: number;
  updates: number;
  lastUpdateAt: number | null;
}

export type HealthProbe = () => HealthState;

export interface HealthServer {
  port: number;
  stop(): void;
}

/** Loopback-only liveness endpoint used by systemd/timers and operators. */
export function startHealthServer(
  host: string,
  port: number,
  probe: HealthProbe,
  log: Logger,
): HealthServer | null {
  if (port === 0) return null;
  const server = Bun.serve({
    hostname: host,
    port,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/health" && url.pathname !== "/ready") {
        return new Response("not found", { status: 404 });
      }
      const state = probe();
      return Response.json({
        ok: true,
        uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
        sessions: state.sessions,
        updates: state.updates,
        lastUpdateAt: state.lastUpdateAt === null ? null : new Date(state.lastUpdateAt).toISOString(),
      });
    },
  });
  const boundPort = server.port ?? port;
  log.info("health_started", { host, port: boundPort });
  return {
    port: boundPort,
    stop: () => server.stop(true),
  };
}
