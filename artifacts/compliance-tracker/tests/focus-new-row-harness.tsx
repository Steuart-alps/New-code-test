import { useState } from "react";
import { createRoot } from "react-dom/client";
import { StringListEditor } from "../src/components/string-list-editor";
import { Button } from "../src/components/ui/button";
import { Input } from "../src/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../src/components/ui/select";
import { useFocusNewRow } from "../src/hooks/use-focus-new-row";
import "../src/index.css";

// Names list, as on the incident, FireTrack and KitchenTrack settings.
function Names() {
  const [items, setItems] = useState<string[]>(["Main kitchen"]);
  return <section data-testid="names"><StringListEditor items={items} onChange={setItems} placeholder="Location" /></section>;
}

// A drop-down that is already filled in, then a name (KitchenTrack fridges and freezers).
function Units() {
  const [units, setUnits] = useState([{ type: "fridge", name: "Walk-in" }]);
  const newRow = useFocusNewRow();
  return <section data-testid="units" ref={newRow.ref}>
    {units.map((unit, i) => <div key={i} className="flex gap-2">
      <select aria-label={`Unit ${i + 1} type`} value={unit.type} onChange={e => setUnits(units.map((u, n) => n === i ? { ...u, type: e.target.value } : u))}>
        <option value="fridge">Fridge</option><option value="freezer">Freezer</option>
      </select>
      <Input aria-label={`Unit ${i + 1} name`} value={unit.name} onChange={e => setUnits(units.map((u, n) => n === i ? { ...u, name: e.target.value } : u))} />
    </div>)}
    <Button onClick={() => { newRow.expect(); setUnits([...units, { type: "freezer", name: "" }]); }}>Add freezer</Button>
  </section>;
}

// A row that starts with a date, then a drop-down that starts empty (tank mix products).
function Pickers() {
  const [rows, setRows] = useState([{ date: "2026-10-27", product: "" }]);
  const newRow = useFocusNewRow();
  return <section data-testid="pickers" ref={newRow.ref}>
    {rows.map((row, i) => <div key={i} className="flex gap-2">
      <Input aria-label={`Row ${i + 1} date`} type="date" value={row.date} onChange={e => setRows(rows.map((r, n) => n === i ? { ...r, date: e.target.value } : r))} />
      <Select value={row.product} onValueChange={product => setRows(rows.map((r, n) => n === i ? { ...r, product } : r))}>
        <SelectTrigger aria-label={`Row ${i + 1} product`}><SelectValue placeholder="Select product" /></SelectTrigger>
        <SelectContent><SelectItem value="a">Product A</SelectItem></SelectContent>
      </Select>
    </div>)}
    <Button onClick={() => { newRow.expect(); setRows([...rows, { date: "2026-10-27", product: "" }]); }}>Add product</Button>
  </section>;
}

// An add that is refused (the list is full), then the list reloading by itself.
function Full() {
  const [rows, setRows] = useState(["One"]);
  const newRow = useFocusNewRow();
  return <section data-testid="full" ref={newRow.ref}>
    {rows.map((row, i) => <Input key={i} aria-label={`Full row ${i + 1}`} value={row} onChange={e => setRows(rows.map((r, n) => n === i ? e.target.value : r))} />)}
    <Button onClick={() => { newRow.expect(); if (rows.length < 1) setRows([...rows, ""]); }}>Add full row</Button>
    <Button onClick={() => setRows([...rows, ""])}>Reload list</Button>
  </section>;
}

createRoot(document.getElementById("root")!).render(
  <div className="space-y-6 p-4">
    <Names />
    <Units />
    <Pickers />
    <Full />
  </div>,
);
