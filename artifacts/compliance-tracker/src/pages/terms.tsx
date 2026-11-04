import { LegalLayout } from "./legal-layout";

export default function TermsPage() {
  return (
    <LegalLayout title="Terms of Service" updated="27 October 2026">
      <section>
        <h2>1. Who we are</h2>
        <p>
          ComplyTrack is a health &amp; safety compliance tracking service operated by ALPS Consulting Ltd, trading as ALPS Consultancy
          (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;), a company registered in Scotland (company number SC739043, registered office 31 De Walden Drive, Kilmarnock, KA3 6AA). By creating
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
          <li>Each site you add is charged straight away for one full month at your per-site price, and is then included in your monthly bill. Removing a site lowers your next bill; no refund or credit is given for the current period.</li>
          <li>You can cancel at any time. Cancellation takes effect at the end of the current billing period; no partial refunds are given for unused time.</li>
          <li>The optional AI features add-on is billed monthly for the whole business and includes a monthly allowance of AI use; top-ups add more. Unused allowance and top-ups carry over and are used oldest first. Anything still unused 12 months after the end of the month it was given for lapses. Unused allowance has no cash value and is not refunded, including when the add-on or your subscription ends.</li>
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
        <h2>5. Data processing</h2>
        <p>
          For the personal data in the records you and your team keep in ComplyTrack (for example staff names, training
          records and incident reports), your business is the controller and we are your processor. Our{" "}
          <a href="/privacy" className="text-primary underline underline-offset-2">Privacy Policy</a> describes the
          data involved. As your processor we:
        </p>
        <ul>
          <li>process that data only to provide ComplyTrack and on your documented instructions, which are these terms and the way you use the service, unless the law requires otherwise (in which case we will tell you first, where allowed);</li>
          <li>make sure everyone at ALPS who can access it is bound by confidentiality;</li>
          <li>keep it secure, including encryption in transit, separation from other customers' data, restricted access to production systems and backups;</li>
          <li>use the sub-processors named in our Privacy Policy, under written terms that protect the data in the same way; you authorise these, and we will tell you before adding or replacing one so you can object;</li>
          <li>help you respond to requests from people exercising their data protection rights, and with security, breach notification and data protection impact assessments, as far as the service allows;</li>
          <li>tell you without undue delay after becoming aware of a personal data breach affecting your data;</li>
          <li>at the end of your subscription, let you export your data and then delete it as described in section 10, unless the law requires us to keep it;</li>
          <li>give you the information you reasonably need to show these obligations are met, and allow reasonable audits on notice.</li>
        </ul>
      </section>
      <section>
        <h2>6. Acceptable use</h2>
        <p>You must not:</p>
        <ul>
          <li>use the service for unlawful purposes or to store unlawful content;</li>
          <li>attempt to access other customers' data or probe, disrupt, or overload the service;</li>
          <li>resell or sublicense the service without our written agreement;</li>
          <li>upload malicious code or content that infringes another party's rights.</li>
        </ul>
      </section>
      <section>
        <h2>7. Important: not professional advice</h2>
        <p>
          ComplyTrack is a record-keeping and reminder tool. It does not provide legal, regulatory, or health &amp;
          safety advice, and using it does not by itself make your business compliant with any law or regulation.
          Responsibility for meeting your health &amp; safety obligations remains with you. Where professional advice is
          required, consult a qualified adviser.
        </p>
      </section>
      <section>
        <h2>8. Availability and changes</h2>
        <p>
          We aim to keep ComplyTrack available at all times but do not guarantee uninterrupted service. We may modify,
          add, or remove features. If we discontinue the service entirely, we will give reasonable notice and an
          opportunity to export your data.
        </p>
      </section>
      <section>
        <h2>9. Liability</h2>
        <p>
          To the maximum extent permitted by law, we are not liable for indirect or consequential losses, loss of
          profits, or loss of data arising from your use of the service. Our total liability in any 12-month period is
          limited to the amount you paid us for the service in that period. Nothing in these terms limits liability
          that cannot be limited by law, including for death or personal injury caused by negligence, or fraud.
        </p>
      </section>
      <section>
        <h2>10. Termination</h2>
        <p>
          You may stop using the service and cancel your subscription at any time. We may suspend or terminate accounts
          that breach these terms or remain unpaid. After your subscription ends, your records are kept for 12 months
          so you can come back or download a full export; we email the Owner 30 days before they are deleted. The
          Owner can ask for earlier deletion after cancelling. Some records are kept longer where the law or a
          dispute needs them, such as the audit trail and RIDDOR reports.
        </p>
      </section>
      <section>
        <h2>11. General</h2>
        <p>
          These terms are governed by the law of Scotland, and the Scottish courts have exclusive
          jurisdiction. If any provision is found unenforceable, the rest remain in effect. We may update these terms
          from time to time; material changes will be notified in the app or by email.
        </p>
      </section>
      <section>
        <h2>12. Contact</h2>
        <p>
          Questions about these terms? Contact ALPS Consulting Ltd via{" "}
          <a href="https://www.alpsconsultancy.co.uk" className="text-primary underline underline-offset-2" target="_blank" rel="noopener noreferrer">
            alpsconsultancy.co.uk
          </a>
          .
        </p>
      </section>
    </LegalLayout>
  );
}
