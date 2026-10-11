import { beforeEach, describe, expect, it } from "vitest";
import { CachedTemplateRepository, render, TemplateParamError, type Template } from "../src/notifications/templates.js";
import { InMemoryCache, InMemoryTemplateRepository } from "./fakes.js";

describe("render", () => {
  it("fills placeholders, with or without spaces inside the braces", () => {
    expect(render("Hi {{name}}, order {{ order_id }} shipped", { name: "Ana", order_id: 1001 })).toBe(
      "Hi Ana, order 1001 shipped",
    );
  });

  it("fills a placeholder that appears several times", () => {
    expect(render("{{a}}-{{a}}-{{b}}", { a: "x", b: true })).toBe("x-x-true");
  });

  it("refuses to render with a missing parameter and names all of them", () => {
    expect(() => render("Hi {{name}}, order {{order_id}} on {{eta}}", { name: "Ana" })).toThrow(TemplateParamError);
    expect(() => render("Hi {{name}}, order {{order_id}} on {{eta}}", { name: "Ana" })).toThrow(/order_id, eta/);
  });

  it("ignores parameters the template does not use", () => {
    expect(render("Hello", { unused: "x" })).toBe("Hello");
  });

  it("does not expand placeholders that appear inside a parameter value", () => {
    expect(render("Hi {{name}}", { name: "{{secret}}", secret: "S3CRET" })).toBe("Hi {{secret}}");
  });

  it("inserts a value literally, including characters that are special in String.replace", () => {
    expect(render("Pay {{amount}}", { amount: "$& $1 $$" })).toBe("Pay $& $1 $$");
  });

  it("does not look up inherited properties as parameters", () => {
    expect(() => render("{{constructor}}", {})).toThrow(TemplateParamError);
  });

  it("leaves text that is not a well-formed placeholder alone", () => {
    expect(render("{{ }} {single} {{a b}} {{", {})).toBe("{{ }} {single} {{a b}} {{");
  });
});

describe("CachedTemplateRepository", () => {
  const welcome: Template = { name: "welcome", channel: "email", subject: "Hi {{name}}", body: "Welcome {{name}}" };
  let db: InMemoryTemplateRepository;
  let cache: InMemoryCache;
  let repo: CachedTemplateRepository;

  beforeEach(async () => {
    db = new InMemoryTemplateRepository();
    cache = new InMemoryCache();
    repo = new CachedTemplateRepository(db, cache, 300);
    await db.upsert(welcome);
    db.finds = 0;
  });

  it("reads the database on a miss, then serves from the cache", async () => {
    expect(await repo.find("welcome", "email")).toEqual(welcome);
    expect(await repo.find("welcome", "email")).toEqual(welcome);
    expect(await repo.find("welcome", "email")).toEqual(welcome);
    expect(db.finds).toBe(1);
  });

  it("caches with a time limit", async () => {
    await repo.find("welcome", "email");
    expect(cache.entries.get("template:welcome:email")?.ttlSeconds).toBe(300);
  });

  it("keeps each channel's version separate", async () => {
    await db.upsert({ name: "welcome", channel: "sms", body: "Hi" });
    expect((await repo.find("welcome", "sms"))?.body).toBe("Hi");
    expect((await repo.find("welcome", "email"))?.body).toBe("Welcome {{name}}");
  });

  it("does not cache a template that does not exist, so one created later is seen at once", async () => {
    expect(await repo.find("later", "email")).toBeNull();
    await db.upsert({ name: "later", channel: "email", body: "now it exists" });
    expect((await repo.find("later", "email"))?.body).toBe("now it exists");
  });

  it("an update replaces the cached copy: the next read sees the new version", async () => {
    await repo.find("welcome", "email"); // now cached
    await repo.upsert({ ...welcome, body: "Edited {{name}}" });
    expect((await repo.find("welcome", "email"))?.body).toBe("Edited {{name}}");
  });

  it("treats a corrupt cache entry as a miss", async () => {
    await cache.set("template:welcome:email", "{not json", 300);
    expect(await repo.find("welcome", "email")).toEqual(welcome);
  });
});
