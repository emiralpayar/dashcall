// API errors: every error response is JSON {error: <English message>, code: <snake_case>}.
export const httpError = (status, code, message) => Object.assign(new Error(message), { status, code, expose: true });

// Turn any thrown error into [status, body]. Errors we didn't create are reported as `internal`
// (message kept short and useful, e.g. a herdr error; never a stack trace).
export function errorBody(e) {
  if (e?.expose) return [e.status, { error: e.message, code: e.code }];
  return [500, { error: String(e?.message || 'Internal error').slice(0, 300), code: 'internal' }];
}
