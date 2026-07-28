import { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout";
import {
  useGetFoodSafetyConfig,
  getGetFoodSafetyConfigQueryKey,
  useUpdateFoodSafetyConfig,
  useListFoodSafetyRecords,
  getListFoodSafetyRecordsQueryKey,
  useGetFoodSafetyRecordByDate,
  getGetFoodSafetyRecordByDateQueryKey,
  useCreateFoodSafetyRecord,
  useUpdateFoodSafetyRecord,
  FoodSafetyRecord,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { UtensilsCrossed, Settings, Plus, Trash2, CheckCircle2, Calendar, Save } from "lucide-react";
import { cn } from "@/lib/utils";

type DeliveryRow = { supplier: string; item: string; temp: string; ok: boolean };
type ColdFoodRow = { unit: string; temp: string; ok: boolean };
type HotTemperatureRow = { item: string; temp: string };
type HotHoldingRow = { item: string; temp: string };

function ConfigDialog() {
  const [open, setOpen] = useState(false);
  const { data: config } = useGetFoodSafetyConfig();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateConfig = useUpdateFoodSafetyConfig();

  const [numFridges, setNumFridges] = useState("");
  const [numFreezers, setNumFreezers] = useState("");
  const [cookingLimit, setCookingLimit] = useState("");
  const [coolingLimit, setCoolingLimit] = useState("");
  const [reheatingLimit, setReheatingLimit] = useState("");
  const [hotHoldingLimit, setHotHoldingLimit] = useState("");

  useEffect(() => {
    if (config) {
      setNumFridges(config.food_num_fridges || "2");
      setNumFreezers(config.food_num_freezers || "1");
      setCookingLimit(config.food_cooking_limit || "75°C");
      setCoolingLimit(config.food_cooling_limit || "8°C within 90 mins");
      setReheatingLimit(config.food_reheating_limit || "75°C");
      setHotHoldingLimit(config.food_hot_holding_limit || "63°C");
    }
  }, [config]);

  const handleSave = async () => {
    updateConfig.mutate(
      {
        data: {
          food_num_fridges: numFridges,
          food_num_freezers: numFreezers,
          food_cooking_limit: cookingLimit,
          food_cooling_limit: coolingLimit,
          food_reheating_limit: reheatingLimit,
          food_hot_holding_limit: hotHoldingLimit,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetFoodSafetyConfigQueryKey() });
          toast({ title: "Configuration saved" });
          setOpen(false);
        },
        onError: (error: any) => {
          toast({ title: "Failed to save", description: error.message, variant: "destructive" });
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings className="w-4 h-4 mr-2" />
          Configure
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Kitchen Configuration</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Number of Fridges</Label>
              <Input type="number" value={numFridges} onChange={(e) => setNumFridges(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Number of Freezers</Label>
              <Input type="number" value={numFreezers} onChange={(e) => setNumFreezers(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Cooking Temperature Limit</Label>
            <Input value={cookingLimit} onChange={(e) => setCookingLimit(e.target.value)} placeholder="75°C" />
          </div>

          <div className="space-y-1.5">
            <Label>Cooling Limit</Label>
            <Input
              value={coolingLimit}
              onChange={(e) => setCoolingLimit(e.target.value)}
              placeholder="8°C within 90 mins"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Reheating Limit</Label>
            <Input value={reheatingLimit} onChange={(e) => setReheatingLimit(e.target.value)} placeholder="75°C" />
          </div>

          <div className="space-y-1.5">
            <Label>Hot Holding Limit</Label>
            <Input
              value={hotHoldingLimit}
              onChange={(e) => setHotHoldingLimit(e.target.value)}
              placeholder="63°C"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={updateConfig.isPending}>
            {updateConfig.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function KitchenPage() {
  const [selectedDate, setSelectedDate] = useState(format(new Date(), "yyyy-MM-dd"));

  const { data: config } = useGetFoodSafetyConfig();
  const { data: records } = useListFoodSafetyRecords();
  const { data: record, isLoading: recordLoading, error: recordError } = useGetFoodSafetyRecordByDate(selectedDate, {
    query: {
      enabled: !!selectedDate,
      queryKey: getGetFoodSafetyRecordByDateQueryKey(selectedDate),
      retry: false,
    },
  });

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createRecord = useCreateFoodSafetyRecord();
  const updateRecord = useUpdateFoodSafetyRecord();

  const numFridges = Number(config?.food_num_fridges || "2");
  const numFreezers = Number(config?.food_num_freezers || "1");

  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [coldFood, setColdFood] = useState<ColdFoodRow[]>([]);
  const [hotTemperature, setHotTemperature] = useState<HotTemperatureRow[]>([]);
  const [hotHolding, setHotHolding] = useState<HotHoldingRow[]>([]);
  const [correctives, setCorrectives] = useState("");
  const [managerSignature, setManagerSignature] = useState("");

  const cookingLimit = config?.food_cooking_limit || "75°C";
  const coolingLimit = config?.food_cooling_limit || "8°C within 90 mins";
  const reheatingLimit = config?.food_reheating_limit || "75°C";
  const hotHoldingLimit = config?.food_hot_holding_limit || "63°C";

  // Initialize form when record loads or date changes
  useEffect(() => {
    if (record) {
      setDeliveries((record.deliveries || []) as DeliveryRow[]);
      setColdFood((record.coldFood || []) as ColdFoodRow[]);
      setHotTemperature((record.hotTemperature || []) as HotTemperatureRow[]);
      setHotHolding((record.hotHolding || []) as HotHoldingRow[]);
      setCorrectives(record.correctives || "");
      setManagerSignature(record.managerSignature || "");
    } else {
      // New record — pre-generate cold food rows
      const fridgeRows: ColdFoodRow[] = Array.from({ length: numFridges }, (_, i) => ({
        unit: `Fridge ${i + 1}`,
        temp: "",
        ok: true,
      }));
      const freezerRows: ColdFoodRow[] = Array.from({ length: numFreezers }, (_, i) => ({
        unit: `Freezer ${i + 1}`,
        temp: "",
        ok: true,
      }));
      setDeliveries([]);
      setColdFood([...fridgeRows, ...freezerRows]);
      setHotTemperature([]);
      setHotHolding([]);
      setCorrectives("");
      setManagerSignature("");
    }
  }, [record, selectedDate, numFridges, numFreezers]);

  const handleSaveDraft = async () => {
    const data = {
      recordDate: selectedDate,
      deliveries,
      coldFood,
      hotTemperature,
      hotHolding,
      cookingLimit,
      coolingLimit,
      reheatingLimit,
      hotHoldingLimit,
      correctives: correctives || undefined,
      managerSignature: managerSignature || undefined,
      submittedAt: undefined,
    };

    if (record) {
      updateRecord.mutate(
        { id: record.id, data },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getGetFoodSafetyRecordByDateQueryKey(selectedDate) });
            queryClient.invalidateQueries({ queryKey: getListFoodSafetyRecordsQueryKey() });
            toast({ title: "Draft saved" });
          },
          onError: (error: any) => {
            toast({ title: "Failed to save", description: error.message, variant: "destructive" });
          },
        }
      );
    } else {
      createRecord.mutate(
        { data },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getGetFoodSafetyRecordByDateQueryKey(selectedDate) });
            queryClient.invalidateQueries({ queryKey: getListFoodSafetyRecordsQueryKey() });
            toast({ title: "Draft created" });
          },
          onError: (error: any) => {
            toast({ title: "Failed to create", description: error.message, variant: "destructive" });
          },
        }
      );
    }
  };

  const handleSubmit = async () => {
    if (!managerSignature.trim()) {
      toast({ title: "Manager signature required", variant: "destructive" });
      return;
    }

    const data = {
      recordDate: selectedDate,
      deliveries,
      coldFood,
      hotTemperature,
      hotHolding,
      cookingLimit,
      coolingLimit,
      reheatingLimit,
      hotHoldingLimit,
      correctives: correctives || undefined,
      managerSignature,
      submittedAt: new Date().toISOString(),
    };

    if (record) {
      updateRecord.mutate(
        { id: record.id, data },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getGetFoodSafetyRecordByDateQueryKey(selectedDate) });
            queryClient.invalidateQueries({ queryKey: getListFoodSafetyRecordsQueryKey() });
            toast({ title: "Record submitted", description: "Kitchen diary signed off." });
          },
          onError: (error: any) => {
            toast({ title: "Failed to submit", description: error.message, variant: "destructive" });
          },
        }
      );
    } else {
      createRecord.mutate(
        { data },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getGetFoodSafetyRecordByDateQueryKey(selectedDate) });
            queryClient.invalidateQueries({ queryKey: getListFoodSafetyRecordsQueryKey() });
            toast({ title: "Record submitted" });
          },
          onError: (error: any) => {
            toast({ title: "Failed to submit", description: error.message, variant: "destructive" });
          },
        }
      );
    }
  };

  const isSubmitted = !!record?.submittedAt;

  return (
    <AppLayout title="Kitchen Diary">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-primary/10">
              <UtensilsCrossed className="w-6 h-6 text-primary" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">
                Daily food safety record — deliveries, temperatures, corrective actions
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ConfigDialog />
          </div>
        </div>

        {/* Date Picker */}
        <Card>
          <CardHeader className="border-b border-border/50 pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-display">Select Date</CardTitle>
              {isSubmitted && (
                <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                  <CheckCircle2 className="w-3 h-3 mr-1" />
                  Submitted
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-4">
            <div className="flex items-center gap-4">
              <Label className="text-sm">Date:</Label>
              <Input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="max-w-xs"
              />
            </div>
          </CardContent>
        </Card>

        {recordLoading ? (
          <Card>
            <CardContent className="p-12 flex justify-center">
              <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Deliveries */}
            <Card>
              <CardHeader className="border-b border-border/50 pb-4">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base font-display">Deliveries</CardTitle>
                    <CardDescription className="text-xs mt-1">Record supplier deliveries received today</CardDescription>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setDeliveries([...deliveries, { supplier: "", item: "", temp: "", ok: true }])}
                    disabled={isSubmitted}
                  >
                    <Plus className="w-3.5 h-3.5 mr-1.5" />
                    Add
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="p-4 space-y-2">
                {deliveries.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">No deliveries recorded.</p>
                ) : (
                  deliveries.map((row, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2 items-center">
                      <Input
                        placeholder="Supplier"
                        value={row.supplier}
                        onChange={(e) => {
                          const updated = [...deliveries];
                          updated[i].supplier = e.target.value;
                          setDeliveries(updated);
                        }}
                        disabled={isSubmitted}
                        className="col-span-3"
                      />
                      <Input
                        placeholder="Item"
                        value={row.item}
                        onChange={(e) => {
                          const updated = [...deliveries];
                          updated[i].item = e.target.value;
                          setDeliveries(updated);
                        }}
                        disabled={isSubmitted}
                        className="col-span-4"
                      />
                      <Input
                        placeholder="Temp (°C)"
                        value={row.temp}
                        onChange={(e) => {
                          const updated = [...deliveries];
                          updated[i].temp = e.target.value;
                          setDeliveries(updated);
                        }}
                        disabled={isSubmitted}
                        className="col-span-2"
                      />
                      <label className="flex items-center gap-2 col-span-2">
                        <input
                          type="checkbox"
                          checked={row.ok}
                          onChange={(e) => {
                            const updated = [...deliveries];
                            updated[i].ok = e.target.checked;
                            setDeliveries(updated);
                          }}
                          disabled={isSubmitted}
                          className="h-4 w-4 rounded border-input accent-primary"
                        />
                        <span className="text-xs">OK</span>
                      </label>
                      {!isSubmitted && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeliveries(deliveries.filter((_, idx) => idx !== i))}
                          className="col-span-1"
                        >
                          <Trash2 className="w-3.5 h-3.5 text-destructive" />
                        </Button>
                      )}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            {/* Cold Food */}
            <Card>
              <CardHeader className="border-b border-border/50 pb-4">
                <CardTitle className="text-base font-display">Cold Food Temperatures</CardTitle>
                <CardDescription className="text-xs mt-1">Check fridge and freezer temperatures</CardDescription>
              </CardHeader>
              <CardContent className="p-4 space-y-2">
                {coldFood.map((row, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2 items-center">
                    <Input
                      placeholder="Unit"
                      value={row.unit}
                      onChange={(e) => {
                        const updated = [...coldFood];
                        updated[i].unit = e.target.value;
                        setColdFood(updated);
                      }}
                      disabled={isSubmitted}
                      className="col-span-5"
                    />
                    <Input
                      placeholder="Temp (°C)"
                      value={row.temp}
                      onChange={(e) => {
                        const updated = [...coldFood];
                        updated[i].temp = e.target.value;
                        setColdFood(updated);
                      }}
                      disabled={isSubmitted}
                      className="col-span-3"
                    />
                    <label className="flex items-center gap-2 col-span-2">
                      <input
                        type="checkbox"
                        checked={row.ok}
                        onChange={(e) => {
                          const updated = [...coldFood];
                          updated[i].ok = e.target.checked;
                          setColdFood(updated);
                        }}
                        disabled={isSubmitted}
                        className="h-4 w-4 rounded border-input accent-primary"
                      />
                      <span className="text-xs">OK</span>
                    </label>
                    {!isSubmitted && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setColdFood(coldFood.filter((_, idx) => idx !== i))}
                        className="col-span-2"
                      >
                        <Trash2 className="w-3.5 h-3.5 text-destructive" />
                      </Button>
                    )}
                  </div>
                ))}
                {!isSubmitted && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setColdFood([...coldFood, { unit: "", temp: "", ok: true }])}
                  >
                    <Plus className="w-3.5 h-3.5 mr-1.5" />
                    Add Row
                  </Button>
                )}
              </CardContent>
            </Card>

            {/* Hot Temperatures */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card>
                <CardHeader className="border-b border-border/50 pb-4">
                  <CardTitle className="text-base font-display">Hot Food Temperatures</CardTitle>
                  <CardDescription className="text-xs mt-1">
                    Cooking: {cookingLimit} | Cooling: {coolingLimit} | Reheating: {reheatingLimit}
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-4 space-y-2">
                  {hotTemperature.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic">No hot food checks recorded.</p>
                  ) : (
                    hotTemperature.map((row, i) => (
                      <div key={i} className="flex gap-2 items-center">
                        <Input
                          placeholder="Item"
                          value={row.item}
                          onChange={(e) => {
                            const updated = [...hotTemperature];
                            updated[i].item = e.target.value;
                            setHotTemperature(updated);
                          }}
                          disabled={isSubmitted}
                          className="flex-1"
                        />
                        <Input
                          placeholder="Temp (°C)"
                          value={row.temp}
                          onChange={(e) => {
                            const updated = [...hotTemperature];
                            updated[i].temp = e.target.value;
                            setHotTemperature(updated);
                          }}
                          disabled={isSubmitted}
                          className="w-32"
                        />
                        {!isSubmitted && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setHotTemperature(hotTemperature.filter((_, idx) => idx !== i))}
                          >
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </Button>
                        )}
                      </div>
                    ))
                  )}
                  {!isSubmitted && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setHotTemperature([...hotTemperature, { item: "", temp: "" }])}
                    >
                      <Plus className="w-3.5 h-3.5 mr-1.5" />
                      Add Row
                    </Button>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="border-b border-border/50 pb-4">
                  <CardTitle className="text-base font-display">Hot Holding</CardTitle>
                  <CardDescription className="text-xs mt-1">Minimum: {hotHoldingLimit}</CardDescription>
                </CardHeader>
                <CardContent className="p-4 space-y-2">
                  {hotHolding.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic">No hot holding checks recorded.</p>
                  ) : (
                    hotHolding.map((row, i) => (
                      <div key={i} className="flex gap-2 items-center">
                        <Input
                          placeholder="Item"
                          value={row.item}
                          onChange={(e) => {
                            const updated = [...hotHolding];
                            updated[i].item = e.target.value;
                            setHotHolding(updated);
                          }}
                          disabled={isSubmitted}
                          className="flex-1"
                        />
                        <Input
                          placeholder="Temp (°C)"
                          value={row.temp}
                          onChange={(e) => {
                            const updated = [...hotHolding];
                            updated[i].temp = e.target.value;
                            setHotHolding(updated);
                          }}
                          disabled={isSubmitted}
                          className="w-32"
                        />
                        {!isSubmitted && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setHotHolding(hotHolding.filter((_, idx) => idx !== i))}
                          >
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </Button>
                        )}
                      </div>
                    ))
                  )}
                  {!isSubmitted && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setHotHolding([...hotHolding, { item: "", temp: "" }])}
                    >
                      <Plus className="w-3.5 h-3.5 mr-1.5" />
                      Add Row
                    </Button>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Correctives */}
            <Card>
              <CardHeader className="border-b border-border/50 pb-4">
                <CardTitle className="text-base font-display">Corrective Actions Taken</CardTitle>
                <CardDescription className="text-xs mt-1">
                  Note any issues found and what was done to fix them
                </CardDescription>
              </CardHeader>
              <CardContent className="p-4">
                <Textarea
                  value={correctives}
                  onChange={(e) => setCorrectives(e.target.value)}
                  rows={3}
                  placeholder="e.g. Fridge 2 running warm — engineer called, stock moved to Fridge 1"
                  disabled={isSubmitted}
                />
              </CardContent>
            </Card>

            {/* Sign-off */}
            <Card>
              <CardHeader className="border-b border-border/50 pb-4">
                <CardTitle className="text-base font-display">Manager Sign-off</CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label>Manager Name (Signature)</Label>
                    <Input
                      value={managerSignature}
                      onChange={(e) => setManagerSignature(e.target.value)}
                      placeholder="Type your name to sign"
                      disabled={isSubmitted}
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    {!isSubmitted && (
                      <>
                        <Button
                          variant="outline"
                          onClick={handleSaveDraft}
                          disabled={createRecord.isPending || updateRecord.isPending}
                        >
                          <Save className="w-4 h-4 mr-2" />
                          Save Draft
                        </Button>
                        <Button
                          onClick={handleSubmit}
                          disabled={createRecord.isPending || updateRecord.isPending}
                          className="shadow-lg shadow-primary/20"
                        >
                          <CheckCircle2 className="w-4 h-4 mr-2" />
                          {createRecord.isPending || updateRecord.isPending ? "Submitting..." : "Submit & Sign"}
                        </Button>
                      </>
                    )}
                    {isSubmitted && (
                      <div className="flex items-center gap-2 text-sm text-emerald-700">
                        <CheckCircle2 className="w-4 h-4" />
                        Submitted on {format(new Date(record.submittedAt!), "dd/MM/yyyy 'at' HH:mm")}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </>
        )}

        {/* History */}
        <Card>
          <CardHeader className="border-b border-border/50 pb-4">
            <CardTitle className="font-display">Recent Records</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {!records || records.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">
                <Calendar className="w-12 h-12 mx-auto mb-3 opacity-20" />
                <p className="text-sm">No kitchen diary records yet.</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {records.slice(0, 10).map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setSelectedDate(r.recordDate)}
                    className="w-full p-4 hover:bg-muted/20 transition-colors text-left flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <Calendar className="w-4 h-4 text-muted-foreground" />
                      <span className="font-medium text-sm">{format(new Date(r.recordDate), "dd/MM/yyyy")}</span>
                    </div>
                    {r.submittedAt ? (
                      <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                        Submitted
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                        Draft
                      </Badge>
                    )}
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
