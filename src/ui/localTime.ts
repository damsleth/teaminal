// Graph timestamps are UTC ISO strings; slicing them shows GMT. These render
// them in the local time zone instead.

const pad = (n: number) => n.toString().padStart(2, '0')

// "HH:MM" local. Unparseable input falls back to the raw UTC slice.
export function localTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(11, 16)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// "YYYY-MM-DD" local. Unparseable input falls back to the raw UTC slice.
export function localDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
