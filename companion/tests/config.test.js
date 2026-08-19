import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "../src/config/index.js";

test("运行超时默认 30/60/30 分钟并限制在 1-240", () => {
  const defaults = normalizeConfig({});
  assert.equal(defaults.analysisTimeoutMinutes, 30);
  assert.equal(defaults.modifyTimeoutMinutes, 60);
  assert.equal(defaults.testTimeoutMinutes, 30);
  const custom = normalizeConfig({ analysisTimeoutMinutes: 45, modifyTimeoutMinutes: 90, testTimeoutMinutes: 20 });
  assert.equal(custom.analysisTimeoutMinutes, 45);
  assert.equal(custom.modifyTimeoutMinutes, 90);
  assert.equal(custom.testTimeoutMinutes, 20);
  assert.throws(() => normalizeConfig({ analysisTimeoutMinutes: 0 }), /1-240/);
  assert.throws(() => normalizeConfig({ modifyTimeoutMinutes: 241 }), /1-240/);
});
