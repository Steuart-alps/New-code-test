import { useState } from "react";
import { AppLayout } from "@/components/layout";
import { useListCategories } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-app-data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Trash2, Tags, Plus } from "lucide-react";
import { 
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter 
} from "@/components/ui/dialog";

export default function CategoriesPage() {
  const { data: categories = [], isLoading } = useListCategories();
  const { createCategory, deleteCategory } = useAppMutations();
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#6366f1");

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await createCategory.mutateAsync({ data: { name, color } });
    setIsOpen(false);
    setName("");
  };

  return (
    <AppLayout title="Categories">
      <div className="flex justify-between items-center mb-6">
        <p className="text-muted-foreground hidden sm:block">Manage tags used to group compliance items.</p>
        <Button onClick={() => setIsOpen(true)} className="shadow-lg shadow-primary/20 w-full sm:w-auto">
          <Plus className="w-4 h-4 mr-2" /> Create Category
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading ? (
          <div className="col-span-full py-12 flex justify-center"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div>
        ) : categories.length === 0 ? (
          <div className="col-span-full py-12 text-center text-muted-foreground bg-card rounded-xl border border-dashed">
            <Tags className="w-8 h-8 mx-auto mb-3 opacity-20" />
            No categories defined yet.
          </div>
        ) : (
          categories.map(cat => (
            <Card key={cat.id} className="p-5 flex justify-between items-center bg-card shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-center gap-3">
                <div className="w-4 h-4 rounded-full shadow-sm" style={{ backgroundColor: cat.color }} />
                <span className="font-semibold text-lg font-display">{cat.name}</span>
              </div>
              <Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10" onClick={() => deleteCategory.mutate({ id: cat.id })}>
                <Trash2 className="w-4 h-4" />
              </Button>
            </Card>
          ))
        )}
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle className="font-display">Create Category</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} id="cat-form" className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label>Category Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. SOC 2" autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label>Color Tag</Label>
              <div className="flex gap-3 items-center">
                <Input type="color" value={color} onChange={e => setColor(e.target.value)} className="w-12 h-12 p-1 rounded-lg cursor-pointer" />
                <span className="text-sm font-mono text-muted-foreground">{color}</span>
              </div>
            </div>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)} type="button">Cancel</Button>
            <Button type="submit" form="cat-form" disabled={createCategory.isPending}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
