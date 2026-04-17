import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  useCreateComplianceItem,
  useUpdateComplianceItem,
  useDeleteComplianceItem,
  useUpdateComplianceItemStatus,
  getListComplianceItemsQueryKey,
  useCreateCategory,
  useUpdateCategory,
  useDeleteCategory,
  getListCategoriesQueryKey,
  getGetCategoryQueryKey,
  useCreateSite,
  useUpdateSite,
  useDeleteSite,
  getListSitesQueryKey,
  getGetSiteQueryKey,
  useCreateContractor,
  useUpdateContractor,
  useDeleteContractor,
  getListContractorsQueryKey,
  getGetContractorQueryKey,
  useCreateCertificate,
  useUpdateCertificate,
  useDeleteCertificate,
  getListCertificatesQueryKey,
  useUpdateSettings,
  getGetSettingsQueryKey,
  useSendReminders,
  useTestEmail
} from "@workspace/api-client-react";

export function useAppMutations() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const invalidateComplianceItems = () => {
    queryClient.invalidateQueries({ queryKey: [getListComplianceItemsQueryKey()[0]] });
    queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
  };

  const createItem = useCreateComplianceItem({
    mutation: {
      onSuccess: () => {
        invalidateComplianceItems();
        toast({ title: "Item created", description: "Compliance item created successfully." });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const updateItem = useUpdateComplianceItem({
    mutation: {
      onSuccess: () => {
        invalidateComplianceItems();
        toast({ title: "Item updated", description: "Compliance item updated successfully." });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const updateItemStatus = useUpdateComplianceItemStatus({
    mutation: {
      onSuccess: () => {
        invalidateComplianceItems();
        toast({ title: "Status updated", description: "Status changed successfully." });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const deleteItem = useDeleteComplianceItem({
    mutation: {
      onSuccess: () => {
        invalidateComplianceItems();
        toast({ title: "Item deleted", description: "Compliance item deleted successfully." });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const createCategory = useCreateCategory({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
        toast({ title: "Category created" });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const updateCategory = useUpdateCategory({
    mutation: {
      onSuccess: (_, { id }) => {
        queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetCategoryQueryKey(id) });
        toast({ title: "Category updated" });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const deleteCategory = useDeleteCategory({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
        queryClient.invalidateQueries({ queryKey: [getListSitesQueryKey()[0]] });
        toast({ title: "Category deleted" });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const invalidateSites = () => {
    queryClient.invalidateQueries({ queryKey: [getListSitesQueryKey()[0]] });
    invalidateComplianceItems();
  };

  const createSite = useCreateSite({
    mutation: {
      onSuccess: () => { invalidateSites(); toast({ title: "Site created" }); },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const updateSite = useUpdateSite({
    mutation: {
      onSuccess: (_, { id }) => {
        invalidateSites();
        queryClient.invalidateQueries({ queryKey: getGetSiteQueryKey(id) });
        toast({ title: "Site updated" });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const deleteSite = useDeleteSite({
    mutation: {
      onSuccess: () => { invalidateSites(); toast({ title: "Site deleted" }); },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const createContractor = useCreateContractor({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListContractorsQueryKey() });
        toast({ title: "Contractor added" });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const updateContractor = useUpdateContractor({
    mutation: {
      onSuccess: (_, { id }) => {
        queryClient.invalidateQueries({ queryKey: getListContractorsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetContractorQueryKey(id) });
        toast({ title: "Contractor updated" });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const deleteContractor = useDeleteContractor({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListContractorsQueryKey() });
        toast({ title: "Contractor deleted" });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const createCertificate = useCreateCertificate({
    mutation: {
      onSuccess: (_, { contractorId }) => {
        queryClient.invalidateQueries({ queryKey: getListCertificatesQueryKey(contractorId) });
        queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
        toast({ title: "Certificate uploaded" });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const updateCertificate = useUpdateCertificate({
    mutation: {
      onSuccess: (_, { contractorId }) => {
        queryClient.invalidateQueries({ queryKey: getListCertificatesQueryKey(contractorId) });
        toast({ title: "Certificate updated" });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const deleteCertificate = useDeleteCertificate({
    mutation: {
      onSuccess: (_, { contractorId }) => {
        queryClient.invalidateQueries({ queryKey: getListCertificatesQueryKey(contractorId) });
        queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
        toast({ title: "Certificate deleted" });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const updateSettings = useUpdateSettings({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        toast({ title: "Settings saved", description: "Application settings updated successfully." });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const triggerReminders = useSendReminders({
    mutation: {
      onSuccess: (data) => {
        toast({ 
          title: "Reminders processed", 
          description: `Sent: ${data.sent}, Skipped: ${data.skipped}, Errors: ${data.errors}` 
        });
      },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const triggerTestEmail = useTestEmail({
    mutation: {
      onSuccess: (data) => {
        if (data.success) {
          toast({ title: "Test Email Sent", description: data.message });
        } else {
          toast({ title: "Failed to send", description: data.message, variant: "destructive" });
        }
      },
      onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
    }
  });

  return {
    createItem,
    updateItem,
    updateItemStatus,
    deleteItem,
    createCategory,
    updateCategory,
    deleteCategory,
    createSite,
    updateSite,
    deleteSite,
    createContractor,
    updateContractor,
    deleteContractor,
    createCertificate,
    updateCertificate,
    deleteCertificate,
    updateSettings,
    triggerReminders,
    triggerTestEmail
  };
}
