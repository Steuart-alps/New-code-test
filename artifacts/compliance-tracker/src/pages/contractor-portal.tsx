/**
 * Public contractor self-service portal.
 * No auth — access is via a time-limited token embedded in the URL.
 */
import { useState, useEffect, useRef } from "react";
import { useParams } from "wouter";
import { format, isPast, differenceInDays } from "date-fns";
import { ShieldCheck, FileUp, Trash2, Plus, CheckCircle2, AlertTriangle, Clock, X, Loader2 } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function apiUrl(path: string) {
  return `${BASE}/api/contractor-portal/${path}`;
}

function toDateInput(v: unknown): string {
  if (!v) return "";
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function ExpiryChip({ date }: { date: string | null }) {
  if (!date) return <span className="text-sm text-gray-400">Not set</span>;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  const days = differenceInDays(d, new Date());
  const expired = isPast(d);
  if (expired) return <span className="inline-flex items-center gap-1 text-xs bg-red-100 text-red-700 rounded-full px-2.5 py-0.5 font-medium"><AlertTriangle className="w-3 h-3" /> Expired {format(d, "d MMM yyyy")}</span>;
  if (days <= 30) return <span className="inline-flex items-center gap-1 text-xs bg-amber-100 text-amber-700 rounded-full px-2.5 py-0.5 font-medium"><Clock className="w-3 h-3" /> Expires {format(d, "d MMM yyyy")}</span>;
  return <span className="inline-flex items-center gap-1 text-xs bg-emerald-100 text-emerald-700 rounded-full px-2.5 py-0.5 font-medium"><CheckCircle2 className="w-3 h-3" /> Valid until {format(d, "d MMM yyyy")}</span>;
}

const DBS_TYPES = ["Basic", "Standard", "Enhanced", "PVG Scheme", "None"];

interface Cert {
  id: number;
  certificate_name: string;
  issuer: string | null;
  completed_date: string | null;
  expiry_date: string | null;
  notes: string | null;
  object_path: string | null;
}

interface PortalData {
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  address: string | null;
  gasSafeNumber: string | null;
  insuranceExpiry: string | null;
  dbsType: string | null;
  dbsExpiryDate: string | null;
  certificates: Cert[];
}

const CERT_EXPIRY_YEARS: Record<string, number> = {
  "IPAF (Powered Access)": 5,
  "PASMA (Mobile Access Towers)": 5,
  "First Aid at Work": 3,
  "Emergency First Aid at Work": 3,
  "Asbestos Awareness": 1,
  "Manual Handling": 3,
  "Chainsaw Operator (NPTC)": 5,
  "Food Hygiene (Level 2)": 3,
  "Food Hygiene (Level 3)": 3,
  "DBS Check (Basic)": 3,
  "DBS Check (Standard)": 3,
  "DBS Check (Enhanced)": 3,
  "PVG Scheme (Scotland)": 5,
};

function suggestExpiry(name: string, completed: string): string {
  const years = CERT_EXPIRY_YEARS[name];
  if (!years || !completed) return "";
  const d = new Date(completed);
  if (isNaN(d.getTime())) return "";
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
}

export default function ContractorPortalPage() {
  const { token } = useParams<{ token: string }>();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PortalData | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  // Editable form state
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [insuranceExpiry, setInsuranceExpiry] = useState("");
  const [dbsType, setDbsType] = useState("");
  const [dbsExpiryDate, setDbsExpiryDate] = useState("");
  const [gasSafeNumber, setGasSafeNumber] = useState("");

  // Certificate add panel
  const [showAddCert, setShowAddCert] = useState(false);
  const [certName, setCertName] = useState("");
  const [certIssuer, setCertIssuer] = useState("");
  const [certCompleted, setCertCompleted] = useState("");
  const [certExpiry, setCertExpiry] = useState("");
  const [certNotes, setCertNotes] = useState("");
  const [certFile, setCertFile] = useState<File | null>(null);
  const [certUploading, setCertUploading] = useState(false);
  const [certSaving, setCertSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!token) return;
    fetch(apiUrl(token))
      .then(r => r.ok ? r.json() : r.json().then((e: any) => Promise.reject(e.error ?? "Failed")))
      .then((d: PortalData) => {
        setData(d);
        setPhone(d.phone ?? "");
        setAddress(d.address ?? "");
        setInsuranceExpiry(toDateInput(d.insuranceExpiry));
        setDbsType(d.dbsType ?? "");
        setDbsExpiryDate(toDateInput(d.dbsExpiryDate));
        setGasSafeNumber(d.gasSafeNumber ?? "");
      })
      .catch(e => setError(typeof e === "string" ? e : "Unable to load portal. The link may have expired."))
      .finally(() => setLoading(false));
  }, [token]);

  async function handleSave() {
    if (!token) return;
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch(apiUrl(token), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone || null, address: address || null, insuranceExpiry: insuranceExpiry || null, dbsType: dbsType || null, dbsExpiryDate: dbsExpiryDate || null, gasSafeNumber: gasSafeNumber || null }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e: any) {
      alert(e.message ?? "Save failed — please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleAddCert() {
    if (!token || !certName.trim()) return;
    setCertSaving(true);
    try {
      let objectPath: string | null = null;

      if (certFile) {
        setCertUploading(true);
        // Step 1: get presigned URL
        const allowedTypes = ["application/pdf", "image/jpeg", "image/png"];
        if (!allowedTypes.includes(certFile.type.toLowerCase())) throw new Error("Certificate files must be PDF, JPEG, or PNG");
        const urlRes = await fetch(apiUrl(`${token}/upload-url`), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contentType: certFile.type }) });
        if (!urlRes.ok) {
          const failure = await urlRes.json().catch(() => null) as { error?: string } | null;
          throw new Error(failure?.error ?? "Could not get upload URL");
        }
        const { uploadUrl, objectPath: op } = await urlRes.json();
        // Step 2: upload directly to GCS
        const putRes = await fetch(uploadUrl, { method: "PUT", body: certFile, headers: { "Content-Type": certFile.type || "application/octet-stream" } });
        if (!putRes.ok) throw new Error("Upload failed");
        objectPath = op;
        setCertUploading(false);
      }

      // Step 3: create cert record
      const res = await fetch(apiUrl(`${token}/certificates`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          certificateName: certName.trim(),
          issuer: certIssuer.trim() || null,
          completedDate: certCompleted || null,
          expiryDate: certExpiry || null,
          objectPath,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
      const newCert = await res.json();
      setData(d => d ? { ...d, certificates: [...d.certificates, newCert] } : d);
      // Reset form
      setCertName(""); setCertIssuer(""); setCertCompleted(""); setCertExpiry(""); setCertNotes(""); setCertFile(null);
      if (fileRef.current) fileRef.current.value = "";
      setShowAddCert(false);
    } catch (e: any) {
      alert(e.message ?? "Could not add certificate");
    } finally {
      setCertSaving(false);
      setCertUploading(false);
    }
  }

  async function handleDeleteCert(certId: number) {
    if (!token || !confirm("Remove this certificate?")) return;
    const res = await fetch(apiUrl(`${token}/certificates/${certId}`), { method: "DELETE" });
    if (res.ok) setData(d => d ? { ...d, certificates: d.certificates.filter(c => c.id !== certId) } : d);
  }

  if (loading) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
    </div>
  );

  if (error) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-sm border border-slate-200 p-8 text-center">
        <AlertTriangle className="w-12 h-12 text-amber-400 mx-auto mb-4" />
        <h1 className="text-lg font-bold text-slate-900 mb-2">Link unavailable</h1>
        <p className="text-slate-600 text-sm">{error}</p>
      </div>
    </div>
  );

  if (!data) return null;

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-slate-900 text-white px-6 py-5 flex items-center gap-3">
        <ShieldCheck className="w-7 h-7 text-emerald-400" />
        <div>
          <span className="text-lg font-bold tracking-tight">ComplyTrack</span>
          <span className="text-slate-400 text-sm ml-2">by ALPS Consulting</span>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">

        {/* Greeting */}
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Hi {data.name.split(" ")[0]} 👋</h1>
          <p className="text-slate-500 mt-1 text-sm">
            Please review and update your compliance details below. Any changes are sent directly to your client's ComplyTrack account.
          </p>
        </div>

        {/* Insurance card */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-slate-900">Insurance</h2>
          <p className="text-xs text-slate-500">Enter your next insurance renewal date (covers all policies — PL, PI, etc.)</p>
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex-1 min-w-[180px]">
              <label className="block text-xs font-medium text-slate-600 mb-1">Renewal / expiry date</label>
              <input type="date" value={insuranceExpiry} onChange={e => setInsuranceExpiry(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400" />
            </div>
            <div className="pt-5">
              <ExpiryChip date={insuranceExpiry || null} />
            </div>
          </div>
        </div>

        {/* DBS / PVG card */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-slate-900">DBS / PVG Check</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Check type</label>
              <select value={dbsType} onChange={e => {
                setDbsType(e.target.value);
                if (e.target.value === "None") setDbsExpiryDate("");
              }}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 bg-white">
                <option value="">— Select —</option>
                {DBS_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Expiry date</label>
              <input type="date" value={dbsExpiryDate} onChange={e => setDbsExpiryDate(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400" />
            </div>
          </div>
          {dbsExpiryDate && <ExpiryChip date={dbsExpiryDate} />}
        </div>

        {/* Gas Safe registration */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-slate-900">Gas Safe registration</h2>
          <p className="text-xs text-slate-500">Leave blank if not applicable to your trade.</p>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Gas Safe registration number</label>
            <input type="text" value={gasSafeNumber} onChange={e => setGasSafeNumber(e.target.value)} placeholder="e.g. 123456"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400" />
          </div>
        </div>

        {/* Contact details */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-slate-900">Contact details</h2>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Phone</label>
            <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="e.g. 07700 900000"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Address</label>
            <textarea value={address} onChange={e => setAddress(e.target.value)} rows={2}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 resize-none" />
          </div>
        </div>

        {/* Save button */}
        <button onClick={handleSave} disabled={saving}
          className="w-full bg-slate-900 text-white rounded-xl py-3 font-semibold text-sm hover:bg-slate-800 transition-colors disabled:opacity-60 flex items-center justify-center gap-2">
          {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : saved ? <><CheckCircle2 className="w-4 h-4 text-emerald-400" /> Saved!</> : "Save details"}
        </button>

        {/* Certificates */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-slate-900">Certificates &amp; licences</h2>
              <p className="text-xs text-slate-500 mt-0.5">Upload copies for your client's records</p>
            </div>
            <button onClick={() => setShowAddCert(true)}
              className="inline-flex items-center gap-1.5 bg-slate-900 text-white text-xs font-semibold px-3 py-2 rounded-lg hover:bg-slate-800 transition-colors">
              <Plus className="w-3.5 h-3.5" /> Add certificate
            </button>
          </div>

          {/* Add cert panel */}
          {showAddCert && (
            <div className="px-6 py-5 bg-slate-50 border-b border-slate-100 space-y-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-slate-700">New certificate</span>
                <button onClick={() => setShowAddCert(false)} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Certificate name *</label>
                <input value={certName} onChange={e => setCertName(e.target.value)} placeholder="e.g. IPAF, First Aid, Gas Safe…"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 bg-white" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Issuing body</label>
                  <input value={certIssuer} onChange={e => setCertIssuer(e.target.value)} placeholder="e.g. IPAF, St John…"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 bg-white" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Completed</label>
                  <input type="date" value={certCompleted} onChange={e => {
                    setCertCompleted(e.target.value);
                    if (!certExpiry) setCertExpiry(suggestExpiry(certName, e.target.value));
                  }} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 bg-white" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Expiry date</label>
                  <input type="date" value={certExpiry} onChange={e => setCertExpiry(e.target.value)}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 bg-white" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Notes (optional)</label>
                  <input value={certNotes} onChange={e => setCertNotes(e.target.value)} placeholder="Cert number, renewal info…"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 bg-white" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  <FileUp className="w-3.5 h-3.5 inline mr-1" />Upload certificate (PDF, JPG, PNG)
                </label>
                <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png"
                  onChange={e => setCertFile(e.target.files?.[0] ?? null)}
                  className="block w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-slate-200 file:text-slate-700 hover:file:bg-slate-300" />
              </div>
              <button onClick={handleAddCert} disabled={certSaving || !certName.trim()}
                className="w-full bg-slate-900 text-white rounded-xl py-2.5 font-semibold text-sm hover:bg-slate-800 transition-colors disabled:opacity-60 flex items-center justify-center gap-2">
                {certSaving
                  ? <><Loader2 className="w-4 h-4 animate-spin" />{certUploading ? "Uploading file…" : "Saving…"}</>
                  : "Add certificate"}
              </button>
            </div>
          )}

          {data.certificates.length === 0 && !showAddCert ? (
            <div className="px-6 py-10 text-center text-slate-400 text-sm">No certificates on record yet.</div>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                {data.certificates.map(cert => (
                  <tr key={cert.id}>
                    <td className="px-6 py-3">
                      <div className="font-medium text-slate-900">{cert.certificate_name}</div>
                      {cert.issuer && <div className="text-xs text-slate-400">{cert.issuer}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <ExpiryChip date={cert.expiry_date} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => handleDeleteCert(cert.id)} className="text-slate-300 hover:text-red-500 transition-colors">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <p className="text-center text-xs text-slate-400 pb-8">
          ComplyTrack by ALPS Consulting · Updates sent directly to your client's account
        </p>
      </div>
    </div>
  );
}
