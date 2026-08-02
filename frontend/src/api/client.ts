import type { ApiErrorBody } from './types';

const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:5000/api';
const SERVER_ORIGIN = API_BASE_URL.replace(/\/api\/?$/, '');
const TOKEN_STORAGE_KEY = 'football_quiz_access_token';

/** Resolves a server-relative path (e.g. an uploaded image's `/uploads/...` URL) to an absolute URL. */
export function resolveMediaUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${SERVER_ORIGIN}${path}`;
}

export class ApiError extends Error {
  status: number;
  details?: Record<string, string[]>;
  reason?: string;

  constructor(message: string, status: number, details?: Record<string, string[]>, reason?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.reason = reason;
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  formData?: FormData;
  auth?: boolean;
}

/** Thin fetch wrapper: JSON in/out, auth header injection, and a typed ApiError on failure. */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, formData, auth = true } = options;

  const headers: Record<string, string> = {};
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let requestBody: BodyInit | undefined;
  if (formData) {
    requestBody = formData;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { method, headers, body: requestBody });
  } catch {
    // fetch() itself rejects (rather than resolving with a non-ok status) for
    // network-level failures - server unreachable, no connection, CORS block.
    // Status 0 marks that distinctly from a real HTTP response for any caller
    // that wants to tell the two apart.
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const errorBody = payload as ApiErrorBody | null;
    throw new ApiError(
      errorBody?.error ?? 'Request failed',
      response.status,
      errorBody?.details,
      errorBody?.reason,
    );
  }

  return payload as T;
}

/** Like `request`, but for endpoints that return a binary file instead of JSON. */
async function requestBlob(path: string, options: RequestOptions = {}): Promise<Blob> {
  const { method = 'GET', auth = true } = options;

  const headers: Record<string, string> = {};
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { method, headers });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
  }

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      errorBody?.error ?? 'Request failed',
      response.status,
      errorBody?.details,
      errorBody?.reason,
    );
  }

  return response.blob();
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.details) {
      const firstDetail = Object.values(error.details)[0]?.[0];
      if (firstDetail) return firstDetail;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body' | 'formData'>) =>
    request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PUT', body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body' | 'formData'>) =>
    request<T>(path, { ...options, method: 'DELETE' }),
  postForm: <T>(path: string, formData: FormData, options?: Omit<RequestOptions, 'method' | 'formData'>) =>
    request<T>(path, { ...options, method: 'POST', formData }),
  getBlob: (path: string, options?: Omit<RequestOptions, 'method' | 'body' | 'formData'>) =>
    requestBlob(path, { ...options, method: 'GET' }),
};
