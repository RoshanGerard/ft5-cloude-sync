import type { CredentialStore } from "@ft5/fs-datasource-engine";
import { describe, expectTypeOf, it } from "vitest";

import { ConfigFileCredentialStore } from "./config-file.js";

describe("ConfigFileCredentialStore conforms to CredentialStore", () => {
  it("is structurally assignable to CredentialStore", () => {
    expectTypeOf<ConfigFileCredentialStore>().toMatchTypeOf<CredentialStore>();
  });

  it("exposes the three required methods with correct signatures", () => {
    type Instance = InstanceType<typeof ConfigFileCredentialStore>;
    expectTypeOf<Instance["get"]>().parameter(0).toEqualTypeOf<string>();
    expectTypeOf<Instance["put"]>().parameter(0).toEqualTypeOf<string>();
    expectTypeOf<Instance["delete"]>().parameter(0).toEqualTypeOf<string>();
  });
});
