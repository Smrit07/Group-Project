// ---------------------------------------------------------------------------
// Fetch wrapper for the REST API.
// ---------------------------------------------------------------------------
// The default base is '/api' — relative, not absolute. That matters: in the
// XAMPP deployment Apache serves this app and proxies /api to Node on the same
// origin, so a hard-coded http://localhost:4000 would break the moment the app
// is opened from a phone on the campus network (where "localhost" is the
// phone). Relative URLs follow whatever host the page was loaded from, which
// is always the right answer.
//
// VITE_API_BASE still overrides it, for the case where the API genuinely lives
// on another origin.
const API_BASE = import.meta.env.VITE_API_BASE || (import.meta.env.BASE_URL + 'api');

/** Thrown for any non-2xx response, carrying the status so callers can branch. */
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  /** 503 means a dependency is down, not that the user did anything wrong. */
  get isServiceUnavailable() {
    return this.status === 503;
  }

  get isAuthError() {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * @param {string} path e.g. '/menu'
 * @param {{ method?: string, body?: object, token?: string, timeoutMs?: number, signal?: AbortSignal }} options
 */
export async function apiRequest(path, { method = 'GET', body, token, timeoutMs = 30000, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  // Without a timeout, a request made while the laptop's wifi drops hangs
  // forever and the spinner never stops — which reads to a user as a crash.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new ApiError('The server took too long to respond. Please try again.', 0, null);
    }
    throw new ApiError('Could not reach the server. Check that the API is running.', 0, null);
  } finally {
    clearTimeout(timer);
  }

  // 204 and any empty body would make .json() throw, which would surface as a
  // confusing parse error rather than a successful no-content response.
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!response.ok) {
    throw new ApiError(data.message || `Request failed (${response.status})`, response.status, data);
  }
  return data;
}
