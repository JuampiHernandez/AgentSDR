import { describe, expect, test } from "bun:test";
import { fillTemplate, mergeTokens, parseMergeToken } from "./render";
import { campaignMergeFields, cleanFallback, mergeFieldToken } from "./mergeFields";

describe("merge field fallbacks", () => {
  test("parses a key and an optional fallback", () => {
    expect(parseMergeToken("firstName")).toEqual({ key: "firstName", fallback: null });
    expect(parseMergeToken(" firstName | there ")).toEqual({ key: "firstName", fallback: "there" });
    expect(parseMergeToken("firstName|")).toEqual({ key: "firstName", fallback: null });
    expect(parseMergeToken("company|your team | and you")).toEqual({ key: "company", fallback: "your team | and you" });
  });

  test("uses the value when there is one, the fallback when not", () => {
    expect(fillTemplate("Hi {{firstName|there}},", { firstName: "Asha" })).toBe("Hi Asha,");
    expect(fillTemplate("Hi {{firstName|there}},", {})).toBe("Hi there,");
    expect(fillTemplate("Hi {{firstName|there}},", { firstName: "   " })).toBe("Hi there,");
    expect(fillTemplate("Hi {{ FIRSTNAME | there }},", { firstName: "Asha" })).toBe("Hi Asha,");
  });

  test("without a fallback a missing field is still empty", () => {
    expect(fillTemplate("Hi {{firstName}},", {})).toBe("Hi ,");
  });

  test("a fallback is never read as spin text", () => {
    for (let i = 0; i < 20; i++) {
      expect(fillTemplate("Hi {{firstName|there}}", {})).toBe("Hi there");
      expect(fillTemplate("Hi {{firstName|there}}", { firstName: "Asha" })).toBe("Hi Asha");
    }
  });

  test("spin text still works beside merge fields, and may contain them", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) seen.add(fillTemplate("{Hi|Hello} {{firstName|there}}", { firstName: "Asha" }));
    expect([...seen].sort()).toEqual(["Hello Asha", "Hi Asha"]);
    const inner = new Set<string>();
    for (let i = 0; i < 60; i++) inner.add(fillTemplate("{Hi {{firstName|there}}|Hello}", {}));
    expect([...inner].sort()).toEqual(["Hello", "Hi there"]);
  });

  test("lead data containing braces or bars is not spun", () => {
    expect(fillTemplate("At {{company}}", { company: "{A|B} Labs" })).toBe("At {A|B} Labs");
  });

  test("the signature token is left for applySignature", () => {
    expect(fillTemplate("{{SIGNATURE}}", {})).toBe("{{SIGNATURE}}");
  });

  test("lists every token a template uses", () => {
    expect(mergeTokens("Hi {{firstName|there}} at {{company}}")).toEqual([
      { key: "firstName", fallback: "there" },
      { key: "company", fallback: null },
    ]);
  });

  test("builds the token to insert, cleaning the fallback", () => {
    expect(mergeFieldToken("firstName", "there")).toBe("{{firstName|there}}");
    expect(mergeFieldToken("firstName", "  ")).toBe("{{firstName}}");
    expect(cleanFallback("a}b{c\nd")).toBe("a b c d");
  });
});

describe("campaign merge fields", () => {
  test("standard fields are offered even when no lead has them", () => {
    const fields = campaignMergeFields([{ email: "a@x.com", productName: "Rocket" }]);
    expect(fields.slice(0, 7).map((f) => f.token)).toEqual([
      "firstName",
      "lastName",
      "fullName",
      "company",
      "title",
      "email",
      "companyDomain",
    ]);
    expect(fields.find((f) => f.token === "firstName")?.missing).toBe(1);
    expect(fields.find((f) => f.token === "email")?.missing).toBe(0);
    expect(fields.at(-1)).toEqual({ token: "productName", label: "Product name", missing: 0 });
  });

  test("counts the leads missing each field and skips aliases", () => {
    const fields = campaignMergeFields([
      { firstName: "Asha", name: "Asha K", jobTitle: "CEO", title: "CEO", source: "PH" },
      { firstName: "", source: "  " },
      { source: "HN" },
    ]);
    expect(fields.find((f) => f.token === "firstName")?.missing).toBe(2);
    expect(fields.find((f) => f.token === "source")?.missing).toBe(1);
    expect(fields.map((f) => f.token)).not.toContain("name");
    expect(fields.map((f) => f.token)).not.toContain("jobTitle");
  });

  test("with no leads, only the standard fields", () => {
    expect(campaignMergeFields([]).map((f) => f.missing)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});
