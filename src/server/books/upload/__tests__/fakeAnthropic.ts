// src/server/books/upload/__tests__/fakeAnthropic.ts
//
// A scripted stand-in for the Anthropic client at the client boundary (the
// shape of src/app/api/ai/__tests__/generate-page.route.test.ts): each call of
// `beta.messages.stream` takes the next scripted turn and records the request.
// No network. Not a test file itself.

import type Anthropic from '@anthropic-ai/sdk';

export type Turn =
  | { content: unknown[]; stop_reason: string; stop_details?: unknown; inputJson?: string[]; wait?: Promise<void> }
  | { throws: unknown };

export interface FakeAnthropic {
  client: Anthropic;
  calls: Array<{ params: Record<string, unknown>; options: unknown }>;
  turns: Turn[];
}

/** A tool_use turn recording `input` with the record tool (the raw fragments are the input as JSON). */
export function toolTurn(input: unknown, name = 'record_invoice'): Turn {
  return {
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'tool_use', id: `toolu_${Math.random().toString(36).slice(2, 10)}`, name, input },
    ],
    stop_reason: 'tool_use',
    inputJson: [JSON.stringify(input)],
  };
}

export function fakeAnthropic(turns: Turn[] = []): FakeAnthropic {
  const state: FakeAnthropic = { client: undefined as unknown as Anthropic, calls: [], turns };
  const stream = (params: Record<string, unknown>, options: unknown) => {
    state.calls.push({ params: { ...params, messages: structuredClone(params.messages) }, options });
    const turn = state.turns[state.calls.length - 1] ?? { content: [], stop_reason: 'end_turn' };
    const handlers: Record<string, (chunk: string) => void> = {};
    const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
    return {
      on(event: string, cb: (chunk: string) => void) {
        handlers[event] = cb;
        return this;
      },
      get currentMessage() {
        return undefined;
      },
      finalMessage: async () => {
        if ('throws' in turn) throw turn.throws;
        if (turn.wait) {
          await Promise.race([
            turn.wait,
            new Promise((_, reject) => {
              const abort = () => reject(Object.assign(new Error('aborted'), { name: 'APIUserAbortError' }));
              if (signal?.aborted) abort();
              signal?.addEventListener('abort', abort);
            }),
          ]);
        }
        for (const chunk of turn.inputJson ?? []) handlers.inputJson?.(chunk);
        return {
          content: turn.content,
          stop_reason: turn.stop_reason,
          stop_details: turn.stop_details ?? null,
          usage: { input_tokens: 1200, output_tokens: 300 },
        };
      },
    };
  };
  state.client = { beta: { messages: { stream } } } as unknown as Anthropic;
  return state;
}

/**
 * A complete synthetic tool input in the wire format the API returns for the
 * strict tool: text that is not printed is an empty string, numbers null.
 */
export function toolInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: '17',
    issueDate: '2022-05-03',
    serviceDate: '',
    servicePeriod: '01.04.2022 - 30.04.2022',
    recipient: {
      name: 'Example Client GmbH',
      addressLines: ['Beispielweg 2', '20095 Hamburg'],
      country: '',
      countryInferred: 'DE',
      customerNumber: '1003',
    },
    recipientVatId: '',
    sender: { name: 'Sample Studio', addressLines: ['Musterstrasse 1', '10115 Berlin'], country: '', taxNumber: '12/345/67890', vatId: '' },
    lines: [
      { description: 'Design work', quantity: 10, unit: 'h', unitPrice: 80, discount: '', lineTotal: 800, taxRate: null, taxAmount: null },
      { description: 'Rabatt 10 %', quantity: null, unit: '', unitPrice: null, discount: '10 %', lineTotal: -80, taxRate: null, taxAmount: null },
    ],
    total: 720,
    currency: 'EUR',
    taxTreatment: 'small_business',
    taxAmounts: [],
    pricesIncludeVat: false,
    taxNote: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
    paymentTerms: 'zahlbar innerhalb von 14 Tagen',
    uncertainFields: [{ path: 'recipient.name', confidence: 'medium' }],
    ...overrides,
  };
}

/** A synthetic PDF (header, label, trailer). */
export function pdfBytes(label: string): Uint8Array {
  return new Uint8Array(Buffer.from(`%PDF-1.4\n% synthetic past invoice ${label}\n%%EOF\n`, 'latin1'));
}
