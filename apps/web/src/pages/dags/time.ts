/**
 * Time labels for the DAG pages, in the context bar's time zone (FR-UI-01); UTC where a caller passes
 * none. Storage and Airflow timestamps are UTC (spec §8.9).
 */
import { UTC_TIME, type TimeFormat } from '../../components/time';

/** `11:02`. */
export const formatClock = (ms: number, time: TimeFormat = UTC_TIME) => time.clock(ms);
/** `5 Nov, 11:02 UTC`. */
export const formatDateTime = (at: string | number, time: TimeFormat = UTC_TIME) => time.dateTime(at);
