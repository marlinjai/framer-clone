// The upload control of a site image (SiteImageField): a file is checked here
// first and refused without a request when the server would refuse it, an
// accepted file is sent and its path becomes the value with a preview, its
// name, type, pixel size and size, and every failure (permission, sign-in,
// network, the server's own refusal) says what to do next. Remove clears it.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { SiteImageField, uploadFailureMessage } from '../SiteImageField';
import { png, svgText } from '@/lib/images/__tests__/fixtures';

const SHA = 'e'.repeat(64);
const fetchMock = vi.fn();

function Harness({ kind = 'favicon', initial = '', onValue }: { kind?: 'favicon' | 'sharing'; initial?: string; onValue?: (v: string) => void }) {
  const [value, setValue] = React.useState(initial);
  return (
    <SiteImageField
      projectId="site_1"
      kind={kind}
      inputId="field"
      label={kind === 'favicon' ? 'Favicon' : 'Sharing image'}
      value={value}
      onChange={(v) => {
        setValue(v);
        onValue?.(v);
      }}
      onBlur={() => {}}
      hintText="Hint."
      square={kind === 'favicon'}
    />
  );
}

function pick(kind: 'favicon' | 'sharing', bytes: Uint8Array, name: string, type = 'image/png') {
  const input = screen.getByTestId(`site-image-file-${kind}`) as HTMLInputElement;
  const file = new File([bytes as BlobPart], name, { type });
  // jsdom's File may lack arrayBuffer in older versions: the component reads it.
  if (!('arrayBuffer' in file)) Object.assign(file, { arrayBuffer: async () => bytes.slice().buffer });
  fireEvent.change(input, { target: { files: [file] } });
}

function answer(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('uploading', () => {
  it('sends an accepted file and uses the answered path, with a preview and the file facts', async () => {
    const onValue = vi.fn();
    fetchMock.mockResolvedValue(
      answer(201, { path: `/site-images/${SHA}.png`, byteSize: 2048, contentType: 'image/png', width: 512, height: 512, sha256: SHA, warnings: [] }),
    );
    render(<Harness onValue={onValue} />);
    pick('favicon', png(512, 512), 'logo.png');

    await waitFor(() => expect(onValue).toHaveBeenCalledWith(`/site-images/${SHA}.png`));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/projects/site_1/images?kind=favicon');
    expect(init.method).toBe('POST');
    expect(screen.getByText('logo.png')).toBeTruthy();
    expect(screen.getByText('PNG, 512 by 512 pixels, 2 KB')).toBeTruthy();
    const img = screen.getByAltText('Favicon preview') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(`/api/projects/site_1/images/${SHA}`);
    // The address box does not show the internal path.
    expect((screen.getByLabelText('Favicon') as HTMLInputElement).value).toBe('');
  });

  it('refuses an SVG before any request, saying why and what to do', async () => {
    render(<Harness />);
    pick('favicon', svgText(), 'logo.svg', 'image/svg+xml');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/SVG can carry script/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Favicon').getAttribute('aria-invalid')).toBe('true');
  });

  it('names a missing permission with the next step', async () => {
    fetchMock.mockResolvedValue(answer(403, { error: { code: 'forbidden', message: 'Forbidden' } }));
    render(<Harness />);
    pick('favicon', png(64, 64), 'a.png');
    expect((await screen.findByRole('alert')).textContent).toMatch(/not allowed to change this site/);
  });

  it('names a network failure with the next step and keeps the old value', async () => {
    const onValue = vi.fn();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<Harness onValue={onValue} />);
    pick('favicon', png(64, 64), 'a.png');
    expect((await screen.findByRole('alert')).textContent).toMatch(/did not reach the server/);
    expect(onValue).not.toHaveBeenCalled();
  });

  it("passes the server's own refusal through", async () => {
    fetchMock.mockResolvedValue(answer(409, { error: { code: 'image_limit', message: 'This site already stores the most images allowed (500).' } }));
    render(<Harness kind="sharing" />);
    pick('sharing', png(1200, 630), 'share.png');
    expect((await screen.findByRole('alert')).textContent).toMatch(/most images allowed/);
  });

  it('warns about a non-square favicon without refusing it', async () => {
    fetchMock.mockResolvedValue(
      answer(201, { path: `/site-images/${SHA}.png`, byteSize: 900, contentType: 'image/png', width: 400, height: 200, sha256: SHA, warnings: [] }),
    );
    render(<Harness />);
    pick('favicon', png(400, 200), 'wide.png');
    expect((await screen.findByTestId('site-image-warnings-favicon')).textContent).toMatch(/squashed/);
  });
});

describe('the value', () => {
  it('Remove clears an upload', () => {
    const onValue = vi.fn();
    render(<Harness initial={`/site-images/${SHA}.png`} onValue={onValue} />);
    expect(screen.getByText('Uploaded image')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove favicon' }));
    expect(onValue).toHaveBeenCalledWith('');
    expect(screen.queryByTestId('site-image-preview-favicon')).toBeNull();
  });

  it('typing an address replaces an upload', () => {
    const onValue = vi.fn();
    render(<Harness kind="sharing" initial={`/site-images/${SHA}.jpg`} onValue={onValue} />);
    fireEvent.change(screen.getByLabelText('Sharing image'), { target: { value: ' https://cdn.test/a.png ' } });
    expect(onValue).toHaveBeenCalledWith('https://cdn.test/a.png');
  });
});

describe('uploadFailureMessage', () => {
  it('says what to do for each kind of failure', () => {
    expect(uploadFailureMessage(401, undefined)).toMatch(/signed out/);
    expect(uploadFailureMessage(404, undefined)).toMatch(/Reload the editor/);
    expect(uploadFailureMessage(503, undefined)).toMatch(/not answering/);
    expect(uploadFailureMessage(500, undefined)).toMatch(/Nothing was changed; upload the file again/);
    expect(uploadFailureMessage(401, undefined, 'delete the image')).toMatch(/then delete the image again/);
    expect(uploadFailureMessage(404, 'This image does not exist on this site.')).toBe('This image does not exist on this site.');
    expect(uploadFailureMessage(429, 'Too many uploads in a short time.')).toBe('Too many uploads in a short time.');
    expect(uploadFailureMessage(413, 'too big, make it smaller')).toBe('too big, make it smaller');
  });
});
