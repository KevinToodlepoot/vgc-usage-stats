// Errors carry the CLI exit code from SPEC §6.1.

export class GeneratorError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

/** 2: bad arguments. */
export class UsageError extends GeneratorError {
  constructor(message: string) { super(message, 2); }
}

/** 3: the month or file does not exist at Smogon. */
export class NotFoundError extends GeneratorError {
  constructor(message: string) { super(message, 3); }
}

/** 4: a fetch failed after retries. */
export class FetchError extends GeneratorError {
  constructor(message: string) { super(message, 4); }
}

/** 5: a validation or invariant failure. */
export class ValidationError extends GeneratorError {
  constructor(message: string) { super(message, 5); }
}
