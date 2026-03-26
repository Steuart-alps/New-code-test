import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateCategory,
  useDeleteCategory,
  useCreateComplianceItem,
  useUpdateComplianceItem,
  useDeleteComplianceItem,
  useUpdateComplianceItemStatus,
  getListCategoriesQueryKey,
  getListComplianceItemsQueryKey,
  getGetDashboardStatsQueryKey,
  getGetComplianceItemQueryKey,
  ListComplianceItemsParams
} from "@workspace/api-client-react";

/**
 * Wrappers for Orval hooks that automatically invalidate related queries 
 * to keep the UI perfectly synced with the backend state.
 */

export function useAppMutations() {
  const queryClient = useQueryClient();

  const invalidateItems = () => {
    queryClient.invalidateQueries({ queryKey: getListComplianceItemsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
  };

  const invalidateItem = (id: number) => {
    queryClient.invalidateQueries({ queryKey: getGetComplianceItemQueryKey(id) });
    invalidateItems();
  };

  const invalidateCategories = () => {
    queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
    // Also invalidate items since category info is joined
    invalidateItems(); 
  };

  // Category Mutations
  const createCategory = useCreateCategory({
    mutation: { onSuccess: invalidateCategories }
  });
  
  const deleteCategory = useDeleteCategory({
    mutation: { onSuccess: invalidateCategories }
  });

  // Compliance Item Mutations
  const createItem = useCreateComplianceItem({
    mutation: { onSuccess: invalidateItems }
  });

  const updateItem = useUpdateComplianceItem({
    mutation: { 
      onSuccess: (data) => invalidateItem(data.id) 
    }
  });

  const deleteItem = useDeleteComplianceItem({
    mutation: { onSuccess: invalidateItems }
  });

  const updateItemStatus = useUpdateComplianceItemStatus({
    mutation: { 
      onSuccess: (data) => invalidateItem(data.id) 
    }
  });

  return {
    createCategory,
    deleteCategory,
    createItem,
    updateItem,
    deleteItem,
    updateItemStatus
  };
}
