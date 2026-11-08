/**
 * One finding: a summary with severity (icon and label), scope and every ranking factor (FR-ADV-04),
 * expanding to observation → impact → action, evidence, "Why am I seeing this?" (FR-ADV-08), copy-only
 * snippets with risks, rollback and verification (FR-ADV-03), affected DAGs and documentation.
 */
import type { ReactNode } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import ErrorOutline from '@mui/icons-material/ErrorOutlineOutlined';
import ExpandMore from '@mui/icons-material/ExpandMore';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import WarningAmber from '@mui/icons-material/WarningAmberOutlined';
import type { Finding, Severity, SourceId } from '@dcam/contracts';
import { InfoPopover, type Explanation } from '@dcam/ui-kit';
import type { PageProps } from '../types';
import { RULE_WIKI_PAGES, WIKI_SLUGS } from '../wiki/content/slugs';
import { ADVISOR_EXPLANATIONS as X } from './explanations';
import { SnippetBlock } from './SnippetBlock';

const SEVERITY: Record<
  Severity,
  { label: string; color: 'error' | 'warning' | 'info'; Icon: typeof ErrorOutline }
> = {
  critical: { label: 'Critical', color: 'error', Icon: ErrorOutline },
  warning: { label: 'Warning', color: 'warning', Icon: WarningAmber },
  info: { label: 'Info', color: 'info', Icon: InfoOutlined },
};
const SCOPE: Record<Finding['scope']['kind'], string> = {
  environment: 'Environment',
  pool: 'Pool',
  dag: 'DAG',
  task: 'Task',
};
const EFFORT: Record<Finding['effort'], string> = {
  1: 'configuration',
  2: 'sizing',
  3: 'DAG change',
  5: 'refactor',
};
const SOURCE: Record<SourceId, string> = {
  'SRC-AF-API': 'Airflow REST API',
  'SRC-MON': 'Cloud Monitoring',
  'SRC-COMPOSER': 'Cloud Composer API',
  DEMO: 'demo data',
};
/** Affected DAG links shown before "and N more". */
const DAG_LINKS = 10;

/** The element ID of a finding in the list, for links that open one finding. */
export const findingAnchor = (id: string) => `finding-${id.replace(/[^\w-]/g, '_')}`;

const weight = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const fixed2 = (x: number) => x.toFixed(2);

export function SeverityBadge({ severity }: { severity: Severity }) {
  const s = SEVERITY[severity];
  return (
    <Chip
      size="small"
      variant="outlined"
      color={s.color}
      icon={<s.Icon fontSize="small" data-testid={`severity-icon-${severity}`} />}
      label={s.label}
    />
  );
}

function SectionTitle({ explanation, children }: { explanation?: Explanation; children: ReactNode }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      <Typography variant="subtitle2" component="h4">
        {children}
      </Typography>
      {explanation && <InfoPopover explanation={explanation} />}
    </Stack>
  );
}

function Lead({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Typography variant="body2" component="p">
      <Box component="span" sx={{ fontWeight: 500 }}>
        {label}:{' '}
      </Box>
      {children}
    </Typography>
  );
}

const WIKI_PAGES: ReadonlySet<string> = new Set(Object.values(WIKI_SLUGS));

/**
 * The wiki page for a finding (FR-WIKI-06): the page it names when the wiki has it, else the rule
 * catalogue entry, so a link never leads to a missing page.
 */
function wikiPageFor(f: Finding): string | null {
  if (f.links.wiki && WIKI_PAGES.has(f.links.wiki)) return f.links.wiki;
  return (RULE_WIKI_PAGES as Partial<Record<string, string>>)[f.rule_id] ?? null;
}

export function FindingItem({
  finding: f,
  rank,
  linkTo,
  expanded = false,
}: {
  finding: Finding;
  rank: number;
  linkTo: PageProps['linkTo'];
  /** Opened on arrival: the finding a link pointed to (FR-ADV-02). */
  expanded?: boolean;
}) {
  const factors = `Impact ${f.impact}/5 · Confidence ${fixed2(f.confidence)} · Effort ${f.effort} (${EFFORT[f.effort]}) · Priority ${fixed2(f.priority_score)}`;
  const shownDags = f.affected_dags.slice(0, DAG_LINKS);
  const wikiSlug = wikiPageFor(f);
  return (
    <Box component="li" id={findingAnchor(f.id)} sx={{ listStyle: 'none' }}>
      <Accordion
        disableGutters
        defaultExpanded={expanded}
        slotProps={{ transition: { unmountOnExit: true } }}
      >
        <AccordionSummary expandIcon={<ExpandMore />}>
          <Stack spacing={1} sx={{ minWidth: 0 }}>
            <Stack direction="row" sx={{ alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Typography variant="body2" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {rank}.
              </Typography>
              <SeverityBadge severity={f.severity} />
              <Typography variant="body1" component="span" sx={{ fontWeight: 500 }}>
                {f.title}
              </Typography>
              <Typography variant="body2" color="text.secondary" component="span">
                {SCOPE[f.scope.kind]} {f.scope.id}
              </Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              {factors}
            </Typography>
          </Stack>
        </AccordionSummary>
        <AccordionDetails>
          <Stack spacing={3}>
            <Stack spacing={1}>
              <Lead label="Observation">{f.observation}</Lead>
              <Lead label="Impact">{f.impact_text}</Lead>
              <Lead label="Action">{f.action}</Lead>
            </Stack>

            <Stack spacing={1}>
              <SectionTitle explanation={X['adv-priority']}>Ranking</SectionTitle>
              <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                Priority {fixed2(f.priority_score)} = tier weight {weight.format(f.tier_weight)} × impact{' '}
                {f.impact} × confidence {fixed2(f.confidence)} ÷ effort {f.effort}
              </Typography>
              <Stack direction="row" sx={{ alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography variant="caption" color="text.secondary">
                  About the factors:
                </Typography>
                <InfoPopover explanation={X['adv-impact']} />
                <InfoPopover explanation={X['adv-confidence']} />
                <InfoPopover explanation={X['adv-effort']} />
              </Stack>
            </Stack>

            <Stack spacing={1}>
              <SectionTitle explanation={X['adv-evidence']}>Evidence</SectionTitle>
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small" aria-label="Evidence">
                  <TableHead>
                    <TableRow>
                      <TableCell>Measure</TableCell>
                      <TableCell align="right">Value</TableCell>
                      <TableCell>Threshold</TableCell>
                      <TableCell>Source</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {f.evidence.map((e) => (
                      <TableRow key={e.label}>
                        <TableCell>{e.label}</TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                          {e.value}
                        </TableCell>
                        <TableCell>{e.threshold ?? '—'}</TableCell>
                        <TableCell>{SOURCE[e.source]}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            </Stack>

            <Stack spacing={1}>
              <SectionTitle explanation={X['adv-why']}>Why am I seeing this?</SectionTitle>
              <Typography variant="body2">{f.why}</Typography>
            </Stack>

            <Stack spacing={2}>
              <SectionTitle explanation={X['adv-remediation']}>Remediation</SectionTitle>
              <Typography variant="body2" color="text.secondary">
                Review and adapt before you apply it: DCAM never runs these snippets.
              </Typography>
              {f.remediation.map((r) => (
                <SnippetBlock key={`${r.kind}-${r.title}`} snippet={r} />
              ))}
              <Box>
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  Risks and trade-offs
                </Typography>
                <Box component="ul" sx={{ m: 0, pl: 3 }}>
                  {f.risks.map((r) => (
                    <Typography key={r} component="li" variant="body2">
                      {r}
                    </Typography>
                  ))}
                </Box>
              </Box>
              <Lead label="Rollback">{f.rollback}</Lead>
              <Lead label="Verify">{f.verify}</Lead>
            </Stack>

            {f.affected_dags.length > 0 && (
              <Stack spacing={1}>
                <SectionTitle>Affected DAGs ({f.affected_dags.length})</SectionTitle>
                <Typography variant="body2">
                  {shownDags.map((dagId, i) => (
                    <span key={dagId}>
                      {i > 0 && ', '}
                      <Link href={linkTo({ page: 'dag', dagId })}>{dagId}</Link>
                    </span>
                  ))}
                  {f.affected_dags.length > DAG_LINKS && ` and ${f.affected_dags.length - DAG_LINKS} more`}
                </Typography>
              </Stack>
            )}

            <Stack spacing={1}>
              <SectionTitle>Learn more</SectionTitle>
              <Stack spacing={0.5}>
                {wikiSlug && (
                  <Link href={linkTo({ page: 'wiki', slug: wikiSlug })} variant="body2">
                    Read the wiki page for {f.rule_id}
                  </Link>
                )}
                {f.links.docs.map((d) => (
                  <Link key={d.url} href={d.url} target="_blank" rel="noopener noreferrer" variant="body2">
                    {d.title}
                  </Link>
                ))}
              </Stack>
            </Stack>
          </Stack>
        </AccordionDetails>
      </Accordion>
    </Box>
  );
}
