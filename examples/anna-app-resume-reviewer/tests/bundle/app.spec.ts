import { describe, it, expect, beforeEach } from "vitest";
import { mountBundle, HostApiError } from "@anna-ai/cli/test";
import manifest from "../../manifest.json" with { type: "json" };

const TOOL_ID = "bundled";

function defaultMocks() {
  const storage = new Map<string, unknown>();
  return {
    "tools.invoke": ({ tool_id, method, args }: any) => {
      expect(tool_id).toBe(TOOL_ID);
      expect(method).toBe("analyze_resume");
      expect(args.resume_text || args.file_b64).toBeTruthy();
      return {
        success: true,
        tool: "analyze_resume",
        data: {
          analysis: {
            ats_score: 78,
            used_llm: false,
            summary: "Frontend engineer intern match is workable after keyword edits.",
            source_note: "test fixture",
            missing_keywords: ["react", "testing"],
            problems: [
              {
                title: "Impact is not quantified",
                detail: "Add numbers to project bullets.",
                severity: "high",
              },
            ],
            perspectives: {
              recruiter: {
                verdict: "Readable but needs sharper first-pass evidence.",
                findings: ["Move the strongest project higher."],
                priorities: ["Tighten summary"],
              },
              ats: {
                verdict: "Keyword match needs role terms.",
                findings: ["Missing keyword: react"],
                priorities: ["Add truthful target terms"],
              },
              engineer: {
                verdict: "Technical bullets need implementation detail.",
                findings: ["Name stack and tradeoffs."],
                priorities: ["Rewrite project bullets"],
              },
            },
            suggestions: [
              {
                id: "s1",
                section: "Summary",
                title: "State target fit",
                reason: "Recruiters scan the top third.",
                rewrite: "Frontend engineer intern with React project evidence.",
                impact: "recruiter",
              },
            ],
            improved_resume: "Improved resume draft",
          },
        },
      };
    },
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

  it("invokes the bundled resume-reviewer tool with review args", async () => {
    const res = await harness.runtime.tools.invoke({
      tool_id: TOOL_ID,
      method: "analyze_resume",
      args: {
        resume_text: "Built a student portal with JavaScript and SQL.",
        target_role: "Frontend engineer intern",
        perspectives: ["recruiter", "ats", "engineer"],
      },
    });
    expect((res as any).success).toBe(true);
    expect(harness.calls.lastOf("tools.invoke")?.outcome).toBe("ok");
  });

  it("allows storage writes for version history", async () => {
    const res = await harness.runtime.storage.set({
      key: "resume-reviewer:v1",
      value: { versions: [{ id: "v1", text: "draft" }] },
    });
    expect(res).toMatchObject({ ok: true });
    expect(harness.calls.lastOf("storage.set")?.outcome).toBe("ok");
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
