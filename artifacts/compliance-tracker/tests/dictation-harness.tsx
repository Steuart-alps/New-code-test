import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useForm } from "react-hook-form";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CoshhSpeakListDialog } from "../src/components/coshh-speak-list-dialog";
import { Button } from "../src/components/ui/button";
import { Input } from "../src/components/ui/input";
import { Label } from "../src/components/ui/label";
import { Textarea } from "../src/components/ui/textarea";
import { Toaster } from "../src/components/ui/toaster";
import "../src/index.css";

declare global {
  interface Window { __added: Array<{ siteId: number; names: string[] }> }
}
window.__added = [];

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

// A box held in React state, like most track forms.
function StateBox() {
  const [value, setValue] = useState("Existing note");
  return (
    <div className="space-y-1">
      <Label htmlFor="state-notes">State notes</Label>
      <Textarea id="state-notes" value={value} maxLength={80} onChange={(e) => setValue(e.target.value)} />
      <output data-testid="state-value">{value}</output>
    </div>
  );
}

// A box registered with react-hook-form, like the contractor and certificate forms.
function HookFormBox() {
  const form = useForm({ defaultValues: { notes: "" } });
  const [saved, setSaved] = useState<string | null>(null);
  return (
    <form className="space-y-1" onSubmit={form.handleSubmit((data) => setSaved(data.notes))}>
      <Label htmlFor="form-notes">Form notes</Label>
      <Textarea id="form-notes" {...form.register("notes")} />
      <Button type="submit">Save form</Button>
      <output data-testid="form-value">{saved ?? ""}</output>
    </form>
  );
}

function ListDialog() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open list</Button>
      <CoshhSpeakListDialog
        open={open}
        defaultSiteId="1"
        existing={[{ siteId: 1, productName: "Thick bleach", status: "in_use" }]}
        onClose={() => setOpen(false)}
        onAdd={async (siteId, names) => {
          window.__added.push({ siteId, names });
          return names.filter((name) => /^fail/i.test(name));
        }}
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <div className="max-w-lg space-y-6 p-6">
      <StateBox />
      <HookFormBox />
      <div className="space-y-1">
        <Label htmlFor="product">Product name</Label>
        <Input id="product" dictation defaultValue="" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="locked">Locked notes</Label>
        <Textarea id="locked" disabled defaultValue="Read only" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="plain">Plain notes</Label>
        <Textarea id="plain" dictation={false} />
      </div>
      <ListDialog />
    </div>
    <Toaster />
  </QueryClientProvider>,
);
