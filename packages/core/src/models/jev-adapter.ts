// verify against https://api.typesafe.ai/openapi.json
//
// The ONLY place that knows the Jev wire format. Shapes come from research/apis.md §5
// (docs quickstart, paraphrased): request { model, state, questions: { <id>: { type, instructions, criteria } } },
// response { model, answers: { <id>: { type, choice, confidence, probabilities } }, usage: { input_tokens, output_tokens } }.
// Unconfirmed: the field that carries the list of options for a "choice" question (assumed `criteria`).
import { ProviderError } from "./errors";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_PROVIDER = "jev";

/** Id of the single question we ask per classify call. */
const QUESTION_ID = "label";

export interface JevChoiceRequestInput {
  model: string;
  text: string;
  labels: readonly string[];
  instructions?: string;
}

export function buildJevChoiceRequest(input: JevChoiceRequestInput): Record<string, unknown> {
  return {
    model: input.model,
    state: input.text,
    questions: {
      [QUESTION_ID]: {
        type: "choice",
        instructions: input.instructions ?? `Pick the best label for the text. Labels: ${input.labels.join(", ")}.`,
        criteria: [...input.labels], // verify: field name for choice options
      },
    },
  };
}

export interface JevChoiceAnswer {
  label: string;
  confidence: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bad(what: string): ProviderError {
  return new ProviderError(`Jev response: ${what}`, { provider: JEV_PROVIDER, retryable: false });
}

export function parseJevChoiceResponse(body: unknown, labels: readonly string[]): JevChoiceAnswer {
  if (!isRecord(body)) throw bad("not an object");
  const answers = body.answers;
  if (!isRecord(answers)) throw bad("missing answers");
  const answer = answers[QUESTION_ID];
  if (!isRecord(answer)) throw bad("missing answer");
  const choice = answer.choice;
  const confidence = answer.confidence;
  if (typeof choice !== "string" || !labels.includes(choice)) throw bad("choice is not one of the labels");
  if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) throw bad("confidence out of range");
  if (typeof body.model !== "string") throw bad("missing model");
  const usage = isRecord(body.usage) ? body.usage : {};
  return {
    label: choice,
    confidence,
    model: body.model,
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
  };
}
