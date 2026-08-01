import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, clearToken, getErrorMessage, getToken, resolveMediaUrl, setToken } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The wrapper always calls fetch(url, init) with both args, so this is safe. */
function lastFetchInit(): RequestInit {
  const [, init] = vi.mocked(fetch).mock.calls.at(-1)!;
  if (!init) throw new Error('fetch was called without an init object');
  return init;
}

function lastFetchHeaders(): Record<string, string> {
  return lastFetchInit().headers as Record<string, string>;
}

describe('resolveMediaUrl', () => {
  it('prefixes a relative path with the server origin', () => {
    expect(resolveMediaUrl('/uploads/abc.png')).toBe('http://127.0.0.1:5000/uploads/abc.png');
  });

  it('leaves an already-absolute URL untouched', () => {
    expect(resolveMediaUrl('https://cdn.example.com/x.png')).toBe('https://cdn.example.com/x.png');
    expect(resolveMediaUrl('http://cdn.example.com/x.png')).toBe('http://cdn.example.com/x.png');
  });
});

describe('token storage', () => {
  afterEach(() => clearToken());

  it('round-trips through localStorage', () => {
    expect(getToken()).toBeNull();
    setToken('abc123');
    expect(getToken()).toBe('abc123');
    clearToken();
    expect(getToken()).toBeNull();
  });
});

describe('getErrorMessage', () => {
  it('prefers the first validation detail over the generic message', () => {
    const error = new ApiError('Validation failed', 422, { title: ['Title is required'] });
    expect(getErrorMessage(error)).toBe('Title is required');
  });

  it('falls back to the ApiError message when there are no details', () => {
    const error = new ApiError('Invalid email or password', 401);
    expect(getErrorMessage(error)).toBe('Invalid email or password');
  });

  it('uses a generic Error message', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('falls back for a non-Error value', () => {
    expect(getErrorMessage('not an error')).toBe('Something went wrong');
  });
});

describe('api request wrapper', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    clearToken();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a GET with no body and an Authorization header when a token is stored', async () => {
    setToken('my-token');
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: 1 }));

    await api.get('/quizzes');

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:5000/api/quizzes');
    expect(lastFetchInit().method).toBe('GET');
    expect(lastFetchHeaders().Authorization).toBe('Bearer my-token');
    expect(lastFetchInit().body).toBeUndefined();
  });

  it('omits the Authorization header when auth: false, even with a token stored', async () => {
    setToken('my-token');
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}));

    await api.post('/auth/login', { email: 'a@b.com', password: 'x' }, { auth: false });

    expect(lastFetchHeaders().Authorization).toBeUndefined();
  });

  it('JSON-encodes a POST body and sets Content-Type', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }));

    await api.post('/quizzes', { title: 'Week 1' });

    expect(lastFetchInit().method).toBe('POST');
    expect(lastFetchHeaders()['Content-Type']).toBe('application/json');
    expect(lastFetchInit().body).toBe(JSON.stringify({ title: 'Week 1' }));
  });

  it('sends FormData as-is without forcing a Content-Type', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }));
    const formData = new FormData();
    formData.append('image', new Blob(['x']), 'play.png');

    await api.postForm('/quizzes/1/questions/2/image', formData);

    expect(lastFetchInit().body).toBe(formData);
    expect(lastFetchHeaders()['Content-Type']).toBeUndefined();
  });

  it('returns undefined for a 204 response without parsing a body', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

    const result = await api.delete('/quizzes/1');

    expect(result).toBeUndefined();
  });

  it('throws an ApiError with the server message and details on a non-ok response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ error: 'Validation failed', details: { title: ['too short'] } }, 422),
    );

    await expect(api.post('/quizzes', { title: '' })).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
      message: 'Validation failed',
      details: { title: ['too short'] },
    });
  });

  it('falls back to a generic message when the error response has no body', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('not json', { status: 500 }));

    await expect(api.get('/quizzes')).rejects.toMatchObject({ status: 500, message: 'Request failed' });
  });

  it('normalizes a network failure into a friendly ApiError with status 0', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(api.get('/quizzes')).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      message: 'Could not reach the server. Check your connection and try again.',
    });
  });
});
