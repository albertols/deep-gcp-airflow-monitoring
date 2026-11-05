/**
 * A remediation snippet: monospace text with a Copy button (FR-ADV-03). Copy only: DCAM never runs it.
 */
import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ContentCopy from '@mui/icons-material/ContentCopy';
import type { Finding } from '@dcam/contracts';

type Snippet = Finding['remediation'][number];

const MONO = '"Roboto Mono", ui-monospace, monospace';

export function SnippetBlock({ snippet }: { snippet: Snippet }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    try {
      const clipboard = (navigator as Partial<Navigator>).clipboard;
      if (!clipboard?.writeText) throw new Error('The clipboard is not available.');
      await clipboard.writeText(snippet.code);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  }

  return (
    <Box>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {snippet.title}
        </Typography>
        <Button
          size="small"
          startIcon={<ContentCopy fontSize="small" />}
          onClick={() => void copy()}
          aria-label={`Copy ${snippet.title} snippet`}
        >
          Copy
        </Button>
      </Stack>
      <Box
        component="pre"
        sx={{
          m: 0,
          p: 2,
          overflowX: 'auto',
          borderRadius: 1,
          bgcolor: 'action.hover',
          fontFamily: MONO,
          fontSize: '0.8125rem',
          lineHeight: 1.5,
        }}
      >
        <code>{snippet.code}</code>
      </Box>
      <Typography variant="caption" color="text.secondary" role="status" aria-live="polite">
        {status === 'copied' && 'Copied to the clipboard.'}
        {status === 'failed' &&
          'Copy is not available in this browser: select the text and copy it with your keyboard.'}
      </Typography>
    </Box>
  );
}
