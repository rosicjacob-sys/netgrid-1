import { describe, it, expect } from "vitest";
import { countryFromDomain } from "./keyword-locale";

describe("countryFromDomain", () => {
  it("maps unambiguous ccTLDs", () => {
    expect(countryFromDomain("pizzeriacrosta.ca")).toBe("ca");
    expect(countryFromDomain("example.fr")).toBe("fr");
    expect(countryFromDomain("example.co.uk")).toBe("gb");
  });

  it("returns null for generic TLDs so an explicit country_code can win", () => {
    expect(countryFromDomain("example.com")).toBeNull();
    expect(countryFromDomain("example.io")).toBeNull();
  });

  it("tolerates schemes, paths and ports", () => {
    expect(countryFromDomain("https://shop.example.ca/blog")).toBe("ca");
    expect(countryFromDomain("example.ca:3000")).toBe("ca");
    expect(countryFromDomain("  EXAMPLE.CA  ")).toBe("ca");
  });

  it("does not throw on junk", () => {
    expect(countryFromDomain("")).toBeNull();
    expect(countryFromDomain("localhost")).toBeNull();
  });
});
