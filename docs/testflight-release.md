# SeenSnap: first TestFlight release

## Registered Apple identity

- Organization: SeenSnap LLC; Team ID `7Z8CYNB749`.
- Explicit bundle: `com.seensnap.app`; app name SeenSnap.
- App Store Connect app ID: `6835181142`; SKU `SEENSNAP-IOS-001`.
- Sign in with Apple, push, associated domains and in-app purchase capabilities are registered.
- First signed iOS archive succeeded on November 15, 2026: version `1.0.0 (1)`, EAS build `fee15abc-47db-4af8-8b8b-cd4a0a701d60`, commit `57912ccc1e561da3c5db99f27d9f00035135e9e1`. It has **not** been uploaded to App Store Connect or reviewed. Build 1 is superseded by the dependency repairs below; build a replacement before submission.

## Implemented in this branch

- Store builds cannot use demo/test-email auth or silently fall back to a development account. Development access requires both `__DEV__` and explicit opt-in.
- Google uses the platform's actual OAuth client; iOS uses the reversed client ID callback, PKCE code exchange, and caught failures. Provider cancellation is quiet. Auth responses/tokens are no longer logged. The sign-in screen stays mounted during provider authentication.
- Scrollable, keyboard-aware sign-in with tappable legal links. Native Apple entitlement is present in both Expo config and the committed Xcode project.
- Store-distribution EAS profile pinned to Xcode 26.1, Node 20.19.4; remote build numbers; version 1.0.0. The preflight refuses missing Expo ownership/project and native Google configuration.
- Native App Store purchase and restore through RevenueCat, authenticated SeenSnap UUIDs, approved product filtering, localized store pricing and real subscription periods. The web build never loads the native SDK. SDK success does not grant Premium: the authenticated API rechecks the provider.
- Server verification handles paid-through cancellation, expiry, grace periods and refunds. Webhooks are authenticated, scoped to this RevenueCat app and trigger a fresh snapshot; replay/delayed events do not overwrite newer state. No client-supplied user ID or entitlement is accepted by sync.
- Regular beta access stays complimentary. Revoked/expired beta grants are not re-created at login. An explicit server-side billing test cohort bypasses beta access and can test sandbox subscriptions; sandbox grants never authorize regular users.
- Membership refreshes after verification and app resume. Purchase buttons wait for verification; pending/canceled/failed purchase states never fabricate Premium.
- Account deletion warns that Apple subscriptions must be canceled separately. Apple-linked accounts reauthorize, exchange the one-use code, verify the linked Apple identity, revoke Apple access, then delete. Provider credentials stay server-side. RevenueCat customer records are removed when configured; deleting them does not cancel an Apple subscription.
- Universal-link association file for the current share host `seensnapalpha.netlify.app`; title/list/profile/post/team links have a web fallback. The marketing domain `seensnap.app` must serve its own association file before adding it to the entitlement.

## Confirmed Expo project

- Owner: `lizzy456` (Elizabeth's signed-in account, confirmed November 15, 2026).
- Project: `seensnap`; display name SeenSnap.
- Project ID: `e4706328-2b26-4812-87c4-08a17bac292e`.
- Dashboard: https://expo.dev/accounts/lizzy456/projects/seensnap
- The project was created successfully and the repository now links to it through `extra.eas.projectId`. The TestFlight profile also declares the same public owner/project identifiers. No dependency on `gregtusar` remains in the app configuration.
- Seven public variables are saved in the project's EAS `preview` environment: owner, project ID, release-build flag, dev-auth disabled, staging environment label, the existing staging API URL and the iOS Google client ID below. RevenueCat is not configured yet.
- The Expo GitHub app is authorized for only `elizabethpetersonanne-source/seensnap`, and that repository is connected to this project. The saved base directory is `/apps/mobile`. No automatic build trigger has been enabled.
- Elizabeth authenticated the Cloud Shell EAS CLI as `lizzy456` and configured the SeenSnap Apple distribution certificate, provisioning profile and APNs key. The first store-distribution archive succeeded. The assistant's separate local CLI is not authenticated.
- The downloaded archive confirms bundle `com.seensnap.app`, version `1.0.0 (1)`, iOS 15.1 minimum, iPhone/iPad families, photo permission text and the expected Google callback. Archive success does not prove on-device authentication, purchases, push delivery or usability.
- Backend `57912ccc1e561da3c5db99f27d9f00035135e9e1` is deployed, with migration and structural checks passed. `/health` confirmed the same commit. The iOS Google client flag was included in that rollout. Netlify production remains unchanged while PR #18 is a draft.

## Account setup still required

### Expo and signing

1. Use the confirmed Expo owner `lizzy456` and project above. Do not create a duplicate project or sign into the previous developer's account.
2. Authenticate EAS CLI as an account with access to this project. Pull the `preview` environment into local build configuration before release checks (`npx eas-cli env:pull --environment preview`). The committed TestFlight profile and the saved EAS environment already supply the confirmed owner/project identifiers during builds.
3. The user supplied the public iOS Google client below, and it is saved in Expo. Deploy the same ID to the API using `--google-ios-client-id`. Keep the existing web client configured separately. The post-install script writes the reversed iOS callback to the committed native plist on the build worker; Expo plugins alone do not update a checked-in native project.
4. Set backend `APPLE_BUNDLE_ID=com.seensnap.app`, `IOS_TEAM_ID=7Z8CYNB749`, and Apple Sign in key ID/private key through Secret Manager. Account Holder/admin creates the Apple signing key with the requested authorization. Never paste private keys into chat or a public client env variable.
5. Have EAS use the SeenSnap Apple team, distribution certificate and provisioning profile. APNs credentials are also required to test push. Credential creation/access may require the Apple Account Holder/admin.
6. Confirm public Terms, Privacy and support URLs contain approved, accessible content. This branch links existing URLs; it does not fabricate legal policy text.

#### Native Google client setup

In the existing `seensnap-staging` Google Cloud project, open Google Auth Platform → Clients (or APIs & Services → Credentials). Check for an existing **iOS** OAuth client for `com.seensnap.app` before creating a duplicate. If none exists, create an iOS client named **SeenSnap iOS**, bundle `com.seensnap.app`, Team ID `7Z8CYNB749`. The optional App Store ID can remain blank until the app is published. Leave existing web clients unchanged.

Copy only the public client ID ending in `.apps.googleusercontent.com` to the Expo `preview` environment as `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` and to the API as `GOOGLE_OAUTH_IOS_CLIENT_ID`. Do not place a client secret in the app. App Check has not been integrated into this AuthSession-based client; enabling enforcement needs separate implementation and device validation.

On November 15, Elizabeth supplied this public iOS client ID after completing Google setup:

```text
451179869201-io7v9k8pv43ap31h8p7nq01jnrlshtt8.apps.googleusercontent.com
```

It is saved in Expo's `preview` environment as `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`. The expected native callback scheme is `com.googleusercontent.apps.451179869201-io7v9k8pv43ap31h8p7nq01jnrlshtt8`. Local release configuration and callback generation are checked with this ID; this does not prove provider authentication works.

Google Cloud Console could not be loaded by the setup browser, so the client's iOS type, bundle ID and consent audience have not been independently inspected. The API update completed; real-device sign-in remains pending. If the Google consent screen is in testing, ensure the intended Google testers are allowed before device acceptance.

Reference: https://developers.google.com/identity/sign-in/ios/api-access

### Real transactions

RevenueCat integration is implemented but **disabled until configured**. No account, subscription contract, prices or charge has been created for the user by this work.

1. Stefan (Apple Account Holder) completes the Paid Apps Agreement and any required banking/tax setup in App Store Connect.
2. Agree monthly/annual prices, the public Free/Premium feature boundary, and when complimentary beta access ends. The only enforced Premium distinction today is the Concierge allowance; do not advertise all other features as paid-only. The current Free allowance of 3/month is an existing implementation default awaiting product approval.
3. Create a subscription group and monthly/annual auto-renewable products with approved identifiers, prices, localizations and review information. Initial product IDs are intentionally not invented or hardcoded in this branch.
4. Create/configure the SeenSnap RevenueCat project and Apple app; import those products, attach them to a Premium entitlement and a current offering with monthly/annual packages. Set restore behavior to **Keep with original App User ID**. Do not enable transfers between unrelated SeenSnap accounts. Select a plan that supports webhooks; any account/financial commitment remains an owner decision.
5. Configure Apple server API / in-app purchase credentials and Apple server notifications using RevenueCat's documented dashboard instructions. These are distinct from the Apple Sign in key.
6. Set the public Apple SDK key (`appl_…`) in EAS as `EXPO_PUBLIC_REVENUECAT_APPLE_KEY`. Put the RevenueCat **secret server API key**, webhook token, RevenueCat app ID and approved product IDs only on the API. Enable new purchases (`BILLING_ENABLED=true`) only after all configuration is present. Turning new sales off does not stop configured restore, webhook or deletion processing.
7. RevenueCat webhook: `https://seensnap-api-staging-7znwtd6zta-uc.a.run.app/api/v1/billing/revenuecat`, authorization `Bearer <server-configured token>`, scoped to the SeenSnap app. Include sandbox and production lifecycle events. Verify successful delivery, retries and transfer notifications.
8. Use **separate SeenSnap accounts** for billing testing; put only their UUIDs in `BILLING_TEST_USER_IDS`. Regular beta users remain Premium without paying. Do not buy production and sandbox subscriptions under the same test identity. Removing a UUID from the test cohort immediately stops sandbox authorization and restores any still-valid beta grant.
9. Exercise new purchase, explicit restore, pending approval, user cancellation, expiry, renewal, billing grace, refund/revocation, a store account belonging to a different SeenSnap user, provider outage and app restart. No production charges are necessary for TestFlight acceptance.

## Deployment and build order

1. Deploy the reviewed backend commit with `deploy/rollout_existing.py --apply --expected-commit <reviewed SHA> --google-ios-client-id 451179869201-io7v9k8pv43ap31h8p7nq01jnrlshtt8.apps.googleusercontent.com`. The new flag validates the public ID, applies it only to the no-traffic candidate and checks it before promotion. It also verifies that the existing Google web client setting is unchanged. Structural checks now include native auth, account-deletion requirements and billing routes. Billing defaults off and does not remove existing beta grants. No schema migration is introduced by this branch, but the rollout still runs its normal backup/migration checks.
2. Configure native auth and verify the new `/auth/deletion-requirements` and billing endpoints. Keep environment out of `local`/`development`; `/auth/dev` and demo token must remain disabled.
3. Merge the frontend only after backend checks pass. Netlify then publishes the release sign-in UI and the association file. Verify the association URL returns JSON over HTTPS with no redirect; verify an authenticated account can still sign in on web.
4. In `apps/mobile`, after the confirmed Expo project/environment is linked, run:

   ```sh
   npm ci
   npx --yes eas-cli@latest env:pull preview --non-interactive
   npm run release:check
   npx --yes eas-cli@latest build --platform ios --profile testflight --no-wait
   # After this exact build succeeds and its logs are reviewed:
   npx --yes eas-cli@latest submit --platform ios --profile testflight --id <verified-build-id>
   ```

   Use the exact successful build for submission, not an unrelated previously built artifact. Build 2 has been uploaded and processed by Apple (see the verification record below). Submission credentials are separate from distribution signing. Configuration preflight needs the public EAS environment variables available locally as well as on the build worker.
5. Wait for Apple's processing; resolve export compliance based on the app's audited encryption use. Do not assume an exemption without checking the final archive and SDKs. Native privacy manifests are aggregated by CocoaPods; inspect the archive's Privacy Report before completing App Privacy disclosures.
6. Add internal testers, verify on an actual iPhone and iPad, then complete Test Information and submit for external TestFlight review. Reviewer access must use a real supported login, not re-enabled email-only authentication.

## Native build repairs after the first archive

The first EAS build succeeded but Expo Doctor identified an incompatible duplicate font module (`expo-font` 57 alongside 14), a missing direct font dependency, a non-square app-config icon and older SDK patches. The replacement uses a direct SDK-54-compatible `expo-font` dependency, updated SDK 54/auth-session/web-browser patches, and the existing 1024-square native icon as its shared config asset. The icon artwork itself is unchanged. Font-loading errors now allow the app to open with fallback fonts instead of leaving an endless startup spinner. CI checks Expo package compatibility and duplicate native modules before compiling bundles.

Expo Doctor now passes 17 of 18 checks locally. Its remaining warning is expected for this **committed native iOS project**: EAS does not automatically synchronize native config fields from app.json. Do not hide that warning or regenerate the iOS project blindly. The native identity, orientation, appearance, icon, launch artwork, permission text and entitlements must be maintained alongside app config; the Google scheme is applied by the checked-in post-install script. The new icon asset is byte-identical to the committed Xcode AppIcon.

These are mobile/build changes; do not rerun the API database rollout solely for them. Build a new signed archive from the repaired commit and inspect its EAS logs before submitting that exact build ID. The refreshed lockfile plus the compatible `shell-quote` patch remove both previously reported critical audit findings. The remaining audit findings need a separate reviewed compatibility update; do not run `npm audit fix --force` or accept an accidental SDK-major migration to resolve them.

## Verified replacement build — November 15, 2026

- Source commit: `fde29693d268b1db4ae4ca800f371af03415c9b9`.
- EAS build: `3e95bb1a-b6bb-413f-9d6b-fbc584934596`, version **1.0.0 (2)**, store distribution, `testflight` profile / `preview` environment.
- Result: **Succeeded**, signed IPA available; 3m 55s build time, 4m 19s total. Dashboard: https://expo.dev/accounts/lizzy456/projects/seensnap/builds/3e95bb1a-b6bb-413f-9d6b-fbc584934596
- Cloud Expo Doctor confirms 17/18 checks; only the documented committed-native-config warning remains.
- GitHub Actions run `43760591310` passed deployment safety, API/migrations and mobile/web checks. Client tests, typecheck, dependency compatibility, autolinking and both bundle exports passed.
- Dependency audit: 0 critical, 13 high, 18 moderate, 2 low; these counts are package findings, not an assessment of runtime exploitability. Further audit triage remains required.
- A follow-up download of build 2 timed out, then browser URL security blocked inspection. Build success and availability were observed in Expo; the replacement IPA itself was not independently inspected locally.
- App Store Connect upload succeeded: EAS submission `9b15402f-7895-4f06-a089-6147ab2da8c1`. Apple's TestFlight screen subsequently showed build **1.0.0 (2)** processed, export-compliance questions completed, and then submitted for TestFlight review. Four individual testers and the SeenSnap Internal group are present; the supplied screenshot still showed No Builds Available, so device installation and tester access are not yet confirmed. Do not resubmit build 2 or cancel its review for an icon update.

## Spotlight app icon update — November 16, 2026 (UTC)

Elizabeth supplied and approved the navy spotlight / gold camera / SEENSNAP artwork. Its square composition is preserved and resized to a 1024×1024 sRGB PNG without an alpha channel. The shared Expo app icon and the committed native Xcode `AppIcon.appiconset` contain identical image bytes. The web favicon now references the same shared asset. The in-app header logo, splash screen and notification artwork are separate assets and retain their existing designs.

The native asset catalog is compiled into each iOS binary, so build 2 will retain its original icon. Build a new archive with the existing `testflight` profile (remote build numbers increment automatically), verify it, and submit that exact new build to App Store Connect. Assign the new build to the intended testing group once Apple processes it. This asset-only change requires no backend deployment. Netlify receives the favicon change when the frontend branch is released.

## Device acceptance before external testing

- Existing Google user retains picks, rankings and teams; new Apple user (including Hide My Email) completes onboarding. Sign-out/account switch and a canceled/error login leave usable controls.
- All ten rating options, keyboard, safe areas, landscape trailers and iPad split-view work. No clipped dialogs or blocked bottom navigation.
- Continuous Swipe, genre filtering, correct save/Watch Next state and personalized reasons; Concierge produces relevant results or honest recovery.
- Push permission/context prompt, delivery and notification destination; universal links through installed/uninstalled and signed-out states, including private lists.
- Purchase/restore lifecycle described above. Server and client agree on Premium without changing another user's access.
- Apple-linked account deletion successfully revokes authorization, removes local/remote account data, and leaves subscription cancellation guidance visible before deletion.
- Approved privacy disclosures include actual data sent to recommendation providers and RevenueCat. Moderation/report/block flows, age rating, content rights and legal URLs reviewed for external release.

## Remaining engineering follow-up before public App Store launch

- Apple server-to-server consent revocation/account deletion notifications and native credential-state recovery need a separate end-to-end lifecycle pass. One-use reauthorization covers user-initiated in-app deletion in this branch; it is not a substitute for every Apple account event.
- A dedicated billing reconciliation/alerting job should recover from webhook delivery exhaustion and detect provider errors. Current access naturally expires and sync retries on purchase/restore or membership return, but dormant renewal recovery depends on successful webhook delivery.
- The website cannot perform native Apple reauthorization; Apple-linked deletion directs users to their iPhone/iPad. Add a web Apple reauthorization flow if Apple accounts must be fully managed from web.
- Initial archive signing and native compilation succeeded. The repaired replacement archive also succeeded and build 2 was uploaded and processed by Apple. Real-device acceptance remains pending. Linux TypeScript/web/unit checks cannot certify those device gates.
