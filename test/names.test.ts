import { expect, test } from "bun:test";
import { workNames } from "../src/core/names.ts";
import type { WorkId } from "../src/core/types.ts";

const ids = (...list: string[]) => list as WorkId[];

test("a work's name in an address leaves its machine out, and a second machine's work of the same name gets a number", () => {
  const names = workNames(ids("studio~search-speed", "mini~search-speed", "mini~sync", "studio~billing"));
  expect([...names.nameOf].map(([id, name]) => [String(id), name])).toEqual([
    ["mini~search-speed", "search-speed"],
    ["studio~search-speed", "search-speed~2"],
    ["mini~sync", "sync"],
    ["studio~billing", "billing"],
  ]);
  expect(String(names.idOf.get("search-speed~2"))).toBe("studio~search-speed");
  expect(names.idOf.get("mini~sync")).toBeUndefined();
});

test("on a hub of one machine a work's name is its id", () => {
  const names = workNames(ids("search-speed", "sync"));
  expect([...names.nameOf].map(([id, name]) => [String(id), name])).toEqual([["search-speed", "search-speed"], ["sync", "sync"]]);
});
