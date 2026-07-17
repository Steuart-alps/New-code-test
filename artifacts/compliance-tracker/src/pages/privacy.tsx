import { LegalLayout } from "./legal-layout";

export default function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy" updated="17 July 2026">
      <section>
        <h2>1. Who we are</h2>
        <p>
          ComplyTrack is operated by ALPS Consulting Ltd, a company registered in England and Wales. We are the data
          controller for account information, and a data processor for the compliance records you and your team store
          in the service. This policy explains what we collect, why, and your rights.
        </p>
      </section>
      <section>
        <h2>2. What we collect</h2>
        <ul>
          <li><strong>Account details</strong> — your name, email address, business name, and password (stored securely hashed, never in plain text).</li>
          <li><strong>Your compliance data</strong> — sites, compliance items, documents, contractor details, and other records you choose to enter.</li>
          <li><strong>Billing information</strong> — handled by our payment provider, Stripe. We never see or store your full card details.</li>
          <li><strong>Usage information</strong> — basic technical logs (such as IP address and login times) used for security and troubleshooting.</li>
        </ul>
      </section>
      <section>
        <h2>3. How we use your information</h2>
        <ul>
          <li>To provide and operate the service (legal basis: performance of a contract).</li>
          <li>To send service emails such as password resets, trial reminders, and compliance-deadline notifications (performance of a contract).</li>
          <li>To process subscription payments through Stripe (performance of a contract).</li>
          <li>To secure the service and prevent abuse (legitimate interests).</li>
        </ul>
        <p>We do not sell your data or use it for third-party advertising.</p>
      </section>
      <section>
        <h2>4. Who we share it with</h2>
        <p>We share data only with service providers needed to run ComplyTrack:</p>
        <ul>
          <li><strong>Stripe</strong> — payment processing and subscription billing.</li>
          <li><strong>Hosting and email providers</strong> — to run the application, store data, and deliver service emails.</li>
        </ul>
        <p>
          These providers act under contract and may process data outside the UK/EEA; where they do, appropriate
          safeguards (such as standard contractual clauses) are in place. We may also disclose information if required
          by law.
        </p>
      </section>
      <section>
        <h2>5. How long we keep it</h2>
        <p>
          We keep your data while your account is active. If your account is closed or your trial lapses, we retain
          data for a reasonable period so you can return or request an export, after which it is deleted. You can ask
          us to delete your account and data at any time.
        </p>
      </section>
      <section>
        <h2>6. Security</h2>
        <p>
          Data is encrypted in transit, passwords are stored using industry-standard hashing, and each customer's data
          is strictly isolated from other customers. Access to production systems is restricted.
        </p>
      </section>
      <section>
        <h2>7. Your rights</h2>
        <p>Under UK and EU data protection law (GDPR), you have the right to:</p>
        <ul>
          <li>access a copy of your personal data;</li>
          <li>correct inaccurate data;</li>
          <li>request deletion of your data;</li>
          <li>receive your data in a portable format;</li>
          <li>object to or restrict certain processing;</li>
          <li>complain to the Information Commissioner's Office (ICO) or your local supervisory authority.</li>
        </ul>
      </section>
      <section>
        <h2>8. Cookies</h2>
        <p>
          ComplyTrack uses only essential cookies: a session cookie to keep you signed in. We do not use advertising or
          third-party tracking cookies.
        </p>
      </section>
      <section>
        <h2>9. Changes and contact</h2>
        <p>
          We may update this policy from time to time; material changes will be notified in the app or by email. For
          privacy questions or to exercise your rights, contact ALPS Consulting Ltd via{" "}
          <a href="https://alpsconsultancy.co.uk" className="text-primary underline underline-offset-2" target="_blank" rel="noopener noreferrer">
            alpsconsultancy.co.uk
          </a>
          .
        </p>
      </section>
    </LegalLayout>
  );
}
