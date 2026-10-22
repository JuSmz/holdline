import type { Content, GenerateContentRequest, GenerateContentResponse, Part } from "../client";

/**
 * A scripted stand-in for Gemini's generateContent (GEMINI_MODE=mock, tests, the e2e run). It plays a
 * small receptionist: prices → times → booking → payment status, through the real tool handlers.
 * Like the real API (docs 2026-10-22) it signs every function call and answers 400 when a function
 * call of the current turn comes back without its thoughtSignature, so the round trip is tested.
 */

type Scripted = { text?: string; calls?: { name: string; args: Record<string, unknown> }[] };

const isUserText = (c: Content) =>
  c.role === "user" && c.parts.some((p) => typeof p.text === "string") && !c.parts.some((p) => p.functionResponse);

const lastUserText = (contents: Content[]) =>
  [...contents]
    .reverse()
    .find((c) => isUserText(c) && !String(c.parts[0]?.text ?? "").startsWith("[payment-update]"))
    ?.parts.map((p) => p.text ?? "")
    .join(" ") ?? "";

function responsesOf(contents: Content[]): { name: string; response: Record<string, unknown> }[] {
  return contents.flatMap((c) =>
    c.parts
      .filter((p) => p.functionResponse)
      .map((p) => p.functionResponse as { name: string; response: Record<string, unknown> }),
  );
}

function latest(contents: Content[], name: string) {
  return responsesOf(contents)
    .filter((r) => r.name === name)
    .at(-1)?.response;
}

function knownCustomer(system: string) {
  const match = /Known customer details: name ([^,]+), email ([^\s.]+@[^\s]+?)\.?(\s|$)/.exec(system);
  return { name: match?.[1] ?? "Sam", email: match?.[2] ?? "sam@personal.example.com" };
}

export class FakeGemini {
  readonly requests: GenerateContentRequest[] = [];
  private signatures = new Set<string>();
  private seq = 0;
  /** Scripted faults for tests: the next N requests fail with this status. */
  failNext: { status: number; count: number } | null = null;
  /** Tests: fail only the request with this 1-based number. */
  failRequest: { n: number; status: number } | null = null;
  /** Tests: the next request's prompt is blocked (promptFeedback.blockReason, no candidates). */
  blockNext = false;
  /** Tests: the model keeps calling get_services whenever it may. */
  loopTools = false;
  /** Tests: the next response makes these calls in parallel. */
  parallelNext: { name: string; args: Record<string, unknown> }[] | null = null;
  /** Tests: runs before each request is answered. */
  onRequest: ((body: GenerateContentRequest) => Promise<void>) | null = null;

  readonly fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as GenerateContentRequest;
    this.requests.push(body);
    await this.onRequest?.(body);
    if (this.failRequest?.n === this.requests.length) {
      return Response.json(
        { error: { code: this.failRequest.status, message: "scripted failure" } },
        { status: this.failRequest.status },
      );
    }
    if (this.blockNext) {
      this.blockNext = false;
      return Response.json({ promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 100 } });
    }
    if (this.failNext && this.failNext.count > 0) {
      this.failNext.count -= 1;
      return Response.json(
        { error: { code: this.failNext.status, message: "scripted failure" } },
        { status: this.failNext.status },
      );
    }
    const problem = this.validate(body.contents);
    if (problem)
      return Response.json({ error: { code: 400, message: problem, status: "INVALID_ARGUMENT" } }, { status: 400 });
    return Response.json(this.respond(body));
  };

  /** Only the current turn (after the last user text) is validated, as documented. */
  private validate(contents: Content[]): string | null {
    const last = contents.at(-1);
    if (!last || last.role !== "user") return "The last turn must be a user turn.";
    let start = contents.length - 1;
    while (start > 0 && !isUserText(contents[start])) start -= 1;
    for (const [i, content] of contents.slice(start).entries()) {
      if (content.role !== "model") continue;
      const calls = content.parts.filter((p) => p.functionCall);
      // Parallel calls: only the first carries the signature.
      if (calls.length > 0 && !this.signatures.has(String(calls[0].thoughtSignature))) {
        return `Function call ${calls[0].functionCall?.name} in the ${start + i + 1}. content block is missing a thought_signature.`;
      }
    }
    return null;
  }

  private respond(body: GenerateContentRequest): GenerateContentResponse {
    if ((body.generationConfig as { responseMimeType?: string } | undefined)?.responseMimeType === "application/json") {
      const transcript = body.contents.map((c) => c.parts.map((p) => p.text ?? "").join(" ")).join(" ");
      const summary = {
        headline: `Customer asked about: ${/drain/i.test(transcript) ? "a blocked drain" : "a repair"}`,
        problem: transcript
          .replace(/<\/?untrusted_transcript>/g, "")
          .trim()
          .slice(0, 120),
        outcome: /confirmed the/i.test(transcript) ? "booked_and_authorized" : "no_booking",
        follow_up: "",
      };
      return {
        candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(summary) }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 60, totalTokenCount: 860 },
      };
    }
    const system = body.systemInstruction?.parts.map((p) => p.text).join("\n") ?? "";
    const allowTools =
      (body.toolConfig as { functionCallingConfig?: { mode?: string } } | undefined)?.functionCallingConfig?.mode !==
      "NONE";
    const parallel = this.parallelNext;
    this.parallelNext = null;
    const step = parallel
      ? { calls: parallel }
      : this.loopTools
        ? { calls: [{ name: "get_services", args: {} }] }
        : this.script(body.contents, system);
    const parts: Part[] = [];
    if (allowTools && step.calls?.length) {
      for (const [i, call] of step.calls.entries()) {
        this.seq += 1;
        const part: Part = { functionCall: { id: `fc-${this.seq}`, name: call.name, args: call.args } };
        if (i === 0) {
          const signature = `sig-${this.seq}-${Math.random().toString(36).slice(2, 8)}`;
          this.signatures.add(signature);
          part.thoughtSignature = signature;
        }
        parts.push(part);
      }
    } else {
      parts.push({ text: step.text ?? "How can I help?" });
    }
    return {
      candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 1200,
        candidatesTokenCount: 40,
        thoughtsTokenCount: 20,
        totalTokenCount: 1260,
      },
      modelVersion: "fake-gemini",
    };
  }

  private script(contents: Content[], system: string): Scripted {
    const last = contents.at(-1)!;
    const said = lastUserText(contents).toLowerCase();
    const services = (latest(contents, "get_services")?.services ?? []) as {
      service_id: string;
      name: string;
      price: string;
    }[];
    const slots = (latest(contents, "check_availability")?.slots ?? []) as { slot_id: string; label: string }[];

    if (last.parts.some((p) => p.functionResponse)) {
      const response = last.parts.find((p) => p.functionResponse)!.functionResponse as {
        name: string;
        response: Record<string, unknown>;
      };
      switch (response.name) {
        case "get_services": {
          const pick = pickService(services, said);
          if (!pick) return { text: "We do plumbing and electrical work. What's going on?" };
          return {
            calls: [
              {
                name: "check_availability",
                args: { service_id: pick.service_id, preferred_date: "", time_of_day: "any" },
              },
            ],
          };
        }
        case "check_availability": {
          const pick = pickService(services, said);
          const labels = slots.map((s) => s.label).join(", ");
          return {
            text: pick
              ? `${pick.name} is ${pick.price}. The next times are ${labels}. Which one works for you?`
              : `The next times are ${labels}.`,
          };
        }
        case "create_booking_with_payment_link": {
          const r = response.response;
          if (r.ok !== true) return { text: String(r.say ?? "Let me check that again.") };
          return {
            text: `I've set that up. PayPal will place a ${String(r.hold_amount)} hold — it's not a charge; it's only charged after the job. ${String(r.cancellation_policy)} The PayPal button is on your screen.`,
          };
        }
        case "check_payment_status": {
          const r = response.response;
          return {
            text:
              r.status === "authorized"
                ? `Yes — PayPal confirmed the hold. See you ${String(r.appointment_label)}.`
                : "I don't see the approval yet — the PayPal button is still waiting on your screen.",
          };
        }
        default:
          return { text: "Okay." };
      }
    }

    if (/went through|payment|paid/.test(said) && latest(contents, "create_booking_with_payment_link")) {
      return { calls: [{ name: "check_payment_status", args: {} }] };
    }
    const chosen = slots.find((s) => said.includes(s.label.toLowerCase()));
    const pick = pickService(services, firstRequest(contents));
    if (chosen && pick) {
      const customer = knownCustomer(system);
      return {
        calls: [
          {
            name: "create_booking_with_payment_link",
            args: {
              service_id: pick.service_id,
              slot_id: chosen.slot_id,
              customer_name: customer.name,
              customer_email: customer.email,
              service_address: "100 Congress Ave, Austin",
              problem_summary: firstRequest(contents).slice(0, 200),
              urgency: "soon",
              // A model may try to send an amount; the handler ignores it.
              hold_amount: "$1.00",
            },
          },
        ],
      };
    }
    return {
      calls: [
        {
          name: "get_services",
          args: /outlet|switch|light|electric/.test(said) ? { category: "electrical" } : { category: "plumbing" },
        },
      ],
    };
  }
}

function firstRequest(contents: Content[]): string {
  return (
    contents
      .find(isUserText)
      ?.parts.map((p) => p.text ?? "")
      .join(" ") ?? ""
  );
}

function pickService(services: { service_id: string; name: string; price: string }[], said: string) {
  const text = said.toLowerCase();
  const byWord = services.find((s) =>
    s.name
      .toLowerCase()
      .split(" ")
      .some((w) => w.length > 3 && text.includes(w)),
  );
  return byWord ?? services[0];
}

let shared: FakeGemini | null = null;

/** The process-wide fake for GEMINI_MODE=mock. */
export function fakeGemini(): FakeGemini {
  return (shared ??= new FakeGemini());
}
