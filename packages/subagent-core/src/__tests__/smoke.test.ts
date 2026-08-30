import { describe, expect, it } from "vitest";

import { CORE_PACKAGE_VERSION } from "../index";

describe("subagent-core scaffold smoke", () => {
  it("exposes CORE_PACKAGE_VERSION", () => {
    expect(CORE_PACKAGE_VERSION).toBe("0.1.0");
  });
});
