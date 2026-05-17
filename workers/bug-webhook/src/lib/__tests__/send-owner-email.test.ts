import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendOwnerEmail } from '../send-owner-email';

describe('sendOwnerEmail', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok:true on 200 and posts to Resend with correct shape', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"id":"abc"}', { status: 200 }));
    const result = await sendOwnerEmail(
      { RESEND_API_KEY: 'rk_test', OWNER_EMAIL: 'owner@example.com' },
      { to: 'recipient@example.com', subject: 'hi', html: '<p>body</p>' }
    );
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer rk_test');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(body.to).toEqual(['recipient@example.com']);
    expect(body.subject).toBe('hi');
    expect(body.html).toBe('<p>body</p>');
    expect(body.from).toBe('Sorting History <hello@send.sortinghistory.com>');
  });

  it('returns no-api-key when RESEND_API_KEY missing, does not call fetch', async () => {
    const result = await sendOwnerEmail(
      { OWNER_EMAIL: 'owner@example.com' },
      { to: 'recipient@example.com', subject: 's', html: 'h' }
    );
    expect(result).toEqual({ ok: false, error: 'no-api-key' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to env.OWNER_EMAIL when payload.to is missing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const result = await sendOwnerEmail(
      { RESEND_API_KEY: 'rk_test', OWNER_EMAIL: 'owner@example.com' },
      { subject: 's', html: 'h' }
    );
    expect(result).toEqual({ ok: true });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.to).toEqual(['owner@example.com']);
  });

  it('returns no-recipient when neither payload.to nor env.OWNER_EMAIL provided', async () => {
    const result = await sendOwnerEmail(
      { RESEND_API_KEY: 'rk_test' },
      { subject: 's', html: 'h' }
    );
    expect(result).toEqual({ ok: false, error: 'no-recipient' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns ok:false with status+body on 4xx response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad address', { status: 422 }));
    const result = await sendOwnerEmail(
      { RESEND_API_KEY: 'rk_test', OWNER_EMAIL: 'owner@example.com' },
      { subject: 's', html: 'h' }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('422: bad address');
  });

  it('returns ok:false with status+body on 5xx response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('upstream down', { status: 503 }));
    const result = await sendOwnerEmail(
      { RESEND_API_KEY: 'rk_test', OWNER_EMAIL: 'owner@example.com' },
      { subject: 's', html: 'h' }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('503: upstream down');
  });

  it('honors a custom from address when provided', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await sendOwnerEmail(
      { RESEND_API_KEY: 'rk_test', OWNER_EMAIL: 'owner@example.com' },
      { subject: 's', html: 'h', from: 'Sorting History Pipeline <hello@send.sortinghistory.com>' }
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.from).toBe('Sorting History Pipeline <hello@send.sortinghistory.com>');
  });

  it('includes plain-text fallback (text field) when payload.text provided', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await sendOwnerEmail(
      { RESEND_API_KEY: 'rk_test', OWNER_EMAIL: 'owner@example.com' },
      { subject: 's', html: '<p>h</p>', text: 'plain body' }
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toBe('plain body');
    expect(body.html).toBe('<p>h</p>');
  });

  it('omits text field when payload.text not provided', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await sendOwnerEmail(
      { RESEND_API_KEY: 'rk_test', OWNER_EMAIL: 'owner@example.com' },
      { subject: 's', html: '<p>h</p>' }
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect('text' in body).toBe(false);
  });

  it('catches network errors and returns ok:false', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const result = await sendOwnerEmail(
      { RESEND_API_KEY: 'rk_test', OWNER_EMAIL: 'owner@example.com' },
      { subject: 's', html: 'h' }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('network down');
  });
});
