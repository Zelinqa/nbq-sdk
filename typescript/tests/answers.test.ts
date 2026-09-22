import { describe, expect, it } from "vitest";
import { answerTurn, type PendingDecisionView, ZelinqaClient } from "../src/index.js";
import { sharedExample } from "./helpers.js";

const pending: PendingDecisionView = {
  decision_id: "decision-hidden",
  candidates: [
    {
      rank: 1,
      question_id: "question-hidden",
      text: "Channels?",
      type: "semi_open",
      selection_mode: "multiple",
      target_ids: [],
      choices: [
        { choice_id: "a", label: "Email" },
        { choice_id: "b", label: "Phone" },
      ],
    },
  ],
};

describe("business answers", () => {
  it("maps exact labels, multi + other, and pending decision", () => {
    expect(
      answerTurn(pending, { choiceLabels: ["Email", "Phone"], freeText: "Mail" }),
    ).toMatchObject({
      decision_id: "decision-hidden",
      question_id: "question-hidden",
      structured_answer: { choice_ids: ["a", "b"], free_text: "Mail" },
    });
  });
  it.each([
    { choiceLabels: ["Unknown"] },
    { choiceLabels: ["Email", "Email"] },
    { candidateRank: 9, userText: "Hello" },
    {},
    { userText: "" },
    { choiceLabels: [] },
    { freeText: "Other" },
  ])("rejects invalid business input", (input) => {
    expect(() => answerTurn(pending, input)).toThrow();
  });
  it("rejects missing pending, single-mode multi-selection and ambiguous labels", () => {
    expect(() => answerTurn(null, { userText: "Hi" })).toThrow();
    const p = structuredClone(pending);
    if (!p.candidates[0]) throw new Error("fixture");
    p.candidates[0].selection_mode = "single";
    expect(() => answerTurn(p, { choiceLabels: ["Email", "Phone"] })).toThrow();
    p.candidates[0].choices.push({ choice_id: "c", label: "Email" });
    expect(() => answerTurn(p, { choiceLabels: ["Email"] })).toThrow();
  });
  it("adds no HTTP roundtrip and infers no success from free text", async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new ZelinqaClient({
      apiKey: "test",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json(
          sharedExample(bodies.length === 1 ? "SessionNeuve" : "DecisionNormale"),
        );
      },
    });
    const session = await client.startSession();
    const decision = await session.next();
    await session.answer({ userText: "I am considering it" });
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toMatchObject({
      state_version: decision.versions.state_version,
      previous_turn: { decision_id: decision.decision_id, user_text: "I am considering it" },
    });
    expect(bodies[2]?.previous_turn).not.toHaveProperty("outcome");
  });
});
