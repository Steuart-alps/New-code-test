import type { ListColumn } from "@/components/list-table";
import { rankIn } from "@/lib/table-sort";

// Column headings for the swimming pool record lists shared by SwimTrack and
// AquaTrack (sessions, surveillance, first aid and incidents).

const TH = "text-left font-medium py-2 pr-4";
const trailing = <T,>(widths: string[]): ListColumn<T>[] => widths.map((w, i) => ({ key: `end${i}`, label: "", className: w }));

interface Session { sessionDate: string; sessionType: string; siteName: string | null; lifeguardName: string | null; openTime: string | null; batherCountPeak: number | null; preSessionResult: string; poolClosed: boolean }
export function sessionColumns<T extends Session>(typeLabels: Record<string, string>, ends: string[]): ListColumn<T>[] {
  return [
    { key: "date", label: "Date", className: TH, value: s => s.sessionDate, sort: "date", filter: "date" },
    { key: "type", label: "Type", className: `${TH} hidden sm:table-cell`, value: s => typeLabels[s.sessionType] ?? s.sessionType, sort: "text", filter: "choice" },
    { key: "site", label: "Site", className: `${TH} hidden md:table-cell`, value: s => s.siteName, sort: "text", filter: "choice" },
    { key: "lifeguard", label: "Lifeguard", className: `${TH} hidden sm:table-cell`, value: s => s.lifeguardName, sort: "text", filter: "choice" },
    { key: "times", label: "Times", className: `${TH} hidden lg:table-cell`, value: s => s.openTime, sort: ["Earliest first", "Latest first"] },
    { key: "bathers", label: "Peak bathers", className: "text-right font-medium py-2 pr-4 hidden md:table-cell", value: s => s.batherCountPeak, sort: "number" },
    { key: "pre", label: "Pre-session", className: TH, value: s => (s.preSessionResult === "pass" ? "Pass" : "Fail"), sort: ["Fail first", "Pass first"], filter: "choice" },
    { key: "status", label: "Status", className: TH, value: s => (s.poolClosed ? "Closed" : "Open"), sort: ["Closed first", "Open first"], filter: "choice" },
    ...trailing<T>(ends),
  ];
}

interface Surveillance { checkDate: string; checkTime: string | null; siteName: string | null; checkedBy: string | null; batherCount: number | null; scanCompleted: boolean; observations: string | null }
export function surveillanceColumns<T extends Surveillance>(ends: string[]): ListColumn<T>[] {
  return [
    { key: "date", label: "Date", className: TH, value: c => c.checkDate, sort: "date", filter: "date" },
    { key: "time", label: "Time", className: TH, value: c => c.checkTime, sort: ["Earliest first", "Latest first"] },
    { key: "site", label: "Site", className: `${TH} hidden md:table-cell`, value: c => c.siteName, sort: "text", filter: "choice" },
    { key: "by", label: "Checked by", className: `${TH} hidden sm:table-cell`, value: c => c.checkedBy, sort: "text", filter: "choice" },
    { key: "bathers", label: "Bathers", className: "text-right font-medium py-2 pr-4 hidden sm:table-cell", value: c => c.batherCount, sort: "number" },
    { key: "scan", label: "Scan done", className: TH, value: c => (c.scanCompleted ? "Yes" : "No"), sort: ["No first", "Yes first"], filter: "choice" },
    { key: "observations", label: "Observations", className: `${TH} hidden lg:table-cell`, value: c => c.observations, filter: "search" },
    ...trailing<T>(ends),
  ];
}

interface FirstAid { checkDate: string; siteName: string | null; checkedBy: string | null; result: string }
export function firstAidColumns<T extends FirstAid>(items: readonly { key: string; label: string }[], ends: string[]): ListColumn<T>[] {
  return [
    { key: "date", label: "Date", className: TH, value: f => f.checkDate, sort: "date", filter: "date" },
    { key: "site", label: "Site", className: `${TH} hidden md:table-cell`, value: f => f.siteName, sort: "text", filter: "choice" },
    { key: "by", label: "Checked by", className: `${TH} hidden sm:table-cell`, value: f => f.checkedBy, sort: "text", filter: "choice" },
    ...items.map((item): ListColumn<T> => ({
      key: item.key, label: item.label.split(" ")[0], className: "text-center font-medium py-2 px-1 hidden lg:table-cell text-xs max-w-[60px]",
      value: f => ((f as unknown as Record<string, boolean>)[item.key] ? "OK" : "Not OK"), filter: "choice",
    })),
    { key: "result", label: "Result", className: TH, value: f => (f.result === "pass" ? "Pass" : "Fail"), sort: ["Fail first", "Pass first"], filter: "choice" },
    ...trailing<T>(ends),
  ];
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];
interface PoolIncident { incidentDate: string; incidentTime: string | null; incidentType: string; severity: string; siteName: string | null; description: string; actionTaken: string | null; outcome: string | null }
export function poolIncidentColumns<T extends PoolIncident>(typeLabels: Record<string, string>, severityLabels: Record<string, string>, ends: string[]): ListColumn<T>[] {
  return [
    { key: "date", label: "Date", className: TH, value: i => `${i.incidentDate} ${i.incidentTime ?? ""}`, sort: "date", filter: "date" },
    { key: "type", label: "Type", className: `${TH} hidden sm:table-cell`, value: i => typeLabels[i.incidentType] ?? i.incidentType, sort: "text", filter: "choice" },
    { key: "severity", label: "Severity", className: TH, value: i => rankIn(SEVERITY_ORDER, i.severity), sort: ["Most severe first", "Least severe first"],
      filter: "choice", filterValue: i => i.severity, choiceLabel: v => severityLabels[v] ?? v, choiceOrder: SEVERITY_ORDER },
    { key: "site", label: "Site", className: `${TH} hidden md:table-cell`, value: i => i.siteName, sort: "text", filter: "choice" },
    { key: "description", label: "Description", className: TH, value: i => i.description, filter: "search" },
    { key: "action", label: "Action taken", className: `${TH} hidden lg:table-cell`, value: i => i.actionTaken, filter: "search" },
    { key: "outcome", label: "Outcome", className: TH, value: i => (i.outcome ? "Resolved" : "Open"), sort: ["Open first", "Resolved first"], filter: "choice" },
    ...trailing<T>(ends),
  ];
}
