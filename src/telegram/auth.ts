import type { MiddlewareFn } from "grammy";
import type { Logger } from "../utils/logger.ts";

export function isAllowedUser(userId: number | undefined, allowed: Set<number>): boolean {
  return userId !== undefined && allowed.has(userId);
}

export function authMiddleware(allowed: Set<number>, log: Logger): MiddlewareFn {
  return async (ctx, next) => {
    if (!isAllowedUser(ctx.from?.id, allowed)) {
      log.debug("update_denied", { userId: ctx.from?.id });
      return;
    }
    await next();
  };
}
