import { useState } from "react";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout";
import { useListContractors } from "@workspace/api-client-react";
import { ContractorFormDialog } from "@/components/contractor-form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, Building, Mail, Phone, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";

export default function ContractorsPage() {
  const [search, setSearch] = useState("");
  const [isFormOpen, setIsFormOpen] = useState(false);

  const { data: contractors = [], isLoading } = useListContractors();

  const filtered = contractors.filter(c => 
    c.name.toLowerCase().includes(search.toLowerCase()) || 
    (c.company && c.company.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <AppLayout title="Contractors">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input 
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search contractors..." 
            className="pl-9 bg-card shadow-sm"
          />
        </div>
        <Button onClick={() => setIsFormOpen(true)} className="shadow-lg shadow-primary/20 w-full sm:w-auto">
          <Plus className="w-4 h-4 mr-2" /> Add Contractor
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-24 bg-card rounded-2xl border border-dashed border-border/60">
          <Building className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
          <h3 className="text-lg font-semibold">No contractors found</h3>
          <p className="text-muted-foreground mt-1 max-w-sm mx-auto">Add your external contractors here to track their compliance and certificates.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(contractor => (
            <Link key={contractor.id} href={`/contractors/${contractor.id}`}>
              <Card className="p-5 hover:shadow-xl hover:border-primary/30 transition-all duration-300 cursor-pointer group bg-card/60 backdrop-blur-sm border-border/50 h-full flex flex-col">
                <div className="flex justify-between items-start mb-4">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-lg">
                    {contractor.name.charAt(0).toUpperCase()}
                  </div>
                  <ChevronRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors transform group-hover:translate-x-1" />
                </div>
                <h3 className="font-display font-semibold text-lg">{contractor.name}</h3>
                {contractor.company && <p className="text-sm text-muted-foreground mt-0.5">{contractor.company}</p>}
                
                <div className="mt-auto pt-5 space-y-2">
                  <div className="flex items-center text-sm text-muted-foreground">
                    <Mail className="w-4 h-4 mr-2 opacity-70" /> {contractor.email}
                  </div>
                  {contractor.phone && (
                    <div className="flex items-center text-sm text-muted-foreground">
                      <Phone className="w-4 h-4 mr-2 opacity-70" /> {contractor.phone}
                    </div>
                  )}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <ContractorFormDialog 
        isOpen={isFormOpen} 
        onClose={() => setIsFormOpen(false)} 
      />
    </AppLayout>
  );
}
