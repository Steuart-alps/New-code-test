import { useState } from "react";
import { useParams, Link, useLocation } from "wouter";
import { AppLayout } from "@/components/layout";
import {
  useGetContractor,
  useListComplianceItems
} from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-app-data";
import { ContractorFormDialog } from "@/components/contractor-form-dialog";
import { ItemFormDialog } from "@/components/item-form-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusBadge, PriorityBadge } from "@/components/badges";
import { format } from "date-fns";
import {
  Building, Mail, Phone, MapPin, Pencil, Trash2, ArrowLeft,
  Plus, ShieldCheck
} from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, 
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from "@/components/ui/alert-dialog";

export default function ContractorDetailPage() {
  const params = useParams();
  const id = parseInt(params.id || "0");

  const [, navigate] = useLocation();
  const { data: contractor, isLoading: loadingContractor } = useGetContractor(id);
  const { data: items = [] } = useListComplianceItems({ contractorId: id, type: "external" });

  const { deleteContractor, deleteItem } = useAppMutations();

  const [isEditContractorOpen, setIsEditContractorOpen] = useState(false);
  const [deleteContractorConfirm, setDeleteContractorConfirm] = useState(false);

  const [itemFormOpen, setItemFormOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<any>(null);

  if (loadingContractor) return <AppLayout title="Contractor Detail"><div className="animate-spin w-8 h-8 mx-auto mt-20 border-2 border-primary border-t-transparent rounded-full" /></AppLayout>;
  if (!contractor) return <AppLayout title="Not Found"><div>Contractor not found</div></AppLayout>;

  return (
    <AppLayout title="Contractor Profile">
      <div className="mb-6">
        <Link href="/contractors" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-primary transition-colors">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to Contractors
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Sidebar Profile */}
        <div className="lg:col-span-1 space-y-6">
          <Card className="p-6 bg-card/60 backdrop-blur-md shadow-lg border-border/50">
            <div className="flex justify-between items-start mb-6">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-primary/60 text-primary-foreground flex items-center justify-center text-2xl font-bold shadow-lg shadow-primary/20">
                {contractor.name.charAt(0).toUpperCase()}
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="icon" onClick={() => setIsEditContractorOpen(true)}>
                  <Pencil className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setDeleteContractorConfirm(true)}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
            
            <h2 className="text-2xl font-display font-bold">{contractor.name}</h2>
            {contractor.company && (
              <div className="flex items-center mt-2 text-muted-foreground">
                <Building className="w-4 h-4 mr-2" />
                <span className="font-medium">{contractor.company}</span>
              </div>
            )}
            
            <div className="mt-6 space-y-4 pt-6 border-t border-border/50">
              <div className="flex items-start">
                <Mail className="w-4 h-4 mr-3 mt-0.5 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Email</p>
                  <p className="text-sm font-medium">{contractor.email}</p>
                </div>
              </div>
              {contractor.phone && (
                <div className="flex items-start">
                  <Phone className="w-4 h-4 mr-3 mt-0.5 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Phone</p>
                    <p className="text-sm font-medium">{contractor.phone}</p>
                  </div>
                </div>
              )}
              {contractor.address && (
                <div className="flex items-start">
                  <MapPin className="w-4 h-4 mr-3 mt-0.5 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Address</p>
                    <p className="text-sm font-medium">{contractor.address}</p>
                  </div>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Main Content Areas */}
        <div className="lg:col-span-2 space-y-6">
          
          {/* Compliance Items Section */}
          <Card className="shadow-lg border-border/50 overflow-hidden">
            <div className="p-6 bg-muted/20 border-b border-border/50 flex justify-between items-center">
              <div>
                <h3 className="font-display text-lg font-bold flex items-center gap-2">
                  <ShieldCheck className="w-5 h-5 text-emerald-500" /> Compliance Checks
                </h3>
                <p className="text-sm text-muted-foreground mt-1">External requirements assigned to this contractor — click any check to view details &amp; certificates</p>
              </div>
              <Button size="sm" onClick={() => { setEditingItem(null); setItemFormOpen(true); }} className="shadow-sm">
                <Plus className="w-4 h-4 mr-1.5" /> Add Requirement
              </Button>
            </div>
            <div className="p-0">
              {items.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  No compliance requirements assigned.
                </div>
              ) : (
                <div className="divide-y divide-border/50">
                  {items.map(item => (
                    <div
                      key={item.id}
                      role="link"
                      tabIndex={0}
                      aria-label={`View details for ${item.title}`}
                      className="p-4 hover:bg-muted/30 transition-colors flex justify-between items-center group cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40"
                      onClick={() => navigate(`/items/${item.id}`)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          navigate(`/items/${item.id}`);
                        }
                      }}
                    >
                      <div>
                        <h4 className="font-semibold hover:text-primary transition-colors">{item.title}</h4>
                        <div className="flex items-center gap-3 mt-2 text-sm">
                          <StatusBadge status={item.status} />
                          <PriorityBadge priority={item.priority} />
                          {item.dueDate && (
                            <span className="text-muted-foreground flex items-center">
                              Due: {format(new Date(item.dueDate), "MMM d, yyyy")}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" size="icon" onClick={() => { setEditingItem(item); setItemFormOpen(true); }}>
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="text-destructive" onClick={() => deleteItem.mutate({ id: item.id })}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
          
        </div>
      </div>

      <ContractorFormDialog isOpen={isEditContractorOpen} onClose={() => setIsEditContractorOpen(false)} contractor={contractor} />
      <ItemFormDialog isOpen={itemFormOpen} onClose={() => setItemFormOpen(false)} item={editingItem} />

      <AlertDialog open={deleteContractorConfirm} onOpenChange={setDeleteContractorConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Contractor?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {contractor.name}. Compliance items will lose their assignment but won't be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                deleteContractor.mutate({ id });
                window.location.href = "/contractors";
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
