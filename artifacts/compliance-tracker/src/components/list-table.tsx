import { useState, type ReactNode } from "react";
import { ArrowUpDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  ColumnFilterChoices, ColumnHeader, ColumnSearch, dateSortOptions, textSortOptions, type ColumnSortOption,
} from "@/components/column-header";
import { sortByLabel } from "@/lib/sort-options";
import { matchesSearch, sortRows, type SortState, type SortValue } from "@/lib/table-sort";

/**
 * One column of a list table whose heading people click to sort, filter or
 * search. Columns with neither `sort` nor `filter` render as a plain heading.
 *
 * - `sort: "text"` sorts A to Z / Z to A, `"date"` newest / oldest first,
 *   `"number"` low / high, or give your own two labels as `[ascLabel, descLabel]`.
 * - `filter: "choice"` shows a dropdown-style list of the values found in the
 *   column (A to Z, or in `choiceOrder` when the order means something, such as
 *   priority); `"search"` shows a search box; `"date"` shows a from/to range.
 */
export interface ListColumn<T> {
  key: string;
  label: string;
  /** Classes for the heading cell (keep the table's own th classes here). */
  className?: string;
  /** The value sorted, and searched or matched by the filter unless `filterValue` is given. */
  value?: (row: T) => SortValue;
  sort?: "text" | "date" | "number" | readonly [asc: string, desc: string];
  filter?: "choice" | "search" | "date";
  /** What the filter matches against, when it differs from `value` (e.g. a status code). */
  filterValue?: (row: T) => string | null | undefined;
  /** Label for a choice value. */
  choiceLabel?: (value: string) => string;
  /** Meaningful order for choices (e.g. Low, Medium, High); otherwise A to Z. */
  choiceOrder?: readonly string[];
  /** Placeholder for a search box. */
  searchPlaceholder?: string;
}

type ColumnFilter = string | { from: string; to: string };

const asText = (v: SortValue) => (v === null || v === undefined ? "" : String(v));
/** The YYYY-MM-DD part of a date value, for the from/to range. */
const dayOf = (v: SortValue) => asText(v).slice(0, 10);

function sortOptionsFor<T>(column: ListColumn<T>): ColumnSortOption[] {
  const { key, sort } = column;
  if (!sort) return [];
  if (sort === "text") return textSortOptions(key);
  if (sort === "date") return dateSortOptions(key);
  if (sort === "number") return [{ key, dir: "asc", label: "Lowest first" }, { key, dir: "desc", label: "Highest first" }];
  return [{ key, dir: "asc", label: sort[0] }, { key, dir: "desc", label: sort[1] }];
}

function isActive(filter: ColumnFilter | undefined) {
  if (!filter) return false;
  if (typeof filter === "string") return filter.trim() !== "" && filter !== "all";
  return !!(filter.from || filter.to);
}

/**
 * Sorting, filtering and searching for a list table. Render the headings with
 * `<ListTableHeadings table={…} />`, the body from `table.rows`, and
 * `<ListTableNoMatches table={…} colSpan={…} />` for when filters hide every row.
 */
export function useListTable<T>(
  rows: readonly T[] | null | undefined,
  columns: ListColumn<T>[],
  options: { defaultSort?: SortState | null } = {},
) {
  const [sort, setSort] = useState<SortState | null>(options.defaultSort ?? null);
  const [filters, setFilters] = useState<Record<string, ColumnFilter>>({});
  const source = rows ?? [];

  // Worked out on every render: lists are short, and columns often read page data (site names…).
  const result = (() => {
    let out = [...source];
    for (const column of columns) {
      const filter = filters[column.key];
      if (!column.filter || !isActive(filter)) continue;
      const read = column.filterValue ?? column.value;
      if (!read) continue;
      if (column.filter === "date" && typeof filter === "object") {
        out = out.filter(row => {
          const day = dayOf(read(row));
          return (!filter.from || (!!day && day >= filter.from)) && (!filter.to || (!!day && day <= filter.to));
        });
      } else if (column.filter === "choice") {
        out = out.filter(row => asText(read(row)) === filter);
      } else if (typeof filter === "string") {
        out = out.filter(row => matchesSearch(asText(read(row)), filter));
      }
    }
    const accessors = Object.fromEntries(columns.filter(c => c.sort && c.value).map(c => [c.key, c.value!]));
    return sortRows(out, sort, accessors);
  })();

  const activeFilters = columns.filter(c => c.filter && isActive(filters[c.key])).length;

  return {
    columns,
    rows: result,
    totalCount: source.length,
    sort,
    setSort,
    filters,
    setFilter: (key: string, value: ColumnFilter | undefined) =>
      setFilters(current => {
        const next = { ...current };
        if (value === undefined) delete next[key];
        else next[key] = value;
        return next;
      }),
    activeFilters,
    clearFilters: () => setFilters({}),
    /** Values found in a choice column, for building its list. */
    choicesFor: (column: ListColumn<T>) => {
      const read = column.filterValue ?? column.value;
      const found = new Set<string>();
      for (const row of source) {
        const v = read ? asText(read(row)) : "";
        if (v) found.add(v);
      }
      // Keep the current choice listed even if no row has it any more.
      const current = filters[column.key];
      if (typeof current === "string" && isActive(current)) found.add(current);
      const label = column.choiceLabel ?? ((v: string) => v);
      const values = column.choiceOrder
        ? [...column.choiceOrder.filter(v => found.has(v)), ...sortByLabel([...found].filter(v => !column.choiceOrder!.includes(v)), label)]
        : sortByLabel([...found], label);
      return values.map(v => ({ value: v, label: label(v) }));
    },
  };
}

export type ListTable<T> = ReturnType<typeof useListTable<T>>;

/** The heading cells (<th>) for a list table; put them inside the table's header <tr>. */
export function ListTableHeadings<T>({ table }: { table: ListTable<T> }) {
  return (
    <>
      {table.columns.map(column => {
        const sortOptions = sortOptionsFor(column);
        if (!sortOptions.length && !column.filter) {
          return (
            <th key={column.key} className={column.className ?? "text-left px-4 py-3 font-medium text-muted-foreground text-xs uppercase tracking-wider"}>
              {column.label}
            </th>
          );
        }
        const filter = table.filters[column.key];
        let controls: ReactNode = null;
        if (column.filter === "choice") {
          controls = (
            <ColumnFilterChoices
              label={column.label}
              value={typeof filter === "string" ? filter : "all"}
              allLabel="All"
              options={table.choicesFor(column)}
              onChange={v => table.setFilter(column.key, v === "all" ? undefined : v)}
            />
          );
        } else if (column.filter === "search") {
          controls = (
            <ColumnSearch
              label={`Search ${column.label.toLowerCase()}`}
              placeholder={column.searchPlaceholder}
              value={typeof filter === "string" ? filter : ""}
              onChange={v => table.setFilter(column.key, v)}
            />
          );
        } else if (column.filter === "date") {
          const range = typeof filter === "object" ? filter : { from: "", to: "" };
          controls = (
            <>
              <p className="text-xs font-semibold text-muted-foreground">Between</p>
              <Input type="date" aria-label={`${column.label} from`} value={range.from}
                onChange={e => table.setFilter(column.key, { ...range, from: e.target.value })} className="h-8 rounded-sm" />
              <Input type="date" aria-label={`${column.label} to`} value={range.to}
                onChange={e => table.setFilter(column.key, { ...range, to: e.target.value })} className="h-8 rounded-sm" />
            </>
          );
        }
        return (
          <ColumnHeader
            key={column.key}
            label={column.label}
            className={column.className}
            sortOptions={sortOptions}
            sort={table.sort}
            onSortChange={table.setSort}
            filterActive={isActive(filter)}
            onClearFilter={() => table.setFilter(column.key, undefined)}
          >
            {controls}
          </ColumnHeader>
        );
      })}
    </>
  );
}

/** A body row shown when the column filters hide every row, with a way to clear them. */
export function ListTableNoMatches<T>({ table, colSpan }: { table: ListTable<T>; colSpan: number }) {
  if (table.rows.length > 0 || table.totalCount === 0) return null;
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-6 text-center text-sm text-muted-foreground">
        Nothing matches the column filters.{" "}
        <button type="button" onClick={table.clearFilters} className="font-medium text-primary underline underline-offset-2">
          Clear filters
        </button>
      </td>
    </tr>
  );
}

/**
 * "Sort by" dropdown for lists shown as cards rather than a table, where there
 * are no column headings to click. Each option is one way to order the list.
 */
export function ListSortSelect({ value, options, onChange, className }: {
  value: SortState | null;
  options: ColumnSortOption[];
  onChange: (sort: SortState) => void;
  className?: string;
}) {
  const id = (o: { key: string; dir: string }) => `${o.key}:${o.dir}`;
  const current = value ? options.find(o => id(o) === id(value)) : undefined;
  return (
    <Select
      value={current ? id(current) : undefined}
      onValueChange={v => {
        const option = options.find(o => id(o) === v);
        if (option) onChange({ key: option.key, dir: option.dir });
      }}
    >
      <SelectTrigger aria-label="Sort list" className={cn("bg-card", className)}>
        <ArrowUpDown className="w-3.5 h-3.5 mr-2 text-muted-foreground shrink-0" aria-hidden="true" />
        <SelectValue placeholder="Sort by" />
      </SelectTrigger>
      <SelectContent>
        {options.map(o => <SelectItem key={id(o)} value={id(o)}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
