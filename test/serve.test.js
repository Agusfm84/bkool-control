import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { resolveSafePath } from "../serve.mjs";

const root = path.resolve("/app");

test("root URL serves index.html", () => {
  assert.equal(resolveSafePath(root, "/"), path.join(root, "index.html"));
});

test("a file inside the folder resolves inside the folder", () => {
  assert.equal(resolveSafePath(root, "/src/core/fec.js"), path.join(root, "src", "core", "fec.js"));
});

test("query strings are ignored", () => {
  assert.equal(resolveSafePath(root, "/spike.html?x=1"), path.join(root, "spike.html"));
});

test("paths escaping the folder are refused", () => {
  assert.equal(resolveSafePath(root, "/../secret.txt"), null);
  assert.equal(resolveSafePath(root, "/%2e%2e/secret.txt"), null);
});
