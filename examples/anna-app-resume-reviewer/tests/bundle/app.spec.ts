import { describe, it, expect, beforeEach } from "vitest";
import { mountBundle, HostApiError } from "@anna-ai/cli/test";
import manifest from "../../manifest.json" with { type: "json" };

function defaultMocks() {
  const storage = new Map<string, unknown>();
  return {
    "storage.get": ({ key }: any) => ({ exists: storage.has(key), value: storage.get(key) }),
    "storage.set": ({ key, value }: any) => {
      storage.set(key, value);
      return { ok: true };
    },
    "chat.write_message": () => ({ ok: true }),
    "chat.append_artifact": () => ({ ok: true }),
    "window.set_title": () => ({ ok: true }),
  };
}

describe("resume-reviewer Anna bundle contract", () => {
  let harness: Awaited<ReturnType<typeof mountBundle>>;

  beforeEach(async () => {
    harness = await mountBundle({ manifest: manifest as any, mocks: defaultMocks() });
  });

  it("allows storage writes for version history", async () => {
    const res = await harness.runtime.storage.set({
      key: "resume-reviewer:v1",
      value: { versions: [{ id: "v1", text: "draft" }] },
    });
    expect(res).toMatchObject({ ok: true });
    expect(harness.calls.lastOf("storage.set")?.outcome).toBe("ok");
  });

  it("does not require or grant tools.invoke", async () => {
    await expect(
      harness.runtime.call("tools", "invoke", {
        tool_id: "bundled:resume-reviewer",
        method: "analyze_resume",
        args: { resume_text: "Built a student portal with JavaScript and SQL." },
      }),
    ).rejects.toBeInstanceOf(HostApiError);
    expect(harness.calls.last()?.outcome).toBe("denied");
  });

  it("blocks undeclared direct llm.complete access", async () => {
    await expect(
      harness.runtime.call("llm", "complete", {
        messages: [{ role: "user", content: { type: "text", text: "hi" } }],
      }),
    ).rejects.toBeInstanceOf(HostApiError);
    expect(harness.calls.last()?.outcome).toBe("denied");
  });
});
