import { fetchAuthSession } from "aws-amplify/auth";

const BASE_URL = import.meta.env.VITE_API_ENDPOINT;

/**
 * Get auth session, token, and email from the JWT payload.
 * Uses the ID token payload directly — no extra Cognito GetUser API call.
 */
export async function getAuth() {
  const session = await fetchAuthSession();
  const token = session.tokens.idToken;
  const email = token.payload.email;
  return { token, email, session };
}

/**
 * Build a URL with query parameters.
 */
function buildUrl(path, queryParams = {}) {
  const url = new URL(path, BASE_URL);
  Object.entries(queryParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

/**
 * Core fetch wrapper with auth, JSON serialization, and error checking.
 * Returns parsed JSON by default. Pass { raw: true } in options to get the raw Response.
 */
async function request(method, path, { queryParams, body, raw } = {}) {
  const { token } = await getAuth();
  const url = buildUrl(path, queryParams);

  const options = {
    method,
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
  };

  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (raw) {
    return response;
  }

  if (!response.ok) {
    const error = new Error(`API ${method} ${path} failed: ${response.statusText}`);
    error.status = response.status;
    error.response = response;
    throw error;
  }

  // Some endpoints return empty responses (204, etc.)
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

const apiClient = {
  get: (path, queryParams) => request("GET", path, { queryParams }),
  post: (path, queryParams, body) => request("POST", path, { queryParams, body }),
  put: (path, queryParams, body) => request("PUT", path, { queryParams, body }),
  delete: (path, queryParams) => request("DELETE", path, { queryParams }),

  /**
   * Returns the raw Response object for cases needing fine-grained control
   * (e.g., parallel calls, streaming, checking response.ok manually).
   */
  getRaw: (path, queryParams) => request("GET", path, { queryParams, raw: true }),
  postRaw: (path, queryParams, body) => request("POST", path, { queryParams, body, raw: true }),
  putRaw: (path, queryParams, body) => request("PUT", path, { queryParams, body, raw: true }),
  deleteRaw: (path, queryParams) => request("DELETE", path, { queryParams, raw: true }),

  /** Expose getAuth for cases that need the token/email directly. */
  getAuth,
};

export default apiClient;
