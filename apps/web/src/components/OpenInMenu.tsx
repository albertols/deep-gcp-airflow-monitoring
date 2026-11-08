/**
 * The "Open in" menu (FR-UI-04): the same environment, DAG, run or task in the Google Cloud console and the
 * Airflow UI, over the page's range. Each link is an anchor that opens in a new tab with
 * `rel="noopener noreferrer"`; DCAM itself never requests these addresses. An item whose field is missing
 * is disabled, says what is missing and what to do, and stays reachable with the keyboard so its reason is
 * read out. In demo mode the menu says the links lead to fictitious resources (FR-EMU-01).
 *
 * The shell provides where the selected environment lives ({@link EnvironmentPlaceContext}, from
 * `/api/v1/meta`); without it the menu says DCAM could not read it.
 *
 * @implements FR-UI-04, FR-UI-05, FR-EMU-01
 */
import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import ArrowDropDown from '@mui/icons-material/ArrowDropDown';
import OpenInNew from '@mui/icons-material/OpenInNew';
import Button from '@mui/material/Button';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import type { Meta } from '@dcam/contracts';
import { InfoPopover } from '@dcam/ui-kit';
import { EXPLANATIONS } from '../explanations';
import type { TimeWindow } from './deep-links';
import { openInLinks, type EnvironmentPlace, type LinkTarget, type MenuLink } from './open-in-links';
import { useTimeFormat } from './view';

export interface EnvironmentPlaceValue {
  readonly mode: Meta['mode'];
  readonly place: EnvironmentPlace;
}

/** Where the selected environment lives; `null` until the shell has read `/api/v1/meta`. */
export const EnvironmentPlaceContext = createContext<EnvironmentPlaceValue | null>(null);

const DEMO_NOTE = 'Demo data: these links lead to fictitious acme resources, so they open nothing real.';
const ITEM_SX = { whiteSpace: 'normal', maxWidth: 440, alignItems: 'flex-start' } as const;

function Item({ link, onClose }: { link: MenuLink; onClose: () => void }) {
  if (link.kind === 'missing')
    return (
      <MenuItem disabled sx={ITEM_SX}>
        <ListItemText primary={link.label} secondary={link.reason} />
      </MenuItem>
    );
  return (
    <MenuItem
      component="a"
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClose}
      sx={ITEM_SX}
    >
      <ListItemText
        primary={
          <>
            {link.label}
            <OpenInNew fontSize="inherit" aria-hidden sx={{ ml: 1, verticalAlign: 'middle' }} />
          </>
        }
        secondary={link.hint}
      />
    </MenuItem>
  );
}

export function OpenInMenu({
  target,
  timeWindow,
  label = 'Open in',
  info = true,
}: {
  target: LinkTarget;
  /** The range the page shows (`range.from`/`range.to` of its data). */
  timeWindow: TimeWindow;
  /** Accessible name; rows name their task, for example "Open load_orders in". */
  label?: string;
  /** The (i) entry; a table shows it once in its column header instead. */
  info?: boolean;
}) {
  const env = useContext(EnvironmentPlaceContext);
  const time = useTimeFormat();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const buttonId = useId();
  const menuId = useId();
  const open = anchor !== null;
  const close = () => setAnchor(null);
  const groups = open
    ? openInLinks(
        {
          place: env?.place ?? null,
          window: timeWindow,
          windowText: `${time.dateTime(timeWindow.from)} to ${time.dateTime(timeWindow.to)}`,
        },
        target,
      )
    : [];

  const items: ReactNode[] = [];
  if (env?.mode === 'demo')
    items.push(
      <MenuItem key="demo" disabled sx={ITEM_SX}>
        <ListItemText secondary={DEMO_NOTE} />
      </MenuItem>,
    );
  for (const group of groups) {
    items.push(<ListSubheader key={group.title}>{group.title}</ListSubheader>);
    for (const link of group.links)
      items.push(<Item key={`${group.title}/${link.label}`} link={link} onClose={close} />);
  }

  return (
    <Stack direction="row" sx={{ alignItems: 'center' }}>
      <Button
        id={buttonId}
        size="small"
        variant="outlined"
        aria-label={label === 'Open in' ? undefined : label}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        aria-expanded={open ? 'true' : undefined}
        endIcon={<ArrowDropDown />}
        onClick={(e) => setAnchor(e.currentTarget)}
      >
        Open in
      </Button>
      {info && <InfoPopover explanation={EXPLANATIONS['open-in']} />}
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={open}
        onClose={close}
        slotProps={{ list: { 'aria-labelledby': buttonId, dense: true, disabledItemsFocusable: true } }}
      >
        {items}
      </Menu>
    </Stack>
  );
}
