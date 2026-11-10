export interface ReportingPeriod {
  year: number;
  quarter: string;
}

export function periodKey(period: ReportingPeriod) {
  return `${period.year}:${period.quarter}`;
}

export function defaultPeriodKey(periods: ReportingPeriod[]) {
  if (periods.some((period) => periodKey(period) === "2026:Q3")) return "2026:Q3";
  return periods[0] ? periodKey(periods[0]) : "all";
}
