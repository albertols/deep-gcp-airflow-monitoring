/**
 * Keeps a failing page from blanking the whole app (FR-UI-07 error state). A failed chunk download
 * usually means DCAM was rebuilt or upgraded while this tab stayed open.
 */
import { Component, type ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';

interface Props {
  /** Changing it (for example the route) clears the error. */
  readonly resetKey: string;
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | null;
  readonly key: string;
}

const isChunkError = (e: Error) =>
  /dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(e.message);

export class PageErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.key ? null : { error: null, key: props.resetKey };
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => window.location.reload()}>
            Reload DCAM
          </Button>
        }
      >
        Couldn't show this page.{' '}
        {isChunkError(error)
          ? 'DCAM was probably updated while this tab was open; reload to get the new version.'
          : `${error.message}. Reload, and if it happens again, check the DCAM server output.`}
      </Alert>
    );
  }
}
