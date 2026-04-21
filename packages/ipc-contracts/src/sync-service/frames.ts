// Transport-level frame shapes for the `services/fs-sync` named-pipe IPC.
// See design.md D2: newline-delimited JSON, one bidirectional socket per
// client, `id` correlates Request with Response; Events are unsolicited
// and carry no `id`.

export interface ErrorShape {
  readonly tag: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface RequestFrame {
  readonly id: string;
  readonly kind: "request";
  readonly command: string;
  readonly params: unknown;
}

export type ResponseFrame =
  | {
      readonly id: string;
      readonly kind: "response";
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly id: string;
      readonly kind: "response";
      readonly ok: false;
      readonly error: ErrorShape;
    };

export interface EventFrame {
  readonly kind: "event";
  readonly name: string;
  readonly payload: unknown;
}

export type Frame = RequestFrame | ResponseFrame | EventFrame;
