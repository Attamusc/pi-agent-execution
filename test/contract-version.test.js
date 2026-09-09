import assert from "node:assert/strict";
import test from "node:test";

import { contractVersion } from "../dist/index.js";

test("exports contract version 1", () => {
  assert.equal(contractVersion, 1);
});
