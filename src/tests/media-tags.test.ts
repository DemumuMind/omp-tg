import { describe, expect, test } from "bun:test";
import { extractMediaTags, stripMediaTags } from "../telegram/media-tags.ts";

describe("MEDIA tags", () => {
  test("extracts quoted and unquoted paths and removes their lines", () => {
    const result = extractMediaTags('Done\nMEDIA:./out/report.pdf\nMEDIA: "/tmp/shot.png"\n');
    expect(result.paths).toEqual(["./out/report.pdf", "/tmp/shot.png"]);
    expect(result.text).toBe("Done");
  });

  test("deduplicates repeated tags", () => {
    expect(extractMediaTags("MEDIA:/a.txt\nMEDIA:/a.txt").paths).toEqual(["/a.txt"]);
  });

  test("only matches tags that start a line", () => {
    expect(extractMediaTags("see MEDIA:/a.txt here").paths).toEqual([]);
    expect(stripMediaTags("see MEDIA:/a.txt here")).toBe("see MEDIA:/a.txt here");
  });

  test("collapses blank lines left behind", () => {
    expect(extractMediaTags("a\n\nMEDIA:/x\n\nb").text).toBe("a\n\nb");
  });
});
