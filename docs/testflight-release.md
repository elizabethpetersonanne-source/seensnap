# SeenSnap: first TestFlight release

## Registered Apple identity

- Organization: SeenSnap LLC; Team ID `7Z8CYNB749`.
- Explicit bundle: `com.seensnap.app`; app name SeenSnap.
- App Store Connect app ID: `6835181142`; SKU `SEENSNAP-IOS-001`.
- Sign in with Apple, push, associated domains and in-app purchase capabilities are registered.
- No signed binary has been built, uploaded or reviewed yet.

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
- Six public variables are saved in the project's EAS `preview` environment: owner, project ID, release-build flag, dev-auth disabled, staging environment label and the existing staging API URL. Native Google and RevenueCat keys are not configured yet.
- The Expo GitHub app is authorized for only `elizabethpetersonanne-source/seensnap`, and that repository is connected to this project. The saved base directory is `/apps/mobile`. No automatic build trigger has been enabled.
- Expo's iOS credentials page has no configured distribution certificate or provisioning profile yet. The first signed build/upload has not been started.
- Browser sign-in does not authenticate the local EAS CLI. CLI/build authentication, native Google configuration and signing still need verification before starting a build.

## Account setup still required

### Expo and signing

1. Use the confirmed Expo owner `lizzy456` and project above. Do not create a duplicate project or sign into the previous developer's account.
2. Authenticate EAS CLI as an account with access to this project. Pull the `preview` environment into local build configuration before release checks (`npx eas-cli env:pull --environment preview`). The committed TestFlight profile and the saved EAS environment already supply the confirmed owner/project identifiers during builds.
3. Configure an **iOS** Google OAuth client for `com.seensnap.app`. Put its public ID in `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` and the same ID in the API's `GOOGLE_OAUTH_IOS_CLIENT_ID`. Keep the existing web client configured separately. The post-install script writes the reversed iOS callback to the committed native plist on the build worker; Expo plugins alone do not update a checked-in native project.
4. Set backend `APPLE_BUNDLE_ID=com.seensnap.app`, `IOS_TEAM_ID=7Z8CYNB749`, and Apple Sign in key ID/private key through Secret Manager. Account Holder/admin creates the Apple signing key with the requested authorization. Never paste private keys into chat or a public client env variable.
5. Have EAS use the SeenSnap Apple team, distribution certificate and provisioning profile. APNs credentials are also required to test push. Credential creation/access may require the Apple Account Holder/admin.
6. Confirm public Terms, Privacy and support URLs contain approved, accessible content. This branch links existing URLs; it does not fabricate legal policy text.

#### Native Google client setup

In the existing `seensnap-staging` Google Cloud project, open Google Auth Platform → Clients (or APIs & Services → Credentials). Check for an existing **iOS** OAuth client for `com.seensnap.app` before creating a duplicate. If none exists, create an iOS client named **SeenSnap iOS**, bundle `com.seensnap.app`, Team ID `7Z8CYNB749`. The optional App Store ID can remain blank until the app is published. Leave existing web clients unchanged.

Copy only the public client ID ending in `.apps.googleusercontent.com` to the Expo `preview` environment as `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` and to the API as `GOOGLE_OAUTH_IOS_CLIENT_ID`. Do not place a client secret in the app. App Check has not been integrated into this AuthSession-based client; enabling enforcement needs separate implementation and device validation.

Google Cloud Console could not be loaded by the setup browser on November 15, so its current OAuth clients and permissions have **not** been inspected. An account owner must complete or verify this step. The release preflight correctly blocks the current configuration on the missing iOS Google client ID.

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

1. Deploy this backend commit with the existing reviewed `deploy/rollout_existing.py` flow. Billing defaults off and does not remove existing beta grants. No schema migration is introduced by this branch, but the rollout still runs its normal backup/migration checks.
2. Configure native auth and verify the new `/auth/deletion-requirements` and billing endpoints. Keep environment out of `local`/`development`; `/auth/dev` and demo token must remain disabled.
3. Merge the frontend only after backend checks pass. Netlify then publishes the release sign-in UI and the association file. Verify the association URL returns JSON over HTTPS with no redirect; verify an authenticated account can still sign in on web.
4. In `apps/mobile`, after the confirmed Expo project/environment is linked, run:

   ```sh
   npm ci
   npm run release:check
   npx eas-cli build --platform ios --profile testflight
   npx eas-cli submit --platform ios --profile testflight
   ```

   Use the exact successful build for submission, not an unrelated previously built artifact. These commands are instructions; no build or upload has been run in this session. Configuration preflight needs the public EAS environment variables available locally as well as on the build worker.
5. Wait for Apple's processing; resolve export compliance based on the app's audited encryption use. Do not assume an exemption without checking the final archive and SDKs. Native privacy manifests are aggregated by CocoaPods; inspect the archive's Privacy Report before completing App Privacy disclosures.
6. Add internal testers, verify on an actual iPhone and iPad, then complete Test Information and submit for external TestFlight review. Reviewer access must use a real supported login, not re-enabled email-only authentication.

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
- Final archive signing, native SDK/pod compilation and real-device behavior cannot be certified by TypeScript/web/unit checks in Linux. No claim of TestFlight readiness until the signed archive and device gates pass.
