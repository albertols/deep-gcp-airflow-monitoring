/**
 * S-18 Advisor: ranked findings with evidence and copy-only remediation ("Top actions", spec §13.4).
 * DCAM never applies changes; people review each snippet and apply it themselves.
 *
 * @implements FR-ADV-01, FR-ADV-03, FR-ADV-04, FR-ADV-08, FR-UI-05, FR-UI-07, FR-UI-08
 */
import { useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { Finding } from '@dcam/contracts';
import { PageHeader } from '../../components/PageHeader';
import { useRefresh } from '../../components/view';
import { Panel, ProvenanceFooter, QueryState } from '../../components/Panel';
import type { PageProps } from '../types';
import { ADVISOR_EXPLANATIONS as X } from './explanations';
import { FindingItem } from './FindingItem';

/** "Top actions" shows at most 10 items per environment (spec §13.4). */
export const TOP_ACTIONS = 10;

function FindingList({
  label,
  findings,
  offset,
  linkTo,
}: {
  label: string;
  findings: readonly Finding[];
  offset: number;
  linkTo: PageProps['linkTo'];
}) {
  return (
    <Stack component="ul" aria-label={label} spacing={1} sx={{ m: 0, p: 0 }}>
      {findings.map((f, i) => (
        <FindingItem key={f.id} finding={f} rank={offset + i + 1} linkTo={linkTo} />
      ))}
    </Stack>
  );
}

export function AdvisorPage({ api, envId, linkTo }: PageProps) {
  const q = useQuery({
    queryKey: ['findings', envId],
    queryFn: () => api.getFindings(envId),
    ...useRefresh(),
  });
  const data = q.data;
  const top = data?.findings.slice(0, TOP_ACTIONS) ?? [];
  const rest = data?.findings.slice(TOP_ACTIONS) ?? [];

  return (
    <Stack spacing={4}>
      <PageHeader
        title="Advisor"
        subtitle="What to change first, with the evidence behind it and the snippet to apply."
      />
      <Alert severity="info">
        DCAM never applies changes. Each snippet is text for you to review, adapt and apply through your own
        change process, in a maintenance window for production.
      </Alert>
      <QueryState isPending={q.isPending} error={q.error} what="the findings" />
      {data && (
        <>
          {data.findings.length === 0 ? (
            data.not_evaluated.length === 0 ? (
              <Alert severity="success">
                No findings for {data.env_id} in the last 24 hours: no rule's condition held. Open Bottlenecks
                to see where work waits, or check again after the next busy period.
              </Alert>
            ) : (
              <Alert severity="info">
                No findings for {data.env_id} in the last 24 hours from the rules DCAM could evaluate;{' '}
                {data.not_evaluated.length === 1
                  ? '1 rule could not be evaluated'
                  : `${data.not_evaluated.length} rules could not be evaluated`}{' '}
                (listed below). Open Bottlenecks to see where work waits.
              </Alert>
            )
          ) : (
            <Panel explanation={X['adv-top-actions']}>
              <FindingList label="Top actions" findings={top} offset={0} linkTo={linkTo} />
            </Panel>
          )}
          {rest.length > 0 && (
            <Panel explanation={X['adv-other']}>
              <FindingList label="Other findings" findings={rest} offset={TOP_ACTIONS} linkTo={linkTo} />
            </Panel>
          )}
          {data.not_evaluated.length > 0 && (
            <Panel explanation={X['adv-not-evaluated']}>
              <Stack component="ul" aria-label="Rules not evaluated" spacing={1} sx={{ m: 0, pl: 2.5 }}>
                {data.not_evaluated.map((r) => (
                  <Typography key={r.rule_id} component="li" variant="body2">
                    <strong>{r.rule_id}</strong> {r.title}: {r.reason}
                  </Typography>
                ))}
              </Stack>
            </Panel>
          )}
          <ProvenanceFooter
            dataAsOf={data.data_as_of}
            sources={data.sources}
            note="rules evaluated over the last 24 hours"
          />
        </>
      )}
    </Stack>
  );
}
