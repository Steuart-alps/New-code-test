import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Filter, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { SortDir, SortState } from "@/lib/table-sort";

/** One way a column can be sorted, e.g. "Newest first" or "Severity, most serious first". */
export interface ColumnSortOption { key: string; dir: SortDir; label: string }

/** A-to-Z / Z-to-A sort options for a text column. */
export const textSortOptions = (key: string): ColumnSortOption[] => [
  { key, dir: "asc", label: "A to Z" },
  { key, dir: "desc", label: "Z to A" },
];

/** Newest / oldest first sort options for a date column. */
export const dateSortOptions = (key: string): ColumnSortOption[] => [
  { key, dir: "desc", label: "Newest first" },
  { key, dir: "asc", label: "Oldest first" },
];

interface ColumnHeaderProps {
  label: string;
  /** Classes for the <th>, e.g. "hidden md:table-cell". */
  className?: string;
  sortOptions?: ColumnSortOption[];
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  /** True while this column's filter or search narrows the list. */
  filterActive?: boolean;
  onClearFilter?: () => void;
  /** Filter and search controls shown under the sort options. */
  children?: ReactNode;
}

/**
 * A list table heading people click to sort the list, filter it or search it.
 * Use the same heading on every list so tables behave alike across the app.
 */
export function ColumnHeader({
  label, className, sortOptions = [], sort, onSortChange, filterActive = false, onClearFilter, children,
}: ColumnHeaderProps) {
  const [open, setOpen] = useState(false);
  const activeSort = sort ? sortOptions.find(o => o.key === sort.key && o.dir === sort.dir) : undefined;
  const sortedHere = !!sort && sortOptions.some(o => o.key === sort.key);
  const canSort = sortOptions.length > 0 && !!onSortChange;
  const SortIcon = !sortedHere ? ArrowUpDown : sort!.dir === "asc" ? ArrowUp : ArrowDown;
  const ariaSort = sortedHere && sortOptions.length <= 2 ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined;

  return (
    <th
      className={cn("text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wider", className)}
      aria-sort={ariaSort}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Sort and filter by ${label}${activeSort ? `, sorted ${activeSort.label}` : ""}${filterActive ? ", filtered" : ""}`}
            title="Sort, filter or search this column"
            data-testid={`column-header-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
            className={cn(
              "inline-flex items-center gap-1 rounded-sm px-2 py-1 -mx-2 -my-1 text-left [text-transform:inherit]",
              "hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              (sortedHere || filterActive) && "text-foreground",
            )}
          >
            {label}
            {canSort && <SortIcon className={cn("w-3.5 h-3.5", !sortedHere && "opacity-40")} aria-hidden="true" />}
            {children && (
              <Filter
                className={cn("w-3.5 h-3.5", filterActive ? "text-primary fill-primary/20" : "opacity-40")}
                aria-hidden="true"
              />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          collisionPadding={8}
          // Long lists scroll inside the pop-up rather than running off the screen.
          className="w-64 p-0 normal-case tracking-normal max-h-[min(28rem,var(--radix-popover-content-available-height))] overflow-y-auto"
        >
          {canSort && (
            <div className="p-1" role="group" aria-label={`Sort by ${label}`}>
              <p className="px-2 pt-1.5 pb-1 text-xs font-semibold text-muted-foreground">Sort</p>
              {sortOptions.map(option => {
                const selected = activeSort === option;
                return (
                  <button
                    key={`${option.key}-${option.dir}`}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => { onSortChange!({ key: option.key, dir: option.dir }); setOpen(false); }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-left hover:bg-muted",
                      selected && "font-medium",
                    )}
                  >
                    <Check className={cn("w-3.5 h-3.5 shrink-0", !selected && "invisible")} aria-hidden="true" />
                    {option.label}
                  </button>
                );
              })}
            </div>
          )}
          {children && (
            <div className={cn("p-3 space-y-2", canSort && "border-t border-border")}>
              {children}
              {filterActive && onClearFilter && (
                <button
                  type="button"
                  onClick={onClearFilter}
                  className="text-xs font-medium text-primary underline underline-offset-2"
                >
                  Clear
                </button>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </th>
  );
}

/** A single-choice list inside a column heading, e.g. Status: All / Open / Closed. */
export function ColumnFilterChoices({ label, value, allLabel, options, onChange }: {
  label: string;
  value: string;
  allLabel: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const choices = [{ value: "all", label: allLabel }, ...options];
  return (
    <div role="group" aria-label={label}>
      <p className="pb-1 text-xs font-semibold text-muted-foreground">{label}</p>
      {choices.map(choice => {
        const selected = value === choice.value;
        return (
          <button
            key={choice.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(choice.value)}
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-1 py-1 text-sm text-left hover:bg-muted",
              selected && "font-medium",
            )}
          >
            <Check className={cn("w-3.5 h-3.5 shrink-0", !selected && "invisible")} aria-hidden="true" />
            {choice.label}
          </button>
        );
      })}
    </div>
  );
}

/** A search box inside a column heading that narrows the list to rows containing the words. */
export function ColumnSearch({ label, value, onChange, placeholder }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
      <Input
        autoFocus
        aria-label={label}
        placeholder={placeholder ?? "Search…"}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="pl-8 h-8 text-sm rounded-sm"
      />
    </div>
  );
}
