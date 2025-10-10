export function getSystemTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && typeof tz === 'string') {
      return tz;
    }
  } catch (error) {
    console.warn('[schedule-task-mcp] Unable to resolve system timezone, falling back to UTC', error);
  }
  return 'UTC';
}

export function formatInTimezone(dateIso: string | undefined, timeZone: string, fallback?: string): string | undefined {
  if (!dateIso) {
    return fallback;
  }
  try {
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const date = new Date(dateIso);
    return formatter.format(date).replace(/\//g, '-');
  } catch (error) {
    console.error('Failed to format date in timezone', timeZone, error);
    return dateIso;
  }
}
