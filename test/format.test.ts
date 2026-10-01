import { expect, test } from "bun:test";
import { contextHeader, defaultAutocompactAt, fmtK } from "../src/format";

test("fmtK compacts thousands and millions", () => {
  expect(fmtK(58000)).toBe("58k");
  expect(fmtK(999)).toBe("999");
  expect(fmtK(1_000_000)).toBe("1M");
  expect(fmtK(1_500_000)).toBe("1.5M");
});

test("contextHeader shows used / window (percent) and a 10-cell bar", () => {
  const h = contextHeader(58000, 200000);
  expect(h).toContain("58k / 200k (29%)");
  expect(h).toMatch(/[▰▱]{10}/);
});

test("contextHeader treats null usage as 0 when the window is known", () => {
  expect(contextHeader(null, 200000)).toContain("0 / 200k (0%)");
});

test("contextHeader without a window falls back to a token count, or empty", () => {
  expect(contextHeader(58000)).toContain("58k");
  expect(contextHeader(null)).toBe("");
});

test("defaultAutocompactAt is 80% of the window", () => {
  expect(defaultAutocompactAt(200000)).toBe(160000);
  expect(defaultAutocompactAt(undefined)).toBeUndefined();
});
