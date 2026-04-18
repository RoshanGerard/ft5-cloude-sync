import { describe, expect, it } from "vitest";
import { willNavigatePolicy } from "../navigation-policy";

describe("willNavigatePolicy", () => {
  it("denies an https url and requests shell.openExternal with the same url", () => {
    expect(willNavigatePolicy("https://example.com/x")).toEqual({
      action: "deny",
      openExternal: "https://example.com/x",
    });
  });

  it("denies an http url without handing it to the OS browser", () => {
    expect(willNavigatePolicy("http://example.com")).toEqual({
      action: "deny",
    });
  });

  it("denies a file:// url without handing it to the OS browser", () => {
    expect(willNavigatePolicy("file:///c:/x")).toEqual({ action: "deny" });
  });

  it("denies a javascript: url without handing it to the OS browser", () => {
    expect(willNavigatePolicy("javascript:alert(1)")).toEqual({
      action: "deny",
    });
  });

  it("denies an internal app:// url — app-scheme navigation is handled by the protocol handler, not will-navigate", () => {
    expect(willNavigatePolicy("app://renderer/index.html")).toEqual({
      action: "deny",
    });
  });

  it("denies a malformed url without throwing", () => {
    expect(willNavigatePolicy("not a url at all")).toEqual({ action: "deny" });
  });
});
