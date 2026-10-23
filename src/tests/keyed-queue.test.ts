import { describe, expect, test } from "bun:test";
import { KeyedQueue } from "../utils/keyed-queue.ts";

describe("KeyedQueue", () => {
  test("serializes one key and runs different keys concurrently", async () => {
    const queue = new KeyedQueue();
    const events: string[] = [];

    const first = queue.push("a", async () => {
      events.push("a1-start");
      await Promise.resolve();
      events.push("a1-end");
    });
    const second = queue.push("a", async () => {
      events.push("a2");
    });
    const other = queue.push("b", async () => {
      events.push("b");
    });

    await Promise.all([first, second, other]);
    expect(events.filter((event) => event.startsWith("a"))).toEqual(["a1-start", "a1-end", "a2"]);
    expect(events).toContain("b");
  });

  test("continues after a rejected task", async () => {
    const queue = new KeyedQueue();
    const events: string[] = [];
    await queue.push("a", async () => {
      throw new Error("boom");
    }).catch(() => undefined);
    await queue.push("a", async () => {
      events.push("next");
    });
    expect(events).toEqual(["next"]);
  });
});
