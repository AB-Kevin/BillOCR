import type { Claim } from '../model/claim.js';

/**
 * A ClaimSource turns raw bytes/text of one file into one or more normalized
 * Claims. The JSON feed yields exactly one claim per file; the X12 837 reader
 * (added in a later milestone) yields many. The rest of the app only ever sees
 * Claim objects, so sources are interchangeable.
 */
export interface ClaimSource {
  readonly kind: 'json' | 'x12';
  /** True if this source recognizes the given text (cheap sniff, no full parse). */
  canParse(text: string): boolean;
  /** Parse into claims. Throws ClaimParseError on unrecoverable input. */
  parse(text: string): Claim[];
}

export class ClaimParseError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ClaimParseError';
  }
}
