import { Router } from "express";
import {
  getMobileAndroidCertFingerprints,
  getMobileAndroidPackage,
  getMobileIosAppIds,
} from "../lib/passkeys";

/**
 * Domain association files that let the ComplyTrack mobile app use this
 * domain's passkeys. iOS reads apple-app-site-association (JSON, no
 * extension, no redirects); Android's Credential Manager reads assetlinks.json.
 * Both are 404 until the app identifiers are configured, so the operating
 * systems never cache an empty association.
 */
const router = Router();

router.get("/.well-known/apple-app-site-association", (_req, res) => {
  const apps = getMobileIosAppIds();
  if (apps.length === 0) {
    res.status(404).json({ error: "Not configured" });
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({ webcredentials: { apps } });
});

router.get("/.well-known/assetlinks.json", (_req, res) => {
  const packageName = getMobileAndroidPackage();
  const fingerprints = getMobileAndroidCertFingerprints();
  if (!packageName || fingerprints.length === 0) {
    res.status(404).json({ error: "Not configured" });
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json([
    {
      relation: [
        "delegate_permission/common.handle_all_urls",
        "delegate_permission/common.get_login_creds",
      ],
      target: {
        namespace: "android_app",
        package_name: packageName,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ]);
});

export default router;
