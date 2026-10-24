export class OmpClosedError extends Error {
  constructor(message = "OMP process is closed") {
    super(message);
    this.name = "OmpClosedError";
  }
}

export class OmpResponseError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "OmpResponseError";
    this.code = code;
  }
}
