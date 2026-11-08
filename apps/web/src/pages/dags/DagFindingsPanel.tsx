/**
 * The advisor's open findings for this DAG on its detail page (FR-DAGD-01 "findings", S-12 tab "findings"):
 * most severe first, each with its rule and a link that opens it in the advisor (FR-ADV-02).
 *
 * @implements FR-DAGD-01, FR-ADV-02, FR-UI-05, FR-UI-07, FR-UI-08
 */
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { DagDetail, Severity } from '@dcam/contracts';
import { Panel, ProvenanceFooter } from '../../components/Panel';
import { SeverityBadge } from '../advisor/FindingItem';
import type { PageProps } from '../types';
import { COMPARE_EXPLANATIONS as E } from './compare-explanations';

const RANK: Readonly<Record<Severity, number>> = { critical: 0, warning: 1, info: 2 };

export function DagFindingsPanel({ detail, linkTo }: { detail: DagDetail; linkTo: PageProps['linkTo'] }) {
  const findings = [...detail.findings].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  return (
    <Panel explanation={E['dagd-findings']}>
      <Stack spacing={2}>
        {findings.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No open findings for this DAG in the last 24 hours: no rule's condition held for it, its pools or
            its environment. The panels below show where it could still improve.
          </Typography>
        ) : (
          <Stack component="ul" aria-label="Findings for this DAG" spacing={1} sx={{ m: 0, p: 0 }}>
            {findings.map((f) => (
              <Stack
                component="li"
                key={f.id}
                direction="row"
                sx={{ alignItems: 'center', gap: 2, flexWrap: 'wrap', listStyle: 'none' }}
              >
                <SeverityBadge severity={f.severity} />
                <Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                  {f.rule_id}
                </Typography>
                <Link href={linkTo({ page: 'advisor' }, { finding: f.id })} variant="body2">
                  {f.title}
                </Link>
              </Stack>
            ))}
          </Stack>
        )}
        <ProvenanceFooter
          as="p"
          dataAsOf={detail.data_as_of}
          sources={detail.sources}
          note="rules evaluated over the last 24 hours"
        />
      </Stack>
    </Panel>
  );
}
