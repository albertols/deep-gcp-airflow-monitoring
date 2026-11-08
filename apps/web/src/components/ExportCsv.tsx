/**
 * "Export CSV" for every table view (FR-STORE-04): the button saves the rows the table shows, after its
 * filters, sort and limits, as a CSV file named after the view, environment, range and data as of. Pages
 * say what their exports belong to with {@link ExportScope}; the file is made in the browser and never
 * leaves the machine.
 *
 * @implements FR-STORE-04
 */
import { createContext, useContext, type ReactNode } from 'react';
import Button from '@mui/material/Button';
import FileDownloadOutlined from '@mui/icons-material/FileDownloadOutlined';
import { exportFileName, toCsv, type CsvColumn, type ExportContext } from './csv';

const NO_SCOPE: ExportContext = { envId: null, range: null, asOf: null };
const ExportScopeContext = createContext<ExportContext>(NO_SCOPE);

/** What the exports inside belong to: the environment, the range preset and the data's "as of". */
export function ExportScope({ children, ...scope }: ExportContext & { children: ReactNode }) {
  return <ExportScopeContext.Provider value={scope}>{children}</ExportScopeContext.Provider>;
}

/** Saves text as a file in the browser; nothing leaves the machine. */
export function downloadText(text: string, fileName: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export interface ExportCsvButtonProps<R> {
  /** Short view name for the file, for example `dags` or `dag-orders_daily-runs`. */
  readonly view: string;
  /** What the table is, for the button's accessible name: "Export CSV, <what>". */
  readonly what: string;
  /** The rows as the table shows them: filtered, sorted and limited. */
  readonly rows: readonly R[];
  readonly columns: readonly CsvColumn<R>[];
}

/** Exports the rows of one table view; disabled when the view has no rows. */
export function ExportCsvButton<R>({ view, what, rows, columns }: ExportCsvButtonProps<R>) {
  const scope = useContext(ExportScopeContext);
  return (
    <Button
      size="small"
      variant="outlined"
      startIcon={<FileDownloadOutlined aria-hidden />}
      disabled={rows.length === 0}
      aria-label={`Export CSV, ${what}`}
      onClick={() => downloadText(toCsv(columns, rows), exportFileName(view, scope))}
      sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
    >
      Export CSV
    </Button>
  );
}
