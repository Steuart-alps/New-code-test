export interface TemperatureFormValues {
  coldFood: { tempAm: string; tempPm: string }[];
  delivery: {
    supplier: string;
    items: string;
    tempChilled: string;
    tempFrozen: string;
    correctiveActions: string;
  };
  hotHolding: { item: string; coreTemp: string; timeOfCheck: string };
  cooking: { item: string; coreTemp: string; timeStart: string; timeFinish: string };
  cooling: { item: string; coreTemp: string; timeStart: string; timeFinish: string };
  reheating: { item: string; coreTemp: string; timeStart: string; timeFinish: string };
  correctives: string;
}

export interface TemperatureSectionVisibility {
  deliveries: boolean;
  hotHolding: boolean;
  cooking: boolean;
  cooling: boolean;
  reheating: boolean;
}

export function hasAnyValue(row: object): boolean {
  return Object.values(row).some((value) => typeof value === 'string' && !!value.trim());
}

export function shouldIncludeHotHolding(
  row: TemperatureFormValues['hotHolding'],
): boolean {
  return !!(row.item.trim() || row.coreTemp.trim());
}

export function canSaveTemperatureForm(
  values: TemperatureFormValues,
  visible: TemperatureSectionVisibility,
): boolean {
  return (
    values.coldFood.some((row) => row.tempAm.trim() || row.tempPm.trim()) ||
    (visible.deliveries && hasAnyValue(values.delivery)) ||
    (visible.hotHolding && shouldIncludeHotHolding(values.hotHolding)) ||
    (visible.cooking && hasAnyValue(values.cooking)) ||
    (visible.cooling && hasAnyValue(values.cooling)) ||
    (visible.reheating && hasAnyValue(values.reheating)) ||
    !!values.correctives.trim()
  );
}