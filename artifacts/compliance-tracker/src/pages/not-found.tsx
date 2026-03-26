import { Link } from "wouter";
import { ShieldCheck } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center bg-background text-foreground font-sans">
      <div className="bg-primary/10 p-4 rounded-3xl mb-6 border border-primary/20">
        <ShieldCheck className="w-16 h-16 text-primary" />
      </div>
      <h1 className="text-6xl font-display font-bold tracking-tight mb-4">404</h1>
      <p className="text-xl text-muted-foreground mb-8 text-center max-w-md">
        The compliance page you're looking for doesn't exist or has been moved.
      </p>
      <Link href="/" className="px-6 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:bg-primary/90 transition-colors shadow-lg shadow-primary/25 hover:-translate-y-0.5 transform">
        Return to Dashboard
      </Link>
    </div>
  );
}
