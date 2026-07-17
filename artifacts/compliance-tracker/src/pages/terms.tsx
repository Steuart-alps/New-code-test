import { LegalLayout } from "./legal-layout";

export default function TermsPage() {
  return (
    <LegalLayout title="Terms of Service" updated="17 July 2026">
      <section>
        <h2>1. Who we are</h2>
        <p>
          ComplyTrack is a health &amp; safety compliance tracking service operated by ALPS Consulting Ltd
          (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;), a company registered in England and Wales. By creating
          an account or using ComplyTrack you agree to these Terms of Service.
        </p>
      </section>
      <section>
        <h2>2. Your account</h2>
        <p>
          You must provide accurate information when signing up and keep your login credentials secure. You are
          responsible for all activity under your account, including activity by team members you invite. You must be
          at least 18 years old and using ComplyTrack for business purposes.
        </p>
      </section>
      <section>
        <h2>3. Free trial and subscriptions</h2>
        <ul>
          <li>New accounts receive a 14-day free trial. No payment details are required to start a trial.</li>
          <li>When the trial ends, continued use requires an active paid subscription, billed monthly per site through our payment provider, Stripe.</li>
          <li>Adding a site during a billing period does not change that period's charge; your subscription quantity is updated for the next billing period.</li>
          <li>You can cancel at any time. Cancellation takes effect at the end of the current billing period; no partial refunds are given for unused time.</li>
          <li>Prices are displayed before purchase and may change with at least 30 days' notice.</li>
        </ul>
      </section>
      <section>
        <h2>4. Your data and content</h2>
        <p>
          You retain ownership of all data you enter into ComplyTrack (compliance records, documents, contractor
          details, and so on). You grant us permission to store and process this data solely to provide the service.
          You are responsible for the accuracy and lawfulness of the data you upload.
        </p>
      </section>
      <section>
        <h2>5. Acceptable use</h2>
        <p>You must not:</p>
        <ul>
          <li>use the service for unlawful purposes or to store unlawful content;</li>
          <li>attempt to access other customers' data or probe, disrupt, or overload the service;</li>
          <li>resell or sublicense the service without our written agreement;</li>
          <li>upload malicious code or content that infringes another party's rights.</li>
        </ul>
      </section>
      <section>
        <h2>6. Important: not professional advice</h2>
        <p>
          ComplyTrack is a record-keeping and reminder tool. It does not provide legal, regulatory, or health &amp;
          safety advice, and using it does not by itself make your business compliant with any law or regulation.
          Responsibility for meeting your health &amp; safety obligations remains with you. Where professional advice is
          required, consult a qualified adviser.
        </p>
      </section>
      <section>
        <h2>7. Availability and changes</h2>
        <p>
          We aim to keep ComplyTrack available at all times but do not guarantee uninterrupted service. We may modify,
          add, or remove features. If we discontinue the service entirely, we will give reasonable notice and an
          opportunity to export your data.
        </p>
      </section>
      <section>
        <h2>8. Liability</h2>
        <p>
          To the maximum extent permitted by law, we are not liable for indirect or consequential losses, loss of
          profits, or loss of data arising from your use of the service. Our total liability in any 12-month period is
          limited to the amount you paid us for the service in that period. Nothing in these terms limits liability
          that cannot be limited by law, including for death or personal injury caused by negligence, or fraud.
        </p>
      </section>
      <section>
        <h2>9. Termination</h2>
        <p>
          You may stop using the service and cancel your subscription at any time. We may suspend or terminate accounts
          that breach these terms or remain unpaid. After termination, we may delete your data following a reasonable
          retention period; you can request an export before then.
        </p>
      </section>
      <section>
        <h2>10. General</h2>
        <p>
          These terms are governed by the laws of England and Wales, and the courts of England and Wales have exclusive
          jurisdiction. If any provision is found unenforceable, the rest remain in effect. We may update these terms
          from time to time; material changes will be notified in the app or by email.
        </p>
      </section>
      <section>
        <h2>11. Contact</h2>
        <p>
          Questions about these terms? Contact ALPS Consulting Ltd via{" "}
          <a href="https://alpsconsultancy.co.uk" className="text-primary underline underline-offset-2" target="_blank" rel="noopener noreferrer">
            alpsconsultancy.co.uk
          </a>
          .
        </p>
      </section>
    </LegalLayout>
  );
}
