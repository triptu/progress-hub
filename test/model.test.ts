import { expect, test } from "bun:test";
import { modelName } from "../src/web/lib/model.ts";

test("model ids read as people say them", () => {
  expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
  expect(modelName("claude-fable-5-2")).toBe("Fable 5.2");
  expect(modelName("claude-opus-4-6-20260101")).toBe("Opus 4.6");
  expect(modelName("gpt-6.1-sol")).toBe("GPT-6.1 Sol");
  expect(modelName("gpt-6-astra")).toBe("GPT-6 Astra");
  expect(modelName("grok-4.7")).toBe("Grok 4.7");
  expect(modelName("<synthetic>")).toBe("<synthetic>");
});
