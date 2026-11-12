import { expect, test } from "bun:test";
import { keepLooks, projectLook, projectLooks, readKeptLooks } from "../src/web/lib/project.ts";

test("the projects on screen each get their own icon, whatever their names hash to", () => {
  const keys = ["kestrel", "harbor", "lumen", "studio", "atlas-mobile", "home-lab", "refold", "nod-build", "w05-dark-mode", "w11-cache"];
  const look = projectLooks(keepLooks(keys, {}));
  expect(new Set(keys.map((key) => look(key).Icon)).size).toBe(keys.length);
  expect(look("HARBOR")).toEqual(look("harbor"));
  expect(look("not-on-screen")).toEqual(projectLook("not-on-screen"));
});

test("a project keeps its look when other projects come and go", () => {
  const first = keepLooks(["kestrel", "harbor"], {});
  const before = projectLooks(first);
  // A name that sorts ahead of both, as another machine's work would bring in, and one that sorts between them.
  const second = keepLooks(["atlas", "kestrel", "refold", "harbor"], first);
  const after = projectLooks(second);
  for (const name of ["kestrel", "harbor"]) expect(after(name)).toEqual(before(name));
  expect(new Set(["atlas", "kestrel", "refold", "harbor"].map((name) => after(name).colour)).size).toBe(4);
  // A project that left the screen comes back as it was.
  const third = keepLooks(["harbor", "lumen"], second);
  expect(projectLooks(third)("atlas")).toEqual(after("atlas"));
  // Nothing new: the same looks, untouched.
  expect(keepLooks(["harbor"], third)).toBe(third);
  expect(readKeptLooks(JSON.parse(JSON.stringify(third)))).toEqual(third);
  expect(readKeptLooks({ harbor: "green", lumen: [1], ok: [2, 3] })).toEqual({ ok: [2, 3] });
});
