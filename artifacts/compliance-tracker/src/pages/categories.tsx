import { useState } from "react";
import { AppLayout } from "@/components/layout";
import { useListCategories } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-app-data";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Trash2, Tags, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

export default function CategoriesPage() {
  const { data: categories, isLoading } = useListCategories();
  const { createCategory, deleteCategory } = useAppMutations();
  const { toast } = useToast();
  
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#2563eb");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setIsSubmitting(true);
    try {
      await createCategory.mutateAsync({ data: { name, color } });
      toast({ title: "Category created" });
      setIsAddOpen(false);
      setName("");
      setColor("#2563eb");
    } catch (err: any) {
      toast({ title: "Failed to create", description: err.message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Are you sure you want to delete this category?")) return;
    try {
      await deleteCategory.mutateAsync({ id });
      toast({ title: "Category deleted" });
    } catch (err: any) {
      toast({ title: "Failed to delete", description: "It may be in use by existing items.", variant: "destructive" });
    }
  };

  return (
    <AppLayout title="Categories">
      <div className="flex justify-between items-center mb-8">
        <div>
          <p className="text-muted-foreground mt-1">Manage tags used to organize compliance items.</p>
        </div>
        <Button onClick={() => setIsAddOpen(true)} className="rounded-xl shadow-lg shadow-primary/20">
          <Plus className="w-4 h-4 mr-2" /> Add Category
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-12">
          <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {categories?.map((cat) => (
            <Card key={cat.id} className="overflow-hidden border-0 shadow-md hover:shadow-lg transition-shadow group relative">
              <div 
                className="h-2 w-full absolute top-0 left-0" 
                style={{ backgroundColor: cat.color }}
              />
              <CardContent className="p-6 pt-8 relative">
                <div className="flex justify-between items-start">
                  <div className="flex items-center gap-3">
                    <div 
                      className="w-10 h-10 rounded-full flex items-center justify-center bg-opacity-10"
                      style={{ backgroundColor: `${cat.color}15`, color: cat.color }}
                    >
                      <Tags className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-lg">{cat.name}</h3>
                      <p className="text-xs text-muted-foreground mt-0.5">Created {new Date(cat.createdAt).toLocaleDateString()}</p>
                    </div>
                  </div>
                </div>
                
                <button 
                  onClick={() => handleDelete(cat.id)}
                  className="absolute top-4 right-4 p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-full opacity-0 group-hover:opacity-100 transition-all focus:opacity-100 outline-none"
                  aria-label="Delete category"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </CardContent>
            </Card>
          ))}
          
          {categories?.length === 0 && (
            <div className="col-span-full py-12 text-center text-muted-foreground bg-card rounded-2xl border border-dashed border-border">
              <Tags className="w-12 h-12 mx-auto opacity-20 mb-3" />
              <p className="font-medium text-foreground">No categories yet</p>
              <p className="text-sm mt-1">Create one to start organizing your items.</p>
            </div>
          )}
        </div>
      )}

      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-[425px] rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-2xl font-display">New Category</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-6 mt-4">
            <div className="space-y-2">
              <Label htmlFor="name">Category Name</Label>
              <Input 
                id="name" 
                value={name} 
                onChange={e => setName(e.target.value)} 
                placeholder="e.g. HR, Security, Finance"
                autoFocus
                className="bg-muted/50 rounded-xl"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="color">Label Color</Label>
              <div className="flex gap-4">
                <input 
                  type="color" 
                  id="color" 
                  value={color} 
                  onChange={e => setColor(e.target.value)}
                  className="w-12 h-12 p-1 rounded-xl cursor-pointer bg-muted/50 border border-input"
                />
                <Input 
                  value={color}
                  onChange={e => setColor(e.target.value)}
                  className="flex-1 font-mono uppercase bg-muted/50 rounded-xl"
                />
              </div>
            </div>
            <DialogFooter className="pt-4 border-t border-border">
              <Button type="button" variant="ghost" onClick={() => setIsAddOpen(false)} className="rounded-xl">Cancel</Button>
              <Button type="submit" disabled={isSubmitting || !name.trim()} className="rounded-xl shadow-lg shadow-primary/20">
                {isSubmitting ? "Creating..." : "Create Category"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
