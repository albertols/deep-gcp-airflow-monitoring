import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PageErrorBoundary } from '../src/components/PageErrorBoundary';

function Boom({ error }: { error: Error }): never {
  throw error;
}

describe('FR-UI-07 page error state', () => {
  it('FR-UI-07: a page that fails shows what happened and a way out, not a blank screen', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <PageErrorBoundary resetKey="a">
        <Boom error={new Error('render failed')} />
      </PageErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't show this page");
    expect(screen.getByRole('button', { name: 'Reload DCAM' })).toBeInTheDocument();
    quiet.mockRestore();
  });

  it('FR-UI-07: explains a failed page download as a probable DCAM update', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <PageErrorBoundary resetKey="a">
        <Boom error={new TypeError('Failed to fetch dynamically imported module: /assets/DagsPage-x.js')} />
      </PageErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/DCAM was probably updated/);
    quiet.mockRestore();
  });

  it('recovers when the route changes', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(
      <PageErrorBoundary resetKey="a">
        <Boom error={new Error('x')} />
      </PageErrorBoundary>,
    );
    rerender(
      <PageErrorBoundary resetKey="b">
        <p>fine</p>
      </PageErrorBoundary>,
    );
    expect(screen.getByText('fine')).toBeInTheDocument();
    quiet.mockRestore();
  });
});
