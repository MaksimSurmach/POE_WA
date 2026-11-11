const timestamp = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
});

/** Browser-local time, always labelled with its time zone. */
export function formatTimestamp(iso: string) {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? timestamp.format(date)
    : 'Time unavailable';
}

export function formatDate(iso: string) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));
}
